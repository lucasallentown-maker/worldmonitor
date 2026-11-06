#!/usr/bin/env node
// Paper scanner. Live mode calls public GeckoTerminal and Solana RPC read methods.
// It does not place orders or touch a wallet. Chief stays NOT_READY.

import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPaperScan } from './src/live.mjs';
import { runPaperFixture } from './src/paper-cycle.mjs';
import { planExecutablePaper } from './src/executable.mjs';
import { buildOrderPreview } from './src/order-preview.mjs';
import { configGuide } from './src/config.mjs';
import { loadObservation, observeCandidates, persistObservation, rowsFromScan } from './src/observe.mjs';
import { loadTimerState, timerHealth } from './src/timer-state.mjs';
import { atomicWriteJson, withLock } from './src/persist.mjs';
import { scanCycle } from './src/scan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

const outDir = arg('--out') || path.join(HERE, 'state');
mkdirSync(outDir, { recursive: true });

const paperFixturePath = arg('--paper-fixture');
if (paperFixturePath) {
  const paperFixture = readJson(paperFixturePath);
  if (paperFixture.fixture !== true || paperFixture.label !== 'FIXTURE — not live market data') {
    console.error('refusing paper fixture that is not explicitly labeled');
    process.exit(2);
  }
  const result = runPaperFixture(paperFixture);
  const output = {
    schema: 'paper-accept/v1',
    live: false,
    fixture: true,
    fixtureLabel: paperFixture.label,
    ok: result.ok === true && result.secondClose?.deleted === false && result.secondClose?.reason === 'position-missing',
    stage: result.stage,
    idempotent: result.replay?.idempotent === true,
    closeDeleted: result.closed?.deleted === true,
    secondCloseDeleted: result.secondClose?.deleted === true,
    humanWatch: result.chief?.humanWatch === true,
    liveOrder: false,
  };
  atomicWriteJson(path.join(outDir, 'paper-accept.json'), output);
  console.log(output.ok ? 'PAPER FIXTURE PASS' : `PAPER FIXTURE FAIL stage=${result.stage}`);
  process.exit(output.ok ? 0 : 1);
}

if (process.argv.includes('--config-guide')) {
  console.log(configGuide());
  process.exit(0);
}

const observeFixturePath = arg('--observe-fixture');
if (observeFixturePath) {
  const observedFixture = readJson(observeFixturePath);
  if (observedFixture.fixture !== true || observedFixture.label !== 'FIXTURE — not live market data') {
    console.error('refusing observation fixture that is not explicitly labeled');
    process.exit(2);
  }
  const observed = observeCandidates(loadObservation(outDir), {
    now: observedFixture.now,
    rows: observedFixture.rows,
    source: 'fixture',
  });
  await persistObservation(outDir, observed.state);
  const recordCount = Object.keys(observed.state.records).length;
  console.log(`OBSERVE FIXTURE records=${recordCount} sized=${observed.state.sizedPositions} orders=${observed.state.liveOrder}`);
  process.exit(observed.ok && observed.state.sizedPositions === false ? 0 : 1);
}

if (process.argv.includes('--timer-health')) {
  const loaded = loadTimerState(outDir);
  const health = timerHealth(loaded.ok === false ? null : loaded, Date.now());
  console.log(JSON.stringify({ ok: health.ok, reason: health.reason, liveOrder: false, timers: health.timers }));
  process.exit(health.ok ? 0 : 1);
}

if (process.argv.includes('--order-preview')) {
  const previewConfigPath = arg('--paper-config') || path.join(HERE, 'paper.bank.json');
  const preview = buildOrderPreview({ config: readJson(previewConfigPath), now: Date.now() });
  atomicWriteJson(path.join(outDir, 'order-preview.json'), preview);
  console.log(`ORDER PREVIEW NOT SUBMITTED blockers=${preview.blockers.join(',') || 'none'} venueApi=${preview.venueApi}`);
  process.exit(preview.submitted ? 1 : 0);
}

const paperConfigPath = arg('--paper-config');
if (paperConfigPath) {
  const plan = planExecutablePaper(readJson(paperConfigPath), {});
  atomicWriteJson(path.join(outDir, 'paper-config.json'), plan);
  const unset = (plan.missing || []).filter(Boolean).join(',');
  console.log(plan.ok ? 'PAPER CONFIG PASS' : `PAPER CONFIG ${plan.reason || 'UNSET'}${unset ? ` ${unset}` : ''}`);
  process.exit(plan.ok ? 0 : 2);
}

const fixturePath = arg('--fixture');

function recordedSufficient() {
  try {
    const report = JSON.parse(readFileSync(path.resolve(HERE, '../../.local-backend/readiness.json'), 'utf8'));
    return Number.isInteger(report.sufficientGreens) ? report.sufficientGreens : 0;
  } catch {
    return 0;
  }
}

if (!fixturePath) {
  const wmSufficient = recordedSufficient();
  const env = {};
  try {
    const text = readFileSync(path.resolve(HERE, '../../.env.local-backend'), 'utf8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
      const eq = trimmed.indexOf('=');
      if (!env[trimmed.slice(0, eq)]) env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
    }
  } catch {
    // optional local env
  }
  if (env.SOLANA_RPC_URL && !process.env.SOLANA_RPC_URL) process.env.SOLANA_RPC_URL = env.SOLANA_RPC_URL;
  const report = await runPaperScan({ stateDir: outDir, wmSufficient });
  if (process.argv.includes('--observe')) {
    const observed = observeCandidates(loadObservation(outDir), {
      now: Date.now(),
      rows: rowsFromScan(report),
      source: 'live-scan',
    });
    await persistObservation(outDir, observed.state);
    console.log(`OBSERVE live records=${Object.keys(observed.state.records).length} sized=false`);
  }
  const line = report.stopped
    ? 'stopped because position.json is present'
    : `discovery=${report.discovery?.ok ? report.discovery.pools : report.discovery?.reason} candidates=${report.candidates.length} holder=${report.holderProbe?.ok ? 'ok' : report.holderProbe?.reason || 'not-run'}`;
  console.log(line);
  console.log(`chief ${report.chief.status}: ${report.chief.reason}`);
  process.exit(report.chief.ready ? 0 : 3);
}

const fixture = readJson(fixturePath);
if (fixture.fixture !== true || fixture.label !== 'FIXTURE — not live market data') {
  console.error('refusing fixture that is not explicitly labeled');
  process.exit(2);
}

const positionFile = path.join(outDir, 'position.json');
const benchFile = path.join(outDir, 'bench.json');
const result = await withLock(path.join(outDir, 'scan.lock'), async () => {
  const position = existsSync(positionFile) ? readJson(positionFile) : null;
  const bench = existsSync(benchFile) ? readJson(benchFile) : (fixture.bench || {});
  const scanned = scanCycle({
    ...fixture,
    position,
    bench,
    source: 'fixture',
  });
  if (!scanned.stopped) atomicWriteJson(benchFile, scanned.bench);
  const output = {
    schema: 'desk-scan/v1',
    live: false,
    fixture: true,
    fixtureLabel: fixture.label,
    stopped: scanned.stopped,
    reason: scanned.reason,
    candidates: scanned.candidates,
    rejected: scanned.rejected,
    context: scanned.context,
    chief: scanned.chief,
    finishedAt: new Date().toISOString(),
  };
  atomicWriteJson(path.join(outDir, 'scan.json'), output);
  return output;
});
console.log(`fixture scan candidates=${result.candidates.length} chief=${result.chief.status}`);
process.exit(result.chief.ready ? 0 : 3);
