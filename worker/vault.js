// Encrypted cloud backup: /api/vault and /api/sync, the same code as Sol's Worker; and
// /api/admin/stats for the app's admin page, the same as Pie's.
//
// What it stores, per vault: an id, the SHA-256 of the vault's auth secret, and encrypted
// records ({ id, seq, iv, ct }). Record ids are opaque, and everything else (habit names, dates,
// ticks, amounts) is inside the ciphertext. It can't decrypt anything: the key never leaves
// people's devices.
//
// This file imports nothing from Cloudflare, so Node can load it for the tests and for
// tools/invite.mjs (index.js can't be loaded there: it imports cloudflare:workers).

const QUOTA = 25 * 1024 * 1024;   // bytes of ciphertext per vault (decades of ticks)
const MAX_BATCH = 500;            // records per push
const PAGE = 500;                 // records per pull
const MAX_CT = 96 * 1024;         // one record, encrypted
const MAX_BODY = 8 * 1024 * 1024;

const ID = /^[A-Za-z0-9_-]{22}$/;
const HASH = /^[0-9a-f]{64}$/;
const IV = /^[A-Za-z0-9_-]{16}$/;
const B64U = /^[A-Za-z0-9_-]+$/;

const HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS });
const fail = (status, error) => json({ error }, status);

const enc = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha256hex = async s => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function sameString(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// Invite tokens are `payload.signature`, signed with INVITE_SECRET. Nothing is stored: the
// Worker only checks the signature and the expiry. Without INVITE_SECRET, anyone can create a
// vault (fine for local development).
async function hmac(secret, s) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(await crypto.subtle.sign('HMAC', key, enc.encode(s)));
}
export async function signInvite(secret, payload) {
  const p = b64u(enc.encode(JSON.stringify(payload)));
  return p + '.' + await hmac(secret, p);
}
export async function validInvite(token, secret, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 400 || !/^[\w-]+\.[\w-]+$/.test(token)) return false;
  const [p, sig] = token.split('.');
  if (!sameString(await hmac(secret, p), sig)) return false;
  const { exp } = JSON.parse(atob(p.replace(/-/g, '+').replace(/_/g, '/')));
  return !exp || exp > now;
}

// "Authorization: Bearer <vaultId>.<authSecret>" → the vault's id, or null.
async function authorize(request, db) {
  const m = /^Bearer ([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/.exec(request.headers.get('authorization') || '');
  if (!m) return null;
  const row = await db.prepare('SELECT auth_hash FROM vaults WHERE id = ?').bind(m[1]).first();
  return row && sameString(row.auth_hash, await sha256hex(m[2])) ? m[1] : null;
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) return { tooBig: true };
  try { return { body: JSON.parse(text) }; } catch { return {}; }
}

async function createVault(request, env) {
  const { body, tooBig } = await readJson(request);
  if (tooBig) return fail(413, 'too_large');
  if (!body || !ID.test(body.vaultId) || !HASH.test(body.authHash)) return fail(400, 'bad_request');
  const existing = await env.DB.prepare('SELECT auth_hash FROM vaults WHERE id = ?').bind(body.vaultId).first();
  // Same key again (a retry, or turning backup back on): nothing to do.
  if (existing) return sameString(existing.auth_hash, body.authHash) ? json({ created: false }) : fail(409, 'exists');
  if (env.INVITE_SECRET) {
    let ok = false;
    try { ok = await validInvite(body.invite, env.INVITE_SECRET); } catch { ok = false; }
    if (!ok) return fail(403, 'invite_required');
  }
  await env.DB.prepare('INSERT INTO vaults (id, auth_hash, next_seq, bytes, created_at, used_at) VALUES (?, ?, 1, 0, ?, ?)')
    .bind(body.vaultId, body.authHash, Date.now(), Date.now()).run();
  return json({ created: true }, 201);
}

async function pull(vault, url, env) {
  const since = Math.max(0, Number.parseInt(url.searchParams.get('since') || '0', 10) || 0);
  const { results } = await env.DB.prepare('SELECT id, seq, iv, ct FROM records WHERE vault = ? AND seq > ? ORDER BY seq LIMIT ?')
    .bind(vault, since, PAGE + 1).all();
  const more = results.length > PAGE;
  const records = results.slice(0, PAGE);
  return json({ records, cursor: records.length ? records.at(-1).seq : since, more });
}

async function push(vault, request, env) {
  const { body, tooBig } = await readJson(request);
  if (tooBig) return fail(413, 'too_large');
  const records = body?.records;
  if (!Array.isArray(records) || records.length > MAX_BATCH) return fail(400, 'bad_request');
  const seen = new Set();
  for (const r of records) {
    if (!r || !ID.test(r.id) || !IV.test(r.iv) || typeof r.ct !== 'string' || !B64U.test(r.ct) || r.ct.length > MAX_CT || seen.has(r.id)) return fail(400, 'bad_request');
    seen.add(r.id);
  }
  if (!records.length) return json({ stored: 0 });
  const v = await env.DB.prepare('SELECT bytes FROM vaults WHERE id = ?').bind(vault).first();
  const incoming = records.reduce((n, r) => n + r.iv.length + r.ct.length, 0);
  if (v.bytes + incoming > QUOTA) return fail(413, 'quota');

  // One transaction: reserve n sequence numbers, then write each record with its own. Commit
  // order and sequence order are the same, so a device that has pulled up to seq N has seen
  // everything at or below N.
  const n = records.length;
  const stmts = [env.DB.prepare('UPDATE vaults SET next_seq = next_seq + ?, used_at = ? WHERE id = ?').bind(n, Date.now(), vault)];
  records.forEach((r, i) => stmts.push(env.DB.prepare(
    `INSERT INTO records (vault, id, seq, iv, ct) VALUES (?, ?, (SELECT next_seq FROM vaults WHERE id = ?) - ?, ?, ?)
     ON CONFLICT (vault, id) DO UPDATE SET seq = excluded.seq, iv = excluded.iv, ct = excluded.ct`,
  ).bind(vault, r.id, vault, n - i, r.iv, r.ct)));
  stmts.push(env.DB.prepare('UPDATE vaults SET bytes = (SELECT COALESCE(SUM(LENGTH(iv) + LENGTH(ct)), 0) FROM records WHERE vault = ?) WHERE id = ?').bind(vault, vault));
  await env.DB.batch(stmts);
  return json({ stored: n });
}

async function destroy(vault, env) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM records WHERE vault = ?').bind(vault),
    env.DB.prepare('DELETE FROM vaults WHERE id = ?').bind(vault),
  ]);
  return new Response(null, { status: 204, headers: HEADERS });
}

// The admin page of the app (as in Pie). The admin key is INVITE_SECRET itself: whoever can
// make invites runs the place. All there is to see is how many backups exist and how big they
// are; what's in them is as unreadable here as anywhere else on the server.
async function admin(request, url, env) {
  if (!env.INVITE_SECRET) return fail(503, 'no_admin');
  const m = /^Bearer admin\.(.{1,200})$/.exec(request.headers.get('authorization') || '');
  // Hashes are compared, so the time taken says nothing about the key or its length.
  if (!m || !sameString(await sha256hex(m[1]), await sha256hex(env.INVITE_SECRET))) return fail(401, 'unauthorized');
  if (request.method !== 'GET' || url.pathname !== '/api/admin/stats') return fail(404, 'not_found');
  const totals = await env.DB.prepare('SELECT COUNT(*) AS vaults, COALESCE(SUM(bytes), 0) AS bytes FROM vaults').first();
  const records = await env.DB.prepare('SELECT COUNT(*) AS n FROM records').first();
  const { results } = await env.DB.prepare(
    `SELECT v.id, v.bytes, v.created_at, v.used_at, (SELECT COUNT(*) FROM records r WHERE r.vault = v.id) AS records
     FROM vaults v ORDER BY v.used_at DESC LIMIT 100`).all();
  return json({
    vaults: totals.vaults, bytes: totals.bytes, records: records.n, quota: QUOTA,
    // A short prefix is enough to tell backups apart on the page; the full id stays on the server.
    list: results.map(v => ({ id: v.id.slice(0, 6), bytes: v.bytes, records: v.records, createdAt: v.created_at, usedAt: v.used_at })),
  });
}

export async function api(request, env) {
  const url = new URL(request.url);
  if (!env.DB) return fail(503, 'not_configured');
  try {
    if (url.pathname.startsWith('/api/admin/')) return await admin(request, url, env);
    if (url.pathname === '/api/vault' && request.method === 'POST') return await createVault(request, env);
    const route = `${request.method} ${url.pathname}`;
    if (!['GET /api/sync', 'POST /api/sync', 'DELETE /api/vault'].includes(route)) return fail(404, 'not_found');
    const vault = await authorize(request, env.DB);
    if (!vault) return fail(401, 'unauthorized');
    if (route === 'GET /api/sync') return await pull(vault, url, env);
    if (route === 'POST /api/sync') return await push(vault, request, env);
    return await destroy(vault, env);
  } catch (e) {
    console.error(e);
    return fail(500, 'server_error');
  }
}
