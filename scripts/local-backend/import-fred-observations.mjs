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

function seriesBundles(doc) {
  if (Array.isArray(doc?.series)) {
    return doc.series.map((row) => ({
      series: row?.series,
      httpstatus: row?.httpstatus,
      retrievaltime: row?.retrievaltime,
      observations: Array.isArray(row?.observations)
        ? row.observations
        : (row?.date ? [{ date: row.date, value: row.value }] : null),
    }));
  }
  if (Array.isArray(doc?.observations)) {
    return doc.observations.map((row) => ({
      series: row?.series,
      httpstatus: row?.httpstatus,
      retrievaltime: row?.retrievaltime,
      observations: [{ date: row?.date, value: row?.value }],
    }));
  }
  return null;
}

function chronological(observations) {
  const copy = observations.map((row) => ({ date: row.date, value: row.value }));
  copy.sort((a, b) => a.date.localeCompare(b.date));
  return copy;
}

export function producerStep(observations, stepsBack) {
  if (!Array.isArray(observations) || observations.length <= stepsBack) return null;
  return {
    latest: observations[observations.length - 1],
    prior: observations[observations.length - 1 - stepsBack],
  };
}

export function buildFredImport(doc, now = Date.now()) {
  assertNoSecrets(doc);
  const rows = seriesBundles(doc);
  if (!rows) return { ok: false, reason: 'observations missing' };
  const byId = new Map();
  for (const row of rows) {
    if (!row || typeof row.series !== 'string') return { ok: false, reason: 'series id missing' };
    if (row.httpstatus !== 200) return { ok: false, reason: `${row.series} http ${row.httpstatus}` };
    if (!Array.isArray(row.observations) || row.observations.length === 0) {
      return { ok: false, reason: `${row.series} observations missing` };
    }
    const retrievalMs = Date.parse(row.retrievaltime || '');
    if (!Number.isFinite(retrievalMs)) return { ok: false, reason: `${row.series} retrieval time missing` };
    const ageMs = now - retrievalMs;
    if (ageMs < -120_000) return { ok: false, reason: `${row.series} retrieval time is in the future` };
    if (ageMs > FRED_TTL_SECONDS * 1000) return { ok: false, reason: `${row.series} retrieval is older than ${FRED_TTL_SECONDS}s` };
    const seen = new Set();
    for (const obs of row.observations) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(obs?.date || '')) return { ok: false, reason: `${row.series} date is not YYYY-MM-DD` };
      if (!Number.isFinite(obs.value)) return { ok: false, reason: `${row.series} value is not finite` };
      if (seen.has(obs.date)) return { ok: false, reason: `${row.series} duplicate date ${obs.date}` };
      seen.add(obs.date);
    }
    byId.set(row.series, { ...row, retrievalMs, observations: chronological(row.observations) });
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
          observations: row.observations.map((obs) => ({ date: obs.date, value: String(obs.value) })),
          provenance: {
            kind: 'imported-fred-export',
            recurring: false,
            scheduledRefresh: false,
            httpStatus: 200,
            retrievalTime: row.retrievaltime,
            newestObservationDate: row.observations.at(-1).date,
            oldestObservationDate: row.observations[0].date,
            observationCount: row.observations.length,
          },
        },
      },
    };
  });
  const m2 = producerStep(byId.get('M2SL').observations, 52);
  const walcl = producerStep(byId.get('WALCL').observations, 4);
  return {
    ok: true,
    keys,
    steps: {
      M2SL: m2,
      WALCL: walcl,
    },
    sufficientForAllFearGreedDerivatives: Boolean(m2 && walcl),
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
    const newest = row.value.series.provenance.newestObservationDate;
    const oldest = row.value.series.provenance.oldestObservationDate;
    console.log(`${row.value.series.id} n=${row.value.series.observations.length} ${oldest}..${newest} imported ttl=${row.ttlSeconds}s`);
  }
  if (built.steps.M2SL) {
    const step = built.steps.M2SL;
    console.log(`M2SL 52-step ${step.prior.date} ${step.prior.value} -> ${step.latest.date} ${step.latest.value}`);
  } else {
    console.log('M2SL 52-step unavailable from this export');
  }
  if (built.steps.WALCL) {
    const step = built.steps.WALCL;
    console.log(`WALCL 4-step ${step.prior.date} ${step.prior.value} -> ${step.latest.date} ${step.latest.value}`);
  } else {
    console.log('WALCL 4-step unavailable from this export');
  }
  console.log('scheduled FRED refresh was not run. provenance=imported-fred-export');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
