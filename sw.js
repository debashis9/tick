// Cache-first app shell. Bump VERSION on every deploy: the browser only installs a new
// service worker when this file's bytes change, and the app then offers "Refresh".
const VERSION = 'tick-v4';

const SHELL = [
  './',
  './styles.css',
  './manifest.webmanifest',
  './js/app.js',
  './js/backup.js',
  './js/dates.js',
  './js/db.js',
  './js/drag.js',
  './js/push.js',
  './js/sheets.js',
  './js/stats.js',
  './js/store.js',
  './js/theme.js',
  './js/ui.js',
  './js/views/calendar.js',
  './js/views/settings.js',
  './js/views/today.js',
  './js/vendor/qrcode.min.js',
  './fonts/bricolage-grotesque-latin.woff2',
  './fonts/figtree-latin.woff2',
  './icons/favicon.svg',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

// A response that followed a redirect can't be used for a navigation; copy it into a plain one.
const unredirect = r => r.redirected ? r.blob().then(b => new Response(b, { status: r.status, statusText: r.statusText, headers: r.headers })) : r;

self.addEventListener('install', event => {
  event.waitUntil(caches.open(VERSION).then(cache => cache.addAll(SHELL)));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    // Any page load (including ?query or #hash variants) gets the cached shell. It's cached
    // as './', not './index.html': some hosts (Cloudflare) redirect /index.html to /, and a
    // redirected response can't answer a navigation.
    event.respondWith(caches.match('./').then(r => r ? unredirect(r) : fetch(req)));
    return;
  }
  if (new URL(req.url).pathname.endsWith('/manifest.webmanifest')) {
    // Network first, so install details (name, id, icons) are never stale; cache when offline.
    event.respondWith(fetch(req).then(res => {
      const copy = res.clone();
      caches.open(VERSION).then(cache => cache.put('./manifest.webmanifest', copy));
      return res;
    }).catch(() => caches.match('./manifest.webmanifest')));
    return;
  }
  event.respondWith(caches.match(req, { ignoreSearch: true }).then(r => r || fetch(req)));
});

// ---------- reminders ----------
// The Tick Worker sends an empty push at a reminder time. It knows nothing about habits, so
// this worker reads them from IndexedDB and says what's still to do. If everything is done,
// it closes the notification straight away (browsers require one for every push).

const pad = n => String(n).padStart(2, '0');
const dateKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const req = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

// Opens the app's database without ever creating it (the page owns the schema).
function openDB() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('tick');
    r.onupgradeneeded = () => r.transaction.abort();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

const isDone = (h, c) => !!c && (!h.goal || c.amount == null || c.amount >= h.goal.amount);

async function whatsDue(now) {
  const db = await openDB();
  try {
    const t = db.transaction(['habits', 'checks', 'settings'], 'readwrite');
    const [habits, checks, settings, test] = await Promise.all([
      req(t.objectStore('habits').getAll()),
      req(t.objectStore('checks').getAll()),
      req(t.objectStore('settings').get('app')),
      req(t.objectStore('settings').get('pushTest')),
    ]);
    if (test) t.objectStore('settings').delete('pushTest');
    const today = dateKey(now), mins = now.getHours() * 60 + now.getMinutes() + 2;
    const ws = settings?.weekStart ?? 1;
    const w0 = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (now.getDay() - ws + 7) % 7);
    const week = new Set([0, 1, 2, 3, 4, 5, 6].map(i => dateKey(new Date(w0.getFullYear(), w0.getMonth(), w0.getDate() + i))));
    const byKey = new Map(checks.map(c => [c.habitId + '|' + c.date, c]));
    const weekCount = h => checks.filter(c => c.habitId === h.id && week.has(c.date) && isDone(h, c)).length;
    const due = habits
      .filter(h => !h.archivedOn && h.reminder && h.createdOn <= today)
      .filter(h => Number(h.reminder.slice(0, 2)) * 60 + Number(h.reminder.slice(3)) <= mins)
      .filter(h => h.schedule.type !== 'days' || h.schedule.days.includes(now.getDay()))
      .filter(h => !isDone(h, byKey.get(h.id + '|' + today)))
      .filter(h => h.schedule.type !== 'weekly' || weekCount(h) < h.schedule.times)
      .sort((a, b) => a.order - b.order)
      .map(h => ({ h, entry: byKey.get(h.id + '|' + today), count: h.schedule.type === 'weekly' ? weekCount(h) : 0 }));
    await new Promise(resolve => { t.oncomplete = t.onerror = t.onabort = resolve; });
    return { due, today, test: test && now - test.at < 10 * 60e3 };
  } finally {
    db.close();
  }
}

async function remind() {
  const now = new Date();
  const opts = { icon: './icons/icon-192.png', tag: 'tick-reminder', renotify: true, data: {} };
  let due = [], today, test = false;
  try { ({ due, today, test } = await whatsDue(now)); } catch (e) { console.warn(e); }
  if (test) return self.registration.showNotification('Reminders are working', { ...opts, body: 'This is how Tick will remind you.' });
  if (!due.length) {
    await self.registration.showNotification('Tick', { ...opts, silent: true, renotify: false });
    const shown = await self.registration.getNotifications({ tag: 'tick-reminder' });
    shown.forEach(n => n.close());
    return;
  }
  if (due.length === 1) {
    const { h, entry, count } = due[0];
    const body = h.goal ? `${[`${entry?.amount || 0} of ${h.goal.amount}`, h.goal.unit].filter(Boolean).join(' ')} so far today.`
      : h.schedule.type === 'weekly' ? `${count} of ${h.schedule.times} this week. Not done yet today.`
      : 'Not done yet today.';
    return self.registration.showNotification(`${h.icon} ${h.name}`, {
      ...opts, body, data: { habitId: h.id, date: today },
      actions: h.goal ? [] : [{ action: 'done', title: 'Mark done' }],
    });
  }
  return self.registration.showNotification(`${due.length} habits still to do`, {
    ...opts, body: due.map(({ h }) => `${h.icon} ${h.name}`).join('\n'),
  });
}

self.addEventListener('push', event => event.waitUntil(remind()));

// "Mark done" ticks the habit without opening the app; open copies of the app re-read storage.
async function markDone(habitId, date) {
  const db = await openDB();
  try {
    const t = db.transaction(['checks'], 'readwrite');
    const store = t.objectStore('checks');
    const old = await req(store.get([habitId, date]));
    store.put({ ...old, habitId, date, at: Date.now() });
    await new Promise((resolve, reject) => { t.oncomplete = resolve; t.onerror = t.onabort = () => reject(t.error); });
  } finally {
    db.close();
  }
  if ('BroadcastChannel' in self) new BroadcastChannel('tick').postMessage('changed');
}

async function openApp() {
  const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  if (open.length) return open[0].focus();
  return self.clients.openWindow('./');
}

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const { habitId, date } = event.notification.data || {};
  event.waitUntil(event.action === 'done' && habitId ? markDone(habitId, date) : openApp());
});
