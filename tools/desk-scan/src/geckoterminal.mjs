import { allowCall, pauseFor429, MAX_NEW_POOL_PAGES, PAGE_DEADLINE_MS, MAX_DEX_CALLS_PER_CYCLE } from './rules.mjs';

export const GT_ORIGIN = 'https://api.geckoterminal.com';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

export function redactUrl(raw) {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}`;
  } catch {
    return 'unparsed-url';
  }
}

function mintFromId(id) {
  if (typeof id !== 'string') return null;
  const prefix = 'solana_';
  return id.startsWith(prefix) ? id.slice(prefix.length) : null;
}

export function mapPool(row) {
  const attrs = row?.attributes || {};
  const rel = row?.relationships || {};
  const baseMint = mintFromId(rel.base_token?.data?.id);
  const quoteMint = mintFromId(rel.quote_token?.data?.id);
  const contract = baseMint && baseMint !== SOL_MINT ? baseMint : (quoteMint && quoteMint !== SOL_MINT ? quoteMint : baseMint);
  const createdAt = Date.parse(attrs.pool_created_at || '');
  const mcapRaw = attrs.market_cap_usd;
  const mcap = mcapRaw == null || mcapRaw === '' ? null : Number(mcapRaw);
  const name = typeof attrs.name === 'string' ? attrs.name : '';
  return {
    ticker: name.split(' / ')[0] || null,
    contract,
    chain: 'solana',
    baseMint,
    quoteMint,
    poolAddress: attrs.address || null,
    dex: rel.dex?.data?.id || null,
    createdAt: Number.isFinite(createdAt) ? createdAt : null,
    liquidityUsd: Number(attrs.reserve_in_usd),
    volumeH24Usd: Number(attrs.volume_usd?.h24),
    mcap: Number.isFinite(mcap) ? mcap : null,
    fdvIgnored: attrs.fdv_usd ?? null,
  };
}

export function mapTrade(row) {
  const attrs = row?.attributes || {};
  const timestamp = Date.parse(attrs.block_timestamp || '');
  const side = attrs.kind === 'buy' || attrs.kind === 'sell' ? attrs.kind : null;
  const usd = Number(attrs.volume_in_usd);
  const price = Number(attrs.price_to_in_usd ?? attrs.price_from_in_usd);
  if (!Number.isFinite(timestamp) || !side || !Number.isFinite(usd) || !Number.isFinite(price) || price <= 0) {
    return null;
  }
  return { timestamp, side, usd, price };
}

async function budgetedGet(url, budgetFile, state, fetchImpl) {
  const gate = allowCall(state, Date.now(), 'scan');
  if (!gate.ok) return { ok: false, reason: gate.reason, state, status: null, body: null };
  let response;
  try {
    response = await fetchImpl(url, {
      headers: {
        Accept: 'application/json;version=20230203',
        'User-Agent': 'worldmonitor-desk-scan/1.0',
      },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    return { ok: false, reason: `geckoterminal ${err.name}: ${err.message}`, state: gate.state, status: null, body: null };
  }
  if (response.status === 429) {
    return { ok: false, reason: '429-pause-60s', state: pauseFor429(gate.state, Date.now()), status: 429, body: null };
  }
  if (!response.ok) {
    return { ok: false, reason: `geckoterminal HTTP ${response.status}`, state: gate.state, status: response.status, body: null };
  }
  try {
    return { ok: true, reason: null, state: gate.state, status: response.status, body: await response.json() };
  } catch {
    return { ok: false, reason: 'geckoterminal body is not JSON', state: gate.state, status: response.status, body: null };
  }
}

export async function discoverNewPools({ fetchImpl = fetch, state, startedAt = Date.now() }) {
  const pools = [];
  let current = state || { calls: [], pausedUntil: 0 };
  const calls = [];
  for (let page = 1; page <= MAX_NEW_POOL_PAGES; page += 1) {
    if (Date.now() - startedAt > PAGE_DEADLINE_MS) {
      return { ok: false, reason: 'page-deadline-60s', pools, state: current, calls };
    }
    const url = `${GT_ORIGIN}/api/v2/networks/solana/new_pools?page=${page}`;
    const got = await budgetedGet(url, null, current, fetchImpl);
    current = got.state;
    calls.push({ page, ok: got.ok, status: got.status, reason: got.reason });
    if (!got.ok) return { ok: false, reason: got.reason, pools, state: current, calls };
    const rows = Array.isArray(got.body?.data) ? got.body.data : null;
    if (!rows) return { ok: false, reason: 'geckoterminal page is not a list', pools, state: current, calls };
    pools.push(...rows.map(mapPool));
  }
  return { ok: true, reason: null, pools, state: current, calls, elapsedMs: Date.now() - startedAt };
}

export async function enrichPoolTrades(poolAddress, { fetchImpl = fetch, state }) {
  const url = `${GT_ORIGIN}/api/v2/networks/solana/pools/${encodeURIComponent(poolAddress)}/trades`;
  const got = await budgetedGet(url, null, state, fetchImpl);
  if (!got.ok) {
    return { ok: false, reason: got.reason, state: got.state, trades: [], observation: { complete: false } };
  }
  const rows = Array.isArray(got.body?.data) ? got.body.data : null;
  if (!rows) {
    return { ok: false, reason: 'geckoterminal trades are not a list', state: got.state, trades: [], observation: { complete: false } };
  }
  const trades = rows.map(mapTrade).filter(Boolean);
  // The public trades route returns a recent page, not a proven 24h tape.
  // complete stays false so the 288-window gate cannot pass on this snapshot.
  return {
    ok: true,
    reason: 'public-trades-page-not-complete-coverage',
    state: got.state,
    trades,
    observation: { complete: false, start: null, end: null, returned: rows.length, parsed: trades.length },
    dexCalls: 1,
    maxDexCalls: MAX_DEX_CALLS_PER_CYCLE,
  };
}
