import { todayKey, parse, addDays, key, DAY_LONG, DAY_SHORT, MONTHS } from '../dates.js';
import { isDue, dayProgress } from '../stats.js';
import { store, has, active, byId, saveSettings, tickCount, reorder } from '../store.js';
import { view, $, ws, cardHTML, metaText, ringSVG, toggle, storageError, daysSince } from '../ui.js';
import { openEditor, openAmountSheet, pickKind } from '../sheets.js';
import { exportBackup } from '../backup.js';
import { bindDrag } from '../drag.js';

const el = () => $('#view-today');

function subText(p, isToday) {
  if (!p.total) return 'Nothing scheduled';
  if (p.done === p.total) return isToday ? 'All done today' : 'All done that day';
  return isToday ? `${p.total - p.done} to go` : `${p.done} of ${p.total} done`;
}

function stripHTML() {
  const t = parse(todayKey());
  let out = '';
  for (let i = 6; i >= 0; i--) {
    const d = addDays(t, -i), k = key(d), p = dayProgress(active(), k, has, key(t), ws());
    out += `<button class="sd" type="button" data-day="${k}" aria-pressed="${k === view.selDate}"
      aria-label="${DAY_LONG[d.getDay()]} ${d.getDate()}: ${p.done} of ${p.total} done">
      <span class="l">${DAY_SHORT[d.getDay()][0]}</span><span class="n">${d.getDate()}</span>${ringSVG(18, 3, p.total ? p.done / p.total : 0, 'mini')}</button>`;
  }
  return out;
}

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

function bannerHTML() {
  const s = store.settings;
  if (isIOS && !isStandalone() && !s.installTipDismissed) {
    return `<div class="notice"><span>Add Tick to your Home Screen so Safari doesn't clear your history: tap Share, then Add to Home Screen.</span>
      <button type="button" data-act="dismiss-install">Got it</button></div>`;
  }
  const since = daysSince(s.lastBackupOn || s.firstUsedOn);
  const snoozed = s.backupSnoozedUntil && s.backupSnoozedUntil > todayKey();
  if (since >= 30 && !snoozed && tickCount()) {
    return `<div class="notice"><span>${s.lastBackupOn ? `Your last backup was ${since} days ago.` : "You haven't backed up yet."} Your history lives only on this device.</span>
      <span class="notice-actions"><button type="button" data-act="snooze-backup" class="quiet">Later</button><button type="button" data-act="backup">Back up</button></span></div>`;
  }
  return '';
}

export function renderToday() {
  const tKey = todayKey();
  if (view.selDate > tKey) view.selDate = tKey;
  const k = view.selDate, d = parse(k), isToday = k === tKey;
  const p = dayProgress(active(), k, has, tKey, ws());
  const list = active().filter(h => k >= h.createdOn);
  const due = list.filter(h => isDue(h, d, has, tKey, ws()));
  const rest = list.filter(h => !due.includes(h));
  el().innerHTML = `
    <header class="head">
      <div>
        <div class="eyebrow">${isToday ? DAY_LONG[d.getDay()] : 'Editing ' + DAY_LONG[d.getDay()]}</div>
        <h1>${d.getDate()} ${MONTHS[d.getMonth()]}</h1>
        <div class="sub" id="today-sub">${subText(p, isToday)}</div>
      </div>
      <div class="pring" id="pring" role="img" aria-label="${p.done} of ${p.total} done">${ringSVG(58, 5, p.total ? p.done / p.total : 0)}<span>${p.done}/${p.total}</span></div>
    </header>
    <div class="strip" id="strip">${stripHTML()}</div>
    ${isToday ? bannerHTML() : `<div class="notice"><span>You're editing a past day.</span><button type="button" data-act="today">Back to today</button></div>`}
    ${active().length ? '' : `<div class="empty"><h2>No habits yet</h2><p>Add the first thing you want to keep doing.</p></div>`}
    ${active().length && !list.length ? `<div class="empty"><p>None of your habits had started by this day.</p></div>` : ''}
    ${due.length ? `<div class="list">${due.map(h => cardHTML(h, k)).join('')}</div>` : ''}
    ${rest.length ? `<div class="sec">Not due ${isToday ? 'today' : 'that day'}</div><div class="list">${rest.map(h => cardHTML(h, k, true)).join('')}</div>` : ''}
    <button class="add" type="button" data-act="new"><span aria-hidden="true">+</span> New habit</button>
    ${active().length ? '<p class="hint">Tap a habit to tick it. Press and hold to edit it, or hold and drag to move it.</p>' : ''}`;
}

function refreshHeader() {
  const p = dayProgress(active(), view.selDate, has, todayKey(), ws());
  const frac = p.total ? p.done / p.total : 0;
  const ring = $('#pring');
  if (!ring) return;
  const val = ring.querySelector('.val');
  val.setAttribute('stroke-dashoffset', parseFloat(val.getAttribute('stroke-dasharray')) * (1 - frac));
  val.style.opacity = frac > 0 ? 1 : 0;
  ring.querySelector('span').textContent = `${p.done}/${p.total}`;
  ring.setAttribute('aria-label', `${p.done} of ${p.total} done`);
  $('#today-sub').textContent = subText(p, view.selDate === todayKey());
  $('#strip').innerHTML = stripHTML();
}

export function bindToday() {
  const root = el();
  bindDrag(root, {
    onHold: card => openEditor(card.dataset.id),
    // A section shows some of the habits; they take the dragged order within their own slots.
    onDrop: ids => {
      const all = active().map(h => h.id), slots = new Set(ids), next = [...ids];
      reorder(all.map(id => slots.has(id) ? next.shift() : id)).then(renderToday, storageError);
    },
  });
  root.addEventListener('keydown', e => {
    const card = e.target.closest('.card');
    if (card && e.target === card && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); card.click(); }
  });
  root.addEventListener('click', e => {
    const t = e.target;
    const edit = t.closest('[data-edit]');
    if (edit) return openEditor(edit.dataset.edit);
    const day = t.closest('[data-day]');
    if (day) { view.selDate = day.dataset.day; return renderToday(); }
    const act = t.closest('[data-act]')?.dataset.act;
    if (act === 'today') { view.selDate = todayKey(); return renderToday(); }
    if (act === 'new') return openEditor(null);
    if (act === 'dismiss-install') return saveSettings({ installTipDismissed: true }).then(renderToday, storageError);
    if (act === 'snooze-backup') return saveSettings({ backupSnoozedUntil: key(addDays(parse(todayKey()), 7)) }).then(renderToday, storageError);
    if (act === 'backup') return exportBackup().then(renderToday);
    const card = t.closest('.card');
    if (!card) return;
    const h = byId(card.dataset.id);
    const kind = t.closest('[data-kind]');
    if (kind) return pickKind(h, card.dataset.date, kind.dataset.kind).then(renderToday);
    if (h.goal) return openAmountSheet(h, card.dataset.date);
    const done = toggle(h, card.dataset.date);
    // Kind chips appear, or the week's count moves the habit between sections: redraw.
    if (h.kinds.length || h.schedule.type === 'weekly') {
      renderToday();
      if (done) el().querySelector(`.card[data-id="${h.id}"]`)?.classList.add('pop');
      return;
    }
    card.classList.toggle('done', done);
    card.setAttribute('aria-pressed', done);
    if (done) { card.classList.remove('pop'); void card.offsetWidth; card.classList.add('pop'); }
    if (!card.classList.contains('off')) card.querySelector('.meta').textContent = metaText(h, card.dataset.date);
    refreshHeader();
  });
}
