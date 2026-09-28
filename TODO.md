# Tick — to do

_Last updated 2026-09-29. Tick is live on Cloudflare and installed on the Android phone._

## Finish the rollout
- [ ] Turn off the old GitHub Pages copy: GitHub repo → Settings → Pages → Source: **None**
- [ ] Check Settings → Invite in the installed app shows the Cloudflare address and QR code
- [ ] Offline check on Android: airplane mode → open Tick → tick a habit → reopen, tick is still there
- [ ] Test on an iPhone: Safari → Share → Add to Home Screen, then the same offline check
- [ ] Invite the first testers (Settings → Invite → Share or show the QR code).
      iPhone testers must use Add to Home Screen, or Safari may clear their data after 7 days.

## Features not built yet (from PLAN.md)
- [ ] "N times a week" habits (any 3 days a week, judged per week). The data model has room for it.
- [ ] Reminders (local notifications; web push needs a server)
- [ ] Invite-only access: signed invite links checked by a Cloudflare Worker, storing nothing
- [ ] Walk / Jog / Run variant: optional picker for which one it was
- [ ] Quantity habits (pages read, minutes walked)
- [ ] Drag to reorder on the Today screen (today: up/down buttons in Settings → Habits)

## Every time you publish an update
1. Edit the files
2. Bump `VERSION` in `sw.js` (currently `tick-v3`)
3. Add any new file to `SHELL` in `sw.js`
4. `npm test`
5. Commit and push. Cloudflare deploys automatically; open apps show "A new version of Tick is ready · Refresh"
