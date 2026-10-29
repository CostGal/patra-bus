# Ξεκινώντας στο patra-bus (Telematica)

Στόχος: από το μηδέν σε app + worker τοπικά και πρώτο PR σε ~15 λεπτά. Ποιος δουλεύει πού και οι κανόνες της ομάδας:
`CLAUDE.md` → «Ομάδα και τομείς». Η ροή μιας κάρτας από την αρχή ως το merge: `docs/WORKFLOW.md`.

## 1. Μία φορά (~10′)
Χρειάζεσαι: **Node 22**, **git**, πρόσβαση write στο repo (σου τη δίνει ο Kostas) και Claude Code desktop.
```
git clone https://github.com/CostGal/patra-bus.git
cd patra-bus
npm install
npx playwright install chromium     # για τα smoke tests
npm test                            # unit + Playwright· πρέπει να βγει πράσινο πριν αλλάξεις οτιδήποτε
git config commit.template .gitmessage   # το πρότυπο commit (τι άλλαξε / γιατί / πώς σπάει)
```
Στα Windows το `npm install` μπορεί να γράψει ότι μπλόκαρε το postinstall του `workerd`. Δεν πειράζει.

## 2. Η εφαρμογή τοπικά
```
npm run dev:web                     # http://localhost:8080/
```
Χωρίς worker: http://localhost:8080/?demo#/stop/1011 (προσομοίωση, όλες οι στάσεις). Με `?debug` βλέπεις `window.__app`.

## 3. Ο worker τοπικά
```
cp worker/.dev.vars.example worker/.dev.vars    # Windows: copy worker\.dev.vars.example worker\.dev.vars
npm run dev:worker                               # http://localhost:8787/health
```
Η εφαρμογή στο `localhost:8080` μιλά αυτόματα στο `localhost:8787` (χωρίς `?demo` = πραγματικά live δεδομένα).
Ο worker παίρνει μόνος του το token του citybus.gr· τοπικό KV και Durable Objects, τίποτα δεν πάει στο Cloudflare.
Όλα τα πεδία του `.dev.vars` είναι προαιρετικά· όσα μείνουν κενά απλώς κλείνουν εκείνο το feature (503).

**Push τοπικά**: φτιάξε **δικό σου** ζεύγος κλειδιών και βάλε τις δύο γραμμές στο `worker/.dev.vars`:
```
node -e "crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign']).then(async k=>{const j=await crypto.subtle.exportKey('jwk',k.privateKey);console.log('VAPID_PUBLIC_KEY='+Buffer.from(await crypto.subtle.exportKey('raw',k.publicKey)).toString('base64url')+'\nVAPID_PRIVATE_KEY='+j.d)})"
```

## 4. Secrets: ποιος έχει τι
| Πού | Ποιος τα έχει | Εσύ |
|---|---|---|
| Τοπικά (`worker/.dev.vars`, gitignored) | ο καθένας τα δικά του | τα φτιάχνεις όπως παραπάνω· Notion μόνο με δοκιμαστική βάση |
| Staging (Cloudflare, worker `patra-bus-staging`) | ο Kostas τα βάζει μία φορά | δεν τα χρειάζεσαι: το deploy γίνεται από το GitHub |
| Production | μόνο ο Kostas | ποτέ |

Ποτέ secret σε αρχείο, commit, PR, issue ή chat. Το CI (`test`) σαρώνει όλο το ιστορικό με gitleaks και κοκκινίζει.
Αν κατά λάθος μπει secret σε commit: **μην** το σβήσεις απλώς, πες το αμέσως στον Kostas για να αλλάξει το κλειδί.

## 5. Deploy στο staging (worker)
1. Κάνε push το branch σου.
2. GitHub → **Actions** → **Worker deploy** → **Run workflow** → διάλεξε το branch σου, target **staging** → Run.
3. Έλεγχος: https://patra-bus-staging.patra-bus.workers.dev/health και π.χ. `/api/patra/live/1011`.

Το staging έχει δικό του KV, Durable Objects και secrets: δεν αγγίζει ποτέ τους χρήστες. Μοιράζεται όμως το ημερήσιο
όριο του δωρεάν πλάνου του Cloudflare με το production (100.000 requests/ημέρα, 1.000 εγγραφές KV/ημέρα), οπότε όχι
load tests. Production: **μόνο** από το `main`, με το ίδιο Action, μετά από έγκριση του Kostas. Ποτέ `wrangler deploy`
από τον υπολογιστή σου.

Για το frontend δεν χρειάζεται deploy: κάθε PR παίρνει μόνο του preview (σχόλιο του Cloudflare στο PR,
`https://<branch>-patra-bus-dev.patra-bus.workers.dev`). Το preview μιλά στον **production** worker.

## 6. Αλλαγή και PR
```
git switch main && git pull
git switch -c <όνομα>/TEL-<id>-<slug>          # π.χ. fanis/TEL-205-lighthouse-budget· το TEL-id από την κάρτα του Notion
# ... αλλαγές ...
npm test && npm run check:i18n
git commit                                    # το .gitmessage ζητά: τι άλλαξε, γιατί, πώς μπορεί να σπάσει
git push -u origin <όνομα>/TEL-<id>-<slug>
```
Μετά άνοιξε PR προς `main` και συμπλήρωσε το template. Ο Kostas μπαίνει μόνος του ως reviewer (CODEOWNERS).
Το CI (`test`) πρέπει να είναι πράσινο. **Δεν κάνεις merge**: το κάνει ο Kostas (Δευ–Παρ 08:30–17:30 τα merges
περιμένουν, βλ. merge window στο `CLAUDE.md`). Ένα PR = μία κάρτα, μικρό (≤ ~3 αρχεία ή ένα θέμα).
