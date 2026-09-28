// Local calendar dates as 'YYYY-MM-DD' strings. Never timestamps, never UTC:
// "did I read on Tuesday" is about the user's calendar day. Date math steps by
// calendar day (new Date(y, m, d + n)), so DST changes can't shift a day.

export const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const DAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const MON_SHORT = MONTHS.map(m => m.slice(0, 3));

const pad = n => String(n).padStart(2, '0');

export const key = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function parse(k) {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

export function today(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

export const todayKey = (now = new Date()) => key(today(now));

// Position of a date within its week, given the first day of the week (0 = Sunday).
export const weekIdx = (d, weekStart) => (d.getDay() - weekStart + 7) % 7;

export const startOfWeek = (d, weekStart) => addDays(d, -weekIdx(d, weekStart));

export const orderedDays = weekStart => [0, 1, 2, 3, 4, 5, 6].map(i => (weekStart + i) % 7);

export const isValidKey = k => typeof k === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(k) && key(parse(k)) === k;
