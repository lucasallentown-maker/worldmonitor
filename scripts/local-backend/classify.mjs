// Health rules for the three local RPC endpoints. A degraded or empty payload
// is not healthy. Nothing in here calls the network or substitutes data.

export const FEAR_GREED_MAX_AGE_MS = 720 * 60 * 1000;
export const CRYPTO_MAX_AGE_MS = 30 * 60 * 1000;
export const SIGNALS_MAX_AGE_MS = 30 * 60 * 1000;

const FEAR_GREED_LABELS = new Set([
  'Extreme Fear',
  'Fear',
  'Neutral',
  'Greed',
  'Extreme Greed',
]);

const CRYPTO_PROVIDERS = new Set(['seed', 'upstream', 'mixed']);

function rejectHostedFallback(body) {
  const text = JSON.stringify(body);
  if (text.includes('api.worldmonitor.app')) {
    return 'response references api.worldmonitor.app';
  }
  return null;
}

export function assertSeedMeta(meta, { maxAgeMs, minRecords, now }) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    return { ok: false, reason: 'seed-meta missing' };
  }
  if (meta.status === 'error') return { ok: false, reason: 'seed-meta status=error' };
  if (typeof meta.sourceVersion !== 'string' || meta.sourceVersion.trim() === '') {
    return { ok: false, reason: 'sourceVersion missing' };
  }
  if (meta.sourceVersion.includes('api.worldmonitor.app')) {
    return { ok: false, reason: 'sourceVersion points at api.worldmonitor.app' };
  }
  if (!Number.isFinite(meta.fetchedAt)) return { ok: false, reason: 'fetchedAt missing' };
  const ageMs = now - meta.fetchedAt;
  if (ageMs < -120_000) return { ok: false, reason: 'fetchedAt is in the future' };
  if (ageMs > maxAgeMs) return { ok: false, reason: `stale fetchedAt ageMs=${ageMs}` };
  if (!Number.isFinite(meta.recordCount) || meta.recordCount < minRecords) {
    return { ok: false, reason: `recordCount ${meta.recordCount} below ${minRecords}` };
  }
  return {
    ok: true,
    ageMs,
    fetchedAt: meta.fetchedAt,
    recordCount: meta.recordCount,
    sourceVersion: meta.sourceVersion,
  };
}

function freshIso(value, maxAgeMs, now, label) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return `${label} is not a timestamp`;
  const ageMs = now - ms;
  if (ageMs < -120_000) return `${label} is in the future`;
  if (ageMs > maxAgeMs) return `${label} is stale`;
  return null;
}

export function classifyFearGreed(body, meta, now) {
  const reasons = [];
  const hosted = rejectHostedFallback(body);
  if (hosted) reasons.push(hosted);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    reasons.push('body is not an object');
    return { ok: false, reasons, summary: null };
  }
  if (body.unavailable !== false) reasons.push('unavailable is not false');
  if (!Number.isFinite(body.compositeScore)) reasons.push('compositeScore missing');
  if (!FEAR_GREED_LABELS.has(body.compositeLabel)) reasons.push('compositeLabel missing or unknown');
  const seeded = freshIso(body.seededAt, FEAR_GREED_MAX_AGE_MS, now, 'seededAt');
  if (seeded) reasons.push(seeded);
  const degraded = [];
  for (const [key, value] of Object.entries(body)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && value.degraded === true) {
      degraded.push(key);
    }
  }
  if (degraded.length > 0) reasons.push(`degraded categories: ${degraded.join(',')}`);
  if (!(typeof body.vix === 'number' && body.vix > 0)) {
    reasons.push('vix is not a positive number (absent Yahoo/FRED header is coerced to 0)');
  }
  if (!Array.isArray(body.sectorPerformance) || body.sectorPerformance.length === 0) {
    reasons.push('sectorPerformance is empty');
  }
  const source = assertSeedMeta(meta, { maxAgeMs: FEAR_GREED_MAX_AGE_MS, minRecords: 1, now });
  if (!source.ok) reasons.push(source.reason);
  const summary = {
    compositeScore: body.compositeScore,
    compositeLabel: body.compositeLabel,
    unavailable: body.unavailable,
    seededAt: body.seededAt,
    vix: body.vix,
    degradedCategories: degraded,
    sectorCount: Array.isArray(body.sectorPerformance) ? body.sectorPerformance.length : 0,
    source: source.ok ? {
      sourceVersion: source.sourceVersion,
      fetchedAt: source.fetchedAt,
      ageMs: source.ageMs,
      recordCount: source.recordCount,
    } : null,
  };
  return { ok: reasons.length === 0, reasons, summary };
}

export function classifyCrypto(body, meta, now) {
  const reasons = [];
  const hosted = rejectHostedFallback(body);
  if (hosted) reasons.push(hosted);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    reasons.push('body is not an object');
    return { ok: false, reasons, summary: null };
  }
  if (body.provider === 'degraded') reasons.push('provider=degraded');
  else if (!CRYPTO_PROVIDERS.has(body.provider)) reasons.push(`provider ${body.provider} is not seed|upstream|mixed`);
  const quotes = Array.isArray(body.quotes) ? body.quotes : null;
  if (!quotes || quotes.length === 0) reasons.push('no quotes');
  else if (!quotes.every((q) => q && typeof q.symbol === 'string' && q.symbol && Number.isFinite(q.price) && q.price > 0)) {
    reasons.push('a quote lacks a symbol or a positive price');
  }
  if (!Array.isArray(body.unresolvedIds) || body.unresolvedIds.length > 0) {
    reasons.push('unresolvedIds is not an empty list');
  }
  const source = assertSeedMeta(meta, {
    maxAgeMs: CRYPTO_MAX_AGE_MS,
    minRecords: quotes?.length || 1,
    now,
  });
  if (!source.ok) reasons.push(source.reason);
  else if (quotes && source.recordCount !== quotes.length) {
    reasons.push(`seed recordCount ${source.recordCount} != quote count ${quotes.length}`);
  }
  const sample = quotes?.[0] ? { symbol: quotes[0].symbol, price: quotes[0].price, change: quotes[0].change } : null;
  return {
    ok: reasons.length === 0,
    reasons,
    summary: {
      provider: body.provider,
      quoteCount: quotes?.length ?? 0,
      sample,
      source: source.ok ? {
        sourceVersion: source.sourceVersion,
        fetchedAt: source.fetchedAt,
        ageMs: source.ageMs,
        recordCount: source.recordCount,
      } : null,
    },
  };
}

export function classifySignals(body, meta, now) {
  const reasons = [];
  const hosted = rejectHostedFallback(body);
  if (hosted) reasons.push(hosted);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    reasons.push('body is not an object');
    return { ok: false, reasons, summary: null };
  }
  const signals = Array.isArray(body.signals) ? body.signals : null;
  if (!signals || signals.length === 0) reasons.push('no signals');
  else {
    const bad = signals.find((s) => (
      !s
      || typeof s.id !== 'string'
      || typeof s.summary !== 'string'
      || s.summary.trim() === ''
      || typeof s.type !== 'string'
      || !s.type.startsWith('CROSS_SOURCE_SIGNAL_TYPE_')
      || s.type.endsWith('_UNSPECIFIED')
      || typeof s.severity !== 'string'
      || s.severity.endsWith('_UNSPECIFIED')
      || !Number.isFinite(s.detectedAt)
    ));
    if (bad) reasons.push('a signal is missing id, type, summary, severity, or detectedAt');
  }
  if (!Number.isFinite(body.evaluatedAt)) reasons.push('evaluatedAt missing');
  else {
    const ageMs = now - body.evaluatedAt;
    if (ageMs < -120_000) reasons.push('evaluatedAt is in the future');
    else if (ageMs > SIGNALS_MAX_AGE_MS) reasons.push(`evaluatedAt is stale ageMs=${ageMs}`);
  }
  if (!Number.isFinite(body.compositeCount) || body.compositeCount < 0) {
    reasons.push('compositeCount missing');
  }
  const source = assertSeedMeta(meta, {
    maxAgeMs: SIGNALS_MAX_AGE_MS,
    minRecords: signals?.length || 1,
    now,
  });
  if (!source.ok) reasons.push(source.reason);
  else if (signals && source.recordCount !== signals.length) {
    reasons.push(`seed recordCount ${source.recordCount} != signal count ${signals.length}`);
  }
  const first = signals?.[0];
  return {
    ok: reasons.length === 0,
    reasons,
    summary: {
      signalCount: signals?.length ?? 0,
      evaluatedAt: body.evaluatedAt,
      compositeCount: body.compositeCount,
      sample: first ? {
        id: first.id,
        type: first.type,
        theater: first.theater,
        severity: first.severity,
        summary: String(first.summary || '').slice(0, 180),
      } : null,
      source: source.ok ? {
        sourceVersion: source.sourceVersion,
        fetchedAt: source.fetchedAt,
        ageMs: source.ageMs,
        recordCount: source.recordCount,
      } : null,
    },
  };
}
