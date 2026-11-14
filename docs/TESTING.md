# Testing and local checks

This doc covers the unit tests, the Playwright smoke tests, their fixtures, the `?demo` modes and the screenshot sweep.

## Commands

```
npm test                  # test:unit + test:e2e (what CI runs)
npm run test:unit         # node --test tests/*.test.mjs
npm run test:e2e          # Playwright smoke tests in tests/e2e/
npx playwright install chromium   # first time only, before test:e2e
npm run check:i18n        # Greek/English string check (CI runs it too)
```

CI (`.github/workflows/test.yml`, required check `test`) runs a secret scan, `npm test` with a Greek locale (`LANG=el_GR.UTF-8`, because tests read Greek UI text), `check:i18n` and a `wrangler deploy --dry-run` of the worker. Lighthouse is a separate workflow.

If CI fails, download the artifact `playwright-results` (kept 14 days). It has one trace per failing test: `npx playwright show-trace <trace.zip>`.

## Unit tests

39 files, `tests/*.test.mjs`, `node:test`, no dependencies. They cover pure logic and the worker: live/scheduled rules (`arrivals`), city data (`multicity`, `corfu-data`), routes (`worker-routes`), geo and walking (`geo`, `walk`), the store (`store`), i18n (`i18n`, `check-i18n`), push and reports on the worker (`push-worker`, `report`) and the service worker map cache (`sw-map`).

## Smoke tests (Playwright)

Config: `playwright.config.mjs`. Chromium at 360x780 as a phone (touch, scale 2), locale `el-GR`, timezone `Europe/Athens`. A static server of `web/` runs on port 4173. Service workers are blocked unless a spec opts in. The whole suite has a 2 minute limit (about 10 s locally). CI retries once.

Specs in `tests/e2e/`:

- `smoke.spec.mjs`: both cities, search, arrivals, LIVE vs scheduled, EL/EN switch, against the fixtures.
- `offline.spec.mjs`: the app shell loads offline after the first visit (service worker on).
- `setup.spec.mjs`: the first-run setup (language, city, LIVE vs scheduled).
- `freshness.spec.mjs`: a LIVE tile with old data stops looking LIVE.
- `forced-colors.spec.mjs`: LIVE and scheduled still differ in high-contrast mode.
- `tap-targets.spec.mjs`: small controls still have a 44 px tap area.

### No network

`tests/e2e/mock.mjs` routes every request. The `web/` static origin is real. `http://localhost:8787/api/{city}/live/{code}` is answered from the fixture, passed through the same `normalizeLive` as the worker, with `fetchedAt` = now. Any other worker route gets 404. Every other origin (citybus.gr, the deployed worker, OpenFreeMap, OSRM, Photon) is aborted and recorded. After each test it fails if a call to `citybus.gr` or `workers.dev` was attempted, or if the page threw an uncaught error.

`mock.mjs` also writes `setupDone` into the store before the page loads, so the setup does not cover other tests. A spec that wants it uses `test.use({ firstRun: true })`. In the same way it sets `sessionStorage['patra-bus:boot']`, so the boot screen (TEL-255) does not add a second to every test; `boot.spec.mjs` uses `test.use({ boot: true })`. The signal that a screen has loaded is `#sheet-content` without `aria-busy`, not a «Φόρτωση…» text.

### Fixtures

- Files: `tests/e2e/fixtures/{city}-live-{code}.json` = `{ city, stop, recordedAt, status, body }`. `body` is the raw upstream `/stops/live/{code}` answer. Status 404 means `body: null` (no service).
- Stops (`tests/e2e/stops.mjs`): Patras `1011`, Corfu `404` (Πολυκλινική, mid-route on lines 04, 07, 08, 11, 14).
- Not a terminus: a first stop like `801` (Πλ. Σαρόκου) only lists scheduled departures and never a live bus.
- Each fixture needs at least one live and one scheduled departure, because the LIVE vs scheduled test runs on both cities.
- Current recordings: Patras 2026-10-09 evening (same data as `web/fixtures/live-1011.json`, used by `?demo`); Corfu 2026-10-19 18:08, stop 404 (1 live: line 11, 2 scheduled: 04, 07).

Re-record with `npm run record-fixtures` (`-- --only=corfu` for one city). It scrapes the token like `fetch-static` (not written anywhere) and makes one live GET per city. Do it on a weekday, in service hours. If the answer lacks a live or a scheduled departure, it does not write and exits 1, so a night run cannot replace a good fixture. `--force` writes anyway. Afterwards run `npm run test:e2e` and commit the JSON. To change a stop, edit `tests/e2e/stops.mjs` and the names/queries in `CITY` of `smoke.spec.mjs`.

## Demo mode

Open `http://localhost:8080/` after `npm run dev:web`. No worker is needed.

- `/?demo#/stop/1011`: simulated arrivals for every stop.
- `?demo=nosvc`: no service. `?demo=error`: upstream error. `?demo=stale`: answers 90 s old, so LIVE tiles age.
- `?setup` previews the first-run setup, `?welcome` the testers' welcome. Neither changes the stored flags.
- `?boot` shows the boot screen on any hash; `?boot=hold` keeps its last frame until a tap (`?boot&setup`, `?boot&welcome` show the order).
- `?debug` exposes `window.__app`.

## Screenshots

`npm run shots` takes key screens in `?demo` with the smoke-test mocks, so it checks layout only. Map tiles are blocked (the map area is empty), fonts are the computer's, and touch feel, push, install, GPS and speed still need a real phone (see `CLAUDE.md`).

Flags: `--device="iPhone SE,Pixel 7"`, `--lang=el|en`, `--theme=light|dark`, `--screen=stop,settings`, `--base=<preview URL>`, `--web=<other checkout>/web`, `--chromium=<path>` (or env `CHROMIUM_PATH`). Output goes to `shots/` with `SUMMARY.md`. All combinations take about 6 minutes. The `setup` and `boot` (held on its last frame) screens are included.

`npm run shots -- --annotate` makes a numbered UI map for reviews: each element has a permanent ID and a nick from `scripts/ui-map.mjs`, output in `shots/ui-map/` with `LEGEND.md` and `explorer.html` (click an element to see its name). Its rules are in `docs/DESIGN.md` section 9.

## Claude desktop browser pane

The pane sometimes registers the service worker and serves old files. Unregister it and run `caches.delete` first. Screenshots fail when the pane is not visible, so use DOM checks.
