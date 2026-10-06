// The admin endpoints, without any app state (so Node tests can use it): invite signatures, the
// API calls, and error messages in words. The same as Sol's js/admin-api.js.

import { ApiError } from './sync-core.js';

const enc = new TextEncoder();
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// The same signature the Worker checks (worker/vault.js: signInvite). The Worker's source isn't
// published with the app, so the few lines are repeated here; a test keeps the two in step.
export async function signInvite(secret, payload) {
  const p = b64u(enc.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return p + '.' + b64u(await crypto.subtle.sign('HMAC', key, enc.encode(p)));
}
export const inviteToken = (secret, days) => signInvite(secret, { exp: Date.now() + days * 864e5 });
export const inviteUrl = (token, base = location.origin + '/') => `${base}?invite=${token}`;

// `auth` is the whole Authorization header, or a function that returns it.
export function adminApi(auth, fetchFn = (...a) => fetch(...a)) {
  async function call(method, path, body) {
    const res = await fetchFn(path, {
      method,
      headers: { authorization: typeof auth === 'function' ? await auth() : auth, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      let code;
      try { code = (await res.json()).error; } catch { /* not JSON */ }
      throw new ApiError(res.status, code);
    }
    return res.json();
  }
  return {
    overview: () => call('GET', '/api/admin/overview'),
    decide: (id, action) => call('POST', `/api/admin/requests/${id}`, { action }),
    revoke: id => call('POST', `/api/admin/vaults/${id}/revoke`, {}),
    setAdmin: (id, admin) => call('POST', `/api/admin/vaults/${id}/admin`, { admin }),
    invite: days => call('POST', '/api/admin/invite', { days }),
  };
}
export function explainAdmin(err) {
  if (err instanceof ApiError) {
    if (err.code === 'unauthorized') return "That isn't this server's admin key.";
    if (err.code === 'not_admin') return 'This device isn’t an admin any more.';
    if (err.code === 'not_yourself') return 'You can’t do that to your own backup.';
    if (err.code === 'no_admin') return 'This server has no admin key (INVITE_SECRET).';
    if (err.code === 'not_configured' || err.status === 404 || err.status === 405 || err.status === 501) return 'This copy of Tick has no backup server, so there is nothing to administer.';
    return `The server had a problem (${err.status}). Try again in a moment.`;
  }
  return navigator.onLine ? "Couldn't reach the server. Try again in a moment." : "You're offline. The admin page needs the network.";
}
