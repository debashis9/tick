// In-memory copy of everything in IndexedDB, plus every mutation the UI can make.
// The data is small (a few habits × a few hundred days), so it's all loaded at boot and
// views read it synchronously. Each mutation updates memory first, then persists.

import * as db from './db.js';
import { todayKey, isValidKey } from './dates.js';

export const COLORS = ['green', 'blue', 'violet', 'pink', 'orange', 'amber', 'teal', 'slate'];
export const ICONS = ['🏃', '📖', '🧘', '💧', '💪', '🥗', '✍️', '🎸', '🛌', '🌱', '💊', '🧹', '📵', '☀️', '🧠', '🚴'];
export const MAX_KINDS = 6;

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
};

// A habit: { id, name, icon, color, schedule, kinds, goal, reminder, order, createdOn, archivedOn }
//   schedule: { type: 'daily' } | { type: 'days', days: [0–6] } | { type: 'weekly', times: 1–6 }
//   kinds:    [] or e.g. ['Walk', 'Jog', 'Run']: optional, picked after ticking
//   goal:     null or { amount: 20, unit: 'pages' }: the day is done once the amount is reached
//   reminder: null or 'HH:MM'
export const store = {
  habits: [],
  entries: new Map(),   // 'habitId|YYYY-MM-DD' → { kind?, amount?, at? }
  settings: { ...DEFAULT_SETTINGS },
};

const ck = (id, k) => id + '|' + k;
const split = c => { const i = c.indexOf('|'); return { habitId: c.slice(0, i), date: c.slice(i + 1) }; };
export const byId = id => store.habits.find(h => h.id === id);
export const entry = (id, k) => store.entries.get(ck(id, k));
export const isDoneEntry = (h, e) => !!e && (!h?.goal || e.amount == null || e.amount >= h.goal.amount);
// Done on that day. A quantity habit counts once its goal is reached.
export const has = (id, k) => {
  const e = store.entries.get(ck(id, k));
  return !!e && isDoneEntry(byId(id), e);
};
export const hasEntries = id => { for (const c of store.entries.keys()) if (c.startsWith(id + '|')) return true; return false; };
export const tickCount = () => { let n = 0; for (const c of store.entries.keys()) { const { habitId, date } = split(c); if (has(habitId, date)) n++; } return n; };
export const active = () => store.habits.filter(h => !h.archivedOn);
export const archived = () => store.habits.filter(h => h.archivedOn);
const newId = () => 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const sortHabits = () => store.habits.sort((a, b) => a.order - b.order);
const normalize = h => Object.assign(h, { kinds: h.kinds || [], goal: h.goal || null, reminder: h.reminder || null });
const rows = () => [...store.entries].map(([c, e]) => ({ ...split(c), ...e }));

// Other open tabs re-read storage when this one changes something.
const listeners = new Set(), localListeners = new Set();
export const onExternalChange = fn => listeners.add(fn);
export const onLocalChange = fn => localListeners.add(fn);
const channel = 'BroadcastChannel' in self ? new BroadcastChannel('tick') : null;
if (channel) channel.onmessage = async () => { await load(); listeners.forEach(fn => fn()); };
const changed = () => { channel?.postMessage('changed'); localListeners.forEach(fn => fn()); };

async function load() {
  const { habits, checks, settings } = await db.loadAll();
  store.habits = habits.map(normalize);
  sortHabits();
  store.entries = new Map(checks.map(({ habitId, date, ...e }) => [ck(habitId, date), e]));
  store.settings = { ...DEFAULT_SETTINGS, ...settings };
  delete store.settings.id;
}

export async function init() {
  await load();
  if (store.settings.seeded) return migrate();
  const t = todayKey();
  if (!store.habits.length) {
    store.habits = [
      { id: newId(), name: 'Walk / Jog / Run', icon: '🏃', color: 'green', schedule: { type: 'daily', days: [] }, kinds: ['Walk', 'Jog', 'Run'], goal: null, reminder: null, order: 0, createdOn: t, archivedOn: null },
      { id: newId(), name: 'Read a book', icon: '📖', color: 'blue', schedule: { type: 'daily', days: [] }, kinds: [], goal: null, reminder: null, order: 1, createdOn: t, archivedOn: null },
    ];
    await db.saveHabits(store.habits);
  }
  store.settings.seeded = true;
  store.settings.firstUsedOn ||= t;
  await db.saveSettings(store.settings);
}

// Version 2 added kinds: the default "Walk / Jog / Run" habit gets Walk, Jog and Run.
async function migrate() {
  if ((store.settings.schemaVersion || 1) >= 2) return;
  const walk = store.habits.filter(h => h.name === 'Walk / Jog / Run' && !h.kinds.length);
  walk.forEach(h => { h.kinds = ['Walk', 'Jog', 'Run']; });
  if (walk.length) await db.saveHabits(walk);
  store.settings.schemaVersion = 2;
  await db.saveSettings(store.settings);
}

// ---------- checks ----------
// Sets or clears (null) one day's entry for a habit.
export async function setEntry(habitId, k, e) {
  if (e) store.entries.set(ck(habitId, k), e); else store.entries.delete(ck(habitId, k));
  await db.putCheck(habitId, k, e);
  changed();
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
  store.habits.push(h);
  await db.saveHabits([h]);
  changed();
  return h;
}

export async function updateHabit(h, fields) {
  Object.assign(h, fields);
  await db.saveHabits([h]);
  changed();
}

export async function setArchived(h, isArchived) {
  h.archivedOn = isArchived ? todayKey() : null;
  await db.saveHabits([h]);
  changed();
}

// Returns an undo function that puts the habit and its history back.
export async function deleteHabit(h) {
  const removed = rows().filter(r => r.habitId === h.id);
  store.habits = store.habits.filter(x => x !== h);
  removed.forEach(r => store.entries.delete(ck(r.habitId, r.date)));
  await db.deleteHabit(h.id);
  changed();
  return async () => {
    store.habits.push(h);
    sortHabits();
    removed.forEach(({ habitId, date, ...e }) => store.entries.set(ck(habitId, date), e));
    await db.putAll([h], removed);
    changed();
  };
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
  const moved = list.filter((h, i) => h.order !== i);
  list.forEach((h, i) => { h.order = i; });
  sortHabits();
  if (!moved.length) return;
  await db.saveHabits(moved);
  changed();
}

// ---------- settings ----------
export async function saveSettings(patch) {
  Object.assign(store.settings, patch);
  await db.saveSettings(store.settings);
  changed();
}

// ---------- backup ----------
export function exportData() {
  return {
    app: 'tick',
    version: 2,
    exportedOn: todayKey(),
    habits: store.habits,
    checks: rows().map(({ at, ...r }) => r),
    settings: { weekStart: store.settings.weekStart, theme: store.settings.theme },
  };
}

const cleanText = (s, max) => typeof s === 'string' ? s.trim().slice(0, max) : '';
const cleanAmount = n => Number.isFinite(n) && n >= 0 && n <= 1e6 ? Math.round(n * 100) / 100 : null;

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
  };
}

// Works out what a backup would add. Nothing already here is changed: habits that
// already exist keep their current name and settings, and ticks are merged in.
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
    const r = { habitId: c.habitId, date: c.date };
    const kind = cleanText(c.kind, 20), amount = cleanAmount(c.amount);
    if (kind) r.kind = kind;
    if (amount != null) r.amount = amount;
    return r;
  });
  return { habits, checks };
}

export async function applyImport({ habits, checks }) {
  store.habits.push(...habits);
  sortHabits();
  checks.forEach(({ habitId, date, ...e }) => store.entries.set(ck(habitId, date), e));
  await db.putAll(habits, checks);
  changed();
}

// Returns an undo function.
export async function eraseAll() {
  const snapshot = { habits: store.habits, checks: rows(), settings: { ...store.settings } };
  await db.eraseAll();
  store.habits = [];
  store.entries = new Map();
  store.settings = { ...DEFAULT_SETTINGS, seeded: true, firstUsedOn: todayKey(), theme: snapshot.settings.theme, weekStart: snapshot.settings.weekStart, pushSynced: snapshot.settings.pushSynced };
  await db.saveSettings(store.settings);
  changed();
  return async () => {
    store.habits = snapshot.habits;
    snapshot.checks.forEach(({ habitId, date, ...e }) => store.entries.set(ck(habitId, date), e));
    store.settings = { ...snapshot.settings, pushSynced: store.settings.pushSynced };
    await db.putAll(snapshot.habits, snapshot.checks);
    await db.saveSettings(store.settings);
    changed();
  };
}
