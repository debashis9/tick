import { test } from 'node:test';
import assert from 'node:assert/strict';
import { key, parse, addDays, weekIdx, startOfWeek, orderedDays, isValidKey, todayKey } from '../js/dates.js';

test('key and parse round-trip local dates', () => {
  assert.equal(key(new Date(2026, 0, 5)), '2026-01-05');
  assert.equal(key(parse('2026-12-31')), '2026-12-31');
});

test('addDays steps by calendar day across month, year and leap day', () => {
  assert.equal(key(addDays(parse('2026-01-31'), 1)), '2026-02-01');
  assert.equal(key(addDays(parse('2026-12-31'), 1)), '2027-01-01');
  assert.equal(key(addDays(parse('2028-02-28'), 1)), '2028-02-29');
  assert.equal(key(addDays(parse('2026-03-01'), -1)), '2026-02-28');
});

test('addDays is not shifted by DST changes', () => {
  // Walk a full year one day at a time; every step must land on the next date.
  let d = parse('2026-01-01');
  for (let i = 0; i < 365; i++) {
    const next = addDays(d, 1);
    assert.equal(next.getHours(), 0);
    assert.notEqual(key(next), key(d));
    d = next;
  }
  assert.equal(key(d), '2027-01-01');
});

test('todayKey uses local midnight, not UTC', () => {
  assert.equal(todayKey(new Date(2026, 8, 28, 23, 59)), '2026-09-28');
  assert.equal(todayKey(new Date(2026, 8, 29, 0, 1)), '2026-09-29');
});

test('week helpers respect the week start', () => {
  const mon = parse('2026-09-28'); // a Monday
  assert.equal(weekIdx(mon, 1), 0);
  assert.equal(weekIdx(mon, 0), 1);
  assert.equal(key(startOfWeek(parse('2026-10-04'), 1)), '2026-09-28'); // Sunday → previous Monday
  assert.equal(key(startOfWeek(parse('2026-10-04'), 0)), '2026-10-04'); // Sunday starts its own week
  assert.deepEqual(orderedDays(1), [1, 2, 3, 4, 5, 6, 0]);
  assert.deepEqual(orderedDays(0), [0, 1, 2, 3, 4, 5, 6]);
});

test('isValidKey rejects malformed and impossible dates', () => {
  assert.ok(isValidKey('2026-02-28'));
  assert.ok(!isValidKey('2026-02-30'));
  assert.ok(!isValidKey('2026-2-3'));
  assert.ok(!isValidKey(null));
});
