// Who is the admin on this device. Any device that holds an admin's backup is the admin (it learns
// so on each sync), so there is nothing to type. The server's admin key (INVITE_SECRET) still works
// as a fallback, for a device without the admin's backup. The same as Sol's js/admin.js.

import { store } from './store.js';
import { ApiError } from './sync-core.js';
import { vaultAuth } from './sync.js';
import { adminApi } from './admin-api.js';

export * from './admin-api.js';

export const isAdminDevice = () => !!(store.settings.isAdmin && store.vault) || !!store.settings.adminKey;
export async function adminAuth() {
  if (store.settings.isAdmin && store.vault) return vaultAuth();
  if (store.settings.adminKey) return `Bearer admin.${store.settings.adminKey}`;
  throw new ApiError(403, 'not_admin');
}
export const myAdminApi = () => adminApi(adminAuth);
