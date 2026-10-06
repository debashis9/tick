// Cloud backup on this device: turning it on, linking another device, and syncing in the
// background (on open, when the app comes back, when the network returns, and a few seconds
// after each change). The encryption and the protocol live in crypto.js and sync-core.js.

import { store, syncAdapter, setVault, markAllDirty, saveSettings, onLocalChange, onExternalChange } from './store.js';
import { newVaultKey, encodeCode, decodeCode, deriveKeys } from './crypto.js';
import { apiClient, syncOnce, ApiError } from './sync-core.js';

let keysFor = { code: null, keys: null };
async function keysOf(code) {
  if (keysFor.code !== code) keysFor = { code, keys: await deriveKeys(await decodeCode(code)) };
  return keysFor.keys;
}

export function explain(err) {
  if (!navigator.onLine) return "You're offline. Tick will back up when you're connected.";
  if (err instanceof ApiError) {
    if (err.code === 'invite_required') return 'Cloud backup needs approval. Ask for it in Settings → Cloud backup, or open an invite link on this device.';
    if (err.code === 'not_approved') return "Your request for cloud backup hasn't been approved yet.";
    if (err.code === 'revoked') return 'Cloud backup for your habits was turned off by the person who runs Tick. Everything is still on this device.';
    if (err.code === 'busy') return 'Too many requests are waiting right now. Try again later.';
    if (err.code === 'name_required') return 'Add your name, so they know who is asking.';
    if (err.code === 'unauthorized') return "There's no backup for this code. It may have been deleted from another device.";
    if (err.code === 'quota') return 'Your backup is full (25 MB).';
    if (err.code === 'not_configured' || err.status === 404 || err.status === 405 || err.status === 501) return 'This copy of Tick has no backup server.';
    return `The backup server had a problem (${err.status}). Tick will try again later.`;
  }
  return "Couldn't reach the backup server. Tick will try again later.";
}

// Step 1 of turning backup on: a new key and its recovery code. Nothing is sent yet.
export async function newCode() {
  return encodeCode(newVaultKey());
}

// Step 2, once the user has saved the code: create the vault and upload everything. An invite or
// an approved request allows it; the name goes with it, for the Admin tab.
export async function turnOn(code) {
  const keys = await keysOf(code);
  const r = store.settings.request;
  await apiClient('', keys).create({ invite: store.settings.invite, request: r?.status === 'approved' ? `${r.id}.${r.secret}` : undefined, name: store.settings.name });
  await setVault({ code, vaultId: keys.vaultId, cursor: 0, lastSyncAt: null, lastError: null, since: Date.now(), linking: false, own: null });
  await markAllDirty();
  return syncNow();
}

// Links this device to an existing backup. Habits already here are kept and uploaded too; one
// with the same name as a habit in the backup is combined with it (records.js, settle). `own`
// remembers which habits were here first, until the first sync has finished.
export async function link(input) {
  const bytes = await decodeCode(input); // throws a readable message for typos
  const code = await encodeCode(bytes);
  const keys = await keysOf(code);
  await apiClient('', keys).pull(0);     // 401 if no such vault
  await setVault({ code, vaultId: keys.vaultId, cursor: 0, lastSyncAt: null, lastError: null, since: Date.now(), linking: true, own: store.habits.map(h => h.id) });
  await markAllDirty();
  return syncNow();
}

export async function turnOff({ deleteCloud }) {
  if (deleteCloud && store.vault) await apiClient('', await keysOf(store.vault.code)).destroy();
  await setVault(null);
}

let running = null, again = false, timer = null, failures = 0;
const statusListeners = new Set();
export const onSyncStatus = fn => statusListeners.add(fn);
const status = () => statusListeners.forEach(fn => fn());
export async function syncNow() {
  if (!store.vault) return null;
  if (running) { again = true; return running; }
  running = (async () => {
    try {
      const keys = await keysOf(store.vault.code);
      const result = await syncOnce(keys, apiClient('', keys), syncAdapter);
      if (store.vault) await setVault({ lastSyncAt: Date.now(), lastError: null, linking: false, own: null });
      await noteAdmin(result.admin);
      failures = 0;
      return result;
    } catch (err) {
      console.warn('sync failed', err);
      if (err instanceof ApiError && err.code === 'revoked') {
        // The admin turned this backup off. The habits stay here; backup goes back to off.
        await setVault(null);
        await saveSettings({ backupNotice: explain(err), isAdmin: false, adminPending: 0, request: store.settings.request && { ...store.settings.request, status: 'revoked' } });
        throw err;
      }
      if (store.vault) await setVault({ lastError: explain(err) });
      // Try again later: 30 s, 1 min, 2 min … up to 15 min.
      failures++;
      schedule(Math.min(30e3 * 2 ** (failures - 1), 15 * 60e3));
      throw err;
    } finally {
      running = null;
      status();
      if (again) { again = false; schedule(500); }
    }
  })();
  return running;
}

function schedule(ms = 4000) {
  clearTimeout(timer);
  if (store.vault) timer = setTimeout(() => syncNow().catch(() => {}), ms);
}

// Each sync tells an admin's devices that they are one, and how many people are waiting.
async function noteAdmin(admin) {
  const isAdmin = !!admin, pending = admin?.pending || 0;
  if (isAdmin !== !!store.settings.isAdmin || pending !== (store.settings.adminPending || 0)) {
    await saveSettings({ isAdmin, adminPending: pending });
  }
}

// "Bearer <vaultId>.<authSecret>" for this device's backup: the Admin tab's credentials on an
// admin's device.
export async function vaultAuth() {
  if (!store.vault) throw new ApiError(401, 'unauthorized');
  const keys = await keysOf(store.vault.code);
  return `Bearer ${keys.vaultId}.${keys.authSecret}`;
}

// ---------- asking for cloud backup ----------
async function requestCall(method, path, body) {
  const r = store.settings.request;
  const headers = { 'content-type': 'application/json' };
  if (r?.id && r?.secret) headers.authorization = `Bearer req.${r.id}.${r.secret}`;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw new ApiError(res.status, data?.error);
  return data;
}

// Sends (or re-sends) this device's request. The id and secret are kept here; the name and note
// go to the admin.
export async function requestBackup(name, note) {
  const res = await requestCall('POST', '/api/requests', { name, note });
  const cur = store.settings.request || {};
  await saveSettings({ request: { id: res.id, secret: res.secret || cur.secret, status: res.status, at: Date.now() }, backupNotice: null });
  return res.status;
}

// Asks whether the admin has decided. Returns the status, or null if there's nothing to ask.
export async function checkRequest() {
  const r = store.settings.request;
  if (!r?.id || !r?.secret || store.vault || !['pending', 'approved', 'rejected'].includes(r.status)) return null;
  try {
    const res = await requestCall('GET', '/api/requests/me');
    if (res.status !== r.status) await saveSettings({ request: { ...r, status: res.status } });
    return res.status;
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) await saveSettings({ request: null });
    return null;
  }
}

export function startBackgroundSync() {
  onLocalChange(() => { if (store.dirty.size) schedule(); });
  // Another tab, or the service worker's "Mark done", changed something that needs uploading.
  onExternalChange(() => { if (store.dirty.size && !running) schedule(); });
  addEventListener('online', () => schedule(500));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(800); });
  schedule(300);
}
