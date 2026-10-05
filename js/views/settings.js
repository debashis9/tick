import { store, active, archived, byId, saveSettings, setArchived, deleteHabit, moveHabit, eraseAll, tickCount } from '../store.js';
import { view, $, esc, cap, ICON, render, toast, storageError, daysSince, scheduleText, appVersion } from '../ui.js';
import { openEditor } from '../sheets.js';
import { exportBackup, importBackup } from '../backup.js';
import { applyTheme } from '../theme.js';
import { pushProblem, permission, sendTest } from '../push.js';
import { syncNow, explain } from '../sync.js';
import { openTurnOn, openLink, openShowCode, openTurnOff } from '../backup-ui.js';

const el = () => $('#view-settings');
let confirmErase = false;
let installPrompt = null;

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  installPrompt = e;
  if (view.tab === 'settings') renderSettings();
});

const appURL = () => location.origin + location.pathname.replace(/index\.html$/, '');
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

function backupText() {
  const s = store.settings;
  if (!s.lastBackupOn) return 'Saves one file with all your habits and ticks. You haven\'t made a backup yet.';
  const n = daysSince(s.lastBackupOn);
  return `Saves one file with all your habits and ticks. Last backup ${n === 0 ? 'today' : n === 1 ? 'yesterday' : `${n} days ago`}.`;
}

function ago(ms) {
  const mins = Math.round((Date.now() - ms) / 60e3);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} ${mins === 1 ? 'minute' : 'minutes'} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  return `on ${new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
}

function cloudHTML() {
  const v = store.vault;
  const [cls, label] = !v ? ['', 'Off'] : v.lastError ? ['warn', 'Needs attention'] : ['on', 'On'];
  const text = !v ? 'Keeps an encrypted copy of your habits and ticks, and keeps your devices in step. It is locked on this device before it is uploaded, so only your devices can read it.'
    : v.lastError ? v.lastError
    : v.lastSyncAt ? `Backed up ${ago(v.lastSyncAt)}. Encrypted on this device before it is uploaded.`
    : 'Backing up…';
  return `<div class="glabel">Cloud backup</div>
    <div class="group">
      <div class="row"><div class="rt"><div class="rtitle">End-to-end encrypted backup</div><div class="rs">${esc(text)}</div></div>
        <span class="state ${cls}">${label}</span></div>
      ${!v && store.settings.invite ? '<div class="row"><div class="rt"><div class="rs">You have an invite for cloud backup on this device.</div></div></div>' : ''}
      <div class="row wrap actions">${v
        ? '<button class="btn-sm" type="button" data-act="bk-sync">Back up now</button><button class="btn-sm" type="button" data-act="bk-code">Show recovery code</button><button class="btn-sm quiet" type="button" data-act="bk-off">Turn off…</button>'
        : '<button class="btn-sm strong" type="button" data-act="bk-on">Turn on backup</button><button class="btn-sm quiet" type="button" data-act="bk-link">I have a recovery code</button>'}</div>
    </div>`;
}

function remindersHTML(list) {
  const withRem = list.filter(h => h.reminder).sort((a, b) => a.reminder < b.reminder ? -1 : 1);
  const problem = pushProblem(), perm = permission();
  const status = problem ? problem
    : perm === 'denied' ? 'Notifications are blocked for Tick. Allow them in your browser or phone settings.'
    : null;
  return `<div class="glabel">Reminders</div>
    <div class="group">
      ${withRem.map(h => `<div class="row" style="--c:var(--h-${h.color})"><span class="ico sm" aria-hidden="true">${esc(h.icon)}</span>
        <div class="rt"><div class="rtitle">${esc(h.name)}</div><div class="rs">${h.reminder} · ${esc(scheduleText(h))}</div></div>
        <button class="btn-sm" type="button" data-edit="${h.id}">Edit</button></div>`).join('')}
      ${withRem.length ? '' : '<div class="row"><div class="rt"><div class="rtitle">No reminders</div><div class="rs">Edit a habit to get a notification at a set time on the days it\'s due.</div></div></div>'}
      ${status ? `<div class="row"><div class="rt"><div class="rs">${esc(status)}</div></div></div>` : ''}
      ${withRem.length && perm === 'granted' ? '<div class="row"><div class="rt"><div class="rtitle">Send a test</div><div class="rs">Checks that reminders reach this device.</div></div><button class="btn-sm" type="button" data-act="test-push">Send</button></div>' : ''}
      <div class="row"><div class="rt"><div class="rs">To send reminders, the Tick server keeps this device's push address, your reminder times and time zone. It never learns your habits or ticks. Turning off every reminder deletes what it keeps.</div></div></div>
    </div>`;
}

export function renderSettings() {
  const s = store.settings;
  const list = active(), arch = archived(), ticks = tickCount();
  el().innerHTML = `
    <header class="head"><div><div class="eyebrow">Tick</div><h1>Settings</h1></div></header>

    <div class="glabel">Habits</div>
    <div class="group">
      ${list.map((h, i) => `<div class="row habit-row" style="--c:var(--h-${h.color})">
        <span class="ico sm" aria-hidden="true">${esc(h.icon)}</span>
        <div class="rt"><div class="rtitle">${esc(h.name)}</div></div>
        <button class="iconbtn" type="button" data-move="${h.id}" data-dir="-1" aria-label="Move ${esc(h.name)} up" ${i === 0 ? 'disabled' : ''}>${ICON.up}</button>
        <button class="iconbtn" type="button" data-move="${h.id}" data-dir="1" aria-label="Move ${esc(h.name)} down" ${i === list.length - 1 ? 'disabled' : ''}>${ICON.down}</button>
        <button class="btn-sm" type="button" data-edit="${h.id}">Edit</button></div>`).join('')}
      <div class="row"><button class="btn-sm" type="button" data-act="new">+ New habit</button></div>
    </div>

    ${arch.length ? `<div class="glabel">Archived habits</div><div class="group">${arch.map(h => `
      <div class="row"><span class="ico sm" aria-hidden="true" style="--c:var(--h-${h.color})">${esc(h.icon)}</span>
      <div class="rt"><div class="rtitle">${esc(h.name)}</div><div class="rs">Hidden from Today. History kept.</div></div>
      <button class="btn-sm" type="button" data-unarchive="${h.id}">Restore</button>
      <button class="btn-sm danger" type="button" data-delete="${h.id}">Delete</button></div>`).join('')}</div>` : ''}

    ${remindersHTML(list)}

    <div class="glabel">Invite</div>
    <div class="group"><div class="row invite"><div class="qr" id="qr" role="img" aria-label="QR code for the app link"></div>
      <div class="rt"><div class="rtitle">Invite someone</div>
      <div class="rs">They scan this code or open the link. They get their own copy of the app, and nothing they track is shared with you.</div>
      <div class="linkrow"><code>${esc(appURL())}</code>
        ${navigator.share ? '<button class="btn-sm" type="button" data-act="share">Share</button>' : ''}
        <button class="btn-sm" type="button" data-act="copy">Copy link</button></div></div></div></div>

    ${cloudHTML()}

    <div class="glabel">Your data</div>
    <div class="group">
      <div class="row"><div class="rt"><div class="rtitle">Back up to a file</div><div class="rs">${backupText()}</div></div>
        <button class="btn-sm" type="button" data-act="backup">Back up</button></div>
      <div class="row"><div class="rt"><div class="rtitle">Restore from a backup</div><div class="rs">Adds habits and ticks from a backup file. Nothing you have is overwritten.</div></div>
        <label class="btn-sm" for="restore-file">Choose file</label>
        <input type="file" id="restore-file" accept="application/json,.json" hidden></div>
      <div class="row"><div class="rt"><div class="rs">Stored on this device${store.vault ? ' and encrypted in your cloud backup' : ' only'} · ${list.length} ${list.length === 1 ? 'habit' : 'habits'} · ${ticks} ${ticks === 1 ? 'tick' : 'ticks'}</div></div></div>
    </div>

    <div class="glabel">Preferences</div>
    <div class="group">
      <form class="row wrap" id="name-set" autocomplete="off"><div class="rt"><label class="rtitle" for="set-name">Your name</label><div class="rs">Tick uses it to say hello. It stays on this device.</div></div>
        <div class="inline"><input class="text-in sm" id="set-name" maxlength="40" autocomplete="given-name" placeholder="Your first name" value="${esc(s.name)}"><button class="btn-sm" type="submit">Save</button></div></form>
      <div class="row wrap"><div class="rt"><div class="rtitle">Theme</div></div>
        <div class="seg">${['system', 'light', 'dark'].map(t => `<button type="button" data-theme-set="${t}" aria-pressed="${s.theme === t}">${cap(t)}</button>`).join('')}</div></div>
      <div class="row wrap"><div class="rt"><div class="rtitle">Week starts on</div></div>
        <div class="seg"><button type="button" data-ws="1" aria-pressed="${s.weekStart === 1}">Monday</button><button type="button" data-ws="0" aria-pressed="${s.weekStart === 0}">Sunday</button></div></div>
    </div>

    <div class="glabel">Install on your phone</div>
    <div class="group">
      ${isStandalone() ? '<div class="row"><div class="rt"><div class="rtitle">Installed</div><div class="rs">You\'re using the installed app.</div></div></div>' : ''}
      ${installPrompt ? '<div class="row"><div class="rt"><div class="rtitle">Install Tick</div><div class="rs">Adds Tick to your home screen or app list.</div></div><button class="btn-sm" type="button" data-act="install">Install</button></div>' : ''}
      <div class="row"><div class="rt"><div class="rtitle">iPhone and iPad</div><div class="rs">In Safari, tap Share, then Add to Home Screen. Do this to keep your history safe: Safari clears a website's data after 7 days without a visit, but home-screen apps are exempt.</div></div></div>
      <div class="row"><div class="rt"><div class="rtitle">Android</div><div class="rs">In Chrome, open the menu and tap Install app (or Add to Home screen).</div></div></div>
      <div class="row"><div class="rt"><div class="rtitle">Computer</div><div class="rs">In Chrome or Edge, click the install icon at the right of the address bar.</div></div></div>
    </div>

    <div class="glabel">Privacy</div>
    <div class="group">
      <div class="row"><div class="rt"><div class="rs">Only your devices can read what you track. Tick has no accounts and no analytics, and no server ever receives your habits or ticks in a form it can read. Two things use a server: reminders (see Reminders above) and cloud backup, if you turn it on.</div></div></div>
      <div class="row"><div class="rt"><div class="rs">With cloud backup on, each habit and tick is encrypted on this device with a key made from your recovery code before it is uploaded. The server stores only encrypted data. It can see that a backup exists, how many records it has, and when your devices sync. It can't see your habits' names, which days you ticked, or amounts and kinds.</div></div></div>
      <div class="row"><div class="rt"><div class="rtitle">Erase all data</div><div class="rs">Removes every habit and tick from this device.${store.vault ? ' Cloud backup is turned off here; the cloud copy is kept, and you can open it again with your recovery code.' : ''}</div></div>
        <button class="btn-sm danger" type="button" data-act="erase">${confirmErase ? 'Tap again to erase' : 'Erase'}</button></div>
    </div>

    ${s.adminKey ? `<div class="glabel">Admin</div>
    <div class="group"><div class="row"><div class="rt"><div class="rtitle">Admin page</div><div class="rs">Invite links for cloud backup, and what the server holds.</div></div>
      <a class="btn-sm" href="#admin">Open</a></div></div>` : ''}
    ${appVersion.text ? `<p class="foot" id="set-version">This is Tick ${esc(appVersion.text)}.</p>` : ''}`;
  if (window.QRCode) {
    try {
      new window.QRCode($('#qr'), { text: appURL(), width: 96, height: 96, colorDark: '#161A17', colorLight: '#FFFFFF', correctLevel: window.QRCode.CorrectLevel.M });
    } catch { /* the link and Copy button still work */ }
  }
}

export function bindSettings() {
  const root = el();
  root.addEventListener('submit', async e => {
    if (e.target.id !== 'name-set') return;
    e.preventDefault();
    try {
      const name = $('#set-name').value.trim().slice(0, 40);
      await saveSettings({ name, nameAsked: true });
      toast(name ? `Saved. Hello, ${name}.` : 'Name removed.');
      renderSettings();
    } catch (err) { storageError(err); }
  });
  root.addEventListener('change', e => {
    if (e.target.id !== 'restore-file') return;
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) importBackup(file);
  });
  root.addEventListener('click', async e => {
    const t = e.target;
    try {
      const th = t.closest('[data-theme-set]');
      if (th) { await saveSettings({ theme: th.dataset.themeSet }); applyTheme(th.dataset.themeSet); return renderSettings(); }
      const w = t.closest('[data-ws]');
      if (w) { await saveSettings({ weekStart: Number(w.dataset.ws) }); view.cal.weekOf = null; return renderSettings(); }
      const edit = t.closest('[data-edit]');
      if (edit) return openEditor(edit.dataset.edit);
      const mv = t.closest('[data-move]');
      if (mv) { await moveHabit(byId(mv.dataset.move), Number(mv.dataset.dir)); return renderSettings(); }
      const ua = t.closest('[data-unarchive]');
      if (ua) { const h = byId(ua.dataset.unarchive); await setArchived(h, false); toast(`Restored ${h.name}`); return renderSettings(); }
      const del = t.closest('[data-delete]');
      if (del) {
        if (del.dataset.confirm !== 'yes') { del.dataset.confirm = 'yes'; del.textContent = 'Tap again'; return; }
        const h = byId(del.dataset.delete);
        const undo = await deleteHabit(h);
        renderSettings();
        return toast(`Deleted ${h.name}`, async () => { await undo(); render(); });
      }
      const act = t.closest('[data-act]')?.dataset.act;
      if (act === 'new') return openEditor(null);
      if (act === 'test-push') {
        try { await sendTest(); toast('Test sent. It should arrive in a few seconds.'); }
        catch (e) { console.warn(e); toast(navigator.onLine ? "Couldn't send a test. Try again later." : 'Connect to the internet to send a test.'); }
        return;
      }
      if (act === 'bk-on') return openTurnOn();
      if (act === 'bk-link') return openLink();
      if (act === 'bk-code') return openShowCode();
      if (act === 'bk-off') return openTurnOff();
      if (act === 'bk-sync') {
        const b = t.closest('[data-act]');
        b.disabled = true; b.textContent = 'Backing up…';
        try { await syncNow(); toast('Backed up.'); } catch (e) { toast(explain(e), null, '', 6000); }
        return renderSettings();
      }
      if (act === 'backup') { await exportBackup(); return renderSettings(); }
      if (act === 'share') {
        try { await navigator.share({ title: 'Tick', text: 'A simple habit tracker. Your data stays on your phone.', url: appURL() }); } catch { /* cancelled */ }
        return;
      }
      if (act === 'copy') {
        try { await navigator.clipboard.writeText(appURL()); toast('Link copied'); }
        catch { toast('Select the link above to copy it'); }
        return;
      }
      if (act === 'install' && installPrompt) {
        installPrompt.prompt();
        await installPrompt.userChoice;
        installPrompt = null;
        return renderSettings();
      }
      if (act === 'erase') {
        if (!confirmErase) { confirmErase = true; return renderSettings(); }
        confirmErase = false;
        const undo = await eraseAll();
        view.cal.filter = 'all';
        renderSettings();
        return toast('Erased all data', async () => { await undo(); render(); }, 'Undo', 6000);
      }
    } catch (err) {
      storageError(err);
    }
  });
}

export const resetSettingsConfirm = () => { confirmErase = false; };
