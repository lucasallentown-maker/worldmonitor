import {
  applyBench,
  aggregateHolders,
  cheapFilter,
  chiefReport,
  concentration,
  freezeAndHolders,
  holderGrowth,
  planDexEnrich,
  takeNewPoolPages,
  tradeMetrics,
  worldNewsContext,
  MAX_CANDIDATES,
} from './rules.mjs';

const REQUIRED = [
  'ticker', 'contract', 'age_minutes', 'liquidity_usd', 'mcap',
  'volume_h1', 'volume_h6', 'volume_h24', 'trades_h24', 'buys_h1', 'sells_h1',
  'price_change_h1', 'rank', 'rank_reason', 'context', 'degraded', 'written_at',
];

function reject(list, pool, reason) {
  list.push({ contract: pool?.contract || null, ticker: pool?.ticker || null, reason });
}

export function scanCycle(input) {
  const now = input.now;
  const rejected = [];
  if (input.position && typeof input.position === 'object') {
    return {
      stopped: true,
      reason: 'position.json present; scanning stopped',
      candidates: [],
      rejected,
      bench: input.bench || {},
      context: worldNewsContext(input.worldNews),
      chief: chiefReport(input.wmSufficient ?? input.wmGreens ?? 0, 0),
      source: input.source || 'fixture',
    };
  }

  const pages = takeNewPoolPages(input.pages, input.elapsedMs ?? 0);
  if (!pages.ok) {
    return {
      stopped: false,
      reason: pages.reason,
      candidates: [],
      rejected,
      bench: input.bench || {},
      context: worldNewsContext(input.worldNews),
      chief: chiefReport(input.wmSufficient ?? input.wmGreens ?? 0, 0),
      source: input.source || 'fixture',
    };
  }

  const cheap = [];
  for (const pool of pages.pools) {
    const gate = cheapFilter(pool, now);
    if (!gate.ok) reject(rejected, pool, gate.reason);
    else cheap.push({ pool, ageMinutes: gate.ageMinutes });
  }

  const enrichPlan = new Set(planDexEnrich(cheap.map((row) => row.pool)).map((pool) => pool.contract));
  const context = worldNewsContext(input.worldNews);
  let bench = { ...(input.bench || {}) };
  const passed = [];

  for (const row of cheap) {
    const pool = row.pool;
    if (!enrichPlan.has(pool.contract)) {
      reject(rejected, pool, 'dex-enrich-not-selected');
      continue;
    }
    if (input.enriched && input.enriched[pool.contract] === false) {
      reject(rejected, pool, 'dex-enrich-missing');
      continue;
    }
    const benchResult = applyBench(pool.contract, bench, now);
    bench = benchResult.bench;
    if (!benchResult.ready) {
      reject(rejected, pool, benchResult.reason);
      continue;
    }
    const trades = tradeMetrics(input.trades?.[pool.contract], input.observation?.[pool.contract], {
      transactions: pool.transactions,
      volume: pool.volumeUsd,
    });
    if (!trades.ok) {
      reject(rejected, pool, trades.reason);
      continue;
    }
    const holders = aggregateHolders(input.accounts?.[pool.contract], input.pagination?.[pool.contract]);
    if (!holders.ok) {
      reject(rejected, pool, holders.reason);
      continue;
    }
    const conc = concentration(holders.owners, holders.total);
    if (!conc.ok) {
      reject(rejected, pool, conc.reason);
      continue;
    }
    const mintGate = freezeAndHolders(input.mints?.[pool.contract], holders.holders);
    if (!mintGate.ok) {
      reject(rejected, pool, mintGate.reason);
      continue;
    }
    const growth = holderGrowth(input.snapshots?.[pool.contract]);
    if (!growth.ok) {
      reject(rejected, pool, growth.reason);
      continue;
    }
    const score = growth.growthPct - trades.price_change_h1;
    passed.push({
      ticker: pool.ticker,
      contract: pool.contract,
      age_minutes: Math.round(row.ageMinutes * 1000) / 1000,
      liquidity_usd: pool.liquidityUsd,
      mcap: pool.mcap,
      volume_h1: trades.volume_h1,
      volume_h6: trades.volume_h6,
      volume_h24: trades.volume_h24,
      trades_h24: trades.trades_h24,
      buys_h1: trades.buys_h1,
      sells_h1: trades.sells_h1,
      price_change_h1: trades.price_change_h1,
      rank_reason: `holder growth ${growth.growthPct.toFixed(2)}% vs h1 price ${trades.price_change_h1.toFixed(2)}%`,
      context: context.context,
      degraded: false,
      written_at: new Date(now).toISOString(),
      _score: score,
    });
  }

  passed.sort((a, b) => b._score - a._score || a.contract.localeCompare(b.contract));
  const candidates = passed.slice(0, MAX_CANDIDATES).map((row, index) => {
    const { _score, ...rest } = row;
    const candidate = { ...rest, rank: index + 1 };
    for (const field of REQUIRED) {
      if (!Object.prototype.hasOwnProperty.call(candidate, field)) {
        throw new Error(`candidate missing ${field}`);
      }
    }
    if (candidate.degraded !== false) throw new Error('passing candidate cannot be degraded');
    return candidate;
  });

  return {
    stopped: false,
    reason: null,
    candidates,
    rejected,
    bench,
    context,
    chief: chiefReport(input.wmSufficient ?? input.wmGreens ?? 0, candidates.length),
    source: input.source || 'fixture',
    live: input.source === 'live',
    fixture: input.source !== 'live',
  };
}
