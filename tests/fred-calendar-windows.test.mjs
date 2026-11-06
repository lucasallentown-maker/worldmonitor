import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { calendarYearChange, stepChange } from '../scripts/fred-calendar-windows.mjs';

const AS_OF = Date.parse('2026-11-06T00:00:00Z');

test('monthly M2 uses the real anniversary, not 52 rows', () => {
  const rows = [
    { date: '2026-09-01', value: 121 },
    { date: '2026-08-01', value: 120 },
    { date: '2025-09-01', value: 110 },
    { date: '2024-09-01', value: 100 },
  ];
  const change = calendarYearChange(rows, { asOfMs: AS_OF });
  assert.equal(change.ok, true);
  assert.equal(change.window, 'calendar-year');
  assert.equal(change.prior.date, '2025-09-01');
  assert.equal(change.latest.date, '2026-09-01');
  assert.equal(change.pct, 10);
  const reversed = calendarYearChange([...rows].reverse(), { asOfMs: AS_OF });
  assert.equal(reversed.prior.date, '2025-09-01');
  assert.equal(reversed.pct, 10);
});

test('a missing anniversary month is not replaced', () => {
  const change = calendarYearChange([
    { date: '2025-08-01', value: 100 },
    { date: '2025-10-01', value: 105 },
    { date: '2026-09-01', value: 121 },
  ], { asOfMs: AS_OF });
  assert.equal(change.ok, false);
  assert.equal(change.reason, 'missing-anniversary');
  assert.equal(change.targetDate, '2025-09-01');
});

test('short history and observations after the as-of date do not leak', () => {
  const short = calendarYearChange([
    { date: '2026-04-01', value: 10 },
    { date: '2026-09-01', value: 12 },
  ], { asOfMs: AS_OF });
  assert.equal(short.reason, 'missing-anniversary');
  const leaked = calendarYearChange([
    { date: '2025-12-01', value: 10 },
    { date: '2026-12-01', value: 99 },
  ], { asOfMs: AS_OF });
  assert.equal(leaked.latest.date, '2025-12-01');
  assert.equal(leaked.reason, 'missing-anniversary');
});

test('WALCL remains a four-observation step with the real dates', () => {
  const rows = [
    { date: '2026-10-07', value: 100 },
    { date: '2026-10-14', value: 101 },
    { date: '2026-10-21', value: 102 },
    { date: '2026-10-28', value: 103 },
    { date: '2026-11-04', value: 104 },
  ];
  const change = stepChange(rows, 4, { asOfMs: AS_OF });
  assert.equal(change.ok, true);
  assert.equal(change.window, 'observation-step');
  assert.equal(change.stepsBack, 4);
  assert.equal(change.prior.date, '2026-10-07');
  assert.equal(change.latest.date, '2026-11-04');
  assert.equal(change.pct, 4);
  const uneven = stepChange([
    { date: '2026-01-01', value: 10 },
    { date: '2026-01-20', value: 11 },
    { date: '2026-03-01', value: 12 },
    { date: '2026-06-01', value: 13 },
    { date: '2026-11-04', value: 14 },
  ], 4, { asOfMs: AS_OF });
  assert.equal(uneven.prior.date, '2026-01-01');
  assert.equal(uneven.window, 'observation-step');
});

test('the imported M2 history anniversary is 2025-09-01, not 2022-05-01', () => {
  const doc = JSON.parse(readFileSync(new URL('../scripts/local-backend/fred-history-export.json', import.meta.url), 'utf8'));
  const series = doc.series.find((row) => row.series === 'M2SL');
  const change = calendarYearChange(series.observations, { asOfMs: Date.parse('2026-11-06T12:00:00Z') });
  assert.equal(change.latest.date, '2026-09-01');
  assert.equal(change.latest.value, 23413.9);
  assert.equal(change.prior.date, '2025-09-01');
  assert.equal(change.prior.value, 22149.2);
  assert.ok(Math.abs(change.pct - ((23413.9 - 22149.2) / 22149.2) * 100) < 1e-9);
  const walcl = doc.series.find((row) => row.series === 'WALCL');
  const step = stepChange(walcl.observations, 4, { asOfMs: Date.parse('2026-11-06T12:00:00Z') });
  assert.equal(step.prior.date, '2026-10-07');
  assert.equal(step.prior.value, 6747560);
  assert.equal(step.latest.date, '2026-11-04');
  assert.equal(step.latest.value, 6748145);
});
