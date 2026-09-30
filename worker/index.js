// The Tick Worker. The app itself is static files (served straight from assets); this code
// only runs for /api/* and for the once-a-minute cron that sends reminders.
//
// What it stores, per device that turned on reminders: the push address, reminder times with
// their weekdays, the time zone, and when each time was last sent. Nothing about habits or ticks.

import { DurableObject } from 'cloudflare:workers';
import { validEndpoint, validTimeZone, cleanSlots, localTime, dueSlots, vapidAuth, sendPush } from './webpush.js';

const MAX_DEVICES = 5000;
const MAX_PER_RUN = 45;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// All subscriptions live in one Durable Object (SQLite). Plenty for a few thousand devices.
export class Reminders extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS subs (
      endpoint TEXT PRIMARY KEY, tz TEXT NOT NULL, slots TEXT NOT NULL, sent TEXT NOT NULL DEFAULT '{}',
      subject TEXT NOT NULL, tested INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL)`);
  }

  save({ endpoint, tz, slots, subject }) {
    const exists = this.sql.exec('SELECT 1 FROM subs WHERE endpoint = ?', endpoint).toArray().length;
    if (!exists && this.sql.exec('SELECT COUNT(*) AS n FROM subs').one().n >= MAX_DEVICES) return false;
    this.sql.exec(`INSERT INTO subs (endpoint, tz, slots, subject, updated) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET tz = excluded.tz, slots = excluded.slots, subject = excluded.subject, updated = excluded.updated`,
    endpoint, tz, JSON.stringify(slots), subject, Date.now());
    return true;
  }

  remove(endpoint) {
    this.sql.exec('DELETE FROM subs WHERE endpoint = ?', endpoint);
  }

  async #push(row) {
    const result = await sendPush(row.endpoint, await vapidAuth(row.endpoint, this.#jwk(), row.subject));
    if (result === 'gone') this.remove(row.endpoint);
    return result;
  }

  #key;
  #jwk() {
    return this.#key ||= JSON.parse(this.env.VAPID_JWK);
  }

  // A push right now, at most one every 20 seconds per device.
  async test(endpoint) {
    const row = this.sql.exec('SELECT * FROM subs WHERE endpoint = ?', endpoint).toArray()[0];
    if (!row) return 'unknown';
    if (Date.now() - row.tested < 20e3) return 'busy';
    this.sql.exec('UPDATE subs SET tested = ? WHERE endpoint = ?', Date.now(), endpoint);
    return this.#push(row);
  }

  // Called every minute by the cron trigger. Sends at most MAX_PER_RUN pushes (the free plan
  // allows about 50 outgoing requests per run). The rest aren't marked as sent, so they go out
  // over the next minutes: a reminder stays due for 30 minutes after its time.
  async run(now = new Date()) {
    const rows = this.sql.exec('SELECT * FROM subs').toArray();
    const jobs = [];
    for (const row of rows) {
      if (jobs.length >= MAX_PER_RUN) break;
      const local = localTime(row.tz, now);
      const sent = JSON.parse(row.sent);
      const due = dueSlots(JSON.parse(row.slots), sent, local);
      if (!due.length) continue;
      due.forEach(t => { sent[t] = local.date; });
      this.sql.exec('UPDATE subs SET sent = ? WHERE endpoint = ?', JSON.stringify(sent), row.endpoint);
      jobs.push(this.#push(row).catch(e => console.warn('push error', e)));
    }
    await Promise.all(jobs);
    return jobs.length;
  }
}

const reminders = env => env.REMINDERS.get(env.REMINDERS.idFromName('all'));

async function api(request, env, url) {
  if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
  // Only the app itself may call the API.
  if (request.headers.get('origin') !== url.origin) return json({ error: 'Wrong origin' }, 403);
  if (!env.VAPID_JWK) return json({ error: 'Reminders are not set up on this server' }, 503);
  const text = await request.text();
  if (text.length > 4096) return json({ error: 'Too large' }, 413);
  let body;
  try { body = JSON.parse(text); } catch { return json({ error: 'Bad JSON' }, 400); }
  if (!validEndpoint(body?.endpoint)) return json({ error: 'Unsupported push service' }, 400);
  const r = reminders(env);

  if (url.pathname === '/api/push/subscribe') {
    const slots = cleanSlots(body.slots);
    if (!slots || !validTimeZone(body.tz)) return json({ error: 'Bad reminder times' }, 400);
    const ok = await r.save({ endpoint: body.endpoint, tz: body.tz, slots, subject: url.origin });
    return ok ? new Response(null, { status: 204 }) : json({ error: 'Full' }, 507);
  }
  if (url.pathname === '/api/push/unsubscribe') {
    await r.remove(body.endpoint);
    return new Response(null, { status: 204 });
  }
  if (url.pathname === '/api/push/test') {
    const result = await r.test(body.endpoint);
    return result === 'sent' ? new Response(null, { status: 204 }) : json({ error: result }, result === 'busy' ? 429 : 400);
  }
  return json({ error: 'Not found' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return api(request, env, url);
    return env.ASSETS.fetch(request);
  },
  async scheduled(event, env, ctx) {
    if (env.VAPID_JWK) ctx.waitUntil(reminders(env).run(new Date(event.scheduledTime)));
  },
};
