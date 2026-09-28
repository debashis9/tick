// Pure functions over a habit and a `has(habitId, dateKey)` lookup. No storage, no DOM,
// so they can be unit-tested in Node.

import { key, parse, addDays } from './dates.js';

export function isScheduled(h, d) {
  if (key(d) < h.createdOn) return false;
  return h.schedule.type === 'daily' || h.schedule.days.includes(d.getDay());
}

// done | missed | off (not scheduled) | pending (today, not done yet) | future | before (habit didn't exist)
export function dayState(h, d, has, tKey) {
  const k = key(d);
  if (k > tKey) return 'future';
  if (k < h.createdOn) return 'before';
  if (has(h.id, k)) return 'done';
  if (!isScheduled(h, d)) return 'off';
  return k === tKey ? 'pending' : 'missed';
}

// Strength: exponential smoothing over due days, as in Loop Habit Tracker.
// Each done day: score = score·m + (1 − m). Each missed day: score = score·m.
// m = 0.5^(1/13) gives a half-life of about 13 due days, so one miss dents the
// score instead of zeroing it.
export const STRENGTH_M = Math.pow(0.5, 1 / 13);

export function habitStats(h, has, tKey) {
  const end = parse(tKey);
  let score = 0, run = 0, best = 0;
  for (let d = parse(h.createdOn); d <= end; d = addDays(d, 1)) {
    const s = dayState(h, d, has, tKey);
    if (s === 'done') { score = score * STRENGTH_M + (1 - STRENGTH_M); run++; if (run > best) best = run; }
    else if (s === 'missed') { score *= STRENGTH_M; run = 0; }
    // off and pending leave the run alone: a Mon/Wed/Fri habit isn't broken by Tuesday,
    // and today isn't a miss until it's over.
  }
  let done = 0, due = 0;
  for (let i = 0; i < 30; i++) {
    const s = dayState(h, addDays(end, -i), has, tKey);
    if (s === 'done') { done++; due++; } else if (s === 'missed') due++;
  }
  return { strength: Math.round(score * 100), streak: run, best, rate: due ? Math.round(done / due * 100) : 0 };
}

// For a non-done day inside a gap between two done days: 'thin' if the gap has no
// misses (only unscheduled days), 'dash' if it has exactly one miss (never miss twice),
// null otherwise. Drives the connectors in the month chain view.
export function bridge(h, d, has, tKey) {
  let miss = 0, x = d, sx;
  for (;;) {
    sx = dayState(h, x, has, tKey);
    if (sx === 'missed') miss++; else if (sx !== 'off') break;
    if (miss > 1) return null;
    x = addDays(x, -1);
  }
  if (sx !== 'done') return null;
  let y = addDays(d, 1), sy;
  for (;;) {
    sy = dayState(h, y, has, tKey);
    if (sy === 'missed') miss++; else if (sy !== 'off') break;
    if (miss > 1) return null;
    y = addDays(y, 1);
  }
  if (sy !== 'done') return null;
  return miss === 0 ? 'thin' : 'dash';
}

export function dayProgress(habits, k, has) {
  const d = parse(k);
  const due = habits.filter(h => isScheduled(h, d));
  return { done: due.filter(h => has(h.id, k)).length, total: due.length };
}

// Completion for the days in [from, to]: done ÷ (done + missed). Pending today isn't counted.
export function rangeRate(h, from, to, has, tKey) {
  let done = 0, due = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const s = dayState(h, d, has, tKey);
    if (s === 'done') { done++; due++; } else if (s === 'missed') due++;
  }
  return { done, due, pct: due ? Math.round(done / due * 100) : 0 };
}
