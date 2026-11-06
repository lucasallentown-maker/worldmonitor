#!/usr/bin/env node
// Localhost FRED refresh. A sanitized history file is imported when no key
// fetch is allowed. The API key is never placed on the command line.
// Key fetch stays untested until the host sets FRED_REFRESH_ALLOW_KEY_FETCH=1.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFredImport } from './import-fred-observations.mjs';
import { readFileSync } from 'node:fs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

export const FRED_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

function localHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export function planFredRefresh(env, now = Date.now()) {
  const host = localHost(env?.UPSTASH_REDIS_REST_URL || '');
  if (!host) return { ok: false, reason: 'redis-url-missing', executed: false };
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    return { ok: false, reason: 'redis-not-localhost', executed: false };
  }
  if (!env.UPSTASH_REDIS_REST_TOKEN) return { ok: false, reason: 'redis-token-missing', executed: false };
  const key = typeof env.FRED_API_KEY === 'string' ? env.FRED_API_KEY.trim() : '';
  if (key) {
    return {
      ok: true,
      mode: 'api-key',
      keyRefresh: 'untested-until-allowed',
      argv: [process.execPath, path.join(ROOT, 'scripts', 'seed-fred-rates.mjs')],
      scheduledRefresh: true,
    };
  }
  const file = env.FRED_OBSERVATION_EXPORT;
  if (!file) return { ok: false, reason: 'fred-source-unconfigured', keyRefresh: 'untested-no-secret', executed: false };
  let built;
  try {
    built = buildFredImport(JSON.parse(readFileSync(file, 'utf8')), now);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'export-unreadable', keyRefresh: 'untested-no-secret', executed: false };
  }
  if (!built.ok) return { ok: false, reason: built.reason, keyRefresh: 'untested-no-secret', executed: false, freshness: 'fail-closed' };
  return {
    ok: true,
    mode: 'sanitized-history',
    keyRefresh: 'untested-no-secret',
    scheduledRefresh: false,
    freshness: 'within-import-ttl',
    argv: [process.execPath, path.join(HERE, 'import-fred-observations.mjs'), file],
  };
}

export function fredTimerDue(lastRunAt, now, intervalMs = FRED_REFRESH_INTERVAL_MS) {
  if (!Number.isFinite(now)) return { ok: false, reason: 'clock-unknown', due: false, dueInMs: null };
  if (!Number.isFinite(lastRunAt)) return { ok: true, reason: 'never-run', due: true, dueInMs: 0 };
  const skew = lastRunAt - now;
  if (skew > 120_000) return { ok: false, reason: 'clock-skew', due: false, dueInMs: null };
  const dueInMs = Math.max(0, intervalMs - (now - lastRunAt));
  return { ok: true, reason: null, due: dueInMs === 0, dueInMs };
}

export function armFredTimer({ lastRunAt, now, schedule, onFire, intervalMs = FRED_REFRESH_INTERVAL_MS }) {
  const due = fredTimerDue(lastRunAt, now, intervalMs);
  if (!due.ok) return { ok: false, reason: due.reason, handle: null };
  const handle = schedule(onFire, due.dueInMs);
  return { ok: true, handle, dueInMs: due.dueInMs, intervalMs };
}

function defaultSpawn(argv, env) {
  const result = spawnSync(argv[0], argv.slice(1), { env, encoding: 'utf8', timeout: 120_000 });
  const text = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (/api_key|FRED_API_KEY|Bearer /i.test(text)) {
    return { code: 1, leaked: true };
  }
  return { code: result.status, leaked: false, text };
}

export async function runFredRefresh(env, { spawn = defaultSpawn, now = Date.now(), allowKeyFetch = false } = {}) {
  const plan = planFredRefresh(env, now);
  if (!plan.ok) return plan;
  const joined = plan.argv.join(' ');
  if (env.FRED_API_KEY && joined.includes(env.FRED_API_KEY)) {
    return { ok: false, reason: 'key-on-argv', executed: false };
  }
  if (plan.mode === 'api-key' && allowKeyFetch !== true) {
    return {
      ok: false,
      executed: false,
      mode: 'api-key',
      keyRefresh: 'untested-no-secret-forward',
      reason: 'key-fetch-not-run',
      argv: plan.argv,
    };
  }
  const childEnv = { ...env };
  const result = spawn(plan.argv, childEnv);
  return {
    ok: result.code === 0 && result.leaked !== true,
    executed: true,
    mode: plan.mode,
    keyRefresh: plan.mode === 'api-key' ? 'executed' : 'untested-no-secret',
    scheduledRefresh: plan.scheduledRefresh,
    freshness: plan.freshness || null,
    code: result.code,
    leaked: result.leaked === true,
  };
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  const result = await runFredRefresh(process.env, {
    allowKeyFetch: process.env.FRED_REFRESH_ALLOW_KEY_FETCH === '1',
  });
  const printable = {
    ok: result.ok,
    mode: result.mode || null,
    reason: result.reason || null,
    keyRefresh: result.keyRefresh || null,
    scheduledRefresh: result.scheduledRefresh === true,
    freshness: result.freshness || null,
    executed: result.executed === true,
  };
  console.log(JSON.stringify(printable));
  process.exit(result.ok ? 0 : 1);
}
