import http from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHandoff, renderHandoffHtml } from './handoff-view.mjs';
import { runObserveCycle } from './observe-cycle.mjs';
import { atomicWriteJson } from './persist.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

export function beginCycle(state) {
  if (state.scanning) {
    state.skipped = 'cycle-still-running';
    return false;
  }
  state.scanning = true;
  state.skipped = null;
  state.phase = 'scanning';
  return true;
}

export function scannerStatus(state, now = Date.now(), cadenceMs = 60_000) {
  const age = Number.isFinite(state?.lastCycleAt) ? now - state.lastCycleAt : null;
  const stale = state?.phase === 'idle' && age != null && age > cadenceMs + 30_000;
  let phase = state?.phase || 'starting';
  if (stale) phase = 'stale';
  return {
    phase,
    scanning: state?.scanning === true,
    skipped: state?.skipped || null,
    lastCycleAt: state?.lastCycleAt ? new Date(state.lastCycleAt).toISOString() : null,
    ageMs: age,
    stale,
    error: state?.error || null,
    cycles: state?.cycles || 0,
    uniquePools: state?.uniquePools || 0,
    survivingCandidates: state?.survivingCandidates || 0,
    suggestedNotionalUsd: 0,
    feeStatus: 'blocked-no-verified-quotes',
    marketScan: 'public-read-only',
    trading: false,
  };
}

export function startLocalScanner({
  host = '127.0.0.1',
  port = 8787,
  outDir,
  configPath,
  runCycle = (dir, previousStartMs) => runObserveCycle(dir, { previousStartMs }),
  cadenceMs = 60_000,
} = {}) {
  if (host !== '127.0.0.1' && host !== '::1') {
    throw new Error('refusing non-loopback bind');
  }
  const state = {
    phase: 'starting',
    scanning: false,
    skipped: null,
    lastCycleAt: null,
    error: null,
    cycles: 0,
    uniquePools: 0,
    survivingCandidates: 0,
    summary: null,
  };
  let timer = null;
  let stopped = false;

  async function tick() {
    if (stopped) return;
    if (!beginCycle(state)) return;
    const previous = state.lastCycleAt;
    try {
      const cycle = await runCycle(outDir, previous);
      state.lastCycleAt = Date.now();
      state.cycles += 1;
      state.uniquePools = cycle?.unique || state.uniquePools;
      state.survivingCandidates = cycle?.candidates || 0;
      state.error = cycle?.ok === false ? (cycle.discoveryReason || 'cycle-failed') : null;
      state.phase = state.error ? 'error' : 'idle';
      if (state.error) console.error(`cycle-failed ${state.error}`);
      state.summary = cycle;
      atomicWriteJson(path.join(outDir, 'status.json'), scannerStatus(state));
    } catch (error) {
      state.lastCycleAt = Date.now();
      state.error = error instanceof Error ? error.message : 'cycle-failed';
      state.phase = 'error';
      atomicWriteJson(path.join(outDir, 'status.json'), scannerStatus(state));
    } finally {
      state.scanning = false;
    }
  }

  const server = http.createServer((request, response) => {
    const remote = request.socket.remoteAddress;
    if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
      response.writeHead(403, { 'Content-Type': 'text/plain' });
      response.end('local only');
      return;
    }
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const status = scannerStatus(state);
    const summary = {
      survivingCandidates: status.survivingCandidates,
      startedCentral: status.lastCycleAt,
      endedCentral: status.lastCycleAt,
      cycles: status.cycles,
      uniquePools: status.uniquePools,
      uniqueAtLastCycle: state.summary?.rejectCounts || {},
      holder: state.summary?.snaps?.[0]?.ok ? {
        mint: state.summary.snaps[0].contract,
        ticker: state.summary.snaps[0].ticker,
        drop: null,
      } : null,
      scanner: status,
    };
    const view = buildHandoff(summary, config);
    view.scanner = status;
    if (state.summary?.snaps?.[0] && state.summary.snaps[0].ok !== true) {
      view.observation.holderDropUnverified = view.observation.holderDropUnverified
        || `Latest holder read did not complete: ${state.summary.snaps[0].reason || 'incomplete'}. It is not an approved candidate.`;
    }
    const html = renderHandoffHtml(view);
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(html);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      timer = setInterval(() => { tick().catch(() => {}); }, cadenceMs);
      tick().catch(() => {});
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}/`,
        address,
        status: () => scannerStatus(state),
        stop: async () => {
          stopped = true;
          clearInterval(timer);
          await new Promise((done) => server.close(() => done()));
        },
      });
    });
  });
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  const outDir = path.join(ROOT, 'local-state');
  mkdirSync(outDir, { recursive: true });
  const scanner = await startLocalScanner({
    outDir,
    configPath: path.join(ROOT, 'paper.bank.json'),
  });
  writeFileSync(path.join(outDir, 'scanner.pid'), `${process.pid}\n`);
  writeFileSync(path.join(outDir, 'port.txt'), `${scanner.address.port}\n`);
  console.log(`local scanner ${scanner.url}`);
  const shutdown = () => {
    const force = setTimeout(() => process.exit(0), 1000);
    force.unref();
    scanner.stop().then(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
