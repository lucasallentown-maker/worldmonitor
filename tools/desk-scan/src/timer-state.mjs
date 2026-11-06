import path from 'node:path';
import { atomicWriteJson, readJson, withLock } from './persist.mjs';
import { PAPER_INTERVALS_MS } from './timers.mjs';

const NAMES = ['risk', 'closePoll', 'chief'];

export function emptyTimerState() {
  return {
    schema: 'paper-timers/v1',
    liveOrder: false,
    timers: {
      risk: { lastFiredAt: null },
      closePoll: { lastFiredAt: null },
      chief: { lastFiredAt: null },
    },
  };
}

export function timerHealth(state, now = Date.now()) {
  if (!state || state.schema !== 'paper-timers/v1' || !state.timers) {
    return { ok: false, reason: 'timer-state-missing', liveOrder: false, timers: {} };
  }
  if (!Number.isFinite(now)) return { ok: false, reason: 'clock-unknown', liveOrder: false, timers: {} };
  const timers = {};
  let invalid = false;
  for (const name of NAMES) {
    const last = state.timers[name]?.lastFiredAt;
    const interval = PAPER_INTERVALS_MS[name];
    if (last == null) {
      timers[name] = { status: 'never-fired', stale: true, dueInMs: 0, lastFiredAt: null };
      continue;
    }
    if (!Number.isFinite(last) || last > now + 120_000) {
      invalid = true;
      timers[name] = { status: 'clock-invalid', stale: true, dueInMs: null, lastFiredAt: null };
      continue;
    }
    const age = now - last;
    timers[name] = {
      status: age >= interval ? 'overdue' : 'ok',
      stale: age >= interval,
      dueInMs: Math.max(0, interval - age),
      lastFiredAt: last,
    };
  }
  return { ok: !invalid, reason: invalid ? 'clock-invalid' : null, liveOrder: false, timers };
}

export function markTimerFired(state, name, now) {
  const next = state && state.schema === 'paper-timers/v1' ? structuredClone(state) : emptyTimerState();
  if (!NAMES.includes(name) || !Number.isFinite(now)) return { ok: false, reason: 'timer-mark-invalid', state: next };
  next.timers[name].lastFiredAt = now;
  next.liveOrder = false;
  return { ok: true, state: next };
}

export function resumeDelays(state, now = Date.now()) {
  const health = timerHealth(state, now);
  if (!health.ok) return { ok: false, reason: health.reason, delays: null };
  const delays = {};
  for (const name of NAMES) delays[name] = health.timers[name].dueInMs;
  return { ok: true, delays, health };
}

export async function persistTimerState(dir, state) {
  const file = path.join(dir, 'timers.json');
  return withLock(path.join(dir, 'timers.lock'), async () => {
    atomicWriteJson(file, state);
    return file;
  });
}

export function loadTimerState(dir) {
  const parsed = readJson(path.join(dir, 'timers.json'), null);
  if (parsed == null) return emptyTimerState();
  if (parsed.schema !== 'paper-timers/v1') return { ok: false, reason: 'timer-state-corrupt' };
  return parsed;
}
