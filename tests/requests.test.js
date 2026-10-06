// Asking for cloud backup, the Admin tab and revoking, through the real Worker code (the same
// tests as Sol's, without its admin notifications).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeD1 } from './helpers/d1.js';
import { api, signInvite } from '../worker/vault.js';
import { signInvite as appSignInvite, adminApi as rawAdminApi } from '../js/admin-api.js';
const adminApi = (secret, fetchFn) => rawAdminApi(`Bearer admin.${secret}`, fetchFn);
import { newVaultKey, deriveKeys } from '../js/crypto.js';
import { apiClient, syncOnce } from '../js/sync-core.js';

const SECRET = 'admin-secret-for-tests';
const BASE = 'https://tick.test';
function server(env = { INVITE_SECRET: SECRET }) {
  const e = { DB: makeD1(), ...env };
  return { env: e, fetchFn: (url, init) => api(new Request(new URL(url, BASE), init), e) };
}
async function call(fetchFn, method, path, body, auth) {
  const res = await fetchFn(BASE + path, { method, headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}
const device = () => {
  const records = new Map(), dirty = new Map();
  return {
    cursor: 0, records,
    put(r) { const rec = { ...r, updatedAt: Date.now() + records.size }; records.set(r.id, rec); dirty.set(r.id, rec.updatedAt); },
    get: id => records.get(id),
    async applyRemote(list) { list.forEach(r => { records.set(r.id, r); dirty.delete(r.id); }); },
    async dirty() { return [...dirty].map(([id, updatedAt]) => ({ id, updatedAt })); },
    async clearDirty(list) { list.forEach(d => dirty.delete(d.id)); },
    async setCursor(n) { this.cursor = n; },
  };
};

test('the app signs invites exactly as the Worker does', async () => {
  const p = { exp: 1790000000000 };
  assert.equal(await appSignInvite(SECRET, p), await signInvite(SECRET, p));
});

test('request → wait → approve → turn on backup, with the name on the admin page', async () => {
  const { fetchFn } = server();
  assert.equal((await call(fetchFn, 'POST', '/api/requests', { name: '  ' })).body.error, 'name_required');
  const made = await call(fetchFn, 'POST', '/api/requests', { name: 'Riya Sen', note: 'Debashis’s cousin' });
  assert.equal(made.status, 201);
  const { id, secret } = made.body;
  const me = `Bearer req.${id}.${secret}`;
  assert.equal((await call(fetchFn, 'GET', '/api/requests/me', null, me)).body.status, 'pending');
  assert.equal((await call(fetchFn, 'GET', '/api/requests/me', null, `Bearer req.${id}.${'x'.repeat(43)}`)).status, 404);

  const keys = await deriveKeys(newVaultKey());
  const client = apiClient(BASE, keys, fetchFn);
  await assert.rejects(client.create({ name: 'Riya' }), e => e.code === 'invite_required');
  await assert.rejects(client.create({ request: `${id}.${secret}` }), e => e.code === 'not_approved');

  const admin = adminApi(SECRET, fetchFn);
  let o = await admin.overview();
  assert.equal(o.totals.pending, 1);
  assert.deepEqual([o.requests[0].name, o.requests[0].note], ['Riya Sen', 'Debashis’s cousin']);
  await admin.decide(id, 'approve');
  assert.equal((await call(fetchFn, 'GET', '/api/requests/me', null, me)).body.status, 'approved');

  assert.deepEqual(await client.create({ request: `${id}.${secret}`, name: 'ignored' }), { created: true });
  const d = device();
  d.put({ id: 'e_1', kind: 'entry', text: 'hello' });
  await syncOnce(keys, client, d);
  o = await admin.overview();
  const v = o.vaults[0];
  assert.deepEqual([v.name, v.via, v.records, o.totals.vaults, o.totals.active7, o.totals.pending], ['Riya Sen', 'request', 1, 1, 1, 0]);
});

test('a request can be rejected, asked again, and is the same request', async () => {
  const { fetchFn } = server();
  const { id, secret } = (await call(fetchFn, 'POST', '/api/requests', { name: 'Arjun' })).body;
  const admin = adminApi(SECRET, fetchFn);
  await admin.decide(id, 'reject');
  const me = `Bearer req.${id}.${secret}`;
  assert.equal((await call(fetchFn, 'GET', '/api/requests/me', null, me)).body.status, 'rejected');
  const again = await call(fetchFn, 'POST', '/api/requests', { name: 'Arjun M', note: 'from Pune' }, me);
  assert.deepEqual(again.body, { id, status: 'pending' });
  const r = (await admin.overview()).requests;
  assert.deepEqual([r.length, r[0].name, r[0].request_count], [1, 'Arjun M', 2]);
});

test('invites still work, and the device’s name is kept with the backup', async () => {
  const { fetchFn } = server();
  const keys = await deriveKeys(newVaultKey());
  await apiClient(BASE, keys, fetchFn).create({ invite: await signInvite(SECRET, { exp: Date.now() + 1e6 }), name: 'Ma' });
  const v = (await adminApi(SECRET, fetchFn).overview()).vaults[0];
  assert.deepEqual([v.name, v.via], ['Ma', 'invite']);
});

test('revoking deletes the backup and tells the device why', async () => {
  const { env, fetchFn } = server();
  const { id, secret } = (await call(fetchFn, 'POST', '/api/requests', { name: 'Meera' })).body;
  const admin = adminApi(SECRET, fetchFn);
  await admin.decide(id, 'approve');
  const keys = await deriveKeys(newVaultKey());
  const client = apiClient(BASE, keys, fetchFn);
  await client.create({ request: `${id}.${secret}` });
  const d = device();
  d.put({ id: 'e_1', kind: 'entry', text: 'x' });
  await syncOnce(keys, client, d);
  await admin.revoke(keys.vaultId);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM records').get().n, 0);
  await assert.rejects(client.pull(0), e => e.status === 403 && e.code === 'revoked');
  await assert.rejects(client.create({ request: `${id}.${secret}` }), e => e.code === 'revoked');
  assert.equal((await call(fetchFn, 'GET', '/api/requests/me', null, `Bearer req.${id}.${secret}`)).body.status, 'revoked');
  const v = (await admin.overview()).vaults[0];
  assert.ok(v.revoked_at);
});

test('the admin endpoints need the admin key; without one there is no admin', async () => {
  const { fetchFn } = server();
  await assert.rejects(adminApi('wrong', fetchFn).overview(), e => e.status === 401);
  await assert.rejects(adminApi(SECRET, fetchFn).decide('x'.repeat(22), 'approve'), e => e.status === 404);
  await assert.rejects(adminApi(SECRET, fetchFn).decide('x'.repeat(22), 'delete'), e => e.status === 400);
  const open = server({});
  await assert.rejects(adminApi(SECRET, open.fetchFn).overview(), e => e.code === 'no_admin');
});

// ---------- admin rights that belong to a backup ----------
async function adminSetup() {
  const { env, fetchFn } = server({ INVITE_SECRET: SECRET });
  // The first admin: their request is marked make_admin (README → Admin) and approved.
  const { id, secret } = (await call(fetchFn, 'POST', '/api/requests', { name: 'Debashis' })).body;
  env.DB.raw.prepare('UPDATE requests SET make_admin = 1 WHERE id = ?').run(id);
  await adminApi(SECRET, fetchFn).decide(id, 'approve');
  const keys = await deriveKeys(newVaultKey());
  await apiClient(BASE, keys, fetchFn).create({ request: `${id}.${secret}` });
  const me = rawAdminApi(`Bearer ${keys.vaultId}.${keys.authSecret}`, fetchFn);
  return { env, fetchFn, keys, me };
}

test('a backup made from an admin request is the admin: no key needed', async () => {
  const { fetchFn, keys, me } = await adminSetup();
  const pulled = await apiClient(BASE, keys, fetchFn).pull(0);
  assert.deepEqual(pulled.admin, { pending: 0 });
  await call(fetchFn, 'POST', '/api/requests', { name: 'Riya', note: 'cousin' });
  assert.deepEqual((await apiClient(BASE, keys, fetchFn).pull(0)).admin, { pending: 1 });
  const o = await me.overview();
  assert.equal(o.me, keys.vaultId);
  assert.equal(o.vaults.find(v => v.id === keys.vaultId).is_admin, 1);
  const riya = o.requests.find(r => r.name === 'Riya');
  await me.decide(riya.id, 'approve');
  assert.equal((await me.overview()).totals.pending, 0);
});

test('an ordinary backup is not an admin', async () => {
  const { fetchFn } = await adminSetup();
  const keys = await deriveKeys(newVaultKey());
  await apiClient(BASE, keys, fetchFn).create({ invite: await signInvite(SECRET, { exp: Date.now() + 1e6 }) });
  assert.equal((await apiClient(BASE, keys, fetchFn).pull(0)).admin, undefined);
  await assert.rejects(rawAdminApi(`Bearer ${keys.vaultId}.${keys.authSecret}`, fetchFn).overview(), e => e.status === 403 && e.code === 'not_admin');
});

test('admins can make someone else an admin, but not demote or revoke themselves', async () => {
  const { fetchFn, keys, me } = await adminSetup();
  const other = await deriveKeys(newVaultKey());
  await apiClient(BASE, other, fetchFn).create({ invite: await signInvite(SECRET, { exp: Date.now() + 1e6 }), name: 'Arjun' });
  await me.setAdmin(other.vaultId, true);
  assert.deepEqual((await apiClient(BASE, other, fetchFn).pull(0)).admin, { pending: 0 });
  await assert.rejects(me.setAdmin(keys.vaultId, false), e => e.code === 'not_yourself');
  await assert.rejects(me.revoke(keys.vaultId), e => e.code === 'not_yourself');
  await rawAdminApi(`Bearer ${other.vaultId}.${other.authSecret}`, fetchFn).setAdmin(other.vaultId, true);
  await me.setAdmin(other.vaultId, false);
  await assert.rejects(rawAdminApi(`Bearer ${other.vaultId}.${other.authSecret}`, fetchFn).overview(), e => e.code === 'not_admin');
});

test('the server signs invite links for an admin backup', async () => {
  const { fetchFn, me } = await adminSetup();
  const { token, days } = await me.invite(30);
  assert.equal(days, 30);
  const keys = await deriveKeys(newVaultKey());
  assert.deepEqual(await apiClient(BASE, keys, fetchFn).create({ invite: token }), { created: true });
});

test('the admin key can make this device’s own backup the admin (how Tick sets up the first admin)', async () => {
  const { fetchFn } = server();
  const keys = await deriveKeys(newVaultKey());
  await apiClient(BASE, keys, fetchFn).create({ invite: await signInvite(SECRET, { exp: Date.now() + 1e6 }), name: 'Debashis' });
  assert.equal((await apiClient(BASE, keys, fetchFn).pull(0)).admin, undefined);
  await adminApi(SECRET, fetchFn).setAdmin(keys.vaultId, true);
  assert.deepEqual((await apiClient(BASE, keys, fetchFn).pull(0)).admin, { pending: 0 });
  const o = await rawAdminApi(`Bearer ${keys.vaultId}.${keys.authSecret}`, fetchFn).overview();
  assert.equal(o.me, keys.vaultId);
  assert.equal(o.vaults[0].name, 'Debashis');
});

test('the admin page holds names and sizes, never anything from inside a backup', async () => {
  const { fetchFn } = server();
  const keys = await deriveKeys(newVaultKey());
  const client = apiClient(BASE, keys, fetchFn);
  await client.create({ invite: await signInvite(SECRET, { exp: Date.now() + 1e6 }), name: 'Riya' });
  const d = device();
  d.put({ id: 'hread', kind: 'habit', name: 'Read a book', createdOn: '2026-10-06' });
  d.put({ id: 'c:hread:2026-10-06', kind: 'check', amount: 22, pick: 'Jog' });
  await syncOnce(keys, client, d);
  const o = JSON.stringify(await adminApi(SECRET, fetchFn).overview());
  assert.ok(o.includes('Riya'));
  for (const plain of ['Read a book', 'hread', '2026-10-06', 'Jog', keys.authSecret]) assert.ok(!o.includes(plain), plain);
});
