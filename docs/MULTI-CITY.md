# Multi-city support (issue #1): research + design

Status: **decided 2026-10-10**, implementation in progress. Owner decisions: (1) Corfu API calls allowed, (2) one
worker with `/api/{city}/…`, (3) app name **Telematica**.

## Research: Corfu (Κέρκυρα)

**Corfu is on the same citybus.gr platform as Patras.** The work is "add a second config", not
"write a second upstream adapter".

- citybus.gr's public home page lists 30 agencies, each with a stops page at
  `https://{slug}.citybus.gr/el/stops`. One of them is **Αστικό Κέρκυρας → `corfu.citybus.gr/el/stops`**.
- The operator's own site (astikoktelkerkyras.gr) links to its Android app, package
  `gr.citybus.urbantransit.corfu`, which is a citybus.gr build.
- The public stops pages of Patras and Corfu use the **same template** (fetched once each, token redacted, then diffed).
  Only these lines differ:

  | | Patras | Corfu |
  |---|---|---|
  | `agencyCode` | `112` | **`101`** |
  | `themeColor` | `#213A8F` | `#0079C1` |
  | `latSW, lngSW` | `38.128445, 21.541517` | `39.346151, 19.647453` |
  | `latNE, lngNE` | `38.344471, 21.930845` | `39.804373, 20.153001` |
  | page `<title>` | Στάσεις \| Αστικό Πατρών | Στάσεις \| Αστικό Κέρκυρας |

  Both pages carry `const token = '…'` and point at `rest.citybus.gr`. So the same token scrape and the same
  REST paths should work, with `/api/v1/el/101/…` in place of `/api/v1/el/112/…`.

**Verified 2026-10-10** (with the token scraped from the Corfu page):
- `/api/v1/el/101/stops` (479 stops) and `/lines` (13 lines, line `16` has no routes) have exactly the Patras shapes.
- Stop codes **do overlap**: 321 of the 479 Corfu codes also exist in Patras. Every cache/DO/KV key carries the city.
- `/stops/live/801` (Πλ. Σαρόκου) at 23:34 → 404, i.e. no service at night, as in Patras. Live shape still to be
  confirmed during service hours.
- Line codes are not always numeric (`04`, `2A`, `2B`); route codes and stop codes are numeric.
- Whether one token works across agencies is untested; the design uses one token per city.

The bbox on the Corfu page covers most of the island (~43 × 50 km), much more than the town network. For the
offline map and for `inArea()`, derive a tighter bbox from the stops' extent (+ margin) once the stops are known.
The page bbox is only the fallback.

## Design

### 1. One city table, everything reads from it
`web/js/cities.js` (frontend) and the same data inside the worker:

```js
{ id: 'patra', name: 'Πάτρα', agency: 112, page: 'https://patra.citybus.gr/el/stops',
  bbox: { west, south, east, north }, center: { lat, lng }, color: '#213A8F' }
```

`geo.js` (`inArea`), `geocode.js` (Photon `bbox`, fallback center), `map.js` (initial center), `offline.js` (download
bbox), `fetch-static.mjs` (`--city`), `build-routes.mjs` (center of «ΚΕΝΤΡΟ») read the **active city** instead
of their own constants. The table is a whitelist: the worker never takes an agency or host from a request.

### 2. Worker: one worker, city in the path (recommended)
`/api/{city}/live/:code`, `/api/{city}/stops`, `/api/{city}/lines`, `/api/{city}/stats/...`, push routes carry a
`city` field. Keys that need the city:
- cache: `live/{city}/{code}` (codes can collide across cities);
- KV token: `token/{city}`;
- Durable Objects: stats `{city}/{route}/{stop}`; reminders and routines store `city` and pass it to `liveBody`.

**Back-compat:** the old routes (`/api/live/:code`, `/api/stops`, …) stay as aliases for `patra`, and so do the
existing un-prefixed stats DO names. Installed PWAs on the old shell keep working until their SW updates, and
the Patras reliability history is kept.

Alternative: one worker per city. That means N deploys, N VAPID key pairs, N KV namespaces and N CORS lists, and
the frontend needs a URL table anyway. It only wins if cities need different upstream code, and the research
shows they don't.

### 3. Data layout
`web/data/{city}/stops.json`, `lines.json`, `routes.json`, `shapes.json`. Moving Patras's files to `web/data/patra/`
touches the SW `SHELL` list, `data.js` and the tests. It happens in the same change that adds Corfu, not before.

### 4. Frontend: active city
- Stored in `store` (`settings.city`, default `patra`). First run inside a known city's bbox → that city.
- Hash: optional prefix, `#/corfu/stop/123`. **No prefix = Patras** (all existing shared links, bookmarks and
  routines keep working). New share links always carry the prefix.
- Per-city user data: favorites, places, routines and reminders reference stop codes, so each item gets a `city`
  field. One-time migration tags existing items `patra`. Lists are filtered by the active city.
- Settings: a city picker. Switching reloads data and recenters the map.

### 5. Things that stay Patras-only for now
- Accents dictionary (`accents.js`) is curated for Patras names. Corfu names show un-accented until the dictionary
  is extended (rule: never guess).
- Route-order inference (`build-routes.mjs`) is generic but was only spot-checked on Patras. Corfu needs its own
  confidence review.
- App name / manifest / repo name. See open question 3.

## Contract (binding for the implementation)

**Worker**
- `GET /api/{city}/live/:code`, `/api/{city}/stops`, `/api/{city}/lines`, `/api/{city}/stats/:route/:stop`.
  `{city}` must be a key of `CITIES` in `web/js/cities.js`, else 404 `{error:'not_found'}`.
- Aliases for Patras, kept indefinitely: `/api/live/:code`, `/api/stops`, `/api/lines`, `/api/stats/:route/:stop`.
- `/health` → `{ ok, now, tokenExp /* patra, back-compat */, cities: { [id]: { tokenExp } } }`. `tokenExp` is read
  from KV only (`/health` never fetches a token). `null` means no token is stored for that city right now: no request
  for it yet, or its token expired and no request came after. It is not an error; the next live request for that city
  fetches a new token (checked 2026-10-19, TEL-95).
- Keys: edge cache `live/{city}/{code}`, `stats/{city}/{route}/{stop}`, `{city}/stops|lines`; KV token `token/{city}`;
  Stats DO name: **Patras keeps `{route}/{stop}`** (keeps its history), other cities `{city}/{route}/{stop}`.
- Push routes stay un-prefixed (`/api/push/…`). `POST /api/push/reminders` and `/api/push/routines` take an optional
  `city` (default `patra`; unknown → 400 `field:'city'`). Reminder/Routine DOs store it and read live through
  `liveBody(env, ctx, city, code)`, the same 15 s cache as the HTTP route.

**Data**: Patras stays at `web/data/*.json`; other cities at `web/data/{city}/*.json` (`dataDir()` in `cities.js`).
`fetch-static --city=corfu` and `build-routes --city=corfu` write there.

**Frontend**
- `api.js` always calls the prefixed routes (`/api/{cityId()}/…`, also for Patras); the memo is keyed by city + code.
- Active city at boot: hash prefix → `settings.city` → `DEFAULT_CITY`. Hash: `#/corfu/stop/123`; **no prefix = Patras**.
  New share links always carry the prefix. Switching city = save setting, go to that city's `#/`, reload.
- User items that reference stops (favorites, places, routines, reminders, recents…) carry `city`; a one-time
  migration tags existing items `patra`; lists show only the active city's items.
- Settings has a city picker. The app is called **Telematica** (manifest, `<title>`, about text, notification
  titles); the active city is shown in the UI. Repo, worker name, localStorage key and SW cache names stay as they are.

## Corfu data (2026-10-10)
`web/data/corfu/`: 479 stops, 13 lines, 55 routes (`routes.json` 23 KB, `shapes.json` 81 KB, one shape per route).
Line `16` (Λιμάνι - Σπήλια) has no routes upstream; nothing references it and the build skips it.
`node scripts/build-routes.mjs --city=corfu`: 110 OSRM requests (FOSSGIS, ~1 per 2 s in practice), 0 retries, all
routes `osrm-trip`, no flags. Patras output verified unchanged (80 routes, identical stops/legSec/confidence/method/
shapes in an `--offline` run against the committed files, 0 network).
- **Confidence:** min 0.80, mean 0.94. **No route is below 0.5** (18 are below 0.9, lowest: 86 0.80, 210 0.82,
  3 0.83, 5 0.85, 6 0.86). Nothing to hide in the UI for Corfu.
- **Centre words:** `build-routes.mjs` has a per-city `CENTER_WORDS` table (Patras `κεντρο`; Corfu `σαροκο`,
  `μεθοδιου`, `πολη`). Corfu writes the hub as «ΣΑΡΟΚΟ (ΠΟΛΗ)» or «ΜΕΘΟΔΙΟΥ (ΠΟΛΗ)»; the bracket is stripped before
  tokenising, so `σαροκο` / `μεθοδιου` are what match.
- **Spot check:** all 55 routes put the town hub (stop 801 / 501 area) at the end the name says; paired directions
  agree (consistency ≥ 0.81, 50 of 55 ≥ 0.94). Direction 2 routes start in town, direction 1 end there.
- **Free signal not used yet:** upstream has two stops per place, «X» and «X ΠΡΟΣ ΠΟΛΗ» (244 of 479 stops). Direction-1
  routes use the «ΠΡΟΣ ΠΟΛΗ» side (≥ 0.9 of their stops on most). This could replace the side-of-road test for Corfu;
  not needed so far.
- **Known issues:**
  1. Order is inferred, as in Patras. Loops through town (11, 45, 51: 40-50 % «ΠΡΟΣ ΠΟΛΗ» stops) and 86 (60 stops,
     28/19 side votes, 0.80) are the least certain.
  2. `CITIES.corfu.center` (39.6243, 19.9217) is ~400 m NE of the Πλ. Σαρόκου stops (801: 39.6221, 19.9180). It is
     only used as the centre target for orientation evidence (radius 1.5 km), so no effect on the output; fix it in
     `cities.js` when convenient.
  3. Codes are strings with leading zeros: route `093` vs `93`, stop `0015`, line `04`..`08`. Never coerce to number.
  4. Names stay un-accented (no Corfu accent dictionary yet, see section 5).

## Open questions (resolved, see Status)
1. **Allow the Corfu API calls?** That means `/stops`, `/lines` and `/stops/live/{code}` under agency `101`, the
   same shapes as the Patras ones, with the agency taken from the official page above. This extends the endpoint
   list in CLAUDE.md, so it needs an explicit yes.
2. **Worker shape:** one worker with `/api/{city}/…` (recommended) or one worker per city.
3. **Branding:** keep "Λεωφορεία Πάτρας" with Corfu as a secondary city, or a generic name ("Αστικά λεωφορεία")
   that shows the active city.

## Plan (each step ships on its own, tests green)
1. `cities.js` + constants → city config, Patras only, **no behavior change**. *(done)*
2. Worker: city-aware routes + keys with Patras aliases. *(done)*
3. Data: `fetch-static --city`, `build-routes --city`, `web/data/{city}/` (Patras stays at `web/data/`). *(done)*
4. Frontend: active city, hash prefix, per-city user data + migration, picker, rebrand to Telematica. *(done)*
5. Corfu: tight bbox from stops and route-order review *(done)*; still open: live shape during service hours, a real
   Corfu live fixture, manual check on a device, worker deploy **before** the frontend reaches `main` (the new
   frontend calls `/api/{city}/…`, which the currently deployed worker does not have).
