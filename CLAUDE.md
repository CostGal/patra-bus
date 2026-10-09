# patra-bus

PWA με live αφίξεις αστικών λεωφορείων Πάτρας, πάνω στο API του patra.citybus.gr.
Βασική αξία: ξεχωρίζει **live** οχήματα από **προγραμματισμένες** αναχωρήσεις (η επίσημη σελίδα τα δείχνει ίδια).

## Εντολές
```
npm install
npm run fetch-static     # ανανεώνει web/data/stops.json + lines.json (committed)
npm run dev:worker       # wrangler dev --local στο :8787 (local KV, ποτέ deploy)
npm run dev:web          # static server του web/ στο :8080, χωρίς HTTP cache
```
Άνοιγμα: http://localhost:8080/ · demo με fixture: http://localhost:8080/?demo#/stop/1011
Τα δύο dev servers υπάρχουν και στο `.claude/launch.json` (`worker`, `web`).

## GitHub / Pages
- Repo (public): https://github.com/CostGal/patra-bus
- Site: https://costgal.github.io/patra-bus/. Το `.github/workflows/pages.yml` ανεβάζει **μόνο** το `web/` σε κάθε push στο `main`.
- Το site είναι σε subpath (`/patra-bus/`), οπότε όλα τα paths στο `web/` μένουν **σχετικά** (`./data/…`, `sw.js`, `start_url: "./"`).
- Ο worker δεν γίνεται deploy. Στο Pages το `API_BASE` δείχνει ακόμα σε `http://localhost:8787`, άρα live μόνο στο δικό σου PC με τον worker ανοιχτό (ο browser μπορεί να ζητήσει άδεια local network). Το browser pane του Claude το μπλοκάρει. Για τους άλλους δουλεύουν αναζήτηση, στάσεις και `?demo`.

## Δομή
- `scripts/fetch-static.mjs`: scrape token → /stops, /lines (250 ms παύση) → `web/data/`. Τα αρχεία γράφονται απευθείας εκεί, ώστε να τα σερβίρει ο static server χωρίς αντίγραφα.
- `worker/`: Cloudflare Worker, μόνο για τοπική χρήση. Routes: `/api/live/:code` (cache 15 s), `/api/stops` και `/api/lines` (cache 24 h), `/health`.
- `web/js/arrivals.js`: **κοινό** module worker + frontend. Η λογική live/προγρ. ζει μόνο εδώ.
- `web/js/text.js`: titleCase και searchKey.
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
- Υπάρχουν και trips/sequence/points (`/api/v1/112/lines/{code}/points` χωρίς `el`), αλλά δεν χρησιμοποιούνται στο v1.
- Στάση για τεστ: **1011** `ΠΑΝΕΠΙΣΤΗΜΙΟΥ & ΑΡΕΘΑ` (201, 606, 609).

## Κανόνες
- Ποτέ polling στο live πιο συχνά από 15 s. Το frontend κάνει poll κάθε 20 s, μόνο όταν η σελίδα είναι ορατή.
- Κανένα probing σε endpoints εκτός από τα παραπάνω.
- Συντεταγμένες `0/0` δεν εμφανίζονται και δεν χρησιμοποιούνται πουθενά. Το `normalizeLive` τις αφαιρεί.
- Ονόματα: Title Case μόνο στην εμφάνιση, με τελικό ς. Οι τόνοι δεν μαντεύονται.
- Service worker: δεν κάνει **ποτέ** cache το `/api/` ή άλλα origins. Σε αλλαγή shell αρχείων ανεβάζεις το `CACHE` στο `web/sw.js`.
- Minimum viable complexity: vanilla JS, χωρίς build step και χωρίς framework.

## Dev σημειώσεις
- Το `npm i` μπλοκάρει το postinstall του `workerd` (npm allow-scripts). Δεν πειράζει: το binary έρχεται από το `@cloudflare/workerd-windows-64` και το `wrangler dev` τρέχει κανονικά.
- Το frontend καλεί `http://localhost:8787` (`API_BASE` στο `web/js/app.js`).
- Ο worker στέλνει `X-Cache: HIT|MISS`. Στο HIT το `fetchedAt` είναι αυτό του αρχικού upstream fetch.
- Το ενσωματωμένο browser pane του Claude desktop δεν κάνει register service workers ("unknown error when fetching the script"). Ο SW επαληθεύεται σε κανονικό Chrome/Edge.
