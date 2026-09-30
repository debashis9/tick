import { chromium } from 'playwright-core';
import fs from 'node:fs';
// End-to-end smoke test. Not part of `npm test` (it needs a browser):
//   npm i --no-save playwright-core
//   npm run serve        # in another terminal (serves on :8420)
//   CHROME_PATH=/path/to/chrome node tests/e2e/smoke.mjs
import os from 'node:os';
const SP = process.env.OUT_DIR || os.tmpdir(), URL = process.env.APP_URL || 'http://localhost:8420/';
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, args: ['--no-sandbox'] });
const results = [];
const check = (name, ok, extra = '') => { results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };

const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
// Test contexts are incognito, where Chrome logs that it has no Push API; real installs do.
page.on('console', m => { if (m.type() === 'error' && !m.text().includes('Push API in incognito')) errors.push('console: ' + m.text()); });

await page.goto(URL);
await page.waitForSelector('.card');
const names = await page.$$eval('.card .name', els => els.map(e => e.textContent));
check('seeds two default habits', names.join('|') === 'Walk / Jog / Run|Read a book', names.join(', '));

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
