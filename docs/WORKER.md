# API worker

This doc covers the Cloudflare Worker `patra-bus` in `worker/`: a proxy and cache in front of citybus.gr, so the citybus token never reaches the browser. It is Amarildo's area.

## 1. What it does

- The app asks the worker for live arrivals, stops and lines. The worker asks citybus.gr (with its own token), cleans the answer and caches it.
- It also takes problem reports (to Notion), anonymous daily counters, and keeps delay statistics.
- It imports four files from `web/js/`, so app and worker use the same logic: `arrivals.js` (live vs scheduled), `cities.js` (city table), `report.js` (report validation), `notif-link.js` (used by the push code).
- A change to those files also redeploys the worker. The list of watched paths is in `.github/workflows/worker-deploy.yml` (see `docs/CI-AND-DEPLOY.md`).

## 2. Routes

The router is `fetch()` in `worker/src/index.js` (lines 332-393). Path parsing for the read-only routes is `worker/src/routes.js`. `{city}` is `patra` or `corfu`. Without a city prefix the path means Patras, and these aliases are kept on purpose.

| Method and path | Returns | Cache | Notes |
|---|---|---|---|
| `GET /api/{city}/live/:code` | Normalized live arrivals for a stop | 15 s | `:code` is 1-6 digits. Header `X-Cache`. |
| `GET /api/{city}/stops` | All stops of the city | 24 h | Passed through from citybus.gr. |
| `GET /api/{city}/lines` | All lines of the city | 24 h | Same. |
| `GET /api/{city}/stats/:route/:stop` | Delay summary, see section 9 | 10 min | Codes must be 1-8 digits, else 400. |
| `GET /api/live/:code`, `/api/stops`, `/api/lines`, `/api/stats/:route/:stop` | Same as above, for Patras | same | Aliases. |
| `GET /version` | `{api, minApp}` | none | Oldest app version this worker serves, section 12. |
| `GET /health` | `{ok, tokenExp, cities: {id: {tokenExp}}, now}` | none | `tokenExp` is `null` when no token is stored. |
| `POST /api/report` | `{ok: true}` | none | Problem report, section 7. |
| `POST /api/count` | `204`, no body | none | Anonymous counter, section 8. |
| `GET /stats` | Static HTML page, holds no data | none | Private stats page. |
| `GET /api/admin/counts` | Counter totals as JSON | none | Needs `Authorization: Bearer <STATS_TOKEN>`. |
| `GET /api/push/key` | `{publicKey}` | none | Push, section 10. `503` without the key. |
| `POST /api/push/reminders` | `201 {id}` | none | One-off reminder. |
| `DELETE /api/push/reminders/:id` | `204` | none | `:id` is 32 hex characters. |
| `POST /api/push/routines` | `201 {id}` | none | Weekly routine. |
| `DELETE /api/push/routines/:id` | `204` | none | Same id format. |

Other behaviour:

- `OPTIONS` answers `204` with the CORS headers (`GET, POST, DELETE, OPTIONS`, preflight cached 24 h).
- Any other method on a read route, and any unknown path, gives `404 {error: 'not_found'}`.
- An unknown city gives `404`. A failed upstream call gives `{error: 'upstream', status}` with the upstream status or `502`.
- `/stats` and `/api/admin/counts` send no CORS header on purpose, so no other site can read them.

## 3. Caching

- The helper is `cachedBody()` in `index.js` (line 115). It uses the Cloudflare Cache API (`caches.default`) with a key that always contains the city: `live/{city}/{code}`, `stats/{city}/{route}/{stop}`, `{city}/stops`, `{city}/lines`. Stop codes repeat between cities, so the city must be in the key.
- Fallback: if the Cache API throws (a risk inside Durable Objects), a copy goes to KV as `memo/{key}` for 60 s. This path is not proven in production.
- The browser always gets `Cache-Control: no-store`, except stats, which sends `public, max-age=600`.
- Header `X-Cache: HIT|MISS` is on live, stats, stops and lines. On a HIT, `fetchedAt` in the body is the time of the original upstream fetch, not of this request. The app uses it to age the countdowns.
- Upstream 404 for live means "no departures now". The worker answers `200 {vehicles: [], noService: true}` and caches it like any other answer.
- An empty or invalid upstream body counts as an error and is not cached.
- The reminder and routine code reads live through the same function (`liveBody`), so it shares the 15 s cache.

## 4. Token handling

- The token is inside the HTML of the city page (`https://{city}.citybus.gr/el/stops`) as `const token = '…'`. The page URL comes from `web/js/cities.js`.
- It is stored in KV as `token/{city}` with the expiry date (`exp`) read from the JWT. The KV entry expires with the token.
- It is fetched only when needed: no token stored, or fewer than 5 minutes left. There is no timer.
- On upstream `401` or `403`, the worker scrapes a fresh token and retries once, now with a `Referer` header.
- Upstream facts (endpoints, token format, `0/0` coordinates) are in `docs/UPSTREAM-API.md`. They are not repeated here.

## 5. Storage

KV namespace `patra-bus-token`, binding `KV`:

| Key | Holds | Lifetime |
|---|---|---|
| `token/{city}` | `{token, exp}` | until the token expires |
| `report-day/{YYYY-MM-DD}` | number of reports forwarded that UTC day | 2 days |
| `memo/{cache key}` | fallback copy of a cached answer | 60 s |

Durable Objects (all SQLite-backed, class names in `worker/src/index.js`):

| Binding | Class | Holds | Object name |
|---|---|---|---|
| `STATS` | `Stats` | last 200 delay samples and pending sightings | Patras `{route}/{stop}`; other cities `{city}/{route}/{stop}` |
| `COUNTERS` | `Counters` | table `counts(day, metric, city, n)` | `global` (one object) |
| `REMINDERS` | `Reminder` | one push reminder | random 128-bit id |
| `ROUTINES` | `Routine` | one weekly routine | random 128-bit id |

Patras keeps the old name form because its history is older than multi-city.

Migrations in `worker/wrangler.toml`: `v1` adds `Reminder`, `v2` adds `Routine` and `Stats`, `v3` adds `Counters`.

## 6. CORS

- `ALLOWED_ORIGIN` in `worker/wrangler.toml` is a comma-separated list. Production: `https://costgal.github.io`, `http://localhost:8080`, `https://patra-bus-dev.patra-bus.workers.dev`, `https://*-patra-bus-dev.patra-bus.workers.dev`. Staging has the same list without the first entry.
- An entry is an exact origin, or one with a single `*` inside the first host label. `*` stands for one or more of `a-z`, `0-9`, `-`. That matches preview URLs of one project and nothing else. Any other use of `*` matches nothing. If the variable is missing, the default is `*`. Code: `worker/src/origin.js`.
- An allowed origin is echoed back in `Access-Control-Allow-Origin`. An unknown origin gets the first exact entry of the list instead, so the browser blocks the answer.
- This only stops browsers running other sites. A script or `curl` can still call GET routes. `POST /api/report` and `POST /api/count` also refuse a request whose `Origin` is not allowed (`403`). A request with no `Origin` passes.

## 7. Problem reports (`POST /api/report`)

Code: `reportRoute()` in `index.js` (line 268), `worker/src/report.js`. Checks run in this order, cheapest first:

1. Method is `POST`, else `404`.
2. Origin allowed, else `403`.
3. `Content-Type: application/json`, else `415`.
4. `NOTION_TOKEN` and `NOTION_DB_ID` exist, else `503`.
5. `Content-Length` and the real body size at most 8192 bytes, else `413`.
6. At most 3 reports per IP per 10 minutes, else `429`. The count lives in memory of one isolate (a running copy of the worker), so it is not global.
7. Body is valid JSON, else `400`.
8. Honeypot field `hp` non-empty: answers `200 {ok: true}` and sends nothing.
9. `validateReport()` from `web/js/report.js` (category, message 10-2000 characters, optional email, whitelisted diagnostics), else `400` with the field name.
10. Daily cap of 100 reports for all clients, key `report-day/{date}` in KV. The date is the UTC day. Over the cap gives `429`. If KV fails, the cap is skipped.
11. One page is created in the Notion database (8 s timeout). A failure gives `502 forward_failed`, and the log has the status only.

The page has the title `{Category}: {first line}`, with `[preview] ` in front when the origin matched the `*` pattern. It also has Category, Status `New`, Received, City and Email, the message text, and the diagnostics as a JSON block. The worker stores nothing itself, and the IP is never forwarded. Without the Notion secrets the endpoint answers `503` and the app says the form is unavailable.

## 8. Anonymous counters

The rule is CLAUDE.md rule 4. This is the mechanics (`worker/src/counters.js`, `index.js` line 309, `admin.js`).

- Whitelist in code: `feedback`, `open`, `install`, `push`. Cities come from the city table; `''` means no city.
- Recorded today: `feedback` by the worker after a report was forwarded, and `open` and `install` from `POST /api/count`. `push` is on the whitelist but no code records it.
- The app sends only `{metric, city}`. `open` goes at most once per device per Athens day, `install` once, on the first launch as an installed app. Nothing is sent with the Settings switch off, with Global Privacy Control, in `?demo`, or from any site other than `https://costgal.github.io`. Client code: `web/js/usage.js`.
- `POST /api/count` checks: origin (`403`), JSON content type (`415`), 20 per IP per 10 minutes (`429`), body at most 200 bytes (`413`), valid metric and city (`400`). It answers `204`.
- Requests from `*`-pattern preview origins and from `localhost` or `127.0.0.1` get the same `204` but are not counted. A request with no `Origin` header is counted.
- A row is one number per (Athens day, metric, city), kept in the `Counters` object. An increment adds 1 inside the object, so it is safe against two requests at once. A counting error is logged and never breaks the request.
- Reading: `GET /stats` serves a page with a password field. The page calls `GET /api/admin/counts` with the token in a header, never in a URL. The answer has today's date, totals for today, 7 days, 30 days and all time, and the last 30 days per day. A wrong token gives `401`; after 3 wrong tries in 10 minutes per IP it gives `429`; no `STATS_TOKEN` gives `503`.

## 9. Delay statistics (`Stats`)

- Fed only by live answers the worker fetched anyway (cache MISS, upstream answered). It never makes extra upstream calls.
- A vehicle seen as scheduled at a stop, with scheduled time T, is remembered. When the same vehicle shows as live at that stop with an ETA of 5 minutes or less, delay = live arrival minus T is saved once. Delays beyond 45 minutes are ignored (a different lap).
- Each object keeps the last 200 samples. Pending sightings expire after 3 hours.
- `GET .../stats/:route/:stop` returns `{samples, medianDelaySec, p80DelaySec, updatedAt}`. With no samples the two delays are `null`.

## 10. State of push and routines

The app has no client any more for push reminders or weekly routines. The worker side is still in the code: the routes in section 2, the `Reminder` and `Routine` classes (`reminders.js`, `routines.js`), the sender in `push.js`, VAPID settings and `DEV_ALLOW_LOCAL_PUSH`.

- Push routes answer `503` unless both VAPID keys exist. POST bodies are limited to 4096 bytes (`413`). Each of the two POST routes allows 12 requests per IP per 10 minutes.
- Only push services of Google, Mozilla, Microsoft and Apple are accepted as subscription endpoints (`push.js`). `http://localhost` is allowed only with `DEV_ALLOW_LOCAL_PUSH=1`.
- Reminder: an alarm fires at the chosen time. If it has a trip, the worker re-reads live and re-arms up to 3 times when the bus is more than 60 s late. If the push service answers `429` or `5xx`, it retries once after 30 s to 5 min. Everything is deleted after sending.
- Routine: on each chosen weekday (Athens time) it checks live 20 minutes before, picks the first catchable bus, sends at leave time minus `leadMin`, then arms the next day. It expires after 120 days and is deleted when the push service says the subscription is gone.
- `cleanUrl()` in `reminders.js` drops any notification `url` that has `to`, `from`, `name`, `lat` or `lng`, so no place data is ever stored.
- To remove this feature, delete the code and the routes, and add a `[[migrations]]` entry with `deleted_classes = ["Reminder", "Routine"]`. Deleting only the code and bindings is not enough: the stored objects stay until a `deleted_classes` migration removes them.

## 11. Secrets and local run

Names only. Values never go in the repo (CLAUDE.md rule 7).

| Name | Used for | Lives in |
|---|---|---|
| `VAPID_PRIVATE_KEY` | signing push messages | Cloudflare secret; `worker/.dev.vars` locally |
| `VAPID_PUBLIC_KEY` | public push key | `[vars]` in `wrangler.toml` for production; Cloudflare secret on staging; `.dev.vars` locally |
| `VAPID_SUBJECT` | contact for push services | `[vars]` in `wrangler.toml` |
| `NOTION_TOKEN`, `NOTION_DB_ID` | problem reports | Cloudflare secret; `.dev.vars` locally (use a test database) |
| `STATS_TOKEN` | the `/stats` page | Cloudflare secret; `.dev.vars` locally |
| `DEV_ALLOW_LOCAL_PUSH` | local push testing | `.dev.vars` only |

- A production secret is set by Kostas with `npx wrangler secret put <NAME> --config worker/wrangler.toml` (staging: add `--env staging`). This changes a secret only; it deploys nothing.
- Copy `worker/.dev.vars.example` to `worker/.dev.vars` (ignored by git). Every line is optional; without it only that feature answers `503`.
- Run locally with `npm run dev:worker` (port 8787, local KV and Durable Objects, nothing reaches Cloudflare). On `localhost` the app calls `http://localhost:8787` (`API_BASE` in `web/js/api.js`).
- Setup steps are in `CONTRIBUTING.md`. Deploys are in `docs/CI-AND-DEPLOY.md`.

## 12. Compatibility (`/version`)

Installed apps update late (the service worker swaps files on the next visit), so for a while old apps call the new worker. These rules keep them working.

- `GET /version` answers `{api, minApp}` from `worker/src/version.js`. `minApp` is the oldest app version (`APP_VERSION` in `web/js/i18n.js`) this worker still serves. `api` is the contract version, `1` today.
- **Only add fields.** A field the app reads is never renamed, removed or given another type in the same release. To change one: add the new field next to the old one, ship the app that reads the new one, and remove the old one in a later release.
- **The worker goes up first.** A release that needs a new worker field deploys the worker (staging, then production) before the web files that read it.
- **`minApp` goes up only when an older app really breaks**, never just because a new version exists. A test fails if `minApp` is newer than the app in `web/`.
- **`api` goes up only for a change old apps cannot read**, which the rules above should make rare.
- The contract test `tests/worker-contract.test.mjs` (part of `npm test`) lists every field the app reads from `/version`, `/health`, live (with and without service), stats and errors. A new field passes; a removed, renamed or retyped one fails. A new field the app starts reading goes into the test's `CONTRACT` in the same PR.
- The app does not read `/version` yet; showing «update the app» when it is older than `minApp` is a separate card (`web/`).
