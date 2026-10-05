// In-memory copy of everything in IndexedDB, plus every mutation the UI can make.
// The data is small (a few habits × a few hundred days), so it's all loaded at boot and
// views read it synchronously. Each mutation updates memory first, then persists.
//
// Habits, checks and the week start sync when cloud backup is on. The rules for those records
// (stamping, tombstones, what goes over the wire) are in records.js; this file keeps the views'
// copy of the live ones, saves what records.js wrote, and tells listeners.

import * as db from './db.js';
import * as rec from './records.js';
import { todayKey, isValidKey } from './dates.js';

export const COLORS = ['green', 'blue', 'violet', 'pink', 'orange', 'amber', 'teal', 'slate'];
export const ICONS = ['🏃', '📖', '🧘', '💧', '💪', '🥗', '✍️', '🎸', '🛌', '🌱', '💊', '🧹', '📵', '☀️', '🧠', '🚴'];
export const MAX_KINDS = 6;

// This device's own settings, except weekStart, which syncs (it lives in records.js's prefs
// and is mirrored here so views read one object).
const DEFAULT_SETTINGS = {
  weekStart: 1,
  theme: 'system',
  seeded: false,
  firstUsedOn: null,
  lastBackupOn: null,
  backupSnoozedUntil: null,
  installTipDismissed: false,
  pushSynced: null,
  schemaVersion: 2,
  invite: null,      // lets this device create a cloud backup (see worker/vault.js)
  name: '',          // used to greet you on Today; stays on this device
  nameAsked: false,  // the welcome card was answered or dismissed
  adminKey: null,    // set on the device of whoever runs this copy of Tick (see views/admin.js)
};

// Everything, tombstones included. The views read `store`, which holds only what's live.
let state = rec.newState();

// A habit: { id, name, icon, color, schedule, kinds, goal, reminder, order, createdOn, archivedOn, updatedAt }
//   schedule: { type: 'daily' } | { type: 'days', days: [0–6] } | { type: 'weekly', times: 1–6 }
//   kinds:    [] or e.g. ['Walk', 'Jog', 'Run']: optional, picked after ticking
//   goal:     null or { amount: 20, unit: 'pages' }: the day is done once the amount is reached
//   reminder: null or 'HH:MM'. Stays on this device; the rest of the habit syncs.
export const store = {
  habits: [],           // live habits, in order
  entries: new Map(),   // 'habitId|YYYY-MM-DD' → that day's check { habitId, date, kind?, amount?, at, updatedAt }
  settings: { ...DEFAULT_SETTINGS },
  vault: null,          // cloud backup: { code, vaultId, cursor, lastSyncAt, lastError, … } or null
  get dirty() { return state.dirty; },   // record id → updatedAt, not yet uploaded
};

const ck = rec.ck;
export const byId = id => store.habits.find(h => h.id === id);
export const entry = (id, k) => store.entries.get(ck(id, k));
export const isDoneEntry = (h, e) => !!e && (!h?.goal || e.amount == null || e.amount >= h.goal.amount);
// Done on that day. A quantity habit counts once its goal is reached.
export const has = (id, k) => {
  const e = store.entries.get(ck(id, k));
  return !!e && isDoneEntry(byId(id), e);
};
export const hasEntries = id => { for (const c of store.entries.keys()) if (c.startsWith(id + '|')) return true; return false; };
// A check whose habit was deleted on another device is ignored: not counted and not exported.
const liveChecks = () => [...store.entries.values()].filter(c => byId(c.habitId));
export const tickCount = () => liveChecks().filter(c => has(c.habitId, c.date)).length;
export const active = () => store.habits.filter(h => !h.archivedOn);
export const archived = () => store.habits.filter(h => h.archivedOn);
const newId = () => 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const normalize = h => Object.assign(h, { kinds: h.kinds || [], goal: h.goal || null, reminder: h.reminder || null });
const liveHabits = () => [...state.habits.values()].filter(h => !h.deleted).map(normalize).sort(rec.byOrder);

// ---------- change notifications ----------
// 'edit': this device changed something (reminders and backup follow up). 'remote': records
// arrived from the cloud (the UI re-renders). 'settings': this device's settings only.
// Other open tabs re-read storage whenever this one changes anything.
const listeners = new Set(), localListeners = new Set();
export const onExternalChange = fn => listeners.add(fn);
export const onLocalChange = fn => localListeners.add(fn);
const channel = 'BroadcastChannel' in self ? new BroadcastChannel('tick') : null;
if (channel) channel.onmessage = async () => { await load(); listeners.forEach(fn => fn()); };
function changed(kind = 'edit') {
  channel?.postMessage('changed');
  if (kind === 'edit') localListeners.forEach(fn => fn());
  if (kind === 'remote') listeners.forEach(fn => fn());
}

// Brings the views' copy in line with what records.js just wrote.
function absorb(w) {
  if (w.habits.length) store.habits = liveHabits();
  for (const c of w.checks) {
    if (c.deleted) store.entries.delete(ck(c.habitId, c.date)); else store.entries.set(ck(c.habitId, c.date), c);
  }
  if (w.prefs) store.settings.weekStart = w.prefs.weekStart;
}

// Every write to habits, checks and the week start ends here.
async function commit(w, kind = 'edit') {
  absorb(w);
  await db.save(w);
  changed(kind);
}

const localSettings = () => { const { weekStart, ...own } = store.settings; return own; };

async function load() {
  const data = await db.loadAll();
  const { state: loaded, repair } = rec.load(data);
  state = loaded;
  store.habits = liveHabits();
  store.entries = new Map([...state.checks].filter(([, c]) => !c.deleted));
  store.settings = { ...DEFAULT_SETTINGS, ...data.local.settings, weekStart: state.prefs?.weekStart ?? DEFAULT_SETTINGS.weekStart };
  store.vault = data.local.vault || null;
  if (repair) await db.save(repair);
}

export async function init() {
  await load();
  if (store.settings.seeded) return migrate();
  const t = todayKey();
  if (!state.habits.size) {
    await commit(rec.edit(state, { habits: [
      { id: newId(), name: 'Walk / Jog / Run', icon: '🏃', color: 'green', schedule: { type: 'daily', days: [] }, kinds: ['Walk', 'Jog', 'Run'], goal: null, reminder: null, order: 0, createdOn: t, archivedOn: null },
      { id: newId(), name: 'Read a book', icon: '📖', color: 'blue', schedule: { type: 'daily', days: [] }, kinds: [], goal: null, reminder: null, order: 1, createdOn: t, archivedOn: null },
    ] }));
  }
  store.settings.seeded = true;
  store.settings.firstUsedOn ||= t;
  await db.setLocal('settings', localSettings());
}

// Version 2 added kinds: the default "Walk / Jog / Run" habit gets Walk, Jog and Run.
async function migrate() {
  if ((store.settings.schemaVersion || 1) >= 2) return;
  const walk = store.habits.filter(h => h.name === 'Walk / Jog / Run' && !h.kinds.length);
  if (walk.length) await commit(rec.edit(state, { habits: walk.map(h => ({ ...h, kinds: ['Walk', 'Jog', 'Run'] })) }));
  store.settings.schemaVersion = 2;
  await db.setLocal('settings', localSettings());
}

// ---------- checks ----------
// Sets or clears (null) one day's entry for a habit. Clearing leaves a tombstone, so the
// untick reaches other devices.
export async function setEntry(habitId, k, e) {
  if (!e && !store.entries.has(ck(habitId, k))) return;
  const row = { habitId, date: k };
  if (!e) row.deleted = true;
  else {
    row.at = e.at || Date.now();
    if (e.kind) row.kind = e.kind;
    if (e.amount != null) row.amount = e.amount;
  }
  await commit(rec.edit(state, { checks: [row] }));
}

// Ticks or unticks a day. Ticking a quantity habit logs its full goal; a picked kind is kept.
export function setCheck(h, k, done) {
  if (!done) return setEntry(h.id, k, null);
  const e = {}, old = entry(h.id, k);
  if (old?.kind) e.kind = old.kind;
  if (h.goal) e.amount = Math.max(old?.amount || 0, h.goal.amount);
  return setEntry(h.id, k, e);
}

// ---------- habits ----------
export async function addHabit(fields) {
  const order = store.habits.reduce((m, h) => Math.max(m, h.order), -1) + 1;
  const h = normalize({ id: newId(), ...fields, order, createdOn: todayKey(), archivedOn: null });
  await commit(rec.edit(state, { habits: [h] }));
  return byId(h.id);
}

const synced = h => JSON.stringify({ ...rec.toRecord('habit', h), updatedAt: 0 });

// `h` may be a copy the caller has held for a while; the change is applied to the current one.
export async function updateHabit(h, fields) {
  const cur = byId(h.id);
  if (!cur) return;
  const next = normalize({ ...cur, ...fields });
  // Only the reminder changed. That stays on this device, so the habit isn't stamped or
  // uploaded, and can't overwrite an edit made on another device.
  if (synced(cur) === synced(next)) return commit(rec.setReminder(state, cur.id, next.reminder));
  await commit(rec.edit(state, { habits: [next] }));
}

export const setArchived = (h, isArchived) => updateHabit(h, { archivedOn: isArchived ? todayKey() : null });

// Deleting leaves tombstones for the habit and each of its checks. Returns an undo function
// that puts the habit and its history back (as new edits, so the undo wins on every device).
export async function deleteHabit(h) {
  const cur = byId(h.id);
  if (!cur) return async () => {};
  const removed = [...store.entries.values()].filter(c => c.habitId === cur.id);
  await commit(rec.edit(state, {
    habits: [{ id: cur.id, deleted: true }],
    checks: removed.map(c => ({ habitId: c.habitId, date: c.date, deleted: true })),
  }));
  return () => commit(rec.edit(state, { habits: [cur], checks: removed }));
}

export async function moveHabit(h, dir) {
  const ids = active().map(x => x.id), i = ids.indexOf(h.id), j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  await reorder(ids);
}

// Puts the active habits in the order of `ids`; archived habits go after them.
export async function reorder(ids) {
  const list = [...ids.map(byId).filter(h => h && !h.archivedOn), ...archived()];
  const moved = list.map((h, i) => h.order === i ? null : { ...h, order: i }).filter(Boolean);
  if (moved.length) await commit(rec.edit(state, { habits: moved }));
}

// ---------- settings ----------
// The week start syncs; everything else in settings belongs to this device.
export async function saveSettings(patch) {
  const { weekStart, ...own } = patch;
  if (Object.keys(own).length) {
    Object.assign(store.settings, own);
    await db.setLocal('settings', localSettings());
  }
  if (weekStart != null && weekStart !== store.settings.weekStart) return commit(rec.edit(state, { prefs: { weekStart } }));
  changed('settings');
}

// ---------- cloud backup ----------
export async function setVault(v) {
  store.vault = v ? { ...store.vault, ...v } : null;
  await db.setLocal('vault', store.vault);
  changed('settings');
}

// What sync-core needs from this device.
export const syncAdapter = {
  get: id => rec.record(state, id),
  applyRemote: records => commit(rec.applyRemote(state, records), 'remote'),
  // Sync asks for this after the pull and before the push, which is the moment to combine
  // same-named habits on a device that is being linked, and to move ticks off merged habits.
  async dirty() {
    const w = rec.settle(state, store.vault?.linking ? store.vault.own : null);
    if (w) await commit(w, 'remote');
    return rec.dirtyList(state);
  },
  async clearDirty(list) {
    rec.clearDirty(state, list);
    await db.clearDirty(list);
  },
  get cursor() { return store.vault?.cursor || 0; },
  async setCursor(n) { if (store.vault) { store.vault.cursor = n; await db.setLocal('vault', store.vault); } },
};

// Everything goes up again, e.g. when a backup is first turned on or linked.
export const markAllDirty = () => db.markDirty(rec.markAll(state));

// ---------- backup file ----------
export function exportData() {
  return {
    app: 'tick',
    version: 3,
    exportedOn: todayKey(),
    habits: store.habits,
    checks: liveChecks().map(({ at, ...r }) => r),
    settings: { weekStart: store.settings.weekStart, theme: store.settings.theme, ...(store.settings.name && { name: store.settings.name }) },
  };
}

const cleanText = (s, max) => typeof s === 'string' ? s.trim().slice(0, max) : '';
const cleanAmount = n => Number.isFinite(n) && n >= 0 && n <= 1e6 ? Math.round(n * 100) / 100 : null;
// Files from before version 3 have no updatedAt; records.js gives those rows an old stamp.
const cleanStamp = n => Number.isSafeInteger(n) && n > 0 ? { updatedAt: n } : {};

function cleanSchedule(s) {
  if (s?.type === 'weekly') {
    return Number.isInteger(s.times) && s.times >= 1 && s.times <= 6 ? { type: 'weekly', times: s.times, days: [] } : null;
  }
  if (s?.type === 'days') {
    const days = Array.isArray(s.days) ? [...new Set(s.days.filter(d => Number.isInteger(d) && d >= 0 && d <= 6))] : [];
    return days.length ? { type: 'days', days } : null;
  }
  return { type: 'daily', days: [] };
}

function cleanHabit(h) {
  if (!h || typeof h.id !== 'string' || !/^[\w-]{1,40}$/.test(h.id)) return null;
  if (typeof h.name !== 'string' || !h.name.trim()) return null;
  if (!isValidKey(h.createdOn)) return null;
  const schedule = cleanSchedule(h.schedule);
  if (!schedule) return null;
  const kinds = Array.isArray(h.kinds) ? [...new Set(h.kinds.map(x => cleanText(x, 20)).filter(Boolean))].slice(0, MAX_KINDS) : [];
  const amount = cleanAmount(h.goal?.amount);
  return {
    id: h.id,
    name: h.name.trim().slice(0, 60),
    icon: typeof h.icon === 'string' && h.icon.length <= 8 ? h.icon : '✓',
    color: COLORS.includes(h.color) ? h.color : 'slate',
    schedule,
    kinds,
    goal: amount ? { amount, unit: cleanText(h.goal.unit, 16) } : null,
    reminder: typeof h.reminder === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(h.reminder) ? h.reminder : null,
    order: Number.isFinite(h.order) ? h.order : 0,
    createdOn: h.createdOn,
    archivedOn: isValidKey(h.archivedOn) ? h.archivedOn : null,
    ...cleanStamp(h.updatedAt),
  };
}

// Works out what a backup would add. Nothing already here is changed: habits that
// already exist keep their current name and settings, and ticks are merged in. A habit or
// tick that was deleted here counts as missing, so a restore brings it back.
export function previewImport(data) {
  if (!data || data.app !== 'tick' || !Array.isArray(data.habits) || !Array.isArray(data.checks)) {
    return { error: "This file isn't a Tick backup." };
  }
  const existing = new Set(store.habits.map(h => h.id));
  let nextOrder = store.habits.reduce((m, h) => Math.max(m, h.order), -1) + 1;
  const habits = data.habits.map(cleanHabit).filter(h => h && !existing.has(h.id))
    .sort((a, b) => a.order - b.order).map(h => ({ ...h, order: nextOrder++ }));
  const known = new Set([...existing, ...habits.map(h => h.id)]);
  const seen = new Set();
  const checks = data.checks.filter(c => {
    if (!c || !known.has(c.habitId) || !isValidKey(c.date)) return false;
    const id = ck(c.habitId, c.date);
    if (store.entries.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  }).map(c => {
    const r = { habitId: c.habitId, date: c.date, ...cleanStamp(c.updatedAt) };
    const kind = cleanText(c.kind, 20), amount = cleanAmount(c.amount);
    if (kind) r.kind = kind;
    if (amount != null) r.amount = amount;
    return r;
  });
  return { habits, checks };
}

export const applyImport = ({ habits, checks }) =>
  commit(rec.adopt(state, { habits, checks: checks.map(c => ({ ...c, at: c.updatedAt || Date.now() })) }));

// Erases this device and turns cloud backup off here. The cloud copy is left alone (Settings →
// Cloud backup → Turn off deletes it). Returns an undo function.
export async function eraseAll() {
  const snapshot = { state, settings: { ...store.settings }, vault: store.vault };
  await db.eraseAll(['settings']);
  state = rec.newState();
  state.prefs = snapshot.state.prefs;
  store.habits = [];
  store.entries = new Map();
  store.vault = null;
  // Who you are on this device (name, invite, admin key) isn't data about habits: it stays.
  const { theme, weekStart, pushSynced, invite, name, nameAsked, adminKey } = snapshot.settings;
  store.settings = { ...DEFAULT_SETTINGS, seeded: true, firstUsedOn: todayKey(), theme, weekStart, pushSynced, invite, name, nameAsked, adminKey };
  await db.setLocal('settings', localSettings());
  changed();
  return async () => {
    const prefs = state.prefs;   // the week start may have been changed since
    state = snapshot.state;
    state.prefs = prefs;
    store.habits = liveHabits();
    store.entries = new Map([...state.checks].filter(([, c]) => !c.deleted));
    store.settings = { ...snapshot.settings, pushSynced: store.settings.pushSynced, weekStart: store.settings.weekStart };
    store.vault = snapshot.vault;
    await db.save({ habits: [...state.habits.values()], checks: [...state.checks.values()], prefs: null, marks: rec.dirtyList(state), clear: [] });
    await db.setLocal('settings', localSettings());
    await db.setLocal('vault', store.vault);
    changed();
  };
}
