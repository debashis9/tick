// Cache-first app shell. Bump VERSION on every deploy: the browser only installs a new
// service worker when this file's bytes change, and the app then offers "Refresh".
const VERSION = 'tick-v2';

const SHELL = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './js/app.js',
  './js/backup.js',
  './js/dates.js',
  './js/db.js',
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
    // Any page load (including ?query or #hash variants) gets the cached shell.
    event.respondWith(caches.match('./index.html').then(r => r || fetch(req)));
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
