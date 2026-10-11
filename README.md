# Tick

A simple habit tracker that works in a browser and installs to your phone's home screen.
Tap a habit to tick it off. The Calendar tab shows your history by week, month or year.

Today greets you by name ("Good morning, Debashis"); the name is asked once and stays on the
device. Habits can repeat every day, on some weekdays, or N times a week (any days), and can have a
reminder. Things you do less often (monthly cleaning, a declutter every 3 months, something once a
year) repeat every N weeks, months or years, counted from the last time you ticked them: they show
on Today under "Occasional" when due and wait there until ticked, the rest fold under "Later", and
they stay out of the daily ring, runs and strength. Under "More options", a habit can also have a daily amount (20 pages, 30 minutes)
or kinds to pick from after ticking (Walk / Jog / Run). Both are optional; the habit's name
may suggest one, but nothing is added without a tap. Press and hold a habit to edit it, or hold and drag to reorder.

What you track lives on your device. There are no accounts and no analytics. Two things use
a server, and neither can read your habits or ticks: reminders (see below), and **cloud
backup, which is optional and end-to-end encrypted**. With backup on, each record is encrypted
on the device with a key made from your recovery code before it's uploaded, and your other
devices stay in step. The plan and the reasoning behind it are in [PLAN.md](PLAN.md) (§12 for
backup).

## Run it locally

The app is static files; reminders and cloud backup need the Worker and a local D1 database,
which `wrangler dev` runs together:

```sh
npm run dev            # applies the D1 migration locally, then serves app + API on :8788
```

Open http://localhost:8788. (Sol uses 8787.) `npm run dev` keeps the local database in
`~/.cache/tick-wrangler`, outside the project: kept inside, every database write looks like a
file change and makes wrangler reload in a loop. It reads `.dev.vars` (git-ignored):
`VAPID_JWK` for reminders and `INVITE_SECRET` for backup invites.

Without the Worker, any static server works too (`npm run serve`, port 8420; port 8000 is left
free for Margin). Settings → Cloud backup then says there's no backup server. Service workers
are allowed on `localhost`, so offline mode and the install prompt work locally too.

## Tests

```sh
npm test               # unit tests, no dependencies: dates, stats, weekly habits, the Worker's
                       # push logic, encryption, the records that sync and the upgrade from the
                       # old database, and two simulated devices syncing through the real
                       # Worker code (SQLite stands in for D1)
```

End-to-end, in a real browser against `npm run dev`: the upgrade from a version 1 database,
ticking, undo, kinds, weekly and amount habits, drag to reorder, add/edit, calendar views,
backup file → erase → restore, what a reminder says, turning cloud backup on with an invite, a
second device opening it with the code, unticks and habit deletes crossing over, checking the
server holds no readable data, offline. It needs a Chromium binary:

```sh
npm i --no-save playwright-core
npm run dev &
WRANGLER="npx wrangler" PERSIST_TO=~/.cache/tick-wrangler CHROME_PATH=/path/to/chrome node tests/e2e/smoke.mjs
```

It creates vaults in the local database; clear them with
`npx wrangler d1 execute tick --local --persist-to ~/.cache/tick-wrangler --command "DELETE FROM records; DELETE FROM vaults"`.
Against the static server (`APP_URL=http://localhost:8420/`) the cloud backup checks report SKIP.

## Deploy (Cloudflare Workers)

Tick needs its **own address** (origin). On Android, Chrome installs one app per origin, so a
second app on the same origin (e.g. next to Margin on `debashis9.github.io`) shows "already
installed" and can't be installed. That's why Tick is on Cloudflare, not GitHub Pages.

- Cloudflare project: **Workers & Pages → tick**, connected to the GitHub repo `debashis9/tick`.
  Every push to `main` builds and deploys automatically (`npx wrangler deploy`).
- `wrangler.jsonc`: the app is static files served straight from assets. The Worker code in
  `worker/` only runs for `/api/*` and for a once-a-minute cron (reminders, below).
  `.assetsignore` keeps `node_modules`, the Worker source, `.dev.vars`, tests, tools, the
  mockup and docs off the site (the build installs Wrangler into `node_modules`, and one of its
  files is over Cloudflare's 25 MB per-file limit). `_headers` sets the security headers.
- The live address is shown under the project's **Domains** tab (`tick.<subdomain>.workers.dev`).
  Settings → Invite in the app shows it with a QR code.

Cloud backup needs three things set up once, **before** the code that uses them is pushed:

1. Create the database, then paste the `database_id` it prints into `wrangler.jsonc` (it holds
   a row of zeros until then):
   ```sh
   npx wrangler d1 create tick
   npx wrangler d1 migrations apply tick --remote
   ```
2. Set the invite secret (the value is in `.dev.vars`):
   ```sh
   npx wrangler secret put INVITE_SECRET
   ```
   Without it, anyone who finds the address can create a backup vault.
3. Commit `wrangler.jsonc` and push.

**On every deploy, bump `VERSION` in `sw.js`** (`tick-v6` → `tick-v7`). The app shows it at the
bottom of Today ("Tick v6") and of Settings, so you can tell which version a phone is running.
Installed apps only
pick up new files when `sw.js` changes; they then show "A new version of Tick is ready ·
Refresh". If you add a file, add it to `SHELL` in `sw.js` too.

Cloudflare redirects `/index.html` to `/`, so the service worker caches and serves `./`, never
`./index.html` (a redirected response can't answer a page load).

### Who gets cloud backup: requests, the Admin tab, invites

Anyone can use Tick on their own device (Settings → Invite shares the plain link). Cloud backup
is by approval, the same way as in Sol:

- **Ask for it:** Settings → Cloud backup → *Ask for cloud backup* sends the person's name and a
  line about how they know you. Tick checks for an answer each time it opens; once approved, it
  says so on Today and Settings offers *Turn on backup*. A device without an invite or an
  approval never sees a Turn on button that would fail at the end.
- **The Admin tab** appears in the navigation on any device that holds an admin's backup. Being
  the admin belongs to your backup, not to a key: every device you open your backup on is the
  admin, with nothing to type. Each sync tells those devices how many people are waiting (a
  badge on the tab, and a note on Today). The tab approves or rejects requests, lists backups by
  name with size and last sync and how many synced in the last 7 and 30 days, revokes a backup
  (its encrypted data is deleted and the device is told why), makes another backup an admin, and
  makes invite links (signed by the server).
- **Setting up the first admin, once:** open the admin link on your phone, then tap *Make my
  backup the admin* on the Admin tab (turn backup on first; the key gives the phone an invite):
  ```sh
  node tools/admin-link.mjs https://tick.<subdomain>.workers.dev   # unlocks the Admin tab with the key, without typing it
  ```
  Then *Forget the admin key on this device*: your backup keeps you the admin. Don't send that
  link to anyone: it is the key to the whole server. The key (`INVITE_SECRET`) stays a fallback.
- **Invite links** skip the request, for people you've already said yes to. Make them on the
  Admin tab, or from a terminal: `node tools/invite.mjs https://tick.<subdomain>.workers.dev 14`.
  The Worker only checks a link's signature and expiry and keeps no list of invitees. On an
  iPhone, where the Home Screen app doesn't share Safari's storage, the link can be pasted into
  *Ask for cloud backup → I have an invite link*.
- **What the server keeps for this:** each request's name, note, status and dates; each
  backup's owner name (from the request, or the name on the device for an invite), how it was
  allowed, and whether it is an admin's. Never anything from inside a backup.
- There are no notifications for new requests (Sol has them; in Tick every push means "a
  reminder is due", and the reminder code is left alone). The badge and Today's note do it.

From a terminal, for the record:

```sh
npx wrangler d1 execute tick --remote --command "SELECT COUNT(*) AS vaults, SUM(bytes) AS bytes FROM vaults"
```

## How cloud backup works

- It's optional. Without it Tick is local-only and never calls the backup routes.
- Turning it on makes a random 128-bit key, shown once as a **28-character recovery code**
  (the last 2 characters are a checksum) and a QR code. You type its last 4 characters to
  prove you saved it. A second device opens the backup by typing the code.
- Everything is derived from that code with HKDF: the AES-256-GCM key, the vault id, the auth
  secret (the server keeps only its SHA-256), and an HMAC key that turns local record ids into
  opaque server ids.
- Each record (a habit, one habit on one day, the week start) is padded to a multiple of 256
  bytes and encrypted separately. The server sees a vault id, opaque record ids, sizes, and
  when devices sync. It never sees habit names, dates, ticks, amounts or kinds.
- A day's record id is made from its habit and date (`c:<habitId>:<date>`), so two devices
  ticking the same day write the same server row.
- Sync pulls first, then pushes local changes; the newer edit of a record wins. Unticking and
  deleting leave tombstones, and deleting a habit tombstones its ticks too. It runs on open,
  when the app comes back, when the network returns, and a few seconds after each change,
  with backoff when the server can't be reached. A tick made from a notification's **Mark
  done** uploads the next time Tick opens.
- **Reminder times and the theme stay per device.** Habits, their order, ticks and the week
  start sync.
- **Linking a device that already has habits:** one with the same name as a habit in the
  backup is combined with it. The older habit survives on every device and takes the other's
  ticks. Every fresh install seeds the same two habits, so without this a second device would
  show two of each.
- **Lose the code and every device, and the backup can't be opened by anyone.** That's the
  point. The app says so before turning backup on.
- **Erase all data** clears the device and turns backup off there; the cloud copy stays.
  Settings → Cloud backup → Turn off → Delete the cloud copy removes it for every device.
- The page's Content-Security-Policy (`_headers`) allows scripts from this site only, since
  a web app's encryption is only as trustworthy as the code it's served.

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
- Locally, `npm run dev` runs the Worker, the Durable Object and the static files together
  (it reads `.dev.vars`); `curl "http://localhost:8788/cdn-cgi/handler/scheduled"` runs the cron once.
- Each device is its own record (keyed by its push address), so each person only gets their
  own reminders. Reminder times don't sync with cloud backup: a reminder is set on the device
  that should notify, and a reminder set on two devices fires on both.
- The free plan allows about 50 outgoing requests per cron run, so each run sends at most 45
  pushes. If more are due at the same minute, the rest go out over the next minutes (a
  reminder stays due for 30 minutes after its time). For hundreds of devices sharing a
  popular time, the paid plan removes the delay.

## How it's put together

No framework and no build step. `package.json` only exists so Node runs the tests.

| File | What it does |
|---|---|
| `index.html` | App shell, nav |
| `js/boot-theme.js` | Applies the saved theme before first paint (a file, so the CSP can forbid inline scripts) |
| `styles.css` | Design tokens (light/dark) and components |
| `js/app.js` | Boot, tab routing, midnight rollover, service-worker updates |
| `js/db.js` | IndexedDB, and the upgrade from the version 1 database. **The only file that touches storage** (besides `sw.js`) |
| `js/records.js` | Pure: the records that sync. Ids, the wire form, stamps, tombstones, combining habits on linking, the upgrade's row logic |
| `js/store.js` | In-memory copy of the data and every mutation; seeds the two default habits; backup file import/export logic |
| `js/dates.js` | Local `YYYY-MM-DD` date helpers (never UTC timestamps) |
| `js/stats.js` | Pure functions: day states, weekly targets, streaks, strength score, chain bridges |
| `js/ui.js` | View state, toast, sheets, habit card |
| `js/sheets.js` | Add/edit habit sheet, amount sheet, day sheet |
| `js/drag.js` | Press-and-hold on Today: release to edit, move to reorder |
| `js/push.js` | Reminders: notification permission, push subscription, syncing times to the Worker |
| `js/backup.js` | Backup file: save (share sheet / download) and restore |
| `js/crypto.js` | Recovery code, key derivation, record encryption (WebCrypto) |
| `js/sync-core.js`, `js/sync.js` | One sync pass (testable, identical to Sol's); background sync on the device |
| `js/backup-ui.js` | Cloud backup sheets: turn on, open with a code, show the code, turn off |
| `js/views/*.js` | Today, Calendar, Settings |
| `sw.js` | Offline cache for the app shell (never caches `/api/`); turns an empty push into a reminder; "Mark done" |
| `worker/index.js`, `worker/webpush.js` | Cloudflare Worker: reminder API, cron, Durable Object, VAPID signing |
| `worker/vault.js`, `worker/migrations/` | Cloud backup, requests and the Admin tab (`/api/vault`, `/api/sync`, `/api/requests`, `/api/admin/*`) and their D1 tables |
| `js/admin-api.js`, `js/admin.js`, `js/views/admin.js` | The Admin tab: requests, backups, revoking, admins, invite links (as in Sol) |
| `tools/invite.mjs`, `tools/admin-link.mjs` | Invite links for cloud backup; the link that unlocks the Admin tab with the key |
| `_headers` | Content-Security-Policy and other security headers |
| `mockup/` | The approved design mockup (reference only; not deployed) |
| `wrangler.jsonc`, `.assetsignore` | Cloudflare deploy config and the list of files not to publish |

Data lives in IndexedDB database `tick` (version 2): `habits`, `checks` (`[habitId, date]`,
plus an optional `kind` and `amount`), `settings` (one synced row, the week start), `dirty`
(changes not yet uploaded) and `local` (this device's own settings and backup state). Every
habit and check has `updatedAt`; a deleted habit or an unticked day stays as a tombstone
(`deleted: true`), so the deletion can reach other devices. A day is done when its check exists
and isn't a tombstone, and for a habit with a daily amount, when the amount reaches it.
Version 1 databases (before cloud backup) are upgraded in place on first open.

Browsers can clear site data, so the app asks for persistent storage on the first tick, nudges
for a backup file every 30 days (unless cloud backup is on), and on iPhone asks you to install
it to the Home Screen (Safari clears data for sites not visited in 7 days; home-screen apps
are exempt).
