// The admin page (#admin): for whoever runs this copy of Tick. Unlocked with the server's admin
// key, on this device only. It makes invite links for cloud backup and shows how many backups
// the server holds and how big they are. It can't see inside any backup: nobody can without
// that backup's recovery code.

import { store, saveSettings } from '../store.js';
import { fetchStats, inviteToken, inviteUrl, explainAdmin } from '../admin.js';
import { key as dateKey, parse, DAY_SHORT, MON_SHORT } from '../dates.js';
import { $, esc, toast, storageError } from '../ui.js';

const el = () => $('#view-admin');
const state = { stats: null, error: '', busy: false, link: '', days: 14 };
const size = b => (b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${(b / 1024).toFixed(b < 10240 ? 1 : 0)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);
const day = ms => { const d = parse(dateKey(new Date(ms))); return `${DAY_SHORT[d.getDay()]} ${d.getDate()} ${MON_SHORT[d.getMonth()]} ${d.getFullYear()}`; };

function unlocked() {
  const s = state.stats;
  const table = !s ? '' : !s.list.length ? '<div class="row"><div class="rt"><div class="rtitle">No backups yet</div><div class="rs">They appear here once someone turns cloud backup on.</div></div></div>'
    : `<div class="scrollx"><table class="tbl"><tr><th>Backup</th><th>Records</th><th>Size</th><th>Created</th><th>Last change</th></tr>
        ${s.list.map(v => `<tr><td><code>${esc(v.id)}…</code></td><td>${v.records}</td><td>${size(v.bytes)}</td><td>${esc(day(v.createdAt))}</td><td>${esc(day(v.usedAt))}</td></tr>`).join('')}</table></div>
      ${s.vaults > s.list.length ? `<div class="row"><div class="rt"><div class="rs">Showing the ${s.list.length} most recently changed.</div></div></div>` : ''}`;
  return `<div class="glabel">Invite links</div>
    <div class="group">
      <div class="row"><div class="rt"><div class="rs">Anyone can use Tick on their own device. An invite lets a person turn on <em>cloud backup</em> on this server. This device already has one.</div></div></div>
      <div class="row wrap"><div class="seg" role="group" aria-label="Valid for">${[7, 14, 30, 90].map(d => `<button type="button" data-days="${d}" aria-pressed="${state.days === d}">${d} days</button>`).join('')}</div>
        <button type="button" class="btn-sm strong" id="adm-invite">Make an invite link</button></div>
      ${state.link ? `<div class="row"><div class="rt"><div class="linkbox" id="adm-link">${esc(state.link)}</div>
          <div class="linkrow"><button type="button" class="btn-sm" id="adm-send">Send it</button><button type="button" class="btn-sm" id="adm-copy">Copy</button></div>
          <div class="rs">Works for anyone who opens it until it runs out in ${state.days} days. The server keeps no list of who was invited.</div></div></div>` : ''}
    </div>
    <div class="glabel row-label">Backups on the server <button type="button" class="btn-sm" id="adm-refresh" ${state.busy ? 'disabled' : ''}>${state.busy ? 'Loading…' : 'Refresh'}</button></div>
    ${state.error ? `<div class="notice bad"><span>${esc(state.error)}</span></div>` : ''}
    <div class="group">
      ${s ? `<div class="stat3"><div><b>${s.vaults}</b><span>${s.vaults === 1 ? 'backup' : 'backups'}</span></div><div><b>${s.records}</b><span>encrypted records</span></div><div><b>${size(s.bytes)}</b><span>stored</span></div></div>` : ''}
      ${table}
      <div class="row"><div class="rt"><div class="rs">This is everything the server knows: that a backup exists, how many records it has, their size and when it last changed. Habit names, days and ticks are encrypted with a key that only the person's recovery code carries, so they can't be shown here or anywhere else. Each backup may hold up to ${s ? size(s.quota) : '25 MB'}. Reminders are kept separately and aren't shown.</div></div></div>
    </div>
    <button type="button" class="btn-sm wide" id="adm-lock">Lock the admin page on this device</button>`;
}

export function renderAdmin() {
  const open = !!store.settings.adminKey;
  el().innerHTML = `
    <header class="head"><div><a class="eyebrow back" href="#settings">‹ Settings</a><h1>Admin</h1></div></header>
    ${open ? unlocked() : `<form class="group welcome" id="adm-form" autocomplete="off">
      <p class="rs">For the person who runs this copy of Tick. Enter the admin key (the server's <code>INVITE_SECRET</code>) to make invite links for cloud backup and see how many backups the server holds.</p>
      <label class="rtitle" for="adm-key">Admin key</label>
      <div class="inline"><input class="text-in" id="adm-key" type="password" autocapitalize="off" spellcheck="false" required>
        <button class="btn-sm strong" ${state.busy ? 'disabled' : ''}>${state.busy ? 'Checking…' : 'Unlock'}</button></div>
      ${state.error ? `<p class="err" role="alert">${esc(state.error)}</p>` : ''}
      <p class="fnote">The key stays on this device and is only ever sent to this site.</p></form>`}`;
  if (open && !state.stats && !state.busy && !state.error) load();
}

async function load() {
  state.busy = true; state.error = ''; renderAdmin();
  try { state.stats = await fetchStats(store.settings.adminKey); } catch (err) { state.error = explainAdmin(err); }
  state.busy = false; renderAdmin();
}

// Checks a key with the server, keeps it, and gives this device an invite of its own (a year),
// so the admin can turn on backup without making themselves a link first.
export async function unlockAdmin(key) {
  state.busy = true; state.error = ''; state.stats = null;
  try {
    state.stats = await fetchStats(key);
    await saveSettings({ adminKey: key, invite: await inviteToken(key, 365) });
    return true;
  } catch (err) { state.error = explainAdmin(err); return false; } finally { state.busy = false; }
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
    if (ok) toast('Admin unlocked on this device. You can now turn on cloud backup too.', null, '', 7000);
  });
  root.addEventListener('click', async e => {
    const hit = s => e.target.closest(s);
    let b;
    try {
      if ((b = hit('[data-days]'))) { state.days = +b.dataset.days; state.link = ''; renderAdmin(); }
      else if (hit('#adm-invite')) { state.link = inviteUrl(await inviteToken(store.settings.adminKey, state.days)); renderAdmin(); }
      else if (hit('#adm-copy')) { await navigator.clipboard.writeText(state.link).catch(() => {}); toast('Invite link copied'); }
      else if (hit('#adm-send')) {
        if (navigator.share) await navigator.share({ title: 'Tick invite', text: 'An invite to turn on cloud backup in Tick:', url: state.link }).catch(() => {});
        else { await navigator.clipboard.writeText(state.link).catch(() => {}); toast('Invite link copied'); }
      }
      else if (hit('#adm-refresh')) load();
      else if (hit('#adm-lock')) { await saveSettings({ adminKey: null }); state.stats = null; state.link = ''; state.error = ''; renderAdmin(); toast('Admin page locked on this device'); }
    } catch (err) { storageError(err); }
  });
}
