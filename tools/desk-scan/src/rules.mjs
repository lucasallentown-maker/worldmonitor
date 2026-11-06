// Research-only pool filters. No network, no orders, no wallet access.
// Thresholds are RAW: every positive-balance owner counts, including treasuries
// and liquidity accounts. This file does not apply an exclusion list.

export const WINDOW_MS = 5 * 60 * 1000;
export const BENCH_MS = 25 * 60 * 1000;
export const HOLDER_WARMUP_MS = 10 * 60 * 1000;
export const SHARED_LIMIT_PER_MIN = 5;
export const VET_RESERVED_PER_MIN = 1;
export const SCAN_BUDGET_PER_MIN = SHARED_LIMIT_PER_MIN - VET_RESERVED_PER_MIN;
export const MAX_NEW_POOL_PAGES = 2;
export const PAGE_DEADLINE_MS = 60_000;
export const HTTP_429_PAUSE_MS = 60_000;
export const MAX_DEX_CALLS_PER_CYCLE = 20;
export const MAX_GT_DOSSIERS_PER_CYCLE = 3;
export const MAX_CANDIDATES = 10;
export const CONTEXT_MAX_BYTES = 1024;

export const CHEAP_FILTERS = Object.freeze({
  ageMinMinutes: 10,
  ageMaxMinutes: 48 * 60,
  minLiquidityUsd: 15_000,
  minVolumeH24Usd: 50_000,
  minMcapUsd: 80_000,
  maxMcapUsd: 6_000_000,
});

export function allowCall(state, now, role) {
  const pausedUntil = state?.pausedUntil || 0;
  if (now < pausedUntil) return { ok: false, reason: '429-pause-60s' };
  if (role === 'vet') return { ok: false, reason: 'vet-not-implemented' };
  if (role !== 'scan') return { ok: false, reason: 'unknown-caller' };
  const calls = (state?.calls || []).filter((call) => now - call.at < 60_000);
  const scanCalls = calls.filter((call) => call.role === 'scan').length;
  if (calls.length >= SHARED_LIMIT_PER_MIN) return { ok: false, reason: 'shared-5-per-min' };
  if (scanCalls >= SCAN_BUDGET_PER_MIN) return { ok: false, reason: 'vet-reservation' };
  return { ok: true, state: { ...state, pausedUntil, calls: [...calls, { at: now, role: 'scan' }] } };
}

export function pauseFor429(state, now) {
  return { ...(state || {}), pausedUntil: now + HTTP_429_PAUSE_MS, calls: state?.calls || [] };
}

export function takeNewPoolPages(pages, elapsedMs) {
  if (!Number.isFinite(elapsedMs) || elapsedMs > PAGE_DEADLINE_MS) {
    return { ok: false, reason: 'page-deadline-60s', pools: [] };
  }
  if (!Array.isArray(pages)) return { ok: false, reason: 'pages-missing', pools: [] };
  if (pages.length > MAX_NEW_POOL_PAGES) return { ok: false, reason: 'more-than-2-pages', pools: [] };
  const pools = [];
  for (const page of pages) {
    if (!Array.isArray(page)) return { ok: false, reason: 'page-not-array', pools: [] };
    pools.push(...page);
  }
  return { ok: true, pools };
}

export function cheapFilter(pool, now) {
  if (!pool || typeof pool !== 'object') return { ok: false, reason: 'pool-missing' };
  if (typeof pool.contract !== 'string' || pool.contract.length < 32) {
    return { ok: false, reason: 'contract-missing' };
  }
  if (typeof pool.ticker !== 'string' || pool.ticker.trim() === '') {
    return { ok: false, reason: 'ticker-missing' };
  }
  if (!Number.isFinite(pool.createdAt)) return { ok: false, reason: 'age-missing' };
  const ageMinutes = (now - pool.createdAt) / 60_000;
  if (ageMinutes < CHEAP_FILTERS.ageMinMinutes || ageMinutes > CHEAP_FILTERS.ageMaxMinutes) {
    return { ok: false, reason: 'age-outside-10m-48h', ageMinutes };
  }
  if (!Number.isFinite(pool.liquidityUsd) || pool.liquidityUsd < CHEAP_FILTERS.minLiquidityUsd) {
    return { ok: false, reason: 'liquidity-below-15k' };
  }
  if (!Number.isFinite(pool.volumeH24Usd) || pool.volumeH24Usd < CHEAP_FILTERS.minVolumeH24Usd) {
    return { ok: false, reason: 'volume-h24-below-50k' };
  }
  if (!Number.isFinite(pool.mcap)) return { ok: false, reason: 'mcap-missing-fdv-not-accepted' };
  if (pool.mcap < CHEAP_FILTERS.minMcapUsd || pool.mcap > CHEAP_FILTERS.maxMcapUsd) {
    return { ok: false, reason: 'mcap-outside-80k-6m' };
  }
  return { ok: true, ageMinutes };
}

export function planDexEnrich(pools) {
  const matched = pools.filter((pool) => (
    pool
    && pool.chain === 'solana'
    && typeof pool.contract === 'string'
    && (pool.baseMint === pool.contract || pool.quoteMint === pool.contract)
  ));
  matched.sort((a, b) => (b.liquidityUsd || 0) - (a.liquidityUsd || 0));
  return matched.slice(0, MAX_GT_DOSSIERS_PER_CYCLE);
}

export function completeWindows(trades, observation) {
  if (!observation || !Number.isFinite(observation.start) || !Number.isFinite(observation.end)) {
    return { ok: false, reason: 'observation-incomplete' };
  }
  if (observation.end < observation.start) return { ok: false, reason: 'observation-incomplete' };
  const first = Math.ceil(observation.start / WINDOW_MS) * WINDOW_MS;
  const last = Math.floor(observation.end / WINDOW_MS) * WINDOW_MS;
  if (last <= first) return { ok: false, reason: 'no-complete-window' };
  const windows = [];
  for (let start = first; start < last; start += WINDOW_MS) {
    const end = start + WINDOW_MS;
    const bucket = [];
    for (const trade of trades || []) {
      if (!trade || !Number.isFinite(trade.timestamp)) {
        return { ok: false, reason: 'trade-timestamp-missing' };
      }
      if (trade.timestamp >= start && trade.timestamp < end) bucket.push(trade);
    }
    windows.push({ start, end, trades: bucket });
  }
  for (let i = 1; i < windows.length; i += 1) {
    if (windows[i].start !== windows[i - 1].end) return { ok: false, reason: 'window-gap' };
  }
  return { ok: true, windows };
}

function lastConsecutive(windows, count) {
  if (!windows || windows.length < count) return { ok: false, reason: `need-${count}-consecutive-5m-windows` };
  const slice = windows.slice(windows.length - count);
  for (let i = 1; i < slice.length; i += 1) {
    if (slice[i].start !== slice[i - 1].end) return { ok: false, reason: 'window-gap' };
  }
  return { ok: true, windows: slice };
}

function sideCount(windows, side) {
  return windows.reduce((sum, window) => (
    sum + window.trades.filter((trade) => trade.side === side).length
  ), 0);
}

function volumeUsd(windows) {
  let total = 0;
  for (const window of windows) {
    for (const trade of window.trades) {
      if (!Number.isFinite(trade.usd) || trade.usd < 0) return null;
      total += trade.usd;
    }
  }
  return total;
}

function priceChangePct(windows) {
  const priced = windows.flatMap((window) => window.trades)
    .filter((trade) => Number.isFinite(trade.price) && trade.price > 0)
    .sort((a, b) => a.timestamp - b.timestamp);
  if (priced.length < 2) return null;
  return ((priced.at(-1).price - priced[0].price) / priced[0].price) * 100;
}

function documentedCount(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

function documentedUsd(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

// trades_h24 is the Dex-published h24 buy count plus sell count.
// It is not the length of a trade tape. Missing fields fail closed.
export function documentedH24TradeCount(transactions) {
  const buys = documentedCount(transactions?.h24?.buys);
  const sells = documentedCount(transactions?.h24?.sells);
  if (buys == null || sells == null) return { ok: false, reason: 'dex-h24-transactions-undocumented' };
  return { ok: true, trades_h24: buys + sells };
}

export function tradeMetrics(trades, observation, dex = {}) {
  const count = documentedH24TradeCount(dex.transactions);
  if (!count.ok) return count;
  if (count.trades_h24 < 200) {
    return { ok: false, reason: 'trades-h24-below-200', trades_h24: count.trades_h24 };
  }
  const volumeH6 = documentedUsd(dex.volume?.h6);
  const volumeH24 = documentedUsd(dex.volume?.h24);
  if (volumeH6 == null || volumeH24 == null) {
    return { ok: false, reason: 'dex-volume-undocumented', trades_h24: count.trades_h24 };
  }
  if (!observation || observation.complete !== true) {
    return { ok: false, reason: 'window-coverage-incomplete', trades_h24: count.trades_h24 };
  }
  const built = completeWindows(trades, observation);
  if (!built.ok) return { ...built, trades_h24: count.trades_h24 };
  const h1 = lastConsecutive(built.windows, 12);
  if (!h1.ok) return { ...h1, trades_h24: count.trades_h24 };
  const buysH1 = sideCount(h1.windows, 'buy');
  const sellsH1 = sideCount(h1.windows, 'sell');
  if (sellsH1 === 0 && buysH1 >= 20) {
    return { ok: false, reason: 'h1-zero-sells-20-buys', trades_h24: count.trades_h24 };
  }
  const volumeH1 = volumeUsd(h1.windows);
  const price = priceChangePct(h1.windows);
  if (volumeH1 == null || price == null) {
    return { ok: false, reason: 'trade-metric-missing', trades_h24: count.trades_h24 };
  }
  return {
    ok: true,
    volume_h1: volumeH1,
    volume_h6: volumeH6,
    volume_h24: volumeH24,
    trades_h24: count.trades_h24,
    buys_h1: buysH1,
    sells_h1: sellsH1,
    price_change_h1: price,
  };
}

export function aggregateHolders(accounts, pagination) {
  if (!pagination || pagination.complete !== true) {
    return { ok: false, reason: pagination?.reason || 'gpa-pagination-incomplete' };
  }
  if (pagination.providerLimited === true) return { ok: false, reason: 'provider-limited' };
  const byOwner = new Map();
  for (const account of accounts || []) {
    if (!account || typeof account.owner !== 'string' || account.owner === '') {
      return { ok: false, reason: 'account-owner-missing' };
    }
    if (!Number.isFinite(account.amount)) return { ok: false, reason: 'account-amount-missing' };
    if (account.amount < 0) return { ok: false, reason: 'negative-balance' };
    if (account.amount === 0) continue;
    if (account.program !== 'spl' && account.program !== 'token2022') {
      return { ok: false, reason: 'unknown-token-program' };
    }
    byOwner.set(account.owner, (byOwner.get(account.owner) || 0) + account.amount);
  }
  const owners = [...byOwner.entries()]
    .map(([owner, amount]) => ({ owner, amount }))
    .sort((a, b) => b.amount - a.amount);
  const total = owners.reduce((sum, owner) => sum + owner.amount, 0);
  if (!(total > 0)) return { ok: false, reason: 'no-positive-balances' };
  return { ok: true, holders: owners.length, owners, total };
}

export function concentration(owners, total) {
  if (!owners?.length || !(total > 0)) return { ok: false, reason: 'concentration-missing' };
  const top1 = owners[0].amount / total;
  const top10 = owners.slice(0, 10).reduce((sum, owner) => sum + owner.amount, 0) / total;
  if (top1 > 0.05) return { ok: false, reason: 'top-owner-above-5pct', top1, top10 };
  if (top10 > 0.55) return { ok: false, reason: 'top10-above-55pct', top1, top10 };
  return { ok: true, top1, top10 };
}

export function freezeAndHolders(mint, holderCount) {
  if (!mint || !Object.prototype.hasOwnProperty.call(mint, 'freezeAuthority')) {
    return { ok: false, reason: 'freeze-authority-unknown' };
  }
  if (mint.freezeAuthority !== null) return { ok: false, reason: 'freeze-authority-set' };
  if (!Number.isInteger(holderCount) || holderCount < 100) {
    return { ok: false, reason: 'holders-below-100' };
  }
  return { ok: true };
}

export function holderGrowth(snapshots) {
  if (!Array.isArray(snapshots) || snapshots.length < 2) {
    return { ok: false, reason: 'holder-history-missing' };
  }
  const sorted = [...snapshots].sort((a, b) => a.at - b.at);
  for (const snap of sorted) {
    if (!Number.isFinite(snap.at) || !Number.isInteger(snap.holders) || snap.holders < 0) {
      return { ok: false, reason: 'holder-snapshot-invalid' };
    }
  }
  const span = sorted.at(-1).at - sorted[0].at;
  if (span < HOLDER_WARMUP_MS) return { ok: false, reason: 'holder-warmup-10m' };
  if (!(sorted[0].holders > 0)) return { ok: false, reason: 'holder-baseline-zero' };
  const growth = (sorted.at(-1).holders - sorted[0].holders) / sorted[0].holders;
  return { ok: true, growth, growthPct: growth * 100 };
}

export function worldNewsContext(input) {
  if (!input || input.kind !== 'world-news' || typeof input.text !== 'string' || input.text.trim() === '') {
    return { context: null, unavailable: true, reason: 'world-news-unavailable' };
  }
  const bytes = Buffer.from(input.text, 'utf8');
  if (bytes.length <= CONTEXT_MAX_BYTES) {
    return { context: input.text, unavailable: false, reason: null };
  }
  let end = CONTEXT_MAX_BYTES;
  while (end > 0 && (bytes[end] & 0b11000000) === 0b10000000) end -= 1;
  return {
    context: bytes.subarray(0, end).toString('utf8'),
    unavailable: false,
    reason: 'truncated-to-1024',
  };
}

export function applyBench(contract, bench, now) {
  const next = { ...(bench || {}) };
  const row = next[contract];
  if (!row || !Number.isFinite(row.since)) {
    next[contract] = { since: now };
    return { ready: false, reason: 'bench-started', bench: next };
  }
  const waited = now - row.since;
  if (waited < BENCH_MS) {
    return { ready: false, reason: 'bench-waiting', waitedMs: waited, bench: next };
  }
  return { ready: true, bench: next, waitedMs: waited };
}

export function chiefReport(wmSufficient, candidateCount) {
  const wmOk = wmSufficient === 3;
  return {
    ready: false,
    status: 'NOT_READY',
    wm_sufficient: wmSufficient ?? 0,
    wm_required: 3,
    wm_ok: wmOk,
    reason: wmOk
      ? 'desk incomplete: VET, SIZE, FILLS, and RISK are not implemented'
      : 'worldmonitor sufficient greens are below 3',
    vet: 'not-implemented',
    size: 'not-implemented',
    fills: 'not-implemented',
    risk: 'not-implemented',
    execution: 'disabled',
    funds: 'disabled',
    candidates: candidateCount,
  };
}
