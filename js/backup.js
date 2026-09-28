// Backup = one JSON file the user keeps. It's also how someone moves to a new phone.

import { todayKey } from './dates.js';
import { exportData, previewImport, applyImport, saveSettings } from './store.js';
import { ICON, plural, openSheet, render, toast, storageError } from './ui.js';

// Returns true once a backup was handed to the user.
export async function exportBackup() {
  const name = `tick-backup-${todayKey()}.json`;
  const blob = new Blob([JSON.stringify(exportData(), null, 1)], { type: 'application/json' });
  let delivered = false;

  // On phones, the share sheet lets people save to Files, Drive or email.
  const file = new File([blob], name, { type: 'application/json' });
  if (matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Tick backup' });
      delivered = true;
    } catch (e) {
      if (e.name === 'AbortError') return false;
    }
  }
  if (!delivered) {
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  try {
    await saveSettings({ lastBackupOn: todayKey(), backupSnoozedUntil: null });
  } catch (e) { storageError(e); }
  toast(`Saved ${name}`);
  return true;
}

export async function importBackup(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    return toast("That file couldn't be read. Choose a Tick backup (.json).", null, '', 6000);
  }
  const p = previewImport(data);
  if (p.error) return toast(p.error, null, '', 6000);
  if (!p.habits.length && !p.checks.length) return toast('Everything in this backup is already here.');
  const parts = [p.habits.length && plural(p.habits.length, 'habit'), p.checks.length && plural(p.checks.length, 'tick')].filter(Boolean);
  const sheet = openSheet(`<div class="grab"></div>
    <div class="sheet-head"><h2>Restore from backup</h2><button class="x" type="button" data-close aria-label="Close">${ICON.x}</button></div>
    <p class="sub">This adds ${parts.join(' and ')}${data.exportedOn ? ` from a backup made on ${data.exportedOn}` : ''}. Nothing you have now is changed or removed.</p>
    <button class="btn-primary" type="button" data-restore>Restore</button>
    <button class="btn-sm" type="button" data-close>Cancel</button>`, async (e, close) => {
    if (!e.target.closest('[data-restore]')) return;
    try {
      await applyImport(p);
      close(); render();
      toast(`Restored ${parts.join(' and ')}`);
    } catch (err) { storageError(err); }
  });
  return sheet;
}
