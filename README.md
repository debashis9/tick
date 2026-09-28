# Tick

A simple habit tracker that works in a browser and installs to your phone's home screen.
Tap a habit to tick it off. The Calendar tab shows your history by week, month or year.

Everything stays on the device that you use it on. There are no accounts, no analytics and
no server that receives data. The plan and the reasoning behind it are in [PLAN.md](PLAN.md).

## Run it locally

ES modules need to be served over HTTP (opening `index.html` as a file won't work):

```sh
npm run serve          # same as: python3 -m http.server 8420
```

Then open http://localhost:8420. (Port 8000 is left free for Margin.) Service workers are allowed on `localhost`, so offline mode
and the install prompt work locally too.

## Tests

```sh
npm test               # unit tests for dates and stats (Node's built-in runner, no dependencies)
```

End-to-end smoke test (26 checks: ticking, undo, add/edit, calendar views, backup → erase →
restore, offline). It needs a Chromium binary:

```sh
npm i --no-save playwright-core
npm run serve &        # serves on :8420
CHROME_PATH=/path/to/chrome node tests/e2e/smoke.mjs
```

## Deploy (GitHub Pages)

1. Create a GitHub repo and push this folder to `main`.
2. Repo **Settings → Pages → Build and deployment**: Source = *Deploy from a branch*,
   Branch = `main`, folder = `/ (root)`.
3. The app is served at `https://<user>.github.io/<repo>/`. Share that link (Settings →
   Invite shows it with a QR code).

**On every deploy, bump `VERSION` in `sw.js`** (`tick-v1` → `tick-v2`). Installed apps only
pick up new files when `sw.js` changes; they then show "A new version of Tick is ready ·
Refresh". If you add a file, add it to `SHELL` in `sw.js` too.

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
| `js/stats.js` | Pure functions: day states, streaks, strength score, chain bridges |
| `js/ui.js` | View state, toast, sheets, habit card |
| `js/sheets.js` | Add/edit habit sheet, day sheet |
| `js/backup.js` | Back up (share sheet / download) and restore |
| `js/views/*.js` | Today, Calendar, Settings |
| `sw.js` | Offline cache for the app shell |
| `mockup/` | The approved design mockup (reference only; not used by the app) |

Data lives in IndexedDB database `tick`: `habits`, `checks` (`[habitId, date]`, present = done)
and `settings`. Browsers can clear site data, so the app asks for persistent storage on the
first tick, nudges for a backup every 30 days, and on iPhone asks you to install it to the
Home Screen (Safari clears data for sites not visited in 7 days; home-screen apps are exempt).
