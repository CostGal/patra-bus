# Frontend (`web/`)

How the phone app in `web/` is built and what it keeps on the device. `web/` is Kostas's area; the plain overview is in
[ARCHITECTURE.md](ARCHITECTURE.md). Motion and materials: [DESIGN.md](DESIGN.md). Tests: [TESTING.md](TESTING.md). The Worker:
[WORKER.md](WORKER.md). The citybus.gr API: [UPSTREAM-API.md](UPSTREAM-API.md).

## 1. Ground rules for this folder
- Vanilla JavaScript with ES modules. No build step, no framework, so what is in `web/` is what the browser runs.
- The map is MapLibre GL JS 4.7.1, copied into `web/vendor/maplibre-gl/` (not loaded from a CDN), with OpenFreeMap styles
  (`liberty` for light, `fiord` for dark, `map.js:9-12`).
- The site is served from `/patra-bus/` on GitHub Pages, so every path inside `web/` is relative (`./data/…`, `sw.js`,
  `start_url: "./"`). A path starting with `/` breaks the live site.
- One CSS file and one `i18n-en-<feature>.js` per feature (`css/report.css`, `i18n-en-report.js`), so two people do not edit the
  same file. `i18n-en.js` pulls the per-feature files in (`i18n-en.js:3-5`). The Greek text is the key: `t('Αναζήτηση')`.
  The rule that every visible string has Greek and English is CLAUDE.md rule 3.
- A new file in `web/` must be added to the `SHELL` list in `sw.js:36`, or it is missing offline.

## 2. Routing
The router lives in `js/app.js` (`route()`, line 645) with helpers in `js/route.js`. A hash looks like `#/{view}/{arg}?{query}`
with an optional city prefix: `#/corfu/stop/801`.
- No prefix means Patras when the hash points at something (a stop, a line, coordinates), so old links keep working
  (`route.js:43-56`). Bare views such as `#/`, `#/lines`, `#/favorites` open in the saved `settings.city`.
- Links inside the app use `cityHash()`. Anything that leaves the page (share links) uses `shareHash()`, which always adds the prefix.
- The city is chosen once at start by `js/boot-city.js` (imported first by `app.js`). A link into the other city, or the
  picker in Settings, saves `settings.city` and reloads the page (`app.js:633-649`), so modules may read the city at load time.
- `?demo` in the page query (not the hash) switches to made-up live data from `js/demo.js`; `?demo=nosvc|error|stale`
  shows those states (`api.js:20-21`).

| Hash | Module | Shows | `app.js` |
|---|---|---|---|
| `#/` | `app.js` (`mountHome`) + `nearby.js` | the "next bus near you" card; favourites and recents when the sheet is open | 730, 508 |
| `#/stop/{code}` | `arrivals-view.js` | arrival tiles for one stop (LIVE or ΠΡΟΓΡ.) | 684 |
| `#/bus/{vehicleCode}?route=&stop=` | `bus-view.js` | one bus as a timeline of stops, anchored on the stop it was opened from | 697 |
| `#/lines` | `lines-view.js` | searchable list of lines | 701 |
| `#/line/{code}?dir=&route=` | `lines-view.js` | one line on the map with its stops | 705 |
| `#/favorites` | `app.js` (`mountFavorites`) | saved stops | 717 |
| `#/pin?lat=&lng=` | `app.js` (`mountPin`) | stops within 1.5 km of a long-pressed point | 721 |
| `#/settings` | `settings-view.js` | settings, data, about, credits | 709 |
| `#/report` | `report-view.js` | problem report form | 713 |

An unknown first segment goes back to `#/` (`app.js:660`). `SNAP` (`app.js:630`) says how high the sheet opens for each view.
Every view exports `mountX(container, ctx, params) → { destroy() }`. It draws inside `container` and must remove its timers,
pollers, listeners and map markers in `destroy()`. `ctx` (`app.js:812-816`) holds `data`, `map`, `location`, `navigate(hash)`,
`sheet.snap(to)` (`'peek' | 'half' | 'full'`), `toast(text, opts)` and `switchCity(id)`. `sheet.js` is a bottom sheet on phones
and a left panel from 900 px.

## 3. Module map (`web/js/`)
Marked **(W)** are also imported by the Worker, so they must not touch the DOM.

- **Shell and map**: `app.js` (boot, router, search box, menu, locate button), `sheet.js` (the sheet), `map.js` (MapLibre
  wrapper, markers, follow mode), `ui.js` (`h()` DOM helper, icons, toast, line badge), `motion.js` (spring engine), `color.js`
  (makes line colours readable), `index.html` and `app.css` outside `js/`.
- **Live data**: `arrivals.js` **(W)** (live vs scheduled, ETA text), `api.js` (`fetchLive`, poller, stats), `arrivals-view.js`
  (stop view and the tile), `demo.js` (`?demo` data).
- **Location and nearby**: `location.js` (the one GPS service), `geo.js` (distances, bearing, `inArea`), `walk.js` (walking time,
  OSRM), `nearby.js` (the home card), `city-detect.js` (offers the other city when GPS is inside its box).
- **Search and places**: `geocode.js` (stops first, then Photon), `places.js` (saved home/work places, see section 5).
- **Lines and vehicle**: `lines-view.js`, `bus-view.js`, `data.js` (loads stops, lines, routes; search ranking).
- **Storage, settings, share**: `store.js` (the main blob), `settings-view.js`, `share.js` (Web Share, else clipboard),
  `notify.js` (local reminder timers; today its only user is the test button and the list in Settings, `settings-view.js:4,148`;
  `app.js:18` imports it so persisted reminders re-arm), `usage.js` (anonymous counts).
- **First run, welcome, report**: `setup.js`, `welcome.js`, `report-view.js`, `report.js` **(W)** (validation and diagnostics
  whitelist), `platform.js` (iOS/Android, installed or browser).
- **Language and text**: `i18n.js` (`t`, `tn`, `N_`, `lang`), `i18n-en.js` + `i18n-en-report|welcome|setup.js`, `text.js`
  (`titleCase`, `searchKey`), `accents.js` (word list).
- **City and routing**: `cities.js` **(W)** (city table), `route.js`, `boot-city.js`.
- **Shared with the Worker, no other use in the app**: `notif-link.js` **(W)** (`isPrivateUrl`; the Worker uses it to drop
  notification links that carry a place, `worker/src/reminders.js:5`). Nothing in `web/js` imports it.

## 4. Data files
- Patras lives in `web/data/`, other cities in `web/data/{city}/` (`dataDir()` in `cities.js:44`): `stops.json`, `lines.json`,
  `routes.json`, `shapes.json`. They are committed and refreshed with `npm run fetch-static` (stops and lines, then routes;
  see UPSTREAM-API.md) or `npm run build-routes` (routes and shapes only). For another city add the flag:
  `npm run fetch-static -- --city=corfu`, `npm run build-routes -- --city=corfu`.
- `routes.json` has `version`, `generatedAt` and `routes`. Each route has `code`, `lineCode`, `direction`, `stops` (ordered
  codes), `legSec` (seconds per leg) and `confidence` (0 to 1). **The stop order is inferred**, not official. In Patras 10 of 80 routes
  have `confidence < 0.5`; in Corfu 0 of 55 (counted in the files). `data.js:15-30` drops unknown stops and rebuilds a bad `legSec`.
- `shapes.json` (drawn line geometry) is loaded on demand by `loadShapes()`; a city without it just has no drawn lines.
- `web/fixtures/live-1011.json` is one real upstream answer, used by `?demo` as a fallback.
- Codes are strings and keep leading zeros (Corfu route `093` is not `93`). Never turn a code into a number. Stop codes repeat
  between cities, so every cache key and stored item carries the city.

## 5. Storage on the device
| Key (`localStorage`) | Holds | Where |
|---|---|---|
| `patra-bus:v2` | One JSON blob, schema 3: favourites, recents (stops and places), settings, first-run flags | `store.js:8,10` |
| `patra-bus:places` | Saved home, work and up to 3 custom places, with coordinates the user chose | `places.js:8` |
| `patra-bus:reminders` | Pending local reminders (only the Settings test creates them) | `notify.js:9` |
| `patra-bus:loc-granted` | `'1'` once a GPS fix worked, so the app may start location without a prompt | `location.js:14,126` |

Every access is wrapped so a blocked or full storage falls back to memory. The old `favs` key is migrated and removed
(`store.js:128-132`). `index.html:45` reads the theme from the blob before first paint.

Favourites, recents, places and reminders each carry a `city`; an item without one is Patras. Lists show only the active city.

Flags inside the blob's `settings` (`store.js:19-32`):
| Setting | Meaning | Set when |
|---|---|---|
| `city`, `lang`, `theme`, `walkSpeed`, `bufferMin`, `reminderMin` | preferences (`reminderMin` is only a Settings row; nothing reads it) | user changes them |
| `setupDone` | first-run setup was shown | when it opens (`setup.js:50`) |
| `welcomeSeen` | testers' welcome was shown | when it opens (`welcome.js:21`) |
| `usageStats` | counting on (default) or off | Settings → Data |
| `usageDay` | Athens day of the last `open` count sent | after a successful POST (`usage.js:46-47`) |
| `usageInstall` | the `install` count was sent | after a successful POST (`usage.js:51-52`) |
| `legendSeen` | unused, still accepted so old blobs stay valid | never |

"Διαγραφή όλων των δεδομένων" (`settings-view.js:222`) calls `clearAll()` (removes the whole blob, flags included) and cancels
the pending reminders. It leaves `patra-bus:places` and `patra-bus:loc-granted`. `resetSettings()` in `store.js:220` keeps `city`, the flags and
the usage keys (`KEEP_ON_RESET`, line 35), but no screen calls it today.

## 6. Live polling
- `fetchLive(code)` (`api.js:166`) remembers the last attempt per `city/stop` for 15 s (`MIN_GAP_MS`, success or failure) and
  shares one request between callers, so no screen can ask the Worker more often than that.
- `createLivePoller` (`api.js:189`) asks every 20 s (`POLL_MS`) and only while the page is visible (`visible()` line 201,
  `onVisibility` line 240); it stops on `visibilitychange` and resumes with a fetch if the last attempt is older than 15 s.
- Data older than 60 s is "stale" (`STALE_MS`). `fetchStats` asks the Worker for typical delays, remembered 10 min per route and stop.
- `API_BASE` (`api.js:22-24`) is `http://localhost:8787` on `localhost`/`127.0.0.1`, otherwise the deployed Worker.
- `?debug` puts `window.__app` (`map`, `sheet`, `ctx`, `data`) on the page (`app.js:818`).

## 7. Location
The position stays on the device (CLAUDE.md rule 6). `location.js` does not use the network. Two requests leave the phone:
- **OSRM** (`walk.js:70`): start and end of a walk with 5 decimals (about 1 m), at most one request per second (`gapMs`, line 34),
  timeout 6 s, a minute of straight-line estimates after three failures or a 429. Without an answer `walkEstimate`
  (line 17) gives a straight-line time times 1.3. Callers: `nearby.js:118`.
- **Photon** (`geocode.js:218-219`): a bias `lat`/`lon` rounded to 2 decimals (about 1 km), plus the typed text and the city box.
  The search starts 350 ms after typing and needs 3 characters (`app.js:436-453`). Without GPS the map centre is used.

## 8. Names and accents
Upstream names are uppercase without accents. `titleCase()` (`text.js:33`) makes Title Case for display, with a final ς.
Accents come only from `accents.js` (402 entries, each word with a single correct accent in a place name). Ambiguous or unknown
words stay unaccented; nothing is guessed. `searchKey()` (`text.js:42`) ignores accents, case and ς/σ, so search works either way.
The dictionary does not look at the city, so a Corfu word that is in it is accented too (for example ΑΓΙΑ).

## 9. Service worker (`sw.js`)
- It pre-caches `SHELL` (must all exist) and `OPTIONAL` files (a 404 is fine) and serves same-origin GETs network-first with a
  4 s wait, then the cached copy (`sw.js:137-163`).
- It never touches `/api/` or other origins (`sw.js:220`). The one exception is `tiles.openfreemap.org` (styles, TileJSON, tiles,
  fonts, sprites) in the cache `patra-bus-map-v1`, at most 4000 entries, oldest tiles trimmed first (`sw.js:5-6,165-209`).
  OSRM and Photon are never cached.
- `CACHE` (`sw.js:4`) is rewritten at deploy by `scripts/stamp-cache.mjs`; nobody bumps it by hand. The committed value stays.
- There is no offline map download any more; only the runtime map cache above exists. The `notificationclick` handler
  (`sw.js:225`) serves the notifications `notify.js` can show.
- `app.js:836-839` registers it after load. A page offline shows a pill (`app.js:296-309`).

## 10. First run, welcome, problem report
- **Setup** (`setup.js`, `css/setup.css`): three steps on the first start that lands on the home view (language, city, what LIVE
  and ΠΡΟΓΡ. mean). `app.js:827` opens it before the first `route()`. `setupDone` is set when it opens, so a reload does not
  bring it back. The language applies at once, the city on close (a new city reloads). «Παράλειψη» or Esc closes it.
  `?setup` previews without the flag.
- **Welcome** (`welcome.js`, `css/welcome.css`): a one-time thank-you for the first testers, only when the app runs installed
  (`platform.js` `mode === 'app'`), after the setup closes (`app.js:832`). `welcomeSeen` is set when it opens, not when it
  closes. It links to `#/report`. `?welcome` previews it without the flag. Motion: a spring for the card, keyframes for the
  decorations; with reduced motion a fade of at most 180 ms.
- **Problem report** (`report-view.js`, `report.js`): category, text (10 to 2000 characters), optional email, a hidden honeypot field and
  the diagnostics shown before sending. Sent as `POST /api/report` with only the typed text plus `diag`. `diag` is a whitelist
  (`report.js:106-121`): app version, city, language, screen name and public stop/line code, os, browser, install mode, viewport
  size, online, theme, service worker on, demo. Never the URL query, coordinates, user agent or IP. The Worker checks it again
  (WORKER.md). In `?demo` nothing is sent.
- **Usage counts** (`usage.js`): `POST /api/count` with `{metric, city}` for `open` (once per Athens day) and `install` (once).
  Not sent with `usageStats` off, Global Privacy Control, `?demo`, or off `https://costgal.github.io`. The rule is CLAUDE.md rule 4.

## 11. Credits
CLAUDE.md rule 5 says these stay visible.
- **Settings → Σχετικά → Πηγές και άδειες** (`settings-view.js:11-19,245-248`): © OpenStreetMap contributors, OpenFreeMap,
  MapLibre GL JS, OSRM / FOSSGIS routing, Photon by komoot, and the active city's citybus.gr site.
- **Map**: MapLibre's attribution control, compact, bottom right (`map.js:91`). It sits behind an (i) button and is kept closed
  until tapped (`map.js:92-104`); its text comes from the map style (OpenFreeMap and OpenStreetMap).
