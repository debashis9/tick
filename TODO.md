# Tick — to do

_Last updated 2026-09-30. Tick is live on Cloudflare and installed on the Android phone._

## Finish the rollout
- [ ] Turn off the old GitHub Pages copy: GitHub repo → Settings → Pages → Source: **None**
- [ ] Check Settings → Invite in the installed app shows the Cloudflare address and QR code
- [ ] Offline check on Android: airplane mode → open Tick → tick a habit → reopen, tick is still there
- [ ] Test on an iPhone: Safari → Share → Add to Home Screen, then the same offline check
- [ ] Invite the first testers (Settings → Invite → Share or show the QR code).
      iPhone testers must use Add to Home Screen, or Safari may clear their data after 7 days.

## Reminders rollout
- [ ] Push to `main` (Cloudflare deploys the Worker, Durable Object and cron)
- [ ] Set the Worker secret once: `npx wrangler secret put VAPID_JWK` (value from `.dev.vars`, see README)
- [ ] After the deploy: Android → edit a habit → Reminder on → Settings → Reminders → Send a test
- [ ] Set a reminder a few minutes ahead and leave the app closed; check it arrives and "Mark done" ticks
- [ ] Same on an iPhone with Tick on the Home Screen

## Built on 2026-09-30
- [x] "N times a week" habits (any days, judged per week)
- [x] Reminders (Web Push from the Worker; it stores only push address, times, time zone)
- [x] Walk / Jog / Run: kinds to pick after ticking (any habit can have kinds)
- [x] Quantity habits (a daily amount such as pages or minutes)
- [x] Amount and kinds under a collapsed "More options", with tap-to-accept suggestions from the name
- [x] Reminder sends capped at 45 per minute; the rest follow in the next minutes
- [x] Drag to reorder on Today (hold, then move; hold and release still edits)

## Not built yet
- [ ] Invite-only access: signed invite links checked by the Cloudflare Worker, storing nothing

## Every time you publish an update
1. Edit the files
2. Bump `VERSION` in `sw.js` (currently `tick-v4`)
3. Add any new file to `SHELL` in `sw.js`
4. `npm test`
5. Commit and push. Cloudflare deploys automatically; open apps show "A new version of Tick is ready · Refresh"
