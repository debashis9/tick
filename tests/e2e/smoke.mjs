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
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

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

// long-press opens editor
const walk = page.locator('.card', { hasText: 'Walk' }).first();
const box = await walk.boundingBox();
await page.mouse.move(box.x + 60, box.y + 30); await page.mouse.down(); await page.waitForTimeout(700); await page.mouse.up();
check('long-press opens the editor', await page.isVisible('.sheet h2:text("Edit habit")'));
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
check('backup file has habits and ticks', backup.app === 'tick' && backup.habits.length === 3 && backup.checks.length === 1, `${backup.habits.length} habits, ${backup.checks.length} ticks`);
await page.click('[data-act="erase"]');
await page.click('[data-act="erase"]');
await page.waitForTimeout(200);
check('erase removes everything', (await page.textContent('.group:has(.rs:text("Stored on this device"))')).includes('0 habits'));
await page.setInputFiles('#restore-file', backupPath);
await page.waitForSelector('[data-restore]');
const restoreText = await page.textContent('.sheet .sub');
await page.click('[data-restore]');
await page.waitForTimeout(300);
check('restore brings everything back', (await page.$$('.habit-row')).length === 3, restoreText.trim());
await page.setInputFiles('#restore-file', backupPath);
await page.waitForTimeout(300);
check('restoring the same file again adds nothing', (await page.textContent('#toast')).includes('already here'));

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
