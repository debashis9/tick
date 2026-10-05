# Tick — to do

_Last updated 2026-10-01. Tick is live on Cloudflare and installed on the Android phone.
Encrypted cloud backup is built and tested locally (64 unit tests, 88 browser checks); it is
not committed, pushed or deployed yet._

## Cloud backup rollout (do these in order, before pushing)
- [x] `npx wrangler d1 create tick`, paste the `database_id` into `wrangler.jsonc` (done 2026-10-05, region APAC)
- [x] `npx wrangler d1 migrations apply tick --remote`
- [x] `npx wrangler secret put INVITE_SECRET` (value from `.dev.vars`). Without it anyone can create a vault
- [ ] Commit and push; Cloudflare deploys. Open apps show "A new version of Tick is ready · Refresh"
- [ ] On the Android phone: Refresh, check habits, ticks, week start, theme and reminders all survived the database upgrade
- [ ] `node tools/admin-link.mjs https://tick.<subdomain>.workers.dev`, open that link on the phone: the admin page unlocks and the phone gets its own invite. Then Settings → Cloud backup → Turn on backup
- [ ] Check the bottom of Today says "Tick v5", and Today asks your name once
- [ ] On a laptop: open Tick, Settings → Cloud backup → I have a recovery code. Check the default habits are not doubled and the ticks arrive
- [ ] Tick on one, untick on the other; tap "Mark done" on a reminder, open Tick, check it reaches the laptop
- [ ] Same on an iPhone with Tick on the Home Screen

## Finish the rollout
- [ ] Turn off the old GitHub Pages copy: GitHub repo → Settings → Pages → Source: **None**
- [ ] Check Settings → Invite in the installed app shows the Cloudflare address and QR code
- [ ] Offline check on Android: airplane mode → open Tick → tick a habit → reopen, tick is still there
- [ ] Test on an iPhone: Safari → Share → Add to Home Screen, then the same offline check
- [ ] Invite the first testers (Settings → Invite → Share or show the QR code).
      iPhone testers must use Add to Home Screen, or Safari may clear their data after 7 days.

## Reminders rollout
- [x] Push to `main` (Cloudflare deploys the Worker, Durable Object and cron)
- [x] Set the Worker secret once: `npx wrangler secret put VAPID_JWK` (value from `.dev.vars`, see README)
- [x] After the deploy: Android → edit a habit → Reminder on → Settings → Reminders → Send a test
- [x] Set a reminder a few minutes ahead and leave the app closed; check it arrives and "Mark done" ticks
- [ ] Same on an iPhone with Tick on the Home Screen

## Built on 2026-09-30
- [x] "N times a week" habits (any days, judged per week)
- [x] Reminders (Web Push from the Worker; it stores only push address, times, time zone)
- [x] Walk / Jog / Run: kinds to pick after ticking (any habit can have kinds)
- [x] Quantity habits (a daily amount such as pages or minutes)
- [x] Amount and kinds under a collapsed "More options", with tap-to-accept suggestions from the name
- [x] Reminder sends capped at 45 per minute; the rest follow in the next minutes
- [x] Drag to reorder on Today (hold, then move; hold and release still edits)

## Built on 2026-10-01
- [x] Optional end-to-end encrypted cloud backup and sync between devices (PLAN §12), same design as Sol
- [x] Signed invite links, checked by the Worker and storing nothing. They gate creating a backup vault, not using the app
- [x] Database version 2: `updatedAt` on every row, tombstones for unticks and deletes, `dirty` and `local` stores
- [x] Strict Content-Security-Policy (`_headers`); the theme script moved to `js/boot-theme.js`
- [x] Backup file version 3 carries `updatedAt`; older files still restore

## Built on 2026-10-05 (from Pie)
- [x] The version (`VERSION` in `sw.js`) at the bottom of Today and of Settings
- [x] Your name, asked once on Today (or set in Settings → Preferences), and a greeting by time of day
- [x] Admin page (`/#admin`): unlock with the admin key or `tools/admin-link.mjs`, make invite links, see what the server holds

## Not built yet
- [ ] Sync a "Mark done" straight from the service worker (today it uploads the next time Tick opens)
- [ ] Combine same-named habits that two already-linked devices each add (today only on linking)
- [ ] Keep the losing copy when two devices edit the same habit offline (last write wins for now)
- [ ] Scan the recovery code's QR to open a backup (today the code is typed)

## Every time you publish an update
1. Edit the files
2. Bump `VERSION` in `sw.js` (currently `tick-v5`)
3. Add any new file to `SHELL` in `sw.js`
4. `npm test`
5. Commit and push. Cloudflare deploys automatically; open apps show "A new version of Tick is ready · Refresh"
