import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../js/dates.js';
import { dayState, habitStats, dayProgress, rangeRate, weekResults, isDue, STRENGTH_MW } from '../js/stats.js';

const weekly = (createdOn, times = 3) => ({ id: 'w', schedule: { type: 'weekly', times, days: [] }, createdOn });
const checker = (...days) => { const s = new Set(days.map(d => 'w|2026-09-' + d)); return (id, k) => s.has(id + '|' + k); };

// 2026-09-28 is a Monday; weeks start on Monday.
// Weeks: 7–13 met (8, 9, 10) · 14–20 short (15) · 21–27 met (21, 23, 25) · 28– current (28).
const T = '2026-09-28';
const h = weekly('2026-09-07');
const has = checker('08', '09', '10', '15', '21', '23', '25', '28');

test('weekly: undone days are off in a met week, missed in a short week', () => {
  assert.equal(dayState(h, parse('2026-09-11'), has, T, 1), 'off');
  assert.equal(dayState(h, parse('2026-09-16'), has, T, 1), 'missed');
  assert.equal(dayState(h, parse('2026-09-22'), has, T, 1), 'off');
  assert.equal(dayState(h, parse('2026-09-15'), has, T, 1), 'done');
});

test('weekly: the current week is never missed yet; today is pending until the target is met', () => {
  const noToday = checker('08', '09', '10');
  const later = '2026-09-30';
  assert.equal(dayState(h, parse('2026-09-28'), noToday, later, 1), 'off');
  assert.equal(dayState(h, parse(later), noToday, later, 1), 'pending');
  const met = checker('28', '29', '30');
  assert.equal(dayState(h, parse('2026-10-01'), met, '2026-10-01', 1), 'off');
});

test('weekly: a partial first week is only judged if it was met', () => {
  const late = weekly('2026-09-09');
  const r = weekResults(late, checker(), '2026-09-21', 1);
  assert.deepEqual(r.map(w => w.met), [null, false, null]);
  assert.equal(dayState(late, parse('2026-09-11'), checker(), '2026-09-21', 1), 'off');
  assert.equal(dayState(late, parse('2026-09-16'), checker(), '2026-09-21', 1), 'missed');
});

test('weekly: stats count weeks', () => {
  const s = habitStats(h, has, T, 1);
  assert.equal(s.unit, 'week');
  assert.equal(s.streak, 1);
  assert.equal(s.best, 1);
  assert.equal(s.rate, 67); // 2 of 3 judged weeks; the current week isn't judged yet
  const m = STRENGTH_MW;
  assert.equal(s.strength, Math.round((((1 - m) * m) * m + (1 - m)) * 100));
});

test('weekly: week start matters', () => {
  // Weeks starting Sunday: 6–12 has 8, 9, 10 (met); 13–19 has 15 (short).
  assert.equal(dayState(h, parse('2026-09-16'), has, T, 0), 'missed');
  assert.equal(dayState(h, parse('2026-09-12'), has, T, 0), 'off');
});

test('weekly: day progress only counts done, pending or short-week days', () => {
  assert.deepEqual(dayProgress([h], '2026-09-16', has, T, 1), { done: 0, total: 1 });
  assert.deepEqual(dayProgress([h], '2026-09-22', has, T, 1), { done: 0, total: 0 });
  assert.deepEqual(dayProgress([h], '2026-09-23', has, T, 1), { done: 1, total: 1 });
  assert.equal(isDue(h, parse('2026-09-11'), has, T, 1), false);
});

test('weekly: rangeRate is ticks toward the target, capped', () => {
  assert.deepEqual(rangeRate(h, parse('2026-09-14'), parse('2026-09-20'), has, T, 1), { done: 1, due: 3, pct: 33 });
  const extra = checker('21', '22', '23', '24');
  assert.deepEqual(rangeRate(h, parse('2026-09-21'), parse('2026-09-27'), extra, T, 1), { done: 3, due: 3, pct: 100 });
});
