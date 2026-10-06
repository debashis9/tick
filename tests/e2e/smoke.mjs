import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
// End-to-end smoke test. Not part of `npm test` (it needs a browser):
//   npm i --no-save playwright-core
//   npm run dev          # in another terminal: the app and the Worker on :8788, with a local D1
//   WRANGLER="npx wrangler" PERSIST_TO=~/.cache/tick-wrangler CHROME_PATH=/path/to/chrome node tests/e2e/smoke.mjs
// Against a plain static server (npm run serve, APP_URL=http://localhost:8420/) there is no
// backup API, and the cloud backup checks report SKIP.
const SP = process.env.OUT_DIR || os.tmpdir(), URL = process.env.APP_URL || 'http://localhost:8788/';
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, args: ['--no-sandbox'] });
const results = [];
const check = (name, ok, extra = '') => { results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };
const skip = name => { results.push(`SKIP ${name}`); };
const hasApi = await fetch(URL + 'api/sync').then(r => r.status === 401, () => false);

const errors = [];
async function device(label) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${label} pageerror: ${e.message}`));
  // Test contexts are incognito, where Chrome logs that it has no Push API; real installs do.
  // Chrome also logs every /api/ response that isn't a success (the blank page used to prepare
  // a database, the favicon it asks for, and the backup server refusing a vault without an invite).
  page.on('console', m => { if (m.type() === 'error' && !m.text().includes('Push API in incognito') && !(m.text().includes('Failed to load resource') && /\/api\/|\/favicon\.ico$/.test(m.location().url))) errors.push(`${label} console: ${m.text()} ${m.location().url}`); });
  return { ctx, page };
}
const pad = n => String(n).padStart(2, '0');
const dayKey = (back = 0) => { const d = new Date(); d.setDate(d.getDate() - back); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const serviceWorker = async ctx => ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 5000 }).catch(() => null);
// Everything in the app's database, as the page sees it.
const dumpDB = page => page.evaluate(() => new Promise((resolve, reject) => {
  const r = indexedDB.open('tick');
  r.onerror = () => reject(r.error);
  r.onsuccess = async () => {
    const db = r.result, out = { version: db.version, stores: [...db.objectStoreNames] };
    for (const name of out.stores) out[name] = await new Promise(res => { db.transaction(name).objectStore(name).getAll().onsuccess = e => res(e.target.result); });
    db.close();
    resolve(out);
  };
}));

// ---------- upgrade: a database made by the version before cloud backup ----------
// The app is installed (so its service worker is running), then its database is replaced with a
// version 1 database, as an existing install has when this update reaches it.
{
  const { ctx, page: pu } = await device('upgrade');
  await ctx.grantPermissions(['notifications']);
  await pu.goto(URL);
  await pu.waitForSelector('.card');
  const sw = await serviceWorker(ctx);
  await pu.waitForFunction(() => navigator.serviceWorker?.controller || null, null, { timeout: 5000 }).catch(() => {});
  await pu.goto(URL + 'api/blank');   // same origin, no app code (the service worker leaves /api/ alone)
  const days = [dayKey(3), dayKey(2), dayKey(1)];
  await pu.evaluate(({ days }) => new Promise((resolve, reject) => {
    const del = indexedDB.deleteDatabase('tick');
    del.onerror = del.onblocked = () => reject(new Error('could not delete the database'));
    del.onsuccess = () => {
      const r = indexedDB.open('tick', 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        db.createObjectStore('habits', { keyPath: 'id' });
        db.createObjectStore('checks', { keyPath: ['habitId', 'date'] }).createIndex('habitId', 'habitId');
        db.createObjectStore('settings', { keyPath: 'id' });
      };
      r.onerror = () => reject(r.error);
      r.onsuccess = () => {
        const db = r.result, t = db.transaction(['habits', 'checks', 'settings'], 'readwrite');
        const habit = (id, name, order, extra) => ({ id, name, icon: '📖', color: 'blue', schedule: { type: 'daily', days: [] }, kinds: [], goal: null, reminder: null, order, createdOn: days[0], archivedOn: null, ...extra });
        t.objectStore('habits').put(habit('hwalk', 'Walk / Jog / Run', 0, { kinds: ['Walk', 'Jog', 'Run'], color: 'green', reminder: '00:00' }));
        t.objectStore('habits').put(habit('hread', 'Read a book', 1, { goal: { amount: 20, unit: 'pages' } }));
        t.objectStore('checks').put({ habitId: 'hwalk', date: days[1], at: Date.now() - 2 * 864e5, kind: 'Jog' });
        t.objectStore('checks').put({ habitId: 'hwalk', date: days[2], at: Date.now() - 864e5 });
        t.objectStore('checks').put({ habitId: 'hread', date: days[2], at: Date.now() - 864e5, amount: 22 });
        t.objectStore('settings').put({ id: 'app', weekStart: 0, theme: 'dark', seeded: true, firstUsedOn: days[0], lastBackupOn: days[1], backupSnoozedUntil: null, installTipDismissed: true, pushSynced: null, schemaVersion: 2 });
        t.oncomplete = () => { db.close(); resolve(); };
        t.onerror = () => reject(t.error);
      };
    };
  }), { days });

  // The updated service worker can run before the page has upgraded the database.
  if (sw) {
    const shown = await sw.evaluate(async today => {
      await markDone('hread', today);
      await remind();
      const ns = await self.registration.getNotifications();
      ns.forEach(n => n.close());
      return ns.map(n => `${n.title} | ${n.body}`);
    }, dayKey());
    check('service worker reads a version 1 database', shown.length === 1 && shown[0].includes('Walk / Jog / Run'), shown.join(' / '));
    const v1 = await dumpDB(pu);
    check('service worker leaves the database at version 1', v1.version === 1 && v1.checks.length === 4 && v1.checks.some(c => c.date === dayKey() && c.updatedAt > 0));
  } else check('service worker available for the upgrade check', false);

  await pu.goto(URL);
  await pu.waitForSelector('.card');
  const after = await dumpDB(pu);
  check('database upgrades to version 2 with the new stores', after.version === 2 && ['dirty', 'local'].every(n => after.stores.includes(n)), after.stores.join(', '));
  check('upgrade keeps every habit and tick', after.habits.length === 2 && after.checks.length === 4 && after.checks.some(c => c.kind === 'Jog') && after.checks.some(c => c.amount === 22) && after.habits.find(h => h.id === 'hwalk').reminder === '00:00');
  check('upgrade stamps every row', [...after.habits, ...after.checks].every(r => r.updatedAt > 0 && r.updatedAt <= Date.now()), JSON.stringify(after.habits.map(h => h.updatedAt)));
  const local = Object.fromEntries(after.local.map(r => [r.key, r.value]));
  check('upgrade moves this device\'s settings to local', local.settings?.theme === 'dark' && local.settings.lastBackupOn === days[1] && local.settings.installTipDismissed === true && !('weekStart' in local.settings) && !after.settings.some(r => r.id === 'app'));
  check('upgrade keeps the week start as a synced setting', after.settings.length === 1 && after.settings[0].id === 'prefs' && after.settings[0].weekStart === 0 && after.settings[0].updatedAt > 0);
  check('upgraded app shows the habits', (await pu.$$eval('.card .name', els => els.map(e => e.textContent))).join('|') === 'Walk / Jog / Run|Read a book');
  check('upgraded app keeps the theme', (await pu.getAttribute('html', 'data-theme')) === 'dark');
  check('tick made from a notification before the upgrade is kept', await pu.locator('.card', { hasText: 'Read a book' }).evaluate(e => e.classList.contains('done')));
  await pu.locator('.sd').nth(5).click();
  check('upgraded app keeps past ticks and amounts', (await pu.locator('.card', { hasText: 'Read a book' }).locator('.meta').textContent()).startsWith('22 / 20 pages')
    && await pu.locator('.card', { hasText: 'Walk' }).evaluate(e => e.classList.contains('done')));
  await pu.click('[data-tab="settings"]');
  check('upgraded app keeps the week start', (await pu.getAttribute('[data-ws="0"]', 'aria-pressed')) === 'true');
  // A change after the upgrade is stamped now and marked for upload.
  await pu.click('[data-tab="today"]');
  await pu.click('[data-act="today"]');
  await pu.locator('.card', { hasText: 'Walk' }).click();
  await pu.waitForTimeout(300);
  const edited = await dumpDB(pu);
  const mark = edited.dirty.find(d => d.id === `c:hwalk:${dayKey()}`);
  check('a tick after the upgrade is marked for upload', !!mark && Date.now() - mark.updatedAt < 60e3 && edited.checks.find(c => c.habitId === 'hwalk' && c.date === dayKey()).updatedAt === mark.updatedAt);
  await ctx.close();
}

const { ctx, page } = await device('A');

await page.goto(URL);
await page.waitForSelector('.card');
const names = await page.$$eval('.card .name', els => els.map(e => e.textContent));
check('seeds two default habits', names.join('|') === 'Walk / Jog / Run|Read a book', names.join(', '));

// The name, asked once on Today, and the greeting it makes.
check('asks for a name on first open', await page.isVisible('#name-form'));
check('no greeting before a name', !(await page.isVisible('.hello')));
await page.fill('#name-in', 'Debashis');
await page.click('#name-form button[type="submit"]');
await page.waitForSelector('.hello');
check('greets by name with the time of day', /^(Good (morning|afternoon|evening)|Hi), Debashis$/.test(await page.textContent('.hello')), await page.textContent('.hello'));
check('the name card goes away', !(await page.isVisible('#name-form')));
await page.waitForFunction(() => /^Tick v\d+$/.test(document.querySelector('#version')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
check('the version is shown on Today', /^Tick v\d+$/.test(await page.textContent('#version').catch(() => '')), await page.textContent('#version').catch(() => 'missing'));
await page.click('[data-tab="settings"]');
check('Settings says which version this is', /^This is Tick v\d+\.$/.test(await page.textContent('#set-version').catch(() => '')));
await page.fill('#set-name', 'Deb');
await page.click('#name-set button');
await page.click('[data-tab="today"]');
check('the greeting follows a name change', (await page.textContent('.hello')).endsWith(', Deb'));

const read = page.locator('.card', { hasText: 'Read a book' });
await read.click();
check('tap ticks a habit', await read.evaluate(e => e.classList.contains('done')));
check('progress ring updates', (await page.textContent('#pring span')) === '1/2');
await page.waitForTimeout(300);
await page.reload(); await page.waitForSelector('.card');
check('tick survives reload', await page.locator('.card', { hasText: 'Read a book' }).evaluate(e => e.classList.contains('done')));

await page.locator('.card', { hasText: 'Read a book' }).click();
check('untick shows undo toast', await page.isVisible('#toast button'));
await page.click('#toast button');
await page.waitForTimeout(200);
check('undo restores the tick', await page.locator('.card', { hasText: 'Read a book' }).evaluate(e => e.classList.contains('done')));

// kinds: the default Walk / Jog / Run habit asks which one after ticking
const walkCard = () => page.locator('.card', { hasText: 'Walk' }).first();
check('no kind chips before ticking', (await walkCard().locator('.kind').count()) === 0);
await walkCard().click();
check('ticking shows kind chips', (await walkCard().locator('.kind').count()) === 3);
await walkCard().locator('.kind', { hasText: 'Jog' }).click();
await page.waitForTimeout(200);
check('picking a kind keeps the tick', await walkCard().evaluate(e => e.classList.contains('done')));
await page.reload(); await page.waitForSelector('.card');
check('picked kind survives reload', (await walkCard().locator('.kind[aria-pressed="true"]').textContent()) === 'Jog');

// past day via week strip
const strip = page.locator('.sd');
await strip.nth(5).click();
check('week strip opens a past day', (await page.textContent('.eyebrow')).startsWith('Editing'));
check('past day before habits existed explains why it is empty', await page.isVisible('.empty:has-text("had started")'));
await page.click('[data-act="today"]');

// add a habit
await page.click('[data-act="new"]');
await page.click('[data-save]');
check('empty name is rejected', await page.isVisible('.err'));
await page.fill('#hname', 'Meditate');
await page.click('[data-type="days"]');
await page.click('[data-icon="🧘"]');
await page.click('[data-save]');
await page.waitForTimeout(200);
const names2 = await page.$$eval('.card .name', els => els.map(e => e.textContent));
check('new habit added', names2.includes('Meditate'), names2.join(', '));

// "N times a week"
await page.click('[data-act="new"]');
await page.fill('#hname', 'Gym');
check('a plain name suggests nothing', (await page.textContent('#more-sub')) === 'Daily amount, kinds');
await page.click('[data-type="weekly"]');
await page.click('[data-times="-1"]');
check('weekly stepper', (await page.textContent('.stepper b')) === '2');
await page.click('[data-save]');
await page.waitForTimeout(200);
const gym = () => page.locator('.card', { hasText: 'Gym' });
check('weekly habit shows its week', (await gym().locator('.meta').textContent()).startsWith('0 of 2 this week'));
await gym().click();
await page.waitForTimeout(200);
check('ticking a weekly habit counts toward the week', (await gym().locator('.meta').textContent()).startsWith('1 of 2 this week'));

// quantity
await page.click('[data-act="new"]');
check('amount and kinds start hidden', !(await page.isVisible('#hgoal')) && !(await page.isVisible('#hkinds')));
await page.fill('#hname', 'Pages');
check('the name suggests an amount', (await page.textContent('#more-sub')).includes('track pages'));
await page.click('[data-more]');
await page.click('[data-suggest]');
check('a suggestion fills the amount but nothing else', (await page.inputValue('#hgoal')) === '20' && (await page.inputValue('#hunit')) === 'pages' && (await page.inputValue('#hkinds')) === '');
await page.click('[data-save]');
await page.waitForTimeout(200);
const pages = () => page.locator('.card', { hasText: 'Pages' });
await pages().click();
check('tapping a quantity habit opens the amount sheet', await page.isVisible('#hamount'));
await page.fill('#hamount', '12');
await page.click('[data-save-amount]');
await page.waitForTimeout(200);
check('a partial amount is not done', !(await pages().evaluate(e => e.classList.contains('done'))) && (await pages().locator('.meta').textContent()).startsWith('12 / 20 pages'));
check('partial amount shows a partial ring', await pages().locator('.chk.part').count() === 1);
await pages().click();
await page.click('[data-step="1"]');
await page.click('[data-step="1"]');
check('stepper adds 5 at a time for a goal of 20', (await page.inputValue('#hamount')) === '22');
await page.click('[data-save-amount]');
await page.waitForTimeout(200);
check('reaching the amount ticks the habit', await pages().evaluate(e => e.classList.contains('done')));

// drag to reorder: hold, then move
const order = () => page.$$eval('#view-today .list', ls => [...ls[0].querySelectorAll('.card .name')].map(e => e.textContent));
const before = await order();
const first = await page.locator('.card').first().boundingBox();
const third = await page.locator('.card').nth(2).boundingBox();
await page.mouse.move(first.x + 80, first.y + 30); await page.mouse.down(); await page.waitForTimeout(600);
for (let i = 1; i <= 10; i++) { await page.mouse.move(first.x + 80, first.y + 30 + (third.y + third.height / 2 - first.y - 30 + 8) * i / 10); await page.waitForTimeout(16); }
await page.mouse.up();
await page.waitForTimeout(500);
const after = await order();
check('hold and drag moves a habit', after[2] === before[0] && after[0] === before[1], `${before.join(', ')} → ${after.join(', ')}`);
check('drag does not tick or open anything', !(await page.isVisible('.scrim')));
await page.reload(); await page.waitForSelector('.card');
check('new order survives reload', (await order()).join() === after.join());

// long-press opens editor
const walk = page.locator('.card', { hasText: 'Walk' }).first();
const box = await walk.boundingBox();
await page.mouse.move(box.x + 60, box.y + 30); await page.mouse.down(); await page.waitForTimeout(700); await page.mouse.up();
check('long-press opens the editor', await page.isVisible('.sheet h2:text("Edit habit")'));
check('a habit with kinds opens with More options showing them', (await page.inputValue('#hkinds')) === 'Walk, Jog, Run');
await page.keyboard.press('Escape');
check('Escape closes the sheet', !(await page.isVisible('.scrim')));
await page.screenshot({ path: SP + '/app-today.png' });

// calendar
await page.click('[data-tab="calendar"]');
check('month view (all) renders', (await page.$$('.mc-all')).length >= 28);
await page.locator('[data-dayall]').last().click();
check('day sheet opens', await page.isVisible('.sheet'));
await page.click('.sheet .btn-primary');
await page.click('.chip:has-text("Read a book")');
check('single habit shows stats', await page.isVisible('.stats'));
check('single habit month has a done band', (await page.$$('.mc.s-done .band')).length >= 1);
await page.screenshot({ path: SP + '/app-cal-single.png', fullPage: true });
await page.click('[data-zoom="week"]');
check('week view renders', (await page.$$('.wc')).length === 7);
await page.click('[data-zoom="year"]');
check('year view renders', (await page.$$('button.yc')).length > 300);
await page.locator('button.yc').last().click();
check('year square jumps to month', (await page.getAttribute('[data-zoom="month"]', 'aria-pressed')) === 'true');

// settings: backup, erase, restore
await page.click('[data-tab="settings"]');
check('QR code renders', (await page.$$('#qr canvas, #qr img')).length > 0);
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-act="backup"]')]);
const backupPath = SP + '/backup.json';
await dl.saveAs(backupPath);
const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
check('backup file has habits and ticks', backup.app === 'tick' && backup.habits.length === 5 && backup.checks.length === 4, `${backup.habits.length} habits, ${backup.checks.length} ticks`);
check('backup keeps kinds and amounts', backup.checks.some(c => c.kind === 'Jog') && backup.checks.some(c => c.amount === 22) && backup.habits.some(h => h.schedule.type === 'weekly' && h.schedule.times === 2));
await page.click('[data-act="erase"]');
await page.click('[data-act="erase"]');
await page.waitForTimeout(200);
check('erase removes everything', (await page.textContent('.group:has(.rs:text("Stored on this device"))')).includes('0 habits'));
await page.setInputFiles('#restore-file', backupPath);
await page.waitForSelector('[data-restore]');
const restoreText = await page.textContent('.sheet .sub');
await page.click('[data-restore]');
await page.waitForTimeout(300);
check('restore brings everything back', (await page.$$('.habit-row')).length === 5, restoreText.trim());
check('restore brings the ticks back', (await page.textContent('.group:has(.rs:text("Stored on this device"))')).includes('4 ticks'));
await page.setInputFiles('#restore-file', backupPath);
await page.waitForTimeout(300);
check('restoring the same file again adds nothing', (await page.textContent('#toast')).includes('already here'));

// reminders: the service worker decides what an (empty) push says from the data on this device
await page.click('[data-tab="settings"]');
check('settings has a reminders section', await page.isVisible('.glabel:text("Reminders")'));
await ctx.grantPermissions(['notifications']);
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 5000 }).catch(() => null);
if (sw) {
  const shown = await sw.evaluate(async () => {
    const db = await openDB();
    const t = db.transaction('habits', 'readwrite');
    const hs = await req(t.objectStore('habits').getAll());
    for (const h of hs) if (h.name === 'Meditate') t.objectStore('habits').put({ ...h, schedule: { type: 'daily', days: [] }, reminder: '00:00' });
    await new Promise(r => { t.oncomplete = r; });
    db.close();
    await remind();
    const ns = await self.registration.getNotifications();
    ns.forEach(n => n.close());
    return ns.map(n => `${n.title} | ${n.body}`);
  });
  check('a push names the habit still to do', shown.length === 1 && shown[0].includes('Meditate') && shown[0].includes('Not done yet'), shown.join(' / '));
} else check('service worker available for the reminder check', false);

// ---------- cloud backup ----------
const sheetClosed = p => p.waitForSelector('.scrim', { state: 'detached' });
const cardNames = p => p.$$eval('#view-today .card .name', els => els.map(e => e.textContent));
const backUpNow = async p => {
  await p.click('[data-tab="settings"]');
  await p.click('[data-act="bk-sync"]');
  await p.waitForSelector('#toast:has-text("Backed up")');
};
if (hasApi) {
  const adminLink = execFileSync('node', ['tools/admin-link.mjs', URL]).toString().split('\n')[0];
  const navAdmin = p => p.locator('.nav [data-tab="admin"]');
  await page.click('[data-tab="settings"]');
  check('cloud backup starts off, offering to ask for it', (await page.textContent('.state')) === 'Off' && await page.isVisible('[data-act="bk-request"]') && !(await page.isVisible('[data-act="bk-on"]')));
  check('no Admin tab on an ordinary device', !(await navAdmin(page).isVisible()));

  // Ask for cloud backup: the name from Today is filled in.
  await page.click('[data-act="bk-request"]');
  check('the request is filled in with the name', (await page.inputValue('#rq-name')) === 'Deb');
  await page.fill('#rq-note', 'Runs Tick');
  await page.waitForTimeout(400);
  await page.screenshot({ path: SP + '/app-backup-request.png' });
  await page.click('#rq-form button[type="submit"]');
  await page.waitForSelector('#toast:has-text("Request sent")');
  check('asking shows it is waiting for approval', (await page.textContent('.state')) === 'Waiting for approval');

  // The person who runs Tick, on a device unlocked with the admin key, approves it.
  const ADM = await device('admin');
  const pa = ADM.page;
  await pa.goto(URL + '#admin');
  await pa.waitForSelector('#adm-form');
  await pa.fill('#adm-key', 'not the key');
  await pa.click('#adm-form button');
  await pa.waitForSelector('#adm-form .err');
  check('the Admin tab refuses a wrong key', (await pa.textContent('#adm-form .err')).includes("isn't this server's admin key"));
  await pa.goto(adminLink);
  await pa.waitForSelector('.admrow:has-text("Deb")');
  check('the admin link unlocks the Admin tab and leaves the address', !pa.url().includes('admin=') && pa.url().endsWith('#admin'), pa.url());
  check('the request is on the Admin tab with its note', await pa.isVisible('.admrow:has-text("Deb") .tag.st-pending') && await pa.isVisible('.admrow:has-text("Runs Tick")'));
  check('the admin key shows the Admin tab in the navigation', await navAdmin(pa).isVisible());
  await pa.click('.admrow:has-text("Deb") [data-approve]');
  await pa.waitForSelector('.admrow:has-text("Deb") .tag.st-approved');
  check('approving marks the request approved', true);
  // An invite link from the terminal still works.
  const invite = execFileSync('node', ['tools/invite.mjs', URL]).toString().split('\n')[0];
  await pa.goto(invite);
  await pa.waitForSelector('#toast:has-text("Invite saved")');
  check('invite link is taken and removed from the address', !pa.url().includes('invite='));
  await ADM.ctx.close();

  // Back on A: the answer arrives, and backup turns on.
  await page.click('[data-act="bk-check"]');
  await page.waitForSelector('#toast:has-text("Approved")');
  check('the approval reaches the device', (await page.textContent('.state')) === 'Approved' && await page.isVisible('[data-act="bk-on"]'));
  await page.click('[data-act="bk-on"]');
  await page.click('[data-next="2"]');
  const code = (await page.textContent('#code')).replace(/\s/g, '');
  check('recovery code is 28 characters', code.length === 28, code.length);
  check('QR code of the recovery code is drawn', await page.waitForSelector('#qr-code img[src^="data:image/png"], #qr-code canvas', { state: 'attached', timeout: 3000 }).then(() => true, () => false));
  await page.screenshot({ path: SP + '/app-backup-code.png' });
  await page.click('[data-next="3"]');
  await page.fill('#last4', 'XXXX');
  await page.click('[data-go]');
  check('wrong last 4 is caught', (await page.textContent('#bk-err')).includes("doesn't match"));
  await page.fill('#last4', code.slice(-4).toLowerCase());
  await page.click('[data-go]');
  await sheetClosed(page);
  await page.waitForSelector('.state.on');
  check('backup turns on', await page.isVisible('.state.on'));
  check('upload reported', (await page.textContent('#toast')).includes('encrypted and uploaded'), await page.textContent('#toast'));

  // A becomes the admin: the admin link once, "Make my backup the admin", then forget the key.
  await page.goto(adminLink);
  await page.waitForSelector('[data-make-me]');
  await page.click('[data-make-me]');
  await page.waitForSelector('#toast:has-text("admin\'s now")');
  await page.waitForSelector('[data-lock]');
  await page.click('[data-lock]');
  await page.waitForTimeout(300);
  check('after forgetting the key, the backup keeps this device the admin', await navAdmin(page).isVisible() && !(await dumpDB(page)).local.find(r => r.key === 'settings').value.adminKey);
  await page.click('[data-tab="settings"]');
  await page.screenshot({ path: SP + '/app-backup-on.png', fullPage: true });
  await page.click('[data-tab="today"]');
  const namesA = await cardNames(page);

  // ---------- device B: a fresh install (its own two default habits) opens the backup ----------
  const B = await device('B');
  const pb = B.page;
  await pb.goto(URL);
  await pb.waitForSelector('.card');
  await pb.locator('.card', { hasText: 'Walk' }).click();   // B ticked something before linking
  await pb.click('[data-tab="settings"]');
  await pb.click('[data-act="bk-link"]');
  await pb.fill('#linkcode', 'AAAA BBBB');
  await pb.click('[data-link]');
  await pb.waitForSelector('#bk-err:not([hidden])');
  check('a mistyped code is caught before sending', (await pb.textContent('#bk-err')).includes('28'));
  await pb.screenshot({ path: SP + '/app-backup-link.png' });
  await pb.fill('#linkcode', code.match(/.{4}/g).join(' ').toLowerCase());
  await pb.click('[data-link]');
  await sheetClosed(pb);
  check('device B opens the backup', await pb.isVisible('.state.on'));
  await pb.waitForTimeout(500);
  check('device B gets the Admin tab from the backup, with nothing typed', await navAdmin(pb).isVisible());
  await pb.click('[data-tab="today"]');
  await pb.waitForSelector('.card');
  const namesB = await cardNames(pb);
  check('device B sees the habits, in the same order, with no duplicate defaults', namesB.join('|') === namesA.join('|') && namesB.filter(n => n === 'Read a book').length === 1, namesB.join(', '));
  check('device B sees the ticks', await pb.locator('.card', { hasText: 'Read a book' }).evaluate(e => e.classList.contains('done'))
    && (await pb.locator('.card', { hasText: 'Pages' }).locator('.meta').textContent()).startsWith('22 / 20 pages'));
  check('device B sees the picked kind', (await pb.locator('.card', { hasText: 'Walk' }).locator('.kind[aria-pressed="true"]').textContent()) === 'Jog');
  check('device B sees the weekly count', (await pb.locator('.card', { hasText: 'Gym' }).locator('.meta').textContent()).startsWith('1 of 2 this week'));

  // B unticks one habit; and its service worker ticks another from a notification.
  await pb.locator('.card', { hasText: 'Gym' }).click();
  const meditate = await pb.locator('.card', { hasText: 'Meditate' }).getAttribute('data-id');
  const swB = await serviceWorker(B.ctx);
  if (swB) await swB.evaluate(([id, date]) => markDone(id, date), [meditate, dayKey()]);
  else check('service worker available on device B', false);
  await pb.waitForTimeout(500);
  const dirtyB = (await dumpDB(pb)).dirty.map(d => d.id);
  check('a tick from a notification is marked for upload', dirtyB.includes(`c:${meditate}:${dayKey()}`), dirtyB.join(', '));
  await backUpNow(pb);
  await backUpNow(page);
  await page.click('[data-tab="today"]');
  check('device A receives the untick', (await page.locator('.card', { hasText: 'Gym' }).locator('.meta').textContent()).startsWith('0 of 2 this week'));
  check('device A receives the tick made from a notification', await page.locator('.card', { hasText: 'Meditate' }).evaluate(e => e.classList.contains('done')));

  // A deletes a habit; B loses it and its ticks.
  await page.click('[data-tab="settings"]');
  await page.locator('.habit-row', { hasText: 'Pages' }).locator('[data-edit]').click();
  await page.click('[data-delete]');
  await page.click('[data-delete]');
  await sheetClosed(page);
  await backUpNow(page);
  await backUpNow(pb);
  await pb.click('[data-tab="today"]');
  check('a habit deleted on device A is gone on device B', !(await cardNames(pb)).includes('Pages'), (await cardNames(pb)).join(', '));
  const dbB = await dumpDB(pb);
  check('its ticks are tombstones on device B', dbB.checks.filter(c => c.habitId === dbB.habits.find(h => h.deleted && !h.mergedInto)?.id).every(c => c.deleted)
    && dbB.habits.filter(h => h.mergedInto).length === 2 && dbB.dirty.length === 0, `${dbB.dirty.length} dirty`);

  // The server holds only ciphertext.
  if (process.env.WRANGLER) {
    const [cmd, ...args] = process.env.WRANGLER.split(' ');
    const dump = execFileSync(cmd, [...args, 'd1', 'execute', 'tick', '--local', ...(process.env.PERSIST_TO ? ['--persist-to', process.env.PERSIST_TO] : []), '--json', '--command', 'SELECT * FROM records; SELECT * FROM vaults'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    // Short words are searched for as plaintext JSON would hold them ("Gym"): three random
    // letters turn up inside base64 ciphertext now and then.
    // (The vaults table has a name column for the Admin tab; the owners' names are expected there.)
    const leaks = ['Walk / Jog / Run', '"Jog"', 'Read a book', 'Meditate', '"Gym"', '"Pages"', '"pages"', '2026-', meditate, code].filter(x => dump.includes(x));
    const cts = [...dump.matchAll(/"ct":\s*"([^"]*)"/g)].map(m => m[1]);
    const sealed = cts.length > 0 && cts.every(ct => /^[\w-]+$/.test(ct) && (Buffer.from(ct, 'base64url').length - 16) % 256 === 0);
    check('server stores no readable habits or ticks', !leaks.length && sealed, leaks.join(', ') || `${cts.length} records`);
  } else skip('server stores no readable habits or ticks (set WRANGLER and PERSIST_TO to read the local database)');

  // Turning backup off on B leaves its data and the cloud copy alone.
  await pb.click('[data-tab="settings"]');
  await pb.click('[data-act="bk-off"]');
  await pb.waitForTimeout(400);
  await pb.screenshot({ path: SP + '/app-backup-off.png' });
  await pb.click('[data-off="keep"]');
  await sheetClosed(pb);
  check('backup turns off on one device', (await pb.textContent('.state')) === 'Off' && (await pb.$$('.habit-row')).length === 4);
  await backUpNow(page);
  check('the other device keeps backing up', await page.isVisible('.state.on'));
  await B.ctx.close();

  // Erase clears this device and unlinks it; the cloud copy stays. Undo puts both back.
  await page.click('[data-act="erase"]');
  await page.click('[data-act="erase"]');
  await page.waitForTimeout(200);
  // The approval belongs to the person, so it stays: backup can be turned on again.
  check('erase turns backup off on this device', (await page.textContent('.state')) === 'Approved' && (await page.$$('.habit-row')).length === 0 && !(await navAdmin(page).isVisible()),
    `${await page.textContent('.state')} | ${(await page.$$('.habit-row')).length} | admin tab ${await navAdmin(page).isVisible()}`);
  await page.click('#toast button');
  await page.waitForSelector('.state.on');
  check('undoing an erase restores the habits, the backup link and the Admin tab', (await page.$$('.habit-row')).length === 4 && await navAdmin(page).isVisible());
  await backUpNow(page);
  const afterUndo = await dumpDB(page);
  check('nothing is left to upload after the undo', afterUndo.dirty.length === 0 && afterUndo.local.some(r => r.key === 'vault'), `${afterUndo.dirty.length} dirty`);

  // ---------- someone else asks; the admin's devices hear about it ----------
  const D = await device('D');
  const pd = D.page;
  await pd.goto(URL);
  await pd.waitForSelector('#name-form');
  await pd.fill('#name-in', 'Meera');
  await pd.click('#name-form button[type="submit"]');
  await pd.click('[data-tab="settings"]');
  await pd.click('[data-act="bk-request"]');
  await pd.fill('#rq-note', 'from the running club');
  await pd.click('#rq-form button[type="submit"]');
  await pd.waitForSelector('#toast:has-text("Request sent")');
  await backUpNow(page);
  // A background sync that started before the request reports 0; the next one, right after, has it.
  await page.waitForFunction(() => document.querySelector('.nav [data-tab="admin"] .badge')?.textContent === '1', null, { timeout: 8000 }).catch(() => {});
  check('the Admin tab shows a badge for the waiting request', (await navAdmin(page).locator('.badge').textContent()) === '1',
    `${await navAdmin(page).locator('.badge').evaluate(b => b.hidden + '|' + b.textContent)} | ${JSON.stringify((({ isAdmin, adminPending }) => ({ isAdmin, adminPending }))((await dumpDB(page)).local.find(r => r.key === 'settings').value))}`);
  await page.click('[data-tab="today"]');
  check('Today tells the admin someone is waiting', await page.isVisible('.notice:has-text("waiting for cloud backup")'));
  await page.click('[data-act="goto-admin"]');
  await page.waitForSelector('.admrow:has-text("Meera")');
  check('the Admin tab lists the request and the backups by name', await page.isVisible('.admrow:has-text("from the running club")') && await page.isVisible('.admrow:has-text("Deb") .tag.st-approved'));
  await page.click('.admrow:has-text("Meera") [data-approve]');
  await page.waitForSelector('.admrow:has-text("Meera") .tag.st-approved');
  await page.click('[data-days="7"]');
  await page.click('[data-invite]');
  const made = await page.textContent('#adm-link');
  check('the Admin tab makes an invite link the server accepts', made.startsWith(URL + '?invite=') && await fetch(URL + 'api/vault', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ vaultId: randomBytes(16).toString('base64url'), authHash: randomBytes(32).toString('hex'), invite: made.split('?invite=')[1] }) }).then(r => r.status === 201));
  await page.screenshot({ path: SP + '/app-admin.png', fullPage: true });

  // Meera turns backup on once approved; then the admin revokes it.
  await pd.goto(URL);
  await pd.waitForSelector('.notice:has-text("approved")');
  check('an approved device is told on Today', true);
  await pd.click('[data-act="goto-settings"]');
  await pd.click('[data-act="bk-on"]');
  await pd.click('[data-next="2"]');
  const codeD = (await pd.textContent('#code')).replace(/\s/g, '');
  await pd.click('[data-next="3"]');
  await pd.fill('#last4', codeD.slice(-4));
  await pd.click('[data-go]');
  await sheetClosed(pd);
  await pd.waitForSelector('.state.on');
  await page.click('[data-refresh]');
  await page.waitForSelector('.admrow:has-text("Meera") [data-ask]');
  await page.click('.admrow:has-text("Meera") [data-ask]');
  await page.click('.admrow:has-text("Meera") [data-revoke]');
  await page.waitForSelector('.admrow:has-text("Meera") .tag.st-revoked');
  await pd.click('[data-act="bk-sync"]');
  await pd.waitForSelector('.state:has-text("Off")');
  check('a revoked device is told why, and keeps its habits', (await pd.textContent('.err-t')).includes('turned off by the person who runs Tick') && (await pd.$$('.habit-row')).length === 2);
  await D.ctx.close();
  await page.click('[data-tab="today"]');
} else {
  ['asking for backup and approving it', 'backup turns on', 'device B opens the backup and sees the habits and ticks', 'unticks, notification ticks and habit deletes reach the other device', 'server stores no readable habits or ticks', 'the Admin tab']
    .forEach(n => skip(`${n} (no backup API at ${URL}; run npm run dev)`));
}

// offline
await page.waitForFunction(() => navigator.serviceWorker?.controller || null, null, { timeout: 5000 }).catch(() => {});
await page.reload(); await page.waitForTimeout(500);
await ctx.setOffline(true);
await page.reload(); 
const offlineOK = await page.waitForSelector('.card, .habit-row', { timeout: 5000 }).then(() => true, () => false);
check('works offline after first visit', offlineOK);
await ctx.setOffline(false);
check('no JS errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(results.join('\n'));
process.exitCode = results.some(r => r.startsWith('FAIL')) ? 1 : 0;
