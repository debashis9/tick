import { todayKey, key, parse, addDays, weekIdx, startOfWeek, orderedDays, DAY_SHORT, DAY_LONG, MONTHS, MON_SHORT } from '../dates.js';
import { isDue, isWeekly, dayState, habitStats, bridge, rangeRate } from '../stats.js';
import { store, has, active, byId } from '../store.js';
import { view, $, ws, esc, cap, plural, ICON, stateLabel, toggle, monthOf, amountText } from '../ui.js';
import { openDaySheet } from '../sheets.js';

const el = () => $('#view-calendar');

function monthHead(tKey) {
  const m0 = view.cal.month, t = parse(tKey);
  const isCur = m0.getFullYear() === t.getFullYear() && m0.getMonth() === t.getMonth();
  return `<div class="panel-head"><h2>${MONTHS[m0.getMonth()]} ${m0.getFullYear()}</h2>
    <div class="pn"><button class="navbtn" type="button" data-nav="-1" aria-label="Previous month">${ICON.left}</button>
    <button class="navbtn" type="button" data-nav="1" aria-label="Next month" ${isCur ? 'disabled' : ''}>${ICON.right}</button></div></div>`;
}

function monthGridStart() {
  let out = orderedDays(ws()).map(dw => `<div class="mhead">${DAY_SHORT[dw].toUpperCase()}</div>`).join('');
  for (let i = 0; i < weekIdx(view.cal.month, ws()); i++) out += '<div></div>';
  return out;
}

// One habit: done days are filled; consecutive done days join into one bar.
function monthSingleHTML(h, tKey) {
  const m0 = view.cal.month, y = m0.getFullYear(), mo = m0.getMonth();
  const nd = new Date(y, mo + 1, 0).getDate();
  const st = d => dayState(h, d, has, tKey, ws());
  let cells = monthGridStart(), doneN = 0, dueN = 0, run = 0, bestRun = 0;
  for (let day = 1; day <= nd; day++) {
    const d = new Date(y, mo, day), k = key(d), s = st(d);
    let cls = `mc s-${s}${k === tKey ? ' is-today' : ''}`, inner = '';
    if (s === 'done') {
      doneN++; dueN++; run++; bestRun = Math.max(bestRun, run);
      const ps = day > 1 ? st(addDays(d, -1)) : null;
      const ns = day < nd ? st(addDays(d, 1)) : null;
      if (ps === 'done') cls += ' jl';
      else if (ps === 'off' || ps === 'missed') { const b = bridge(h, addDays(d, -1), has, tKey, ws()); if (b) inner += `<i class="ln l ${b}"></i>`; }
      if (ns === 'done') cls += ' jr';
      else if (ns === 'off' || ns === 'missed') { const b = bridge(h, addDays(d, 1), has, tKey, ws()); if (b) inner += `<i class="ln r ${b}"></i>`; }
      inner += '<i class="band"></i>';
    } else if (s === 'off' || s === 'missed') {
      if (s === 'missed') { dueN++; run = 0; }
      const b = bridge(h, d, has, tKey, ws());
      if (b) inner += `<i class="ln ${b}"></i>`;
    }
    const dis = s === 'future' || s === 'before';
    cells += `<button class="${cls}" type="button" data-h="${h.id}" data-date="${k}" ${dis ? 'disabled' : ''}
      aria-label="${DAY_LONG[d.getDay()]} ${day} ${MONTHS[mo]}: ${esc(h.name)}, ${stateLabel[s]}">${inner}<span class="num">${day}</span></button>`;
  }
  const summary = isWeekly(h)
    ? `<p class="summary">Done on <b>${doneN}</b> ${doneN === 1 ? 'day' : 'days'} this month. Goal: ${h.schedule.times} a week, any days.</p>`
    : dueN
    ? `<p class="summary"><b>${doneN}</b> of ${plural(dueN, 'due day')} done · longest run this month <b>${bestRun}</b></p>`
    : '<p class="summary">No due days this month yet.</p>';
  return `<div class="panel" style="--c:var(--h-${h.color})">${monthHead(tKey)}<div class="mgrid">${cells}</div>${summary}</div>
    <div class="legend" style="--c:var(--h-${h.color})"><span><i class="lg done"></i>Done</span><span><i class="lg missed"></i>${isWeekly(h) ? 'Week fell short' : 'Missed'}</span>
    <span><i class="lg dash"></i>One miss between done days</span><span><i class="lg off"></i>${isWeekly(h) ? 'Not needed' : 'Not scheduled'}</span></div>`;
}

// All habits: each day is a ring with one slice per habit that was due.
// Above six habits the slices get too thin, so the day becomes a single shaded dot.
function monthAllHTML(tKey) {
  const m0 = view.cal.month, y = m0.getFullYear(), mo = m0.getMonth();
  const nd = new Date(y, mo + 1, 0).getDate();
  const list = active(), many = list.length > 6;
  let cells = monthGridStart(), perfect = 0, dueDays = 0;
  for (let day = 1; day <= nd; day++) {
    const d = new Date(y, mo, day), k = key(d);
    if (k > tKey) {
      cells += `<button class="mc mc-all s-future" type="button" disabled><span class="num">${day}</span></button>`;
      continue;
    }
    const due = list.filter(h => isDue(h, d, has, tKey, ws()));
    const doneN = due.filter(h => has(h.id, k)).length;
    const isPerfect = due.length > 0 && doneN === due.length;
    if (due.length) dueDays++;
    if (isPerfect) perfect++;
    let svg = '', numStyle = '';
    if (due.length && many) {
      const f = doneN / due.length;
      svg = `<svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="17" fill="var(--track)"/><circle cx="20" cy="20" r="17" fill="var(--ink)" fill-opacity="${f * .85}"/></svg>`;
      if (f > .5) numStyle = ' style="color:var(--on-ink)"';
    } else if (due.length) {
      const r = 17, c = 2 * Math.PI * r, gap = due.length > 1 ? 3.4 : 0, seg = (c - gap * due.length) / due.length;
      svg = `<svg viewBox="0 0 40 40" aria-hidden="true">${due.map((h, i) =>
        `<circle cx="20" cy="20" r="${r}" fill="none" stroke-width="3.6" stroke="${has(h.id, k) ? `var(--h-${h.color})` : 'var(--track)'}"
          stroke-dasharray="${seg} ${c - seg}" stroke-dashoffset="${-i * (seg + gap)}" transform="rotate(-90 20 20)"/>`).join('')}</svg>`;
    }
    cells += `<button class="mc mc-all${isPerfect ? ' perfect' : ''}${k === tKey ? ' is-today' : ''}" type="button" data-dayall="${k}"
      aria-label="${DAY_LONG[d.getDay()]} ${day} ${MONTHS[mo]}: ${doneN} of ${due.length} done">${svg}<span class="num"${numStyle}>${day}</span></button>`;
  }
  return `<div class="panel">${monthHead(tKey)}<div class="mgrid">${cells}</div>
    <p class="summary"><b>${perfect}</b> of ${plural(dueDays, 'day')} with everything done. Tap a day to see or change it.</p></div>
    <div class="legend">${list.map(h => `<span style="--c:var(--h-${h.color})"><i class="lg done sq"></i>${esc(h.name)}</span>`).join('')}
    <span><i class="lg sq" style="background:var(--track)"></i>Due, not done</span></div>`;
}

// Habits × days of one week.
function weekHTML(h, tKey) {
  const cur = startOfWeek(parse(tKey), ws());
  const w0 = view.cal.weekOf || cur;
  const days = [0, 1, 2, 3, 4, 5, 6].map(i => addDays(w0, i));
  const isCur = key(w0) === key(cur);
  const label = `${days[0].getDate()} ${MON_SHORT[days[0].getMonth()]} – ${days[6].getDate()} ${MON_SHORT[days[6].getMonth()]}`;
  const list = h ? [h] : active();
  let grid = '<div></div>' + days.map(d => `<div class="dh${key(d) === tKey ? ' is-today' : ''}">${DAY_SHORT[d.getDay()]}<b>${d.getDate()}</b></div>`).join('');
  let done = 0, due = 0;
  list.forEach(hb => {
    grid += `<div class="hn"><span class="e" aria-hidden="true">${esc(hb.icon)}</span><span class="t">${esc(hb.name)}</span></div>`;
    grid += days.map(d => {
      const s = dayState(hb, d, has, tKey, ws());
      if (s === 'done') { done++; due++; } else if (s === 'missed' || s === 'pending') due++;
      const dis = s === 'future' || s === 'before';
      return `<button class="wc s-${s}" type="button" style="--c:var(--h-${hb.color})" data-h="${hb.id}" data-date="${key(d)}" ${dis ? 'disabled' : ''}
        aria-label="${DAY_LONG[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}: ${esc(hb.name)}, ${stateLabel[s]}">${s === 'done' ? ICON.check : ''}</button>`;
    }).join('');
  });
  const c = (h || list[0] || { color: 'slate' }).color;
  return `<div class="panel"><div class="panel-head"><h2>${isCur ? 'This week' : label}</h2>
    <div class="pn"><button class="navbtn" type="button" data-wnav="-1" aria-label="Previous week">${ICON.left}</button>
    <button class="navbtn" type="button" data-wnav="1" aria-label="Next week" ${isCur ? 'disabled' : ''}>${ICON.right}</button></div></div>
    ${list.length ? `<div class="wk">${grid}</div>` : '<p class="summary">No habits to show.</p>'}
    <p class="summary"><b>${done}</b> of ${plural(due, 'tick')}${isCur ? ' so far this week' : ''}. Tap any past day to fix it.</p></div>
    <div class="legend" style="--c:var(--h-${c})"><span><i class="lg done sq round"></i>Done</span>
    <span><i class="lg missed round"></i>Missed</span><span><i class="lg dot"></i>Not scheduled</span></div>`;
}

// The last 53 weeks as a heatmap.
function yearHTML(h, tKey) {
  const endW = startOfWeek(parse(tKey), ws()), startW = addDays(endW, -52 * 7);
  const list = active();
  const lv = [0, 22, 42, 66, 92];
  const shade = l => l === 0 ? 'var(--track)' : `color-mix(in oklch, var(--ink) ${lv[l]}%, var(--surface))`;
  let out = '<div></div>' + [0, 1, 2, 3, 4, 5, 6].map(i => `<div class="yl">${i % 2 === 0 && i < 6 ? DAY_SHORT[(ws() + i) % 7] : ''}</div>`).join('');
  let total = 0;
  for (let w = 0; w <= 52; w++) {
    const w0 = addDays(startW, w * 7);
    let label = '';
    for (let i = 0; i < 7; i++) { const d = addDays(w0, i); if (d.getDate() === 1) label = MON_SHORT[d.getMonth()]; }
    out += `<div class="ym">${label}</div>`;
    for (let i = 0; i < 7; i++) {
      const d = addDays(w0, i), k = key(d);
      if (k > tKey) { out += '<span class="yc"></span>'; continue; }
      let bg = 'transparent', lab;
      if (h) {
        const s = dayState(h, d, has, tKey, ws());
        bg = s === 'done' ? 'var(--c)' : s === 'missed' ? 'var(--track)' : s === 'off' ? 'var(--off)' : 'transparent';
        if (s === 'done') total++;
        lab = stateLabel[s];
      } else {
        const due = list.filter(x => isDue(x, d, has, tKey, ws()));
        const dn = due.filter(x => has(x.id, k)).length;
        if (due.length) {
          const f = dn / due.length;
          if (f === 1) total++;
          bg = shade(f === 0 ? 0 : f < .34 ? 1 : f < .67 ? 2 : f < 1 ? 3 : 4);
        }
        lab = `${dn} of ${due.length} done`;
      }
      out += `<button class="yc" type="button" style="--y:${bg}" data-jump="${k}" aria-label="${d.getDate()} ${MONTHS[d.getMonth()]}: ${lab}"></button>`;
    }
  }
  const legend = h
    ? '<span><i class="lg sq done"></i>Done</span><span><i class="lg sq" style="background:var(--track)"></i>Missed</span><span><i class="lg sq off"></i>Not scheduled</span>'
    : `<span>Less</span>${[0, 1, 2, 3, 4].map(l => `<i class="lg sq" style="background:${shade(l)}"></i>`).join('')}<span>More</span>`;
  const cvar = h ? `style="--c:var(--h-${h.color})"` : '';
  return `<div class="panel" ${cvar}><div class="panel-head"><h2>Last 12 months</h2></div>
    <div class="ywrap" id="ywrap"><div class="ygrid">${out}</div></div>
    <p class="summary">${h ? `Done on <b>${total}</b> ${total === 1 ? 'day' : 'days'} in the last 12 months.` : `<b>${total}</b> ${total === 1 ? 'day' : 'days'} with everything done in the last 12 months.`} Tap a square to open its month.</p></div>
    <div class="legend" ${cvar}>${legend}</div>`;
}

// Amount totals for quantity habits and a count per kind, over the last 30 days.
function detailHTML(h, tKey) {
  const from = key(addDays(parse(tKey), -29)), parts = [];
  let recent = 0, total = 0;
  const kinds = new Map(h.kinds.map(x => [x, 0]));
  for (const [c, e] of store.entries) {
    if (!c.startsWith(h.id + '|')) continue;
    const k = c.slice(h.id.length + 1), isRecent = k >= from;
    if (h.goal && e.amount) { total += e.amount; if (isRecent) recent += e.amount; }
    if (isRecent && e.kind && has(h.id, k)) kinds.set(e.kind, (kinds.get(e.kind) || 0) + 1);
  }
  if (h.goal) parts.push(`<span><b>${esc(amountText(h, recent))}</b> in the last 30 days</span><span><b>${esc(amountText(h, total))}</b> since you started</span>`);
  if ([...kinds.values()].some(Boolean)) parts.push(`<span>Last 30 days: ${[...kinds].filter(([, n]) => n).map(([x, n]) => `${esc(x)} <b>${n}</b>`).join(' · ')}</span>`);
  return parts.length ? `<p class="detail">${parts.join('')}</p>` : '';
}

function statsHTML(h, tKey) {
  const st = habitStats(h, has, tKey, ws()), wk = st.unit === 'week';
  return `<div class="stats" style="--c:var(--h-${h.color})">
    <div><b>${st.strength}%</b><span>Strength</span><div class="meter"><i style="width:${st.strength}%"></i></div></div>
    <div><b>${st.streak}</b><span>${wk ? 'Weeks in a row' : 'Current run'}</span></div>
    <div><b>${st.best}</b><span>${wk ? 'Best, in weeks' : 'Best run'}</span></div>
    <div><b>${st.rate}%</b><span>${wk ? 'Recent weeks' : 'Last 30 days'}</span></div></div>
    ${detailHTML(h, tKey)}
    <p class="explain">${wk
    ? `A week counts once you tick ${h.schedule.times} of its days. Strength weights recent weeks most, so one short week only lowers it a little.`
    : 'Strength counts every tick since you started, with recent days weighted most. A single missed day only lowers it a little.'}</p>`;
}

function barsHTML(h, tKey) {
  const cur = startOfWeek(parse(tKey), ws());
  let bars = '', xs = '';
  for (let i = 11; i >= 0; i--) {
    const w0 = addDays(cur, -7 * i);
    const r = rangeRate(h, w0, addDays(w0, 6), has, tKey, ws());
    bars += `<div class="bar${i === 0 ? ' cur' : ''}${r.due ? '' : ' none'}" style="height:${r.pct}%" title="Week of ${w0.getDate()} ${MON_SHORT[w0.getMonth()]}: ${r.done} of ${r.due} (${r.pct}%)"></div>`;
    xs += `<span>${i === 0 ? 'Now' : i % 4 === 3 ? `${w0.getDate()} ${MON_SHORT[w0.getMonth()]}` : ''}</span>`;
  }
  return `<div class="panel chart" style="--c:var(--h-${h.color})"><div class="panel-head"><h2>Weekly completion</h2></div>
    <div class="plot"><div class="gl" style="top:0"><span>100%</span></div><div class="gl" style="top:50%"><span>50%</span></div><div class="gl" style="top:100%"><span>0%</span></div>
    <div class="bars">${bars}</div></div><div class="bars-x">${xs}</div></div>`;
}

export function renderCalendar() {
  const tKey = todayKey();
  view.cal.month ||= monthOf(parse(tKey));
  let h = view.cal.filter === 'all' ? null : byId(view.cal.filter);
  if (view.cal.filter !== 'all' && (!h || h.archivedOn)) { view.cal.filter = 'all'; h = null; }
  const chip = (id, label, icon) => `<button class="chip" type="button" data-filter="${id}" aria-pressed="${view.cal.filter === id}">
    ${icon ? `<span aria-hidden="true">${esc(icon)}</span>` : ''}${esc(label)}</button>`;
  const z = view.cal.zoom;
  const body = z === 'week' ? weekHTML(h, tKey) : z === 'year' ? yearHTML(h, tKey) : h ? monthSingleHTML(h, tKey) : monthAllHTML(tKey);
  el().innerHTML = `
    <header class="head"><div><div class="eyebrow">History</div><h1>Calendar</h1></div></header>
    <div class="seg" role="group" aria-label="Time range">${['week', 'month', 'year'].map(x =>
      `<button type="button" data-zoom="${x}" aria-pressed="${z === x}">${cap(x)}</button>`).join('')}</div>
    <div class="chips" role="group" aria-label="Habits">${chip('all', 'All habits')}${active().map(x => chip(x.id, x.name, x.icon)).join('')}</div>
    ${h ? statsHTML(h, tKey) : ''}
    ${body}
    ${h ? barsHTML(h, tKey) : ''}`;
  const yw = $('#ywrap');
  if (yw) yw.scrollLeft = yw.scrollWidth;
}

export function bindCalendar() {
  el().addEventListener('click', e => {
    const t = e.target;
    const z = t.closest('[data-zoom]');
    if (z) { view.cal.zoom = z.dataset.zoom; return renderCalendar(); }
    const f = t.closest('[data-filter]');
    if (f) { view.cal.filter = f.dataset.filter; return renderCalendar(); }
    const n = t.closest('[data-nav]');
    if (n) { const m = view.cal.month; view.cal.month = new Date(m.getFullYear(), m.getMonth() + Number(n.dataset.nav), 1); return renderCalendar(); }
    const wn = t.closest('[data-wnav]');
    if (wn) { view.cal.weekOf = addDays(view.cal.weekOf || startOfWeek(parse(todayKey()), ws()), 7 * Number(wn.dataset.wnav)); return renderCalendar(); }
    const j = t.closest('[data-jump]');
    if (j) { view.cal.month = monthOf(parse(j.dataset.jump)); view.cal.zoom = 'month'; return renderCalendar(); }
    const da = t.closest('[data-dayall]');
    if (da) return openDaySheet(da.dataset.dayall);
    const c = t.closest('[data-h][data-date]');
    if (c && !c.disabled) { toggle(byId(c.dataset.h), c.dataset.date); renderCalendar(); }
  });
}
