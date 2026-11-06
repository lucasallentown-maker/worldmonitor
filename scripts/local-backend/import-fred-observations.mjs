#!/usr/bin/env node
// Credential-free import of a sanitized FRED observation export.
// This is a one-time bridge. A normal deploy reads FRED_API_KEY on the host
// through scripts/seed-fred-rates.mjs. This file never asks for or stores a key.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FRED_TTL_SECONDS = 93600;
const REQUIRED = ['M2SL', 'WALCL', 'SOFR', 'BAMLH0A0HYM2', 'BAMLC0A0CM', 'FEDFUNDS', 'T10Y2Y', 'UNRATE'];
const SECRET_KEYS = ['api_key', 'apikey', 'token', 'authorization', 'secret', 'password'];

export function assertNoSecrets(value, pathName = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecrets(item, `${pathName}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEYS.includes(key.toLowerCase())) {
      throw new Error(`refusing secret-looking field ${pathName}.${key}`);
    }
    assertNoSecrets(child, `${pathName}.${key}`);
  }
}

export function buildFredImport(doc, now = Date.now()) {
  assertNoSecrets(doc);
  const rows = Array.isArray(doc?.observations) ? doc.observations : null;
  if (!rows) return { ok: false, reason: 'observations missing' };
  const byId = new Map();
  for (const row of rows) {
    if (!row || typeof row.series !== 'string') return { ok: false, reason: 'series id missing' };
    if (row.httpstatus !== 200) return { ok: false, reason: `${row.series} http ${row.httpstatus}` };
    if (!Number.isFinite(row.value)) return { ok: false, reason: `${row.series} value is not finite` };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date || '')) return { ok: false, reason: `${row.series} date is not YYYY-MM-DD` };
    const retrievalMs = Date.parse(row.retrievaltime || '');
    if (!Number.isFinite(retrievalMs)) return { ok: false, reason: `${row.series} retrieval time missing` };
    const ageMs = now - retrievalMs;
    if (ageMs < -120_000) return { ok: false, reason: `${row.series} retrieval time is in the future` };
    if (ageMs > FRED_TTL_SECONDS * 1000) return { ok: false, reason: `${row.series} retrieval is older than ${FRED_TTL_SECONDS}s` };
    byId.set(row.series, { ...row, retrievalMs });
  }
  for (const series of REQUIRED) {
    if (!byId.has(series)) return { ok: false, reason: `${series} missing from export` };
  }
  const keys = REQUIRED.map((series) => {
    const row = byId.get(series);
    const ttlSeconds = Math.max(1, Math.floor((FRED_TTL_SECONDS * 1000 - (now - row.retrievalMs)) / 1000));
    return {
      key: `economic:fred:v1:${series}:0`,
      metaKey: `seed-meta:economic:fred:v1:${series}`,
      ttlSeconds,
      fetchedAt: row.retrievalMs,
      value: {
        series: {
          id: series,
          observations: [{ date: row.date, value: String(row.value) }],
          provenance: {
            kind: 'imported-fred-export',
            recurring: false,
            httpStatus: 200,
            observationDate: row.date,
            retrievalTime: row.retrievaltime,
          },
        },
      },
    };
  });
  return {
    ok: true,
    keys,
    history: {
      M2SL: 'one observation cannot compute the 52-step M2 change fear-and-greed reads',
      WALCL: 'one observation cannot compute the 4-step balance-sheet change fear-and-greed reads',
    },
    sufficientForAllFearGreedDerivatives: false,
  };
}

async function redisSet(url, token, key, value, ttlSeconds) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'worldmonitor-fred-import/1.0',
    },
    body: JSON.stringify(['SET', key, JSON.stringify(value), 'EX', String(ttlSeconds)]),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`redis HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error('redis command error');
}

async function main() {
  const file = process.argv[2];
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!file || !url || !token) {
    console.error('usage: UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... node scripts/local-backend/import-fred-observations.mjs <export.json>');
    process.exit(2);
  }
  const host = new URL(url).hostname;
  if (host !== '127.0.0.1' && host !== 'localhost') {
    console.error('refusing non-local Redis');
    process.exit(2);
  }
  const built = buildFredImport(JSON.parse(readFileSync(file, 'utf8')));
  if (!built.ok) {
    console.error(built.reason);
    process.exit(1);
  }
  for (const row of built.keys) {
    await redisSet(url, token, row.key, row.value, row.ttlSeconds);
    await redisSet(url, token, row.metaKey, {
      fetchedAt: row.fetchedAt,
      recordCount: 1,
      sourceVersion: 'imported-fred-export',
      recurring: false,
    }, row.ttlSeconds);
    console.log(`${row.value.series.id} ${row.value.series.observations[0].date} imported ttl=${row.ttlSeconds}s`);
  }
  console.log('import bridge complete. M2 YoY and WALCL 4-step change remain impossible from one observation each.');
  console.log('scheduled FRED refresh was not run.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
