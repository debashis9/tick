import { parse, orderedDays, DAY_SHORT, DAY_LONG, MONTHS } from './dates.js';
import { isScheduled, dayProgress } from './stats.js';
import { store, has, active, byId, COLORS, ICONS, addHabit, updateHabit, setArchived, deleteHabit } from './store.js';
import { $, esc, ICON, cardHTML, openSheet, render, toast, toggle, storageError } from './ui.js';

// All habits for one day, each tappable. Opened from the "All habits" month view.
export function openDaySheet(k) {
  const d = parse(k);
  const body = () => {
    const list = active().filter(h => k >= h.createdOn);
    const p = dayProgress(active(), k, has);
    return `<div class="grab"></div>
      <div class="sheet-head"><div><h2>${DAY_LONG[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}</h2>
      <div class="sub">${p.done} of ${p.total} due habits done</div></div>
      <button class="x" type="button" data-close aria-label="Close">${ICON.x}</button></div>
      <div class="list">${list.length ? list.map(h => cardHTML(h, k, !isScheduled(h, d))).join('') : '<p class="sub">No habits existed on this day.</p>'}</div>
      <button class="btn-primary" type="button" data-close>Done</button>`;
  };
  const sheet = openSheet(body(), e => {
    const card = e.target.closest('.card');
    if (!card) return;
    toggle(byId(card.dataset.id), k);
    sheet.setBody(body());
    render();
  });
}

// Add a habit (id = null) or edit one.
export function openEditor(id) {
  const h = id ? byId(id) : null;
  const used = active().map(x => x.color);
  const draft = h
    ? { name: h.name, icon: h.icon, color: h.color, type: h.schedule.type, days: [...h.schedule.days] }
    : { name: '', icon: '💧', color: COLORS.find(c => !used.includes(c)) || 'green', type: 'daily', days: [1, 3, 5] };
  let err = '', confirmDelete = false, busy = false;
  const scheduleChanged = () => h.schedule.type !== draft.type
    || (draft.type === 'days' && [...h.schedule.days].sort().join() !== [...draft.days].sort().join());

  const body = () => `<div class="grab"></div>
    <div class="sheet-head"><h2>${h ? 'Edit habit' : 'New habit'}</h2><button class="x" type="button" data-close aria-label="Close">${ICON.x}</button></div>
    <div class="field"><label class="flabel" for="hname">Name</label>
      <input class="text-in" id="hname" maxlength="60" placeholder="e.g. Drink 2L water" value="${esc(draft.name)}" autocomplete="off" enterkeyhint="done"></div>
    <div class="field"><span class="flabel">Icon</span><div class="emojis">${ICONS.map(i =>
      `<button class="emo" type="button" data-icon="${i}" aria-pressed="${draft.icon === i}">${i}</button>`).join('')}</div></div>
    <div class="field"><span class="flabel">Color</span><div class="swatches">${COLORS.map(c =>
      `<button class="sw" type="button" data-color="${c}" style="--c:var(--h-${c})" aria-pressed="${draft.color === c}" aria-label="${c}"></button>`).join('')}</div></div>
    <div class="field"><span class="flabel">Repeat</span>
      <div class="seg"><button type="button" data-type="daily" aria-pressed="${draft.type === 'daily'}">Every day</button>
      <button type="button" data-type="days" aria-pressed="${draft.type === 'days'}">Specific days</button></div>
      ${draft.type === 'days' ? `<div class="days">${orderedDays(store.settings.weekStart).map(x =>
        `<button class="dy" type="button" data-dow="${x}" aria-pressed="${draft.days.includes(x)}">${DAY_SHORT[x]}</button>`).join('')}</div>` : ''}
      ${h && scheduleChanged() ? '<p class="fnote">Past days are judged by the new schedule.</p>' : ''}</div>
    ${err ? `<p class="err" role="alert">${err}</p>` : ''}
    <button class="btn-primary" type="button" data-save>${h ? 'Save changes' : 'Add habit'}</button>
    ${h ? `<div class="btn-row"><button class="btn-sm" type="button" data-archive>Archive</button>
      <button class="btn-sm danger" type="button" data-delete>${confirmDelete ? 'Tap again to delete' : 'Delete'}</button></div>
      <p class="fnote">Archive hides the habit and keeps its history. Delete removes both.</p>` : ''}`;

  const sheet = openSheet(body(), async (e, close, scrim) => {
    const t = e.target;
    const redraw = () => { draft.name = $('#hname', scrim).value; sheet.setBody(body()); };
    if (t.closest('[data-icon]')) { draft.icon = t.closest('[data-icon]').dataset.icon; return redraw(); }
    if (t.closest('[data-color]')) { draft.color = t.closest('[data-color]').dataset.color; return redraw(); }
    if (t.closest('[data-type]')) { draft.type = t.closest('[data-type]').dataset.type; return redraw(); }
    if (t.closest('[data-dow]')) {
      const x = Number(t.closest('[data-dow]').dataset.dow);
      draft.days = draft.days.includes(x) ? draft.days.filter(y => y !== x) : [...draft.days, x];
      return redraw();
    }
    if (busy) return;
    try {
      if (t.closest('[data-save]')) {
        draft.name = $('#hname', scrim).value.trim();
        if (!draft.name) { err = 'Give the habit a name.'; return redraw(); }
        if (draft.type === 'days' && !draft.days.length) { err = 'Pick at least one day.'; return redraw(); }
        busy = true;
        const fields = { name: draft.name, icon: draft.icon, color: draft.color, schedule: { type: draft.type, days: draft.type === 'days' ? [...draft.days].sort() : [] } };
        if (h) await updateHabit(h, fields); else await addHabit(fields);
        close(); render();
        return toast(h ? 'Saved' : `Added ${draft.name}`);
      }
      if (t.closest('[data-archive]')) {
        busy = true;
        await setArchived(h, true);
        close(); render();
        return toast(`Archived ${h.name}`, async () => { await setArchived(h, false); render(); });
      }
      if (t.closest('[data-delete]')) {
        if (!confirmDelete) { confirmDelete = true; return redraw(); }
        busy = true;
        const undo = await deleteHabit(h);
        close(); render();
        return toast(`Deleted ${h.name}`, async () => { await undo(); render(); });
      }
    } catch (error) {
      busy = false;
      storageError(error);
    }
  });
  // Enter in the name field saves.
  sheet.scrim.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.id === 'hname') { e.preventDefault(); sheet.scrim.querySelector('[data-save]').click(); }
  });
  if (!h) setTimeout(() => $('#hname', sheet.scrim)?.focus(), 60);
}
