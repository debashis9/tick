import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, addDays, key } from '../js/dates.js';
import { dayState, habitStats, bridge, dayProgress, rangeRate, STRENGTH_M } from '../js/stats.js';

const daily = (createdOn) => ({ id: 'a', schedule: { type: 'daily', days: [] }, createdOn });
const mwf = (createdOn) => ({ id: 'b', schedule: { type: 'days', days: [1, 3, 5] }, createdOn });
const checker = (...entries) => { const s = new Set(entries); return (id, k) => s.has(id + '|' + k); };

// 2026-09-28 is a Monday.
const T = '2026-09-28';

test('dayState covers every state', () => {
  const h = mwf('2026-09-20');
  const has = checker('b|2026-09-25', 'b|2026-09-22');
  assert.equal(dayState(h, parse('2026-09-19'), has, T), 'before');
  assert.equal(dayState(h, parse('2026-09-21'), has, T), 'missed');   // Monday, not done
  assert.equal(dayState(h, parse('2026-09-22'), has, T), 'done');     // Tuesday, done anyway
  assert.equal(dayState(h, parse('2026-09-24'), has, T), 'off');      // Thursday
  assert.equal(dayState(h, parse('2026-09-25'), has, T), 'done');
  assert.equal(dayState(h, parse(T), has, T), 'pending');
  assert.equal(dayState(h, parse('2026-09-29'), has, T), 'future');
});

test('streak counts due days, ignores unscheduled days and a pending today', () => {
  const h = mwf('2026-09-14');
  // Wed 16, Fri 18, Mon 21, Wed 23, Fri 25 done; Mon 14 missed; today (Mon 28) pending.
  const has = checker(...['16', '18', '21', '23', '25'].map(d => `b|2026-09-${d}`));
  const s = habitStats(h, has, T);
  assert.equal(s.streak, 5);
  assert.equal(s.best, 5);
});

test('a miss resets the streak but keeps best', () => {
  const h = daily('2026-09-20');
  const has = checker('a|2026-09-20', 'a|2026-09-21', 'a|2026-09-22', 'a|2026-09-24', 'a|2026-09-25');
  const s = habitStats(h, has, T);
  assert.equal(s.best, 3);
  assert.equal(s.streak, 0); // 26 and 27 missed
});

test('strength follows exponential smoothing and one miss only dents it', () => {
  const h = daily('2026-09-01');
  const all = [];
  for (let d = parse('2026-09-01'); key(d) < T; d = addDays(d, 1)) all.push('a|' + key(d));
  const full = habitStats(h, checker(...all), T).strength;
  const oneMiss = habitStats(h, checker(...all.filter(c => c !== 'a|2026-09-26')), T).strength;
  // 27 done days from zero: 1 - m^27
  assert.equal(full, Math.round((1 - Math.pow(STRENGTH_M, 27)) * 100));
  assert.ok(oneMiss < full && oneMiss > full - 10, `one miss: ${full} → ${oneMiss}`);
});

test('30-day rate is done ÷ due and ignores pending today', () => {
  const h = daily('2026-09-24');
  const has = checker('a|2026-09-24', 'a|2026-09-25', 'a|2026-09-27'); // 26 missed, 28 pending
  assert.equal(habitStats(h, has, T).rate, 75);
});

test('bridge: thin over unscheduled days, dashed over one miss, none over two', () => {
  const h = mwf('2026-09-01');
  // Mon 21 done, Wed 23 done → Tue 22 is a thin bridge.
  let has = checker('b|2026-09-21', 'b|2026-09-23');
  assert.equal(bridge(h, parse('2026-09-22'), has, T), 'thin');
  // Mon 21 done, Wed 23 missed, Fri 25 done → Wed and the off days around it are dashed.
  has = checker('b|2026-09-21', 'b|2026-09-25');
  assert.equal(bridge(h, parse('2026-09-23'), has, T), 'dash');
  assert.equal(bridge(h, parse('2026-09-22'), has, T), 'dash');
  // Mon 14 done, Wed 16 + Fri 18 missed, Mon 21 done → no bridge.
  has = checker('b|2026-09-14', 'b|2026-09-21');
  assert.equal(bridge(h, parse('2026-09-16'), has, T), null);
  // Gap ending at a pending today is not bridged.
  has = checker('b|2026-09-25');
  assert.equal(bridge(h, parse('2026-09-26'), has, T), null);
});

test('dayProgress counts only habits due that day', () => {
  const hs = [daily('2026-09-01'), mwf('2026-09-01')];
  const has = checker('a|2026-09-22', 'b|2026-09-22');
  assert.deepEqual(dayProgress(hs, '2026-09-22', has), { done: 1, total: 1 }); // Tuesday: only daily is due
  assert.deepEqual(dayProgress(hs, '2026-09-23', has), { done: 0, total: 2 });
});

test('rangeRate for a week', () => {
  const h = daily('2026-09-01');
  const has = checker('a|2026-09-21', 'a|2026-09-22', 'a|2026-09-23');
  assert.deepEqual(rangeRate(h, parse('2026-09-21'), parse('2026-09-27'), has, T), { done: 3, due: 7, pct: 43 });
});
