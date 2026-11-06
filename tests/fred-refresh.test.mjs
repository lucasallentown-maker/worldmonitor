import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { armFredTimer, FRED_REFRESH_INTERVAL_MS, fredTimerDue, planFredRefresh, runFredRefresh } from '../scripts/local-backend/fred-refresh.mjs';

const NOW = Date.parse('2026-11-06T12:00:00.000Z');
const HISTORY = new URL('../scripts/local-backend/fred-history-export.json', import.meta.url);

test('the refresh timer waits six hours and does not fire on a future stamp', () => {
  const due = fredTimerDue(NOW - 60 * 60 * 1000, NOW);
  assert.equal(due.due, false);
  assert.equal(due.dueInMs, 5 * 60 * 60 * 1000);
  assert.equal(fredTimerDue(NOW - FRED_REFRESH_INTERVAL_MS, NOW).due, true);
  assert.equal(fredTimerDue(NOW + 5 * 60 * 1000, NOW).reason, 'clock-skew');
  let fired = 0;
  const armed = armFredTimer({
    lastRunAt: NOW - 60 * 60 * 1000,
    now: NOW,
    schedule(fn, ms) {
      assert.equal(ms, 5 * 60 * 60 * 1000);
      return { fn };
    },
    onFire() { fired += 1; },
  });
  assert.equal(armed.ok, true);
  assert.equal(fired, 0);
});

test('sanitized history is planned without a key and a public Redis URL is refused', () => {
  const local = planFredRefresh({
    UPSTASH_REDIS_REST_URL: 'http://127.0.0.1:8079',
    UPSTASH_REDIS_REST_TOKEN: 'local-token',
    FRED_OBSERVATION_EXPORT: HISTORY.pathname,
  }, NOW);
  assert.equal(local.ok, true);
  assert.equal(local.mode, 'sanitized-history');
  assert.equal(local.keyRefresh, 'untested-no-secret');
  assert.equal(local.argv.some((part) => String(part).includes('local-token')), false);
  const stale = planFredRefresh({
    UPSTASH_REDIS_REST_URL: 'http://127.0.0.1:8079',
    UPSTASH_REDIS_REST_TOKEN: 'local-token',
    FRED_OBSERVATION_EXPORT: HISTORY.pathname,
  }, NOW + 40 * 24 * 60 * 60 * 1000);
  assert.equal(stale.ok, false);
  assert.equal(stale.freshness, 'fail-closed');
  assert.match(stale.reason, /older than/);
  const remote = planFredRefresh({
    UPSTASH_REDIS_REST_URL: 'https://example.upstash.io',
    UPSTASH_REDIS_REST_TOKEN: 'local-token',
    FRED_OBSERVATION_EXPORT: HISTORY.pathname,
  }, NOW);
  assert.equal(remote.reason, 'redis-not-localhost');
});

test('a key is not fetched or placed on argv unless the host allows it', async () => {
  const calls = [];
  const blocked = await runFredRefresh({
    UPSTASH_REDIS_REST_URL: 'http://127.0.0.1:8079',
    UPSTASH_REDIS_REST_TOKEN: 'local-token',
    FRED_API_KEY: 'not-a-real-key',
    FRED_OBSERVATION_EXPORT: HISTORY.pathname,
  }, {
    now: NOW,
    allowKeyFetch: false,
    spawn(argv) {
      calls.push(argv);
      return { code: 0, leaked: false };
    },
  });
  assert.equal(blocked.reason, 'key-fetch-not-run');
  assert.equal(blocked.keyRefresh, 'untested-no-secret-forward');
  assert.equal(calls.length, 0);
  const allowed = await runFredRefresh({
    UPSTASH_REDIS_REST_URL: 'http://127.0.0.1:8079',
    UPSTASH_REDIS_REST_TOKEN: 'local-token',
    FRED_API_KEY: 'not-a-real-key',
  }, {
    now: NOW,
    allowKeyFetch: true,
    spawn(argv) {
      calls.push(argv.join(' '));
      return { code: 0, leaked: false };
    },
  });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.keyRefresh, 'executed');
  assert.equal(calls[0].includes('not-a-real-key'), false);
  assert.match(calls[0], /seed-fred-rates\.mjs$/);
});

test('the systemd unit is a six hour localhost timer and is not enabled here', () => {
  const service = readFileSync(new URL('../scripts/local-backend/systemd/worldmonitor-fred-refresh.service', import.meta.url), 'utf8');
  const timer = readFileSync(new URL('../scripts/local-backend/systemd/worldmonitor-fred-refresh.timer', import.meta.url), 'utf8');
  assert.match(service, /fred-refresh\.mjs/);
  assert.doesNotMatch(service, /api_key|Bearer /);
  assert.match(timer, /OnUnitActiveSec=6h/);
  assert.equal(FRED_REFRESH_INTERVAL_MS, 6 * 60 * 60 * 1000);
});
