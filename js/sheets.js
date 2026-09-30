import { todayKey, parse, orderedDays, DAY_SHORT, DAY_LONG, MONTHS } from './dates.js';
import { isDue, dayProgress } from './stats.js';
import { has, entry, active, byId, COLORS, ICONS, MAX_KINDS, addHabit, updateHabit, setArchived, deleteHabit, setEntry } from './store.js';
import { $, esc, ICON, ws, cardHTML, openSheet, render, toast, toggle, ticked, storageError, amountText } from './ui.js';
import { enableReminders } from './push.js';

const dayTitle = k => { const d = parse(k); return `${DAY_LONG[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`; };

// Picks (or un-picks) which kind a ticked day was, e.g. Jog.
export function pickKind(h, k, kind) {
  const e = { ...entry(h.id, k) };
  if (e.kind === kind) delete e.kind; else e.kind = kind;
  return setEntry(h.id, k, e).catch(storageError);
}

// All habits for one day, each tappable. Opened from the "All habits" month view.
export function openDaySheet(k) {
  const d = parse(k), tKey = todayKey();
  const body = () => {
    const list = active().filter(h => k >= h.createdOn);
    const p = dayProgress(active(), k, has, tKey, ws());
    return `<div class="grab"></div>
      <div class="sheet-head"><div><h2>${dayTitle(k)}</h2>
      <div class="sub">${p.done} of ${p.total} due habits done</div></div>
      <button class="x" type="button" data-close aria-label="Close">${ICON.x}</button></div>
      <div class="list">${list.length ? list.map(h => cardHTML(h, k, !isDue(h, d, has, tKey, ws()))).join('') : '<p class="sub">No habits existed on this day.</p>'}</div>
      <button class="btn-primary" type="button" data-close>Done</button>`;
  };
  const sheet = openSheet(body(), async e => {
    const card = e.target.closest('.card');
    if (!card || e.target.closest('[data-edit]')) return;
    const h = byId(card.dataset.id), kind = e.target.closest('[data-kind]');
    if (kind) await pickKind(h, k, kind.dataset.kind); else toggle(h, k);
    sheet.setBody(body());
    render();
  });
}

// Logs how much of a quantity habit was done on day k (the day's total, not an increment).
export function openAmountSheet(h, k) {
  const e = entry(h.id, k), goal = h.goal.amount;
  const step = goal >= 20 ? 5 : 1;
  let value = e?.amount || goal;
  const body = () => `<div class="grab"></div>
    <div class="sheet-head"><div><h2>${esc(h.icon)} ${esc(h.name)}</h2>
      <div class="sub">${k === todayKey() ? 'Today' : dayTitle(k)} · goal ${esc(amountText(h, goal))}</div></div>
      <button class="x" type="button" data-close aria-label="Close">${ICON.x}</button></div>
    <div class="amount" style="--c:var(--h-${h.color})">
      <button class="stepbtn" type="button" data-step="-1" aria-label="Less">−</button>
      <label class="amount-in"><input id="hamount" type="number" inputmode="decimal" min="0" step="any" value="${value}" aria-label="Amount in ${esc(h.goal.unit || 'units')}">
        <span>${esc(h.goal.unit)}</span></label>
      <button class="stepbtn" type="button" data-step="1" aria-label="More">+</button>
    </div>
    <button class="btn-primary" type="button" data-save-amount>Save</button>
    ${e ? '<button class="btn-sm" type="button" data-clear-amount>Clear this day</button>' : ''}`;
  const read = scrim => { const n = parseFloat($('#hamount', scrim).value); return Number.isFinite(n) && n >= 0 ? Math.min(n, 1e6) : null; };
  const sheet = openSheet(body(), async (ev, close, scrim) => {
    const t = ev.target;
    const st = t.closest('[data-step]');
    if (st) {
      value = Math.max(0, Math.round(((read(scrim) ?? 0) + step * Number(st.dataset.step)) * 100) / 100);
      $('#hamount', scrim).value = value;
      return;
    }
    try {
      if (t.closest('[data-clear-amount]')) {
        await setEntry(h.id, k, null);
        close(); render();
        return toast(`Cleared ${h.name}`, () => { setEntry(h.id, k, e).catch(storageError); render(); });
      }
      if (t.closest('[data-save-amount]')) {
        const n = read(scrim);
        if (n == null) return;
        const wasDone = has(h.id, k), next = { ...e, amount: Math.round(n * 100) / 100 };
        await setEntry(h.id, k, n > 0 || next.kind ? next : null);
        if (!wasDone && has(h.id, k)) ticked();
        close(); render();
      }
    } catch (err) { storageError(err); }
  });
  sheet.scrim.addEventListener('keydown', ev => {
    if (ev.key === 'Enter' && ev.target.id === 'hamount') { ev.preventDefault(); sheet.scrim.querySelector('[data-save-amount]').click(); }
  });
  setTimeout(() => $('#hamount', sheet.scrim)?.select(), 60);
}

// Offered from a habit's name, never applied without a tap. Names like "Walk / Jog / Run" or
// "Tea or coffee" suggest their parts as kinds.
const AMOUNTS = [
  [/\b(read|reading|book|books|pages?)\b/i, '20', 'pages'],
  [/\b(meditat\w*|yoga|stretch\w*|practi[cs]e|study|studying|guitar|piano)\b/i, '15', 'minutes'],
  [/\b(water|drink)\b/i, '8', 'glasses'],
];
function suggestions(d) {
  const out = [];
  const a = AMOUNTS.find(([re]) => re.test(d.name));
  if (a && !d.goal.trim()) out.push({ goal: a[1], unit: a[2], label: `Track ${a[2]}, ${a[1]} a day` });
  const parts = d.name.split(/\s*(?:\/|,|\bor\b)\s*/i).map(x => x.trim()).filter(Boolean);
  if (parts.length >= 2 && parts.length <= MAX_KINDS && parts.every(x => x.length <= 20) && !d.kinds.trim()) {
    out.push({ kinds: parts.join(', '), label: `Pick one each time: ${parts.join(', ')}` });
  }
  return out;
}

const parseKinds = s => [...new Set(s.split(',').map(x => x.trim().slice(0, 20)).filter(Boolean))];

// Add a habit (id = null) or edit one.
export function openEditor(id) {
  const h = id ? byId(id) : null;
  const used = active().map(x => x.color);
  const draft = h
    ? { name: h.name, icon: h.icon, color: h.color, type: h.schedule.type, days: [...h.schedule.days], times: h.schedule.times || 3,
      goal: h.goal ? String(h.goal.amount) : '', unit: h.goal?.unit || '', kinds: h.kinds.join(', '), reminder: h.reminder }
    : { name: '', icon: '💧', color: COLORS.find(c => !used.includes(c)) || 'green', type: 'daily', days: [1, 3, 5], times: 3,
      goal: '', unit: '', kinds: '', reminder: null };
  let err = '', confirmDelete = false, busy = false, more = !!(h && (h.goal || h.kinds.length));
  const moreSub = () => {
    const set = [draft.goal.trim() && `${draft.goal.trim()} ${draft.unit.trim()}`.trim() + ' a day', draft.kinds.trim()].filter(Boolean);
    if (set.length) return set.join(' · ');
    const sg = suggestions(draft);
    return sg.length ? `Suggested: ${sg[0].label.charAt(0).toLowerCase() + sg[0].label.slice(1)}` : 'Daily amount, kinds';
  };
  const suggestHTML = () => suggestions(draft).map((x, i) =>
    `<button class="suggest" type="button" data-suggest="${i}"><span aria-hidden="true">+</span> ${esc(x.label)}</button>`).join('');
  const scheduleChanged = () => h.schedule.type !== draft.type
    || (draft.type === 'days' && [...h.schedule.days].sort().join() !== [...draft.days].sort().join())
    || (draft.type === 'weekly' && h.schedule.times !== draft.times);

  const body = () => `<div class="grab"></div>
    <div class="sheet-head"><h2>${h ? 'Edit habit' : 'New habit'}</h2><button class="x" type="button" data-close aria-label="Close">${ICON.x}</button></div>
    <div class="field"><label class="flabel" for="hname">Name</label>
      <input class="text-in" id="hname" maxlength="60" placeholder="e.g. Drink 2L water" value="${esc(draft.name)}" autocomplete="off" enterkeyhint="done"></div>
    <div class="field"><span class="flabel">Icon</span><div class="emojis">${ICONS.map(i =>
      `<button class="emo" type="button" data-icon="${i}" aria-pressed="${draft.icon === i}">${i}</button>`).join('')}</div></div>
    <div class="field"><span class="flabel">Color</span><div class="swatches">${COLORS.map(c =>
      `<button class="sw" type="button" data-color="${c}" style="--c:var(--h-${c})" aria-pressed="${draft.color === c}" aria-label="${c}"></button>`).join('')}</div></div>
    <div class="field"><span class="flabel">Repeat</span>
      <div class="seg seg-3"><button type="button" data-type="daily" aria-pressed="${draft.type === 'daily'}">Every day</button>
      <button type="button" data-type="days" aria-pressed="${draft.type === 'days'}">Some days</button>
      <button type="button" data-type="weekly" aria-pressed="${draft.type === 'weekly'}">Per week</button></div>
      ${draft.type === 'days' ? `<div class="days">${orderedDays(ws()).map(x =>
        `<button class="dy" type="button" data-dow="${x}" aria-pressed="${draft.days.includes(x)}">${DAY_SHORT[x]}</button>`).join('')}</div>` : ''}
      ${draft.type === 'weekly' ? `<div class="stepper"><button class="stepbtn" type="button" data-times="-1" aria-label="Fewer" ${draft.times <= 1 ? 'disabled' : ''}>−</button>
        <b>${draft.times}</b><span>${draft.times === 1 ? 'time' : 'times'} a week, any days</span>
        <button class="stepbtn" type="button" data-times="1" aria-label="More" ${draft.times >= 6 ? 'disabled' : ''}>+</button></div>` : ''}
      ${h && scheduleChanged() ? '<p class="fnote">Past days are judged by the new schedule.</p>' : ''}</div>
    <div class="field"><span class="flabel">Reminder</span>
      <div class="remind"><button class="switch" type="button" role="switch" data-remind aria-checked="${!!draft.reminder}" aria-label="Remind me"><i></i></button>
        ${draft.reminder ? `<input class="text-in time-in" id="hrem" type="time" value="${draft.reminder}" aria-label="Reminder time">` : '<span class="fnote">Off</span>'}</div>
      ${draft.reminder ? '<p class="fnote">A notification at this time on days the habit is due, unless it\'s already done.</p>' : ''}</div>
    <div class="more-opts">
      <button class="more-toggle" type="button" data-more aria-expanded="${more}">
        <span class="rt"><span class="rtitle">More options</span><span class="rs" id="more-sub">${esc(moreSub())}</span></span>${more ? ICON.up : ICON.down}</button>
      ${more ? `<div class="more-body">
        <div class="suggests" id="hsuggest">${suggestHTML()}</div>
        <div class="field"><span class="flabel">Daily amount <em>optional</em></span>
          <div class="pair"><input class="text-in" id="hgoal" type="number" inputmode="decimal" min="0" step="any" placeholder="e.g. 20" value="${esc(draft.goal)}" aria-label="Amount">
            <input class="text-in" id="hunit" maxlength="16" placeholder="pages" value="${esc(draft.unit)}" autocomplete="off" aria-label="Unit"></div>
          <p class="fnote">For habits you measure, like pages or minutes. The day counts once you reach it. Leave empty to just tick it.</p></div>
        <div class="field"><label class="flabel" for="hkinds">Kinds <em>optional</em></label>
          <input class="text-in" id="hkinds" placeholder="e.g. Walk, Jog, Run" value="${esc(draft.kinds)}" autocomplete="off">
          <p class="fnote">Separate with commas. After you tick, you can pick which one it was. Leave empty for a plain tick.</p></div>
      </div>` : ''}</div>
    ${err ? `<p class="err" role="alert">${err}</p>` : ''}
    <button class="btn-primary" type="button" data-save>${h ? 'Save changes' : 'Add habit'}</button>
    ${h ? `<div class="btn-row"><button class="btn-sm" type="button" data-archive>Archive</button>
      <button class="btn-sm danger" type="button" data-delete>${confirmDelete ? 'Tap again to delete' : 'Delete'}</button></div>
      <p class="fnote">Archive hides the habit and keeps its history. Delete removes both.</p>` : ''}`;

  // Fields under "More options" only exist while it's open; otherwise the draft keeps its values.
  const readInputs = scrim => {
    draft.name = $('#hname', scrim).value;
    ['goal', 'unit', 'kinds'].forEach(f => { const el = $('#h' + f, scrim); if (el) draft[f] = el.value; });
    if ($('#hrem', scrim)?.value) draft.reminder = $('#hrem', scrim).value;
  };

  const sheet = openSheet(body(), async (e, close, scrim) => {
    const t = e.target;
    const redraw = () => { readInputs(scrim); sheet.setBody(body()); };
    if (t.closest('[data-more]')) { more = !more; return redraw(); }
    const sg = t.closest('[data-suggest]');
    if (sg) {
      readInputs(scrim);
      Object.assign(draft, (({ label, ...x }) => x)(suggestions(draft)[Number(sg.dataset.suggest)] || {}));
      return sheet.setBody(body());
    }
    if (t.closest('[data-icon]')) { draft.icon = t.closest('[data-icon]').dataset.icon; return redraw(); }
    if (t.closest('[data-color]')) { draft.color = t.closest('[data-color]').dataset.color; return redraw(); }
    if (t.closest('[data-type]')) { draft.type = t.closest('[data-type]').dataset.type; return redraw(); }
    if (t.closest('[data-times]')) { draft.times = Math.min(6, Math.max(1, draft.times + Number(t.closest('[data-times]').dataset.times))); return redraw(); }
    if (t.closest('[data-dow]')) {
      const x = Number(t.closest('[data-dow]').dataset.dow);
      draft.days = draft.days.includes(x) ? draft.days.filter(y => y !== x) : [...draft.days, x];
      return redraw();
    }
    if (t.closest('[data-remind]')) {
      readInputs(scrim);
      if (draft.reminder) { draft.reminder = null; err = ''; return redraw(); }
      // Ask for notification permission straight from the tap: browsers only allow it then.
      const problem = await enableReminders();
      err = problem || '';
      if (!problem) draft.reminder = '20:00';
      return sheet.setBody(body());
    }
    if (busy) return;
    try {
      if (t.closest('[data-save]')) {
        readInputs(scrim);
        draft.name = draft.name.trim();
        const amount = draft.goal.trim() ? parseFloat(draft.goal) : null;
        const kinds = parseKinds(draft.kinds);
        err = !draft.name ? 'Give the habit a name.'
          : draft.type === 'days' && !draft.days.length ? 'Pick at least one day.'
          : amount !== null && !(amount > 0 && amount <= 1e6) ? 'The daily amount needs to be a number above 0.'
          : kinds.length > MAX_KINDS ? `Up to ${MAX_KINDS} kinds.` : '';
        if (err) return redraw();
        busy = true;
        const schedule = draft.type === 'days' ? { type: 'days', days: [...draft.days].sort() }
          : draft.type === 'weekly' ? { type: 'weekly', times: draft.times, days: [] } : { type: 'daily', days: [] };
        const fields = {
          name: draft.name, icon: draft.icon, color: draft.color, schedule, kinds,
          goal: amount ? { amount: Math.round(amount * 100) / 100, unit: draft.unit.trim().slice(0, 16) } : null,
          reminder: draft.reminder,
        };
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
  // Suggestions follow the name as it's typed, without redrawing the field being typed in.
  sheet.scrim.addEventListener('input', e => {
    if (e.target.id !== 'hname' && e.target.id !== 'hgoal' && e.target.id !== 'hkinds') return;
    readInputs(sheet.scrim);
    $('#more-sub', sheet.scrim).textContent = moreSub();
    const box = $('#hsuggest', sheet.scrim);
    if (box) box.innerHTML = suggestHTML();
  });
  // Enter in the name field saves.
  sheet.scrim.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.id === 'hname') { e.preventDefault(); sheet.scrim.querySelector('[data-save]').click(); }
  });
  if (!h) setTimeout(() => $('#hname', sheet.scrim)?.focus(), 60);
}
