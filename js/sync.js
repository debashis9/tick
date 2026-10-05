// Cloud backup on this device: turning it on, linking another device, and syncing in the
// background (on open, when the app comes back, when the network returns, and a few seconds
// after each change). The encryption and the protocol live in crypto.js and sync-core.js.

import { store, syncAdapter, setVault, markAllDirty, onLocalChange, onExternalChange } from './store.js';
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
    if (err.code === 'invite_required') return 'Cloud backup needs an invite link from the person who runs Tick. Open the link on this device, then try again.';
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

// Step 2, once the user has saved the code: create the vault and upload everything.
export async function turnOn(code) {
  const keys = await keysOf(code);
  await apiClient('', keys).create(store.settings.invite);
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
      failures = 0;
      return result;
    } catch (err) {
      console.warn('sync failed', err);
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

export function startBackgroundSync() {
  onLocalChange(() => { if (store.dirty.size) schedule(); });
  // Another tab, or the service worker's "Mark done", changed something that needs uploading.
  onExternalChange(() => { if (store.dirty.size && !running) schedule(); });
  addEventListener('online', () => schedule(500));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(800); });
  schedule(300);
}
