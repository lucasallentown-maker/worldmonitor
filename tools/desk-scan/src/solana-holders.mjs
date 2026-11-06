export const DEFAULT_SOLANA_RPC = 'https://api.mainnet-beta.solana.com';
export const SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

export function redactRpc(raw) {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}`;
  } catch {
    return 'unparsed-rpc-url';
  }
}

export function resolveSolanaRpc(env = process.env) {
  const configured = typeof env.SOLANA_RPC_URL === 'string' ? env.SOLANA_RPC_URL.trim() : '';
  if (!configured) return { url: DEFAULT_SOLANA_RPC, source: 'public-default' };
  return { url: configured, source: 'SOLANA_RPC_URL' };
}

export function parseMintFreeze(base64) {
  const buf = Buffer.from(base64 || '', 'base64');
  if (buf.length < 82) return { ok: false, reason: 'mint-account-short' };
  const tag = buf.readUInt32LE(46);
  if (tag === 0) return { ok: true, freezeAuthority: null };
  if (tag === 1) {
    return { ok: true, freezeAuthority: buf.subarray(50, 82).toString('hex') };
  }
  return { ok: false, reason: 'mint-freeze-tag-unknown' };
}

export function parseOwnerAmount(base64) {
  const buf = Buffer.from(base64 || '', 'base64');
  if (buf.length < 40) return { ok: false, reason: 'token-account-short' };
  const amount = buf.readBigUInt64LE(32);
  return {
    ok: true,
    owner: buf.subarray(0, 32).toString('hex'),
    amountRaw: amount.toString(),
  };
}

// Unique positive owners across SPL and Token-2022. Amounts stay BigInt so a
// raw balance above 2^53 cannot be rounded into a fake holder or a fake share.
export function exactOwners(accounts) {
  const byOwner = new Map();
  for (const account of accounts || []) {
    let amount;
    try {
      amount = BigInt(account?.amountRaw);
    } catch {
      return { ok: false, reason: 'amount-unparsed' };
    }
    if (amount < 0n) return { ok: false, reason: 'negative-balance' };
    if (amount === 0n) continue;
    if (account.program !== 'spl' && account.program !== 'token2022') {
      return { ok: false, reason: 'unknown-token-program' };
    }
    if (typeof account.owner !== 'string' || account.owner.length === 0) {
      return { ok: false, reason: 'account-owner-missing' };
    }
    byOwner.set(account.owner, (byOwner.get(account.owner) || 0n) + amount);
  }
  if (!Number.isSafeInteger(byOwner.size) || byOwner.size === 0) {
    return { ok: false, reason: byOwner.size === 0 ? 'no-positive-balances' : 'holder-count-unrepresentable' };
  }
  const owners = [...byOwner.entries()].sort((a, b) => (a[1] === b[1] ? 0 : a[1] > b[1] ? -1 : 1));
  let total = 0n;
  for (const [, amount] of owners) total += amount;
  let top10 = 0n;
  for (const [, amount] of owners.slice(0, 10)) top10 += amount;
  const top1 = owners[0][1];
  return {
    ok: true,
    holders: owners.length,
    topOwnerAbove5: top1 * 20n > total,
    top10Above55: top10 * 20n > total * 11n,
  };
}

function accountData(account) {
  const data = account?.account?.data ?? account?.data;
  if (Array.isArray(data)) return data[0];
  if (typeof data === 'string') return data;
  return null;
}

async function rpc(url, method, params, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'worldmonitor-desk-scan/1.0' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(25_000),
    });
  } catch (err) {
    return { ok: false, error: `${err.name}: ${err.message}` };
  }
  let body = null;
  try {
    body = await response.json();
  } catch {
    return { ok: false, error: `HTTP ${response.status} body is not JSON` };
  }
  if (!response.ok) {
    const message = body?.error?.message || body?.message || response.statusText || 'request failed';
    return { ok: false, error: `HTTP ${response.status}: ${message}`, code: body?.error?.code ?? response.status };
  }
  if (body?.error) {
    return { ok: false, error: `${body.error.code}: ${body.error.message}`, code: body.error.code };
  }
  return { ok: true, result: body.result };
}

export async function readHolderSnapshot(mint, { rpcUrl, fetchImpl = fetch } = {}) {
  if (!rpcUrl) return { ok: false, reason: 'solana rpc url missing', holderCount: null, invented: false };
  const endpoint = redactRpc(rpcUrl);
  const mintInfo = await rpc(rpcUrl, 'getAccountInfo', [mint, { encoding: 'base64', commitment: 'confirmed' }], fetchImpl);
  if (!mintInfo.ok) {
    return { ok: false, reason: `mint ${mintInfo.error}`, holderCount: null, invented: false, rpc: endpoint };
  }
  const mintData = mintInfo.result?.value?.data;
  const freeze = parseMintFreeze(Array.isArray(mintData) ? mintData[0] : mintData);
  if (!freeze.ok) {
    return { ok: false, reason: freeze.reason, holderCount: null, invented: false, rpc: endpoint };
  }

  const programs = [
    ['spl', SPL_TOKEN_PROGRAM],
    ['token2022', TOKEN_2022_PROGRAM],
  ];
  const accounts = [];
  const programResults = [];
  for (const [name, program] of programs) {
    const got = await rpc(rpcUrl, 'getProgramAccounts', [
      program,
      {
        encoding: 'base64',
        commitment: 'confirmed',
        filters: [{ memcmp: { offset: 0, bytes: mint } }],
        dataSlice: { offset: 32, length: 40 },
      },
    ], fetchImpl);
    if (!got.ok) {
      programResults.push({ program: name, ok: false, error: got.error, code: got.code ?? null });
      return {
        ok: false,
        reason: `gpa-${name}: ${got.error}`,
        holderCount: null,
        invented: false,
        rpc: endpoint,
        freezeAuthority: freeze.freezeAuthority,
        programs: programResults,
      };
    }
    if (!Array.isArray(got.result)) {
      return {
        ok: false,
        reason: `gpa-${name}: result is not a complete list`,
        holderCount: null,
        invented: false,
        rpc: endpoint,
        programs: [...programResults, { program: name, ok: false, error: 'result is not a list' }],
      };
    }
    programResults.push({ program: name, ok: true, accounts: got.result.length });
    for (const row of got.result) {
      const parsed = parseOwnerAmount(accountData(row));
      if (!parsed.ok) {
        return { ok: false, reason: parsed.reason, holderCount: null, invented: false, rpc: endpoint, programs: programResults };
      }
      accounts.push({ owner: parsed.owner, amountRaw: parsed.amountRaw, program: name });
    }
  }
  const counted = exactOwners(accounts);
  if (!counted.ok) {
    return { ok: false, reason: counted.reason, holderCount: null, invented: false, rpc: endpoint, programs: programResults };
  }
  return {
    ok: true,
    reason: null,
    holderCount: counted.holders,
    topOwnerAbove5: counted.topOwnerAbove5,
    top10Above55: counted.top10Above55,
    invented: false,
    rpc: endpoint,
    freezeAuthority: freeze.freezeAuthority,
    accounts,
    pagination: { complete: true, providerLimited: false },
    programs: programResults,
  };
}
