# Telematica (repo `patra-bus`)

PWA with live city-bus arrivals for **Patras and Corfu**, on top of the citybus.gr API. Its point: it tells **live**
vehicles apart from **scheduled** departures (the official site shows them the same). Frontend: vanilla JS in `web/`.
API: a Cloudflare Worker in `worker/` that proxies and caches citybus.gr, so the token never reaches the browser.
The repo, worker, localStorage key and cache names stay `patra-bus`.

## Team and areas
Three people, each running Claude Code. See who runs this session (`git config user.name`) and work only in that
person's area. If a change needs a file in another area, say so and ask first, or propose a separate card.

| Who (GitHub) | Area | Deploy |
|---|---|---|
| Kostas (`CostGal`) | `web/`, review of every PR, holder of the production secrets | staging; approves production |
| Amarildo (`ksainis2002-coder`) | `worker/`, data scripts (`fetch-static`, `build-routes`, `record-fixtures`), new features | staging, never production |
| Fanis (`fanistsob2001`) | `.github/`, `tests/e2e/` infrastructure, `.claude/` (skills, mods), feedback and metrics | staging, never production |

Kostas is code owner of everything (`.github/CODEOWNERS`). Four `web/js` files are also imported by the worker
(`arrivals.js`, `cities.js`, `report.js`, `notif-link.js`): a merge that changes them (or `route.js`, which the deploy
workflow also watches) redeploys the worker, so a change to them touches Amarildo's area as well as Kostas's.

## Hard rules
Code and docs cite these by number ("CLAUDE.md rule 4"), so the numbers stay as they are.
1. **`main` is protected.** No push to `main`; everything lands by PR. Only Kostas merges. Claude merges only in
   Kostas's own session, when he says "merge" in chat for that PR and its checks have passed. In any other session, never.
2. **One branch per card:** `<who>/TEL-<id>-<slug>`, inside this repo (no fork). `<who>` writes the code: `claude`,
   `kostas`, `amarildo` or `fanis` (e.g. `claude/TEL-210-stats-cache`). The id comes from the Notion card: no card, no branch.
3. **Every text the user sees exists in Greek and English.** Greek is the key in `t()`/`tn()`/`N_()` (`web/js/i18n.js`);
   English goes in `web/js/i18n-en.js` or `i18n-en-<feature>.js`. `npm run check:i18n` must pass.
4. **No analytics, telemetry or tracking:** no third-party scripts, no fingerprinting, no beacons. Diagnostics leave the
   device only through the «Αναφορά προβλήματος» form, when the user sends it, and only what the form showed them first.
   One exception (Kostas, 2026-10-25): the anonymous daily counters of `worker/src/counters.js`: one number per
   day × metric × city, with no IP, device id, user id or free text. The app sends only `{metric, city}` to
   `POST /api/count`: `open` at most once a day per device and `install` once, the first time it opens as an installed
   app; nothing when the user switched it off in Settings or the browser sends Global Privacy Control. Previews and
   localhost are not counted. `feedback` is counted by the worker itself; `push` is reserved and nothing records it.
   Only Kostas sees the totals (`/stats` on the worker, secret `STATS_TOKEN`). A new metric or field needs this rule
   updated first.
5. **Attributions stay visible:** OpenFreeMap / © OpenStreetMap, OSRM / FOSSGIS, Photon / komoot and citybus.gr in
   Settings (`settings-view.js`), and the map's own credit on the map (`AttributionControl` in `map.js`).
6. **The user's location stays on the device.** It is not sent to our worker, not stored (localStorage holds only the
   flag `patra-bus:loc-granted`), and not put in an app URL, share link, reminder or report. Two exceptions, both
   requests straight from the browser to a third party: **OSRM** (`walk.js`: the "near you" card and the stop's "Οδηγίες ως εδώ" pill) gets the start and end
   of a walk at 5 decimals (~1 m); **Photon** (`geocode.js`) gets a `lat`/`lon` bias rounded to 2 decimals (~1 km).
   A new location flow to anyone needs this rule updated first.
7. **No secrets in commits, PRs, issues or comments:** the citybus token, `NOTION_TOKEN`, `NOTION_DB_ID`,
   `VAPID_PRIVATE_KEY`, `STATS_TOKEN`. They live as Cloudflare secrets and, locally, in `worker/.dev.vars`
   (gitignored); not in `.dev.vars.example` either.
8. **Every PR follows `.github/pull_request_template.md`** (task id, what changed, phone screenshots, how it was
   checked) and needs the required checks `test` (CI) and `merge-window`. What they do: `docs/CI-AND-DEPLOY.md`.
9. **Every check on a real phone becomes an issue** with the label `device-test`, so Kostas can run them together.
   Whatever cannot be checked locally or in `?demo` (install, GPS/compass, look and motion on the device,
   iPhone/Android) does not stay as a PR checkbox: one issue per group of checks, with prerequisites, steps with URLs,
   the expected result as a checklist, devices, cleanup and the PR link. List: `gh issue list --label device-test`.
10. **Every UI change follows `docs/UI-PROTOCOL.md`** (rules U1…): the PR shows its checklist or says which exception it
   makes and why. If a proposal breaks a rule, say which one (e.g. "breaks U4"). The bypass is for Kostas only ("UI
   bypass" → branch `kostas/ui-exp-*`, label `ui-experiment`, never merged as is). A new rule needs Kostas's approval.

## Also binding
- **Worker deploys** go only through GitHub → Actions → «Worker deploy»: staging from any branch, production only from
  `main` with Kostas's approval. No `wrangler deploy` from a computer, not even for staging.
- **citybus.gr:** only the three endpoints in `docs/UPSTREAM-API.md` (`/stops`, `/lines`, `/stops/live/{code}`); no
  probing of other URLs. Live is not polled faster than every 15 s per stop (the frontend polls every 20 s, only
  while the page is visible). The API is unofficial and they can block us.
- **Codes are strings** (stop, line, route), with possible leading zeros (`093` ≠ `93`): no conversion to numbers.
  Coordinates `0/0` mean "scheduled" and are not shown or used anywhere.
- **Names:** Title Case for display only; accents come only from the curated dictionary `web/js/accents.js`, never guessed.
- **Frontend stays simple:** vanilla JS ES modules, no build step, no framework. Paths in `web/` are relative (the site
  is served from `/patra-bus/`). A new file in `web/` goes into the SHELL list of `web/sw.js`; `CACHE` there is stamped
  at deploy, so don't bump it by hand. The service worker caches nothing from `/api/` or other origins, except
  OpenFreeMap map assets.
- **Anything the user touches** follows `docs/DESIGN.md`.

## How to work
- Plan first: a short plan in plain words, then wait for the OK before editing. One card = one branch = one PR; if the
  work grows past ~3 files or mixes two topics, say so and propose a split.
- Few words. After a change say only: what changed, what to check in the app, the preview link. Details go in the PR
  or the card. Don't watch or comment on CI and GitHub notifications; the person checks and tells you.
- Every commit and PR carries three lines: what changed, why, how it could break.
- What you notice along the way is a finding: note it and make cards at the end; don't fix it in passing.
- Steps for the person come one at a time; wait for the answer. Full rules, Notion and the skills (`/plan-week`,
  `/task TEL-<id>`, `/quick-task`): `docs/WORKFLOW.md`.
- New technical terms go in `docs/GLOSSARY.md`. When how the parts connect changes, update `docs/ARCHITECTURE.md`.

## Commands
```
npm install
npm test               # unit tests + Playwright smoke tests (what CI runs)
npm run check:i18n     # every Greek string has its English
npm run dev:web        # static server for web/ on :8080
npm run dev:worker     # the worker locally on :8787
npm run fetch-static   # refresh web/data (stops, lines), then rebuild routes
npm run shots          # screenshots of every screen
```
App: http://localhost:8080/ · demo without the worker: http://localhost:8080/?demo#/stop/1011 (test stop **1011**
`ΠΑΝΕΠΙΣΤΗΜΙΟΥ & ΑΡΕΘΑ`, lines 201, 606, 609). Both dev servers are in `.claude/launch.json` (`web`, `worker`).

## Where to read
None of these is loaded automatically: open the one for your topic before you start.
- How the parts connect, where data lives: `docs/ARCHITECTURE.md`
- Frontend (views, modules, storage on the device, service worker, i18n files): `docs/FRONTEND.md`
- Worker (routes, caching, KV, Durable Objects, counters, reports, secrets): `docs/WORKER.md`
- citybus.gr API facts, before touching `worker/`, `scripts/fetch-static.mjs`, `scripts/record-fixtures.mjs` or
  `web/js/arrivals.js`: `docs/UPSTREAM-API.md`
- Cities (Patras, Corfu, adding one): `docs/MULTI-CITY.md`
- Motion, materials, glass, the numbered UI map for reviews: `docs/DESIGN.md`; the UI rules and their checks: `docs/UI-PROTOCOL.md`
- Tests, fixtures, `?demo` modes, screenshots: `docs/TESTING.md`
- CI, merge window, Pages, PR previews, staging and production deploys: `docs/CI-AND-DEPLOY.md`
- First-time setup, local worker, who holds which secret: `CONTRIBUTING.md`
- Notion list, Blocks, sessions and skills: `docs/WORKFLOW.md`
- Terms in plain language: `docs/GLOSSARY.md` (Kostas's study list: `docs/LEARNING.md`)
