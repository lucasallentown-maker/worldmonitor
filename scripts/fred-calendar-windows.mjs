// Date-aware FRED windows. Dates come only from observations that were supplied.
// A missing anniversary is a gap, not a nearby month. A step window is an
// observation count, not a calendar month.

function parseRow(row) {
  if (!row || typeof row.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.date)) return null;
  const value = typeof row.value === 'number' ? row.value : Number(row.value);
  if (!Number.isFinite(value)) return null;
  const ms = Date.parse(`${row.date}T00:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  return { date: row.date, ms, value };
}

export function anniversaryDate(isoDate, yearsBack) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate || '');
  if (!match) return null;
  const year = Number(match[1]) - yearsBack;
  const month = Number(match[2]);
  const day = Number(match[3]);
  const stamp = new Date(Date.UTC(year, month - 1, day));
  if (stamp.getUTCFullYear() !== year || stamp.getUTCMonth() !== month - 1 || stamp.getUTCDate() !== day) {
    return null;
  }
  return stamp.toISOString().slice(0, 10);
}

export function orderedObservations(rows, asOfMs = Number.POSITIVE_INFINITY) {
  const parsed = [];
  const seen = new Set();
  for (const row of rows || []) {
    const item = parseRow(row);
    if (!item || item.ms > asOfMs) continue;
    if (seen.has(item.date)) return { ok: false, reason: 'duplicate-date', observations: [] };
    seen.add(item.date);
    parsed.push(item);
  }
  parsed.sort((a, b) => a.ms - b.ms);
  return { ok: true, observations: parsed };
}

export function calendarYearChange(rows, { years = 1, asOfMs } = {}) {
  const ordered = orderedObservations(rows, asOfMs);
  if (!ordered.ok) return ordered;
  if (ordered.observations.length === 0) return { ok: false, reason: 'insufficient-history', window: 'calendar-year' };
  const latest = ordered.observations.at(-1);
  const targetDate = anniversaryDate(latest.date, years);
  if (!targetDate) return { ok: false, reason: 'anniversary-not-a-real-date', window: 'calendar-year', latest };
  const prior = ordered.observations.find((row) => row.date === targetDate) || null;
  if (!prior) {
    return { ok: false, reason: 'missing-anniversary', window: 'calendar-year', latest, targetDate };
  }
  if (prior.value === 0) return { ok: false, reason: 'zero-base', window: 'calendar-year', latest, prior };
  return {
    ok: true,
    window: 'calendar-year',
    latest,
    prior,
    targetDate,
    pct: ((latest.value - prior.value) / prior.value) * 100,
  };
}

export function stepChange(rows, stepsBack, { asOfMs } = {}) {
  if (!Number.isInteger(stepsBack) || stepsBack < 1) {
    return { ok: false, reason: 'step-count-invalid', window: 'observation-step' };
  }
  const ordered = orderedObservations(rows, asOfMs);
  if (!ordered.ok) return { ...ordered, window: 'observation-step' };
  if (ordered.observations.length <= stepsBack) {
    return { ok: false, reason: 'insufficient-history', window: 'observation-step', stepsBack, count: ordered.observations.length };
  }
  const latest = ordered.observations.at(-1);
  const prior = ordered.observations[ordered.observations.length - 1 - stepsBack];
  if (prior.value === 0) return { ok: false, reason: 'zero-base', window: 'observation-step', stepsBack, latest, prior };
  return {
    ok: true,
    window: 'observation-step',
    stepsBack,
    latest,
    prior,
    pct: ((latest.value - prior.value) / prior.value) * 100,
  };
}
