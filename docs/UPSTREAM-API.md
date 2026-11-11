# citybus.gr upstream API

This doc covers what we know about the unofficial citybus.gr REST API that the worker and the data scripts call. Facts were verified on 2026-10-09 unless stated otherwise. For the hard project rules see `CLAUDE.md`; for Corfu see `docs/MULTI-CITY.md`.

## Host and cities

- Host: `https://rest.citybus.gr`. Base path: `/api/v1/el/{agency}` (`apiBase()` in `web/js/cities.js`).
- Agency `112` = Patras, agency `101` = Corfu. The city table is `web/js/cities.js`; nothing else hard-codes agencies.
- Each city has its own page that carries the token: `https://patra.citybus.gr/el/stops`, `https://corfu.citybus.gr/el/stops`.
- Corfu uses the same three endpoints under the same rules (approved 2026-10-10) and returns the same shapes.
- Stop codes overlap between cities (321 of Corfu's 479 stop codes also exist in Patras), so every cache key and file includes the city.
- Codes are strings with possible leading zeros. Corfu has route `093` (not `93`), stop `0015`, line `04`. Never turn a code into a number.
- Names arrive uppercase and without accents. The accent dictionary was curated for Patras; `titleCase()` does not look at the city, so a Corfu word that is in the dictionary gets its accent too (`docs/FRONTEND.md` section 8).

## Allowed endpoints

Only these three are used, all GET, with no query parameters. The API is unofficial and they can block us, so we do not probe other paths.

- `/stops`
- `/lines`
- `/stops/live/{code}`

Other endpoints exist (trips, sequence, `/api/v1/112/lines/{code}/points` without `el`), but we do not use them. The exact path for the stop order of a route is unknown and is not searched for.

## Authentication

- Header: `Authorization: Bearer <token>`. That is all that is needed.
- A `Referer` (the city page origin) is sent only as a fallback when the first call gets 401 or 403 (`worker/src/index.js` `upstream()`, `scripts/fetch-static.mjs` `get()`, `scripts/record-fixtures.mjs` `getLive()`).
- Token source: the HTML of the city page contains `const token = '...'` once. The worker, `fetch-static` and `record-fixtures` scrape it with the same regex.
- Shape: HS256 JWT, payload only `{exp}`, valid 48 hours.
- The worker keeps it in KV `token/{city}` (`worker/src/index.js` `getToken()`). The scripts hold it in memory only. It is never written to a committed file.

## Response shapes

`/stops` returns an array (839 items on 2026-10-09):

| Field | Type |
|---|---|
| `id` | number |
| `code` | string |
| `name` | string |
| `latitude`, `longitude` | number |
| `lineCodes`, `routeCodes` | arrays |
| `distance` | always 0, dropped |

`/lines` returns 30 items on 2026-10-09: `id`, `code`, `name`, `color`, `textColor`, `borderColor` and `routes[]` with `id`, `code`, `name`, `direction` (1 or 2).

`/stops/live/{code}` returns `{vehicles: [...]}`. Each vehicle has:

| Field | Type |
|---|---|
| `lineCode`, `lineName`, `routeCode`, `routeName` | string |
| `latitude`, `longitude` | string |
| `departureMins`, `departureSeconds` | number |
| `vehicleCode` | string |
| `lineColor`, `lineTextColor`, `borderColor` | string |

## Reading a live response

`normalizeLive()` in `web/js/arrivals.js` is the only place that interprets it. The worker and the frontend share it.

- Scheduled vs live: `latitude`/`longitude` of `"0"`/`"0"` means a scheduled departure. Everything else is live. Unparseable or out-of-range coordinates also count as not live (`isLive()`).
- `0/0` coordinates are never shown or used. Coordinates only leave `normalizeLive` for live vehicles.
- `departureMins` is the number of minutes until the (scheduled) time.
- `departureSeconds` is a remainder from 0 to 59, not a total. 1′14″ arrives as mins 1, secs 14. It can be non-zero on scheduled rows too.
- So `etaSec = departureMins * 60 + departureSeconds`, and the scheduled clock time is `fetchedAt + etaSec`. This stays stable between fetches (for example 22:45:33).
- A scheduled row that duplicates a live bus of the same line (within a small time window) is dropped, so the bus does not show twice (`dropScheduledDuplicates()`).

## Edge cases

- 404 on `/stops/live/{code}` means no departures at that time (confirmed 2026-10-10: 404 at night, data in the morning). The worker turns it into `200 {vehicles: [], noService: true}` and caches it for 15 s (`liveBody()` in `worker/src/index.js`, `noServiceResult()` in `web/js/arrivals.js`).
- Once a 200 came back with an empty body, on a quick repeat call. The worker treats an empty body as an upstream error and does not cache it (`upstream()`). `record-fixtures` fails with "empty body, try again".
- Static data (`/stops`, `/lines`) is cached by the worker for 24 h (`worker/src/index.js`).

## Rate rules

- Never poll the live endpoint faster than every 15 s. The frontend enforces this with a per-stop memo that also covers errors (`MIN_GAP_MS = 15000` in `web/js/api.js`), and the worker caches live answers for 15 s.
- The frontend polls every 20 s (`POLL_MS`), and only while the page is visible.
- `fetch-static` pauses 250 ms between `/stops` and `/lines`. `record-fixtures` makes one live GET per city and nothing else.

## Test stop

Patras stop `1011` `ΠΑΝΕΠΙΣΤΗΜΙΟΥ & ΑΡΕΘΑ` (lines 201, 606, 609). See `docs/TESTING.md` for the fixtures.

## Unconfirmed observations

Seen on 2026-10-10 and not verified. Do not build on them.

- `vehicleCode` looks like `YYYYMMDD_route_..._HH_MM`. The HH_MM matched departure times from the terminus, so it may be a source of the timetable. It is not used.
- The live answer for a terminus stop lists only 1 or 2 departures, about 25 minutes ahead.
- Route 2015 (confidence 0.25 in `routes.json`) probably has its stop order reversed: the departures of its "first" stop 372 belong to route 2021.
