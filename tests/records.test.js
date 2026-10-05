// The records that sync: ids, the wire form, stamps, tombstones, and the upgrade from the
// version 1 database (the real upgrade, in a browser, is in tests/e2e/smoke.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as rec from '../js/records.js';

const NOW = new Date('2026-10-01T10:30:00').getTime();
const habit = (id, extra = {}) => ({ id, name: 'Read a book', icon: '📖', color: 'blue', schedule: { type: 'daily', days: [] }, kinds: [], goal: null, reminder: null, order: 0, createdOn: '2026-09-28', archivedOn: null, ...extra });

// Today's database: no updatedAt anywhere, settings in one 'app' row.
const V1 = () => ({
  habits: [
    habit('hwalk', { name: 'Walk / Jog / Run', kinds: ['Walk', 'Jog', 'Run'], reminder: '07:30' }),
    habit('hread', { order: 1, goal: { amount: 20, unit: 'pages' }, createdOn: '2026-09-29' }),
  ],
  checks: [
    { habitId: 'hwalk', date: '2026-09-28', at: 1759040000000, kind: 'Jog' },
    { habitId: 'hread', date: '2026-09-29', at: 1759130000000, amount: 22 },
    { habitId: 'hread', date: '2026-09-30', at: 1759220000000, amount: 5 },
  ],
  settings: [
    { id: 'app', weekStart: 0, theme: 'dark', seeded: true, firstUsedOn: '2026-09-28', lastBackupOn: null, backupSnoozedUntil: null, installTipDismissed: true, pushSynced: '{"endpoint":"https://fcm.googleapis.com/x"}', schemaVersion: 2 },
    { id: 'pushTest', at: 1759300000000 },
  ],
});

test('check ids split back into habit and date', () => {
  assert.equal(rec.checkId('hmf3k2a1b2c', '2026-10-01'), 'c:hmf3k2a1b2c:2026-10-01');
  assert.deepEqual(rec.parseId('c:hmf3k2a1b2c:2026-10-01'), { kind: 'check', habitId: 'hmf3k2a1b2c', date: '2026-10-01' });
  assert.deepEqual(rec.parseId('c:my-habit_2:2026-10-01'), { kind: 'check', habitId: 'my-habit_2', date: '2026-10-01' });
  assert.deepEqual(rec.parseId('hmf3k2a1b2c'), { kind: 'habit', id: 'hmf3k2a1b2c' });
  assert.deepEqual(rec.parseId('s:prefs'), { kind: 'prefs' });
  for (const bad of ['c:2026-10-01', 'c::2026-10-01', 'c:h1:yesterday', 'x:y', '', null, 42]) assert.equal(rec.parseId(bad), null, String(bad));
});

test('upgrade from version 1 loses nothing and stamps every row', () => {
  const v1 = V1(), out = rec.upgradeV1(v1, NOW);
  assert.equal(out.habits.length, 2);
  assert.equal(out.checks.length, 3);
  // Every field that was there is still there, unchanged.
  out.habits.forEach((h, i) => { const { updatedAt, ...rest } = h; assert.deepEqual(rest, v1.habits[i]); });
  out.checks.forEach((c, i) => { const { updatedAt, ...rest } = c; assert.deepEqual(rest, v1.checks[i]); });
  // A check is stamped with the moment it was ticked.
  assert.deepEqual(out.checks.map(c => c.updatedAt), v1.checks.map(c => c.at));
  // A habit is stamped inside the day it was created: old, so a real edit made later wins.
  for (const h of out.habits) {
    const start = new Date(h.createdOn + 'T00:00:00').getTime();
    assert.ok(h.updatedAt >= start && h.updatedAt < start + 864e5 && h.updatedAt < NOW, `${h.id} ${h.updatedAt}`);
  }
});

test('upgrade moves device settings to local, and syncs the week start only if it was changed', () => {
  const out = rec.upgradeV1(V1(), NOW);
  const local = Object.fromEntries(out.local.map(r => [r.key, r.value]));
  assert.equal(local.settings.theme, 'dark');
  assert.equal(local.settings.installTipDismissed, true);
  assert.equal(local.settings.pushSynced, '{"endpoint":"https://fcm.googleapis.com/x"}');
  assert.equal(local.settings.schemaVersion, 2);
  assert.ok(!('weekStart' in local.settings) && !('id' in local.settings));
  assert.deepEqual(local.pushTest, { at: 1759300000000 });
  assert.equal(out.prefs.id, 'prefs');
  assert.equal(out.prefs.weekStart, 0);
  assert.ok(out.prefs.updatedAt > 0 && out.prefs.updatedAt < NOW);

  // Monday is the default nobody chose: no record, so it can't override a choice made elsewhere.
  const v1 = V1(); v1.settings[0].weekStart = 1;
  assert.equal(rec.upgradeV1(v1, NOW).prefs, null);
});

test('upgrade leaves rows that already have a stamp alone, and copes with an empty database', () => {
  const v1 = V1();
  v1.checks[0].updatedAt = 1759300000123;   // written by the new service worker before the page upgraded
  const out = rec.upgradeV1(v1, NOW);
  assert.equal(out.checks.length, 2);
  assert.ok(!out.checks.some(c => c.date === '2026-09-28'));
  assert.deepEqual(rec.upgradeV1({}, NOW), { habits: [], checks: [], prefs: null, local: [] });
});

test('two devices that carry the same habit do not stamp it identically', () => {
  const a = rec.upgradeV1(V1(), NOW), b = rec.upgradeV1(V1(), NOW + 3 * 3600e3 + 17);
  assert.notEqual(a.habits[0].updatedAt, b.habits[0].updatedAt);
});

test('loading stamps a row with no updatedAt and marks it for upload', () => {
  const { state, repair } = rec.load({ habits: [habit('h1', { updatedAt: 5 })], checks: [{ habitId: 'h1', date: '2026-10-01', at: 1759300000000 }] }, NOW);
  assert.equal(state.checks.get('h1|2026-10-01').updatedAt, 1759300000000);
  assert.deepEqual(repair.marks, [{ id: 'c:h1:2026-10-01', updatedAt: 1759300000000 }]);
  assert.equal(repair.habits.length, 0);
  assert.equal(rec.load({ habits: [habit('h1', { updatedAt: 5 })] }, NOW).repair, null);
});

test('the wire form leaves out the reminder, and a check\'s kind travels as pick', () => {
  const state = rec.newState();
  rec.edit(state, { habits: [habit('h1', { reminder: '07:30' })], checks: [{ habitId: 'h1', date: '2026-10-01', at: 111, kind: 'Jog', amount: 22 }], prefs: { weekStart: 0 } }, NOW);
  const h = rec.record(state, 'h1');
  assert.equal(h.kind, 'habit');
  assert.equal(h.name, 'Read a book');
  assert.equal(h.updatedAt, NOW);
  assert.ok(!('reminder' in h));
  assert.deepEqual(rec.record(state, 'c:h1:2026-10-01'), { id: 'c:h1:2026-10-01', kind: 'check', updatedAt: NOW, at: 111, amount: 22, pick: 'Jog' });
  assert.deepEqual(rec.record(state, 's:prefs'), { id: 's:prefs', kind: 'prefs', updatedAt: NOW, weekStart: 0 });
  assert.equal(rec.record(state, 'c:h1:2026-10-02'), undefined);

  // Round trip onto another device.
  const other = rec.newState();
  rec.applyRemote(other, ['h1', 'c:h1:2026-10-01', 's:prefs'].map(id => rec.record(state, id)));
  assert.deepEqual(other.checks.get('h1|2026-10-01'), { habitId: 'h1', date: '2026-10-01', updatedAt: NOW, at: 111, amount: 22, kind: 'Jog' });
  assert.equal(other.habits.get('h1').reminder, null);
  assert.equal(other.habits.get('h1').name, 'Read a book');
  assert.deepEqual(other.prefs, { weekStart: 0, updatedAt: NOW });
  assert.equal(other.dirty.size, 0);
});

test('a record from another device keeps the reminder set on this one', () => {
  const state = rec.newState();
  rec.edit(state, { habits: [habit('h1', { reminder: '21:00' })] }, NOW);
  rec.applyRemote(state, [{ ...rec.toRecord('habit', habit('h1', { name: 'Read', updatedAt: NOW + 5 })) }]);
  assert.equal(state.habits.get('h1').name, 'Read');
  assert.equal(state.habits.get('h1').reminder, '21:00');
});

test('changing only the reminder does not stamp or upload the habit', () => {
  const state = rec.newState();
  rec.edit(state, { habits: [habit('h1')] }, NOW);
  rec.clearDirty(state, rec.dirtyList(state));
  const w = rec.setReminder(state, 'h1', '06:45');
  assert.equal(state.habits.get('h1').reminder, '06:45');
  assert.equal(state.habits.get('h1').updatedAt, NOW);
  assert.equal(state.dirty.size, 0);
  assert.equal(w.marks.length, 0);
});

test('edits always move updatedAt forward, even if the clock went back', () => {
  const state = rec.newState();
  rec.edit(state, { checks: [{ habitId: 'h1', date: '2026-10-01', at: 1 }] }, NOW);
  rec.edit(state, { checks: [{ habitId: 'h1', date: '2026-10-01', deleted: true }] }, NOW - 60_000);
  const row = state.checks.get('h1|2026-10-01');
  assert.deepEqual(row, { habitId: 'h1', date: '2026-10-01', deleted: true, updatedAt: NOW + 1 });
  assert.deepEqual(rec.record(state, 'c:h1:2026-10-01'), { id: 'c:h1:2026-10-01', kind: 'check', updatedAt: NOW + 1, deleted: true });
  assert.equal(state.dirty.get('c:h1:2026-10-01'), NOW + 1);
});

test('records this version does not understand are ignored', () => {
  const state = rec.newState();
  const w = rec.applyRemote(state, [
    { id: 'n:note1', kind: 'note', updatedAt: 5 },
    { id: 'h1', kind: 'check', updatedAt: 5 },
    { id: 'c:h1:2026-10-01', kind: 'check' },
    { id: 'h2', kind: 'habit', updatedAt: 5 },
    { id: 's:prefs', kind: 'prefs', updatedAt: 5, weekStart: 3 },
    null,
  ]);
  assert.equal(state.habits.size + state.checks.size, 0);
  assert.equal(state.prefs, null);
  assert.equal(w.habits.length + w.checks.length, 0);
});

test('a restore keeps the file\'s stamp for new rows and brings back deleted ones as new edits', () => {
  const state = rec.newState();
  rec.edit(state, { habits: [habit('h1')], checks: [{ habitId: 'h1', date: '2026-09-29', at: 1 }] }, NOW - 5000);
  rec.edit(state, { checks: [{ habitId: 'h1', date: '2026-09-29', deleted: true }] }, NOW - 4000);
  rec.adopt(state, { habits: [habit('h2', { updatedAt: 777 }), habit('h3')], checks: [
    { habitId: 'h1', date: '2026-09-29', updatedAt: 500 },   // deleted here
    { habitId: 'h1', date: '2026-09-30', updatedAt: 600 },   // never here
    { habitId: 'h1', date: '2026-09-28' },                   // from a file with no stamps
    { habitId: 'h2', date: '2026-09-30', updatedAt: NOW + 9e9 },   // a stamp from the future is capped
  ] }, NOW);
  assert.equal(state.habits.get('h2').updatedAt, 777);
  assert.ok(state.habits.get('h3').updatedAt < NOW);
  assert.equal(state.checks.get('h1|2026-09-29').updatedAt, NOW);
  assert.ok(!state.checks.get('h1|2026-09-29').deleted);
  assert.equal(state.checks.get('h1|2026-09-30').updatedAt, 600);
  assert.ok(state.checks.get('h1|2026-09-28').updatedAt < NOW);
  assert.equal(state.checks.get('h2|2026-09-30').updatedAt, NOW);
  assert.ok(state.dirty.has('h2') && state.dirty.has('c:h1:2026-09-30'));
});

test('habits sort the same way everywhere when two devices gave out the same order number', () => {
  const list = [habit('hb', { order: 1 }), habit('ha', { order: 1 }), habit('hc', { order: 1, createdOn: '2026-09-20' }), habit('hd', { order: 0 })];
  assert.deepEqual(list.sort(rec.byOrder).map(h => h.id), ['hd', 'hc', 'ha', 'hb']);
  assert.deepEqual(list.reverse().sort(rec.byOrder).map(h => h.id), ['hd', 'hc', 'ha', 'hb']);
});
