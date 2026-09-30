# Tick

A simple habit tracker that works in a browser and installs to your phone's home screen.
Tap a habit to tick it off. The Calendar tab shows your history by week, month or year.

Habits can repeat every day, on some weekdays, or N times a week (any days), and can have a
reminder. Under "More options", a habit can also have a daily amount (20 pages, 30 minutes)
or kinds to pick from after ticking (Walk / Jog / Run). Both are optional; the habit's name
may suggest one, but nothing is added without a tap. Press and hold a habit to edit it, or hold and drag to reorder.

Everything you track stays on the device that you use it on. There are no accounts and no
analytics. The one thing that uses a server is reminders (see below), and it never learns
your habits or ticks. The plan and the reasoning behind it are in [PLAN.md](PLAN.md).

## Run it locally

ES modules need to be served over HTTP (opening `index.html` as a file won't work):

```sh
npm run serve          # same as: python3 -m http.server 8420
```

Then open http://localhost:8420. (Port 8000 is left free for Margin.) Service workers are allowed on `localhost`, so offline mode
and the install prompt work locally too.

## Tests

```sh
npm test               # unit tests: dates, stats, weekly habits, the Worker's push logic (no dependencies)
```

End-to-end smoke test (ticking, undo, kinds, weekly and amount habits, drag to reorder,
add/edit, calendar views, backup → erase → restore, what a reminder says, offline). It needs a
Chromium binary:

```sh
npm i --no-save playwright-core
npm run serve &        # serves on :8420
CHROME_PATH=/path/to/chrome node tests/e2e/smoke.mjs
```

## Deploy (Cloudflare Workers)

Tick needs its **own address** (origin). On Android, Chrome installs one app per origin, so a
second app on the same origin (e.g. next to Margin on `debashis9.github.io`) shows "already
installed" and can't be installed. That's why Tick is on Cloudflare, not GitHub Pages.

- Cloudflare project: **Workers & Pages → tick**, connected to the GitHub repo `debashis9/tick`.
  Every push to `main` builds and deploys automatically (`npx wrangler deploy`).
- `wrangler.jsonc`: the app is static files served straight from assets. The Worker code in
  `worker/` only runs for `/api/*` and for a once-a-minute cron (reminders, below).
  `.assetsignore` keeps `node_modules`, the Worker source, `.dev.vars`, tests, the mockup and
  docs off the site (the build installs Wrangler into `node_modules`, and one of its files is
  over Cloudflare's 25 MB per-file limit).
- The live address is shown under the project's **Domains** tab (`tick.<subdomain>.workers.dev`).
  Settings → Invite in the app shows it with a QR code.

**On every deploy, bump `VERSION` in `sw.js`** (`tick-v4` → `tick-v5`). Installed apps only
pick up new files when `sw.js` changes; they then show "A new version of Tick is ready ·
Refresh". If you add a file, add it to `SHELL` in `sw.js` too.

Cloudflare redirects `/index.html` to `/`, so the service worker caches and serves `./`, never
`./index.html` (a redirected response can't answer a page load).

## Reminders (Web Push)

A web app can't schedule its own notifications, so the Worker sends them:

1. Turning on a reminder asks for notification permission and subscribes this device to push.
   `js/push.js` then posts the device's push address, the reminder times with their weekdays
   and its time zone to `/api/push/subscribe`. Habit names and ticks are never sent. When no
   habit has a reminder any more, it calls `/api/push/unsubscribe`, which deletes the record.
2. The Worker keeps those records in a Durable Object (SQLite). A cron runs every minute and
   sends an **empty** push (no payload, so nothing to encrypt) to each device whose reminder
   time has come in its own time zone, once per day per time.
3. On the phone, `sw.js` wakes up, reads the habits from IndexedDB and shows what's still to
   do ("📖 Read a book · Not done yet today", with a **Mark done** button on Android and
   desktop). If everything is already done it shows nothing.

Pushes are signed with a VAPID key pair. The public key is in `js/push.js`; the private key is
the Worker secret `VAPID_JWK` (a JSON Web Key), and a local copy is in `.dev.vars` (git-ignored,
never published). To set the secret on Cloudflare:

```sh
npx wrangler secret put VAPID_JWK    # paste the JSON after VAPID_JWK= in .dev.vars (without the outer quotes)
```

To make a new key pair (every device must then turn its reminders off and on again), run
`node -e 'const k=require("crypto").generateKeyPairSync("ec",{namedCurve:"P-256"}).privateKey.export({format:"jwk"});console.log(JSON.stringify(k));console.log(Buffer.concat([Buffer.from([4]),Buffer.from(k.x,"base64url"),Buffer.from(k.y,"base64url")]).toString("base64url"))'`:
the first line is the secret, the second goes in `VAPID_PUBLIC_KEY` in `js/push.js`.

Notes:
- iPhone and iPad only get web push when Tick is installed to the Home Screen (iOS 16.4+).
- Settings → Reminders → **Send a test** checks the whole path on a device.
- Locally, `npx wrangler dev` runs the Worker, the Durable Object and the static files together
  (it reads `.dev.vars`); `curl "http://localhost:8787/cdn-cgi/handler/scheduled"` runs the cron once.
- Each device is its own record (keyed by its push address), so each person only gets their
  own reminders. The same person on two devices has two separate copies of Tick (no sync), so
  a reminder set on both will fire on both.
- The free plan allows about 50 outgoing requests per cron run, so each run sends at most 45
  pushes. If more are due at the same minute, the rest go out over the next minutes (a
  reminder stays due for 30 minutes after its time). For hundreds of devices sharing a
  popular time, the paid plan removes the delay.

## How it's put together

No framework and no build step. `package.json` only exists so Node runs the tests.

| File | What it does |
|---|---|
| `index.html` | App shell, nav, theme bootstrap |
| `styles.css` | Design tokens (light/dark) and components |
| `js/app.js` | Boot, tab routing, midnight rollover, service-worker updates |
| `js/db.js` | IndexedDB. **The only file that touches storage** |
| `js/store.js` | In-memory copy of the data and every mutation; seeds the two default habits; backup import/export logic |
| `js/dates.js` | Local `YYYY-MM-DD` date helpers (never UTC timestamps) |
| `js/stats.js` | Pure functions: day states, weekly targets, streaks, strength score, chain bridges |
| `js/ui.js` | View state, toast, sheets, habit card |
| `js/sheets.js` | Add/edit habit sheet, amount sheet, day sheet |
| `js/drag.js` | Press-and-hold on Today: release to edit, move to reorder |
| `js/push.js` | Reminders: notification permission, push subscription, syncing times to the Worker |
| `js/backup.js` | Back up (share sheet / download) and restore |
| `js/views/*.js` | Today, Calendar, Settings |
| `sw.js` | Offline cache for the app shell; turns an empty push into a reminder |
| `worker/` | Cloudflare Worker: reminder API, cron, Durable Object, VAPID signing |
| `mockup/` | The approved design mockup (reference only; not deployed) |
| `wrangler.jsonc`, `.assetsignore` | Cloudflare deploy config and the list of files not to publish |

Data lives in IndexedDB database `tick`: `habits`, `checks` (`[habitId, date]`, plus an
optional `kind` and `amount`) and `settings`. A day is done when its check exists, and for a
habit with a daily amount, when the amount reaches it. Browsers can clear site data, so the app asks for persistent storage on the
first tick, nudges for a backup every 30 days, and on iPhone asks you to install it to the
Home Screen (Safari clears data for sites not visited in 7 days; home-screen apps are exempt).
