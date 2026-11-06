#!/usr/bin/env node
// Read-only observation. No orders, no wallet, no fabricated holder counts.

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { discoverNewPools } from './src/geckoterminal.mjs';
import { scanCycle } from './src/scan.mjs';
import { readHolderSnapshot, resolveSolanaRpc } from './src/solana-holders.mjs';
import { atomicWriteJson, readJson } from './src/persist.mjs';
import { loadObservation, observeCandidates, persistObservation } from './src/observe.mjs';
import { cadenceGap, emptyWatch, upsertWatch, watchPools } from './src/watch.mjs';
import { holderHistoryReady } from './src/vet.mjs';

const CADENCE_MS = 60_000;
const MINUTES = Number(process.env.OBSERVE_MINUTES || 20);
const OUT = process.env.OBSERVE_OUT || path.resolve('tools/desk-scan/observe-run');

function central(ms) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
  }).format(new Date(ms));
}

function countReasons(rows) {
  const counts = {};
  for (const row of rows) counts[row.reason] = (counts[row.reason] || 0) + 1;
  return counts;
}

function holderTargets(watch) {
  return watchPools(watch)
    .filter((pool) => typeof pool.contract === 'string')
    .sort((a, b) => a.firstSeenAt - b.firstSeenAt)
    .slice(0, 2);
}

mkdirSync(OUT, { recursive: true });
const budgetFile = path.join(OUT, 'gt-budget.json');
const watchFile = path.join(OUT, 'watch.json');
const cyclesFile = path.join(OUT, 'cycles.json');
const logFile = path.join(OUT, 'observe.log');
const summaryFile = path.join(OUT, 'summary.json');

const cycles = [];
const logLines = [];
let stop = false;
process.on('SIGTERM', () => { stop = true; });
process.on('SIGINT', () => { stop = true; });

function log(line) {
  const text = `${new Date().toISOString()} ${line}`;
  logLines.push(text);
  console.log(text);
}

const runStarted = Date.now();
const deadline = runStarted + MINUTES * 60_000;
log(`observe-live start central=${central(runStarted)} minutes=${MINUTES} cadenceMs=${CADENCE_MS}`);

while (!stop && Date.now() < deadline) {
  const cycleStarted = Date.now();
  const previousStart = cycles.at(-1)?.startedAtMs ?? null;
  const spacing = cadenceGap(previousStart, cycleStarted, CADENCE_MS);
  let budget = readJson(budgetFile, { calls: [], pausedUntil: 0 });
  let watch = readJson(watchFile, emptyWatch());
  const discovered = await discoverNewPools({ state: budget, startedAt: cycleStarted });
  budget = discovered.state || budget;
  atomicWriteJson(budgetFile, budget);
  const merged = upsertWatch(watch, discovered.pools || [], cycleStarted);
  watch = merged.watch;
  atomicWriteJson(watchFile, watch);
  const benchFile = path.join(OUT, 'bench.json');
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
  const rpc = resolveSolanaRpc();
  const snaps = [];
  for (const target of holderTargets(watch)) {
    const snap = await readHolderSnapshot(target.contract, { rpcUrl: rpc.url });
    const complete = snap.ok === true && Number.isInteger(snap.holderCount);
    snaps.push({
      contract: target.contract,
      ok: complete,
      holderCount: complete ? snap.holderCount : null,
      reason: complete ? null : (snap.reason || 'holder-incomplete'),
      rpc: snap.rpc || null,
      invented: false,
    });
    await persistObservation(OUT, observeCandidates(loadObservation(OUT), {
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
  const endedAt = Date.now();
  const cycle = {
    index: cycles.length + 1,
    startedAtMs: cycleStarted,
    startedAt: new Date(cycleStarted).toISOString(),
    startedCentral: central(cycleStarted),
    endedAt: new Date(endedAt).toISOString(),
    elapsedMs: endedAt - cycleStarted,
    gapMs: spacing.gapMs,
    gap: spacing.gap,
    discoveryOk: discovered.ok === true,
    discoveryReason: discovered.reason || null,
    pages: (discovered.calls || []).map((call) => ({ page: call.page, ok: call.ok, status: call.status, reason: call.reason })),
    fetchedPools: (discovered.pools || []).length,
    added: merged.added,
    unique: merged.unique,
    cheapPass: Math.max(0, merged.unique - rejects.filter((row) => row.reason === 'pool-missing' || row.reason === 'contract-missing' || row.reason === 'ticker-missing' || row.reason === 'age-missing' || row.reason === 'age-outside-10m-48h' || row.reason === 'liquidity-below-15k' || row.reason === 'volume-h24-below-50k' || row.reason === 'mcap-missing-fdv-not-accepted' || row.reason === 'mcap-outside-80k-6m').length),
    candidates: (scanned.candidates || []).length,
    rejectCounts: countReasons(rejects),
    snaps,
    pausedUntil: budget.pausedUntil || 0,
  };
  cycles.push(cycle);
  atomicWriteJson(cyclesFile, cycles);
  log(`cycle=${cycle.index} fetched=${cycle.fetchedPools} unique=${cycle.unique} candidates=${cycle.candidates} discovery=${cycle.discoveryReason || 'ok'} snaps=${snaps.map((row) => `${row.ok ? row.holderCount : row.reason}`).join('|') || 'none'} gapMs=${spacing.gapMs}`);
  const remain = CADENCE_MS - (Date.now() - cycleStarted);
  if (remain > 0 && !stop && Date.now() + remain < deadline + CADENCE_MS) {
    await new Promise((resolve) => setTimeout(resolve, remain));
  }
}

const observation = loadObservation(OUT);
const histories = Object.values(observation.records || {}).map((row) => {
  const ready = holderHistoryReady(row.holderHistory || []);
  return {
    contract: row.contract,
    ticker: row.ticker,
    completeSnapshots: (row.holderHistory || []).filter((snap) => snap.complete === true).length,
    spanReady: ready.ok === true,
    spanMs: ready.spanMs ?? null,
    reason: ready.reason || null,
  };
});
const rejectTotals = {};
for (const cycle of cycles) {
  for (const [reason, count] of Object.entries(cycle.rejectCounts || {})) {
    rejectTotals[reason] = (rejectTotals[reason] || 0) + count;
  }
}
const summary = {
  schema: 'observe-live-summary/v1',
  live: true,
  fixture: false,
  orders: false,
  paperBuys: false,
  startedAt: new Date(runStarted).toISOString(),
  startedCentral: central(runStarted),
  endedAt: new Date().toISOString(),
  endedCentral: central(Date.now()),
  elapsedMs: Date.now() - runStarted,
  requestedMinutes: MINUTES,
  cadenceMs: CADENCE_MS,
  cycles: cycles.length,
  gaps: cycles.filter((cycle) => cycle.gap).length,
  fetchedPoolRows: cycles.reduce((sum, cycle) => sum + cycle.fetchedPools, 0),
  uniquePools: readJson(watchFile, emptyWatch()).pools ? Object.keys(readJson(watchFile, emptyWatch()).pools).length : 0,
  cheapPassLastCycle: cycles.at(-1)?.cheapPass ?? 0,
  survivingCandidates: cycles.reduce((sum, cycle) => sum + (cycle.candidates || 0), 0),
  rejectTotals,
  histories,
  twoSnapshotsTenMinutesApart: histories.some((row) => row.spanReady),
  discoveryErrors: cycles.filter((cycle) => cycle.discoveryOk !== true).map((cycle) => ({ index: cycle.index, reason: cycle.discoveryReason })),
  continuous: cycles.every((cycle) => !cycle.gap),
  note: 'Surviving candidates are pools that passed every existing gate. Cheap-pass is only the first filter. Holder counts are present only when a public RPC snapshot completed. No fee was invented.',
};
atomicWriteJson(summaryFile, summary);
atomicWriteJson(logFile, { lines: logLines });
log(`observe-live stop central=${summary.endedCentral} cycles=${summary.cycles} unique=${summary.uniquePools} tenMinutePair=${summary.twoSnapshotsTenMinutesApart}`);
