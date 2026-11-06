import path from 'node:path';
import { discoverNewPools } from './geckoterminal.mjs';
import { scanCycle } from './scan.mjs';
import { readHolderSnapshot, resolveSolanaRpc } from './solana-holders.mjs';
import { atomicWriteJson, readJson } from './persist.mjs';
import { loadObservation, observeCandidates, persistObservation } from './observe.mjs';
import { cadenceGap, emptyWatch, upsertWatch, watchPools } from './watch.mjs';

const CHEAP_REASONS = new Set([
  'pool-missing', 'contract-missing', 'ticker-missing', 'age-missing', 'age-outside-10m-48h',
  'liquidity-below-15k', 'volume-h24-below-50k', 'mcap-missing-fdv-not-accepted', 'mcap-outside-80k-6m',
]);

function central(ms) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(ms));
}

function countReasons(rows) {
  const counts = {};
  for (const row of rows) counts[row.reason] = (counts[row.reason] || 0) + 1;
  return counts;
}

export async function runObserveCycle(outDir, { previousStartMs = null, index = 1, cadenceMs = 60_000 } = {}) {
  const cycleStarted = Date.now();
  const spacing = cadenceGap(previousStartMs, cycleStarted, cadenceMs);
  const budgetFile = path.join(outDir, 'gt-budget.json');
  const watchFile = path.join(outDir, 'watch.json');
  const benchFile = path.join(outDir, 'bench.json');
  let budget = readJson(budgetFile, { calls: [], pausedUntil: 0 });
  let watch = readJson(watchFile, emptyWatch());
  const discovered = await discoverNewPools({ state: budget, startedAt: cycleStarted });
  budget = discovered.state || budget;
  atomicWriteJson(budgetFile, budget);
  const merged = upsertWatch(watch, discovered.pools || [], cycleStarted);
  watch = merged.watch;
  atomicWriteJson(watchFile, watch);
  const scanned = scanCycle({
    now: cycleStarted,
    source: 'live',
    wmSufficient: 0,
    pages: [watchPools(watch)],
    elapsedMs: 0,
    bench: readJson(benchFile, {}),
    trades: {},
    observation: {},
    accounts: {},
    pagination: {},
    mints: {},
    snapshots: {},
  });
  atomicWriteJson(benchFile, scanned.bench || {});
  const rejects = scanned.rejected || [];
  const cheapFail = rejects.filter((row) => CHEAP_REASONS.has(row.reason)).length;
  const rpc = resolveSolanaRpc();
  const snaps = [];
  const targets = watchPools(watch).filter((pool) => typeof pool.contract === 'string').sort((a, b) => a.firstSeenAt - b.firstSeenAt).slice(0, 2);
  for (const target of targets) {
    const snap = await readHolderSnapshot(target.contract, { rpcUrl: rpc.url });
    const complete = snap.ok === true && Number.isInteger(snap.holderCount);
    snaps.push({
      contract: target.contract,
      ticker: target.ticker || null,
      ok: complete,
      holderCount: complete ? snap.holderCount : null,
      reason: complete ? null : (snap.reason || 'holder-incomplete'),
      rpc: snap.rpc || null,
      invented: false,
      approved: false,
    });
    await persistObservation(outDir, observeCandidates(loadObservation(outDir), {
      now: cycleStarted,
      source: 'live-readonly',
      rows: [{
        contract: target.contract,
        ticker: target.ticker,
        holders: complete ? snap.holderCount : null,
        holderComplete: complete,
        prospective: true,
        liquidityUsd: null,
      }],
    }).state);
    if (complete) break;
  }
  return {
    ok: discovered.ok === true,
    index,
    startedAtMs: cycleStarted,
    startedAt: new Date(cycleStarted).toISOString(),
    startedCentral: central(cycleStarted),
    endedAt: new Date().toISOString(),
    elapsedMs: Date.now() - cycleStarted,
    gapMs: spacing.gapMs,
    gap: spacing.gap,
    discoveryOk: discovered.ok === true,
    discoveryReason: discovered.reason || null,
    pages: (discovered.calls || []).map((call) => ({ page: call.page, ok: call.ok, status: call.status, reason: call.reason })),
    fetchedPools: (discovered.pools || []).length,
    added: merged.added,
    unique: merged.unique,
    cheapPass: Math.max(0, merged.unique - cheapFail),
    candidates: (scanned.candidates || []).length,
    rejectCounts: countReasons(rejects),
    snaps,
    pausedUntil: budget.pausedUntil || 0,
  };
}
