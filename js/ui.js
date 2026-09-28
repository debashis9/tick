// Shared UI: view state, re-render hook, small templates, toast and bottom sheets.

import { todayKey, parse, orderedDays, DAY_SHORT } from './dates.js';
import { habitStats } from './stats.js';
import { store, has, setCheck } from './store.js';

export const view = {
  tab: 'today',
  selDate: todayKey(),
  cal: { zoom: 'month', filter: 'all', month: null, weekOf: null },
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

export const scheduleText = h => h.schedule.type === 'daily' ? 'Every day'
  : orderedDays(store.settings.weekStart).filter(x => h.schedule.days.includes(x)).map(x => DAY_SHORT[x]).join(', ');

export function metaText(h) {
  const st = habitStats(h, has, todayKey());
  const parts = [];
  if (h.schedule.type !== 'daily') parts.push(scheduleText(h));
  const started = [...store.checks].some(c => c.startsWith(h.id + '|'));
  parts.push(st.streak >= 2 ? `${st.streak} in a row` : started ? `Strength ${st.strength}%` : 'New');
  return parts.join(' · ');
}

export function cardHTML(h, k, off = false) {
  const done = has(h.id, k);
  return `<div class="card${done ? ' done' : ''}${off ? ' off' : ''}" role="button" tabindex="0" aria-pressed="${done}"
    data-id="${h.id}" data-date="${k}" style="--c:var(--h-${h.color})">
    <div class="ico" aria-hidden="true">${esc(h.icon)}</div>
    <div class="txt"><div class="name">${esc(h.name)}</div><div class="meta">${off ? 'Not scheduled · ' + scheduleText(h) : metaText(h)}</div></div>
    <button class="more" type="button" data-edit="${h.id}" aria-label="Edit ${esc(h.name)}">${ICON.dots}</button>
    <div class="chk" aria-hidden="true">${ICON.check}</div>
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
  const done = !has(h.id, k);
  setCheck(h.id, k, done).catch(storageError);
  if (done) { askPersist(); navigator.vibrate?.(8); }
  else toast(`Unticked ${h.name}`, () => { setCheck(h.id, k, true).catch(storageError); render(); });
  return done;
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
