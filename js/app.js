import { todayKey, parse } from './dates.js';
import { init, store, onExternalChange } from './store.js';
import { view, $, setRenderer, toast, monthOf } from './ui.js';
import { renderToday, bindToday } from './views/today.js';
import { renderCalendar, bindCalendar } from './views/calendar.js';
import { renderSettings, bindSettings, resetSettingsConfirm } from './views/settings.js';
import { applyTheme } from './theme.js';

const TABS = ['today', 'calendar', 'settings'];

function render() {
  if (view.tab === 'today') renderToday();
  else if (view.tab === 'calendar') renderCalendar();
  else renderSettings();
}

function go(tab) {
  view.tab = tab;
  TABS.forEach(t => { $('#view-' + t).hidden = t !== tab; });
  document.querySelectorAll('.nav-item').forEach(b => {
    if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  $('#main').classList.toggle('wide', tab === 'calendar');
  resetSettingsConfirm();
  render();
  window.scrollTo(0, 0);
  history.replaceState(null, '', tab === 'today' ? location.pathname : '#' + tab);
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
  onExternalChange(render);
  document.querySelector('.nav').addEventListener('click', e => {
    const b = e.target.closest('[data-tab]');
    if (b) go(b.dataset.tab);
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkDayRollover(); });
  setInterval(checkDayRollover, 60_000);
  const start = location.hash.slice(1);
  go(TABS.includes(start) ? start : 'today');
  registerServiceWorker();
}

boot();
