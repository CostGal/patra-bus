# Glossary

Technical words used in this project, in plain language. Add new terms in alphabetical order.
"My words:" is for you: rewrite the entry in your own words. If you can't, that term goes to [LEARNING.md](LEARNING.md).

**ADR** (architecture decision record): a one-page note of one decision: what we chose, why, and what it changes, like the minutes of a meeting about a single question.
Where it shows up in Telematica: proposed in Amarildo's Moovit handoff (`/docs/decisions/`); not adopted yet, a finding of TEL-135.
My words:

**Alarm** (Durable Object alarm): a wake-up call a program sets for itself, like an alarm clock that starts the code at an exact time.
Where it shows up in Telematica: push reminders and routines fire at their time this way (`worker/src/reminders.js`, `routines.js`).
My words:

**All rights reserved**: the default legal state of a piece of work: people may look at it, but copying or using it needs the owner's permission, like a library book you can read but not photocopy and sell.
Where it shows up in Telematica: the repo has no license file, so the code is "all rights reserved"; the founders' proposal (TEL-1) keeps it that way until a lawyer helps decide.
My words:

**API**: a menu of requests one program can make to another, like ordering from a restaurant menu without entering the kitchen.
Where it shows up in Telematica: citybus.gr's API gives bus data; our Worker offers its own API to the app (`worker/src/index.js`).
My words:

**API token**: a secret pass that proves "I'm allowed to ask", like a visitor badge that expires.
Where it shows up in Telematica: the Worker gets the citybus token from their web page and keeps it in KV (`getToken` in `worker/src/index.js`). It must never be in the browser or in git.
My words:

**Benchmark**: the same small task, timed and counted on every app, like timing two runners on the same track.
Where it shows up in Telematica: TEL-135 runs 12 tasks (e.g. "next bus at stop 1011") on Moovit, Google Maps and our app; results in Notion.
My words:

**Bounding box** (bbox): a rectangle on the map given by four edges (west, south, east, north), like the frame you draw in pencil around a city on a paper map.
Where it shows up in Telematica: each city's area in `web/js/cities.js`; `inArea()` in `geo.js` checks a point against it, e.g. to drop a live bus position that lands outside the city (`api.js`); `cityAt()` in `web/js/city-detect.js` uses the boxes to tell which city the user is in (TEL-142).
My words:

**Branch**: your own copy-line of the project where you try changes without disturbing the main version, like a draft next to the final document.
Where it shows up in Telematica: every task gets `<name>/TEL-<id>-<slug>`; `main` is protected (see `CLAUDE.md`).
My words:

**Cache**: a saved copy of an answer so you don't have to ask again, like keeping the bus timetable on the fridge.
Where it shows up in Telematica: the Worker keeps each stop's live answer for 15 s; the phone keeps app files offline (`worker/src/index.js`, `web/sw.js`).
My words:

**Checkout**: a folder on your computer holding a working copy of the project files at one branch, like a photocopy of a book you can scribble on without touching the original. The command `git checkout` is the other meaning: it switches which branch that folder shows.
Where it shows up in Telematica: `C:\dev\patra-bus` is the main checkout; each Claude task works in its own extra one (see Worktree).
My words:

**CI** (continuous integration): a robot that runs the tests automatically on every proposed change, like a spell-checker that runs before anything is published.
Where it shows up in Telematica: GitHub Actions in `.github/workflows/` (tests, Lighthouse, Pages).
My words:

**Clean-room**: learning how a rival product works only by using it and reading public sources, never from its code or private data, like working out a recipe by tasting the dish instead of stealing the chef's notebook.
Where it shows up in Telematica: the rule for all competitor research (TEL-135): no Moovit code, images, keys, endpoints or data in our app or repo.
My words:

**Cliff** (in vesting): a starting hurdle: if you leave before it, you keep nothing; after it, a first chunk unlocks at once, like a gym deal that only starts counting after the first full year.
Where it shows up in Telematica: the founders' proposal (TEL-1) suggests a 12-month cliff inside a 4-year vesting.
My words:

**Cloudflare Worker**: a small program that runs on Cloudflare's computers around the world, so we don't need our own server; like a shop clerk who works at the counter for us.
Where it shows up in Telematica: the `patra-bus` Worker in `worker/` is the go-between for the app and citybus.gr.
My words:

**Copyleft**: a kind of license (GPL, AGPL) that lets anyone use your code but requires their own work built on it to be shared openly too, like a recipe you may cook from only if you publish your own recipe as well.
Where it shows up in Telematica: not used; it is one of the options compared in the founders' proposal (TEL-1).
My words:

**CORS**: a browser rule about which websites may read answers from another website, like a doorman with a guest list.
Where it shows up in Telematica: `ALLOWED_ORIGIN` in `worker/wrangler.toml` and `worker/src/origin.js` list the sites allowed to call our Worker.
My words:

**Deduplication**: finding two entries that are really the same thing and keeping only one, like crossing out a name written twice on a guest list.
Where it shows up in Telematica: a scheduled row that is the same bus as a live row is dropped, so only the live one shows (`dropScheduledDuplicates` in `web/js/arrivals.js`).
My words:

**Device emulation**: a desktop browser pretending to be a phone by copying its screen size, pixel density and touch behaviour, like trying on a costume. It matches the layout, not the real hardware.
Where it shows up in Telematica: `scripts/shots.mjs` uses Playwright's device list (iPhone SE, iPhone 15, Pixel 7, iPad Mini); touch feel, push, GPS and speed still need a real phone.
My words:

**Displacement map**: a picture whose colours tell a filter how far to shift each pixel of what lies behind, like looking through the thick rim of a glass. Browsers can use one inside `backdrop-filter` only in Chrome-based browsers, not Safari.
Where it shows up in Telematica: the lens bend at the edges of the glass prototype (`?glass`, `web/js/glass.js`, TEL-83).
My words:

**Durable Object**: a small box of memory on Cloudflare that has an ID and can wake itself up later, like a labelled locker with its own alarm clock.
Where it shows up in Telematica: one per push reminder and routine, plus delay stats (`Reminder`, `Routine`, `Stats` in `worker/src/`).
My words:

**ES module**: a JavaScript file that declares what it shares (`export`) and what it borrows (`import`), like a kitchen drawer with a label.
Where it shows up in Telematica: all of `web/js/` loads as modules directly in the browser, with no build step.
My words:

**Fallback**: a second way to do something when the first way doesn't work, like taking the stairs when the lift is broken.
Where it shows up in Telematica: the same-bus check tries `vehicleCode` first, then same line + arrival within 60 s (`web/js/arrivals.js`).
My words:

**Fixture**: saved sample data used in tests, like a photo of a situation you can replay anytime.
Where it shows up in Telematica: recorded citybus.gr answers in `tests/e2e/fixtures/` and `web/fixtures/` so tests never use the network.
My words:

**Gentlemen's agreement**: a promise made on trust, with no legal force, like shaking hands on a deal.
Where it shows up in Telematica: the temporary founders' arrangement between Kostas, Fanis and Amarildo until a lawyer writes a real agreement (TEL-1).
My words:

**Geocoding**: turning a place name into map coordinates, like looking up an address in a phone book.
Where it shows up in Telematica: place search with Photon in `web/js/geocode.js`.
My words:

**GitHub Pages**: free hosting for a website's files straight from a GitHub repo, like a noticeboard that always shows the latest posted sheet.
Where it shows up in Telematica: it serves the `web/` folder at costgal.github.io/patra-bus (`.github/workflows/pages.yml`).
My words:

**GITHUB_TOKEN**: a temporary key GitHub hands to each Action run, which opens only what the workflow's `permissions:` list allows, like a one-day visitor pass limited to certain rooms.
Where it shows up in Telematica: `.github/workflows/watch-same-bus.yml` uses it (permission `issues: write`) to comment on the watch issue; nothing is stored.
My words:

**Glassmorphism** (backdrop blur): a see-through panel that blurs whatever lies behind it, like frosted glass in front of the map. The blur costs work from the phone's graphics chip, more so on cheap Android phones.
Where it shows up in Telematica: the floating search bar and bottom sheet (`.material` in `app.css`); the fuller look is tested with `?glass` (TEL-83, `css/glass.css`).
My words:

**Hash router**: showing different screens depending on the part of the address after `#`, like page tabs in one book.
Where it shows up in Telematica: `#/stop/1011`, `#/plan`, `#/settings` (`web/js/app.js`, `route.js`).
My words:

**Headless browser**: a real browser that runs without a visible window, so a script can open pages and take screenshots, like a robot using the browser for you.
Where it shows up in Telematica: Playwright runs Chromium this way for the smoke tests and for `npm run shots`.
My words:

**Health check**: a small address a service answers with "I'm alive, and this is my state", like a nurse who takes your pulse before the doctor comes in.
Where it shows up in Telematica: `GET /health` of the Worker (`worker/src/index.js`) returns `ok`, the time and `tokenExp` per city.
My words:

**Honeypot**: a hidden form field that humans never fill but spam robots do, like a bowl of candy that only thieves reach for.
Where it shows up in Telematica: the `hp` field in the problem report (`web/js/report.js`, `worker/src/report.js`).
My words:

**Hook** (SessionStart hook): a command Claude Code runs by itself at a fixed moment, like a checklist taped inside the project folder that gets done every time the folder is opened.
Where it shows up in Telematica: `.claude/settings.json` runs `scripts/cloud-session-start.mjs` when a session starts; in a cloud session it installs packages and Chromium, locally it does nothing.
My words:

**i18n** (internationalisation): preparing an app so text can be shown in several languages, like menus printed in two languages.
Where it shows up in Telematica: Greek text is the key, English lives in `web/js/i18n-en*.js`; `npm run check:i18n` checks it.
My words:

**IKE** (Ιδιωτική Κεφαλαιουχική Εταιρεία, a Greek private limited company): a company type where the owners risk only what they put in, like a fence around their personal savings.
Where it shows up in Telematica: the likely permanent legal form for the software company (TEL-1); nothing is registered yet.
My words:

**JWT** (JSON Web Token): a signed pass with an expiry time written inside, like a concert wristband with a printed date.
Where it shows up in Telematica: the citybus token is a JWT valid 48 h; the Worker reads its expiry (`jwtExp` in `worker/src/index.js`).
My words:

**KV** (key-value store): a giant list of labels and values, like a coat-check: hand over a label, get your coat back.
Where it shows up in Telematica: Cloudflare KV holds the citybus tokens and the daily report counter (`worker/wrangler.toml`).
My words:

**Leaver** (good leaver / bad leaver): someone who leaves the company. A good leaver keeps what they already earned; a bad leaver loses part of it, like leaving a job with notice versus walking out mid-shift.
Where it shows up in Telematica: the founders' proposal (TEL-1) defines both cases for vesting.
My words:

**License**: a text that tells everyone what they may do with your code, like a sign in a park ("you may walk", "no picking flowers"). Permissive licenses (MIT, Apache-2.0) allow almost anything; copyleft ones (GPL) require sharing back; with no license, nobody has permission.
Where it shows up in Telematica: the repo has none; MapLibre, OpenFreeMap and the other third-party parts keep their own licenses and credits.
My words:

**localStorage**: a small notebook the browser keeps on your device for a website, like a sticky note only you can read.
Where it shows up in Telematica: favourites, settings, places and routines in `patra-bus:v2` (`web/js/store.js`).
My words:

**Manifest** (web app manifest): an ID card that tells the phone the app's name, icon and colours so it can be installed, like a name tag.
Where it shows up in Telematica: `web/manifest.webmanifest`.
My words:

**MapLibre GL**: a free code library that draws interactive maps, like a drawing kit that already knows how to draw roads.
Where it shows up in Telematica: `web/js/map.js`, with the library stored in `web/vendor/maplibre-gl/`.
My words:

**Mod** (Claude Code plugin): a small add-on that changes how Claude Code itself looks or behaves, like a phone case with a pocket for your cards.
Where it shows up in Telematica: `.claude/skills/tel-sprint/` draws the «Sprint» pane with your current TEL cards from Notion (`/sprint` refreshes it).
My words:

**OSRM**: a free service that works out walking or driving routes, like asking a local for directions.
Where it shows up in Telematica: walking time to a stop (`web/js/walk.js`), via the FOSSGIS server.
My words:

**Parity matrix** (feature matrix): a table with features down the side and "them vs us" across, like the spec sheets of two phones side by side.
Where it shows up in Telematica: TEL-135 compares 40+ Moovit features with ours and marks each one Learn, Beat or Skip (in Notion).
My words:

**Playwright**: a tool that opens a real browser by itself and clicks through the app, like a robot tester.
Where it shows up in Telematica: smoke tests in `tests/e2e/` (`npm run test:e2e`).
My words:

**Preview deploy**: a temporary copy of the site for one proposed change, so you can try it before it is merged, like a fitting room.
Where it shows up in Telematica: Cloudflare Workers Builds gives each PR its own address (project `patra-bus-dev`, `wrangler.jsonc`).
My words:

**Proxy**: a middleman that asks for you and passes the answer back, like a personal assistant who makes the phone call.
Where it shows up in Telematica: the Worker is a proxy in front of citybus.gr so the token never reaches the phone.
My words:

**Pull request (PR)**: a request to merge your branch into `main`, with room for others to review it, like handing in a draft for a teacher's comments.
Where it shows up in Telematica: `.github/pull_request_template.md`; only Kostas merges.
My words:

**Push subscription**: the address of one phone's notification inbox, which a server uses to send it a message, like a postal address for notifications.
Where it shows up in Telematica: the phone gives it to the Worker when booking a reminder (`web/js/push.js`, `worker/src/reminders.js`).
My words:

**PWA** (progressive web app): a website that can be installed and work like an app, even partly offline, like a bookmark with superpowers.
Where it shows up in Telematica: the whole `web/` folder (`manifest.webmanifest`, `sw.js`).
My words:

**Rate limit**: a cap on how many requests are allowed in a time window, like "one coffee per person per minute".
Where it shows up in Telematica: 15 s minimum between live requests per stop; per-IP limits on reminders and reports (`worker/src/index.js`).
My words:

**Scheduled workflow** (cron): a GitHub Action that starts by itself on a timetable, like an alarm clock that rings every 30 minutes. It only runs from the `main` branch.
Where it shows up in Telematica: `.github/workflows/watch-same-bus.yml` (`schedule:` with `cron: '7,37 5-17 * * *'`).
My words:

**Secret** (Cloudflare secret): a private value stored on the server and hidden from the code in git, like a safe's combination.
Where it shows up in Telematica: `VAPID_PRIVATE_KEY`, `NOTION_TOKEN`, `NOTION_DB_ID`; locally in `worker/.dev.vars` (ignored by git).
My words:

**Service worker**: a helper script the browser runs in the background for a site, like a doorman who answers for you when you're out.
Where it shows up in Telematica: `web/sw.js` keeps the app working offline; `web/sw-push.js` shows notifications.
My words:

**Skill** (slash command): a saved set of instructions Claude Code loads when you type its name, like a recipe card you hand the cook.
Where it shows up in Telematica: `/plan-week` and `/task TEL-<id>` in `.claude/skills/`, both following `docs/WORKFLOW.md`.
My words:

**SQLite**: a tiny database stored in a single file, like a spreadsheet with strict columns.
Where it shows up in Telematica: the storage inside each Durable Object (`new_sqlite_classes` in `worker/wrangler.toml`).
My words:

**Teardown**: a careful study of a rival product from the outside, screen by screen, like a mechanic looking over a competitor's car without opening the engine.
Where it shows up in Telematica: Amarildo's Moovit teardown and the TEL-135 study (notes in Notion, never in the public repo).
My words:

**Toast**: a small message that slides in at the bottom of the screen for a few seconds and then disappears by itself, like a sticky note that falls off on its own.
Where it shows up in Telematica: `toast()` in `web/js/ui.js`, e.g. "Back online" or the "Switch city?" offer (TEL-142).
My words:

**tokenExp**: the moment the saved citybus token stops working, like the expiry date printed on a visitor badge.
Where it shows up in Telematica: `/health` returns it per city, read from the KV key `token/{city}`; it is `null` when no token is saved (`worker/src/index.js`).
My words:

**TTL** (time to live): how long a saved item stays valid before it is thrown away, like the expiry date on milk.
Where it shows up in Telematica: 15 s for live answers, 24 h for stops/lines, token life in KV (`worker/src/index.js`).
My words:

**Upstream**: the original source your program depends on, like the river above your mill.
Where it shows up in Telematica: citybus.gr and its REST API.
My words:

**VAPID**: a pair of keys that proves to push services that our server is the one sending a notification, like a signed delivery slip.
Where it shows up in Telematica: `VAPID_PUBLIC_KEY` in `worker/wrangler.toml`, private key as a secret (`worker/src/push.js`).
My words:

**vehicleCode**: the ID of one bus trip that citybus.gr sends with each arrival, like a booking number.
Where it shows up in Telematica: it links a bus across stops and views (`#/bus/…`, onboard alerts) and decides whether a live and a scheduled row are the same bus (`web/js/arrivals.js`).
My words:

**Vesting**: earning your share of a company step by step over time, instead of owning it all on day one, like getting the office key a month at a time.
Where it shows up in Telematica: the founders' proposal (TEL-1) suggests 4 years with a 12-month cliff for Fanis and Amarildo.
My words:

**Web Push**: the standard way a server sends a notification to a phone even when the app is closed, like a postal delivery to your door.
Where it shows up in Telematica: `web/js/push.js`, `web/sw-push.js`, `worker/src/push.js`.
My words:

**WebKit**: the browser engine inside Safari and every iPhone browser, like the engine block that all iPhone browsers share.
Where it shows up in Telematica: `npm run shots` can render the app with WebKit to get closer to how it looks on an iPhone.
My words:

**Worktree**: a second checkout of the same repo in another folder, on its own branch, like a second desk with its own copy of the file while both desks share one archive.
Where it shows up in Telematica: each Claude session works in its own worktree under `.claude/worktrees/`, so tasks never mix.
My words:

**Wrangler**: Cloudflare's command-line tool for running and deploying Workers, like the remote control for our Worker.
Where it shows up in Telematica: `npm run dev:worker`, `npx wrangler deploy --config worker/wrangler.toml`.
My words:
