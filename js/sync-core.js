// One sync pass against the Worker, with no knowledge of IndexedDB or the DOM (so tests can run
// two simulated devices against the real Worker code).
//
//   local = {
//     get(id)              → the local record (tombstones included), or undefined
//     resolve(theirs, ours)→ optional: null (keep ours), { record } or { record, upload: true }.
//                            Without it, the newer record wins.
//     applyRemote(records, uploadIds)
//                          → store records that came from the server; those in uploadIds are a
//                            combination this device must send back (so they stay dirty)
//     dirty()              → [{ id, updatedAt }] changed here and not yet uploaded
//     clearDirty(list)     → forget those, unless they changed again meanwhile
//     cursor, setCursor(n) → the last server sequence number this device has seen
//   }

import { encryptRecord, decryptRecord } from './crypto.js';

export class ApiError extends Error {
  constructor(status, code) { super(code || `Server error ${status}`); this.status = status; this.code = code; }
}

export function apiClient(base, keys, fetchFn = (...a) => fetch(...a)) {
  const auth = { authorization: `Bearer ${keys.vaultId}.${keys.authSecret}` };
  async function call(method, path, body) {
    const res = await fetchFn(base + path, {
      method,
      headers: body ? { ...auth, 'content-type': 'application/json' } : auth,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      let code;
      try { code = (await res.json()).error; } catch { /* not JSON */ }
      throw new ApiError(res.status, code);
    }
    return res.status === 204 ? null : res.json();
  }
  return {
    create: invite => call('POST', '/api/vault', { vaultId: keys.vaultId, authHash: keys.authHash, invite: invite || undefined }),
    pull: since => call('GET', `/api/sync?since=${since}`),
    push: records => call('POST', '/api/sync', { records }),
    destroy: () => call('DELETE', '/api/vault'),
  };
}

const BATCH = 200;

// Pull first, so a newer copy from another device wins over an older local edit; then push
// whatever is still dirty. Last write wins per record, by updatedAt.
export async function syncOnce(keys, api, local) {
  let pulled = 0, pushed = 0, unreadable = 0;
  let cursor = local.cursor || 0;
  for (;;) {
    const res = await api.pull(cursor);
    const incoming = [];
    for (const row of res.records) {
      try { incoming.push(await decryptRecord(keys, row)); } catch { unreadable++; }
    }
    const keep = [], upload = new Set();
    for (const r of incoming) {
      const cur = local.get(r.id);
      const out = local.resolve ? local.resolve(r, cur)
        : !cur || (r.updatedAt || 0) > (cur.updatedAt || 0) ? { record: r } : null;
      if (!out) continue;
      keep.push(out.record);
      if (out.upload) upload.add(out.record.id);
    }
    if (keep.length) await local.applyRemote(keep, upload);
    pulled += keep.length;
    cursor = res.cursor;
    await local.setCursor(cursor);
    if (!res.more) break;
  }
  const dirty = await local.dirty();
  for (let i = 0; i < dirty.length; i += BATCH) {
    const records = dirty.slice(i, i + BATCH).map(d => local.get(d.id)).filter(Boolean);
    const rows = await Promise.all(records.map(r => encryptRecord(keys, r)));
    await api.push(rows);
    await local.clearDirty(records.map(r => ({ id: r.id, updatedAt: r.updatedAt })));
    pushed += rows.length;
  }
  return { pulled, pushed, unreadable };
}
