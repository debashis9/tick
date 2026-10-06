import { todayKey, parse } from './dates.js';
import { init, store, onExternalChange, onLocalChange, saveSettings } from './store.js';
import { view, $, setRenderer, toast, monthOf, appVersion } from './ui.js';
import { renderToday, bindToday } from './views/today.js';
import { renderCalendar, bindCalendar } from './views/calendar.js';
import { renderSettings, bindSettings, resetSettingsConfirm } from './views/settings.js';
import { renderAdmin, bindAdmin, unlockAdmin, updateAdminNav, refreshAdmin } from './views/admin.js';
import { isAdminDevice } from './admin.js';
import { applyTheme } from './theme.js';
import { startReminderSync } from './push.js';
import { startBackgroundSync, onSyncStatus, checkRequest } from './sync.js';

// 'admin' has a nav button only on admin devices (views/admin.js: updateAdminNav).
const TABS = ['today', 'calendar', 'settings', 'admin'];

function render() {
  updateAdminNav();
  if (view.tab === 'today') renderToday();
  else if (view.tab === 'calendar') renderCalendar();
  else if (view.tab === 'admin') renderAdmin();
  else renderSettings();
}

function go(tab) {
  view.tab = tab;
  TABS.forEach(t => { $('#view-' + t).hidden = t !== tab; });
  document.querySelectorAll('.nav-item').forEach(b => {
    if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  $('#main').classList.toggle('wide', tab === 'calendar');
  if (tab === 'admin') refreshAdmin();
  resetSettingsConfirm();
  render();
  window.scrollTo(0, 0);
  history.replaceState(null, '', location.pathname + (tab === 'today' ? '' : '#' + tab));
}

// Records arrived from the cloud or another tab. Don't redraw the list under a card that is
// being dragged, or a field someone is typing in: wait until they're done.
function renderRemote() {
  const a = document.activeElement;
  if (document.querySelector('.card.lifted') || (a?.closest?.('main') && a.matches('input:not([type=file])'))) return setTimeout(renderRemote, 400);
  render();
}

// The admin's own link (…/#admin=KEY, from tools/admin-link.mjs) unlocks the admin page on this
// device without typing the key. The key is taken out of the address at once.
function takeAdminLink() {
  if (!location.hash.startsWith('#admin=')) return false;
  const key = decodeURIComponent(location.hash.slice(7));
  history.replaceState(null, '', location.pathname + '#admin');
  const unlocking = unlockAdmin(key);
  go('admin');   // shows "Checking…" until the server answers
  unlocking.then(ok => { updateAdminNav(); if (view.tab === 'admin') renderAdmin(); if (ok) toast('Admin unlocked on this device. You can now turn on cloud backup too.', null, '', 7000); });
  return true;
}

// If the app stays open past midnight, move "today" forward.
let lastToday = todayKey();
function checkDayRollover() {
  const t = todayKey();
  if (t === lastToday) return;
  if (view.selDate === lastToday) view.selDate = t;
  if (view.cal.month && view.cal.month.getTime() === monthOf(parse(lastToday)).getTime()) view.cal.month = monthOf(parse(t));
  view.cal.weekOf = null;
  lastToday = t;
  render();
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // Reload only when the user asked for the new version. On a first visit the worker
  // also takes control (clients.claim), and that must not reload the page.
  let updateRequested = false;
  navigator.serviceWorker.register('./sw.js').then(reg => {
    reg.addEventListener('updatefound', () => {
      const next = reg.installing;
      next?.addEventListener('statechange', () => {
        if (next.state === 'installed' && navigator.serviceWorker.controller) {
          toast('A new version of Tick is ready', () => { updateRequested = true; next.postMessage('skipWaiting'); }, 'Refresh', 0);
        }
      });
    });
  }).catch(err => console.warn('Service worker not registered:', err));
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!updateRequested) return;
    updateRequested = false;
    location.reload();
  });
}

// An invite link (…/?invite=…) is kept on this device until backup is turned on. Read before
// the first tab switch, which rewrites the address.
const invite = new URLSearchParams(location.search).get('invite');
async function takeInvite() {
  if (!invite) return;
  if (/^[\w-]+\.[\w-]+$/.test(invite) && invite.length < 400) {
    await saveSettings({ invite });
    toast('Invite saved. Turn on cloud backup in Settings whenever you like.', () => document.querySelector('.nav [data-tab="settings"]').click(), 'Settings', 8000);
  }
}

// Asks whether a backup request was answered: on open and whenever Tick comes back to the screen.
async function askAboutRequest() {
  const before = store.settings.request?.status;
  const now = await checkRequest();
  if (now && now !== before) {
    if (now === 'approved') toast('Your cloud backup request was approved.', () => go('settings'), 'Turn on', 10000);
    else if (now === 'rejected') toast("Your cloud backup request wasn't approved.", null, '', 7000);
    render();
  }
}

async function boot() {
  try {
    await init();
  } catch (err) {
    console.error(err);
    $('#main').innerHTML = `<div class="fatal"><h1>Tick can't open its storage</h1>
      <p>This browser is blocking site storage, which Tick needs to keep your habits on this device.
      Private or incognito windows often do this. Open Tick in a normal window, or allow site data for this page.</p></div>`;
    return;
  }
  applyTheme(store.settings.theme);
  view.cal.month = monthOf(parse(todayKey()));
  setRenderer(render);
  bindToday();
  bindCalendar();
  bindSettings();
  onExternalChange(renderRemote);
  // Erase (and its undo) changes whether this device holds the admin's backup.
  onLocalChange(() => { updateAdminNav(); if (view.tab === 'admin' && !isAdminDevice()) go('today'); });
  // A sync may have changed whether this device is the admin, or how many people are waiting.
  onSyncStatus(() => {
    updateAdminNav();
    if (view.tab === 'admin' && !isAdminDevice()) go('today');
    else if ((view.tab === 'settings' || view.tab === 'today') && !document.querySelector('.scrim')) render();
  });
  document.querySelector('.nav').addEventListener('click', e => {
    const b = e.target.closest('[data-tab]');
    if (b) go(b.dataset.tab);
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { checkDayRollover(); askAboutRequest(); } });
  setInterval(checkDayRollover, 60_000);
  bindAdmin();
  // Links inside the app (Settings → Admin → Open, Admin → ‹ Settings) and the admin link.
  addEventListener('hashchange', () => {
    if (takeAdminLink()) return;
    const t = location.hash.slice(1);
    if (TABS.includes(t) && t !== view.tab) go(t);
  });
  updateAdminNav();
  const start = location.hash.slice(1);
  if (!takeAdminLink()) go(TABS.includes(start) ? start : 'today');   // #admin without rights shows how to get them
  registerServiceWorker();
  appVersion().then(v => { if (v && (view.tab === 'today' || view.tab === 'settings')) render(); });
  startReminderSync();
  await takeInvite();
  startBackgroundSync();
  askAboutRequest();
}

boot();
