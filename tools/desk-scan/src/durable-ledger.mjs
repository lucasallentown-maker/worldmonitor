// Durable paper journal. The journal is the source of truth. The positions
// file is rewritten only after the journal rename. A kill before that rename
// keeps the position. Temporary files are never read back.

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import path from 'node:path';
import { withLock } from './persist.mjs';
import { paperClose, paperOpen, recoverLedger } from './paper-ledger.mjs';

export const CLOSE_CRASH_POINTS = Object.freeze([
  'lock-held',
  'before-journal-write',
  'journal-partial',
  'journal-temp',
  'journal-rename',
  'position-temp',
  'position-rename',
]);

function crash(crashAt, point) {
  if (crashAt === point) process.kill(process.pid, 'SIGKILL');
}

function writeDurable(file, value, crashAt, stage) {
  const tmp = `${file}.${process.pid}.tmp`;
  if (crashAt === `${stage}-partial`) {
    const partial = openSync(tmp, 'w', 0o600);
    writeSync(partial, '{');
    fsyncSync(partial);
    closeSync(partial);
    crash(crashAt, `${stage}-partial`);
  }
  const fd = openSync(tmp, 'w', 0o600);
  writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
  fsyncSync(fd);
  closeSync(fd);
  crash(crashAt, `${stage}-temp`);
  renameSync(tmp, file);
  crash(crashAt, `${stage}-rename`);
}

export function journalFile(dir) {
  return path.join(dir, 'journal.json');
}

export function positionsFile(dir) {
  return path.join(dir, 'positions.json');
}

export function lockFile(dir) {
  return path.join(dir, 'ledger.lock');
}

export function readDurableJournal(dir) {
  const file = journalFile(dir);
  if (!existsSync(file)) return { ok: true, events: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(parsed)) return { ok: false, reason: 'journal-corrupt', events: [] };
    return { ok: true, events: parsed };
  } catch {
    return { ok: false, reason: 'journal-corrupt', events: [] };
  }
}

export function recoverDurable(dir) {
  const journal = readDurableJournal(dir);
  if (!journal.ok) return { ok: false, reason: journal.reason, ledger: null, confirmedCloses: 0, positionIds: [] };
  const ledger = recoverLedger(journal.events);
  let stalePositions = null;
  if (existsSync(positionsFile(dir))) {
    try {
      stalePositions = JSON.parse(readFileSync(positionsFile(dir), 'utf8'));
    } catch {
      stalePositions = null;
    }
  }
  const confirmedCloses = ledger.events.filter((row) => row?.type === 'paper-close' && row.confirmed === true).length;
  return {
    ok: true,
    ledger,
    stalePositions,
    confirmedCloses,
    positionIds: Object.keys(ledger.positions),
  };
}

function mutate(dir, crashAt, apply) {
  mkdirSync(dir, { recursive: true });
  return withLock(lockFile(dir), async () => {
    crash(crashAt, 'lock-held');
    const current = readDurableJournal(dir);
    if (!current.ok) return { ok: false, reason: current.reason };
    const result = apply(recoverLedger(current.events));
    crash(crashAt, 'before-journal-write');
    writeDurable(journalFile(dir), result.ledger.events, crashAt, 'journal');
    writeDurable(positionsFile(dir), result.ledger.positions, crashAt, 'position');
    return result;
  });
}

export function durableOpen(dir, intent, options = {}) {
  return mutate(dir, options.crashAt, (ledger) => paperOpen(ledger, intent));
}

export function durableClose(dir, close, options = {}) {
  return mutate(dir, options.crashAt, (ledger) => paperClose(ledger, close));
}
