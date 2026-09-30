// Pure functions over a habit and a `has(habitId, dateKey)` lookup. No storage, no DOM,
// so they can be unit-tested in Node. `ws` is the first day of the week (0 = Sunday); it
// only matters for "N times a week" habits, which are judged per week.

import { key, parse, addDays, startOfWeek } from './dates.js';

export const isWeekly = h => h.schedule.type === 'weekly';

// Could the habit be done on this day? Weekly habits can be done on any day.
export function isScheduled(h, d) {
  if (key(d) < h.createdOn) return false;
  return h.schedule.type !== 'days' || h.schedule.days.includes(d.getDay());
}

// Ticks in the week that contains d.
export function weekCount(h, d, has, ws = 1) {
  const w0 = startOfWeek(d, ws);
  let n = 0;
  for (let i = 0; i < 7; i++) if (has(h.id, key(addDays(w0, i)))) n++;
  return n;
}

// done | missed | off (not needed) | pending (today, not done yet) | future | before (habit didn't exist)
// A weekly habit's undone days are 'off' once the week's target is met or while the week is
// still running, and 'missed' only when a whole week ended short of its target.
export function dayState(h, d, has, tKey, ws = 1) {
  const k = key(d);
  if (k > tKey) return 'future';
  if (k < h.createdOn) return 'before';
  if (has(h.id, k)) return 'done';
  if (isWeekly(h)) {
    if (weekCount(h, d, has, ws) >= h.schedule.times) return 'off';
    if (k === tKey) return 'pending';
    // The first week only counts if the habit existed for all of it.
    const w0 = startOfWeek(d, ws);
    return key(addDays(w0, 6)) < tKey && key(w0) >= h.createdOn ? 'missed' : 'off';
  }
  if (!isScheduled(h, d)) return 'off';
  return k === tKey ? 'pending' : 'missed';
}

// Counts toward that day's progress: scheduled days, and for weekly habits the days that were
// done, are still needed today, or belong to a week that fell short.
export function isDue(h, d, has, tKey, ws = 1) {
  if (!isWeekly(h)) return isScheduled(h, d);
  const s = dayState(h, d, has, tKey, ws);
  return s === 'done' || s === 'pending' || s === 'missed';
}

// Strength: exponential smoothing over due days, as in Loop Habit Tracker.
// Each done day: score = score·m + (1 − m). Each missed day: score = score·m.
// m = 0.5^(1/13) gives a half-life of about 13 due days, so one miss dents the
// score instead of zeroing it. Weekly habits step once per week, half-life 4 weeks.
export const STRENGTH_M = Math.pow(0.5, 1 / 13);
export const STRENGTH_MW = Math.pow(0.5, 1 / 4);

export function habitStats(h, has, tKey, ws = 1) {
  if (isWeekly(h)) return weeklyStats(h, has, tKey, ws);
  const end = parse(tKey);
  let score = 0, run = 0, best = 0;
  for (let d = parse(h.createdOn); d <= end; d = addDays(d, 1)) {
    const s = dayState(h, d, has, tKey, ws);
    if (s === 'done') { score = score * STRENGTH_M + (1 - STRENGTH_M); run++; if (run > best) best = run; }
    else if (s === 'missed') { score *= STRENGTH_M; run = 0; }
    // off and pending leave the run alone: a Mon/Wed/Fri habit isn't broken by Tuesday,
    // and today isn't a miss until it's over.
  }
  let done = 0, due = 0;
  for (let i = 0; i < 30; i++) {
    const s = dayState(h, addDays(end, -i), has, tKey, ws);
    if (s === 'done') { done++; due++; } else if (s === 'missed') due++;
  }
  return { strength: Math.round(score * 100), streak: run, best, rate: due ? Math.round(done / due * 100) : 0, unit: 'day' };
}

// One result per week since the habit started: true (target met), false (fell short), or
// null (not judged yet: the current week, or the first partial week, while short of target).
export function weekResults(h, has, tKey, ws = 1) {
  const cur = startOfWeek(parse(tKey), ws), first = startOfWeek(parse(h.createdOn), ws);
  const out = [];
  for (let w0 = first; w0 <= cur; w0 = addDays(w0, 7)) {
    const met = weekCount(h, w0, has, ws) >= h.schedule.times;
    const judged = met || (w0 < cur && key(w0) >= h.createdOn);
    out.push({ start: w0, met: judged ? met : null });
  }
  return out;
}

function weeklyStats(h, has, tKey, ws) {
  const weeks = weekResults(h, has, tKey, ws);
  let score = 0, run = 0, best = 0;
  for (const { met } of weeks) {
    if (met === true) { score = score * STRENGTH_MW + (1 - STRENGTH_MW); run++; if (run > best) best = run; }
    else if (met === false) { score *= STRENGTH_MW; run = 0; }
  }
  const recent = weeks.slice(-5).filter(w => w.met !== null);
  const met = recent.filter(w => w.met).length;
  return { strength: Math.round(score * 100), streak: run, best, rate: recent.length ? Math.round(met / recent.length * 100) : 0, unit: 'week' };
}

// For a non-done day inside a gap between two done days: 'thin' if the gap has no
// misses (only unscheduled days), 'dash' if it has exactly one miss (never miss twice),
// null otherwise. Drives the connectors in the month chain view.
export function bridge(h, d, has, tKey, ws = 1) {
  let miss = 0, x = d, sx;
  for (;;) {
    sx = dayState(h, x, has, tKey, ws);
    if (sx === 'missed') miss++; else if (sx !== 'off') break;
    if (miss > 1) return null;
    x = addDays(x, -1);
  }
  if (sx !== 'done') return null;
  let y = addDays(d, 1), sy;
  for (;;) {
    sy = dayState(h, y, has, tKey, ws);
    if (sy === 'missed') miss++; else if (sy !== 'off') break;
    if (miss > 1) return null;
    y = addDays(y, 1);
  }
  if (sy !== 'done') return null;
  return miss === 0 ? 'thin' : 'dash';
}

export function dayProgress(habits, k, has, tKey, ws = 1) {
  const d = parse(k);
  const due = habits.filter(h => isDue(h, d, has, tKey, ws));
  return { done: due.filter(h => has(h.id, k)).length, total: due.length };
}

// Completion for the days in [from, to]: done ÷ (done + missed). Pending today isn't counted.
// Weekly habits: ticks toward the target in each week of the range (capped at the target).
export function rangeRate(h, from, to, has, tKey, ws = 1) {
  let done = 0, due = 0;
  if (isWeekly(h)) {
    for (let w0 = startOfWeek(from, ws); w0 <= to; w0 = addDays(w0, 7)) {
      if (key(w0) > tKey || key(addDays(w0, 6)) < h.createdOn) continue;
      done += Math.min(weekCount(h, w0, has, ws), h.schedule.times);
      due += h.schedule.times;
    }
  } else {
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const s = dayState(h, d, has, tKey, ws);
      if (s === 'done') { done++; due++; } else if (s === 'missed') due++;
    }
  }
  return { done, due, pct: due ? Math.round(done / due * 100) : 0 };
}
