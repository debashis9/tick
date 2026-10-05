// IndexedDB access. This is the only file that touches storage; everything else goes
// through store.js. (The service worker also reads and writes the database: see sw.js.)
//
//   habits    habit rows and tombstones, by id                          synced, except `reminder`
//   checks    one habit on one day, by [habitId, date], and tombstones  synced
//   settings  one row, 'prefs': { weekStart, updatedAt }                synced
//   dirty     ids changed on this device and not yet in the cloud backup ({ id, updatedAt })
//   local     this device's own settings and backup state ({ key, value }); never synced

import { upgradeV1 } from './records.js';

const DB_NAME = 'tick';
const VERSION = 2;
let dbPromise;

const request = r => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});

// Version 1 → 2, inside the upgrade transaction: it all happens or none of it does.
function upgradeFromV1(t) {
  const hs = t.objectStore('habits'), cs = t.objectStore('checks'), ss = t.objectStore('settings'), ls = t.objectStore('local');
  const rows = {};
  const read = (name, s) => {
    s.getAll().onsuccess = e => {
      rows[name] = e.target.result;
      if (!rows.habits || !rows.checks || !rows.settings) return;
      try {
        const out = upgradeV1(rows);
        out.habits.forEach(h => hs.put(h));
        out.checks.forEach(c => cs.put(c));
        out.local.forEach(r => ls.put(r));
        ss.delete('app');
        ss.delete('pushTest');
        if (out.prefs) ss.put(out.prefs);
      } catch (err) { console.error(err); t.abort(); }
    };
  };
  read('habits', hs); read('checks', cs); read('settings', ss);
}

function open() {
  dbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = e => {
      const db = req.result;
      if (e.oldVersion < 1) {
        db.createObjectStore('habits', { keyPath: 'id' });
        const checks = db.createObjectStore('checks', { keyPath: ['habitId', 'date'] });
        checks.createIndex('habitId', 'habitId');
        db.createObjectStore('settings', { keyPath: 'id' });
      }
      if (e.oldVersion < 2) {
        db.createObjectStore('dirty', { keyPath: 'id' });
        db.createObjectStore('local', { keyPath: 'key' });
        if (e.oldVersion === 1) upgradeFromV1(req.transaction);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // Let a later upgrade (from another tab) go ahead; the next call here reopens.
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Storage is blocked by another open copy of the app.'));
  });
  return dbPromise;
}

async function write(stores, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, 'readwrite');
    fn(t);
    t.oncomplete = () => resolve();
    t.onerror = t.onabort = () => reject(t.error);
  });
}

export async function loadAll() {
  const db = await open();
  const t = db.transaction(['habits', 'checks', 'settings', 'dirty', 'local']);
  const [habits, checks, prefs, dirty, local] = await Promise.all([
    request(t.objectStore('habits').getAll()),
    request(t.objectStore('checks').getAll()),
    request(t.objectStore('settings').get('prefs')),
    request(t.objectStore('dirty').getAll()),
    request(t.objectStore('local').getAll()),
  ]);
  return { habits, checks, prefs, dirty, local: Object.fromEntries(local.map(r => [r.key, r.value])) };
}

// Saves what records.js wrote (rows, plus which records now need uploading and which no
// longer do) in one transaction.
export const save = w => write(['habits', 'checks', 'settings', 'dirty'], t => {
  const hs = t.objectStore('habits'), cs = t.objectStore('checks'), ds = t.objectStore('dirty');
  w.habits.forEach(h => hs.put(h));
  w.checks.forEach(c => cs.put(c));
  if (w.prefs) t.objectStore('settings').put({ ...w.prefs, id: 'prefs' });
  w.marks.forEach(m => ds.put(m));
  w.clear.forEach(id => ds.delete(id));
});

// Clears dirty marks for records uploaded at exactly this version (a newer edit stays dirty).
export const clearDirty = list => write(['dirty'], t => {
  const ds = t.objectStore('dirty');
  for (const d of list) {
    ds.get(d.id).onsuccess = e => { if (e.target.result?.updatedAt === d.updatedAt) ds.delete(d.id); };
  }
});

export const markDirty = marks => write(['dirty'], t => {
  const ds = t.objectStore('dirty');
  marks.forEach(m => ds.put(m));
});

export const setLocal = (key, value) => write(['local'], t => {
  if (value === undefined || value === null) t.objectStore('local').delete(key);
  else t.objectStore('local').put({ key, value });
});

// Tells the service worker that the next push is a test (see sendTest in push.js).
export const markPushTest = () => setLocal('pushTest', { at: Date.now() });

// Removes every habit and check from this device, and everything in `local` except `keepLocal`.
// The week start (settings) stays.
export const eraseAll = (keepLocal = []) => write(['habits', 'checks', 'dirty', 'local'], t => {
  ['habits', 'checks', 'dirty'].forEach(n => t.objectStore(n).clear());
  const ls = t.objectStore('local');
  ls.getAllKeys().onsuccess = e => e.target.result.filter(k => !keepLocal.includes(k)).forEach(k => ls.delete(k));
});
