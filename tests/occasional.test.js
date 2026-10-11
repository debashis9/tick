import { test } from 'node:test';
import assert from 'node:assert/strict';
import { key, parse, addMonths } from '../js/dates.js';
import { occasional, addInterval, isDue, dayState, dayProgress, bridge } from '../js/stats.js';

const habit = (n, unit, extra = {}) => ({ id: 'h1', createdOn: '2026-01-10', schedule: { type: 'every', n, unit, days: [], ...extra } });
const hasIn = dates => (id, k) => dates.includes(k);

test('addMonths keeps the day, and the 31st lands on the end of a shorter month', () => {
  assert.equal(key(addMonths(parse('2026-01-15'), 1)), '2026-02-15');
  assert.equal(key(addMonths(parse('2026-01-31'), 1)), '2026-02-28');
  assert.equal(key(addMonths(parse('2024-01-31'), 1)), '2024-02-29');
  assert.equal(key(addMonths(parse('2026-11-30'), 3)), '2027-02-28');
  assert.equal(key(addMonths(parse('2026-12-05'), 1)), '2027-01-05');
});

test('addInterval: weeks, months, years', () => {
  assert.equal(key(addInterval(parse('2026-10-11'), 2, 'week')), '2026-10-25');
  assert.equal(key(addInterval(parse('2026-10-11'), 3, 'month')), '2027-01-11');
  assert.equal(key(addInterval(parse('2024-02-29'), 1, 'year')), '2025-02-28');
});

test('never done: due on the first due date, or the day it was added', () => {
  assert.deepEqual(occasional(habit(1, 'month'), [], '2026-01-10'), { done: false, due: '2026-01-10', late: 0, now: true, last: null });
  const later = occasional(habit(1, 'year', { start: '2026-03-01' }), [], '2026-01-20');
  assert.equal(later.due, '2026-03-01');
  assert.equal(later.now, false);
});

test('overdue counts the days and stays on the list until ticked', () => {
  const o = occasional(habit(1, 'month'), [], '2026-01-13');
  assert.equal(o.late, 3);
  assert.equal(o.now, true);
});

test('done: the next one is counted from the day it was done, not the day it was due', () => {
  const h = habit(1, 'month');
  const onDay = occasional(h, ['2026-01-20'], '2026-01-20');
  assert.deepEqual(onDay, { done: true, due: '2026-02-20', late: 0, now: true, last: '2026-01-20' });
  const after = occasional(h, ['2026-01-20'], '2026-01-21');
  assert.equal(after.now, false);
  assert.equal(after.due, '2026-02-20');
  assert.equal(occasional(h, ['2026-01-20'], '2026-02-20').now, true);
  assert.equal(occasional(h, ['2026-01-20'], '2026-02-22').late, 2);
});

test('a past day ignores ticks made after it', () => {
  const o = occasional(habit(3, 'month'), ['2026-01-12', '2026-04-20'], '2026-04-15');
  assert.equal(o.last, '2026-01-12');
  assert.equal(o.due, '2026-04-12');
  assert.equal(o.late, 3);
});

test('occasional habits stay out of daily progress and are never missed', () => {
  const h = habit(1, 'month'), has = hasIn(['2026-01-12']);
  assert.equal(isDue(h, parse('2026-01-11'), has, '2026-01-20'), false);
  assert.equal(dayState(h, parse('2026-01-11'), has, '2026-01-20'), 'off');
  assert.equal(dayState(h, parse('2026-01-12'), has, '2026-01-20'), 'done');
  assert.equal(dayState(h, parse('2026-01-20'), has, '2026-01-20'), 'off');
  assert.equal(bridge(h, parse('2026-01-11'), has, '2026-01-20'), null);
  const daily = { id: 'd', createdOn: '2026-01-01', schedule: { type: 'daily', days: [] } };
  assert.deepEqual(dayProgress([daily, h], '2026-01-12', has, '2026-01-20'), { done: 1, total: 1 });
});
