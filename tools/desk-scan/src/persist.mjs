import { openSync, closeSync, unlinkSync, renameSync, writeFileSync, readFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const tails = new Map();

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquire(lockFile) {
  const staleMs = 60_000;
  try {
    const fd = openSync(lockFile, 'wx');
    writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
    return fd;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    let owner = null;
    try {
      owner = JSON.parse(readFileSync(lockFile, 'utf8'));
    } catch {
      owner = null;
    }
    const age = Date.now() - (statSync(lockFile).mtimeMs || 0);
    if (owner && pidAlive(owner.pid) && age < staleMs) return null;
    if (owner && pidAlive(owner.pid)) return null;
    try { unlinkSync(lockFile); } catch { /* raced */ }
    return null;
  }
}

export function withLock(lockFile, fn) {
  mkdirSync(path.dirname(lockFile), { recursive: true });
  const previous = tails.get(lockFile) || Promise.resolve();
  const run = previous.catch(() => {}).then(async () => {
    const started = Date.now();
    let fd = null;
    while (fd == null) {
      fd = acquire(lockFile);
      if (fd == null) {
        if (Date.now() - started > 15_000) throw new Error(`lock timeout ${lockFile}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    try {
      return await fn();
    } finally {
      try { closeSync(fd); } catch { /* already closed */ }
      try { unlinkSync(lockFile); } catch { /* already released */ }
    }
  });
  tails.set(lockFile, run);
  return run;
}

export function atomicWriteJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

export function readJson(file, fallback = null) {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, 'utf8'));
}

export const CYCLE_MAX_AGE_MS = 10 * 60 * 1000;

export function cycleFresh(report, now = Date.now()) {
  const finished = Date.parse(report?.finishedAt || '');
  if (!Number.isFinite(finished)) return false;
  const age = now - finished;
  return age >= -120_000 && age <= CYCLE_MAX_AGE_MS;
}
