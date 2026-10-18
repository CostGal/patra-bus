# Glossary

Technical words used in this project, in plain language. Add new terms in alphabetical order.
"My words:" is for you: rewrite the entry in your own words. If you can't, that term goes to [LEARNING.md](LEARNING.md).

**Alarm** (Durable Object alarm): a wake-up call a program sets for itself, like an alarm clock that starts the code at an exact time.
Where it shows up in Telematica: push reminders and routines fire at their time this way (`worker/src/reminders.js`, `routines.js`).
My words:

**API**: a menu of requests one program can make to another, like ordering from a restaurant menu without entering the kitchen.
Where it shows up in Telematica: citybus.gr's API gives bus data; our Worker offers its own API to the app (`worker/src/index.js`).
My words:

**API token**: a secret pass that proves "I'm allowed to ask", like a visitor badge that expires.
Where it shows up in Telematica: the Worker gets the citybus token from their web page and keeps it in KV (`getToken` in `worker/src/index.js`). It must never be in the browser or in git.
My words:

**Bounding box** (bbox): a rectangle drawn on the map by four numbers (west, east, south, north limit), like the outline you would draw around a city to ask "is this point inside?".
Where it shows up in Telematica: `bbox` of each city in `web/js/cities.js`, checked by `cityAt` in `web/js/city-detect.js`.
My words:

**Branch**: your own copy-line of the project where you try changes without disturbing the main version, like a draft next to the final document.
Where it shows up in Telematica: every task gets `<name>/TEL-<id>-<slug>`; `main` is protected (see `CLAUDE.md`).
My words:

**Cache**: a saved copy of an answer so you don't have to ask again, like keeping the bus timetable on the fridge.
Where it shows up in Telematica: the Worker keeps each stop's live answer for 15 s; the phone keeps app files offline (`worker/src/index.js`, `web/sw.js`).
My words:

**CI** (continuous integration): a robot that runs the tests automatically on every proposed change, like a spell-checker that runs before anything is published.
Where it shows up in Telematica: GitHub Actions in `.github/workflows/` (tests, Lighthouse, Pages).
My words:

**Cloudflare Worker**: a small program that runs on Cloudflare's computers around the world, so we don't need our own server; like a shop clerk who works at the counter for us.
Where it shows up in Telematica: the `patra-bus` Worker in `worker/` is the go-between for the app and citybus.gr.
My words:

**CORS**: a browser rule about which websites may read answers from another website, like a doorman with a guest list.
Where it shows up in Telematica: `ALLOWED_ORIGIN` in `worker/wrangler.toml` and `worker/src/origin.js` list the sites allowed to call our Worker.
My words:

**Device emulation**: a desktop browser pretending to be a phone by copying its screen size, pixel density and touch behaviour, like trying on a costume. It matches the layout, not the real hardware.
Where it shows up in Telematica: `scripts/shots.mjs` uses Playwright's device list (iPhone SE, iPhone 15, Pixel 7, iPad Mini); touch feel, push, GPS and speed still need a real phone.
My words:

**Durable Object**: a small box of memory on Cloudflare that has an ID and can wake itself up later, like a labelled locker with its own alarm clock.
Where it shows up in Telematica: one per push reminder and routine, plus delay stats (`Reminder`, `Routine`, `Stats` in `worker/src/`).
My words:

**ES module**: a JavaScript file that declares what it shares (`export`) and what it borrows (`import`), like a kitchen drawer with a label.
Where it shows up in Telematica: all of `web/js/` loads as modules directly in the browser, with no build step.
My words:

**Fixture**: saved sample data used in tests, like a photo of a situation you can replay anytime.
Where it shows up in Telematica: recorded citybus.gr answers in `tests/e2e/fixtures/` and `web/fixtures/` so tests never use the network.
My words:

**Geocoding**: turning a place name into map coordinates, like looking up an address in a phone book.
Where it shows up in Telematica: place search with Photon in `web/js/geocode.js`.
My words:

**GitHub Pages**: free hosting for a website's files straight from a GitHub repo, like a noticeboard that always shows the latest posted sheet.
Where it shows up in Telematica: it serves the `web/` folder at costgal.github.io/patra-bus (`.github/workflows/pages.yml`).
My words:

**Hash router**: showing different screens depending on the part of the address after `#`, like page tabs in one book.
Where it shows up in Telematica: `#/stop/1011`, `#/plan`, `#/settings` (`web/js/app.js`, `route.js`).
My words:

**Headless browser**: a real browser that runs without a visible window, so a script can open pages and take screenshots, like a robot using the browser for you.
Where it shows up in Telematica: Playwright runs Chromium this way for the smoke tests and for `npm run shots`.
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

**JWT** (JSON Web Token): a signed pass with an expiry time written inside, like a concert wristband with a printed date.
Where it shows up in Telematica: the citybus token is a JWT valid 48 h; the Worker reads its expiry (`jwtExp` in `worker/src/index.js`).
My words:

**KV** (key-value store): a giant list of labels and values, like a coat-check: hand over a label, get your coat back.
Where it shows up in Telematica: Cloudflare KV holds the citybus tokens and the daily report counter (`worker/wrangler.toml`).
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

**TTL** (time to live): how long a saved item stays valid before it is thrown away, like the expiry date on milk.
Where it shows up in Telematica: 15 s for live answers, 24 h for stops/lines, token life in KV (`worker/src/index.js`).
My words:

**Upstream**: the original source your program depends on, like the river above your mill.
Where it shows up in Telematica: citybus.gr and its REST API.
My words:

**VAPID**: a pair of keys that proves to push services that our server is the one sending a notification, like a signed delivery slip.
Where it shows up in Telematica: `VAPID_PUBLIC_KEY` in `worker/wrangler.toml`, private key as a secret (`worker/src/push.js`).
My words:

**Web Push**: the standard way a server sends a notification to a phone even when the app is closed, like a postal delivery to your door.
Where it shows up in Telematica: `web/js/push.js`, `web/sw-push.js`, `worker/src/push.js`.
My words:

**WebKit**: the browser engine inside Safari and every iPhone browser, like the engine block that all iPhone browsers share.
Where it shows up in Telematica: `npm run shots` can render the app with WebKit to get closer to how it looks on an iPhone.
My words:

**Wrangler**: Cloudflare's command-line tool for running and deploying Workers, like the remote control for our Worker.
Where it shows up in Telematica: `npm run dev:worker`, `npx wrangler deploy --config worker/wrangler.toml`.
My words:
