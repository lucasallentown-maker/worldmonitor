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

// Mirrors scripts/seed-cross-source-signals.mjs SOURCE_KEYS. A missing or
// undated key blocks sufficiency. Credential names are hints for the operator;
// this module never reads or creates those secrets.
export const CROSS_SOURCE_MAX_AGE_MIN = Object.freeze({
  'thermal:escalation:v1': 360,
  'intelligence:gpsjam:v2': 30,
  'military:surges:stale:v1': 30,
  'unrest:events:v1': 120,
  'relay:oref:history:v1': 30,
  'market:stocks-bootstrap:v1': 30,
  'market:commodities-bootstrap:v1': 30,
  'cyber:threats-bootstrap:v2': 240,
  'supply_chain:shipping:v2': 1140,
  'sanctions:pressure:v1': 720,
  'seismology:earthquakes:v1': 30,
  'radiation:observations:v1': 30,
  'infra:outages:v1': 30,
  'wildfire:fires:v1': 360,
  'displacement:border-uk:v1': 2880,
  'displacement:idmc-idu:v1': 2880,
  'forecast:predictions:v2': 90,
  'gdelt:intel:tone:military': 30,
  'gdelt:intel:tone:nuclear': 30,
  'gdelt:intel:tone:maritime': 30,
  'weather:alerts:v1': 45,
  'risk:scores:sebuf:stale:v14': 30,
  'regulatory:actions:v1': 30,
  'market:physical-divergence:v1': 2160,
});

export const CROSS_SOURCE_CREDENTIALS = Object.freeze({
  'infra:outages:v1': 'CLOUDFLARE_API_TOKEN',
  'wildfire:fires:v1': 'NASA_FIRMS_API_KEY or FIRMS_API_KEY',
  'military:surges:stale:v1': 'OPENSKY_CLIENT_ID and OPENSKY_CLIENT_SECRET',
  'unrest:events:v1': 'ACLED_EMAIL and ACLED_PASSWORD, or ACLED_ACCESS_TOKEN',
  'forecast:predictions:v2': 'OPENROUTER_API_KEY or a configured LLM key',
});

const FRED_REQUIREMENTS = [
  ['liquidity', 'm2Yoy', 'FRED:M2SL'],
  ['liquidity', 'fedBsMom', 'FRED:WALCL'],
  ['liquidity', 'sofr', 'FRED:SOFR'],
  ['credit', 'hySpread', 'FRED:BAMLH0A0HYM2'],
  ['credit', 'igSpread', 'FRED:BAMLC0A0CM'],
  ['macro', 'fedRate', 'FRED:FEDFUNDS'],
  ['macro', 't10y2y', 'FRED:T10Y2Y'],
  ['macro', 'unrate', 'FRED:UNRATE'],
];

export function requiredCrossSourceKeys(now = Date.now()) {
  const year = new Date(now).getUTCFullYear();
  return [
    'thermal:escalation:v1',
    'intelligence:gpsjam:v2',
    'military:surges:stale:v1',
    'unrest:events:v1',
    'relay:oref:history:v1',
    'market:stocks-bootstrap:v1',
    'market:commodities-bootstrap:v1',
    'cyber:threats-bootstrap:v2',
    'supply_chain:shipping:v2',
    'sanctions:pressure:v1',
    'seismology:earthquakes:v1',
    'radiation:observations:v1',
    'infra:outages:v1',
    'wildfire:fires:v1',
    `displacement:summary:v1:${year}`,
    'displacement:border-uk:v1',
    'displacement:idmc-idu:v1',
    'forecast:predictions:v2',
    'gdelt:intel:tone:military',
    'gdelt:intel:tone:nuclear',
    'gdelt:intel:tone:maritime',
    'weather:alerts:v1',
    'risk:scores:sebuf:stale:v14',
    'regulatory:actions:v1',
    'market:physical-divergence:v1',
  ];
}

function verdict(httpReasons, blocked, summary) {
  const httpGreen = httpReasons.length === 0;
  const sufficient = httpGreen && blocked.length === 0;
  return {
    httpGreen,
    sufficient,
    ok: sufficient,
    blocked,
    reasons: [...httpReasons, ...blocked],
    summary: summary ? { ...summary, httpGreen, sufficient, blocked } : null,
  };
}

function categoryInputs(body, name) {
  const category = body?.[name];
  if (!category || typeof category !== 'object') return null;
  if (category.inputs && typeof category.inputs === 'object') return category.inputs;
  if (typeof category.inputsJson === 'string') {
    try {
      const parsed = JSON.parse(category.inputsJson);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function missingFredInputs(body) {
  const missing = [];
  for (const [category, field, code] of FRED_REQUIREMENTS) {
    const inputs = categoryInputs(body, category);
    const value = inputs?.[field];
    if (!Number.isFinite(value)) missing.push(code);
  }
  return missing;
}

function valueFetchedAt(value) {
  if (!value || typeof value !== 'object') return null;
  if (Number.isFinite(value._seed?.fetchedAt)) return value._seed.fetchedAt;
  if (Number.isFinite(value.fetchedAt)) return value.fetchedAt;
  if (Number.isFinite(value.evaluatedAt)) return value.evaluatedAt;
  if (typeof value.timestamp === 'string') {
    const ms = Date.parse(value.timestamp);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

export function assessCrossSourceCoverage(presentByKey, now) {
  const keys = requiredCrossSourceKeys(now).map((key) => {
    const maxAgeMs = (CROSS_SOURCE_MAX_AGE_MIN[key] ?? 30) * 60 * 1000;
    const value = presentByKey?.[key];
    const credential = CROSS_SOURCE_CREDENTIALS[key] || null;
    if (value == null) {
      return { key, status: 'missing', ageMs: null, maxAgeMs, credential };
    }
    const fetchedAt = valueFetchedAt(value);
    if (!Number.isFinite(fetchedAt)) {
      return { key, status: 'undated', ageMs: null, maxAgeMs, credential };
    }
    const ageMs = now - fetchedAt;
    if (ageMs < -120_000 || ageMs > maxAgeMs) {
      return { key, status: 'stale', ageMs, maxAgeMs, credential };
    }
    return { key, status: 'fresh', ageMs, maxAgeMs, credential: null };
  });
  const fresh = keys.filter((row) => row.status === 'fresh').length;
  return {
    checked: true,
    required: keys.length,
    fresh,
    sparse: fresh < keys.length,
    keys,
  };
}

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
    return verdict(reasons, ['body is not an object'], null);
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
  const fredMissing = missingFredInputs(body);
  const blocked = fredMissing.map((code) => `neutral FRED fallback, missing ${code}`);
  const summary = {
    compositeScore: body.compositeScore,
    compositeLabel: body.compositeLabel,
    unavailable: body.unavailable,
    seededAt: body.seededAt,
    vix: body.vix,
    degradedCategories: degraded,
    sectorCount: Array.isArray(body.sectorPerformance) ? body.sectorPerformance.length : 0,
    fredMissing,
    upstream: {
      yahoo: typeof body.vix === 'number' && body.vix > 0 ? 'present' : 'missing',
      breadth: degraded.includes('breadth') ? 'degraded' : 'present',
      sentiment: degraded.includes('sentiment') ? 'degraded' : 'present',
      fred: fredMissing.length === 0 ? 'present' : 'blocked',
    },
    source: source.ok ? {
      sourceVersion: source.sourceVersion,
      fetchedAt: source.fetchedAt,
      ageMs: source.ageMs,
      recordCount: source.recordCount,
    } : null,
  };
  return verdict(reasons, blocked, summary);
}

export function classifyCrypto(body, meta, now) {
  const reasons = [];
  const hosted = rejectHostedFallback(body);
  if (hosted) reasons.push(hosted);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    reasons.push('body is not an object');
    return verdict(reasons, ['body is not an object'], null);
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
  return verdict(reasons, [], {
    provider: body.provider,
    quoteCount: quotes?.length ?? 0,
    sample,
    upstream: { coinpaprika: body.provider === 'seed' ? 'present' : body.provider || 'missing' },
    source: source.ok ? {
      sourceVersion: source.sourceVersion,
      fetchedAt: source.fetchedAt,
      ageMs: source.ageMs,
      recordCount: source.recordCount,
    } : null,
  });
}

export function classifySignals(body, meta, now, coverage = null) {
  const reasons = [];
  const hosted = rejectHostedFallback(body);
  if (hosted) reasons.push(hosted);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    reasons.push('body is not an object');
    return verdict(reasons, ['body is not an object'], null);
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
  const blocked = [];
  if (!coverage || coverage.checked !== true) {
    blocked.push('cross-source coverage was not checked');
  } else {
    const required = coverage.required ?? coverage.keys?.length ?? 0;
    const fresh = coverage.fresh ?? 0;
    if (fresh < required) {
      const bad = (coverage.keys || []).filter((row) => row.status !== 'fresh');
      const shown = bad.slice(0, 8).map((row) => `${row.key}:${row.status}${row.credential ? ` needs ${row.credential}` : ''}`);
      blocked.push(`sparse cross-source inputs ${fresh}/${required}${shown.length ? ` (${shown.join(', ')})` : ''}`);
    }
  }
  const first = signals?.[0];
  return verdict(reasons, blocked, {
    signalCount: signals?.length ?? 0,
    evaluatedAt: body.evaluatedAt,
    compositeCount: body.compositeCount,
    coverage: coverage && coverage.checked ? {
      required: coverage.required,
      fresh: coverage.fresh,
      sparse: coverage.sparse,
    } : null,
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
  });
}
