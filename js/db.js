// IndexedDB access. This is the only file that touches storage; everything else goes
// through store.js. If sync ever arrives, this layer is what changes.

const DB_NAME = 'tick';
const VERSION = 1;
let dbPromise;

function open() {
  dbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('habits', { keyPath: 'id' });
      const checks = db.createObjectStore('checks', { keyPath: ['habitId', 'date'] });
      checks.createIndex('habitId', 'habitId');
      db.createObjectStore('settings', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Storage is blocked by another open copy of the app.'));
  });
  return dbPromise;
}

const request = r => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});

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
  const t = db.transaction(['habits', 'checks', 'settings']);
  const [habits, checks, settings] = await Promise.all([
    request(t.objectStore('habits').getAll()),
    request(t.objectStore('checks').getAll()),
    request(t.objectStore('settings').get('app')),
  ]);
  return { habits, checks, settings };
}

export const saveHabits = habits => write(['habits'], t => {
  const s = t.objectStore('habits');
  habits.forEach(h => s.put(h));
});

// A check is one habit on one day: { habitId, date, at, kind?, amount? }. null removes it.
export const putCheck = (habitId, date, entry) => write(['checks'], t => {
  const s = t.objectStore('checks');
  if (entry) s.put({ ...entry, habitId, date, at: entry.at || Date.now() });
  else s.delete([habitId, date]);
});

export const deleteHabit = id => write(['habits', 'checks'], t => {
  t.objectStore('habits').delete(id);
  const checks = t.objectStore('checks');
  checks.index('habitId').openKeyCursor(IDBKeyRange.only(id)).onsuccess = e => {
    const cursor = e.target.result;
    if (!cursor) return;
    checks.delete(cursor.primaryKey);
    cursor.continue();
  };
});

// Adds habits and checks without removing anything (restore, undo, import).
export const putAll = (habits, checks) => write(['habits', 'checks'], t => {
  const hs = t.objectStore('habits'), cs = t.objectStore('checks');
  habits.forEach(h => hs.put(h));
  checks.forEach(c => cs.put({ ...c, at: c.at || Date.now() }));
});

export const saveSettings = settings => write(['settings'], t => {
  t.objectStore('settings').put({ ...settings, id: 'app' });
});

// Tells the service worker that the next push is a test (see sendTest in push.js).
export const markPushTest = () => write(['settings'], t => {
  t.objectStore('settings').put({ id: 'pushTest', at: Date.now() });
});

export const eraseAll = () => write(['habits', 'checks', 'settings'], t => {
  ['habits', 'checks', 'settings'].forEach(n => t.objectStore(n).clear());
});
