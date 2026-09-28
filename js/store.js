// In-memory copy of everything in IndexedDB, plus every mutation the UI can make.
// The data is small (a few habits × a few hundred days), so it's all loaded at boot and
// views read it synchronously. Each mutation updates memory first, then persists.

import * as db from './db.js';
import { todayKey, isValidKey } from './dates.js';

export const COLORS = ['green', 'blue', 'violet', 'pink', 'orange', 'amber', 'teal', 'slate'];
export const ICONS = ['🏃', '📖', '🧘', '💧', '💪', '🥗', '✍️', '🎸', '🛌', '🌱', '💊', '🧹', '📵', '☀️', '🧠', '🚴'];

const DEFAULT_SETTINGS = {
  weekStart: 1,
  theme: 'system',
  seeded: false,
  firstUsedOn: null,
  lastBackupOn: null,
  backupSnoozedUntil: null,
  installTipDismissed: false,
  schemaVersion: 1,
};

export const store = {
  habits: [],
  checks: new Set(),   // 'habitId|YYYY-MM-DD'
  settings: { ...DEFAULT_SETTINGS },
};

const ck = (id, k) => id + '|' + k;
const split = c => { const i = c.indexOf('|'); return { habitId: c.slice(0, i), date: c.slice(i + 1) }; };
export const has = (id, k) => store.checks.has(ck(id, k));
export const active = () => store.habits.filter(h => !h.archivedOn);
export const archived = () => store.habits.filter(h => h.archivedOn);
export const byId = id => store.habits.find(h => h.id === id);
const newId = () => 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const sortHabits = () => store.habits.sort((a, b) => a.order - b.order);

// Other open tabs re-read storage when this one changes something.
const listeners = new Set();
export const onExternalChange = fn => listeners.add(fn);
const channel = 'BroadcastChannel' in self ? new BroadcastChannel('tick') : null;
if (channel) channel.onmessage = async () => { await load(); listeners.forEach(fn => fn()); };
const changed = () => channel?.postMessage('changed');

async function load() {
  const { habits, checks, settings } = await db.loadAll();
  store.habits = habits;
  sortHabits();
  store.checks = new Set(checks.map(c => ck(c.habitId, c.date)));
  store.settings = { ...DEFAULT_SETTINGS, ...settings };
  delete store.settings.id;
}

export async function init() {
  await load();
  if (store.settings.seeded) return;
  const t = todayKey();
  if (!store.habits.length) {
    store.habits = [
      { id: newId(), name: 'Walk / Jog / Run', icon: '🏃', color: 'green', schedule: { type: 'daily', days: [] }, order: 0, createdOn: t, archivedOn: null },
      { id: newId(), name: 'Read a book', icon: '📖', color: 'blue', schedule: { type: 'daily', days: [] }, order: 1, createdOn: t, archivedOn: null },
    ];
    await db.saveHabits(store.habits);
  }
  store.settings.seeded = true;
  store.settings.firstUsedOn ||= t;
  await db.saveSettings(store.settings);
}

// ---------- checks ----------
export async function setCheck(habitId, k, done) {
  if (done) store.checks.add(ck(habitId, k)); else store.checks.delete(ck(habitId, k));
  await db.setCheck(habitId, k, done);
  changed();
}

// ---------- habits ----------
export async function addHabit({ name, icon, color, schedule }) {
  const order = store.habits.reduce((m, h) => Math.max(m, h.order), -1) + 1;
  const h = { id: newId(), name, icon, color, schedule, order, createdOn: todayKey(), archivedOn: null };
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
  const removed = [...store.checks].filter(c => c.startsWith(h.id + '|'));
  store.habits = store.habits.filter(x => x !== h);
  removed.forEach(c => store.checks.delete(c));
  await db.deleteHabit(h.id);
  changed();
  return async () => {
    store.habits.push(h);
    sortHabits();
    removed.forEach(c => store.checks.add(c));
    await db.putAll([h], removed.map(split));
    changed();
  };
}

export async function moveHabit(h, dir) {
  const list = active();
  const i = list.indexOf(h), j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return;
  const other = list[j];
  [h.order, other.order] = [other.order, h.order];
  if (h.order === other.order) h.order += dir;
  sortHabits();
  await db.saveHabits([h, other]);
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
    version: 1,
    exportedOn: todayKey(),
    habits: store.habits,
    checks: [...store.checks].map(split),
    settings: { weekStart: store.settings.weekStart, theme: store.settings.theme },
  };
}

function cleanHabit(h) {
  if (!h || typeof h.id !== 'string' || !/^[\w-]{1,40}$/.test(h.id)) return null;
  if (typeof h.name !== 'string' || !h.name.trim()) return null;
  if (!isValidKey(h.createdOn)) return null;
  const type = h.schedule?.type === 'days' ? 'days' : 'daily';
  const days = type === 'days' && Array.isArray(h.schedule.days)
    ? [...new Set(h.schedule.days.filter(d => Number.isInteger(d) && d >= 0 && d <= 6))] : [];
  if (type === 'days' && !days.length) return null;
  return {
    id: h.id,
    name: h.name.trim().slice(0, 60),
    icon: typeof h.icon === 'string' && h.icon.length <= 8 ? h.icon : '✓',
    color: COLORS.includes(h.color) ? h.color : 'slate',
    schedule: { type, days },
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
    if (store.checks.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  }).map(c => ({ habitId: c.habitId, date: c.date }));
  return { habits, checks };
}

export async function applyImport({ habits, checks }) {
  store.habits.push(...habits);
  sortHabits();
  checks.forEach(c => store.checks.add(ck(c.habitId, c.date)));
  await db.putAll(habits, checks);
  changed();
}

// Returns an undo function.
export async function eraseAll() {
  const snapshot = { habits: store.habits, checks: [...store.checks].map(split), settings: { ...store.settings } };
  await db.eraseAll();
  store.habits = [];
  store.checks = new Set();
  store.settings = { ...DEFAULT_SETTINGS, seeded: true, firstUsedOn: todayKey(), theme: snapshot.settings.theme, weekStart: snapshot.settings.weekStart };
  await db.saveSettings(store.settings);
  changed();
  return async () => {
    store.habits = snapshot.habits;
    snapshot.checks.forEach(c => store.checks.add(ck(c.habitId, c.date)));
    store.settings = snapshot.settings;
    await db.putAll(snapshot.habits, snapshot.checks);
    await db.saveSettings(snapshot.settings);
    changed();
  };
}
