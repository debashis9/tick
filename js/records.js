// Everything about the records that sync, with no IndexedDB and no DOM, so the same code runs
// in the app (store.js) and in the tests (two simulated devices).
//
// Three kinds sync. On the device they are rows in the habits, checks and settings stores; on
// the wire each is one record with an id, a kind and updatedAt:
//   habit  id 'h…'                  the habit, without its reminder time (that stays per device)
//   check  id 'c:<habitId>:<date>'  { at, amount?, pick? }   pick is the row's `kind` (Walk / Jog / Run)
//   prefs  id 's:prefs'             { weekStart }
// A deleted habit or check stays as a tombstone: { deleted: true, updatedAt } and its key. A habit
// combined into another on linking also says which one: mergedInto.
//
// Functions that change a state return what they wrote, for db.js to save in one transaction:
//   { habits: [rows], checks: [rows], prefs: row or null, marks: [{ id, updatedAt }], clear: [ids] }
// marks are records to upload; clear are records that no longer need uploading.

export const PREFS_ID = 's:prefs';
// The same format is written by sw.js (markDone), which can't import this file.
export const checkId = (habitId, date) => `c:${habitId}:${date}`;
export const ck = (habitId, date) => habitId + '|' + date;

const HABIT_ID = /^[\w-]{1,40}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Habit ids can't contain ':', so a check id splits back into its habit and date.
export function parseId(id) {
  if (typeof id !== 'string') return null;
  if (id === PREFS_ID) return { kind: 'prefs' };
  if (id.startsWith('c:')) {
    const i = id.lastIndexOf(':'), habitId = id.slice(2, i), date = id.slice(i + 1);
    return HABIT_ID.test(habitId) && DATE.test(date) ? { kind: 'check', habitId, date } : null;
  }
  return HABIT_ID.test(id) ? { kind: 'habit', id } : null;
}

export const newState = () => ({
  habits: new Map(),   // id → row or tombstone
  checks: new Map(),   // 'habitId|date' → row or tombstone
  prefs: null,         // { weekStart, updatedAt }, or null while nobody has chosen
  dirty: new Map(),    // record id → updatedAt, not yet uploaded
});

const blank = () => ({ habits: [], checks: [], prefs: null, marks: [], clear: [] });

// Habits sort the same way on every device, even when two devices gave out the same order number.
export const byOrder = (a, b) => a.order - b.order || (a.createdOn < b.createdOn ? -1 : a.createdOn > b.createdOn ? 1 : a.id < b.id ? -1 : 1);

// A stamp for a row that never had one: the start of its day plus the time of day right now.
// It is old on purpose, so any real edit made later, on any device, wins. The time of day keeps
// two devices that carry the same row from giving it the same stamp.
export function oldStamp(day, now) {
  const start = DATE.test(day || '') ? new Date(day + 'T00:00:00').getTime() : 0;
  return Math.max(1, Math.min((start || 0) + now % 864e5, now));
}

// ---------- loading ----------
// Builds a state from the rows in storage. A row without updatedAt (written by an older service
// worker during an update) is stamped and marked for upload; `repair` is what to save, or null.
export function load({ habits = [], checks = [], prefs = null, dirty = [] }, now = Date.now()) {
  const state = newState(), repair = blank();
  for (const h of habits) {
    const row = h.updatedAt ? h : { ...h, updatedAt: oldStamp(h.createdOn, now) };
    state.habits.set(row.id, row);
    if (row !== h) { repair.habits.push(row); repair.marks.push({ id: row.id, updatedAt: row.updatedAt }); }
  }
  for (const c of checks) {
    const row = c.updatedAt ? c : { ...c, updatedAt: Math.min(c.at || oldStamp(c.date, now), now) };
    state.checks.set(ck(row.habitId, row.date), row);
    if (row !== c) { repair.checks.push(row); repair.marks.push({ id: checkId(row.habitId, row.date), updatedAt: row.updatedAt }); }
  }
  if (prefs?.updatedAt) state.prefs = { weekStart: prefs.weekStart, updatedAt: prefs.updatedAt };
  for (const d of dirty) state.dirty.set(d.id, d.updatedAt);
  for (const m of repair.marks) state.dirty.set(m.id, m.updatedAt);
  return { state, repair: repair.marks.length ? repair : null };
}

// ---------- changes made on this device ----------
function keep(state, w, kind, row, dirty = true) {
  let id;
  if (kind === 'habit') { id = row.id; state.habits.set(id, row); w.habits.push(row); }
  else if (kind === 'check') { id = checkId(row.habitId, row.date); state.checks.set(ck(row.habitId, row.date), row); w.checks.push(row); }
  else { id = PREFS_ID; state.prefs = row; w.prefs = row; }
  if (dirty) { state.dirty.set(id, row.updatedAt); w.marks.push({ id, updatedAt: row.updatedAt }); }
  else { state.dirty.delete(id); w.clear.push(id); }
}

// Stamps rows as edits made here (always moving forward), stores them and marks them for upload.
// A deleted habit is { id, deleted: true }; an unticked day is { habitId, date, deleted: true }.
export function edit(state, { habits = [], checks = [], prefs = null }, now = Date.now()) {
  const w = blank();
  const stamp = old => Math.max(now, (old?.updatedAt || 0) + 1);
  for (const h of habits) keep(state, w, 'habit', { ...h, updatedAt: stamp(state.habits.get(h.id)) });
  for (const c of checks) keep(state, w, 'check', { ...c, updatedAt: stamp(state.checks.get(ck(c.habitId, c.date))) });
  if (prefs) keep(state, w, 'prefs', { weekStart: prefs.weekStart, updatedAt: stamp(state.prefs) });
  return w;
}

// A change that stays on this device (a habit's reminder time): stored, not stamped, not uploaded.
export function setReminder(state, id, reminder) {
  const w = blank(), h = state.habits.get(id);
  if (!h || h.deleted) return w;
  const row = { ...h, reminder: reminder || null };
  state.habits.set(id, row);
  w.habits.push(row);
  return w;
}

// Rows from a backup file. A row that was never here keeps the file's stamp, so a newer copy
// still in the cloud wins when it arrives. A row deleted here comes back as a new edit.
export function adopt(state, { habits = [], checks = [] }, now = Date.now()) {
  const w = blank();
  const stamp = (old, row, day) => old ? Math.max(now, old.updatedAt + 1) : Math.min(row.updatedAt || oldStamp(day, now), now);
  for (const h of habits) keep(state, w, 'habit', { ...h, updatedAt: stamp(state.habits.get(h.id), h, h.createdOn) });
  for (const c of checks) keep(state, w, 'check', { ...c, updatedAt: stamp(state.checks.get(ck(c.habitId, c.date)), c, c.date) });
  return w;
}

// ---------- the wire form ----------
export function toRecord(kind, row) {
  if (kind === 'prefs') return { id: PREFS_ID, kind, updatedAt: row.updatedAt, weekStart: row.weekStart };
  if (kind === 'check') {
    const rec = { id: checkId(row.habitId, row.date), kind, updatedAt: row.updatedAt };
    if (row.deleted) return { ...rec, deleted: true };
    if (row.at) rec.at = row.at;
    if (row.amount != null) rec.amount = row.amount;
    if (row.kind) rec.pick = row.kind;
    return rec;
  }
  if (row.deleted) return { id: row.id, kind, updatedAt: row.updatedAt, deleted: true, ...(row.mergedInto && { mergedInto: row.mergedInto }) };
  const { reminder, ...synced } = row;
  return { ...synced, kind };
}

// The row for a record from another device, or null if it isn't one this version understands.
export function fromRecord(rec) {
  const p = parseId(rec?.id);
  if (!p || p.kind !== rec.kind || !(rec.updatedAt > 0)) return null;
  const updatedAt = rec.updatedAt;
  if (p.kind === 'prefs') return rec.weekStart === 0 || rec.weekStart === 1 ? { weekStart: rec.weekStart, updatedAt } : null;
  if (p.kind === 'check') {
    const row = { habitId: p.habitId, date: p.date, updatedAt };
    if (rec.deleted) return { ...row, deleted: true };
    if (rec.at) row.at = rec.at;
    if (rec.amount != null) row.amount = rec.amount;
    if (rec.pick) row.kind = rec.pick;
    return row;
  }
  if (rec.deleted) return { id: rec.id, deleted: true, updatedAt, ...(parseId(rec.mergedInto)?.kind === 'habit' && { mergedInto: rec.mergedInto }) };
  if (typeof rec.name !== 'string' || !rec.schedule || !DATE.test(rec.createdOn || '')) return null;
  const { kind, reminder, ...row } = rec;
  return { ...row, kinds: row.kinds || [], goal: row.goal || null, order: Number.isFinite(row.order) ? row.order : 0, archivedOn: row.archivedOn || null };
}

// What sync uploads for an id: the record, tombstones included, or undefined.
export function record(state, id) {
  const p = parseId(id);
  if (!p) return undefined;
  const row = p.kind === 'prefs' ? state.prefs : p.kind === 'check' ? state.checks.get(ck(p.habitId, p.date)) : state.habits.get(id);
  return row ? toRecord(p.kind, row) : undefined;
}

// ---------- sync ----------
// Stores records that came from the server (sync has already checked they are newer). A habit
// keeps the reminder time set on this device.
export function applyRemote(state, records) {
  const w = blank(), moved = [];
  for (const rec of records) {
    const row = fromRecord(rec);
    if (!row) continue;
    if (rec.kind === 'habit') {
      const old = state.habits.get(rec.id), reminder = old && !old.deleted ? old.reminder || null : null;
      if (!row.deleted) row.reminder = reminder;
      else if (row.mergedInto && reminder) moved.push([row.mergedInto, reminder]);
    }
    keep(state, w, rec.kind, row, false);
  }
  // A reminder set here on a habit that was combined into another moves to that one.
  for (const [id, reminder] of moved) {
    const t = survivor(state, id);
    if (t && !t.reminder) w.habits.push(...setReminder(state, t.id, reminder).habits);
  }
  return w;
}

export const dirtyList = state => [...state.dirty].map(([id, updatedAt]) => ({ id, updatedAt }));

// Forgets uploads that went through, unless the record changed again meanwhile.
export function clearDirty(state, list) {
  for (const d of list) if (state.dirty.get(d.id) === d.updatedAt) state.dirty.delete(d.id);
}

// Everything goes up again (when backup is turned on or linked). Returns the marks to save.
export function markAll(state) {
  for (const h of state.habits.values()) state.dirty.set(h.id, h.updatedAt);
  for (const c of state.checks.values()) state.dirty.set(checkId(c.habitId, c.date), c.updatedAt);
  if (state.prefs) state.dirty.set(PREFS_ID, state.prefs.updatedAt);
  return dirtyList(state);
}

// ---------- combining same-named habits when a device is linked ----------
const nameKey = h => h.name.trim().toLowerCase();
// The older habit survives, so every device picks the same one whichever copy it had first.
const older = (a, b) => (a.createdOn < b.createdOn || (a.createdOn === b.createdOn && a.id < b.id) ? a : b);

// The live habit a merged habit points to, following a chain (A into B, B into C).
function survivor(state, id) {
  let h = state.habits.get(id);
  for (let i = 0; h?.deleted && h.mergedInto && i < 8; i++) h = state.habits.get(h.mergedInto);
  return h && !h.deleted ? h : null;
}

// Moves live checks from `from` to the habit `to`, for every day `to` has no tick.
function moveChecks(state, from, to, filled, out) {
  for (const c of state.checks.values()) {
    if (c.deleted || c.habitId !== from) continue;
    const there = state.checks.get(ck(to, c.date));
    if ((!there || there.deleted) && !filled.has(ck(to, c.date))) {
      const { updatedAt, ...fields } = c;
      out.push({ ...fields, habitId: to });
      filled.add(ck(to, c.date));
    }
    out.push({ habitId: from, date: c.date, deleted: true });
  }
}

// Runs after a pull and before the push. `own` is the list of habits that were on this device
// before it was linked (only while linking, otherwise null): each is combined with a same-named
// habit from the backup. Then ticks on any habit that was merged away, here or on another
// device, follow it to the survivor. Returns what was written, or null.
export function settle(state, own, now = Date.now()) {
  const w = blank(), mine = new Set(own || []);
  const add = x => { w.habits.push(...x.habits); w.checks.push(...x.checks); w.marks.push(...x.marks); };
  for (const id of mine) {
    const x = state.habits.get(id);
    if (!x || x.deleted || x.archivedOn) continue;
    const twins = [...state.habits.values()].filter(h => !h.deleted && !h.archivedOn && !mine.has(h.id) && nameKey(h) === nameKey(x));
    if (!twins.length) continue;
    const y = twins.reduce(older), win = older(x, y), lose = win === x ? y : x;
    const checks = [];
    moveChecks(state, lose.id, win.id, new Set(), checks);
    add(edit(state, { habits: [{ id: lose.id, deleted: true, mergedInto: win.id }], checks }, now));
    if (lose.reminder && !win.reminder) w.habits.push(...setReminder(state, win.id, lose.reminder).habits);
  }
  const checks = [], filled = new Set();
  for (const h of state.habits.values()) {
    if (!h.deleted || !h.mergedInto) continue;
    const to = survivor(state, h.id);
    if (to) moveChecks(state, h.id, to.id, filled, checks);
  }
  if (checks.length) add(edit(state, { checks }, now));
  return w.habits.length || w.checks.length ? w : null;
}

// ---------- upgrade from database version 1 ----------
// Version 1 had habits, checks and a settings store with rows 'app' and 'pushTest', and no
// updatedAt anywhere. Returns the rows to put (nothing is removed from habits or checks), the
// rows for the new local store, and the synced prefs row if the week start was ever changed.
export function upgradeV1({ habits = [], checks = [], settings = [] }, now = Date.now()) {
  const app = settings.find(r => r.id === 'app'), test = settings.find(r => r.id === 'pushTest');
  const out = {
    habits: habits.filter(h => !h.updatedAt).map(h => ({ ...h, updatedAt: oldStamp(h.createdOn, now) })),
    checks: checks.filter(c => !c.updatedAt).map(c => ({ ...c, updatedAt: Math.min(c.at || oldStamp(c.date, now), now) })),
    prefs: null,
    local: [],
  };
  if (app) {
    const { id, weekStart, ...rest } = app;
    out.local.push({ key: 'settings', value: rest });
    // Monday is the default. A default nobody chose must not override a real choice elsewhere.
    if (weekStart === 0) out.prefs = { id: 'prefs', weekStart: 0, updatedAt: oldStamp(app.firstUsedOn, now) };
  }
  if (test) out.local.push({ key: 'pushTest', value: { at: test.at } });
  return out;
}
