// Web Push without a payload: just a signed "wake up" to the browser's push service. With no
// payload there's nothing to encrypt, and nothing about the user's habits leaves their device.
// Pure functions (Web Crypto + Intl only), so Node can unit-test them.

const enc = new TextEncoder();
export const b64u = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));

// Push services Tick will send to. Anything else is refused, so the Worker can't be used to
// send requests to arbitrary URLs.
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /\.notify\.windows\.com$/];

export function validEndpoint(s) {
  if (typeof s !== 'string' || s.length > 1024) return false;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' && PUSH_HOSTS.some(re => re.test(u.hostname));
  } catch { return false; }
}

export function validTimeZone(tz) {
  if (typeof tz !== 'string' || tz.length > 64) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

// [{ t: 'HH:MM', days: [0–6] }], at most one per minute of the day that's used.
export function cleanSlots(slots) {
  if (!Array.isArray(slots) || !slots.length || slots.length > 24) return null;
  const out = [];
  for (const s of slots) {
    if (!s || typeof s.t !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.t)) return null;
    if (!Array.isArray(s.days) || !s.days.length || s.days.some(d => !Number.isInteger(d) || d < 0 || d > 6)) return null;
    out.push({ t: s.t, days: [...new Set(s.days)].sort() });
  }
  return out;
}

const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// The wall-clock date, minute of the day and weekday in a time zone.
export function localTime(tz, now) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short',
  }).formatToParts(now).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute), dow: DOW[p.weekday] };
}

// Slots to send now: due today, their time has come in the last `windowMin` minutes (so a late
// or skipped cron run still sends), and not already sent today.
export function dueSlots(slots, sent, local, windowMin = 30) {
  return slots.filter(s => {
    const m = Number(s.t.slice(0, 2)) * 60 + Number(s.t.slice(3));
    return s.days.includes(local.dow) && local.minutes >= m && local.minutes < m + windowMin && sent[s.t] !== local.date;
  }).map(s => s.t);
}

// The Authorization header for one push service (RFC 8292). `jwk` is the private P-256 key.
export async function vapidAuth(endpoint, jwk, subject, now = Date.now()) {
  const key = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d },
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const part = o => b64u(enc.encode(JSON.stringify(o)));
  const unsigned = part({ typ: 'JWT', alg: 'ES256' }) + '.'
    + part({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject });
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(unsigned));
  const pub = b64u(new Uint8Array([4, ...unb64u(jwk.x), ...unb64u(jwk.y)]));
  return `vapid t=${unsigned}.${b64u(sig)}, k=${pub}`;
}

// Returns 'sent', 'gone' (the subscription no longer exists: forget it) or 'failed'.
export async function sendPush(endpoint, auth) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: auth, TTL: '3600', Urgency: 'high', Topic: 'tick-reminder' },
    body: '',
  });
  if (res.ok) return 'sent';
  if (res.status === 404 || res.status === 410) return 'gone';
  console.warn('push failed', res.status, new URL(endpoint).hostname, await res.text().catch(() => ''));
  return 'failed';
}
