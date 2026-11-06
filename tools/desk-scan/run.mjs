#!/usr/bin/env node
// Research scanner. Live GeckoTerminal and Solana RPC calls are not implemented.
// Without a labeled fixture this process fail-closes and writes no candidates.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chiefReport } from './src/rules.mjs';
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

function recordedGreens() {
  try {
    const report = JSON.parse(readFileSync(path.resolve(HERE, '../../.local-backend/readiness.json'), 'utf8'));
    return Number.isInteger(report.greens) ? report.greens : 0;
  } catch {
    return 0;
  }
}

if (!fixturePath) {
  const greens = recordedGreens();
  const chief = chiefReport(greens, 0);
  chief.ready = false;
  chief.status = 'NOT_READY';
  chief.reason = 'live-rpc-not-configured';
  const report = {
    schema: 'desk-scan/v1',
    live: false,
    fixture: false,
    ok: false,
    reason: 'live RPC not executed: GeckoTerminal and Solana RPC clients are not configured. Refusing to invent candidates.',
    wm_greens: greens,
    chief,
    candidates: [],
  };
  writeFileSync(path.join(outDir, 'scan.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.error(report.reason);
  process.exit(2);
}

const fixture = readJson(fixturePath);
if (fixture.fixture !== true || fixture.label !== 'FIXTURE — not live market data') {
  console.error('refusing fixture that is not explicitly labeled');
  process.exit(2);
}

const positionFile = path.join(outDir, 'position.json');
const benchFile = path.join(outDir, 'bench.json');
const position = existsSync(positionFile) ? readJson(positionFile) : null;
const bench = existsSync(benchFile) ? readJson(benchFile) : (fixture.bench || {});
const result = scanCycle({
  ...fixture,
  position,
  bench,
  source: 'fixture',
});
if (!result.stopped) writeFileSync(benchFile, `${JSON.stringify(result.bench, null, 2)}\n`);
const output = {
  schema: 'desk-scan/v1',
  live: false,
  fixture: true,
  fixtureLabel: fixture.label,
  stopped: result.stopped,
  reason: result.reason,
  candidates: result.candidates,
  rejected: result.rejected,
  context: result.context,
  chief: result.chief,
};
writeFileSync(path.join(outDir, 'scan.json'), `${JSON.stringify(output, null, 2)}\n`);
console.log(`fixture scan candidates=${result.candidates.length} chief=${result.chief.status}`);
process.exit(result.chief.ready ? 0 : 3);
