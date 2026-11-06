#!/usr/bin/env node
// Fail closed. Probes the three local endpoints up to 10 times, 3 seconds
// apart. Exits 0 only when one attempt shows all three healthy, with seed-meta
// proving source and freshness. Does not call api.worldmonitor.app.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assessCrossSourceCoverage,
  classifyCrypto,
  classifyFearGreed,
  classifySignals,
  requiredCrossSourceKeys,
} from './classify.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const STATE = path.join(ROOT, '.local-backend');
const ATTEMPTS = 10;
const GAP_MS = 3000;

const ENDPOINTS = [
  {
    id: 'fear-greed',
    path: '/api/market/v1/get-fear-greed-index',
    metaKey: 'seed-meta:market:fear-greed',
    classify: classifyFearGreed,
  },
  {
    id: 'crypto',
    path: '/api/market/v1/list-crypto-quotes',
    metaKey: 'seed-meta:market:crypto',
    classify: classifyCrypto,
  },
  {
    id: 'signals',
    path: '/api/intelligence/v1/list-cross-source-signals',
    metaKey: 'seed-meta:intelligence:cross-source-signals',
    classify: classifySignals,
  },
];

export function loadEnvFile(file) {
  const env = {};
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return env;
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return env;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getJson(url, headers) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'worldmonitor-local-readiness/1.0', ...headers },
    redirect: 'manual',
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  let body = null;
  let parseError = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch (err) {
    parseError = err.message;
  }
  return {
    http: response.status,
    finalUrl: response.url || url,
    bytes: Buffer.byteLength(text),
    body,
    parseError,
    textPreview: text.slice(0, 240),
  };
}

async function redisGet(redisUrl, token, key) {
  const response = await fetch(redisUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'worldmonitor-local-readiness/1.0',
    },
    body: JSON.stringify(['GET', key]),
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return { error: `redis HTTP ${response.status}` };
  const payload = await response.json();
  if (payload.error) return { error: 'redis command error' };
  if (!payload.result) return { value: null };
  try {
    return { value: JSON.parse(payload.result) };
  } catch {
    return { error: 'redis value is not JSON' };
  }
}

async function readSeedMeta(redisUrl, token, key) {
  const got = await redisGet(redisUrl, token, key);
  if (got.error) return got;
  if (got.value == null) return { error: 'redis miss' };
  return { meta: got.value };
}

async function loadCrossSourceCoverage(redisUrl, token, now) {
  const present = {};
  for (const key of requiredCrossSourceKeys(now)) {
    const got = await redisGet(redisUrl, token, key);
    if (got.error) return { error: `${key}: ${got.error}` };
    present[key] = got.value;
  }
  return { coverage: assessCrossSourceCoverage(present, now) };
}

function localUrl(base, endpointPath) {
  const url = new URL(endpointPath, base);
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    throw new Error(`refusing non-local API base ${url.origin}`);
  }
  return url;
}

export async function runReadiness({
  apiBase,
  redisUrl,
  redisToken,
  attempts = ATTEMPTS,
  gapMs = GAP_MS,
  now = () => Date.now(),
} = {}) {
  if (!apiBase || !redisUrl || !redisToken) {
    return {
      ok: false,
      reason: 'WM_API_BASE, UPSTASH_REDIS_REST_URL, and UPSTASH_REDIS_REST_TOKEN are required',
      attempts: [],
    };
  }
  let redisOrigin;
  try {
    redisOrigin = new URL(redisUrl);
  } catch {
    return { ok: false, reason: 'UPSTASH_REDIS_REST_URL is not a URL', attempts: [] };
  }
  if (redisOrigin.hostname !== '127.0.0.1' && redisOrigin.hostname !== 'localhost') {
    return { ok: false, reason: 'refusing non-local Redis REST URL', attempts: [] };
  }

  const history = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const at = new Date(now()).toISOString();
    const row = { attempt, at, endpoints: [] };
    let allOk = true;
    for (const endpoint of ENDPOINTS) {
      const started = Date.now();
      let http = null;
      let classified = { ok: false, reasons: ['not requested'], summary: null };
      try {
        const target = localUrl(apiBase, endpoint.path);
        const got = await getJson(target);
        http = got.http;
        if (got.finalUrl && !got.finalUrl.includes(target.host)) {
          classified = { ok: false, reasons: [`redirected to ${got.finalUrl}`], summary: null };
        } else if (got.http !== 200) {
          classified = {
            ok: false,
            reasons: [`HTTP ${got.http}`, got.parseError || got.textPreview].filter(Boolean),
            summary: { http: got.http, preview: got.textPreview },
          };
        } else if (got.parseError) {
          classified = { ok: false, reasons: [`not JSON: ${got.parseError}`], summary: null };
        } else {
          const metaRead = await readSeedMeta(redisUrl, redisToken, endpoint.metaKey);
          const meta = metaRead.meta ?? null;
          if (metaRead.error) {
            classified = { httpGreen: false, sufficient: false, ok: false, blocked: [], reasons: [metaRead.error], summary: null };
          } else if (endpoint.id === 'signals') {
            const covered = await loadCrossSourceCoverage(redisUrl, redisToken, now());
            if (covered.error) {
              classified = { httpGreen: false, sufficient: false, ok: false, blocked: [covered.error], reasons: [covered.error], summary: null };
            } else {
              classified = endpoint.classify(got.body, meta, now(), covered.coverage);
            }
          } else {
            classified = endpoint.classify(got.body, meta, now());
          }
        }
      } catch (err) {
        classified = { ok: false, reasons: [`${err.name}: ${err.message}`], summary: null };
      }
      if (!classified.ok) allOk = false;
      row.endpoints.push({
        id: endpoint.id,
        path: endpoint.path,
        http,
        httpGreen: classified.httpGreen === true,
        sufficient: classified.sufficient === true,
        ok: classified.ok === true,
        blocked: classified.blocked || [],
        reasons: classified.reasons,
        summary: classified.summary,
        elapsedMs: Date.now() - started,
      });
    }
    row.ok = allOk;
    history.push(row);
    if (allOk) break;
    if (attempt < attempts) await sleep(gapMs);
  }
  const passed = history.some((row) => row.ok);
  const last = history.at(-1);
  const httpGreens = last?.endpoints.filter((endpoint) => endpoint.httpGreen).length ?? 0;
  const sufficientGreens = passed ? 3 : last?.endpoints.filter((endpoint) => endpoint.sufficient).length ?? 0;
  return {
    ok: passed,
    reason: passed
      ? '3/3 sufficient'
      : `HTTP-green ${httpGreens}/3, sufficient ${sufficientGreens}/3`,
    attempts: history,
    greens: sufficientGreens,
    httpGreens,
    sufficientGreens,
  };
}

async function main() {
  const env = {
    ...loadEnvFile(path.join(ROOT, '.env.local-backend')),
    ...process.env,
  };
  const report = await runReadiness({
    apiBase: env.WM_API_BASE || 'http://127.0.0.1:3000',
    redisUrl: env.UPSTASH_REDIS_REST_URL,
    redisToken: env.UPSTASH_REDIS_REST_TOKEN,
  });
  mkdirSync(STATE, { recursive: true });
  const out = {
    schema: 'worldmonitor-local-readiness/v1',
    live: true,
    fixture: false,
    ok: report.ok,
    greens: report.sufficientGreens ?? report.greens,
    httpGreens: report.httpGreens ?? 0,
    sufficientGreens: report.sufficientGreens ?? 0,
    reason: report.reason,
    checkedAt: new Date().toISOString(),
    attemptsRun: report.attempts.length,
    attempts: report.attempts,
  };
  writeFileSync(path.join(STATE, 'readiness.json'), `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
  for (const row of report.attempts) {
    const bits = row.endpoints.map((e) => `${e.id} http=${e.http ?? '-'} httpGreen=${e.httpGreen} sufficient=${e.sufficient}`);
    console.log(`attempt ${row.attempt} ${row.ok ? 'SUFFICIENT' : 'NOT SUFFICIENT'} ${bits.join(' | ')}`);
  }
  console.log(report.ok ? 'SUFFICIENT 3/3' : `NOT SUFFICIENT (${report.reason})`);
  process.exit(report.ok ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error('readiness failed:', err.message);
    process.exit(1);
  });
}
