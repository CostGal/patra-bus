# patra-bus

**Telematica**: PWA με live αφίξεις αστικών λεωφορείων **Πάτρας και Κέρκυρας**, πάνω στο API του citybus.gr
(patra.citybus.gr, corfu.citybus.gr). Repo, worker, localStorage key και ονόματα cache μένουν `patra-bus`.
Βασική αξία: ξεχωρίζει **live** οχήματα από **προγραμματισμένες** αναχωρήσεις (η επίσημη σελίδα τα δείχνει ίδια).

## Αρχιτεκτονική με μια ματιά
- **Frontend**: vanilla JS PWA (ES modules, χωρίς build step και framework) στο `web/`. Το GitHub Pages σερβίρει μόνο το `web/`. Preview ανά PR από Cloudflare Workers Builds (`patra-bus-dev`).
- **API worker** (`worker/`, Cloudflare Worker `patra-bus`): proxy + cache μπροστά στο citybus.gr, ώστε το token να μη φτάνει ποτέ στον browser. KV: `token/{city}` και `report-day/{date}`. Durable Objects (SQLite): `Stats` (ιστορικό καθυστερήσεων ανά διαδρομή/στάση), `Reminder` (push υπενθύμιση), `Routine` (εβδομαδιαία ρουτίνα).
- **Upstream**: REST API του citybus.gr (`rest.citybus.gr`), agency `112` = Πάτρα, `101` = Κέρκυρα (`web/js/cities.js`). Στάσεις/γραμμές/διαδρομές είναι committed στατικά στο `web/data/`.
- **Κοινός κώδικας** worker + frontend: `web/js/arrivals.js` (live/προγρ.), `web/js/report.js`, `web/js/cities.js`.
- **Τρίτοι, χωρίς κλειδί**: χάρτης MapLibre GL (vendored) + OpenFreeMap, περπάτημα OSRM (FOSSGIS), αναζήτηση τόπων Photon (komoot).
- Συμβόλαια modules και ownership: `docs/ARCHITECTURE.md`· κίνηση: `docs/DESIGN.md`· πόλεις: `docs/MULTI-CITY.md`.

## Αυστηροί κανόνες
1. **Ποτέ push στο `main`.** Μόνο μέσω PR· το `main` είναι protected και μόνο ο Kostas κάνει merge.
2. Branch ανά εργασία: `<όνομα>/TEL-<id>-<slug>` (π.χ. `kostas/TEL-12-repo-workflow`), μέσα στο repo, όχι fork.
3. Κάθε κείμενο που βλέπει ο χρήστης υπάρχει σε **ελληνικά και αγγλικά**: το ελληνικό είναι το key στα `t()`/`tn()`/`N_()` (`web/js/i18n.js`), το αγγλικό στο `web/js/i18n-en.js` ή στο `i18n-en-<feature>.js`. Το `npm run check:i18n` (`scripts/check-i18n.mjs`, τρέχει στο CI) πρέπει να περνά.
4. **Κανένα analytics, telemetry ή tracking**: ούτε scripts τρίτων, ούτε fingerprinting, ούτε beacons. Διαγνωστικά στέλνει μόνο η φόρμα «Αναφορά προβλήματος», όταν τη στείλει ο χρήστης, και μόνο όσα του εμφανίζονται πριν την αποστολή. **Μόνη εξαίρεση** (απόφαση Kostas, 2026-10-25): οι ανώνυμοι ημερήσιοι μετρητές του `worker/src/counters.js` (ένας αριθμός ανά ημέρα × μέτρηση × πόλη, χωρίς IP, id συσκευής ή χρήστη, χωρίς ελεύθερο κείμενο). Η εφαρμογή στέλνει στο `POST /api/count` μόνο `{metric, city}`: `open` το πολύ μία φορά την ημέρα ανά συσκευή και `install` μία φορά, την πρώτη φορά που ανοίγει ως εγκατεστημένη· τίποτα όταν ο χρήστης το έκλεισε στις Ρυθμίσεις ή ο browser στέλνει Global Privacy Control. Previews και localhost δεν μετρώνται. Τα `feedback`/`push` τα μετρά μόνο ο worker. Τα βλέπει μόνο ο Kostas στο `/stats` του worker (secret `STATS_TOKEN`). Νέα μέτρηση ή νέο πεδίο δεν μπαίνει χωρίς να ενημερωθεί αυτός ο κανόνας.
5. Τα attributions (OpenFreeMap / © OpenStreetMap, OSRM / FOSSGIS, Photon / komoot, citybus.gr) μένουν ορατά στις Ρυθμίσεις (`settings-view.js`) και στον χάρτη (`AttributionControl` στο `map.js`). Ποτέ αφαίρεση.
6. **Η θέση του χρήστη μένει στη συσκευή**: δεν στέλνεται ποτέ στον worker μας, δεν αποθηκεύεται (στο localStorage μπαίνει μόνο το flag `patra-bus:loc-granted`), δεν μπαίνει σε URL της εφαρμογής, share link, υπενθύμιση/ρουτίνα ή αναφορά. Μόνες εξαιρέσεις, αιτήματα κατευθείαν από τον browser σε τρίτους: το **OSRM** (`walk.js`, κάρτα «κοντά σου» και planner) παίρνει αφετηρία/προορισμό περπατήματος με 5 δεκαδικά (~1 μ), και το **Photon** (`geocode.js`) παίρνει bias `lat`/`lon` στρογγυλεμένο σε 2 δεκαδικά (~1 χλμ). Νέα ροή θέσης προς οποιονδήποτε δεν μπαίνει χωρίς να ενημερωθεί αυτός ο κανόνας.
7. **Ποτέ secrets σε commit**: citybus token, `NOTION_TOKEN`, `NOTION_DB_ID`, `VAPID_PRIVATE_KEY`, `STATS_TOKEN`. Ζουν μόνο ως Cloudflare secrets και τοπικά στο `worker/.dev.vars` (στο `.gitignore`).
8. Κάθε PR ακολουθεί το `.github/pull_request_template.md` (task ID, τι άλλαξε, screenshots από κινητό, πώς ελέγχθηκε). Το CI τρέχει `npm test` (unit + Playwright smoke) + `npm run check:i18n` (required check `test`) και Lighthouse (performance, accessibility, PWA), που σχολιάζει τα scores στο PR.
9. **Κάθε έλεγχος σε πραγματικό κινητό γίνεται issue**, ώστε ο Kostas να τους κάνει όλους μαζί: ό,τι δεν ελέγχεται τοπικά/στο `?demo` (push και tap ειδοποίησης, εγκατάσταση, GPS/πυξίδα, εμφάνιση και κίνηση στη συσκευή, iPhone/Android) δεν μένει μόνο ως checkbox ή σημείωση στο PR. Ανοίγει GitHub issue με label `device-test` (και/ή task στο Notion), ένα ανά ομάδα ελέγχων, με: προαπαιτούμενα (merge, deploy worker, ρυθμίσεις), βήματα με URL, αναμενόμενο αποτέλεσμα ως checklist, συσκευές, cleanup και link στο PR. Το PR τα γράφει στο «Πώς ελέγχθηκε». Λίστα: `gh issue list --label device-test`.

## Εντολές
```
npm install
npm run fetch-static     # ανανεώνει web/data/stops.json + lines.json και μετά τρέχει build-routes (committed)
npm run build-routes     # routes.json + shapes.json από stops/lines + OSRM (cache στο scripts/.cache/)
npm test                 # test:unit + test:e2e (αυτό τρέχει το CI)
npm run test:unit        # node --test tests/*.test.mjs
npm run test:e2e         # Playwright smoke tests (tests/e2e/)· πρώτη φορά: npx playwright install chromium
npm run record-fixtures  # ξαναγράφει τα fixtures των smoke tests από το citybus.gr (βλ. Smoke tests)
npm run dev:worker       # wrangler dev --local στο :8787 (local KV)
npx wrangler deploy --config worker/wrangler.toml   # deploy του worker στο Cloudflare
npm run dev:web          # static server του web/ στο :8080, χωρίς HTTP cache
npm run shots            # screenshots (?demo, mocks) για συσκευές × light/dark × EL/EN στο shots/ + SUMMARY.md· `-- --device= --lang= --theme= --screen= --base=<preview URL> --web=<web/ άλλου checkout> --chromium=<path> --glass (?glass) --map (αφήνει μόνο το OpenFreeMap, για να φαίνεται ο χάρτης πίσω από το glass)`· ~6′ για όλα, μόνο layout (όχι αφή/push/GPS/απόδοση)
npm run shots -- --annotate   # αριθμημένος χάρτης UI για reviews (TEL-198): κάθε στοιχείο με μόνιμο ID ανά περιοχή (`scripts/ui-map.mjs`) → shots/ui-map/ + LEGEND.md· κανόνες στο docs/DESIGN.md §9
```
Άνοιγμα: http://localhost:8080/ · demo (προσομοίωση για όλες τις στάσεις): http://localhost:8080/?demo#/stop/1011 · `?demo=nosvc`, `?demo=error`, `?demo=stale` (δεδομένα 90″ παλιά: τα LIVE tiles «γερνούν») για τις αντίστοιχες καταστάσεις. `?glass` = πρωτότυπο glass UI (TEL-83, `css/glass.css` + `js/glass.js`: refraction μόνο σε Chromium, touch & hold σε ό,τι πατιέται: μεγαλώνει (τα στρογγυλά κουμπιά περισσότερο και «πάνω» από τα διπλανά), πιο αδιαφανές, ελατήριο στην επιστροφή, χωρίς shine· οι γραμμές λιστών παίρνουν highlight αντί να μεγαλώνουν· το κουμπί θέσης γεμίζει μπλε· το φύλλο έχει 5 στάσεις· μπάρα chips χωρίς λωρίδα, blur μόνο με scroll· μενού που «βγαίνει» από το ☰, που γίνεται ✕· ίδιο morph για ⋯ (→ ˄) και το i του χάρτη· φακός στα chips γραμμών), μόνο όσο είναι στο URL.
Τα δύο dev servers υπάρχουν και στο `.claude/launch.json` (`worker`, `web`).

## GitHub / Pages / Cloudflare
- Repo (public): https://github.com/CostGal/patra-bus
- Site: https://costgal.github.io/patra-bus/. Το `.github/workflows/pages.yml` ανεβάζει **μόνο** το `web/` σε κάθε push στο `main`.
- Το site είναι σε subpath (`/patra-bus/`), οπότε όλα τα paths στο `web/` μένουν **σχετικά** (`./data/…`, `sw.js`, `start_url: "./"`).
- Worker: https://patra-bus.patra-bus.workers.dev (λογαριασμός Cloudflare του kostas.galanis31, `wrangler login`). KV namespace `patra-bus-token`: tokens (`token/{city}`) και ο ημερήσιος μετρητής αναφορών (`report-day/{date}`). Το deploy είναι **χειροκίνητο**: το push στο `main` ανεβάζει μόνο το Pages.
- `ALLOWED_ORIGIN` στο `worker/wrangler.toml`: λίστα με κόμμα (`https://costgal.github.io,http://localhost:8080,https://patra-bus-dev.patra-bus.workers.dev,https://*-patra-bus-dev.patra-bus.workers.dev`, τα δύο τελευταία = Cloudflare site και previews). Origin της λίστας επιστρέφεται ως έχει, οτιδήποτε άλλο παίρνει το πρώτο. Αυτό σταματά μόνο browsers σε άλλα sites, όχι scripts.

## Branches & previews
- `main` = η beta που βλέπουν οι δοκιμαστές. Protected: μόνο PR, απαιτείται το check `test` (`.github/workflows/test.yml`, τρέχει `npm test` (unit + Playwright) με ελληνικό locale και `npm run check:i18n`), **μόνο ο Kostas κάνει merge**.
- **Merge window** (TEL-182): Δευ–Παρ 08:30–17:30 ώρα Αθήνας κανένα merge στο `main`. Ο κανόνας είναι 09:00· τα 30′ καλύπτουν την καθυστέρηση του cron του GitHub. Το required status `merge-window` (`.github/workflows/merge-window.yml`) μένει κίτρινο όσο είναι κλειστό. Ένα PR που είναι έτοιμο μέσα στις ώρες παίρνει **Enable auto-merge** και γίνεται merge μόνο του μετά τις 17:30. Αργίες: ημερομηνία (YYYY-MM-DD, με κόμμα) στο repo variable `MERGE_WINDOW_HOLIDAYS`· για άνοιγμα αμέσως, Actions → Merge window → Run workflow.
- Κάθε εργασία σε δικό της branch `<όνομα>/TEL-<id>-<slug>` (π.χ. `kostas/TEL-12-repo-workflow`, μέσα στο repo, όχι fork), ανοίγει PR. Πριν ανοίξεις PR κάνε merge το `main` στο branch σου.
- Κάθε PR παίρνει preview από το Cloudflare Workers Builds (project `patra-bus-dev`, `wrangler.jsonc` στη ρίζα, στατικά αρχεία από το `web/`· **δεν** είναι ο API worker `patra-bus`). Ο worker δέχεται αυτά τα origins μέσω του `https://*-patra-bus-dev.patra-bus.workers.dev` στο `ALLOWED_ORIGIN` (`worker/src/origin.js`: το `*` μέσα στο πρώτο label, μόνο για αυτό το project). Οι αναφορές από previews μπαίνουν στο Notion με πρόθεμα `[preview]`.
- **Μην ανεβάζεις χειροκίνητα το `CACHE` στο `web/sw.js`**: το `scripts/stamp-cache.mjs` το βάζει από το commit κατά το deploy (Pages workflow και build command του Cloudflare). Το committed αρχείο μένει όπως είναι. Νέα αρχεία του `web/` μπαίνουν ακόμα στη λίστα SHELL.
- Ο worker ανεβαίνει χειροκίνητα και είναι κοινός σε όλους (previews και παραγωγή): αλλαγές σε αυτόν ελέγχονται τοπικά με `npm run dev:worker` και τις ανεβάζει μόνο ο Kostas μετά το merge.
- Σύγκρουση ownership: δες `docs/ARCHITECTURE.md`. Ένα αρχείο CSS και i18n ανά feature (`css/report.css`, `i18n-en-report.js`) ώστε να μη συγκρούονται οι designers.

## Δομή (v2)
Συμβόλαια modules και ownership: **`docs/ARCHITECTURE.md`**. Κανόνες κίνησης/υλικών (springs, materials,
transform-origin, reduced motion) στο **`docs/DESIGN.md`** — δεσμευτικό για ό,τι αγγίζει ο χρήστης.
Χτίστηκε/ελέγχθηκε διαβάζοντας μόνο κώδικα· **χρειάζεται έλεγχος από άνθρωπο σε πραγματικό browser/συσκευή**
πριν θεωρηθεί τελειωμένο οπτικά. Χάρτης MapLibre GL 4.7.1 (vendored στο `web/vendor/maplibre-gl/`) + OpenFreeMap (liberty / fiord για dark). Hash router στο `app.js` (+ `js/route.js`): προαιρετικό πρόθεμα πόλης (`#/corfu/stop/801`· **χωρίς πρόθεμα = Πάτρα** για stop/line/συντεταγμένες, ενώ γυμνά views όπως `#/lines` παίρνουν το `settings.city`). Τα share links έχουν πάντα πρόθεμα. Η ενεργή πόλη ορίζεται στο `js/boot-city.js` (πρώτο import του app.js)· αλλαγή πόλης = reload. Views: `#/`, `#/stop/{code}`, `#/plan?to=lat,lng&name=…&from=…`, `#/lines`, `#/line/{code}?dir=&route=`, `#/favorites`, `#/pin?lat=&lng=`, `#/settings`, `#/guide` (`?section=install`), `#/report` (αναφορά προβλήματος· εικονίδιο bug στο μενού). `#/notif?routine=…|ref=…&stop=…` δεν είναι view: σύνδεσμος ειδοποίησης που λύνεται στη συσκευή (`js/notif-link.js`, βλ. Push υπενθυμίσεις).
- Shell: `index.html`, `app.css`, `css/tokens.css`, `js/app.js`, `js/map.js`, `js/sheet.js` (bottom sheet / side panel ≥ 900 px), `js/ui.js`.
- Live: `js/api.js` (`fetchLive` με **global memo 15 s ανά στάση**, και για errors, `createLivePoller` 20 s μόνο visible), `js/demo.js` (ντετερμινιστική προσομοίωση πάνω στο routes.json), `js/arrivals-view.js` (tiles LIVE/ΠΡΟΓΡ.).
- Τοποθεσία: `js/location.js` (singleton, φίλτρα άλματος/ακρίβειας, πυξίδα), `js/geo.js`, `js/walk.js` (OSRM foot FOSSGIS, ≤ 1 req/s, fallback εκτίμηση), `js/nearby.js` (κάρτα «Επόμενο λεωφορείο κοντά σου»).
- Διαδρομή: `js/geocode.js` (στάσεις + Photon), `js/planner.js` (απευθείας ή με **μία αλλαγή** (ίδια στάση ή ≤ 300 μ), ≤ 5 live στάσεις ανά σχέδιο, «Φύγε σε N′» = αναμονή λεωφορείου − περπάτημα − περιθώριο· ίδιο `vehicleCode` σε επιβίβαση/αποβίβαση → ακριβής χρόνος), `js/planner-view.js`.
- Οδηγός (`docs/GUIDE.md`): `js/guide-view.js` (τι είναι, εγκατάσταση, πώς το χρησιμοποιώ, τι κάνει κάθε κουμπί), `js/platform.js` (καθαρή ανίχνευση: iOS/Android/άλλο × εφαρμογή/browser × Safari/Chrome/Samsung/Firefox/Edge/in-app), `js/install-guide.js` (σωστό tutorial ανά περίπτωση, κουμπί «Εγκατάσταση» με `beforeinstallprompt`). Κάρτα «Πρώτη φορά εδώ;» και μία φορά υπόδειξη εγκατάστασης στο home (flags `guideSeen`, `installHintDismissed`). Μετά την πρώτη εκκίνηση (setup) η κάρτα «Πρώτη φορά εδώ;» δεν εμφανίζεται. Αγγλικά ανά feature σε `i18n-en-guide.js`/`i18n-en-install.js`.
- Extras: `js/store.js` (blob `patra-bus:v2` στο localStorage, schema 3: αγαπημένα/πρόσφατα/μέρη/ρουτίνες/υπενθυμίσεις έχουν `city`, ό,τι δεν έχει είναι Πάτρα, οι λίστες δείχνουν μόνο την ενεργή πόλη), `js/notify.js` (υπενθυμίσεις μόνο όσο η εφαρμογή είναι ανοιχτή), `js/share.js`, `js/lines-view.js`, `js/settings-view.js`.
- `js/data.js`: φορτώνει stops/lines/routes (+ `loadShapes` lazy). `web/data/routes.json`: σειρά στάσεων ανά διαδρομή + `legSec` + `confidence`. **Η σειρά συμπεραίνεται** (OSRM trip + έλεγχος πλευράς δρόμου), δεν είναι επίσημη· 10/80 διαδρομές έχουν confidence < 0.5 (φουρκέτες/κύκλοι, π.χ. 502x, 2015).
- `tests/`: node:test, χωρίς deps. `tests/e2e/`: Playwright smoke tests (βλ. Smoke tests).
- `scripts/fetch-static.mjs`: scrape token → /stops, /lines (250 ms παύση) → `web/data/`. Τα αρχεία γράφονται απευθείας εκεί, ώστε να τα σερβίρει ο static server χωρίς αντίγραφα.
- `worker/`: Cloudflare Worker, τοπικά (`wrangler dev`) και deployed. Routes (`worker/src/routes.js`): `/api/{city}/live/:code` (cache 15 s), `/api/{city}/stops` και `/api/{city}/lines` (cache 24 h), `/api/{city}/stats/:route/:stop`, `/health` (tokenExp ανά πόλη). Τα παλιά χωρίς πρόθεμα (`/api/live/:code` κ.λπ.) μένουν ως aliases της Πάτρας. Keys με την πόλη: cache `live/{city}/{code}`, KV `token/{city}`, Stats DO `{route}/{stop}` για Πάτρα (κρατά το ιστορικό) και `{city}/{route}/{stop}` για τις άλλες.
- `web/js/arrivals.js`: **κοινό** module worker + frontend. Η λογική live/προγρ. ζει μόνο εδώ.
- `web/js/text.js`: titleCase και searchKey.
- `web/js/cities.js`: πίνακας πόλεων (agency, σελίδα token, bbox, κέντρο). Ό,τι εξαρτάται από την πόλη το διαβάζει από εκεί (worker, scripts, frontend). Πόλεις: `patra` (agency 112, default) και `corfu` (101). Σχεδιασμός, συμβόλαιο και δεδομένα Κέρκυρας στο **`docs/MULTI-CITY.md`** (issue #1).
- Δεδομένα: Πάτρα στο `web/data/*.json`, άλλες πόλεις στο `web/data/{city}/` (`dataDir()`). `npm run fetch-static -- --city=corfu`, `npm run build-routes -- --city=corfu` (κέντρο από `CENTER_WORDS` στο build-routes). Κωδικοί είναι **strings** με πιθανά μηδενικά μπροστά (Κέρκυρα: route `093` ≠ `93`, stop `0015`, line `04`)· ποτέ μετατροπή σε αριθμό. Τα ονόματα Κέρκυρας μένουν άτονα (το λεξικό τόνων είναι για την Πάτρα).
- `web/fixtures/live-1011.json`: πραγματική upstream απάντηση (1 live, 1 προγρ.), για το `?demo`.

## Upstream API (επαληθευμένο 2026-10-09)
- Host `https://rest.citybus.gr`, agency `112`. Όλα GET, χωρίς params.
- Header: μόνο `Authorization: Bearer <token>`. Το Referer **δεν** χρειάζεται. Μένει μόνο ως fallback στο retry μετά από 401/403.
- Token: inline στο HTML του `https://patra.citybus.gr/el/stops` ως `const token = '…'` (μία εμφάνιση). HS256 JWT, payload μόνο `{exp}`, διάρκεια 48 h. **Ποτέ σε committed αρχείο.**
- `/api/v1/el/112/stops` → array (839 στις 2026-10-09): `{id:number, code:string, name, latitude:number, longitude:number, lineCodes[], routeCodes[], distance:0}`. Το `distance` το πετάμε.
- `/api/v1/el/112/lines` → 30: `{id, code, name, color, textColor, borderColor, routes[{id, code, name, direction:1|2}]}`.
- `/api/v1/el/112/stops/live/{code}` → `{vehicles[{lineCode, lineName, routeCode, routeName, latitude:string, longitude:string, departureMins:number, departureSeconds:number, vehicleCode, lineColor, lineTextColor, borderColor}]}`.
  - `latitude/longitude` = `"0"/"0"` → **προγραμματισμένη** αναχώρηση. Το `departureMins` = λεπτά ως την ώρα του προγράμματος. Όλα τα άλλα είναι live.
  - Το `departureSeconds` είναι **υπόλοιπο 0–59**, όχι σύνολο (1′14″ → mins 1, secs 14). Μπορεί να είναι ≠0 **και στα προγραμματισμένα**. Γι' αυτό η ώρα προγράμματος = `fetchedAt + etaSec`, και βγαίνει σταθερή ανάμεσα στα fetches (π.χ. 22:45:33).
  - Μία φορά ήρθε **200 με κενό body** (σε γρήγορη επανάληψη). Το χειριζόμαστε ως upstream error και δεν μπαίνει σε cache.
- **Κέρκυρα (agency `101`, σελίδα token `https://corfu.citybus.gr/el/stops`)**: επιτρέπονται τα **ίδια τρία** endpoints (`/stops`, `/lines`, `/stops/live/{code}`) με τους ίδιους κανόνες (έγκριση 2026-10-10). Ίδια σχήματα απαντήσεων· οι κωδικοί στάσεων **επικαλύπτονται** με της Πάτρας (321/479), άρα κάθε key έχει την πόλη.
- Υπάρχουν και trips/sequence/points (`/api/v1/112/lines/{code}/points` χωρίς `el`), αλλά δεν χρησιμοποιούνται. Το ακριβές path για τη σειρά στάσεων **δεν** είναι γνωστό και δεν ψάχνεται (κανόνας no probing).
- Live **404** = καμία αναχώρηση εκείνη την ώρα (επιβεβαιώθηκε 2026-10-10: 404 τη νύχτα, 200 με δεδομένα το πρωί). Ο worker το γυρίζει ως `200 {vehicles: [], noService: true}` με cache 15 s.
- Παρατηρήσεις 2026-10-10 (**ανεπιβεβαίωτες**): το `vehicleCode` μοιάζει με `YYYYMMDD_route_…_HH_MM`, όπου το HH_MM ταίριαξε με ώρες αναχώρησης από την αφετηρία (πιθανή πηγή προγράμματος, δεν χρησιμοποιείται). Το live της αφετηρίας δίνει μόνο 1–2 αναχωρήσεις (~25′ μπροστά). Η διαδρομή 2015 (confidence 0.25) μάλλον έχει αντίστροφη σειρά: οι αναχωρήσεις της «πρώτης» στάσης 372 ανήκουν στη 2021.
- Στάση για τεστ: **1011** `ΠΑΝΕΠΙΣΤΗΜΙΟΥ & ΑΡΕΘΑ` (201, 606, 609).

## Κανόνες
- Ποτέ polling στο live πιο συχνά από 15 s. Το frontend κάνει poll κάθε 20 s, μόνο όταν η σελίδα είναι ορατή.
- Κανένα probing σε endpoints εκτός από τα παραπάνω.
- Συντεταγμένες `0/0` δεν εμφανίζονται και δεν χρησιμοποιούνται πουθενά. Το `normalizeLive` τις αφαιρεί.
- Ονόματα: Title Case μόνο στην εμφάνιση, με τελικό ς. Τόνοι **μόνο** από το επιμελημένο λεξικό `web/js/accents.js` (λέξεις με μοναδικό σωστό τονισμό, 402 λέξεις, ~70% των ονομάτων πλήρως τονισμένα). Αμφίσημες/άγνωστες λέξεις μένουν άτονες· ποτέ αυτόματη μαντεψιά. Το `searchKey` αγνοεί τόνους.
- Service worker: δεν κάνει **ποτέ** cache το `/api/` ή άλλα origins, **εκτός από το OpenFreeMap** (style, TileJSON, tiles, glyphs, sprites) σε ξεχωριστά caches: `patra-bus-map-v1` (runtime, ≤ 4000) και `patra-bus-map-offline-v1` (λήψη της ενεργής πόλης z8–14, μία πόλη τη φορά, ~7,6 MB για την Πάτρα, από τις Ρυθμίσεις). Ποτέ OSRM ή Photon. Το MapLibre είναι vendored στο `web/vendor/maplibre-gl/` (4.7.1). Το `CACHE` στο `web/sw.js` σφραγίζεται αυτόματα στο deploy (βλ. Branches & previews)· κάθε νέο αρχείο στο `web/` μπαίνει στη λίστα SHELL.
- Τρίτες υπηρεσίες (χωρίς κλειδί, με attribution στις Ρυθμίσεις): OpenFreeMap, OSRM/FOSSGIS (≤ 1 req/s), Photon/komoot (debounce). Η θέση του χρήστη δεν μπαίνει ποτέ σε URL της εφαρμογής.
- Minimum viable complexity: vanilla JS, χωρίς build step και χωρίς framework.

## Smoke tests (Playwright)
- `tests/e2e/*.spec.mjs`, config στο `playwright.config.mjs`: Chromium σε **360×780** (κινητό, `el-GR`), static server του `web/` στο :4173. Καλύπτουν: φόρτωση και των δύο πόλεων, αναζήτηση στάσης, αφίξεις, LIVE vs ΠΡΟΓΡ. (κείμενο, εικονίδιο **και** χρώματα), εναλλαγή EL/EN (κανένα ελληνικό στο ορατό κείμενο/labels εκτός από ονόματα στάσεων/διαδρομών), app shell offline μετά την πρώτη επίσκεψη (service worker). Όλο το suite < 2 λεπτά (`globalTimeout`· τοπικά ~10 s).
- **Ποτέ δίκτυο**: το `tests/e2e/mock.mjs` απαντά στο `http://localhost:8787/api/{city}/live/{code}` από τα fixtures (περνούν από το ίδιο `normalizeLive` με τον worker, `fetchedAt` = τώρα), δίνει 404 σε κάθε άλλο route του worker και κόβει κάθε άλλο origin (citybus.gr, deployed worker, OpenFreeMap, OSRM, Photon). Αν η σελίδα δοκιμάσει citybus.gr ή `workers.dev`, το τεστ αποτυγχάνει.
- Fixtures: `tests/e2e/fixtures/{city}-live-{code}.json` = `{ city, stop, recordedAt, status, body }`, όπου `body` η **ακατέργαστη** απάντηση του upstream `/stops/live/{code}` (`status` 404 → `body: null` = noService). Στάσεις στο `tests/e2e/stops.mjs`: Πάτρα **1011**, Κέρκυρα **404** (Πολυκλινική, στη μέση των γραμμών 04/07/08/11/14). Όχι αφετηρία: η 801 (Πλ. Σαρόκου) είναι αρχή ή τέλος και στις 19 διαδρομές της και δίνει μόνο προγραμματισμένα, ποτέ live (TEL-29). Το τεστ LIVE/ΠΡΟΓΡ. τρέχει **και στις δύο πόλεις** και θέλει **τουλάχιστον ένα live και ένα προγραμματισμένο** σε κάθε fixture.
- Τρέχοντα fixtures: Πάτρα = η πραγματική απάντηση της 2026-10-09 ~22:10 (1 live, 1 προγρ., ίδια με το `web/fixtures/live-1011.json`)· Κέρκυρα = στάση 404, Δευτέρα 2026-10-19 18:08 (1 live: γραμμή 11, 2 προγρ.: 04, 07).
- **Ξαναγράψιμο**: `npm run record-fixtures` (ή `-- --only=corfu`). Κάνει scrape το token όπως το `fetch-static` (δεν γράφεται πουθενά) και **ένα** GET `/stops/live/{code}` ανά πόλη, τίποτα άλλο. Κάνε το καθημερινή, μέρα, σε ώρες λειτουργίας: αν η απάντηση δεν έχει και live και προγραμματισμένο **δεν γράφεται** (exit 1), ώστε ένα βραδινό τρέξιμο να μη χαλάσει καλό fixture· `--force` τη γράφει όπως είναι. Μετά: `npm run test:e2e` και commit τα JSON. Αλλαγή στάσης = `tests/e2e/stops.mjs` + τα ονόματα/queries του `CITY` στο `smoke.spec.mjs`.
- Αποτυχία στο CI: artifact `playwright-results` (trace ανά τεστ, `npx playwright show-trace …`).

## Αναφορά προβλήματος
- Client: `js/report-view.js` (+ `js/report.js`, κοινό με τον worker: validation, whitelist διαγνωστικών, transport), `css/report.css`, αγγλικά στο `js/i18n-en-report.js`. Στέλνει μόνο ό,τι έγραψε ο χρήστης (κατηγορία, κείμενο, προαιρετικό email) + τα διαγνωστικά που εμφανίζονται πριν την αποστολή (χωρίς query/συντεταγμένες/UA/IP).
- Worker: `POST /api/report` (`worker/src/report.js`): έλεγχος Origin + `application/json`, 3 / 10′ ανά IP (μνήμη isolate), honeypot (`hp`), ημερήσιο όριο 100 στο KV `report-day/{date}`, μετά μία σελίδα στη βάση Notion. Δεν αποθηκεύει τίποτα στον worker. Λεπτομέρειες και schema της βάσης στο `docs/ARCHITECTURE.md`.
- Secrets (όχι στο repo): `npx wrangler secret put NOTION_TOKEN --config worker/wrangler.toml` (internal integration, κοινοποιημένη στη βάση) και `NOTION_DB_ID`· τοπικά στο `worker/.dev.vars`. Χωρίς αυτά ο worker απαντά 503 και η φόρμα δείχνει «δεν είναι διαθέσιμη».

## Καλωσόρισμα δοκιμαστών
- `js/welcome.js` + `css/welcome.css` + `js/i18n-en-welcome.js`: μία φορά, την πρώτη φορά που η εφαρμογή ανοίγει ως εγκατεστημένη (standalone, `currentPlatform().mode === 'app'`), modal με animation ευχαριστίας («Πρώτοι δοκιμαστές» / "Founding testers") και σύνδεσμο προς `#/report`. Flag `welcomeSeen` (store.js, επιβιώνει του reset ρυθμίσεων, σβήνει με «Διαγραφή όλων»)· μπαίνει όταν εμφανιστεί, όχι όταν κλείσει. `?welcome` το δείχνει οποτεδήποτε χωρίς να πειράξει το flag (για προεπισκόπηση σε browser). Κίνηση: spring για την κάρτα, keyframes για τα διακοσμητικά, reduced motion = fade ≤ 180 ms.

## Πρώτη εκκίνηση (setup)
- `js/setup.js` + `css/setup.css` + `js/i18n-en-setup.js` (TEL-74, issue #35): την πρώτη φορά που η εφαρμογή ανοίγει στο home (όχι σε deep link), 3 βήματα: γλώσσα (προεπιλογή από τη γλώσσα του συστήματος), πόλη, LIVE vs ΠΡΟΓΡ. «Παράλειψη»/Esc κλείνει· η πόλη εφαρμόζεται στο κλείσιμο (άλλη πόλη = reload). Flags `setupDone` + `guideSeen` μπαίνουν όταν εμφανιστεί (επιβιώνουν του reset). Ανοίγει πριν το πρώτο route· το welcome των δοκιμαστών περιμένει να κλείσει. `?setup` = προεπισκόπηση χωρίς flags.
- Τεστ: το `tests/e2e/mock.mjs` βάζει `setupDone` σε κάθε spec, εκτός με `test.use({ firstRun: true })` (`setup.spec.mjs`). Το `npm run shots` το βγάζει ως screen `setup` (3 βήματα).

## Push υπενθυμίσεις
- Worker: `GET /api/push/key`, `POST /api/push/reminders` (προαιρετικό `city`, default `patra`· όριο 12 / 10′ ανά IP, ανά isolate), `DELETE /api/push/reminders/{id}`. Ένα SQLite Durable Object (`Reminder`) ανά υπενθύμιση, alarm στην ώρα, ξαναδιαβάζει το live μέσα από την ίδια cache 15 s και ξαναοπλίζει (≤ 3) αν το λεωφορείο άργησε > 60 s. Διαγράφονται όλα μετά την αποστολή.
- VAPID: public key στο `wrangler.toml`, private **μόνο** ως Cloudflare secret (`npx wrangler secret put VAPID_PRIVATE_KEY --config worker/wrangler.toml`) και τοπικά στο `worker/.dev.vars` (gitignored, μαζί με `DEV_ALLOW_LOCAL_PUSH=1`). Αλλαγή κλειδιού = αλλαγή και των δύο.
- Client: `js/push.js` + `js/notify.js` (ίδιο `tag` τοπικά και στον server), `web/sw-push.js` (importScripts από το `sw.js`). Στο iPhone μόνο ως εγκατεστημένη εφαρμογή.
- Το `url` της ειδοποίησης που πάει στον worker **δεν έχει ποτέ μέρος** (συντεταγμένες/όνομα): `#/{city}/notif?routine=<ref>&stop=` για ρουτίνες (το `ref` μένει στη ρουτίνα στη συσκευή), `#/{city}/notif?ref=<ref>&stop=` για υπενθυμίσεις με σύνδεσμο διαδρομής (το hash μένει στο `patra-bus:push-links`, 24 ώρες). Το `app.js` το λύνει στη συσκευή: διαδρομή προς το μέρος όπως είναι τώρα, αλλιώς η στάση, αλλιώς αρχική. Ο worker πετά κάθε `url` με `to/from/name/lat/lng` (`cleanUrl`, παλιοί clients). Ρουτίνες αποθηκευμένες πριν το TEL-13 κρατούν το παλιό URL ώσπου να λήξουν (120 ημέρες).

## Dev σημειώσεις
- Το `npm i` μπλοκάρει το postinstall του `workerd` (npm allow-scripts). Δεν πειράζει: το binary έρχεται από το `@cloudflare/workerd-windows-64` και το `wrangler dev` τρέχει κανονικά.
- `API_BASE` στο `web/js/api.js`: σε `localhost`/`127.0.0.1` καλεί `http://localhost:8787`, αλλού τον deployed worker.
- `?debug` εκθέτει `window.__app` (και `map._map`).
- Ο worker στέλνει `X-Cache: HIT|MISS`. Στο HIT το `fetchedAt` είναι αυτό του αρχικού upstream fetch.
- Το browser pane του Claude desktop **μερικές φορές** κάνει register τον SW και σερβίρει παλιά αρχεία: στο τεστ κάνε unregister + `caches.delete` πρώτα. Screenshots αποτυγχάνουν όταν το pane δεν είναι ορατό· χρησιμοποίησε DOM checks.

## Team rules
- Plan before code: for anything bigger than a typo, present a plain-language plan and get
  approval first.
- One task per branch/PR. If a task needs more than ~3 files or mixes concerns, split it.
- Explain-back gate: nothing is committed or merged unless the author can state in their own
  words what changed, why, and how it could break. Write those 3 lines in the commit/PR.
- Update docs/ARCHITECTURE.md whenever how the parts connect changes.
- New technical terms go in docs/GLOSSARY.md.
- Sessions follow **docs/WORKFLOW.md**: one list (Notion Tasks), `/plan-week` for the weekly planning, `/task TEL-<id>`
  for one task per session; every step the user does is given one at a time and Claude waits for confirmation.
- The mod `.claude/skills/tel-sprint/` opens a pane «Sprint» in Claude Code with the connected Notion user's open cards
  of the current sprint (read-only, through the Notion connector, every 5′ and on `/sprint`). In a local Claude desktop
  session the connector is a server named by an id per user; in auto mode each user allows its two read tools once in
  `.claude/settings.local.json` (gitignored): `mcp__<id>__notion-get-self`, `mcp__<id>__notion-query-data-sources`.
