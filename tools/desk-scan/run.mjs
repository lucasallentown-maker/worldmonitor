#!/usr/bin/env node
// Paper scanner. Live mode calls public GeckoTerminal and Solana RPC read methods.
// It does not place orders or touch a wallet. Chief stays NOT_READY.

import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPaperScan } from './src/live.mjs';
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

const fixturePath = arg('--fixture');
const outDir = arg('--out') || path.join(HERE, 'state');
mkdirSync(outDir, { recursive: true });

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
