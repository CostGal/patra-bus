# Telematica architecture

*A plain-language overview. Details for people who code are in the docs listed under "More detail" at the end.*
*Words in **bold** with a ⓖ are explained in [GLOSSARY.md](GLOSSARY.md).*

## The big picture
Telematica is a web app that works like a phone app (a **PWA** ⓖ). Its files sit on **GitHub Pages** ⓖ and run entirely on your phone.
The phone never talks to the bus company directly. It asks our own small program, the **Cloudflare Worker** ⓖ, which holds the secret
**API token** ⓖ for citybus.gr, asks citybus.gr "which buses are coming to stop 1011?", tidies the answer and remembers it for 15 seconds
so many phones asking the same question cost only one call. The tidy-up step marks each bus as **live** (it has GPS coordinates) or
**scheduled** (coordinates are `0/0`, so it is only the timetable). The phone repeats the question every 20 seconds while the app is visible.
The list of stops, lines and routes is not fetched live: it is saved as files in the repo (`web/data/`). The Worker also keeps a few things
(the token, delay statistics, anonymous daily counts) in **Durable Objects** ⓖ and **KV** ⓖ. The app has no push notifications or routines;
the Worker still carries code for them that nothing in the app calls (see [WORKER.md](WORKER.md)).

## Data flow
```
 citybus.gr (upstream)  <--token, bus questions--  Cloudflare Worker "patra-bus"  <--/api/{city}/live/1011--  Phone (PWA)
   (patra / corfu)                                  - token kept in KV                 ^  asks every 20 s,        - favourites, settings,
                                                    - 15 s cache per stop              |  only while visible        saved places
                                                    - live vs scheduled                |                           - your location (never sent to us)
                                                    - Durable Objects: delay stats,    |  files from GitHub Pages
                                                      anonymous daily counts           +-- (web/ folder, offline copy via service worker)

 Phone also talks DIRECTLY to: OpenFreeMap (map tiles) | OSRM/FOSSGIS (walking route) | Photon (place search)
 Worker also talks to: Notion (only when a user sends "Report a problem")
```

## Where data lives
| Where | What | Notes |
|---|---|---|
| **On the phone only** | Favourites, recents, settings and first-run flags in one blob in `localStorage` ⓖ (`patra-bus:v2`); saved places (`patra-bus:places`); pending local reminders (`patra-bus:reminders`); a "location worked before" flag (`patra-bus:loc-granted`). Details: [FRONTEND.md](FRONTEND.md) section 5 | "Delete all" in Settings clears the `v2` blob and the reminders, not the places or the location flag. |
| **On the phone, never stored** | Your live GPS location | Only the flag "permission granted" is saved. Never sent to our Worker, never put in a link. |
| **Cloudflare KV** ⓖ | Citybus token per city (`token/{city}`), daily report counter (`report-day/{date}`), short fallback cache (`memo/…`, 60 s) | Token expires every 48 h. It is fetched only when a request needs it: the first request for that city, any request in the last 5 min before expiry, or a retry after a 401/403. No timer refreshes it. The KV entry expires with the token, so a city with no requests since then has no token (`/health` shows `null`). |
| **Cloudflare Durable Objects** ⓖ | **`Stats`**: delay statistics (last 200 samples per route + stop), read by the app. **`Reminder`** (one-off push reminders: push subscription ⓖ, time, bus line/stop codes) and **`Routine`** (weekly: same, kept up to 120 days): the Worker still has them, but the app has no client for either | A reminder is deleted after it is sent. No place names or coordinates are stored. `Counters` is in the next row. |
| **Cloudflare Durable Object `Counters`** ⓖ | Anonymous daily totals: one number per (Athens day, metric, city), e.g. "3 feedback reports from Patras on 2026-10-25". Metrics and cities come from a fixed whitelist (`worker/src/counters.js`). `feedback` is counted by the Worker after a forwarded report; `open` and `install` arrive from the app through `POST /api/count` `{metric, city}` (only those two metrics; Origin + JSON checks, 20 / 10′ per IP in memory, 204 with no body; previews and localhost answer 204 without counting; TEL-196). The app side is `web/js/usage.js`, called once after boot: `open` at most once per device per Athens day, `install` once on the first launch as an installed app; nothing with the Settings → Data switch off (`usageStats`), with Global Privacy Control, in `?demo` or off `https://costgal.github.io`. The markers `usageDay` / `usageInstall` stay on the device (inside the `patra-bus:v2` blob, so "Delete all" removes them). `push` is on the whitelist but nothing records it, so today only `feedback`, `open` and `install` are counted. | No IP, device id, user id or free text, and nothing finer than the day: a request can only add 1 to a row. Counting is best effort and never blocks the request it rides on. Read only through the private page `GET /stats` (served by the Worker, not by Pages) → `GET /api/admin/counts` with `Authorization: Bearer <STATS_TOKEN>` (Cloudflare secret; 401 wrong token, 429 after 3 wrong tries / 10′ per IP in memory, 503 without the secret). No CORS header, `no-store`, the token never in a URL (`worker/src/admin.js`, TEL-195). |
| **GitHub repo** | Stops, lines, routes (`web/data/`), all code | Public. Secrets are never committed. |
| **Notion** | Problem reports a user chose to send | Via the Worker. |

Third-party services (free, no key). Credits: Settings → Σχετικά lists OpenStreetMap, OpenFreeMap, MapLibre, OSRM / FOSSGIS, Photon and citybus.gr; the map shows the OpenFreeMap / OpenStreetMap attribution behind its (i) button:
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
| Place search | `web/js/geocode.js` |
| Local reminder timers | `web/js/notify.js`: only the test button and the list in Settings use it today, and `app.js` loads it to re-arm saved ones. The Worker side (`worker/src/reminders.js`, `push.js`, `routines.js`) has no client in the app |
| Vehicle page (one bus as a timeline) | `web/js/bus-view.js` |
| Saved places (home, work) | `web/js/places.js`, shown in Settings; nothing else reads them yet |
| Anonymous counts | `web/js/usage.js`, `worker/src/counters.js`, `worker/src/admin.js` (private `/stats` page) |
| First-run setup and testers' welcome | `web/js/setup.js`, `web/js/welcome.js` |
| Delay statistics | `worker/src/stats.js` |
| Offline app shell and runtime map cache | `web/sw.js` |
| Problem report | `web/js/report-view.js`, `worker/src/report.js` |
| Storage on the phone, settings | `web/js/store.js`, `settings-view.js` |
| Cities (Patras, Corfu) | `web/js/cities.js`, `docs/MULTI-CITY.md` |
| Greek / English text | `web/js/i18n.js`, `i18n-en*.js` |
| Deploys and checks | `.github/workflows/`: `pages.yml`, `worker-deploy.yml`, `test.yml`, `lighthouse.yml`, `merge-window.yml`, `watch-same-bus.yml`; `worker/wrangler.toml` (Worker settings) |
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
- **Stop order is guessed.** The order of stops on a route is inferred, not official; 10 of 80 Patras routes have low confidence (Corfu: none of 55).
- **Stale static data.** Stops/lines/routes are committed files. If the city changes a stop, the app shows old data until someone runs `npm run fetch-static` and merges.
- **One production Worker, one staging Worker.** Web previews (and the live site) still call the production Worker `patra-bus`. Worker changes are tried first on **staging** ⓖ: a second Worker `patra-bus-staging` with its own KV, Durable Objects and secrets (`[env.staging]` in `worker/wrangler.toml`), deployed from any branch by the Action **Worker deploy** (target `staging`), and by itself after a merge to `main` that touches the Worker. Production is deployed only by the same Action from a published GitHub **Release** ⓖ (a tag like `v0.9.1`), after Kostas approves it in the GitHub **Environment** ⓖ `production`; the site on GitHub Pages changes on the same Release (TEL-211). Nobody deploys from their own computer. A forgotten approval still leaves the Worker behind the web files.
- **Free plan limits are per account, shared by staging and production** (checked 2026-10-28 in Cloudflare's docs): 100,000 Worker requests/day, KV 1,000 writes/day and 100,000 reads/day, Durable Objects only SQLite-backed (100,000 requests/day), 100 Workers per account. Heavy testing on staging eats production's daily quota. Web previews (Workers Builds, project `patra-bus-dev`): 3,000 build minutes/month, 1 build at a time, 20′ timeout; static files are free and unlimited.
- **Rate limits are per server instance** (in memory), not global: a brake, not a wall.
- **Public servers.** OSRM, Photon and OpenFreeMap are free community services with fair-use rules; they can slow down or block heavy use. UNVERIFIED whether our usage is inside their limits at larger scale.
- **VAPID key change.** Changing the push key needs the public key (in `wrangler.toml`) and the private key (a Cloudflare secret) to change together. UNVERIFIED what happens to already-subscribed phones.
- **Cache inside Durable Objects** is believed unreliable, so a short KV copy is used as backup (`cachedBody` in `worker/src/index.js`). UNVERIFIED in production.

## More detail
- [FRONTEND.md](FRONTEND.md): how `web/` is built: router, views, modules, device storage, service worker.
- [WORKER.md](WORKER.md): the Cloudflare Worker, its routes, Durable Objects and secrets.
- [UPSTREAM-API.md](UPSTREAM-API.md): the citybus.gr endpoints we use and what they return.
- [CI-AND-DEPLOY.md](CI-AND-DEPLOY.md): workflows, previews, deploys and the merge window.
- [TESTING.md](TESTING.md): unit and smoke tests, fixtures.
- [DESIGN.md](DESIGN.md): motion and material rules for the UI.
- [MULTI-CITY.md](MULTI-CITY.md): how Patras and Corfu share one app.
- [WORKFLOW.md](WORKFLOW.md): how we work on cards and sessions.
- [GLOSSARY.md](GLOSSARY.md): the ⓖ words explained.
- [archive/ARCHITECTURE-rounds-1-4.md](archive/ARCHITECTURE-rounds-1-4.md): old module contracts from the first build rounds (history, partly wrong today).
