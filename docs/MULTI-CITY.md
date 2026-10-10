# Multi-city support (issue #1): research + design

Status: **draft for review**. Research done by hand on 2026-10-10; no new upstream endpoints have been called.

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

**Not yet verified, because it needs calls we haven't been allowed to make:**
- whether `/api/v1/el/101/stops`, `/lines` and `/stops/live/{code}` answer with the same shapes as agency 112;
- whether one token works across agencies. The JWT payload is only `{exp}`, so it might, but the design below does
  not depend on it: one token per city;
- whether the stop codes of the two cities overlap. The design assumes **they can**.

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

## Open questions (owner decisions)
1. **Allow the Corfu API calls?** That means `/stops`, `/lines` and `/stops/live/{code}` under agency `101`, the
   same shapes as the Patras ones, with the agency taken from the official page above. This extends the endpoint
   list in CLAUDE.md, so it needs an explicit yes.
2. **Worker shape:** one worker with `/api/{city}/…` (recommended) or one worker per city.
3. **Branding:** keep "Λεωφορεία Πάτρας" with Corfu as a secondary city, or a generic name ("Αστικά λεωφορεία")
   that shows the active city.

## Plan (each step ships on its own, tests green)
1. `cities.js` + constants → city config, Patras only, **no behavior change**. *(started on branch `multi-city`)*
2. Worker: city-aware routes + keys with Patras aliases. Needs decision 2.
3. Data: `fetch-static --city`, `build-routes --city`, move to `web/data/{city}/`. Corfu data needs decision 1.
4. Frontend: active city, hash prefix, per-city user data + migration, picker.
5. Corfu: tight bbox from stops, route-order review, demo fixture, manual check on a device.
