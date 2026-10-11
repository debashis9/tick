// Shared UI: view state, re-render hook, small templates, toast and bottom sheets.

import { todayKey, parse, orderedDays, DAY_SHORT, MON_SHORT } from './dates.js';
import { habitStats, isWeekly, weekCount, isOccasional, occasional } from './stats.js';
import { store, has, entry, hasEntries, active, doneDates, setCheck, setEntry } from './store.js';

export const ws = () => store.settings.weekStart;

// Which version of the app this device is running: the one its service worker cached (the
// VERSION in sw.js, bumped on every deploy). Before a service worker is in charge (the very
// first visit, or a browser without one), it's read from the server's sw.js. 'tick-v5' → 'v5'.
// `appVersion.text` holds the answer once known, so views can draw it without waiting.
let versionAsked;
export function appVersion() {
  versionAsked ||= (async () => {
    const sw = navigator.serviceWorker;
    if (sw?.controller) {
      const v = await new Promise(resolve => {
        const timer = setTimeout(() => resolve(null), 1500);
        sw.addEventListener('message', function on(e) { if (e.data?.version) { clearTimeout(timer); sw.removeEventListener('message', on); resolve(e.data.version); } });
        sw.controller.postMessage('version');
      });
      if (v) return v;
    }
    try { return /VERSION = '([^']+)'/.exec(await (await fetch('sw.js', { cache: 'no-store' })).text())?.[1] || null; } catch { return null; }
  })().then(v => (appVersion.text = v ? v.replace(/^tick-/, '') : null));
  return versionAsked;
}
appVersion.text = null;

export const view = {
  tab: 'today',
  selDate: todayKey(),
  cal: { zoom: 'month', filter: 'all', month: null, weekOf: null },
  later: false,   // Today's "Later" list of occasional habits is open
};

let renderFn = () => {};
export const setRenderer = fn => { renderFn = fn; };
export const render = () => renderFn();

export const $ = (s, r = document) => r.querySelector(s);
export const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const cap = s => s[0].toUpperCase() + s.slice(1);
export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export const ICON = {
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  left: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>',
  right: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
  up: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>',
  dots: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>',
  x: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};

export const stateLabel = {
  done: 'done', missed: 'missed', off: 'not scheduled', pending: 'not done yet', future: 'upcoming', before: 'before this habit started',
};

export function ringSVG(size, sw, frac, cls = '') {
  const r = (size - sw) / 2, c = 2 * Math.PI * r, h = size / 2;
  return `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">
    <circle class="trk" cx="${h}" cy="${h}" r="${r}" fill="none" stroke-width="${sw}"/>
    <circle class="val" cx="${h}" cy="${h}" r="${r}" fill="none" stroke-width="${sw}" stroke-linecap="round"
      stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - frac)}" style="opacity:${frac > 0 ? 1 : 0}"/></svg>`;
}

const timesText = n => n === 1 ? 'Once a week' : n === 2 ? 'Twice a week' : `${n} times a week`;

export const everyText = (n, unit) => n === 1 ? `Every ${unit}` : `Every ${n} ${unit}s`;

export const scheduleText = h => h.schedule.type === 'daily' ? 'Every day'
  : isOccasional(h) ? everyText(h.schedule.n, h.schedule.unit)
  : isWeekly(h) ? timesText(h.schedule.times)
  : orderedDays(ws()).filter(x => h.schedule.days.includes(x)).map(x => DAY_SHORT[x]).join(', ');

export const fmtNum = n => Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
export const amountText = (h, n) => `${fmtNum(n)} ${h.goal.unit}`.trim();

// '3 Nov', with the year when it isn't this one.
export function dayText(k) {
  const d = parse(k);
  return `${d.getDate()} ${MON_SHORT[d.getMonth()]}${k.slice(0, 4) === todayKey().slice(0, 4) ? '' : ' ' + d.getFullYear()}`;
}

export const occasionalOf = (h, k = todayKey()) => occasional(h, doneDates(h.id), k);

// The occasional habits on day k: the ones for that day's list (due, overdue, or done that
// day), and the rest, soonest first.
export function occasionalOn(k) {
  const now = [], later = [];
  for (const h of active()) {
    if (!isOccasional(h) || k < h.createdOn) continue;
    const o = occasionalOf(h, k);
    (o.now ? now : later).push({ h, due: o.due });
  }
  later.sort((a, b) => a.due < b.due ? -1 : a.due > b.due ? 1 : 0);
  return { now: now.map(x => x.h), later: later.map(x => x.h) };
}

function occasionalText(h, k) {
  const o = occasionalOf(h, k), every = scheduleText(h).toLowerCase();
  if (o.done) return `Done · next due ${dayText(o.due)}`;
  if (o.late) return `${o.late < 60 ? `Overdue by ${plural(o.late, 'day')}` : `Overdue since ${dayText(o.due)}`} · ${every}`;
  return `Due ${o.due === k ? (k === todayKey() ? 'today' : 'this day') : dayText(o.due)} · ${every}`;
}

// The line under a habit's name for day k: progress toward that day's amount or the week's
// target, then the run or strength. An occasional habit says when it's due.
export function metaText(h, k = todayKey()) {
  if (isOccasional(h)) return occasionalText(h, k);
  const st = habitStats(h, has, todayKey(), ws());
  const parts = [];
  if (h.goal) parts.push(`${fmtNum(entry(h.id, k)?.amount || 0)} / ${amountText(h, h.goal.amount)}`);
  if (isWeekly(h)) parts.push(`${weekCount(h, parse(k), has, ws())} of ${h.schedule.times} this week`);
  else if (h.schedule.type === 'days' && !h.goal) parts.push(scheduleText(h));
  const unit = st.unit === 'week' ? ' weeks' : '';
  parts.push(st.streak >= 2 ? `${st.streak}${unit} in a row` : hasEntries(h.id) ? `Strength ${st.strength}%` : 'New');
  return parts.join(' · ');
}

const offText = (h, k) => isWeekly(h)
  ? `${weekCount(h, parse(k), has, ws())} of ${h.schedule.times} this week · target met`
  : 'Not scheduled · ' + scheduleText(h);

// Kinds (e.g. Walk / Jog / Run) show once the day is ticked, so the tick itself stays one tap.
function kindsHTML(h, k) {
  const picked = entry(h.id, k)?.kind;
  return `<div class="kinds" role="group" aria-label="Which one?">${h.kinds.map(x =>
    `<button class="kind" type="button" data-kind="${esc(x)}" aria-pressed="${x === picked}">${esc(x)}</button>`).join('')}</div>`;
}

export function cardHTML(h, k, off = false) {
  const done = has(h.id, k);
  const part = h.goal && !done ? Math.min(1, (entry(h.id, k)?.amount || 0) / h.goal.amount) : 0;
  const occ = isOccasional(h), late = occ && occasionalOf(h, k).late > 0;
  return `<div class="card${done ? ' done' : ''}${off ? ' off' : ''}${h.goal ? ' qty' : ''}${late ? ' late' : ''}" role="button" tabindex="0" aria-pressed="${done}"
    data-id="${h.id}" data-date="${k}" style="--c:var(--h-${h.color})">
    <div class="ico" aria-hidden="true">${esc(h.icon)}</div>
    <div class="txt"><div class="name">${esc(h.name)}</div><div class="meta">${off && !done && !occ ? offText(h, k) : metaText(h, k)}</div>
      ${done && h.kinds.length ? kindsHTML(h, k) : ''}</div>
    <button class="more" type="button" data-edit="${h.id}" aria-label="Edit ${esc(h.name)}">${ICON.dots}</button>
    <div class="chk${part ? ' part' : ''}" aria-hidden="true" style="--p:${part}">${ICON.check}</div>
  </div>`;
}

// ---------- toast ----------
let toastTimer;
export function toast(msg, action, label = 'Undo', ms = 4000) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button">${esc(label)}</button>` : ''}`;
  t.hidden = false;
  t.style.animation = 'none'; void t.offsetWidth; t.style.animation = '';
  if (action) t.querySelector('button').onclick = () => { t.hidden = true; action(); };
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

// ---------- ticking ----------
let persistAsked = false;
function askPersist() {
  // Ask the browser not to evict our storage under pressure. Once per session is enough.
  if (persistAsked) return;
  persistAsked = true;
  navigator.storage?.persisted?.().then(p => { if (!p) navigator.storage.persist?.(); }).catch(() => {});
}

// Flips a tick. Unticking shows an undo toast. Returns the new state.
export function toggle(h, k) {
  const old = entry(h.id, k), done = !has(h.id, k);
  setCheck(h, k, done).catch(storageError);
  if (done) ticked();
  else toast(`Unticked ${h.name}`, () => { setEntry(h.id, k, old).catch(storageError); render(); });
  return done;
}

export function ticked() {
  askPersist();
  navigator.vibrate?.(8);
}

export function storageError(err) {
  console.error(err);
  toast("Couldn't save that change. Check that this browser allows site storage.", null, '', 8000);
}

// ---------- sheets ----------
export function openSheet(html, onClick) {
  const opener = document.activeElement;
  const scrim = document.createElement('div');
  scrim.className = 'scrim';
  scrim.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
  document.body.appendChild(scrim);
  const close = () => {
    scrim.remove();
    document.removeEventListener('keydown', onKey);
    opener?.focus?.();
  };
  const onKey = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  scrim.addEventListener('click', e => {
    if (e.target === scrim || e.target.closest('[data-close]')) return close();
    onClick?.(e, close, scrim);
  });
  scrim.querySelector('.sheet').focus?.();
  return { scrim, close, setBody: html => { scrim.querySelector('.sheet').innerHTML = html; } };
}

export const monthOf = d => new Date(d.getFullYear(), d.getMonth(), 1);
export const daysSince = k => k ? Math.round((parse(todayKey()) - parse(k)) / 864e5) : Infinity;
