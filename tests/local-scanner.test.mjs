import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { beginCycle, scannerStatus, startLocalScanner } from '../tools/desk-scan/src/local-server.mjs';

const configPath = path.resolve('tools/desk-scan/paper.bank.json');

test('a second cycle waits instead of overlapping', () => {
  const state = { scanning: false, skipped: null, phase: 'starting' };
  assert.equal(beginCycle(state), true);
  assert.equal(beginCycle(state), false);
  assert.equal(state.skipped, 'cycle-still-running');
  assert.equal(state.phase, 'scanning');
});

test('idle status becomes stale after the cadence window', () => {
  const now = Date.parse('2026-11-06T12:00:00Z');
  const fresh = scannerStatus({ phase: 'idle', lastCycleAt: now - 60_000, cycles: 1 }, now, 60_000);
  assert.equal(fresh.stale, false);
  assert.equal(fresh.suggestedNotionalUsd, 0);
  const stale = scannerStatus({ phase: 'idle', lastCycleAt: now - 120_000, error: null }, now, 60_000);
  assert.equal(stale.phase, 'stale');
  assert.equal(stale.stale, true);
});

test('the local page refreshes, reports errors, and shuts down', async () => {
  const outDir = await mkdtemp(path.join(tmpdir(), 'scanner spaces '));
  let calls = 0;
  const scanner = await startLocalScanner({
    host: '127.0.0.1',
    port: 0,
    outDir,
    configPath,
    cadenceMs: 60_000,
    runCycle: async () => {
      calls += 1;
      if (calls === 1) throw new Error('public feed failed');
      return { ok: true, unique: 3, candidates: 0, snaps: [{ ok: false, reason: 'holder-incomplete', contract: 'Mint111111111111111111111111111111111111111' }] };
    },
  });
  try {
    assert.equal(scanner.address.address, '127.0.0.1');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const first = await fetch(scanner.url);
    const html = await first.text();
    assert.match(html, /http-equiv="refresh" content="15"/);
    assert.match(html, /Error: public feed failed/);
    assert.match(html, /Suggested paper entry 0/);
    assert.match(html, /not a trade/);
    assert.equal(calls, 1);
    const again = scanner.status();
    assert.equal(again.phase, 'error');
  } finally {
    await scanner.stop();
    await rm(outDir, { recursive: true, force: true });
  }
  await assert.rejects(fetch(scanner.url), /fetch failed|ECONNREFUSED/);
});
