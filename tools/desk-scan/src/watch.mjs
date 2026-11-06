// Pools already seen stay in the watch. Later cycles reapply the same filters.
// Nothing here relaxes a threshold or invents a holder count.

export function emptyWatch() {
  return { schema: 'watch/v1', pools: {} };
}

function remembered(pool, seenAt, previous) {
  return {
    ticker: pool.ticker || null,
    contract: pool.contract,
    chain: pool.chain || 'solana',
    baseMint: pool.baseMint || null,
    quoteMint: pool.quoteMint || null,
    poolAddress: pool.poolAddress || null,
    dex: pool.dex || null,
    createdAt: Number.isFinite(pool.createdAt) ? pool.createdAt : null,
    liquidityUsd: Number.isFinite(pool.liquidityUsd) ? pool.liquidityUsd : null,
    volumeH24Usd: Number.isFinite(pool.volumeH24Usd) ? pool.volumeH24Usd : null,
    volumeUsd: pool.volumeUsd || null,
    transactions: pool.transactions || null,
    mcap: Number.isFinite(pool.mcap) ? pool.mcap : null,
    firstSeenAt: previous?.firstSeenAt ?? seenAt,
    lastSeenAt: seenAt,
  };
}

export function upsertWatch(watch, pools, seenAt) {
  const next = emptyWatch();
  next.pools = { ...(watch?.pools || {}) };
  let added = 0;
  for (const pool of pools || []) {
    if (!pool || typeof pool.contract !== 'string' || pool.contract.length < 32) continue;
    const previous = next.pools[pool.contract];
    if (!previous) added += 1;
    next.pools[pool.contract] = remembered(pool, seenAt, previous);
  }
  return { watch: next, added, unique: Object.keys(next.pools).length };
}

export function watchPools(watch) {
  return Object.values(watch?.pools || {});
}

export function cadenceGap(previousStartMs, cycleStartedMs, cadenceMs = 60_000) {
  if (!Number.isFinite(previousStartMs)) return { gapMs: 0, gap: false };
  if (!Number.isFinite(cycleStartedMs) || !Number.isFinite(cadenceMs)) return { gapMs: null, gap: true };
  const gapMs = cycleStartedMs - previousStartMs - cadenceMs;
  return { gapMs, gap: gapMs > 5_000 };
}
