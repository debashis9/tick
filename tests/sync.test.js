// Two simulated devices syncing through the real Worker code (with SQLite standing in for D1).
// A device here is js/records.js (the same code store.js runs) with its rows in memory.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeD1 } from './helpers/d1.js';
import { api, signInvite, validInvite } from '../worker/vault.js';
import { newVaultKey, deriveKeys } from '../js/crypto.js';
import { apiClient, syncOnce, ApiError } from '../js/sync-core.js';
import * as rec from '../js/records.js';

const BASE = 'https://tick.test';

function server(env = {}) {
  const e = { DB: makeD1(), ...env };
  const fetchFn = (url, init) => api(new Request(url, init), e);
  return { env: e, fetchFn };
}

// One clock for every device, so "later" in a test is later in updatedAt.
let clock = Date.now();
const now = () => (clock += 10);

let ids = 0;
function device() {
  const state = rec.newState();
  const d = {
    state, cursor: 0, own: null,
    // ----- what the app does -----
    addHabit(name, extra = {}) {
      const id = extra.id || 'h' + (++ids).toString(36).padStart(4, '0');
      rec.edit(state, { habits: [{ id, name, icon: '📖', color: 'blue', schedule: { type: 'daily', days: [] }, kinds: [], goal: null, reminder: null, order: state.habits.size, createdOn: '2026-09-28', archivedOn: null, ...extra }] }, now());
      return id;
    },
    rename(id, name) { rec.edit(state, { habits: [{ ...state.habits.get(id), name }] }, now()); },
    tick(habitId, date, e = {}) { const t = now(); rec.edit(state, { checks: [{ habitId, date, at: t, ...e }] }, t); },
    untick(habitId, date) { rec.edit(state, { checks: [{ habitId, date, deleted: true }] }, now()); },
    deleteHabit(id) {
      const habit = state.habits.get(id), removed = [...state.checks.values()].filter(c => c.habitId === id && !c.deleted);
      rec.edit(state, { habits: [{ id, deleted: true }], checks: removed.map(c => ({ habitId: id, date: c.date, deleted: true })) }, now());
      return () => rec.edit(state, { habits: [habit], checks: removed }, now());
    },
    // What sw.js's markDone writes straight into IndexedDB from a notification.
    markDoneFromNotification(habitId, date) {
      const old = state.checks.get(rec.ck(habitId, date)), t = now(), updatedAt = Math.max(t, (old?.updatedAt || 0) + 1);
      state.checks.set(rec.ck(habitId, date), { ...(old?.deleted ? null : old), habitId, date, at: t, updatedAt });
      state.dirty.set(`c:${habitId}:${date}`, updatedAt);
    },
    // ----- what the views show -----
    habits: () => [...state.habits.values()].filter(h => !h.deleted).sort(rec.byOrder),
    names: () => d.habits().map(h => h.name),
    ticks: id => [...state.checks.values()].filter(c => !c.deleted && c.habitId === id && !state.habits.get(id)?.deleted).map(c => c.date).sort(),
    check: (id, date) => { const c = state.checks.get(rec.ck(id, date)); return c && !c.deleted ? c : null; },
    // Everything that syncs, as one string to compare devices with (reminders stay per device).
    view: () => JSON.stringify({ habits: d.habits().map(h => Object.entries({ ...h, reminder: null }).sort()), ticks: d.habits().map(h => [h.id, d.ticks(h.id)]), prefs: state.prefs }),
    // ----- what sync-core needs (the same shape as store.js's syncAdapter) -----
    get: id => rec.record(state, id),
    async applyRemote(list) { rec.applyRemote(state, list); },
    async dirty() { rec.settle(state, d.own, now()); return rec.dirtyList(state); },
    async clearDirty(list) { rec.clearDirty(state, list); },
    async setCursor(n) { d.cursor = n; },
    // Linking: remember which habits were here first, and upload everything.
    startLink() { d.own = d.habits().map(h => h.id); rec.markAll(state); },
  };
  return d;
}

// A vault and devices that share its code.
async function vault(n, env) {
  const s = server(env), code = newVaultKey();
  const devices = [];
  for (let i = 0; i < n; i++) {
    const keys = await deriveKeys(new Uint8Array(code)), d = device();
    d.fetch = s.fetchFn;
    d.sync = async () => { const r = await syncOnce(keys, apiClient(BASE, keys, (...a) => d.fetch(...a)), d); d.own = null; return r; };
    d.keys = keys;
    devices.push(d);
  }
  await apiClient(BASE, devices[0].keys, s.fetchFn).create();
  return { ...s, devices };
}
const rows = env => env.DB.raw.prepare('SELECT * FROM records').all();
const settle = async (...ds) => { for (let i = 0; i < 3; i++) for (const d of ds) await d.sync(); };

test('a vault is created once; a second create with the same key is fine, another key is refused', async () => {
  const { fetchFn } = server();
  const keys = await deriveKeys(newVaultKey());
  const a = apiClient(BASE, keys, fetchFn);
  assert.deepEqual(await a.create(), { created: true });
  assert.deepEqual(await a.create(), { created: false });
  const clash = apiClient(BASE, { ...keys, authHash: 'f'.repeat(64) }, fetchFn);
  await assert.rejects(clash.create(), e => e.status === 409);
});

test('without the auth secret, a vault cannot be read, written or deleted', async () => {
  const { fetchFn } = server();
  const keys = await deriveKeys(newVaultKey());
  await apiClient(BASE, keys, fetchFn).create();
  const thief = apiClient(BASE, { ...keys, authSecret: (await deriveKeys(newVaultKey())).authSecret }, fetchFn);
  for (const call of [() => thief.pull(0), () => thief.push([]), () => thief.destroy()]) {
    await assert.rejects(call(), e => e instanceof ApiError && e.status === 401);
  }
});

test('two devices end up with the same habits and ticks, and the server holds only ciphertext', async () => {
  const { env, devices: [phone, laptop] } = await vault(2);
  const walk = phone.addHabit('Walk / Jog / Run', { kinds: ['Walk', 'Jog', 'Run'], color: 'green' });
  const read = phone.addHabit('Read a book', { goal: { amount: 20, unit: 'pages' } });
  phone.tick(walk, '2026-09-29', { kind: 'Jog' });
  phone.tick(read, '2026-09-29', { amount: 22 });
  phone.tick(read, '2026-09-30', { amount: 5 });
  rec.edit(phone.state, { prefs: { weekStart: 0 } }, now());
  assert.deepEqual(await phone.sync(), { pulled: 0, pushed: 6, unreadable: 0 });

  assert.equal((await laptop.sync()).pulled, 6);
  assert.deepEqual(laptop.names(), ['Walk / Jog / Run', 'Read a book']);
  assert.equal(laptop.check(walk, '2026-09-29').kind, 'Jog');
  assert.equal(laptop.check(read, '2026-09-30').amount, 5);
  assert.equal(laptop.state.prefs.weekStart, 0);
  assert.equal(laptop.view(), phone.view());

  // Nothing readable on the server: no names, dates, kinds, units, colors, field names, local
  // ids or the auth secret. Short words are searched for as they'd appear in plaintext JSON
  // ("Jog"), since three random letters turn up inside base64 ciphertext now and then.
  // (The vaults table has a name column of its own, for the Admin tab; records have none.)
  const dump = JSON.stringify(rows(env)) + JSON.stringify(env.DB.raw.prepare('SELECT * FROM vaults').all());
  assert.ok(!JSON.stringify(rows(env)).includes('"name"'));
  for (const plain of ['Walk / Jog / Run', '"Jog"', 'Read a book', '"pages"', '2026-09', '"green"', '"amount"', '"habit"', '"check"', '"prefs"', walk, read, 'c:', phone.keys.authSecret]) {
    assert.ok(!dump.includes(plain), `server dump contains ${plain}`);
  }
  // And every stored value is ciphertext: base64url, padded to 256 bytes plus the 16-byte tag.
  for (const r of rows(env)) {
    assert.match(r.ct, /^[\w-]+$/);
    assert.equal((Buffer.from(r.ct, 'base64url').length - 16) % 256, 0);
  }
  assert.equal(rows(env).length, 6);

  // A tick on the laptop and a new habit on the phone each reach the other device.
  laptop.tick(walk, '2026-09-30', { kind: 'Walk' });
  const gym = phone.addHabit('Gym', { schedule: { type: 'weekly', times: 2, days: [] } });
  await settle(laptop, phone);
  assert.deepEqual(phone.ticks(walk), ['2026-09-29', '2026-09-30']);
  assert.equal(laptop.habits().find(h => h.id === gym).schedule.times, 2);
  assert.equal(laptop.view(), phone.view());
  assert.equal((await phone.dirty()).length + (await laptop.dirty()).length, 0);
});

test('the same day ticked on both devices is one row on the server', async () => {
  const { env, devices: [a, b] } = await vault(2);
  const h = a.addHabit('Meditate');
  await settle(a, b);
  const before = rows(env).length;
  a.tick(h, '2026-10-01');
  b.tick(h, '2026-10-01');
  await settle(a, b);
  assert.equal(rows(env).length, before + 1);
  assert.deepEqual(a.ticks(h), ['2026-10-01']);
  assert.deepEqual(b.ticks(h), ['2026-10-01']);
});

test('an untick travels as a tombstone, and ticking again brings the day back', async () => {
  const { env, devices: [a, b] } = await vault(2);
  const h = a.addHabit('Meditate');
  a.tick(h, '2026-10-01');
  await settle(a, b);
  assert.deepEqual(b.ticks(h), ['2026-10-01']);
  const n = rows(env).length;

  b.untick(h, '2026-10-01');
  await settle(b, a);
  assert.deepEqual(a.ticks(h), []);
  assert.equal(a.state.checks.get(rec.ck(h, '2026-10-01')).deleted, true);
  assert.equal(rows(env).length, n, 'the tombstone replaces the row; nothing is added or removed');

  a.tick(h, '2026-10-01', { kind: 'Morning' });
  await settle(a, b);
  assert.equal(b.check(h, '2026-10-01').kind, 'Morning');
});

test('deleting a habit takes its ticks with it on the other device; undo brings them back', async () => {
  const { devices: [a, b] } = await vault(2);
  const h = a.addHabit('Read a book'), keepMe = a.addHabit('Gym');
  ['2026-09-28', '2026-09-29', '2026-09-30'].forEach(d => a.tick(h, d));
  a.tick(keepMe, '2026-09-30');
  await settle(a, b);
  assert.equal(b.ticks(h).length, 3);

  const undo = b.deleteHabit(h);
  await settle(b, a);
  assert.deepEqual(a.names(), ['Gym']);
  assert.equal([...a.state.checks.values()].filter(c => c.habitId === h && !c.deleted).length, 0, 'every check of the habit is a tombstone');
  assert.deepEqual(a.ticks(keepMe), ['2026-09-30']);

  undo();
  await settle(b, a);
  assert.deepEqual(a.names(), ['Read a book', 'Gym']);
  assert.deepEqual(a.ticks(h), ['2026-09-28', '2026-09-29', '2026-09-30']);
  assert.equal(a.view(), b.view());
});

test('a tick made offline for a habit deleted elsewhere is ignored, not shown and not repaired', async () => {
  const { devices: [a, b] } = await vault(2);
  const h = a.addHabit('Read a book');
  await settle(a, b);
  b.tick(h, '2026-10-01');   // b is offline
  a.deleteHabit(h);
  await settle(a, b);
  assert.deepEqual(a.names(), []);
  assert.deepEqual(b.names(), []);
  assert.deepEqual(a.ticks(h), []);
  assert.deepEqual(b.ticks(h), []);
  assert.equal(a.view(), b.view());
});

test('a tick written by the service worker (Mark done) reaches the other device', async () => {
  const { devices: [phone, laptop] } = await vault(2);
  const h = phone.addHabit('Meditate');
  phone.tick(h, '2026-10-01', { kind: 'Morning' });
  phone.untick(h, '2026-10-02');
  await settle(phone, laptop);
  phone.markDoneFromNotification(h, '2026-10-01');   // already ticked: keeps the kind
  phone.markDoneFromNotification(h, '2026-10-02');   // was unticked: the tombstone is replaced
  phone.markDoneFromNotification(h, '2026-10-03');   // new
  assert.equal((await phone.sync()).pushed, 3);
  await laptop.sync();
  assert.deepEqual(laptop.ticks(h), ['2026-10-01', '2026-10-02', '2026-10-03']);
  assert.equal(laptop.check(h, '2026-10-01').kind, 'Morning');
});

test('reminder times stay on the device that set them', async () => {
  const { env, devices: [a, b] } = await vault(2);
  const h = a.addHabit('Read a book', { reminder: '21:30' });
  await settle(a, b);
  assert.equal(a.state.habits.get(h).reminder, '21:30');
  assert.equal(b.state.habits.get(h).reminder, null);
  // b sets its own; a rename from a doesn't wipe it, and a reminder-only change uploads nothing.
  rec.setReminder(b.state, h, '07:00');
  assert.equal((await b.sync()).pushed, 0);
  a.rename(h, 'Read');
  await settle(a, b);
  assert.equal(b.state.habits.get(h).name, 'Read');
  assert.equal(b.state.habits.get(h).reminder, '07:00');
  assert.equal(a.state.habits.get(h).reminder, '21:30');
  assert.equal(rows(env).length, 1);
});

test('the newer edit wins when both devices change the same record', async () => {
  const { devices: [a, b] } = await vault(2);
  const h = a.addHabit('Read a book', { goal: { amount: 20, unit: 'pages' } });
  await settle(a, b);
  a.tick(h, '2026-10-01', { amount: 10 });   // older
  b.tick(h, '2026-10-01', { amount: 5 });    // newer: the day's total, not added to a's
  a.rename(h, 'Read (older)');
  b.rename(h, 'Read (newer)');
  await b.sync();
  await a.sync();   // a pulls b's newer copies before pushing its own
  await b.sync();
  assert.equal(a.check(h, '2026-10-01').amount, 5);
  assert.equal(b.check(h, '2026-10-01').amount, 5);
  assert.deepEqual(a.names(), ['Read (newer)']);
  assert.deepEqual(b.names(), ['Read (newer)']);
});

test('linking a device combines its same-named habits with the backup\'s; the older habit survives', async () => {
  const { devices: [phone, laptop] } = await vault(2);
  // The phone has months of history and turned backup on.
  const walk = phone.addHabit('Walk / Jog / Run', { createdOn: '2026-06-01', order: 0 });
  const read = phone.addHabit('Read a book', { createdOn: '2026-06-01', order: 1 });
  phone.tick(read, '2026-09-30');
  phone.tick(read, '2026-10-01', { amount: 30 });
  await phone.sync();

  // The laptop is a fresh install: the two seeded habits, one ticked today, and one of its own.
  const walk2 = laptop.addHabit('Walk / Jog / Run', { createdOn: '2026-10-01', order: 0 });
  const read2 = laptop.addHabit(' read a Book ', { createdOn: '2026-10-01', order: 1, reminder: '21:00' });
  const piano = laptop.addHabit('Piano', { createdOn: '2026-10-01', order: 2 });
  laptop.tick(walk2, '2026-10-01', { kind: 'Jog' });
  laptop.tick(read2, '2026-10-01', { amount: 5 });
  laptop.tick(piano, '2026-10-01');
  laptop.startLink();
  await settle(laptop, phone);

  for (const d of [phone, laptop]) {
    assert.deepEqual(d.names(), ['Walk / Jog / Run', 'Read a book', 'Piano'], 'no duplicates');
    assert.deepEqual(d.habits().map(h => h.id), [walk, read, piano], 'the phone\'s older habits survive');
    assert.deepEqual(d.ticks(walk), ['2026-10-01'], 'the laptop\'s tick moved across');
    assert.equal(d.check(walk, '2026-10-01').kind, 'Jog');
    assert.equal(d.check(read, '2026-10-01').amount, 30, 'a day the survivor already has is kept');
    assert.deepEqual(d.ticks(read), ['2026-09-30', '2026-10-01']);
    assert.deepEqual(d.ticks(piano), ['2026-10-01']);
    assert.equal(d.state.habits.get(read2).mergedInto, read);
  }
  assert.equal(laptop.state.habits.get(read).reminder, '21:00', 'the reminder set on the laptop stays there');
  assert.equal(phone.state.habits.get(read).reminder, null);
  assert.equal(phone.view(), laptop.view());
});

test('the older habit survives even when it is the one being linked', async () => {
  const { devices: [laptop, phone] } = await vault(2);
  // Backup was turned on from the fresh laptop; the phone with the history links second.
  const fresh = laptop.addHabit('Read a book', { createdOn: '2026-10-01' });
  laptop.tick(fresh, '2026-10-01');
  await laptop.sync();
  const old = phone.addHabit('Read a book', { createdOn: '2026-06-01' });
  phone.tick(old, '2026-06-02');
  phone.tick(old, '2026-09-30');
  phone.startLink();
  await settle(phone, laptop);
  for (const d of [phone, laptop]) {
    assert.deepEqual(d.habits().map(h => h.id), [old]);
    assert.equal(d.habits()[0].createdOn, '2026-06-01', 'the earliest start date is kept, so no tick falls before it');
    assert.deepEqual(d.ticks(old), ['2026-06-02', '2026-09-30', '2026-10-01']);
  }
});

test('two devices linking at the same moment still agree, and no tick is lost', async () => {
  const { fetchFn, devices: [a, b, c] } = await vault(3);
  const ha = a.addHabit('Read a book', { createdOn: '2026-08-01' });
  a.tick(ha, '2026-08-02');
  await a.sync();
  const hb = b.addHabit('Read a book', { createdOn: '2026-06-01' });   // the oldest
  b.tick(hb, '2026-06-02');
  const hc = c.addHabit('Read a book', { createdOn: '2026-10-01' });   // the newest
  c.tick(hc, '2026-10-01');
  b.startLink(); c.startLink();
  // Both pull before either pushes: b merges a's habit into its own, c merges its own into a's.
  let pulls = 0, open;
  const bothPulled = new Promise(resolve => { open = resolve; });
  const gated = async (url, init) => {
    if (init.method === 'POST') await bothPulled;
    const res = await fetchFn(url, init);
    if (init.method === 'GET' && ++pulls === 2) open();
    return res;
  };
  b.fetch = c.fetch = gated;
  await Promise.all([b.sync(), c.sync()]);
  assert.equal(b.state.habits.get(ha).mergedInto, hb);
  assert.equal(c.state.habits.get(hc).mergedInto, ha);
  b.fetch = c.fetch = fetchFn;
  await settle(a, b, c);
  for (const d of [a, b, c]) {
    assert.deepEqual(d.habits().map(h => h.id), [hb], 'everyone keeps the oldest habit');
    assert.deepEqual(d.ticks(hb), ['2026-06-02', '2026-08-02', '2026-10-01'], 'ticks from all three ended up on it');
  }
  assert.equal(a.view(), b.view());
  assert.equal(b.view(), c.view());
});

test('habits that only one side has are all kept when linking, and archived ones are left alone', async () => {
  const { devices: [a, b] } = await vault(2);
  const archived = a.addHabit('Read a book', { archivedOn: '2026-09-01' });
  a.addHabit('Gym');
  await a.sync();
  const mine = b.addHabit('Read a book', { createdOn: '2026-10-01' });
  b.startLink();
  await settle(b, a);
  assert.deepEqual(a.habits().map(h => h.id).sort(), [archived, a.habits().find(h => h.name === 'Gym').id, mine].sort());
  assert.equal(a.view(), b.view());
});

test('pulls page through a long history', async () => {
  const { devices: [a, b] } = await vault(2);
  const h = a.addHabit('Read a book', { createdOn: '2022-01-01' });
  const day = i => new Date(Date.UTC(2022, 0, 1 + i)).toISOString().slice(0, 10);
  for (let i = 0; i < 1233; i++) a.tick(h, day(i));
  assert.equal((await a.sync()).pushed, 1234);
  assert.equal((await b.sync()).pulled, 1234);
  assert.equal(b.ticks(h).length, 1233);
});

test('deleting the vault removes everything from the server', async () => {
  const { env, fetchFn, devices: [a] } = await vault(1);
  const h = a.addHabit('Read a book');
  a.tick(h, '2026-10-01');
  await a.sync();
  const c = apiClient(BASE, a.keys, fetchFn);
  await c.destroy();
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM records').get().n, 0);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM vaults').get().n, 0);
  await assert.rejects(c.pull(0), e => e.status === 401);
});

test('with INVITE_SECRET set, creating a vault needs a valid, unexpired invite', async () => {
  const secret = 'test-secret-123';
  const { fetchFn } = server({ INVITE_SECRET: secret });
  const keys = await deriveKeys(newVaultKey());
  const c = apiClient(BASE, keys, fetchFn);
  await assert.rejects(c.create(), e => e.status === 403 && e.code === 'invite_required');
  await assert.rejects(c.create(await signInvite('wrong-secret', { exp: Date.now() + 1e6 })), e => e.status === 403);
  await assert.rejects(c.create(await signInvite(secret, { exp: Date.now() - 1 })), e => e.status === 403);
  assert.equal(await validInvite('garbage', secret), false);
  assert.deepEqual(await c.create(await signInvite(secret, { exp: Date.now() + 1e6 })), { created: true });
});

test('the server rejects malformed pushes', async () => {
  const { fetchFn } = server();
  const keys = await deriveKeys(newVaultKey());
  const c = apiClient(BASE, keys, fetchFn);
  await c.create();
  for (const bad of [[{ id: 'short', iv: 'a'.repeat(16), ct: 'x' }], [{ id: 'a'.repeat(22), iv: 'bad', ct: 'x' }], [{ id: 'a'.repeat(22), iv: 'a'.repeat(16), ct: '<script>' }]]) {
    await assert.rejects(c.push(bad), e => e.status === 400);
  }
});
