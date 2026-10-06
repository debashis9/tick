// Encrypted cloud backup, asking for it, and the Admin tab: /api/vault, /api/sync, /api/requests,
// /api/admin/*. The same code as Sol's Worker (../journal/worker/index.js), without Sol's
// reminders, voice notes and admin notifications.
//
// What it stores, per backup: an id, the SHA-256 of its auth secret, encrypted records ({ id, seq,
// iv, ct }), and for the Admin tab the owner's name, how the backup was allowed (request, invite),
// and whether it is an admin's. Per request: the name and note someone typed. Record ids are
// opaque, and everything about habits (names, days, ticks, amounts) is inside the ciphertext. It
// can't decrypt anything: the key never leaves people's devices.
//
// This file imports nothing from Cloudflare, so Node can load it for the tests and for
// tools/invite.mjs (index.js can't be loaded there: it imports cloudflare:workers).

const QUOTA = 25 * 1024 * 1024;   // bytes of ciphertext per vault (decades of ticks)
const MAX_BATCH = 500;            // records per push
const PAGE = 500;                 // records per pull
const MAX_CT = 96 * 1024;         // one record, encrypted
const MAX_BODY = 8 * 1024 * 1024;
const MAX_PENDING = 200;          // open requests at once, so a flood can't fill the table

const ID = /^[A-Za-z0-9_-]{22}$/;
const HASH = /^[0-9a-f]{64}$/;
const IV = /^[A-Za-z0-9_-]{16}$/;
const B64U = /^[A-Za-z0-9_-]+$/;

const HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS });
const fail = (status, error) => json({ error }, status);
const noContent = () => new Response(null, { status: 204, headers: HEADERS });

const enc = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha256hex = async s => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
function b64u(buf) {
  const u = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const randomId = n => b64u(crypto.getRandomValues(new Uint8Array(n)));
function sameString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const cleanText = (v, max) => typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';

// ---------- invites ----------
// Invite tokens are `payload.signature`, signed with INVITE_SECRET. Nothing is stored: the Worker
// only checks the signature and the expiry. Without INVITE_SECRET, anyone can create a vault (fine
// for local development) and there is no admin page.
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

async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) return { tooBig: true };
  try { return { body: JSON.parse(text) }; } catch { return {}; }
}

// "Authorization: Bearer <vaultId>.<authSecret>" → { vault } or { error }.
async function authorize(request, db) {
  const m = /^Bearer ([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/.exec(request.headers.get('authorization') || '');
  if (!m) return { error: fail(401, 'unauthorized') };
  const row = await db.prepare('SELECT auth_hash, revoked_at, is_admin FROM vaults WHERE id = ?').bind(m[1]).first();
  if (!row || !sameString(row.auth_hash, await sha256hex(m[2]))) return { error: fail(401, 'unauthorized') };
  if (row.revoked_at) return { error: fail(403, 'revoked') };
  return { vault: m[1], isAdmin: !!row.is_admin };
}

// "Authorization: Bearer req.<id>.<secret>" → the request row, or null.
async function requestOf(request, db) {
  const m = /^Bearer req\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/.exec(request.headers.get('authorization') || '');
  if (!m) return null;
  const row = await db.prepare('SELECT * FROM requests WHERE id = ?').bind(m[1]).first();
  return row && sameString(row.secret_hash, await sha256hex(m[2])) ? row : null;
}

// ---------- vaults and sync ----------
async function createVault(request, env) {
  const { body, tooBig } = await readJson(request);
  if (tooBig) return fail(413, 'too_large');
  if (!body || !ID.test(body.vaultId) || !HASH.test(body.authHash)) return fail(400, 'bad_request');
  const existing = await env.DB.prepare('SELECT auth_hash, revoked_at FROM vaults WHERE id = ?').bind(body.vaultId).first();
  if (existing) {
    if (!sameString(existing.auth_hash, body.authHash)) return fail(409, 'exists');
    if (existing.revoked_at) return fail(403, 'revoked');
    return json({ created: false }); // a retry, or turning backup back on with the same code
  }
  // Allowed: no INVITE_SECRET (development), a valid invite, or an approved request.
  let via = 'open', req = null;
  if (env.INVITE_SECRET) {
    let invited = false;
    try { invited = await validInvite(body.invite, env.INVITE_SECRET); } catch { invited = false; }
    if (invited) via = 'invite';
    else {
      const m = typeof body.request === 'string' && /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/.exec(body.request);
      req = m ? await env.DB.prepare('SELECT * FROM requests WHERE id = ?').bind(m[1]).first() : null;
      if (!req || !sameString(req.secret_hash, await sha256hex(m[2]))) return fail(403, 'invite_required');
      if (req.status !== 'approved') return fail(403, 'not_approved');
      via = 'request';
    }
  }
  const name = cleanText(req?.name || body.name, 60) || null;
  await env.DB.prepare('INSERT INTO vaults (id, auth_hash, next_seq, bytes, created_at, used_at, name, via, request_id, is_admin) VALUES (?, ?, 1, 0, ?, ?, ?, ?, ?, ?)')
    .bind(body.vaultId, body.authHash, Date.now(), Date.now(), name, via, req?.id || null, req?.make_admin ? 1 : 0).run();
  return json({ created: true }, 201);
}

async function pull(vault, url, env, isAdmin) {
  const since = Math.max(0, Number.parseInt(url.searchParams.get('since') || '0', 10) || 0);
  const { results } = await env.DB.prepare('SELECT id, seq, iv, ct FROM records WHERE vault = ? AND seq > ? ORDER BY seq LIMIT ?')
    .bind(vault, since, PAGE + 1).all();
  // "Last sync" for the admin page; written at most once an hour per vault.
  await env.DB.prepare('UPDATE vaults SET used_at = ? WHERE id = ? AND used_at < ?').bind(Date.now(), vault, Date.now() - 3600e3).run();
  const more = results.length > PAGE;
  const records = results.slice(0, PAGE);
  // An admin's devices learn how many people are waiting, with no extra request.
  const admin = isAdmin ? { pending: (await env.DB.prepare(`SELECT COUNT(*) AS n FROM requests WHERE status = 'pending'`).first()).n } : undefined;
  return json({ records, cursor: records.length ? records.at(-1).seq : since, more, admin });
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
  return noContent();
}

// ---------- requests ----------
// A new request returns an id and a secret the device keeps; asking again (after a rejection,
// or to change the note) sends them back and updates the same request.
async function makeRequest(request, env) {
  const { body } = await readJson(request);
  const name = cleanText(body?.name, 60), note = cleanText(body?.note, 300);
  if (!name) return fail(400, 'name_required');
  const now = Date.now();
  const mine = await requestOf(request, env.DB);
  if (mine) {
    if (mine.status === 'approved') return json({ id: mine.id, status: 'approved' });
    await env.DB.prepare(`UPDATE requests SET name = ?, note = ?, status = 'pending', request_count = request_count + 1, updated_at = ?, decided_at = NULL WHERE id = ?`)
      .bind(name, note || null, now, mine.id).run();
    return json({ id: mine.id, status: 'pending' });
  }
  const open = await env.DB.prepare(`SELECT COUNT(*) AS n FROM requests WHERE status = 'pending'`).first();
  if (open.n >= MAX_PENDING) return fail(429, 'busy');
  const id = randomId(16), secret = randomId(32);
  await env.DB.prepare('INSERT INTO requests (id, secret_hash, name, note, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, await sha256hex(secret), name, note || null, 'pending', now, now).run();
  return json({ id, secret, status: 'pending' }, 201);
}

async function requestStatus(request, env) {
  const mine = await requestOf(request, env.DB);
  if (!mine) return fail(404, 'no_request');
  return json({ status: mine.status, decidedAt: mine.decided_at });
}

// ---------- admin ----------
// Who may use the admin endpoints: a device holding an admin backup ("Bearer <vault>.<secret>"),
// or the admin key ("Bearer admin.<INVITE_SECRET>", kept as a fallback). Returns { me } or { error }.
async function adminOf(request, env) {
  const m = /^Bearer admin\.(.{1,200})$/.exec(request.headers.get('authorization') || '');
  if (m) {
    if (!env.INVITE_SECRET) return { error: fail(503, 'no_admin') };
    return sameString(await sha256hex(m[1]), await sha256hex(env.INVITE_SECRET)) ? { me: null } : { error: fail(401, 'unauthorized') };
  }
  const { vault, isAdmin, error } = await authorize(request, env.DB);
  if (error) return { error };
  return isAdmin ? { me: vault } : { error: fail(403, 'not_admin') };
}

async function admin(request, url, env) {
  const { me, error } = await adminOf(request, env);
  if (error) return error;
  const now = Date.now();
  if (request.method === 'POST' && url.pathname === '/api/admin/invite') {
    if (!env.INVITE_SECRET) return fail(503, 'no_admin');
    const { body } = await readJson(request);
    const days = [7, 30, 90].includes(body?.days) ? body.days : 30;
    return json({ token: await signInvite(env.INVITE_SECRET, { exp: now + days * 864e5 }), days });
  }
  if (request.method === 'GET' && url.pathname === '/api/admin/overview') {
    const [{ results: requests }, { results: vaults }, totals] = await Promise.all([
      env.DB.prepare(`SELECT id, name, note, status, request_count, created_at, updated_at, decided_at FROM requests
        ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, updated_at DESC LIMIT 300`).all(),
      env.DB.prepare(`SELECT v.id, v.name, v.via, v.bytes, v.created_at, v.used_at, v.revoked_at, v.is_admin,
        (SELECT COUNT(*) FROM records r WHERE r.vault = v.id) AS records FROM vaults v ORDER BY v.used_at DESC LIMIT 300`).all(),
      env.DB.prepare(`SELECT COUNT(*) AS vaults, COALESCE(SUM(bytes), 0) AS bytes,
        SUM(CASE WHEN used_at > ? AND revoked_at IS NULL THEN 1 ELSE 0 END) AS active7,
        SUM(CASE WHEN used_at > ? AND revoked_at IS NULL THEN 1 ELSE 0 END) AS active30 FROM vaults`).bind(now - 7 * 864e5, now - 30 * 864e5).first(),
    ]);
    return json({ requests, vaults, me, totals: { ...totals, pending: requests.filter(r => r.status === 'pending').length }, quota: QUOTA });
  }
  let r;
  if (request.method === 'POST' && (r = /^\/api\/admin\/requests\/([A-Za-z0-9_-]{22})$/.exec(url.pathname))) {
    const { body } = await readJson(request);
    const status = { approve: 'approved', reject: 'rejected' }[body?.action];
    if (!status) return fail(400, 'bad_request');
    const res = await env.DB.prepare('UPDATE requests SET status = ?, decided_at = ?, updated_at = ? WHERE id = ?').bind(status, now, now, r[1]).run();
    return res.meta.changes ? json({ status }) : fail(404, 'not_found');
  }
  if (request.method === 'POST' && (r = /^\/api\/admin\/vaults\/([A-Za-z0-9_-]{22})\/admin$/.exec(url.pathname))) {
    const { body } = await readJson(request);
    if (typeof body?.admin !== 'boolean') return fail(400, 'bad_request');
    if (!body.admin && r[1] === me) return fail(409, 'not_yourself');
    const res = await env.DB.prepare('UPDATE vaults SET is_admin = ? WHERE id = ? AND revoked_at IS NULL').bind(body.admin ? 1 : 0, r[1]).run();
    return res.meta.changes ? json({ admin: body.admin }) : fail(404, 'not_found');
  }
  if (request.method === 'POST' && (r = /^\/api\/admin\/vaults\/([A-Za-z0-9_-]{22})\/revoke$/.exec(url.pathname))) {
    if (r[1] === me) return fail(409, 'not_yourself');
    const v = await env.DB.prepare('SELECT request_id FROM vaults WHERE id = ?').bind(r[1]).first();
    if (!v) return fail(404, 'not_found');
    // The encrypted data goes; the row stays (revoked) so the device is told why, not just refused.
    await env.DB.batch([
      env.DB.prepare('DELETE FROM records WHERE vault = ?').bind(r[1]),
      env.DB.prepare('UPDATE vaults SET revoked_at = ?, bytes = 0, is_admin = 0 WHERE id = ?').bind(now, r[1]),
      env.DB.prepare(`UPDATE requests SET status = 'revoked', decided_at = ?, updated_at = ? WHERE id = ?`).bind(now, now, v.request_id || ''),
    ]);
    return json({ revoked: true });
  }
  return fail(404, 'not_found');
}

// ---------- routing ----------
export async function api(request, env) {
  const url = new URL(request.url);
  if (!env.DB) return fail(503, 'not_configured');
  try {
    const route = `${request.method} ${url.pathname}`;
    if (route === 'POST /api/vault') return await createVault(request, env);
    if (route === 'POST /api/requests') return await makeRequest(request, env);
    if (route === 'GET /api/requests/me') return await requestStatus(request, env);
    if (url.pathname.startsWith('/api/admin/')) return await admin(request, url, env);
    if (!['GET /api/sync', 'POST /api/sync', 'DELETE /api/vault'].includes(route)) return fail(404, 'not_found');
    const { vault, isAdmin, error } = await authorize(request, env.DB);
    if (error) return error;
    if (route === 'GET /api/sync') return await pull(vault, url, env, isAdmin);
    if (route === 'POST /api/sync') return await push(vault, request, env);
    return await destroy(vault, env);
  } catch (e) {
    console.error(e);
    return fail(500, 'server_error');
  }
}
