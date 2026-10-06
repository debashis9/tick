// The Admin tab: for whoever runs this copy of Tick (the same design as Sol's). It appears on any
// device that holds an admin's backup, and as a fallback on a device unlocked with the server's
// admin key. Approve or reject requests for cloud backup, see each backup's owner, size and last
// sync, revoke one, make someone else an admin, and make invite links. It can't see inside any
// backup: habits and ticks are encrypted with a key only their owner's devices have.

import { store, saveSettings } from '../store.js';
import { myAdminApi, adminApi, isAdminDevice, inviteToken, inviteUrl, explainAdmin } from '../admin.js';
import { syncNow } from '../sync.js';
import { parse, key as dateKey, DAY_SHORT, MON_SHORT } from '../dates.js';
import { $, esc, toast, storageError, plural, render } from '../ui.js';

const el = () => $('#view-admin');
const state = { data: null, error: '', busy: false, link: '', days: 30, confirm: null };
const size = b => (b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${(b / 1024).toFixed(b < 10240 ? 1 : 0)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);
const when = ms => { if (!ms) return '—'; const d = parse(dateKey(new Date(ms))); return `${DAY_SHORT[d.getDay()]} ${d.getDate()} ${MON_SHORT[d.getMonth()]} ${d.getFullYear()}`; };
function ago(ms) {
  if (!ms) return 'never';
  const d = Math.floor((Date.now() - ms) / 864e5);
  return d < 1 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`;
}
const STATUS = { pending: 'Waiting', approved: 'Approved', rejected: 'Rejected', revoked: 'Revoked' };

function requestsHTML(list) {
  if (!list.length) return '<div class="row"><div class="rt"><div class="rs">No requests yet. They appear here when someone taps "Ask for cloud backup".</div></div></div>';
  return list.map(r => `<div class="row admrow">
      <div class="rt"><div class="rtitle">${esc(r.name)} <span class="tag st-${esc(r.status)}">${STATUS[r.status] || esc(r.status)}</span></div>
        ${r.note ? `<div class="quote">"${esc(r.note)}"</div>` : ''}
        <div class="rs">Asked ${esc(when(r.updated_at))}${r.request_count > 1 ? ` · ${plural(r.request_count, 'time')}` : ''}${r.decided_at ? ` · decided ${esc(when(r.decided_at))}` : ''}</div></div>
      <div class="acts">${r.status === 'pending' || r.status === 'rejected' ? `<button type="button" class="btn-sm strong" data-approve="${esc(r.id)}">Approve</button>` : ''}
        ${r.status === 'pending' || r.status === 'approved' ? `<button type="button" class="btn-sm" data-reject="${esc(r.id)}">${r.status === 'approved' ? 'Withdraw' : 'Reject'}</button>` : ''}</div>
    </div>`).join('');
}

function vaultsHTML(list, me) {
  if (!list.length) return '<div class="row"><div class="rt"><div class="rs">No backups yet.</div></div></div>';
  return list.map(v => {
    const mine = v.id === me || v.id === store.vault?.vaultId;
    return `<div class="row admrow${v.revoked_at ? ' dim' : ''}">
      <div class="rt"><div class="rtitle">${esc(v.name || 'No name')}${mine ? ' <span class="tag st-approved">You</span>' : ''}${v.is_admin ? ' <span class="tag st-pending">Admin</span>' : ''} <span class="tag">${v.via === 'invite' ? 'Invite' : v.via === 'request' ? 'Request' : 'Open'}</span>${v.revoked_at ? ' <span class="tag st-revoked">Revoked</span>' : ''}</div>
        <div class="rs">${v.revoked_at ? `Revoked ${esc(when(v.revoked_at))}` : `${size(v.bytes)} · ${plural(v.records, 'record')} · last sync ${esc(ago(v.used_at))}`} · since ${esc(when(v.created_at))}</div></div>
      <div class="acts">${v.revoked_at || mine ? '' : state.confirm === v.id
        ? `<button type="button" class="btn-sm danger" data-revoke="${esc(v.id)}">Delete their backup</button><button type="button" class="btn-sm quiet" data-cancel>Cancel</button>`
        : `<button type="button" class="btn-sm quiet" data-admin="${esc(v.id)}" data-on="${v.is_admin ? 0 : 1}">${v.is_admin ? 'Remove admin' : 'Make admin'}</button><button type="button" class="btn-sm" data-ask="${esc(v.id)}">Revoke…</button>`}</div>
    </div>`;
  }).join('');
}

// On a device unlocked with the key that has a backup of its own, which isn't an admin's yet:
// one tap makes it the admin's, and then the key isn't needed.
function setupHTML(d) {
  const s = store.settings, v = store.vault;
  if (!s.adminKey || s.isAdmin) return '';
  const mineIsAdmin = !!d?.vaults.find(x => x.id === v?.vaultId && x.is_admin);
  if (!v) return `<div class="notice"><span>Turn on cloud backup on this device, and you can make it the admin's backup: then the Admin tab follows your backup to every device you open it on, with no key.</span></div>`;
  return mineIsAdmin ? '' : `<div class="notice"><span>Make this device's backup the admin's. Every device you open your backup on then gets this tab, with no key.</span>
    <button type="button" data-make-me>Make my backup the admin</button></div>`;
}

function unlocked() {
  const d = state.data, t = d?.totals, s = store.settings;
  return `${state.error ? `<div class="notice bad"><span>${esc(state.error)}</span></div>` : ''}
    ${setupHTML(d)}
    ${d ? `<div class="group stat3">
      <div><b>${t.pending}</b><span>waiting for you</span></div>
      <div><b>${t.vaults || 0}</b><span>${t.vaults === 1 ? 'backup' : 'backups'}, ${size(t.bytes || 0)}</span></div>
      <div><b>${t.active7 || 0}</b><span>synced this week (${t.active30 || 0} in 30 days)</span></div></div>` : ''}
    <div class="glabel row-label">Requests <button type="button" class="btn-sm" data-refresh ${state.busy ? 'disabled' : ''}>${state.busy ? 'Loading…' : 'Refresh'}</button></div>
    <div class="group">${d ? requestsHTML(d.requests) : '<div class="row"><div class="rt"><div class="rs">Loading…</div></div></div>'}</div>
    <div class="glabel">Backups</div>
    <div class="group">${d ? vaultsHTML(d.vaults, d.me) : ''}
      <div class="row"><div class="rt"><div class="rs">Each backup is encrypted with a key only its owner's devices have. The server knows who asked, the size, and when it last synced; it can't read any habit or tick. Revoking deletes the encrypted backup; the habits stay on their devices. An admin is anyone whose devices hold an admin's backup: this tab appears on all of them.</div></div></div></div>
    <div class="glabel">Invite links</div>
    <div class="group">
      <div class="row"><div class="rt"><div class="rs">An invite skips the request: whoever opens it can turn on backup straight away. It works for anyone until it expires, so send it to people you've already said yes to.</div></div></div>
      <div class="row wrap"><div class="seg" role="group" aria-label="Valid for">${[7, 30, 90].map(n => `<button type="button" data-days="${n}" aria-pressed="${state.days === n}">${n} days</button>`).join('')}</div>
        <button type="button" class="btn-sm strong" data-invite>Make a link</button></div>
      ${state.link ? `<div class="row"><div class="rt"><div class="linkbox" id="adm-link">${esc(state.link)}</div>
        <div class="linkrow"><button type="button" class="btn-sm" data-send>Send it</button><button type="button" class="btn-sm" data-copy>Copy</button></div></div></div>` : ''}
    </div>
    ${s.adminKey ? '<button type="button" class="btn-sm wide" data-lock>Forget the admin key on this device</button>' : ''}`;
}

export function renderAdmin() {
  const open = isAdminDevice();
  el().innerHTML = `<header class="head"><div><div class="eyebrow">For whoever runs Tick</div><h1>Admin</h1></div></header>
    ${open ? unlocked() : `<div class="group welcome">
      <p class="rs">The Admin tab appears on any device that holds an admin's backup. Turn on (or open) your backup in Settings and it shows up by itself.</p>
      <form id="adm-form" autocomplete="off"><label class="rtitle" for="adm-key">Or use the admin key (the server's <code>INVITE_SECRET</code>)</label>
        <div class="inline"><input class="text-in" id="adm-key" type="password" autocapitalize="off" spellcheck="false" required>
          <button class="btn-sm strong" ${state.busy ? 'disabled' : ''}>${state.busy ? 'Checking…' : 'Unlock'}</button></div>
        ${state.error ? `<p class="err" role="alert">${esc(state.error)}</p>` : ''}</form></div>`}`;
  if (open && !state.data && !state.busy && !state.error) load();
}

async function load() {
  state.busy = true; state.error = ''; renderAdmin();
  try {
    state.data = await myAdminApi().overview();
    if (state.data.totals.pending !== store.settings.adminPending) await saveSettings({ adminPending: state.data.totals.pending });
  } catch (err) { state.error = explainAdmin(err); }
  state.busy = false; renderAdmin(); updateAdminNav();
}
export const refreshAdmin = () => { state.data = null; state.error = ''; };

// The fallback: checks a key with the server and keeps it; this device also gets an invite (a year),
// so it can turn on backup (and then make its backup the admin's).
export async function unlockAdmin(key) {
  state.busy = true; state.error = ''; state.data = null;
  try {
    state.data = await adminApi(`Bearer admin.${key}`).overview();
    await saveSettings({ adminKey: key, invite: store.settings.invite || await inviteToken(key, 365) });
    return true;
  } catch (err) { state.error = explainAdmin(err); return false; } finally { state.busy = false; updateAdminNav(); }
}

// The Admin item in the navigation: shown only on admin devices, with a count of waiting requests.
export function updateAdminNav() {
  const item = document.querySelector('.nav [data-tab="admin"]');
  if (!item) return;
  item.hidden = !isAdminDevice();
  const n = store.settings.adminPending || 0, badge = item.querySelector('.badge');
  badge.textContent = n > 9 ? '9+' : String(n);
  badge.hidden = !n;
  item.setAttribute('aria-label', n ? `Admin, ${plural(n, 'request')} waiting` : 'Admin');
}

export function bindAdmin() {
  const root = el();
  root.addEventListener('submit', async e => {
    if (e.target.id !== 'adm-form') return;
    e.preventDefault();
    const key = $('#adm-key').value.trim();
    if (!key) return;
    state.busy = true; renderAdmin();
    const ok = await unlockAdmin(key);
    renderAdmin();
    if (ok) toast('Admin unlocked on this device.');
  });
  root.addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b) return;
    const ds = b.dataset;
    try {
      if ('refresh' in ds) load();
      else if (ds.approve || ds.reject) {
        b.disabled = true;
        await myAdminApi().decide(ds.approve || ds.reject, ds.approve ? 'approve' : 'reject');
        toast(ds.approve ? 'Approved. Their app offers to turn on backup the next time it opens.' : 'Done.');
        await load();
      }
      else if (ds.ask) { state.confirm = ds.ask; renderAdmin(); }
      else if ('cancel' in ds) { state.confirm = null; renderAdmin(); }
      else if (ds.revoke) { b.disabled = true; await myAdminApi().revoke(ds.revoke); state.confirm = null; toast('Revoked. Their backup is deleted from the server.'); await load(); }
      else if (ds.admin) {
        b.disabled = true;
        await myAdminApi().setAdmin(ds.admin, ds.on === '1');
        toast(ds.on === '1' ? "They're an admin now. The Admin tab appears on their devices after their next sync." : 'No longer an admin.');
        await load();
      }
      else if ('makeMe' in ds) {
        b.disabled = true;
        await myAdminApi().setAdmin(store.vault.vaultId, true);
        await syncNow().catch(() => {});   // the sync tells this device it's the admin now
        toast('Your backup is the admin\'s now. You can forget the key on this device.', null, '', 7000);
        await load();
      }
      else if (ds.days) { state.days = +ds.days; state.link = ''; renderAdmin(); }
      else if ('invite' in ds) { state.link = inviteUrl((await myAdminApi().invite(state.days)).token); renderAdmin(); }
      else if ('copy' in ds) { await navigator.clipboard.writeText(state.link).then(() => toast('Invite link copied'), () => toast('Select the link above to copy it')); }
      else if ('send' in ds) {
        if (navigator.share) await navigator.share({ title: 'Tick', text: 'Tick, a habit tracker. This link lets you turn on cloud backup:', url: state.link }).catch(() => {});
        else await navigator.clipboard.writeText(state.link).then(() => toast('Invite link copied'), () => {});
      }
      else if ('lock' in ds) {
        await saveSettings({ adminKey: null }); state.data = null; state.link = ''; state.error = '';
        updateAdminNav(); render();
        toast('Admin key forgotten on this device');
      }
    } catch (err) {
      if (err?.status) { state.error = explainAdmin(err); renderAdmin(); } else storageError(err);
    }
  });
}
