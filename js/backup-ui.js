// The cloud backup sheets: turning it on (save the code, check it), linking another device,
// showing the code again, and turning it off.

import { store, saveSettings } from './store.js';
import { formatCode, normalizeCode } from './crypto.js';
import { newCode, turnOn, link, turnOff, explain, requestBackup } from './sync.js';
import { ICON, openSheet, esc, toast, render, plural } from './ui.js';

const head = title => `<div class="grab"></div>
  <div class="sheet-head"><h2>${title}</h2><button class="x" type="button" data-close aria-label="Close">${ICON.x}</button></div>`;
const steps = n => `<div class="steps" aria-hidden="true">${[1, 2, 3].map(i => `<i class="${i <= n ? 'on' : ''}"></i>`).join('')}</div>`;

function qrInto(el, text) {
  if (!el) return;
  el.innerHTML = '';
  try {
    // qrcodejs draws into the element; the white box keeps it scannable in dark mode.
    new window.QRCode(el, { text, width: 360, height: 360, colorDark: '#161A17', colorLight: '#FFFFFF', correctLevel: window.QRCode.CorrectLevel.M });
  } catch { el.hidden = true; }
}

const whatServerSees = `<div class="seebox">
  <div><h3>The server can't see</h3><ul><li>Your habits' names</li><li>Which days you ticked</li><li>Amounts and kinds</li></ul></div>
  <div><h3>The server can see</h3><ul><li>That a backup exists</li><li>How many records it has</li><li>When your devices sync</li></ul></div></div>`;

export function openTurnOn() {
  let code = null;
  const s1 = () => `${head('Turn on encrypted backup')}${steps(1)}
    <p class="sub">Your habits and ticks are locked on this device with a new key before anything is uploaded. Only your devices ever have the key, so nobody else can read them, including whoever runs Tick.</p>
    ${whatServerSees}
    <button type="button" class="btn-primary" data-next="2">Continue</button>`;
  const s2 = () => `${head('Save your recovery code')}${steps(2)}
    <p class="sub">This code is the key to your backup. You need it to open Tick on another phone or computer. Nobody can reset it for you.</p>
    <div class="code" id="code" tabindex="0">${esc(formatCode(code))}</div>
    <div class="qr-code" id="qr-code" aria-label="QR code of your recovery code" role="img"></div>
    <button type="button" class="btn-sm" data-copy>Copy code</button>
    <p class="warn">Keep it in a password manager, or write it down and keep it somewhere safe. If you lose this code <i>and</i> all your devices, the backup can't be opened by anyone.</p>
    <button type="button" class="btn-primary" data-next="3">I've saved it</button>`;
  const s3 = () => `${head('Check the code')}${steps(3)}
    <p class="sub">Type the last group of 4 from your saved code, so we know it was saved correctly.</p>
    <div class="field"><label class="flabel" for="last4">Last 4 characters</label>
      <input class="text-in codein" id="last4" maxlength="6" autocomplete="off" autocapitalize="characters" spellcheck="false"></div>
    <p class="err" id="bk-err" role="alert" hidden></p>
    <button type="button" class="btn-primary" data-go>Turn on backup</button>
    <button type="button" class="btn-sm" data-next="2">Show code</button>`;

  const sheet = openSheet(`${head('Turn on encrypted backup')}<p class="sub">Making a key…</p>`, async (ev, close, scrim) => {
    const b = ev.target.closest('button');
    if (!b || !code) return;
    if (b.dataset.next) {
      sheet.setBody(b.dataset.next === '2' ? s2() : s3());
      qrInto(scrim.querySelector('#qr-code'), 'tick:' + code);
      scrim.querySelector('#last4')?.focus();
      return;
    }
    if ('copy' in b.dataset) {
      try { await navigator.clipboard.writeText(formatCode(code)); toast('Code copied. Paste it somewhere safe.'); }
      catch {
        const r = document.createRange();
        r.selectNodeContents(scrim.querySelector('#code'));
        getSelection().removeAllRanges();
        getSelection().addRange(r);
        toast('Code selected. Copy it from there.');
      }
      return;
    }
    if ('go' in b.dataset) {
      const err = scrim.querySelector('#bk-err');
      if (normalizeCode(scrim.querySelector('#last4').value) !== code.slice(-4)) {
        err.textContent = "That doesn't match the last 4 characters of your code. Check your saved copy, or tap Show code.";
        err.hidden = false;
        return;
      }
      b.disabled = true; b.textContent = 'Encrypting and uploading…';
      try {
        const r = await turnOn(code);
        close(); render();
        toast(`Backup is on. ${plural(r?.pushed || 0, 'record')} encrypted and uploaded.`);
      } catch (e) {
        err.textContent = store.vault ? `Backup is on, but the first upload didn't finish: ${explain(e)}` : explain(e);
        err.hidden = false; b.disabled = false; b.textContent = 'Try again';
        if (store.vault) { close(); render(); }
      }
    }
  });
  sheet.scrim.addEventListener('keydown', ev => {
    if (ev.key === 'Enter' && ev.target.id === 'last4') { ev.preventDefault(); sheet.scrim.querySelector('[data-go]').click(); }
  });
  newCode().then(c => { code = c; sheet.setBody(s1()); });
}

export function openLink() {
  openSheet(`${head('Open your backup here')}
    <p class="sub">Type the recovery code from your other device (Settings → Cloud backup → Show recovery code). Spaces and capitals don't matter.</p>
    <div class="field"><label class="flabel" for="linkcode">Recovery code</label>
      <textarea class="text-in codein" id="linkcode" rows="2" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="7KQM X9PD 4TRW …"></textarea></div>
    <p class="fnote">Habits already on this device are kept. One with the same name as a habit in your backup is combined with it: its ticks move to the older of the two.</p>
    <p class="err" id="bk-err" role="alert" hidden></p>
    <button type="button" class="btn-primary" data-link>Open backup</button>`, async (ev, close, scrim) => {
    const b = ev.target.closest('[data-link]');
    if (!b) return;
    const err = scrim.querySelector('#bk-err');
    b.disabled = true; b.textContent = 'Downloading and unlocking…';
    try {
      const r = await link(scrim.querySelector('#linkcode').value);
      close(); render();
      toast(`Backup opened. ${plural(r?.pulled || 0, 'record')} downloaded.`);
    } catch (e) {
      // A mistyped code has its own message; anything else is about the server.
      err.textContent = store.vault ? `Backup is linked, but the first sync didn't finish: ${explain(e)}`
        : e.name === 'Error' && !e.status ? e.message : explain(e);
      err.hidden = false; b.disabled = false; b.textContent = 'Try again';
      if (store.vault) { close(); render(); }
    }
  });
  setTimeout(() => document.querySelector('#linkcode')?.focus(), 60);
}

export function openShowCode() {
  const code = store.vault.code;
  const sheet = openSheet(`${head('Your recovery code')}
    <p class="sub">To open Tick on another device, install it there, go to Settings → Cloud backup → <b>I have a recovery code</b>, and type this code.</p>
    <div class="code" id="code" tabindex="0">${esc(formatCode(code))}</div>
    <div class="qr-code" id="qr-code" aria-label="QR code of your recovery code" role="img"></div>
    <p class="warn">Anyone with this code can read your habits and ticks. Show it only on your own devices.</p>`);
  qrInto(sheet.scrim.querySelector('#qr-code'), 'tick:' + code);
}

export function openTurnOff() {
  openSheet(`${head('Turn off backup')}
    <p class="sub">Your habits and ticks stay on this device either way.</p>
    <div class="choice"><button type="button" class="btn-sm" data-off="keep">Turn off on this device</button>
      <p class="fnote">The cloud copy stays, and your other devices keep backing up. You can open it again with your recovery code.</p></div>
    <div class="choice"><button type="button" class="btn-sm danger" data-off="delete">Delete the cloud copy</button>
      <p class="fnote">Removes the backup from the server for every device. This can't be undone.</p></div>
    <p class="err" id="bk-err" role="alert" hidden></p>`, async (ev, close, scrim) => {
    const b = ev.target.closest('[data-off]');
    if (!b) return;
    if (b.dataset.off === 'delete' && b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Tap again to delete it for good'; return; }
    try {
      await turnOff({ deleteCloud: b.dataset.off === 'delete' });
      close(); render();
      toast(b.dataset.off === 'delete' ? 'Deleted the cloud backup. Your habits are still on this device.' : 'Backup is off on this device.');
    } catch (e) {
      const err = scrim.querySelector('#bk-err');
      err.textContent = explain(e); err.hidden = false;
    }
  });
}

// ---------- asking for cloud backup ----------
// The name and note go to the admin; an invite link (pasted here, for iPhones where the Home
// Screen app doesn't share Safari's storage) skips the wait. As in Sol.
export function openRequest() {
  const r = store.settings.request;
  const sheet = openSheet(`${head('Ask for cloud backup')}
    <p class="sub">Cloud backup is for people the person who runs Tick knows. Your name and a line about how they know you go to them. Once they approve, you can turn backup on here.</p>
    <form id="rq-form" class="rq" novalidate>
      <div class="field"><label class="flabel" for="rq-name">Your name</label>
        <input class="text-in" id="rq-name" maxlength="60" autocomplete="name" value="${esc(store.settings.name)}"></div>
      <div class="field"><label class="flabel" for="rq-note">How do they know you? <em>optional</em></label>
        <input class="text-in" id="rq-note" maxlength="300" placeholder="e.g. from the running club"></div>
      <p class="err" id="rq-err" role="alert" hidden></p>
      <button class="btn-primary" type="submit">${r?.status === 'rejected' ? 'Ask again' : 'Send request'}</button>
    </form>
    <details class="more-invite"><summary>I have an invite link</summary>
      <div class="field"><label class="flabel" for="rq-invite">Paste the invite link</label>
        <input class="text-in" id="rq-invite" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="https://tick…/?invite=…"></div>
      <button type="button" class="btn-sm" data-useinvite>Use invite</button></details>`, async (ev, close, scrim) => {
    if (!ev.target.closest('[data-useinvite]')) return;
    const raw = scrim.querySelector('#rq-invite').value.trim();
    const token = (/[?&]invite=([\w-]+\.[\w-]+)/.exec(raw) || /^([\w-]+\.[\w-]+)$/.exec(raw))?.[1];
    if (!token) return toast("That doesn't look like a Tick invite link.");
    await saveSettings({ invite: token });
    close(); render();
    toast('Invite saved. You can turn on backup now.');
  });
  sheet.scrim.querySelector('#rq-form').addEventListener('submit', async ev => {
    ev.preventDefault();
    const root = sheet.scrim, err = root.querySelector('#rq-err'), name = root.querySelector('#rq-name').value.trim();
    if (!name) { err.textContent = 'Add your name, so they know who is asking.'; err.hidden = false; return; }
    const b = root.querySelector('#rq-form button'); b.disabled = true; b.textContent = 'Sending…';
    try {
      if (!store.settings.name) await saveSettings({ name, nameAsked: true });
      const status = await requestBackup(name, root.querySelector('#rq-note').value.trim());
      sheet.close(); render();
      toast(status === 'approved' ? "You're already approved. Turn on backup in Settings." : 'Request sent. Tick checks for an answer each time you open it.');
    } catch (e) { err.textContent = explain(e); err.hidden = false; b.disabled = false; b.textContent = 'Try again'; }
  });
  setTimeout(() => sheet.scrim.querySelector(store.settings.name ? '#rq-note' : '#rq-name')?.focus(), 60);
}
