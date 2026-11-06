import assert from 'node:assert/strict';
import test from 'node:test';
import { assessCrossSourceCoverage, classifyCrypto, classifyFearGreed, classifySignals, requiredCrossSourceKeys } from '../scripts/local-backend/classify.mjs';
import { runReadiness } from '../scripts/local-backend/readiness.mjs';

const NOW = Date.parse('2026-11-06T06:10:00.000Z');
const FRESH = NOW - 60_000;

function meta(sourceVersion, recordCount) {
  return { fetchedAt: FRESH, recordCount, sourceVersion };
}

function fearBody(overrides = {}) {
  return {
    compositeScore: 54.2,
    compositeLabel: 'Neutral',
    unavailable: false,
    seededAt: new Date(FRESH).toISOString(),
    vix: 18.4,
    sectorPerformance: [{ symbol: 'XLK', name: 'Technology', change1d: 0.4 }],
    sentiment: { score: 50, degraded: false },
    breadth: { score: 61, degraded: false },
    ...overrides,
  };
}

test('FIXTURE fear-greed HTTP-green is not sufficient without FRED inputs', () => {
  const partial = classifyFearGreed(fearBody(), meta('yahoo-cboe-cnn-fred-v1', 1), NOW);
  assert.equal(partial.httpGreen, true, partial.reasons.join('; '));
  assert.equal(partial.sufficient, false);
  assert.equal(partial.ok, false);
  assert.ok(partial.blocked.some((line) => line.includes('FRED:M2SL')));

  const complete = classifyFearGreed(fearBody({
    liquidity: { inputs: { m2Yoy: 4.2, fedBsMom: 0.1, sofr: 4.3 } },
    credit: { inputs: { hySpread: 3.1, igSpread: 1.1 } },
    macro: { inputs: { fedRate: 4.5, t10y2y: 0.4, unrate: 4.1 } },
  }), meta('yahoo-cboe-cnn-fred-v1', 1), NOW);
  assert.equal(complete.sufficient, true, complete.reasons.join('; '));
  assert.equal(complete.summary.source.sourceVersion, 'yahoo-cboe-cnn-fred-v1');

  const degraded = classifyFearGreed(fearBody({ breadth: { score: 50, degraded: true } }), meta('yahoo-cboe-cnn-fred-v1', 1), NOW);
  assert.equal(degraded.ok, false);
  assert.match(degraded.reasons.join(' '), /degraded categories: breadth/);

  const unavailable = classifyFearGreed(
    { compositeScore: 0, compositeLabel: '', unavailable: true },
    meta('yahoo-cboe-cnn-fred-v1', 1),
    NOW,
  );
  assert.equal(unavailable.ok, false);

  const hosted = classifyFearGreed(fearBody({ note: 'https://api.worldmonitor.app/x' }), meta('yahoo-cboe-cnn-fred-v1', 1), NOW);
  assert.equal(hosted.ok, false);
});

test('FIXTURE crypto rejects degraded, empty, and unsourced quotes', () => {
  const quotes = [{ symbol: 'BTC', price: 100000, change: 1.2 }];
  const ok = classifyCrypto(
    { provider: 'seed', quotes, unresolvedIds: [] },
    meta('coinpaprika-tickers+coingecko-fallback', 1),
    NOW,
  );
  assert.equal(ok.ok, true, ok.reasons.join('; '));

  const degraded = classifyCrypto(
    { provider: 'degraded', quotes: [], unresolvedIds: [] },
    meta('coinpaprika-tickers+coingecko-fallback', 1),
    NOW,
  );
  assert.equal(degraded.ok, false);
  assert.match(degraded.reasons.join(' '), /degraded/);

  const mismatch = classifyCrypto(
    { provider: 'seed', quotes, unresolvedIds: [] },
    meta('coinpaprika-tickers+coingecko-fallback', 2),
    NOW,
  );
  assert.equal(mismatch.ok, false);
});

test('FIXTURE cross-source signals require a fresh non-empty seed', () => {
  const signal = {
    id: 'weather:north-america',
    type: 'CROSS_SOURCE_SIGNAL_TYPE_WEATHER_EXTREME',
    theater: 'North America',
    summary: 'Extreme weather: 3 active extreme alerts in North America',
    severity: 'CROSS_SOURCE_SIGNAL_SEVERITY_MEDIUM',
    severityScore: 2,
    detectedAt: FRESH,
    contributingTypes: [],
    signalCount: 0,
  };
  const httpOnly = classifySignals(
    { signals: [signal], evaluatedAt: FRESH, compositeCount: 0 },
    meta('cross-source-v1', 1),
    NOW,
  );
  assert.equal(httpOnly.httpGreen, true, httpOnly.reasons.join('; '));
  assert.equal(httpOnly.sufficient, false);

  const present = {};
  for (const key of requiredCrossSourceKeys(NOW)) {
    present[key] = { _seed: { fetchedAt: FRESH } };
  }
  const coverage = assessCrossSourceCoverage(present, NOW);
  const full = classifySignals(
    { signals: [signal], evaluatedAt: FRESH, compositeCount: 0 },
    meta('cross-source-v1', 1),
    NOW,
    coverage,
  );
  assert.equal(full.sufficient, true, full.reasons.join('; '));
  delete present['wildfire:fires:v1'];
  const sparse = assessCrossSourceCoverage(present, NOW);
  const blocked = classifySignals(
    { signals: [signal], evaluatedAt: FRESH, compositeCount: 0 },
    meta('cross-source-v1', 1),
    NOW,
    sparse,
  );
  assert.equal(blocked.sufficient, false);
  assert.match(blocked.blocked.join(' '), /sparse cross-source/);
  assert.match(blocked.blocked.join(' '), /NASA_FIRMS_API_KEY/);

  const empty = classifySignals(
    { signals: [], evaluatedAt: FRESH, compositeCount: 0 },
    meta('cross-source-v1', 0),
    NOW,
  );
  assert.equal(empty.ok, false);
  assert.match(empty.reasons.join(' '), /no signals/);
});

test('readiness refuses a non-local Redis URL before any request', async () => {
  const report = await runReadiness({
    apiBase: 'http://127.0.0.1:3000',
    redisUrl: 'https://example.upstash.io',
    redisToken: 'not-sent',
    attempts: 1,
  });
  assert.equal(report.ok, false);
  assert.match(report.reason, /non-local/);
  assert.equal(report.attempts.length, 0);
});
