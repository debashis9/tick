// The admin's side of the app: checking the admin key, reading what the server knows about
// cloud backups, and making invite links. The admin key is the server's INVITE_SECRET; it is
// kept on this device only (in its own settings, never synced or exported) once entered, and
// sent only to this site's own API. The same design as Pie's admin page.

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
export const inviteUrl = (token, base = location.origin + location.pathname) => `${base}?invite=${token}`;

// What the server knows: counts and sizes. Throws ApiError (401 for a wrong key).
export async function fetchStats(secret, fetchFn = (...a) => fetch(...a)) {
  const res = await fetchFn('/api/admin/stats', { headers: { authorization: `Bearer admin.${secret}` } });
  if (!res.ok) {
    let code;
    try { code = (await res.json()).error; } catch { /* not JSON */ }
    throw new ApiError(res.status, code);
  }
  return res.json();
}

export function explainAdmin(err) {
  if (err instanceof ApiError) {
    if (err.code === 'unauthorized') return "That isn't this server's admin key.";
    if (err.code === 'no_admin') return 'This server has no admin key set (INVITE_SECRET), so anyone can turn on cloud backup and there is nothing to unlock.';
    if (err.code === 'not_configured' || err.status === 404 || err.status === 405 || err.status === 501) return 'This copy of Tick has no backup server, so there is nothing to administer.';
    return `The server had a problem (${err.status}). Try again in a moment.`;
  }
  return navigator.onLine ? "Couldn't reach the server. Try again in a moment." : "You're offline. The admin page needs the network.";
}
