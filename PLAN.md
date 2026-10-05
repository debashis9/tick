# Habit Tracker — Product & Build Plan

_Drafted 2026-09-28. Status: mockup approved; Phases 1–5 built on 2026-09-28 and deployed on Cloudflare. Encrypted cloud backup (§12) built and tested locally on 2026-10-01, not yet deployed. See README.md to run, test and deploy._

Working name: **Tick** (placeholder, easy to change; it's just the manifest `name` and the header).

---

## 1. What we're building

A personal habit tracker that opens in a browser on desktop and installs to the home screen on
phones (Android, iPhone, iPad). You tap a habit to mark it done for today. A second tab shows
a calendar of your history for every habit.

### Goals
1. **One tap to log.** Opening the app and ticking a habit should take under 3 seconds.
2. **Very clean, modern UI.** Calm, lots of whitespace, one accent color per habit, no clutter.
3. **Private by design.** Every person's data stays on their own device. You (the admin) can
   invite people, but you never see, store or receive anything they track.
4. **Works offline**, starts instantly, feels like a native app when installed.

### Non-goals (for now)
_Changed 2026-10-01: optional encrypted backup and sync were added; see §12._
- No sync between devices (explicitly out of scope; a manual export/import file covers
  "moving to a new phone").
- No accounts, no login, no server database, no analytics, no crash reporting.
- No push reminders (needs a server to send pushes — revisit later, see §10).

### Defaults on first launch
| Habit | Icon | Color | Schedule |
|---|---|---|---|
| Walk / Jog / Run | 🏃 | Green | Every day |
| Read a book | 📖 | Blue | Every day |

Both are ordinary habits — the user can rename, recolor, reschedule, archive or delete them.
Walking/Jogging/Running is **one habit**, as written in the brief. (If you'd rather log which
of the three it was, that's a small v2 add-on: an optional "variant" chip on long-press.)

---

## 2. Platform & architecture decision

### Recommendation: an installable web app (PWA), local-only, no build step

One codebase serves both "webpage" and "mobile": the same site runs in a desktop browser and
installs to the phone home screen, full-screen, with its own icon. This is the same shape as
Margin (`../vocab-capture`), so hosting, service-worker and icon work is already familiar.

| Option | Verdict |
|---|---|
| **PWA, vanilla JS, no build** | ✅ One codebase, free hosting (GitHub Pages), instant deploy with `git push`, nothing to rot between sessions. Matches your existing Margin setup. |
| React Native / Flutter native apps | ❌ App Store + Play Store accounts, review, and fees just to let friends "try it". Overkill without sync or push. |
| PWA with React/Vite | Workable, but adds a toolchain for an app with ~6 screens. Not needed. |

**Why no backend is the right call here:** you don't want users' data and you don't want sync.
With no server, "we don't collect anything" is true by construction, not by promise — there is
nowhere for data to go.

### Stack
- **HTML + CSS + vanilla JS**, native ES modules (no bundler). Files stay small and readable.
- **Storage: IndexedDB** (not localStorage — larger quota, structured, async). A ~40-line
  wrapper; no library needed.
- **All persistence behind a small repository API** (`listHabits`, `saveHabit`,
  `archiveHabit`, `deleteHabit`, `setCheck`, `getChecks(from, to)`, `exportAll`, `importAll`).
  The UI never touches IndexedDB directly — the lesson from Margin, where this made the
  IndexedDB → Supabase move a three-function change. If sync ever happens, only this layer
  changes.
- **Charts: hand-drawn SVG/CSS grid.** Rings, heatmaps and calendars are simple shapes; a
  charting library would cost more than it saves.
- **Service worker**: cache-first app shell, versioned cache name, "new version available —
  tap to refresh" toast.
- **Hosting: GitHub Pages** (`.nojekyll`, like Margin). HTTPS is required for PWA install and
  service workers — Pages gives that free.

### Proposed file layout
```
habit_tracker/
  index.html            app shell + templates
  styles.css            tokens, components, light/dark
  js/
    app.js              router (tabs), boot, first-run seeding
    db.js               IndexedDB wrapper + repository API  ← the only file that touches storage
    dates.js            local-date helpers (the bug magnet — heavily tested)
    stats.js            streaks, strength score, completion rates
    views/today.js
    views/calendar.js   week / month / year views
    views/habit.js      habit detail + edit sheet
    views/settings.js
  sw.js                 service worker
  manifest.webmanifest
  icons/                192, 512, maskable, apple-touch-icon
  fonts/                self-hosted Inter (variable, woff2)
  tests/                unit tests (dates, stats) + Playwright e2e
```

---

## 3. Data model

```js
// store: habits  (keyPath: id)
{
  id: "h_8f3k2",              // random, never reused
  name: "Read a book",
  icon: "📖",                 // emoji — zero asset cost, universally rendered
  color: "blue",              // palette key, not a hex — lets light/dark themes differ
  schedule: {                 // decides "missed" vs "not scheduled" on the calendar
    type: "daily" | "weekdays" | "perWeek",
    days: [1,3,5],            // for "weekdays": 0=Sun … 6=Sat
    perWeek: 3                // for "perWeek": any 3 days in the week
  },
  order: 2,                   // manual sort on the Today screen
  createdOn: "2026-09-28",    // local date — days before this render as "not started"
  archivedOn: null            // archived habits leave Today but keep their history
}

// store: checks  (keyPath: [habitId, date], index on date)
{ habitId: "h_8f3k2", date: "2026-09-28", at: 1759075200000 }
// Present = done. Absent = not done. Untick = delete the row.

// store: settings  (single row)
{ weekStart: 1, theme: "system", lastBackupOn: "2026-09-01", seeded: true, schemaVersion: 1 }
```

**Dates are stored as local `YYYY-MM-DD` strings, never timestamps.** "Did I read on Tuesday"
is a question about the user's calendar day, not a UTC instant. This one choice removes the
classic habit-tracker bugs (ticks landing on the wrong day near midnight, or shifting after
travel across time zones).

---

## 4. Screens & UX

Navigation: **bottom tab bar on mobile** (Today · Calendar · Settings); **left rail on
desktop** (≥ 900px) with content centered, max ~720px wide (the calendar gets wider).

### 4.1 Today (home)

```
┌─────────────────────────────────┐
│  Sunday, 28 September      ◐ 1/2│  ← progress ring: done / scheduled today
│                                 │
│  M  T  W  T  F  S [S]           │  ← week strip: tap a past day to edit it
│  ●  ●  ◐  ●  ○  ●  ◐            │     (dot = that day's completion)
│                                 │
│  ┌───────────────────────────┐  │
│  │ 🏃  Walk / Jog / Run    ✓ │  │  ← done: card fills with habit color,
│  │     12-day streak         │  │     check draws in (180ms)
│  └───────────────────────────┘  │
│  ┌───────────────────────────┐  │
│  │ 📖  Read a book         ○ │  │  ← not done: white card, hairline border
│  │     Strength 64%          │  │
│  └───────────────────────────┘  │
│                                 │
│  Not scheduled today            │  ← collapsed section, dimmed
│   🧘 Meditate (Mon/Wed/Fri)     │
│                                 │
│                          ( + )  │  ← add habit
├─────────────────────────────────┤
│   Today    Calendar   Settings  │
└─────────────────────────────────┘
```

Interaction rules:
- **Tap anywhere on the card toggles it.** Whole card is the target (≥ 64px tall).
- Untick is just another tap — plus an **"Undone · Undo"** toast for 4s, so a mis-tap is never
  scary.
- **Long-press (or ⋯ on desktop)** → edit sheet: rename, icon, color, schedule, archive,
  delete.
- **Drag handle in edit mode** to reorder.
- Haptic tick on Android (`navigator.vibrate(8)`); iOS web has no haptics API, the animation
  carries it.
- When everything scheduled is done: ring closes, header quietly says "All done today". No
  confetti — clean means restraint.
- Day rollover: re-render "today" on `visibilitychange` so an app left open overnight is right
  in the morning.

### 4.2 Add / edit habit (bottom sheet on mobile, dialog on desktop)

```
┌─────────────────────────────────┐
│  New habit                  ✕   │
│  ┌───────────────────────────┐  │
│  │ Drink 2L water            │  │
│  └───────────────────────────┘  │
│  Icon   💧 🏃 📖 🧘 💪 🥗 ✍️ …  │
│  Color  ● ● ● ● ● ● ● ●         │
│  Repeat [Every day] [Days] [N/week]
│         M T W T F S S           │  ← only when "Days" selected
│                                 │
│         [   Add habit   ]       │
└─────────────────────────────────┘
```
Only the name is required. Everything else has a sensible default (next unused color,
every day). No limit on the number of habits.

### 4.3 Calendar tab — see §5 (the research-backed design)

### 4.4 Habit detail (tap a habit's name in Calendar, or from the edit sheet)
Stats header, the habit's year heatmap, a 12-week bar chart, edit/archive. Detailed in §5.

### 4.5 Settings
- **Invite someone** (see §7)
- **Back up / Restore** — export a `.json` file, import one. Shows "Last backup: 27 days ago".
- **Theme**: System / Light / Dark
- **Week starts on**: Monday / Sunday
- **Archived habits** (restore or delete permanently)
- **Install the app** — platform-specific instructions (iOS needs Share → Add to Home Screen)
- **About & privacy**: "Everything you track stays on this device. Nothing is sent anywhere."
- **Erase all data** (typed confirmation)

---

## 5. Calendar & visualization — research and recommendation

### 5.1 What exists, and what each one is good at

| Pattern | Seen in | Answers the question | Strength | Weakness |
|---|---|---|---|---|
| **Year heatmap** (GitHub-style grid, 53 weeks × 7 days) | Loop, HabitHeat, many 2026 trackers | "How consistent have I been over months?" | Long-term pattern at a glance; beautiful | Tiny cells on a phone; poor for editing; one habit at a time or an aggregate that hides which habit |
| **Habit × day matrix** (rows = habits, columns = days) | Loop's main screen, Notion templates, paper bullet journals | "How's this week across everything?" | Best way to compare habits side by side; easy to edit | Only a week or two fits on a phone |
| **Month calendar with dots/fills** | Habitify, Way of Life, wall calendars ("don't break the chain") | "What did I do this month?" | Familiar mental model; big tap targets | With many habits, dots become confetti |
| **Rings** (per day or per habit) | Apple Activity, Streaks | "Did I close today?" | Emotional, motivating, instant | Hard to read history; >6 segments unreadable |
| **Streak counter** | Nearly every app, Duolingo | "How long is my chain?" | Very motivating early | All-or-nothing: one miss resets to 0 |
| **Habit strength score** (exponentially weighted) | Loop | "How established is this habit?" | Forgiving — a miss dents it, doesn't erase it | Abstract unless explained in one line |

### 5.2 What the research says, and what it means for the design

- **Missing one day doesn't hurt habit formation; missing several in a row does.** Lally et al.
  (2010) — the "66 days" study (median 66, range 18–254) — found single missed days didn't
  disrupt the automaticity curve. James Clear's "never miss twice" rule is the popular form.
  → *The calendar should make a single miss look like a small gap, not a broken chain.*
- **Strict streak resets are a leading reason people abandon trackers.** A reset to 0 triggers
  the "what-the-hell effect" (Polivy's dieting research): "it's already broken, why bother."
  Apps respond with streak freezes, grace days or strength scores.
  → *Lead with a forgiving metric; keep the streak, but don't make it the headline.*
- **Logging friction kills tracking.** If logging takes more than a few seconds, people stop.
  → *Editing past days must be possible directly from the calendar with one tap.*
- **"Missed" only means something relative to a schedule.** A Mon/Wed/Fri habit isn't missed on
  Tuesday. → *Three distinct day states: done, missed, not scheduled.*

### 5.3 Recommendation: one Calendar tab, three zoom levels, one habit filter

```
┌─────────────────────────────────┐
│ Calendar                        │
│ [ Week | Month | Year ]         │  ← segmented control (zoom level)
│ (All) (🏃 Walk) (📖 Read) (+2)  │  ← habit filter chips, horizontally scrollable
│ ...view...                      │
└─────────────────────────────────┘
```

The two controls are orthogonal: **zoom** (how much time) × **filter** (which habits). Every
combination has a sensible rendering, and the user's last choice is remembered.

#### Week — the habit × day matrix (default when "All" is selected)
```
            M   T   W   T   F   S   S
🏃 Walk     ●   ●   ○   ●   ●   ●  [ ]
📖 Read     ●   ●   ●   ●   ○   ●  [ ]
🧘 Meditate ●   ·   ●   ·   ●   ·   ·
            ‹ 22–28 Sep ›
```
- `●` done (habit color) · `○` missed (hollow ring) · `·` not scheduled · `[ ]` today.
- Tap any past cell to toggle it. Swipe for the previous week.
- This is the view people will actually use daily for "catching up" on yesterday.

#### Month — the "chain" calendar (the signature view)

**Single habit selected** — done days are filled in the habit's color, and **consecutive done
days are joined into one continuous pill**, so a streak is literally a visible shape:

```
  M    T    W    T    F    S    S
 (1━━━━2━━━━3━━━━4)   5   (6━━━━7)
 (8━━━━9━━━10━━━11━━━12━━━13━━━14)
 (15━━━16)  17  (18━━━19━━━20━━━21)
 (22━━━23━━━24━━━25━━━26━━━27) [28]
```
- A **single miss sandwiched between done days** draws a faint dashed bridge instead of a hard
  break — the "never miss twice" rule made visible. Two misses in a row break the pill.
- Missed scheduled days: hollow outline. Unscheduled days: plain number. Future days: dimmed.
  Days before the habit existed: blank.
- Tap a day to toggle it (with the undo toast).
- A one-line summary sits under the grid: "22 of 28 days · best run 7 days".

**"All" selected** — each day cell gets a **segmented ring**: one arc per habit scheduled that
day, filled in that habit's color if done, faint track if not. The date sits in the middle.
A day where everything is done gets a closed ring and a soft tinted background, so "perfect
days" pop out of the month.
- **Automatic fallback:** above 6 habits, arcs get too thin to read, so the cell switches to a
  single fill whose intensity = % of scheduled habits done (heatmap style), with the exact
  "5/8" on tap.
- Tapping a day opens a small sheet listing that day's habits, each tappable — backfilling
  several habits for one day in one place.

#### Year — heatmap
- **Single habit**: 53 × 7 GitHub-style grid in the habit's color (done / missed / not
  scheduled). Opens scrolled to today; month labels above.
- **All**: same grid, intensity = daily completion %, in a neutral accent.
- Read-only here (cells are too small to tap reliably on a phone); tapping a cell jumps to that
  month.

#### Habit detail — the stats that matter, in order
```
📖 Read a book                         ⋯
┌────────┬────────┬────────┬────────┐
│ 64%    │ 5 days │ 21 days│ 84%    │
│Strength│Streak  │ Best   │ 30-day │
└────────┴────────┴────────┴────────┘
[ year heatmap for this habit ]
[ bar chart: completions per week, last 12 weeks ]
```
- **Strength (headline metric).** Exponential smoothing as in Loop Habit Tracker: each
  scheduled day, `score = score·m + done·(1−m)`, where `m = 0.5^(√f / 13)` and `f` is the
  habit's frequency (1 for daily) — about a 13-day half-life for a daily habit. A few misses
  after a long run dent it; they don't zero it. One-line explainer under an ⓘ.
- **Streak / Best streak**: counted in *scheduled* days, so a Mon/Wed/Fri habit's streak isn't
  broken by Tuesday.
- **30-day rate**: done ÷ scheduled over the last 30 days.
- The bar chart (per week) shows trend — "am I getting better?" — which neither heatmaps nor
  streaks answer.

### 5.4 Why this beats a plain month calendar
- **Week matrix** answers the most frequent question (did I do everything lately?) and is the
  fastest place to fix a forgotten tick.
- **Chain pills** turn a streak from a number into a shape you can see growing — the motivating
  part of "don't break the chain" — while the dashed bridge removes its cruelty.
- **Segmented rings** keep the "All habits" month readable without dot confetti, and degrade
  gracefully when someone tracks 10 things.
- **Strength over streak** follows the research: reward consistency, forgive a single lapse.

### 5.5 Accessibility of the visuals
- Color is never the only signal: done = filled, missed = hollow outline, unscheduled = none.
- Habit palette chosen for color-vision-deficiency separation, and each habit also shows its
  emoji wherever color alone would identify it.
- Every cell has an `aria-label` ("Tuesday 23 September: Read a book, done").
- Keyboard: arrow keys move between cells, Space toggles.
- `prefers-reduced-motion` turns off the tick and ring animations.

---

## 6. Visual design system

**Direction:** calm, "paper and ink" neutrals with each habit carrying one saturated color.
Flat surfaces, hairline borders, generous radius, almost no shadow. Think Things 3 / Linear
restraint, not gamified.

### Tokens (CSS custom properties)
```css
:root {
  --bg: #FAFAF9;  --surface: #FFFFFF;  --border: #E7E5E4;
  --text: #1C1917;  --text-2: #78716C;  --text-3: #A8A29E;
  --radius-card: 18px;  --radius-chip: 999px;
  --space: 4px;           /* 4-pt grid: 8 / 12 / 16 / 24 / 32 */
  --ease: cubic-bezier(.2,.8,.2,1);
}
[data-theme="dark"] {     /* also under prefers-color-scheme: dark */
  --bg: #0C0C0D;  --surface: #161618;  --border: #27272A;
  --text: #FAFAF9;  --text-2: #A1A1AA;  --text-3: #52525B;
}
```

**Habit palette** — 8 hues defined in OKLCH at equal lightness/chroma so no habit looks louder
than another, with a lighter variant for dark mode: green, blue, violet, pink, orange, amber,
teal, slate. The done-card fill uses the color at ~14% opacity with a solid check, so text
contrast stays AA.

**Type:** Bricolage Grotesque for headings and big numbers, Figtree for everything else
(changed from Inter in the mockup; Inter felt generic). Both get self-hosted in the real app,
with no Google Fonts request, so the "nothing leaves your device" promise holds literally.
30/650 for the date header, 16.5/600 for habit names, 13/400 for meta. Tabular numbers for
stats.

**Motion:** tick = circle fills + check stroke draws (180ms), card background crossfades;
ring arcs animate on change; sheets slide up with the ease above. Nothing loops, nothing
bounces for more than one frame.

**Touch & layout:** targets ≥ 48px; safe-area insets for notched phones; bottom tab bar sits
above the iOS home indicator; no horizontal page scroll at 320px wide.

Before building, I'd make a static clickable mockup of Today + Calendar (light and dark) to
lock the look.

---

## 7. Inviting people (admin) without collecting data

### Recommended for v1: share the link
Settings → **Invite someone** opens the phone's share sheet (Web Share API) with the app URL,
and shows a **QR code** (generated on-device) for showing someone in person. Each person gets
their own fresh copy of the app with its own local data. You're the admin simply because you
own the site and its repo.

What you can and can't see: nothing. There's no server to report to. Not even a user count.

### Optional, if you want only invited people to use it
A stateless invite gate on the Cloudflare Worker you already run for Margin:
- You generate a link like `…/?invite=<token>` from a tiny admin page. The token is
  HMAC-signed with a secret only the Worker knows (optionally with an expiry).
- On first open the app asks the Worker "is this token valid?" → yes/no. The app remembers
  "invited" locally and never calls again.
- The Worker keeps **no list, no log, no database** — it just checks a signature.
- Honest caveat: the app's files are still public static files, so this is a polite door, not
  a vault. That's fine because there's no shared data behind it to protect.

---

## 8. Data safety (because it's local-only)

Local-only means the device *is* the database. Plan for the ways data gets lost:
1. **Ask for persistent storage** (`navigator.storage.persist()`) on first tick, so the
   browser won't evict it under storage pressure.
2. **iPhone: install to Home Screen.** Safari deletes site storage after 7 days without a
   visit when used as a plain website; home-screen apps are exempt. Onboarding says this
   plainly with a 3-step picture guide.
3. **Backup nudges.** A quiet banner after 30 days without an export: "Back up your history".
   Export is a single JSON file shared via the share sheet (save to Files/Drive/email yourself).
4. **Import is safe:** validates schema, shows "This will add 3 habits and 412 check-ins", merges
   rather than overwrites by default.
5. **Moving to a new phone** = export on old, import on new. That's the "sync" story for now.

---

## 9. Edge cases to get right
- Midnight rollover while the app is open; ticking at 23:59 vs 00:01.
- Time-zone travel (local date strings handle this; test it anyway).
- DST changes (never do date math in milliseconds — step by calendar day).
- Habit created mid-month: days before `createdOn` are "not started", not "missed".
- Schedule changed later: history is judged by the schedule at the time? **Decision: judge all
  history by the current schedule** (simpler, and what Loop does); note it in the edit sheet.
- "N per week" habits: a day is never "missed"; the week is judged as a whole (week row shows
  3/3 ✓).
- Archive vs delete: archive keeps history and hides from Today; delete asks for confirmation
  and removes checks too.
- Future days are not tappable. Past days are, back to `createdOn`.
- 0 habits (user deleted both defaults): friendly empty state with "Add your first habit".
- 30+ habits: Today list scrolls, month view uses the intensity fallback, filter chips scroll.
- Two open tabs on desktop: `BroadcastChannel` tells the other tab to re-render.

---

## 10. Build phases

| Phase | Scope | Done when |
|---|---|---|
| **0. Design mockup** | Static HTML of Today + Calendar (month, week) in light & dark | You approve the look |
| **1. Core** | IndexedDB layer, seeding, Today screen, tap-to-tick + undo, add/edit/archive/delete, reorder, week strip backfill | You can use it daily in a browser |
| **2. Calendar** | Week matrix, month chain view (single) + segmented rings (all), year heatmap, habit filter, tap-to-edit past days | All views render correctly for daily / weekday / per-week habits |
| **3. Stats** | Habit detail: strength, streaks, 30-day rate, 12-week bars | Unit-tested against hand-computed fixtures |
| **4. PWA** | Manifest, icons (incl. maskable + apple-touch), service worker, offline, update toast, install guide, persist() | Installs and works offline on Android, iPhone, Windows |
| **5. Safety & sharing** | Export/import, backup nudge, invite share + QR, erase-all, about/privacy | A backup restores exactly on another device |
| **6. Polish** | Animations, dark-mode tuning, a11y pass, empty states, 320px check | Lighthouse PWA + a11y ≥ 95; manual pass on real phones |
| **Later** | Invite gate on the Worker; habit variants (walk vs run); quantity habits (pages, minutes); reminders (local notifications / push); optional encrypted sync | — |

### Testing
- **Unit tests** (plain Node test runner, no deps) for `dates.js` and `stats.js`: streaks
  across DST, per-week habits, schedule edge cases, strength-score fixtures.
- **Playwright e2e** at iPhone and desktop viewports: tick/untick/undo, add habit, backfill
  from calendar, export → wipe → import round-trip, offline reload.
- **Real devices** before inviting anyone: an Android phone, an iPhone (installed to Home
  Screen), a desktop browser.

---

## 11. Decisions (defaults accepted 2026-09-28)
1. Invite model: **open share link in v1**, or the signed-invite gate from day one?
2. Walk/Jog/Run: **one habit** or one habit with a variant picker?
3. Week starts on **Monday** (changeable in Settings)?
4. Hosting: **GitHub Pages** (like Margin) or Cloudflare Pages next to the Worker?
5. Name: "Tick" or something else?

### Changes made while building the mockup
- **Week strip shows the last 7 days** (rolling), not the calendar week. On a Monday the
  calendar week would be one usable day and six future ones.
- **"+ New habit" is a dashed row at the end of the list** instead of a floating button:
  quieter and just as easy to find.
- **Habit stats live in the Calendar tab.** Picking a single habit chip shows its strength,
  runs, 30-day rate and 12-week bar chart around the calendar, so there's no separate
  detail page.
- **Streak copy is "N in a row"** (works for daily and Mon/Wed/Fri habits alike).

### Changes made while building the app (2026-09-28)
- **Reorder lives in Settings → Habits** (up/down buttons) instead of drag handles. It's simpler
  and works with a keyboard. Drag-to-reorder on Today can come later.
- **"N per week" schedules are not built yet.** Every day or specific weekdays only. The data
  model has room for it.
- **The app asks for persistent storage on the first tick**, not on first launch, so the browser
  prompt (where there is one) comes after the user has something worth keeping.
- **A new habit's card says "New"** until its first tick, rather than "Strength 0%".
- **A past day before any habit existed** says so, instead of showing an empty list.

### Added 2026-09-30 (the "Later" list, except the invite gate)
- **"N times a week"**: any N of the week's days (1–6). A week is judged once it ends: undone
  days are "not needed" once the target is met, and "missed" only in a week that fell short.
  Runs and strength count weeks (strength half-life 4 weeks). A first partial week only counts
  if it was met. Today shows the habit until the week's target is met.
- **Daily amounts** (pages, minutes): the day is done once the amount reaches the goal. On Today,
  tapping the habit opens a number sheet (the day's total, − / + in steps of 5 for goals ≥ 20);
  the check circle fills partway. In the calendar a tap still toggles (done = the full goal).
- **Kinds** (Walk / Jog / Run): a comma-separated list on any habit. Chips appear on the card
  after ticking, so the tick stays one tap. The default habit got Walk, Jog, Run (settings
  schema version 2 migrates existing installs). The calendar shows counts per kind.
- **Reminders use Web Push from the Worker** (chosen over calendar-file reminders). The Worker
  stores only the push address, reminder times with weekdays, and time zone; the push is empty
  and the service worker reads the habits locally to word it. This is the one exception to "no
  server that receives data", stated in Settings → Reminders and Privacy.
- **Amount and kinds are always the user's choice.** They sit under a collapsed "More options"
  in the add/edit sheet (open when a habit already uses them), so adding a habit stays name,
  icon, color, repeat. The habit's name can *suggest* one: "read / book / pages" → 20 pages a
  day, "meditate / yoga / study / practice" → 15 minutes, "water / drink" → 8 glasses, and a
  name with parts ("Walk / Jog / Run", "Tea or coffee") → those parts as kinds. A suggestion
  is a button; nothing is applied without a tap.
- **Reminders scale by spreading**: each cron run sends at most 45 pushes (free plan ≈ 50
  outgoing requests per run); the rest go out in the next minutes (a reminder stays due for
  30 minutes). Each device gets only its own reminders: the server keys records by push address.
- **Drag to reorder on Today**: press and hold lifts the card; release to edit (as before), or
  move to drag. Up/down buttons in Settings stay for keyboards.

---

## 12. Encrypted cloud backup and sync (planned and built 2026-10-01)

This replaces the "no sync" non-goal in §1 and the "no backend" argument in §2. It follows the
design Sol (`../journal`, PLAN §8) already runs in production. Read that section for the
reasoning behind the vault, the recovery code and the invite gate; this section only records
what is reused and where Tick has to differ.

### 12.1 What it promises
- **Optional.** Without backup, Tick behaves exactly as today and talks to no backup server.
- **Turning it on** makes a random 128-bit key, shown once as a 28-character recovery code and
  a QR code. You confirm its last 4 characters. A second device opens the backup by typing
  the code.
- **Encrypted on the device.** AES-256-GCM, keys derived from the code with HKDF. The server
  stores ciphertext under opaque ids (HMAC of the local id). Each record is padded to a
  multiple of 256 bytes. The server never sees habit names, dates, ticks, amounts or kinds.
- **Sync:** pull first, then push what changed here. Last write wins per record, by
  `updatedAt`. Deletions are tombstones. It runs on open, on focus, on reconnect and a few
  seconds after a change, and backs off when the server can't be reached (30 s, doubling, up
  to 15 min).
- **Creating a vault needs a signed invite link** (`INVITE_SECRET`). The Worker checks the
  signature and expiry and stores nothing about invitees. The app itself stays open to anyone.
- **Strict Content-Security-Policy** in `_headers`: scripts from this site only.

### 12.2 What is reused from Sol

| Sol file | In Tick | Change |
|---|---|---|
| `js/crypto.js` | `js/crypto.js` | HKDF salt `tick-vault-v1`, so a Tick code and a Sol code never derive the same keys. Nothing else. |
| `js/sync-core.js` | `js/sync-core.js` | None. Kept byte-identical so a fix in one app copies to the other. |
| `js/sync.js` | `js/sync.js` | Wording; also syncs after another tab or the service worker changed data (§12.6). |
| `js/backup-ui.js` | `js/backup-ui.js` | Tick's sheet markup and wording; QR text is `tick:<code>`. |
| `worker/index.js` (`/api/vault`, `/api/sync`) | `worker/vault.js` | The code, unchanged, in its own file (§12.9). |
| `worker/migrations/0001_vaults.sql` | same path | Database name only. |
| `tools/invite.mjs` | `tools/invite.mjs` | Imports `signInvite` from `worker/vault.js`. |
| `_headers`, `js/boot-theme.js` | same paths | `tick.theme` key. |
| `tests/crypto.test.js`, `tests/sync.test.js`, `tests/helpers/d1.js` | same paths | Sync test rewritten around habits and checks (§12.12). |

New in Tick: `js/records.js`, a pure module (no IndexedDB, no DOM) that holds everything about
records that sync: ids, the wire form, stamping, tombstones, applying remote records, the merge
on linking, and the upgrade from today's schema. `store.js` uses it; so do the tests.

### 12.3 Records

Three kinds sync. Each has `id`, `kind`, `updatedAt`, and becomes a tombstone when deleted.

| Kind | Id | Fields (inside the ciphertext) |
|---|---|---|
| `habit` | the habit's id, `h…` | name, icon, color, schedule, kinds, goal, order, createdOn, archivedOn |
| `check` | `c:<habitId>:<date>` | at, amount?, pick? (the kind picked: Walk / Jog / Run) |
| `prefs` | `s:prefs` | weekStart |
| tombstone | same id | `{ id, kind, updatedAt, deleted: true }` and nothing else |

- **A check's id is made from its habit and date**, so two devices that tick the same habit on
  the same day write the same server row. The server sees only the HMAC of that id.
  Habit ids can't contain `:` (they match `[\w-]{1,40}`), so the id splits back unambiguously.
- **A check already has a field called `kind`** (the picked Walk / Jog / Run). In the wire form
  it travels as `pick`, so `kind` can mean the record type as in Sol. On the device and in
  backup files it stays `kind`; nothing that reads checks today changes.
- **Unticking writes a tombstone** in place of deleting the row. So does clearing an amount.
  Ticking again later replaces the tombstone.
- **Deleting a habit tombstones the habit and every one of its checks**, in one transaction.
  Undo writes them all back with a new `updatedAt`, so the undo wins on every device.
- **A check whose habit is missing or deleted is ignored** everywhere (not shown, not counted,
  not exported). This happens when one device deletes a habit while another, offline, ticks
  it. Devices do not "repair" such checks by tombstoning them: a repair made halfway through
  receiving an undo would delete ticks the user just restored. (A habit merged into another
  on linking is the one exception, §12.7: its tombstone says where the ticks belong.)
- **A habit's `reminder` time does not sync** (§12.5). It stays on the habit row on this
  device and is left out of the wire form. Saving a habit when only its reminder changed does
  not bump `updatedAt`, so it can't overwrite a rename made on another device.
- **Habit order** is the `order` number on each habit, so it syncs with the habit. Two devices
  can both add a habit offline and pick the same number, so habits sort by `order`, then
  `createdOn`, then `id`, which is the same on every device.
- **Amounts are last-write-wins too.** An amount is the day's total, so if two devices log the
  same habit on the same day before syncing, the later total stands; they are not added up.

Sizes: a check encrypts to about 380 bytes on the server, a habit to about 730. Five habits
ticked every day is about 0.7 MB a year against the 25 MB quota per vault.

### 12.4 On the device: IndexedDB version 2

| Store | Key | Holds | Synced |
|---|---|---|---|
| `habits` | `id` | habit rows, now with `updatedAt`; tombstones `{ id, deleted, updatedAt }` | yes (except `reminder`) |
| `checks` | `[habitId, date]` | check rows, now with `updatedAt`; tombstones `{ habitId, date, deleted, updatedAt }` | yes |
| `settings` | `id` | one row, `prefs`: `{ weekStart, updatedAt }` | yes |
| `dirty` (new) | `id` | `{ id, updatedAt }` for records changed here and not uploaded yet | no |
| `local` (new) | `key` | `settings` (this device's own), `vault` (backup state), `pushTest` | no |

`habits` and `checks` keep their stores and keys. Every write stamps `updatedAt` (always moving
forward: `max(now, previous + 1)`) and puts a `dirty` mark in the same transaction. This
happens whether or not backup is on, as in Sol.

**Upgrade from version 1** runs inside the one `onupgradeneeded` transaction, so it either
completes or leaves the old database untouched:
1. Create `dirty` and `local`.
2. Move the `app` settings row to `local/settings` and the `pushTest` marker to `local/pushTest`.
3. If the week starts on Sunday (not the default), write `settings/prefs` with that choice. If it is the
   default, write nothing: a setting nobody chose must not override a real choice on another
   device.
4. Stamp every habit and check that has no `updatedAt`:
   - a check gets its `at` (the moment it was ticked);
   - a habit gets the start of its `createdOn` day plus the time of day the upgrade ran.

   These stamps are deliberately old. Any real edit made after the upgrade, on any device, is
   newer and wins. The time-of-day part keeps two devices that both carry the same habit (moved
   earlier with a backup file) from stamping it identically: with equal stamps and different
   contents, last-write-wins would never settle.
5. Nothing is deleted and no row is rewritten beyond gaining `updatedAt`.

The row arithmetic is a pure function in `records.js` (`upgradeV1(rows, now)`), tested in Node.
The real upgrade is tested in a browser, from a version 1 database built by the test (§12.12).

Also: the database now closes itself on `versionchange`, so a later upgrade is not blocked by
another open tab. (For this first upgrade an old tab still blocks it, with today's message.)
On load, a row found without `updatedAt` is stamped and marked dirty; that covers a tick
written by the old service worker during an update.

### 12.5 What syncs and what stays on the device

| Setting | Where | Why |
|---|---|---|
| Habits, their order, archived state | synced | They are the data. |
| Ticks, amounts, picked kinds | synced | They are the data. |
| Week starts on | synced (`s:prefs`) | Changes how weekly habits are judged; two devices must agree or they show different streaks. |
| Theme | device | A phone and a laptop are often set differently. |
| Reminder time per habit | device | A reminder is "notify this device". Synced, every device with notifications on would buzz. |
| Push subscription, `pushSynced` | device | Tied to this browser. |
| Backup state: code, cursor, last sync, last error | device | It is the key; it must never be uploaded. |
| Invite token, install tip, backup-file nudge, `firstUsedOn` | device | About this install. |

Reminders are untouched on the server side: the Durable Object, the cron and `/api/push/*` do
not change. In the app, `push.js` also re-checks its reminder times after remote changes,
since a habit deleted or archived on another device may have had a reminder here.

### 12.6 The service worker writes too

`sw.js` ticks a habit from the notification's "Mark done" button, straight into IndexedDB.
- That write now stamps `updatedAt` and puts the `dirty` mark `c:<habitId>:<date>` in the same
  transaction. If the old row is a tombstone, it is replaced, not merged.
- Reading what is due skips tombstoned habits and checks. Until now "the row exists" meant
  done; that is no longer true anywhere.
- It reads the week start from `settings/prefs` and the test marker from `local/pushTest`.
- **An update can reach the service worker before the page has upgraded the database.** So
  the worker checks the database version and reads the old places when it is still version 1
  (and skips the `dirty` store, which doesn't exist yet). The upgrade keeps an `updatedAt` it
  finds, and turning backup on marks everything dirty anyway.
- The page hears about the tick over the BroadcastChannel as today, reloads, and now also
  schedules a sync if anything is dirty. With the app closed, the tick uploads the next time
  Tick opens.
- `/api/` requests bypass the worker's cache, as in Sol.

The id format `c:<habitId>:<date>` therefore lives in two places (`records.js` and `sw.js`,
which is a classic script and can't import modules). Both carry a comment pointing at the other.

### 12.7 Linking a device that already has habits

Every fresh install seeds "Walk / Jog / Run" and "Read a book" with new random ids. So a second
device always has two habits of its own when the code is typed in, often with today's ticks.
Sol's rule ("keep everything, upload it too") would leave two of each.

On linking, after the first pull and before the first push:
- A habit that was on this device and a habit from the backup with the **same name** (ignoring
  case and spaces at the ends, archived habits left alone) are combined. **The older one
  survives**: earlier `createdOn`, then the smaller id. The rule doesn't depend on which
  device applies it or on which copy was in the backup first, so every device picks the same
  survivor. It also keeps the earliest start date, which matters because days before
  `createdOn` are "not started".
- The other habit's ticks move to the survivor for every day the survivor has no tick. The
  other habit becomes a tombstone that **names the survivor** (`mergedInto`), and its checks
  become tombstones.
- **Ticks follow that pointer on every device.** After each pull, a live check on a habit that
  was merged away is moved to the survivor (following a chain if there is one). This is what
  makes two devices linking at the same moment agree: if one merges A into B while the other
  merges C into A, the ticks from C still end up on B.
- A reminder time set on this device for the habit that went away is kept on the survivor.
- Any other local habit is kept and uploaded. Habits sort by `order`, then `createdOn`, then
  `id`, so equal order numbers from two devices fall the same way everywhere.
- The sheet says so before you confirm: "Habits already on this device are kept. One with the
  same name as a habit in your backup is combined with it."

This only happens on linking. Two linked devices that each add "Gym" get two habits. One gap
remains: two devices that link in the same moment to a backup that has no habit of that name
both upload theirs, and you get two; delete or archive one.

### 12.8 Backup file

Export and restore keep working and keep their promise: restore adds what is missing and
changes nothing that is here.
- The file becomes `version: 3`: habits and checks carry `updatedAt`. Tombstones are not
  exported; the file is a snapshot of what exists.
- **Missing here** now means "not here, or deleted here". Restoring a file after deleting a
  habit by mistake brings it back, on every device.
- A record that was never here keeps the file's `updatedAt`. If a newer copy is in the cloud
  and hasn't arrived yet, the cloud copy still wins. A record restored over a tombstone is a
  new edit, stamped now.
- Version 2 files (no `updatedAt`) are still accepted and get an old stamp, as in the upgrade.
- **Erase all data** clears this device and turns backup off here. The cloud copy stays;
  Settings says so, and deleting it is under Turn off. Undo puts back the data and the link.
- The 30-day "back up your history" nudge on Today is not shown while cloud backup is on.

### 12.9 Worker and config

- `worker/vault.js`: Sol's vault code as it is (`api`, `signInvite`, `validInvite`). It imports
  nothing from Cloudflare, so Node can load it for the tests and for `tools/invite.mjs`.
  `worker/index.js` can't be loaded in Node because it imports `cloudflare:workers`.
- `worker/index.js`: one new line in `fetch`: `/api/vault` and `/api/sync` go to `vault.js`.
  Everything else under `/api/` goes to the reminder code as today. The `Reminders` class,
  the push routes and `scheduled` are not edited.
- `wrangler.jsonc`: a `d1_databases` binding `DB` (database `tick`, migrations in
  `worker/migrations`) beside the Durable Object binding and the cron. Its own database and
  its own `INVITE_SECRET`, not Sol's: a Sol invite does not open Tick.
- `npm run dev`: applies the migration locally, then `wrangler dev --port 8788` (Sol uses
  8787), both with `--persist-to ~/.cache/tick-wrangler`. Kept inside the project, every
  database write looks like a file change and wrangler reloads in a loop.
- `.dev.vars` gains a local `INVITE_SECRET` beside `VAPID_JWK`. `.assetsignore` gains `tools`.
- Quota and limits as Sol: 25 MB per vault, 500 records per pull page, 200 per push.

### 12.10 Screens and wording

- **Settings → Cloud backup**, a new group above "Your data": Off / On / Needs attention, when
  it last synced, and the buttons from Sol (Turn on backup, I have a recovery code; then Back
  up now, Show recovery code, Turn off…). The four sheets are Sol's, in Tick's sheet style.
  There is no mockup for these; I'll screenshot them for you before calling it done.
- An invite link (`…/?invite=…`) is saved on the device and removed from the address bar.
  Settings → Invite keeps sharing the plain app link; a backup invite comes from
  `tools/invite.mjs`.
- Wording that stops being true once backup is on, and what replaces it:
  - nav: "Everything you track stays on this device." → "Only your devices can read what you track."
  - Settings → Your data: "Stored on this device only" → adds "and encrypted in your cloud backup" when on.
  - Settings → Privacy: gains what the server can and can't see with backup on.
- "The server can't see": habit names, which days you ticked, amounts and kinds.
  "The server can see": that a backup exists, how many records it has and their sizes, and
  when your devices sync (so, roughly when you use Tick).
- A sync never redraws the list in the middle of a drag; it redraws when the drag ends.

### 12.11 Content-Security-Policy

`_headers`, as Sol: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self';
manifest-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none';
form-action 'none'`, plus `nosniff`, `Referrer-Policy: no-referrer` and a Permissions-Policy.
- The inline theme script in `index.html` moves to `js/boot-theme.js`.
- `style-src` needs `'unsafe-inline'`: habit colors are set with `style="--c:…"` on every card.
- Push subscription is done by the browser, not by a page request, so `connect-src 'self'`
  doesn't affect reminders.

### 12.12 Tests

- `tests/crypto.test.js`: Sol's, with Tick records (code round-trip, typo checksum, key
  derivation, padding to 256, tamper and wrong-key failures).
- `tests/records.test.js`: the version 1 → 2 upgrade from today's rows (nothing lost, stamps
  as in §12.4, default week start writes no record, rows already stamped are left alone);
  wire form round-trip (reminder left out, `kind` ↔ `pick`, tombstones); check ids.
- `tests/sync.test.js`: two devices built on `records.js`, syncing through the real Worker
  code over `node:sqlite`. Ticks; unticks as tombstones; the same day ticked on both devices
  lands on one server row; a habit delete takes its checks with it, and undo brings them back
  on the other device; a tick written the way the service worker writes it arrives; linking
  a device with seeded habits combines them; newer edit wins; paging; invites; vault delete;
  malformed pushes. And the database dump contains no habit name, date, kind, amount unit,
  local id or auth secret.
- `tests/e2e/smoke.mjs`, run against `npm run dev`:
  - starts from a **version 1 database** created in the browser before the app loads, and
    checks habits, ticks, kinds, week start and theme survive the upgrade;
  - the existing checks;
  - backup refused without an invite; turned on with one; a second browser context opens it
    with the code and sees the habits and ticks, with no duplicate default habits; an untick
    and a "Mark done" from the service worker travel across; the local D1 dump has no
    readable data;
  - backup file export → erase → restore still passes.
  Against the plain static server (no API) the backup checks report SKIP.

`npm test` stays dependency-free. That is why the upgrade is tested as a pure function plus a
real browser, and not with a fake IndexedDB package.

### 12.13 Decisions, and the alternatives that lost

| Decision | Lost | Why |
|---|---|---|
| Keep the `habits` and `checks` stores; add `updatedAt`, `dirty`, `local` | Sol's single `records` store | The service worker and the backup file read these stores. Moving every row is a riskier upgrade for no gain. |
| Check id `c:<habitId>:<date>` | Random id per check | Two devices ticking the same day would make two rows, and "done" would be counted twice. |
| Tombstones always, backup on or off | Delete rows while backup is off | One code path in three writers (store, service worker, restore). A tombstone is about 80 bytes. |
| Mark dirty always | Only while backup is on | Same reason, and no way to miss an upload when backup is turned on mid-session. |
| Old stamps on upgrade | Stamp with the upgrade time | A device that upgrades later would beat real edits made earlier on another device. |
| Don't sync reminder times | Sync the whole habit | Every device with notifications on would get every reminder. |
| Sync week start | Per device | Devices would disagree about streaks and weekly targets. |
| Order as a number on each habit | One synced "order" record | The backup file, the service worker and sorting already use `habit.order`. Per-habit last-write-wins can mix two simultaneous reorders, which the fixed tie-break makes at least identical everywhere. |
| Combine same-named habits on linking | Keep both, as Sol does | Every new device seeds the same two habits. |
| The older habit survives a combine | The backup's habit survives | "Whichever was uploaded first" depends on timing; "older" is the same answer on every device, and keeps the earliest start date. |
| Ignore checks of deleted habits | Tombstone them on sight | A repair racing an undo deletes restored ticks. |
| `sync-core.js` unchanged | Add a tie-break for equal `updatedAt` | Equal stamps only come from the upgrade, and §12.4 avoids them there. |
| Tick uploads a "Mark done" on next open | Sync from the service worker | It is a classic script; it would need its own copy of the crypto and sync code. |
| Upgrade tested as a pure function + in a real browser | `fake-indexeddb` dev dependency | Keeps `npm test` with no dependencies, and a real browser is the stronger test. |
| Own D1 database and invite secret | Share Sol's | Separate apps, separate quotas, and deleting one never touches the other. |
| Vault code in `worker/vault.js` | Inline in `worker/index.js` | Node can't import `cloudflare:workers`; tests and the invite tool need the vault code. |

### 12.14 Limits worth knowing
- **Lose the recovery code and every device, and the backup can't be opened by anyone.**
- **On the device the data is plaintext in IndexedDB**, as today. The phone's lock protects it.
- **Last write wins by each device's clock.** A device whose clock is far ahead wins until
  the others catch up.
- **The server sees timing.** A sync a few seconds after each tick shows when you use Tick,
  though not what you ticked.
- **Reminders and backup are separate tables with no shared id.** The reminder table still
  holds push address, reminder times and time zone (§11). Only request logs (IP address,
  time), which Cloudflare keeps, could connect a vault to a push address.
- **Any web app trusts the code it is served.** The CSP narrows that to this site's own files.

### 12.15 Build order
1. `records.js` and its tests (ids, wire form, upgrade).
2. `db.js` version 2 and `store.js` on top of `records.js`; existing smoke test passes, plus
   the upgrade-from-version-1 check.
3. `sw.js` (tombstones, stamp, dirty, both schema versions), `VERSION` → `tick-v5`, new files
   in `SHELL`.
4. `crypto.js`, `sync-core.js`, `worker/vault.js`, migration, `tools/invite.mjs`, sync tests.
5. `sync.js`, `backup-ui.js`, Settings, wording, `_headers`, `boot-theme.js`.
6. Backup file version 3. End-to-end with two browser contexts.
7. README, TODO. No deploy and no push.

### Changes made while building
- **Erase keeps the week start and the invite** on the device, as it already kept the theme.
- **A habit that was deleted elsewhere can't be brought back by saving a stale edit sheet.**
  Saving or archiving a habit that is no longer live does nothing.
- **A row found without `updatedAt` on load is stamped and marked for upload.** This covers a
  tick written by the previous service worker in the moment between a hard reload and the new
  worker taking over.
- **The simultaneous-link gap stays** (§12.7, last paragraph). It is listed in TODO.md.
- **The smoke test prepares its version 1 database from `/api/blank`**: once the service
  worker is installed it answers every page load with the app, and `/api/` is the one path it
  leaves alone.

Deploy, to do together afterwards: `npx wrangler d1 create tick` and paste the id into
`wrangler.jsonc`; `npx wrangler d1 migrations apply tick --remote`;
`npx wrangler secret put INVITE_SECRET` **before** pushing (without it anyone can create a
vault); then push.

---

## 13. Version label, name and greeting, admin page (2026-10-05)

Taken from Pie (`../split`), which built them the same day; the code is Pie's, in Tick's style.

- **Version.** The service worker answers a `version` message with its `VERSION`; before it is
  in charge the app reads `sw.js`. Shown as "Tick v5" at the bottom of Today and "This is Tick
  v5." at the bottom of Settings. (Pie puts it in a fixed corner; Tick's bottom nav is there.)
- **Name and greeting.** Today asks "What should we call you?" once, with "Not now". The name
  is set or changed in Settings → Preferences. Today then says "Good morning / afternoon /
  evening, <name>", or "Hi, <name>" from 10 pm to 5 am, above the date. **The name stays on
  the device; it doesn't sync.** It would have to be its own record: inside `s:prefs`, a second
  device naming itself on first open would overwrite the week start chosen elsewhere. The
  backup file carries it, and a restore sets it if the device has none. Erase keeps it.
- **Admin page** (`#admin`, no nav button; Settings shows an Admin row once unlocked). Unlocks
  with the admin key, which is `INVITE_SECRET`, typed or from `tools/admin-link.mjs` (the key
  sits after `#`, so it never reaches a server, and the app takes it out of the address at
  once). It makes invite links (7–90 days) and shows the backups on the server: count, records,
  bytes, created and last-changed dates, and a 6-character id prefix. `GET /api/admin/stats` in
  `worker/vault.js` compares SHA-256 hashes of the key, so timing says nothing about it. A
  server without `INVITE_SECRET` has no admin. Unlocking gives the device a one-year invite.
  The key is kept in this device's own settings: never synced, never in a backup file.
- Not shown on the admin page: reminder subscriptions. They live in the Durable Object, and the
  reminder code is left as it is.

---

## Sources
- Loop Habit Tracker (strength score, matrix view): https://github.com/iSoron/uhabits ·
  FAQ: https://github.com/iSoron/uhabits/discussions/689
- Lally et al. 2010 / 66-day rule explained: https://keelify.com/blog/66-day-habit-rule-explained
- Never-miss-twice rule: https://www.ehm-tech.com/habit/blog/never-miss-twice-rule/
- Streak anxiety & recovery mechanisms: https://habitdoom.com/blog/streak-anxiety-habit-trackers ·
  https://tracebyme.com/blog/habit-tracker-streak-anxiety-two-day-rule/ ·
  https://www.habidu.com/news/habit-streaks-psychology/
- Heatmap trackers: https://habitheat.com/heatmap-habit-tracker/ ·
  https://serverless.tools/habit-tracker/
- WebKit storage policy (7-day eviction, home-screen exemption):
  https://webkit.org/blog/14403/updates-to-storage-policy/ ·
  https://www.magicbell.com/blog/pwa-ios-limitations-safari-support-complete-guide
