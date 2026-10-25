# Telematica architecture

*Plain-language page first (read this one). The detailed module contracts for people who code are further down, under "Technical reference".*
*Words in **bold** with a ⓖ are explained in [GLOSSARY.md](GLOSSARY.md).*

## The big picture
Telematica is a web app that works like a phone app (a **PWA** ⓖ). Its files sit on **GitHub Pages** ⓖ and run entirely on your phone.
The phone never talks to the bus company directly. It asks our own small program, the **Cloudflare Worker** ⓖ, which holds the secret
**API token** ⓖ for citybus.gr, asks citybus.gr "which buses are coming to stop 1011?", tidies the answer and remembers it for 15 seconds
so many phones asking the same question cost only one call. The tidy-up step marks each bus as **live** (it has GPS coordinates) or
**scheduled** (coordinates are `0/0`, so it is only the timetable). The phone repeats the question every 20 seconds while the app is visible.
The list of stops, lines and routes is not fetched live: it is saved as files in the repo (`web/data/`). The Worker also keeps a few things
for features that must work when the app is closed (push reminders, routines, delay statistics) in **Durable Objects** ⓖ and **KV** ⓖ.

## Data flow
```
 citybus.gr (upstream)  <--token, bus questions--  Cloudflare Worker "patra-bus"  <--/api/{city}/live/1011--  Phone (PWA)
   (patra / corfu)                                  - token kept in KV                 ^  asks every 20 s,        - favourites, settings,
                                                    - 15 s cache per stop              |  only while visible        places, routines
                                                    - live vs scheduled                |                           - your location (never sent to us)
                                                    - Durable Objects: reminders,      |  files from GitHub Pages
                                                      routines, delay stats            +-- (web/ folder, offline copy via service worker)
                                                          |
                                                          +--> push message --> phone vendor's push service --> notification

 Phone also talks DIRECTLY to: OpenFreeMap (map tiles) | OSRM/FOSSGIS (walking route) | Photon (place search)
 Worker also talks to: Notion (only when a user sends "Report a problem")
```

## Where data lives
| Where | What | Notes |
|---|---|---|
| **On the phone only** | Favourites, recents, settings, saved places (home/work), routines, language, one big blob in `localStorage` ⓖ (`patra-bus:v2`, places in `patra-bus:places`) | Cleared by "Delete all" in Settings. |
| **On the phone, never stored** | Your live GPS location | Only a flag "permission granted" is saved. Never sent to our Worker, never put in a link. |
| **Cloudflare KV** ⓖ | Citybus token per city (`token/{city}`), daily report counter (`report-day/{date}`), short fallback cache (`memo/…`, 60 s) | Token expires every 48 h. It is fetched only when a request needs it: the first request for that city, any request in the last 5 min before expiry, or a retry after a 401/403. No timer refreshes it. The KV entry expires with the token, so a city with no requests since then has no token (`/health` shows `null`). |
| **Cloudflare Durable Objects** ⓖ | **Push reminders** (one-off: push subscription ⓖ, time, bus line/stop codes), **routines** (weekly: same, kept up to 120 days), **delay statistics** (last 200 samples per route + stop) | A reminder is deleted after it is sent. No place names or coordinates are stored. |
| **Cloudflare Durable Object `Counters`** ⓖ | Anonymous daily totals: one number per (Athens day, metric, city), e.g. "3 feedback reports from Patras on 2026-10-25". Metrics and cities come from a fixed whitelist (`worker/src/counters.js`). `feedback` is counted by the Worker after a forwarded report; `open` and `install` arrive from the app through `POST /api/count` `{metric, city}` (only those two metrics; Origin + JSON checks, 20 / 10′ per IP in memory, 204 with no body; previews and localhost answer 204 without counting; TEL-196). `push` is reserved for a later card. | No IP, device id, user id or free text, and nothing finer than the day: a request can only add 1 to a row. Counting is best effort and never blocks the request it rides on. Read only through the private page `GET /stats` (served by the Worker, not by Pages) → `GET /api/admin/counts` with `Authorization: Bearer <STATS_TOKEN>` (Cloudflare secret; 401 wrong token, 429 after 3 wrong tries / 10′ per IP in memory, 503 without the secret). No CORS header, `no-store`, the token never in a URL (`worker/src/admin.js`, TEL-195). |
| **GitHub repo** | Stops, lines, routes (`web/data/`), all code | Public. Secrets are never committed. |
| **Notion** | Problem reports a user chose to send | Via the Worker. |

Third-party services (free, no key, credit shown in Settings and on the map):
- **OpenFreeMap**: map pictures. The phone fetches them directly.
- **OSRM / FOSSGIS**: walking time and route. Receives the start and end point of a walk from the phone (about 1 m precision).
- **Photon (komoot)**: searching for places by name. Receives your typed text and a rounded location (about 1 km).
- **citybus.gr**: the real bus data. Only the Worker (and the maintenance scripts) talk to it.

## Where to find things
| Feature | Main files |
|---|---|
| Live arrivals on a stop | `web/js/arrivals.js` (live vs scheduled, shared with Worker), `api.js`, `arrivals-view.js` |
| Token, proxy, 15 s cache | `worker/src/index.js`, `worker/src/routes.js` |
| Stops, lines, routes data | `scripts/fetch-static.mjs`, `scripts/build-routes.mjs`, `web/data/`, `web/js/data.js` |
| Map | `web/js/map.js` |
| "Next bus near me" | `web/js/nearby.js`, `location.js`, `walk.js` |
| Trip planner and place search | `web/js/planner.js`, `planner-view.js`, `geocode.js` |
| Push reminders | `web/js/push.js`, `notify.js`, `web/sw-push.js`, `worker/src/reminders.js`, `worker/src/push.js` |
| Weekly routines | `web/js/routines.js`, `worker/src/routines.js` |
| Delay statistics | `worker/src/stats.js` |
| Offline app and offline map | `web/sw.js`, `web/js/offline.js` |
| Problem report | `web/js/report-view.js`, `worker/src/report.js` |
| Storage on the phone, settings | `web/js/store.js`, `settings-view.js` |
| Cities (Patras, Corfu) | `web/js/cities.js`, `docs/MULTI-CITY.md` |
| Greek / English text | `web/js/i18n.js`, `i18n-en*.js` |
| Deploys and checks | `.github/workflows/` (Pages, tests, Lighthouse, same-bus watch), `worker/wrangler.toml` (Worker settings) |
| Same-bus watcher (is rule B needed?) | `scripts/watch-same-bus.mjs`, `.github/workflows/watch-same-bus.yml`, `tests/watch-same-bus.test.mjs` |

## Same-bus watcher (TEL-145)
When the same bus shows up twice for a stop (once live, once scheduled), `dropScheduledDuplicates` in `web/js/arrivals.js` hides the scheduled one with two rules: **A** = same `vehicleCode`, **B** = same line and arrival time within 60 s. Rule B can hide a second real bus of the same line, so we want to know if rule A is enough on its own. We had never seen a real pair, so a **scheduled workflow** ⓖ now looks for us.

- **What runs:** `.github/workflows/watch-same-bus.yml`, every 30 min in daytime (cron `7,37 5-17 * * *`, UTC), only from `main`. It scrapes the token like `npm run record-fixtures` (never written down), then makes **one** `/stops/live/{code}` request each for Patras 280 and 1011 and Corfu 801, nothing else. No rider data is involved. Pause it from the Actions tab ("Disable workflow") or by deleting the workflow file.
- **Where it reports:** one standing issue, **"Same-bus watch (TEL-145)"** (created by the first finding, assigned to the repo owner so a comment sends an email). Each run also writes a short summary in the Actions tab. If the run itself fails (token not found, upstream error) the job turns red and GitHub emails a failure notice; empty answers and the nightly 404 are not failures.
- **The two comment kinds:**
  - **"Rule A confirmed"**: a live and a scheduled row share one `vehicleCode`. Evidence that A works; posted for the first 5 only.
  - **"Rule B fired without rule A"**: same line, ETA within 60 s, **different** codes. Always posted (once per pair).
- **What to do when it fires** (codes look like `20261009_6091_0000100_22_10` = date, route, …, departure time; this format is an unconfirmed observation):
  1. *Mismatch with a different route or time part in the codes*: two real buses, and rule B is hiding one. Open a card to remove rule B from `arrivals.js` (shared with the Worker, so only Kostas can deploy it).
  2. *Mismatch where the codes are the same trip written differently*: rule A is not enough. Keep rule B and note it on the card.
  3. *Mismatch where the live code is not a trip code* (a bare number, e.g. `1599524552076686932` on 2026-10-20, issue #96): upstream did not link the bus to its trip and sent the trip as a separate scheduled row. Rule A can never match it, so keep rule B; the watcher's comment says so. Only act if the ETAs or route point to two different buses.
  4. *About 5 "Rule A confirmed" comments and no mismatch for roughly two weeks*: open a card to remove rule B, with the comments as the evidence.
  When the question is settled, disable the workflow and close the issue.
- **Limits:** a pair only shows if one of the three stops has one at the moment of the request, so it may take days. The watcher repeats the pairing rules of `arrivals.js` instead of importing them (the Worker must stay untouched); a unit test checks that both agree.

## Fragile points
- **Token scraping.** The Worker finds the token by looking for the text `const token = '…'` in the citybus.gr web page. If they change that page, every live request fails ("token not found") until we fix the code.
- **Unofficial API.** We use only three citybus endpoints and must never poll faster than every 15 s per stop. They can change or block us without notice.
- **Stop order is guessed.** The order of stops on a route is inferred, not official; about 10 of 80 routes have low confidence.
- **Stale static data.** Stops/lines/routes are committed files. If the city changes a stop, the app shows old data until someone runs `npm run fetch-static` and merges.
- **One shared Worker.** Previews and production use the same Worker, and only Kostas deploys it by hand. A bad deploy hits everyone; a forgotten deploy leaves the Worker behind the web files.
- **Rate limits are per server instance** (in memory), not global: a brake, not a wall.
- **Free-tier limits: UNVERIFIED.** I did not check current Cloudflare free-plan limits (Worker requests per day, KV writes, Durable Object usage). Check the Cloudflare dashboard before growing the user base.
- **Public servers.** OSRM, Photon and OpenFreeMap are free community services with fair-use rules; they can slow down or block heavy use. UNVERIFIED whether our usage is inside their limits at larger scale.
- **VAPID key change.** Changing the push key needs the public key (in `wrangler.toml`) and the private key (a Cloudflare secret) to change together. UNVERIFIED what happens to already-subscribed phones.
- **Cache inside Durable Objects** is believed unreliable, so a short KV copy is used as backup (`cachedBody` in `worker/src/index.js`). UNVERIFIED in production.
- **Docs drift.** The technical reference below was written in earlier rounds. Where it disagrees with `CLAUDE.md` (for example it says to bump `CACHE` by hand and to load MapLibre from a CDN; today the cache name is stamped automatically and MapLibre is stored in `web/vendor/`), trust `CLAUDE.md` and the code.

---

# Technical reference (for people who code): patra-bus v2 architecture (module contracts)

Vanilla JS ES modules, no build step, no framework. Libraries only from pinned CDN URLs.
Map: **MapLibre GL JS 4.7.1** (global `maplibregl`, loaded by a classic `<script>` in index.html from
`https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js` + `.css`) with **OpenFreeMap** vector styles
(`https://tiles.openfreemap.org/styles/liberty` light, a dark style for dark mode). No API keys anywhere.

Language of the UI: Greek. Times in `Europe/Athens`, 24 h.

## Hard rules (from CLAUDE.md, still binding)
- Live upstream (`/api/live/:code` on our worker) is never fetched more often than every **15 s per stop**,
  retries included. `api.js` enforces this globally (per-code memo + in-flight dedupe). Pollers run every 20 s,
  only while `document.visibilityState === 'visible'`.
- No calls to citybus endpoints other than the ones in CLAUDE.md. No probing / guessing upstream URLs.
- Coordinates `0/0` never shown or used. Only live vehicles carry `lat/lng`, and only inside the active city's
  `bbox` (`api.js` `cleanVehicle`: an outside position is dropped, the vehicle stays live).
- Names: `titleCase()` for display only, final ς, accents never guessed.
- Service worker never caches `/api/` or any other origin (map tiles, routing, geocoding included).
  Bump `CACHE` in `web/sw.js` when shell files change.
- Every `localStorage` access in try/catch. Never put personal data (location) in URLs sent to third parties
  beyond what the integration strictly needs (routing/geocoding coordinates are needed; nothing else).

## Third-party integrations (all free, no key, attribution required in the UI "Σχετικά" + map attribution)
- Tiles: OpenFreeMap (OpenMapTiles schema, © OpenStreetMap contributors).
- Walking routes: FOSSGIS OSRM foot server
  `https://routing.openstreetmap.de/routed-foot/route/v1/driving/{lng},{lat};{lng},{lat}?overview=full&geometries=geojson`
  — max ~1 request/s from a client, results cached, fallback to straight-line estimate.
- Geocoding (place search): Photon `https://photon.komoot.io/api/?q=…&lat=…&lon=…&limit=…&bbox=21.60,38.13,21.90,38.33`
  — debounced ≥ 300 ms, abortable.

## Routing (hash)
| Hash | View (module) |
|---|---|
| `#/` | home: next-bus-near-me card (`nearby.js`) + favorites + recents |
| `#/stop/{code}` | stop sheet with arrival tiles (`arrivals-view.js`) |
| `#/plan` / `#/plan?to=lat,lng&name=…&from=lat,lng` | trip planner (`planner-view.js`) |
| `#/lines` / `#/line/{lineCode}?dir=1` | line browser / one line on the map (`lines-view.js`) |
| `#/settings` | settings + about/attribution (`settings-view.js`) |
| `#/guide` / `#/guide?section=install` | in-app guide + install-as-app tutorial (`guide-view.js`, `install-guide.js`; contract in `docs/GUIDE.md`) |
| `#/report` | report a problem (`report-view.js`; menu item with the `bug` icon, SNAP `full`) |
| `#/notif?routine=…\|ref=…&stop=…` | notification link, never a view: `app.js` resolves it on the device (`notif-link.js`) and replaces the hash (see PC below) |

**Problem reports** (`js/report.js` shared, `js/report-view.js`, `worker/src/report.js`, `POST /api/report`): the view sends `{ category: data|app|idea|other, message (10–2000), email?, hp, diag }`.
`report.js` holds the one validation (`validateReport`, `cleanDiag` whitelist) used by both the form and the Worker. `diag` is a fixed whitelist of coarse facts
(app version, city, language, screen name + public stop/line code, os/browser/install mode, viewport size, online, theme, SW on, demo): never the URL query,
coordinates, user agent or IP, and the view shows it verbatim before sending. `app.js` keeps `reportCtx` (the screen the user came from) and passes it in.
Worker: Origin must be allowed (403) and Content-Type `application/json` (415) → 503 without `NOTION_TOKEN`/`NOTION_DB_ID` → per-IP 3 / 10 min in memory (429)
→ ≤ 8 KB (413) → honeypot field `hp` non-empty = `200 {ok:true}` and nothing forwarded → validation (400 `field`) → global cap 100/UTC day in KV `report-day/{date}` (429)
→ one page in the Notion database (502 `forward_failed` on any Notion error). Nothing is stored in the Worker; the IP lives only in the limiter's memory.
Notion database properties (exact names): `Name` (title), `Category` (select), `Status` (select, "New"), `City` (select), `Email` (email), `Received` (date); the page body is the
message plus a JSON code block with the diagnostics.

**Guide integration** (`app.js`, part C of `docs/GUIDE.md`): `guide` has SNAP `full` and mounts `mountGuide(content, ctx, { section })`
like settings. Just before mounting, `ctx.renderInstall` is set to `() => install-guide.renderInstallSection()` (left `undefined` when
that module fails to load, the guide then has no install section). `install-guide.js` is imported once at the top of `app.js`, in
parallel with boot and never awaited, and `captureInstallPrompt()` runs as soon as it resolves. Entry points: menu item "Οδηγός"
(above Settings), a "Οδηγός χρήσης" row in Settings and, when `installHint()` is non-null, "Εγκατάσταση ως εφαρμογή"
(`#/guide?section=install`). Settings flags `guideSeen` and `installHintDismissed` (booleans in `store.js`, absent = false, kept by
`resetSettings`, wiped by `clearAll`) drive one small `.guide-hint` card under the home card (inside the sheet's peek height): "first time
here?" until `guideSeen`, else the one-time install hint until `installHintDismissed`; never both, and only when the page booted on the home
view (not a deep link). Opening the guide or pressing ✕ sets the flag.

**First-run setup** (TEL-74, `js/setup.js` + `css/setup.css` + `js/i18n-en-setup.js`): a 3-step dialog (language, city, LIVE vs ΠΡΟΓΡ.)
shown once, only when the page boots on the home view. `app.js` imports it in parallel with boot and calls
`maybeSetup({ bootHome, ctx })` just **before** the first `route()`, so it can set `setupDone` + `guideSeen` on show and the home's
"first time here?" card never paints under it. `maybeSetup` returns a promise that resolves on close (or `null`); the testers'
welcome (`welcome.js`) waits for it. A language tap calls `setLang` at once (the setup re-renders on `onLangChange`; "Next" commits
the highlighted one, pre-selected from `navigator.language`); the city is applied on close (done, skip or Esc): a different city =
`settings.city` + reload, like `switchCity`. Skipping stores no `lang`, so the store default (`'el'`) applies. `?setup` previews it
without touching the flags. The sample tiles reuse `exampleTile` / `sampleLines` exported by `guide-view.js`. E2E: `tests/e2e/mock.mjs`
marks the setup done for every spec unless `test.use({ firstRun: true })`; `scripts/shots.mjs` seeds the same flag and shoots the
dialog as screen `setup`.

**City prefix** (docs/MULTI-CITY.md, `js/route.js`): any hash may start with a city id, `#/corfu/stop/123`. Views and links use
city-relative hashes; `cityHash()` adds the prefix for every city but Patras (links, `navigate`, `replaceState`), `shareHash()`
always adds it (share links, reminder/push urls). `js/boot-city.js` (first import of `app.js`) sets the active city: prefix, else an
unprefixed link to a stop/line/coordinates (= Patras, old links keep working), else `settings.city`, else Patras. A prefix of another
city while running, or the picker in the settings, saves `settings.city` and reloads. Stored favourites, recents, places, routines,
reminders and the onboard trip carry a `city`; older items are Patras; lists show only the active city's.
`?demo` in the page query (not the hash) switches the whole app to synthetic data (`demo.js`); a DEMO tag is shown.

## View mounting contract
Every view module exports `mountX(container: HTMLElement, ctx: Ctx, params?) → { destroy(): void }`.
The view renders everything inside `container` (its own header too) and must clean up timers, pollers,
listeners and its map overlays in `destroy()`.

```ts
type Ctx = {
  data: Data;                       // data.js
  map: MapApi;                      // map.js
  location: LocationService;        // location.js singleton
  navigate(hash: string): void;     // e.g. ctx.navigate('#/stop/1011')
  sheet: { snap(to: 'peek'|'half'|'full'): void };
  toast(text: string, opts?: { action?: { label: string, onClick(): void }, ms?: number }): void;
};
```

## Module ownership and APIs

### A — shell & map: `index.html`, `app.css`, `css/tokens.css`, `js/app.js`, `js/map.js`, `js/sheet.js`, `js/ui.js`
- `ui.js`: `h(tag, props, ...kids)` (props: `class`, `on*` listeners, attributes; `style` object allowed), `icon(name) → SVGElement`
  (names: search, back, close, locate, locate-fixed, compass, star, star-on, share, walk, bus, clock, live, route, layers, menu, swap, bell, settings, info, chevron),
  `toast(text, opts)`, `lineBadge(line|{code,color,textColor}) → HTMLElement`, `fmtClock(epochMs) → "HH:MM"`.
- `map.js`: `createMap(container, { onStopClick(code), onMapClick({lat,lng}), onLongPress({lat,lng}) }) → MapApi`
```ts
type MapApi = {
  ready: Promise<void>;
  setStops(stops: Stop[]): void;                 // all stops as a clustered/zoom-aware layer
  highlightStop(code: string | null): void;
  setUserFix(fix: Fix | null): void;              // blue dot + accuracy circle + heading cone
  setVehicles(id: string, v: {lat,lng,lineCode,color,textColor,label?}[]): void;  // live buses
  clearVehicles(id: string): void;
  setOverlay(id: string, fc: GeoJSON.FeatureCollection, style: { kind: 'route'|'walk'|'ride', color?: string }): void;
  clearOverlay(id: string): void;
  setMarkers(id: string, m: {lat,lng,kind:'origin'|'dest'|'board'|'alight'|'pin',label?}[]): void;
  clearMarkers(id: string): void;
  flyTo(p: {lat,lng}, zoom?: number): void;
  fitTo(points: {lat,lng}[], opts?: { maxZoom?: number }): void;   // respects sheet padding
  setPadding(p: { top?, bottom?, left?, right? }): void;
  setTheme(t: 'light'|'dark'): void;
  getCenter(): {lat,lng};
};
```
- Layout: full-screen map; floating search bar on top ("Πού πάμε;"), chips row (Κοντά μου, Αγαπημένα, Γραμμές);
  FABs (locate/follow/compass, layers/theme); draggable bottom sheet with snap points peek/half/full on phones;
  left side panel ≥ 900 px wide. App wires `location` → `map.setUserFix`.

### B — live data & arrival tiles: `js/arrivals.js`, `js/api.js`, `js/demo.js`, `js/arrivals-view.js`, `css/arrivals.css`, `worker/src/index.js`, `web/fixtures/*`, `tests/arrivals.test.mjs`, `tests/api.test.mjs`
- `arrivals.js` `normalizeLive(raw, fetchedAt)` adds `vehicleCode: string|null` (string for any vehicle that has one).
- `api.js`:
```ts
export const API_BASE: string; export const DEMO: boolean;
type Vehicle = { lineCode, lineName, routeCode, routeName, color, textColor, live: boolean,
                 departureMins: number, etaSec: number, vehicleCode: string|null, lat?: number, lng?: number };
type LiveResult = { fetchedAt: number, vehicles: Vehicle[], noService?: boolean };
fetchLive(code: string, opts?: { signal?: AbortSignal }): Promise<LiveResult>;  // 15 s per-code memo, in-flight dedupe; throws ApiError
class ApiError extends Error { kind: 'network'|'timeout'|'upstream'|'bad' }
remainingSec(v: Vehicle, fetchedAt: number, now = Date.now()): number;         // max(0, etaSec - (now - fetchedAt)/1000), same for live & scheduled
createLivePoller(code, onUpdate: (s: { data: LiveResult|null, error: ApiError|null, loading: boolean, nextAt: number }) => void)
  → { refresh(): void, destroy(): void };   // 20 s, visible-only, respects the 15 s floor
```
- `demo.js`: `demoLive(code) → LiveResult` synthesised from `routes.json` order + leg times, consistent across stops
  (same `vehicleCode` passes stops in route order), mix of live (with positions along the route) and scheduled.
- `arrivals-view.js`: `mountStop(container, ctx, { code }) → {destroy}` (header with name, code, favorite, share,
  "Οδηγίες ως εδώ" → `#/plan?to=…`; arrival tiles with per-second countdown, LIVE vs ΠΡΟΓΡ. unmistakable;
  shows the stop's live buses on the map via `ctx.map.setVehicles('stop', …)`);
  `arrivalTile(v: Vehicle, fetchedAt, opts?: { compact?: boolean, now?: number, line?: Line }) → HTMLElement`;
  `etaText(sec) → string` (e.g. "τώρα", "<1′", "7′", "1 ώ 05′").
- Worker: upstream **404** on live → `200 { fetchedAt, vehicles: [], noService: true }`, cached 15 s like any live result.

### C — location & nearby: `js/location.js`, `js/geo.js`, `js/walk.js`, `js/nearby.js`, `css/nearby.css`, `tests/geo.test.mjs`
- `location.js` default export `location: LocationService`:
```ts
type Fix = { lat, lng, accuracy /*m*/, heading: number|null, speed: number|null, ts: number, source: 'gps'|'manual' };
type LocStatus = 'idle'|'locating'|'ok'|'denied'|'unavailable'|'timeout'|'insecure';
LocationService = { start(): void; stop(): void; current: Fix|null; status: LocStatus;
  subscribe(fn: (fix: Fix|null, status: LocStatus) => void): () => void;
  setManual(p: {lat,lng} | null): void; enableCompass(): Promise<boolean>; }
```
  Quality: fast coarse fix then high accuracy watch, reject jumps (implied speed > 60 m/s) and fixes much worse than the
  current one unless the current is stale (> 30 s), light smoothing, pause when hidden, resume when visible,
  compass heading via DeviceOrientation (iOS permission on user gesture).
- `geo.js`: `haversine(a, b)`, `bearing(a, b)`, `fmtDist(m)`, `nearestStops(stops, p, { limit, maxMeters }) → {stop, meters}[]`
  (grid index, fast for 839 stops), `PATRAS_BBOX`, `inArea(p)`.
- `walk.js`: `walkRoute(from, to, { signal }) → Promise<{ seconds, meters, geometry: [lng,lat][] | null, source: 'osrm'|'estimate' }>`;
  `walkEstimate(from, to)` (straight line × 1.3 at 1.3 m/s, adjusted by `store.getSettings().walkSpeed`).
- `nearby.js`: `findNextBuses(ctx, fix) → Promise<NearbyStop[]>` and `mountNearby(container, ctx) → {destroy}`:
  the home card "Επόμενο λεωφορείο κοντά σου": nearest stops (both sides of the road), next departures with
  walk time, "πρόλαβέ το: φύγε σε X′" / "δεν προλαβαίνεις", live vs scheduled, auto refresh.

### D — data & routes: `scripts/fetch-static.mjs`, `scripts/build-routes.mjs`, `web/data/routes.json`, `web/data/shapes.json`, `web/js/data.js`, `package.json`, `tests/routes.test.mjs`, `tests/data.test.mjs`
- `routes.json`: `{ version: 1, generatedAt, routes: { [routeCode]: { code, lineCode, name, direction, stops: string[] /*ordered stop codes*/, legSec: number[] /*bus seconds between consecutive stops, length stops-1*/, confidence: number /*0..1*/, method: string } } }`
- `shapes.json` (lazy): `{ [routeCode]: [lng, lat][] }` road geometry, simplified.
- Other cities keep the same files under `web/data/{city}/` (Patras stays at `web/data/`); `fetch-static.mjs` and
  `build-routes.mjs` take `--city=`. `build-routes.mjs` has a per-city `CENTER_WORDS` table (the route-name tokens that mean
  the town hub: Patras `κεντρο`, Corfu `σαροκο`/`μεθοδιου`/`πολη`); see `docs/MULTI-CITY.md` for the Corfu data review.
- `data.js`: `loadData() → Promise<Data>`, `loadShapes() → Promise<Record<string, [number,number][]>>`, `searchStops(data, q, limit)`.
```ts
type Stop = { code, name, displayName, lat, lng, lineCodes: string[], routeCodes: string[], key: string };
type Line = { code, name, displayName, color, textColor, routes: { code, name, direction }[] };
type Route = { code, lineCode, name, displayName, direction, stops: string[], legSec: number[], confidence, pos: Map<string, number> };
type Data = { stops: Stop[], lines: Line[], routes: Route[], stopByCode: Map, lineByCode: Map, routeByCode: Map,
              routesByStop: Map<string, Route[]> };
```

### E — trip planner: `js/planner.js`, `js/planner-view.js`, `js/geocode.js`, `css/planner.css`, `tests/planner.test.mjs`
- `geocode.js`: `searchPlaces(q, { near, signal }) → Promise<Place[]>`, `Place = { kind: 'stop'|'place', name, subtitle, lat, lng, stopCode? }`.
- `planner.js`: `planTrips(ctx, from: {lat,lng}, to: {lat,lng}, { now }) → Promise<Itinerary[]>` (single bus, plus walk-only when sensible).
  `Itinerary = { kind: 'bus'|'walk', line, route, board: Stop, alight: Stop, walkTo: {seconds, meters, geometry}, walkFrom: {...},
   bus: { remainingSec, live, vehicleCode, scheduledAt?: number }, rideSec, rideSource: 'live-match'|'estimate',
   leaveInSec /* when to start walking: bus remaining − walkTo − buffer */, arriveAt: number, next?: {...} }`.
  If a live vehicle with the same `vehicleCode` appears at both board and alight stops, ride time = difference (exact).
- `planner-view.js`: `mountPlanner(container, ctx, { to?, from?, name? }) → {destroy}`: destination search, itinerary cards
  with a big "Φύγε σε 12′" (or "Φύγε τώρα" / "Δεν προλαβαίνεις αυτό, επόμενο σε…"), step timeline, map overlays
  (walk dashed, ride in line colour, board/alight markers), reminder button (`notify.js`), live refresh.

### F — PWA, storage & extras: `js/store.js`, `js/notify.js`, `js/lines-view.js`, `js/share.js`, `js/settings-view.js`, `css/extras.css`, `web/sw.js`, `web/manifest.webmanifest`, `web/icons/*`
- `store.js`: `getFavorites(): string[]`, `isFavorite(code)`, `toggleFavorite(code): boolean`, `getRecents(kind: 'stop'|'place'): any[]`,
  `addRecent(kind, item)`, `getSettings(): { theme: 'auto'|'light'|'dark', walkSpeed: 'slow'|'normal'|'fast', bufferMin: number, reminderMin: number }`,
  `setSetting(key, value)`, `onChange(fn) → unsubscribe`. Migrates the old `favs` key.
- `notify.js`: `scheduleReminder({ at, title, body, tag }) → { cancel() }`, `listReminders()`, `ensurePermission() → Promise<boolean>`
  (in-app toast + vibration always; system notification when permitted; only while the app is open).
- `share.js`: `shareLink({ title, text, url }) → Promise<'shared'|'copied'|'failed'>`.
- `lines-view.js`: `mountLines(container, ctx)`, `mountLine(container, ctx, { code, dir })` (ordered stops, direction switch,
  route on the map from `shapes.json`, tap stop → `#/stop/…`).
- `settings-view.js`: `mountSettings(container, ctx)` (theme, walk speed, buffer minutes, reminders, about + attributions, data freshness).
- `sw.js`: shell list includes every file in this document; still never caches `/api/` or other origins.

## Process rules for agents
- Edit only the files you own. Read anything. If you need a change in someone else's file, write it in your final report.
- Never run git commands that change state (commit, checkout, stash, reset, push). Never deploy.
- Dev servers already run: web `http://localhost:8080/` (no HTTP cache), worker `http://localhost:8787/`. Don't start others on those ports.
- Browser checks: open your **own** tab (`tabs_create`) and only drive that tab. Use `?demo` for data at night.

## Round 2 (transfers, push, offline map, accents, polish)

### T — transfers: `js/planner.js`, `js/planner-view.js`, `css/planner.css`, `tests/planner.test.mjs`
`Itinerary.kind` gains `'transfer'` with `legs: [{ route, line, board, alight, bus, rideSec, rideSource }, …]` (2 bus legs) and `transfer: { stop|walk, waitSec }`.
The reminder button passes `trip` to `scheduleReminder` (below) for the FIRST bus leg.

### PW — push server: `worker/src/index.js`, `worker/src/push.js`, `worker/src/reminders.js`, `worker/wrangler.toml`, `tests/push-worker.test.mjs`, `.dev.vars` (gitignored, local keys only)
- `GET /api/push/key` → `{ publicKey }` (VAPID, base64url, uncompressed P-256 point).
- `POST /api/push/reminders` JSON `{ subscription: PushSubscriptionJSON, at: epochMs, title, body, tag, url, trip?: { stopCode, routeCode, lineCode, vehicleCode|null, offsetSec } }` → `201 { id }`.
  `at` must be within the next 3 h; bodies ≤ 4 KB; text fields length-capped. A `url` with coordinates or a place name
  (`to=`, `from=`, `name=`, `lat=`, `lng=`, from clients older than TEL-13) is accepted but dropped (`cleanUrl`): it is never stored.
- `DELETE /api/push/reminders/{id}` → `204`.
- At `at` (Durable Object alarm, one object per reminder): if `trip` is set, re-read live for `stopCode` through the same 15 s cache,
  find the bus (`vehicleCode`, else first of `routeCode`), recompute leave time = bus eta − `offsetSec`; if it moved later by > 60 s re-arm (max 3 times),
  else send the push (title/body updated with the fresh minutes). Then delete everything stored. Expired/410 subscriptions are dropped.
- Web Push per RFC 8291 (aes128gcm) + VAPID (RFC 8292, ES256 via WebCrypto). Secrets: `VAPID_PRIVATE_KEY` (secret), `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT` = `https://github.com/CostGal/patra-bus`.
- CORS: same allowlist; methods GET, POST, DELETE, OPTIONS; header Content-Type.

### PC — push client: `js/push.js`, `js/notify.js`, `web/sw-push.js`, `tests/push-client.test.mjs`
- `push.js`: `isPushSupported()`, `pushState() → 'unsupported'|'needs-install'|'denied'|'off'|'on'`, `enablePush()` (user gesture), `disablePush()`,
  `schedulePushReminder(payload) → id|null`, `cancelPushReminder(id)`, `mountPushCard(container, ctx) → {destroy}` (settings card; explains iPhone needs the installed app).
- `notify.js`: `scheduleReminder({ at, title, body, tag, trip? })` keeps working locally and, when push is on, also books a server reminder (same `tag`), cancels it on cancel.
- `sw-push.js` (imported by `sw.js` via `importScripts`): `push` → `showNotification(title, { body, tag, data: { url } })`. `notificationclick` stays in `sw.js`.
- Notification links (`notif-link.js`, shared with the worker): the `url` sent to the server never carries a place. Routines send
  `#/{city}/notif?routine=<ref>&stop=<code>` (`ref` random, kept in the local routine); one-off reminders whose link is a plan
  (`isPrivateUrl`) send `#/{city}/notif?ref=<ref>&stop=<code>` and keep `ref → hash` in localStorage `patra-bus:push-links` (≤ 20, at + 24 h).
  On the tap, `app.js` resolves it on the device: routine → `#/plan?to=` its saved place as it is now; reminder → the kept hash;
  otherwise the stop (`stop`, which the server already has in `trip`), else home.

### OM — offline map: `web/sw.js`, `web/vendor/**`, `web/index.html`, `js/offline.js`, `tests/offline.test.mjs`
- MapLibre GL 4.7.1 self-hosted under `web/vendor/maplibre-gl/` (precached).
- `sw.js` may now cache **OpenFreeMap only** (style, tilejson, tiles, glyphs, sprites) in a separate bounded cache; still never `/api/`, OSRM, Photon or any other origin.
- `offline.js`: `offlineMapStatus()`, `downloadPatrasMap({ onProgress, signal })`, `clearOfflineMap()`, `mountOfflineCard(container, ctx) → {destroy}` (opt-in download with size estimate, progress, cancel, delete).

### AC — accented names: `js/text.js`, `js/accents.js`, `tests/text.test.mjs`
`titleCase()` applies a curated word dictionary (`ACCENTS`) of unambiguous Greek words; unknown or ambiguous words stay unaccented. `searchKey()` unchanged.

### LC — readable line colours: `js/color.js`, `tests/color.test.mjs` (TEL-19)
`readableLine(color, textColor) → { color, textColor }` (pure) makes upstream badge pairs reach WCAG 4.5:1: a ≤ 6% darkening first, then dark text (`#1f1f1f`) on bright lines, a darker background only as a last resort. Applied once at the sources, `data.js` `buildIndex` (static lines) and `api.js` `cleanVehicle` (live), so badges, chips, map markers and the line/bus views all get the readable pair. `arrivals.js` (shared with the worker) keeps the raw upstream colours. Full audit: `docs/ui-audit.md`.

### PO — polish + integration: `js/app.js`, `js/nearby.js`, `js/location.js`, `js/map.js`, `js/settings-view.js`, `app.css`, `css/extras.css`, `tests/location.test.mjs`, `tests/nearby.test.mjs`
Settings mounts `mountPushCard` and `mountOfflineCard`; offline indicator; 4th nearby stop; compass in landscape; map pins clear of the floating buttons.

## Round 3 (minimal UI, places/routines, onboard alert, reliability stats, English)

### UI principles (binding for every module)
- Home = map + search bar + ONE contextual card in the peek sheet. Priority: active onboard trip (`mountOnboardCard`) > saved place card (`mountPlacesCard`) > nearby next bus (`mountNearby`) > a single CTA. Favourites/recents only when the sheet is expanded or search is focused.
- Show things only when relevant: no permanent legends or explanations (one-time hints at most; full legend in Settings → Σχετικά), empty sections hidden, secondary actions behind a "⋯" menu or in the detail view. One primary action per card.
- Text budget per card: one headline line + one meta line; details on tap.
- Floating controls: search bar, locate button; everything else in the menu. Chips only when useful (e.g. saved places), max 3.
- Every new user-visible string goes through `t()` from `js/i18n.js` with the GREEK text as the key: `t('Φύγε σε {n}′', { n })`.

### U — minimal shell: `index.html`, `app.css`, `css/tokens.css`, `js/app.js`, `js/sheet.js`, `js/ui.js`, `js/map.js`, `web/sw.js`
Applies the principles above; home composition; links `css/places.css`; SW shell list gets every new file; bumps CACHE.

### P — places + routines (client): `js/places.js`, `js/routines.js`, `css/places.css`, `tests/places.test.mjs`
- `getPlaces() → [{ id: 'home'|'work'|string, name, lat, lng }]`, `setPlace(p)`, `removePlace(id)` (own localStorage key `patra-bus:places`, try/catch).
- `mountPlacesCard(container, ctx) → {destroy}`: compact "Για το σπίτι · 601 · Φύγε σε 6′" using `planTrips` (best itinerary), refreshed ≤ every 60 s while visible; renders nothing if no places or no location.
- `mountPlacesSettings`, `mountRoutinesSettings(container, ctx) → {destroy}` (settings sections).
- Routines: `{ id, days: number[] /*0=Κυρ*/, time: 'HH:MM' /*Europe/Athens, planned leave time*/, placeId, ref, trip: { stopCode, routeCode, lineCode, offsetSec }, leadMin }` booked on the server (below) when push is on.
  The server gets the push address, days/time, the boarding `trip` (incl. `offsetSec`, the walk to the stop) and the opaque link `#/{city}/notif?routine=<ref>`: never the place, its coordinates or its name.

### W — worker: routines + stats: `worker/src/index.js`, `worker/src/reminders.js`, `worker/src/routines.js`, `worker/src/stats.js`, `worker/wrangler.toml`, `tests/routines-worker.test.mjs`, `tests/stats.test.mjs`
- `POST /api/push/routines` `{ subscription, days, time, tz: 'Europe/Athens', title, url, trip, leadMin }` → `201 { id }` (`url` as for reminders: a place link is dropped); `DELETE /api/push/routines/{id}`. One Durable Object per routine: on each matching day at time − 20′ read live (same 15 s cache path) for `trip.stopCode`, pick the first bus of `routeCode` with leave = eta − offsetSec ≥ now, alarm at leave − leadMin, send "Φύγε σε N′ για το 601", re-arm for the next matching day. Drop on 404/410; expire after 120 days.
- Reminders gain `kind: 'leave'|'alight'` (default 'leave'); 'alight' text: "Ετοιμάσου: η στάση «{name}» σε ~1′" (`trip.stopName` optional field).
- Stats: only from upstream live responses the worker already fetches (never extra calls). When a `vehicleCode` seen as scheduled at stop S (scheduled time T) later appears live at S with eta ≤ 5′, record delay = liveArrival − T once per (vehicle, stop) into a Stats Durable Object (rolling last 200 per routeCode+stopCode). `GET /api/stats/{routeCode}/{stopCode}` → `{ samples, medianDelaySec, p80DelaySec, updatedAt }` (cache 10 min).

### B — onboard alert: `js/onboard.js`, `js/bus-view.js`, `js/planner-view.js`, `css/planner.css`, `tests/onboard.test.mjs`
`startOnboard({ vehicleCode, routeCode, lineCode, alightStop })` (user gesture): foreground = GPS + Screen Wake Lock + countdown, vibrate/notify ~1 stop before; background = push reminder via `notify.scheduleReminder({ …, trip: { stopCode: alightStop, vehicleCode, routeCode, lineCode, offsetSec: 90, stopName }, kind: 'alight' })`. `activeTrip()`, `onTripChange(fn)`, `stopOnboard()`, `mountOnboardCard(container, ctx)`. Entry: bus view ("Θα κατέβω στη…") and planner itinerary ("Είμαι στο λεωφορείο").

### R — reliability in the UI: `js/api.js`, `js/arrivals-view.js`, `css/arrivals.css`, `js/nearby.js`, `css/nearby.css`, `js/planner.js`, `tests/api.test.mjs`, `tests/planner.test.mjs`, `tests/nearby.test.mjs`
`fetchStats(routeCode, stopCode)` (memo 10 min, null on failure). Scheduled tiles show a quiet "συνήθως +3′" when samples ≥ 10; the planner shifts scheduled buses by the median delay (labelled). Also make tiles + nearby card follow the UI principles.

### L — English + settings: `js/i18n.js`, `js/i18n-en.js`, `js/store.js`, `js/settings-view.js`, `js/lines-view.js`, `css/extras.css`, `tests/i18n.test.mjs`, `tests/store.test.mjs`
`t()`, `lang()`, `setLang('el'|'en')`, `onLangChange`; language auto from `navigator.language`, override in Settings; `<html lang>` updated. Stop/line names stay Greek. Settings mounts `mountPlacesSettings`, `mountRoutinesSettings`, push and offline cards; settings and lines follow the UI principles.

## Round 4 (Apple-design motion pass)

Spec: **`docs/DESIGN.md`** (binding). Applies the spring/material/response language from that doc to the
existing shell, sheet and views; no new user-facing feature.

### M — motion engine: `js/motion.js`, `tests/motion.test.mjs`
Pure, no DOM. Exports:
- `springStep(state: {value, velocity}, target, dt, {damping=1, response=0.35}) → {value, velocity}` — one analytic
  step of a damped harmonic oscillator (critically/under/over-damped), exact for any `dt`.
- `rubberband(overshoot, dimension, constant=0.55)` — DESIGN.md §2 resistance curve past a drag limit.
- `project(velocity, decelerationRate=0.998)` — flick projection, returns a displacement (caller adds its own position).
- `createSpringLoop({get, set, onSettle, raf?, caf?, now?}) → { to(target, {velocity, damping, response}), stop(), isAnimating() }`
  — rAF-driven; `get`/`set` work on any single scalar (a position, or an opacity/scale progress 0..1), so a retarget
  mid-flight always continues from the live value and the loop's own velocity (never jumps). Used by `sheet.js`
  (drag/snap) and by `app.js`'s popover (open/close progress).

### CSS (M2): `web/css/tokens.css`, `web/app.css`
New tokens: `--material-bg`, `--material-edge`, `--blur-chip` (12px), `--blur-surface` (20px), `--blur-saturate`
(180%), `--spring-ease` (CSS-transition approximation of damping 1 / response .35 — for things that fade only,
not for gesture-driven motion, which stays on the JS spring), `--track-*`/`--lead-*` per type step (display/title/
body/label, DESIGN.md §5). New utility classes in `app.css`: `.material` / `.material-lg` (translucent surface,
small-chip vs big-surface blur+shadow weight — never nested on each other), `.material-enter` (opt-in pop-in
keyframe), `.press` (JS-opt-in `:active`-style scale(.97) for non-native-button elements — native buttons already
get real `:active`), `.tabular` (`font-variant-numeric: tabular-nums`), `.fade-edge-top`/`.fade-edge-bottom` (mask
instead of a divider line under sticky chrome). `@media (prefers-reduced-transparency: reduce)` and
`(prefers-contrast: more)` fall back `.material`/`.material-lg`/`.searchbar`/`.fab`/`.sheet`/`.toast` to solid.

### CSS design tokens (shadcn-style): `web/css/tokens.css`
Two layers, both in `tokens.css` (the pre-TEL-46 names were removed in TEL-50; see the map below):
1. **Roles** (names as in shadcn/ui): `--background/--foreground`, `--card`, `--popover`, `--primary`, `--secondary`, `--muted/--muted-foreground`,
   `--destructive`, `--border` (decorative hairlines), `--input` (control edge, ≥ 3:1), `--ring` (focus), plus the app's own status
   colours `--live/--live-foreground/--live-muted`, `--scheduled/--scheduled-border/--scheduled-muted`, `--warning/--warning-muted`.
   Each has a `*-foreground` partner where text sits on the fill.
2. **Scales**: radius (`--radius` is the one knob; `--radius-sm/-md/-lg` derive from it, `--radius-full` for pills), spacing
   (`--space-1…8`, 4 px grid), type (`--text-2xs…3xl`, `--weight-*`, `--track-*/--lead-*`), controls (`--control-h` 44 px,
   `--control-h-sm`, `--disabled-opacity`), elevation (`--shadow-1/-2/-sheet`), motion (`--ease`, `--spring-ease`).

Old → new, for branches that predate TEL-50: `--bg`→`--background`, `--surface`→`--card`, `--surface-2`→`--muted`, `--text`→`--foreground`,
`--text-2`→`--muted-foreground`, `--accent`→`--primary`, `--accent-text`→`--primary-foreground`, `--accent-soft`→`--primary-soft`, `--danger`→`--destructive`,
`--focus`→`--ring`, `--scrim`→`--overlay`, `--live-bg`→`--live-muted`, `--sched`→`--scheduled`, `--sched-bg`→`--scheduled-muted`, `--warn`→`--warning`,
`--warn-bg`→`--warning-muted`, `--toast-bg/-text/-action`→`--inverse/-foreground/-action`, `--s1…4`→`--space-1/2/4/6`, `--fs`→`--text-base`, `--fs-sm`→`--text-sm`.
There is no `--accent` any more (shadcn's hover-tint role is `--muted`). `tests/tokens.test.mjs` fails if a stylesheet uses an old name.
Raw values: use the scale tokens where one fits (radius, 4 px-grid spacing, the type steps). Off-scale literals (10/14 px padding, .85/.9 rem text) are left as they were.

Themes: light in `:root`; dark in `@media (prefers-color-scheme: dark)` (unless `data-theme="light"`) and `:root[data-theme="dark"]`. The two dark
blocks must stay identical. Only roles are re-declared per theme; scales and components never are.
**LIVE vs SCHEDULED** status badges (`.atile-flag`, `.nb-flag`, `.pl-flag`, `.ex-chip-*`) share one recipe: LIVE = solid `--live` fill + `--live-foreground` text +
pulsing dot (`currentColor`); SCHEDULED = transparent fill, `--scheduled-border` outline, `--scheduled` text + clock icon. Components: inputs use `--input` + `--ring`, cards `--card`, popovers/sheets `--popover`/material.
**Buttons (TEL-51): one `.btn`** (`app.css`), variants composed as classes: `.primary`, `.destructive` (red outline), `.ghost`, `.link`, `.current`, `.on`, `.sm`,
`.rect` (12 px corners, Settings rows), `.round` (icon-only 44 px; `.strong` = body-colour glyph; not `.icon`, which is the SVG class). The old `.ex-btn`, `.ex-icon-btn`,
`.nb-btn*`, `.pl-btn`, `.pl-icon-btn`, `.stopv-btn`, `.stopv-primary`, `.icon-btn` are gone. A module class next to `.btn` (`.stopv-small`, `.nb-line .btn`) may add layout only.
`tests/tokens.test.mjs` checks contrast for every role pair in both themes (LIVE/SCHEDULED ≥ 7:1), dark-block parity, that no stylesheet uses a removed name and that
no stylesheet uses an undefined `var(--…)`.

### Shell & map (M5): `js/map.js`, `js/app.js` (menu/popover/FAB only)
- `map.js`: touch long-press now shows an immediate dot at `pointerdown` (DESIGN.md §1 — feedback on press-down,
  not only at completion), growing over the same 500 ms as the long-press timer, themed via the existing palette.
  Live vehicle markers were already gliding via a custom rAF tween (not a CSS transition) between position
  updates; confirmed still correct, left as is — it already satisfies §2 for passive (non-gesture) motion.
  Attribution control nesting checked: its default `hsla(0,0%,100%,.5)` background sits only on the opaque map
  canvas in the areas where it can appear next to the FAB column, never on another translucent layer (§4) —
  no change needed.
- `app.js`: the menu popover (`makePopover`) now scales/fades from the trigger button's centre
  (`transform-origin`, DESIGN.md §3) using `createSpringLoop` (§2's "popovers" belong on the spring, not a
  fixed-duration transition) — interruptible if re-tapped mid-close. The menu trigger (`#menu-btn`, a `.sb-btn`
  with no prior `:active` styling) opts into M2's `.press` utility for pointerdown feedback (§1).
- `sheet.js` (M1, in progress at the time of this note): imports `createSpringLoop`/`rubberband`/`project` from
  `motion.js`; drag-follow stays 1:1 (no physics while the finger is down), release hands velocity to the spring.

### Not yet landed / needs a follow-up from someone who owns the file
- `sheet.js`'s spring integration was still being extended as this note was written (constants for the
  momentum/settle spring presets were in place; full snap-point/rubber-band wiring may need a second pass by M1).

### Human verification needed
This round is motion/visual feel (springs, transform-origin, materials, press states). It was built and
reviewed by reading code only — **no browser or device was available in this session**. Before shipping:
open the app on a phone and a desktop, check the popover grows from the menu button (not its own centre),
check the long-press dot appears immediately on touch, drag the sheet and confirm it still follows 1:1 with
no stutter, and toggle `prefers-reduced-motion`/`prefers-reduced-transparency` in devtools to confirm the
fallbacks actually look right, not just that the media query exists.
