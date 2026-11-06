import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CLOSE_CRASH_POINTS, durableClose, recoverDurable } from '../tools/desk-scan/src/durable-ledger.mjs';

const SCRIPT = path.resolve('tools/desk-scan/crash-close.mjs');
const KEEPS_POSITION = new Set(['lock-held', 'before-journal-write', 'journal-partial', 'journal-temp']);

function killAt(dir, crashAt) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, '--dir', dir, '--crash-at', crashAt], { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`crash child hung at ${crashAt}`));
    }, 5000);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

test('SIGKILL at each close write boundary recovers once from the journal', async () => {
  for (const point of CLOSE_CRASH_POINTS) {
    const dir = await mkdtemp(path.join(tmpdir(), `paper-kill-${point}-`));
    try {
      const killed = await killAt(dir, point);
      assert.equal(killed.signal, 'SIGKILL', point);
      const first = recoverDurable(dir);
      assert.equal(first.ok, true, point);
      const again = recoverDurable(dir);
      assert.deepEqual(again.positionIds, first.positionIds, point);
      assert.equal(again.confirmedCloses, first.confirmedCloses, point);
      if (KEEPS_POSITION.has(point)) {
        assert.deepEqual(first.positionIds, ['paper-1'], point);
        assert.equal(first.confirmedCloses, 0, point);
        assert.equal(first.ledger.positions['paper-1'].status, 'open', point);
        const closed = await durableClose(dir, {
          id: 'paper-1',
          at: Date.parse('2026-11-06T12:00:02.000Z'),
          paperPrice: 1.1,
          confirmed: true,
          provenance: 'paper-crash-test',
        });
        assert.equal(closed.deleted, true, point);
      } else {
        assert.deepEqual(first.positionIds, [], point);
        assert.equal(first.confirmedCloses, 1, point);
        if (point === 'journal-rename') {
          assert.ok(first.stalePositions?.['paper-1'], point);
        }
      }
      const replay = await durableClose(dir, {
        id: 'paper-1',
        at: Date.parse('2026-11-06T12:00:03.000Z'),
        paperPrice: 1.1,
        confirmed: true,
        provenance: 'paper-crash-test',
      });
      assert.equal(replay.deleted, false, point);
      assert.equal(replay.reason, 'position-missing', point);
      const finalState = recoverDurable(dir);
      assert.equal(finalState.confirmedCloses, 1, point);
      assert.deepEqual(finalState.positionIds, [], point);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});
