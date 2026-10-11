# UI and accessibility audit (TEL-19)

Audit, not redesign: people use Telematica at a bus stop, in sunlight, one-handed. Visual style stays as it is.
P1 items are fixed in the TEL-19 PR. P2 and P3 items are proposals for new tasks.

- **Date:** 2026-10-11. **Base:** `main` at `0d4d163`.
- **Line numbers:** they point at this branch, after the P1 fixes.
- **Guidelines:**
  - Vercel Web Interface Guidelines (`vercel-labs/agent-skills` → `web-design-guidelines`; rules fetched from `vercel-labs/web-interface-guidelines`).
  - WCAG 2.2 AA (`mastepanoski/claude-skills` → `wcag-accessibility-audit`).
- **Matrix:** Patras and Corfu × EL and EN × light and dark, at 360×780 (Chromium, `el-GR`, touch).
  - Network mocked with the smoke-test fixtures (`tests/e2e/mock.mjs`).
  - Extra routes for loading (delayed), error (500, abort, timeout), empty and `noService`, plus stale data (clock fast-forwarded past `STALE_MS`).
  - `?demo` for many tiles.
- **Method:**
  - Measured contrast of every visible text node against its real background, including translucent sheets. Over the map these were checked against the worst plausible map colour: sea `#a0c8f0` in light, fiord `#45516e` in dark.
  - Measured hit boxes of every interactive element.
  - Dumped the accessibility tree per screen and logged live-region mutations.
  - Walked every screen with the keyboard, and checked greyscale and forced colours.
- **Not covered:** a real TalkBack/VoiceOver pass and an outdoor check on a phone. See the `device-test` issue linked from the PR.

**Priorities**
- **P1:** a WCAG 2.2 A/AA failure, or a serious outdoor-readability problem, on a primary flow (home/search, stop arrivals including loading/empty/error, LIVE vs scheduled tiles, top bar/sheet). Also Greek screen-reader output for arrivals that is missing or misleading.
- **P2:** an AA failure on a secondary screen (settings, guide, report, lines, planner, favourites, welcome), or a meaningful non-blocking problem on a primary flow.
- **P3:** polish, AAA, or a Web Interface Guidelines best practice.

| | P1 | P2 | P3 |
|---|---|---|---|
| Outdoor readability / contrast | 6 | 6 | 3 |
| Tap targets / gestures | 1 | 1 | 2 |
| Arrival states (loading, empty, error, stale) | 4 | – | 3 |
| LIVE vs scheduled | (in contrast) | 1 | 2 |
| Screen reader / keyboard | 4 | 11 | 10 |
| **Total** | **15** | **19** | **20** |

LIVE vs scheduled is never shown by colour alone (WCAG 1.4.1 passes). The cues are:
- the text label (LIVE / ΠΡΟΓΡ.);
- a pulsing dot vs a clock icon;
- the timetable time on scheduled tiles;
- the stripe and countdown colour.

The distinction survives dark mode and greyscale, and survives forced colours through the text. The tiles' Greek and English accessible names are full sentences, for example:

> «Γραμμή 609, Νοσοκομείο Πανεπιστήμιο Ερμού. Ζωντανή θέση: φτάνει σε 1 λεπτό, περίπου στις 22:18.»

The gaps were around the tiles, not in them.

---

## P1: fixed in this PR

### Outdoor readability (contrast)

**P1-1. Line badges below 4.5:1 on 20/30 Patras lines and 7/13 Corfu lines** (WCAG 1.4.3, 1.4.11)
- **Problem:** upstream sends white text on every line colour. Measured ratios:
  - `#00bcd4` (901, 902, Corfu 06): 2.30
  - `#ccab1d` (608): 2.23
  - `#ff9800` (Corfu 11): 2.16
  - `#4caf50` (701, 2B): 2.78
  - `#ff5722` (201): 3.16
  - `#787878` (14 Patras lines, e.g. 606/609): 4.42
- **Where it shows:** badges are 11–16 px, so the 4.5:1 minimum applies. The same pairs drive filter chips, search rows, map markers and the line/bus views.
- **Fix:** [web/js/color.js](../web/js/color.js) `readableLine()` normalises each pair once, at the two sources, so every consumer inherits it:
  - [web/js/data.js:39](../web/js/data.js:39) for static lines;
  - [web/js/api.js:74](../web/js/api.js:74) for live vehicles. The worker-shared `arrivals.js` is untouched.
- **Rule:** keep the line colour. First try a darkening of at most 6%: grey `#787878` → `#767676`, magenta `#d500f9` → `#c800ea`. Otherwise use dark text `#1f1f1f` on bright lines: 201, 608, 701, 901/902, Corfu 04/06/10/11/2B.
- **Result:** every line is now ≥ 4.52:1. Tested in [tests/color.test.mjs](../tests/color.test.mjs) against both cities' `lines.json`.

**P1-2. Filter chips faded out by a mask** (1.4.3, 1.4.11)
- **Problem:** `.fade-edge-bottom` masked the lower ~55% of the sticky chip row. The 201 badge text dropped to ~1.5–2.5:1, and chip borders and the selected chip's outline disappeared.
- **Fix:** the row is wrapped in a sticky `.stopv-chipbar`, and the same fade is drawn under it (`::after`, over the 12 px gap). See [web/css/arrivals.css:41](../web/css/arrivals.css:41) and [web/js/arrivals-view.js:173](../web/js/arrivals-view.js:173).

**P1-3. Light `--accent` under 4.5:1 off pure white** (1.4.3)
- **Problem:** `#1a73e8` measured 4.37 on the sheet, 3.89 over sea, 4.05 on `--surface-2` and 3.93 on `--accent-soft`. It is used for:
  - "Όρισε θέση στον χάρτη"
  - "Φύγε σε 2′"
  - "Εμφάνιση όλων (14)"
  - links and the selected report category
- **Fix:** `--accent: #1967d2`, the next shade of the same blue. It gives 5.37 on white and 4.64 over sea. White text on the accent goes from 4.51 to 5.37. `--focus` is unchanged. See [web/css/tokens.css:5](../web/css/tokens.css:5).

**P1-4. LIVE label fails on its own pill** (1.4.3)
- **Problem:** `#188038` on `#e6f4ea` measured 4.42 at 11.5 px bold, on every live tile, the nearby tiles and the settings legend.
- **Fix:** `--live: #137333`, the same green one step darker. It gives 5.24 on the pill and 5.95 on white. See [web/css/tokens.css:5](../web/css/tokens.css:5).

**P1-5. Light `--warn` fails on `--warn-bg`** (1.4.3)
- **Problem:** `#b06000` on `#fef7e0` measured 4.34. Affected:
  - the stale/offline banner;
  - "Πήγαινε στη στάση τώρα";
  - the map note;
  - the planner "run" hero;
  - "Στο όριο", which measured 4.01 over sea.
- **Fix:** `--warn: #9a5200`. It gives 5.47 on `--warn-bg` and 5.86 on white. See [web/css/tokens.css:6](../web/css/tokens.css:6).

**P1-6. Stale arrivals faded to `opacity: .6`** (1.4.3)
- **Problem:** when the data is old (offline, outdoors), countdowns fell to 2.46–2.59:1 (light) and 3.1:1 (dark), and badges to ≤ 2.6.
- **Fix:** `filter: grayscale(1)`. The text keeps full contrast, and nothing looks LIVE-green while the banner says the data is old. See [web/css/arrivals.css:64](../web/css/arrivals.css:64).

### Arrival states (loading / empty / error / stale)

**P1-7. Loading, error, empty and loaded states were never announced** (4.1.3)
- **Problem:** a screen-reader user heard an empty list (the skeleton is `aria-hidden`), then silence. "Δεν φορτώθηκαν οι αφίξεις" and "Καμία προγραμματισμένη άφιξη αυτή τη στιγμή" were plain paragraphs.
- **Fix:** one visually-hidden `role=status` per stop view ([web/js/arrivals-view.js:178](../web/js/arrivals-view.js:178)) speaks once per change of state kind:
  - loading: «Φόρτωση αφίξεων…»
  - error: «Δεν φορτώθηκαν οι αφίξεις. Η υπηρεσία …»
  - empty: «Καμία προγραμματισμένη άφιξη αυτή τη στιγμή»
  - loaded: «2 αφίξεις, 1 με ζωντανή θέση» / "2 arrivals, 1 with live position"
  - stale: «Παλιά δεδομένα: οι χρόνοι μπορεί να μην ισχύουν.»
- The routine 20 s poll is never announced.

**P1-8. Stale banner was a live region rewritten every second** (4.1.3, 2.2.2)
- **Problem:** with `role=status`, "Παλιά δεδομένα: ενημερώθηκαν πριν 60″… 61″… 62″" was re-announced every second (37 announcements in 12 s), and the ″ was read as a symbol.
- **Fix:**
  - The banner is no longer a live region ([web/js/arrivals-view.js:171](../web/js/arrivals-view.js:171)). Staleness is announced once, through P1-7.
  - Stale tiles add «Τα δεδομένα δεν έχουν ενημερωθεί πρόσφατα.» / "The data has not been updated recently." to their accessible name ([web/js/arrivals-view.js:51](../web/js/arrivals-view.js:51)). Before, they still said «Ζωντανή θέση: φτάνει τώρα».

**P1-9. "Δοκίμασε ξανά" (Try again) dropped keyboard focus to `<body>`** (2.4.3)
- **Problem:** every update rebuilt the error block, and the new button was `disabled` while waiting.
- **Fix:**
  - The block stays in place for a repeated error.
  - Retry buttons use `aria-disabled` (same look, keep focus) and `doRefresh` ignores presses while waiting ([web/js/arrivals-view.js:197](../web/js/arrivals-view.js:197), [:318](../web/js/arrivals-view.js:318)).
  - Whatever had focus in the list gets it back after a rebuild ([:300](../web/js/arrivals-view.js:300)).

**P1-10. Line-filter chips and "Εμφάνιση όλων" lost focus on activation and on every poll** (2.4.3, 2.1.1)
- **Problem:** chips were rebuilt on every render.
- **Fix:**
  - Chips are now rebuilt only when the lines or the filter change, and focus returns to the same chip ([web/js/arrivals-view.js:233](../web/js/arrivals-view.js:233)).
  - "Εμφάνιση όλων" moves focus to the first newly shown tile ([:285](../web/js/arrivals-view.js:285)).

### Keyboard, screen reader and gestures

**P1-11. The search overlay stayed open after Tab and hid every later focused control** (2.4.11, 2.4.7)
- **Problem:** `#search-panel` is full-screen. Tabbing out of the input left it open over the locate button, the sheet, the chips and the tiles.
- **Fix:** focus moving to a control outside the search closes it ([web/js/app.js:493](../web/js/app.js:493)). A blur with nowhere to go, such as touch-scrolling the results, keeps it open.

**P1-12. Search messages were silent and sat inside the listbox** (4.1.3, 1.3.1)
- **Problem:** «Κανένα αποτέλεσμα», «Δεν ήταν δυνατή η αναζήτηση τόπων.» and «Αναζήτηση τόπων…» were `<p>` children of `role=listbox`, and the result count was never announced.
- **Fix:**
  - The visible messages stay where they are, `aria-hidden`.
  - A `role=status` after the listbox ([web/js/app.js:312](../web/js/app.js:312)) speaks the message and «9 αποτελέσματα» / "9 results", debounced 500 ms.

**P1-13. In the half-height sheet, keyboard focus landed below the screen edge** (2.4.11)
- **Problem:** the sheet is translated, so the browser never scrolls it. Tiles took focus at y = 833–1030 on a 780 px screen.
- **Fix:** keyboard focus (`:focus-visible` only) that lands below the edge opens the sheet to the detent where it fits ([web/js/sheet.js:226](../web/js/sheet.js:226)). Taps never move the sheet.

**P1-14. The map canvas took keyboard focus with no visible indicator** (2.4.7)
- **Problem:** the canvas is the first Tab stop on every view, with `outline: none`.
- **Fix:** an inset 3 px `--focus` ring on `:focus-visible` only ([web/app.css:75](../web/app.css:75)).

**P1-15. "Peek" was reachable only by dragging on most views** (2.5.7)
- **Problem:** tapping the handle cycled peek → half → full → half, never back to peek. A map tap collapses only on home.
- **Fix:** taps walk up to full and back down to peek: full → half → peek → half → full ([web/js/sheet.js:180](../web/js/sheet.js:180)). Arrow keys are unchanged.

**Verification**
- A scripted check of all P1 fixes passes: 70/70 assertions across EL/EN × light/dark plus Corfu. The same script against `main` fails each of them.
- `npm test` passes: 560 unit tests and 9 smoke tests. `npm run check:i18n` passes.
- Before/after images are in [docs/ui-audit/](ui-audit/).

---

## P2: proposals

**Outdoor readability**
- **P2-1. Key arrival info at 11.5–12.5 px.**
  - The LIVE/ΠΡΟΓΡ. flag and the timetable time are `.72rem`: [web/css/arrivals.css:74](../web/css/arrivals.css:74), [:78](../web/css/arrivals.css:78).
  - Other small text:
    - `.atile-usual` 12.5 px ([:79](../web/css/arrivals.css:79))
    - `.nb-flag` / `.nb-leave` ([web/css/nearby.css:67](../web/css/nearby.css:67), [:105](../web/css/nearby.css:105))
    - row badges 11 px ([web/app.css:330](../web/app.css:330))
  - Raise these to `--fs-sm` (13 px), keeping weight and tracking.
- **P2-2. Toast action fails in both themes** (1.4.3).
  - The toast is 85% translucent: light `#8ab4f8` measures 3.8:1 and dark `#1a73e8` 2.9:1. This affects the «Ξανά» and «Άνοιγμα» actions.
  - Fix: an opaque toast and dark `--toast-action: #185abc`. See [web/app.css:268](../web/app.css:268), [:281](../web/app.css:281), [web/css/tokens.css:16](../web/css/tokens.css:16), [:52](../web/css/tokens.css:52), [:63](../web/css/tokens.css:63).
- **P2-3. Text inputs and the select have no visible boundary** (1.4.11).
  - Borders measure 1.1–1.27:1 on the lines search, report, settings select and planner fields.
  - Fix: add a field-only token `--field-border` (`#80868b` light / `#6b7076` dark).
  - See [web/css/extras.css:46](../web/css/extras.css:46), [:65](../web/css/extras.css:65), [web/css/report.css:10](../web/css/report.css:10), [web/css/planner.css:24](../web/css/planner.css:24).
- **P2-4. Sheet drag handle nearly invisible** (1.4.11).
  - It measures 1.19 (light) / 1.27 (dark).
  - Fix: use `--field-border` at rest. See [web/app.css:211](../web/app.css:211).
- **P2-5. Planner hero delay line** at `--text-2` with `opacity: .8` on accent-soft measures 3.5:1.
  - Fix: drop the opacity. See [web/css/planner.css:113](../web/css/planner.css:113).
- **P2-6. Stop "⋯" menu items show focus only as a 1.1:1 background tint** (2.4.7).
  - Fix: add an inset outline. See [web/css/arrivals.css:20](../web/css/arrivals.css:20).

**Tap targets**
- **P2-7. Primary controls under 44 px** (all pass the 24 px AA minimum; this is 2.5.5 AAA / Apple HIG, and matters one-handed). Measured sizes:
  - refresh 36×36 ([web/css/arrivals.css:111](../web/css/arrivals.css:111))
  - filter chips 40 tall ([:45](../web/css/arrivals.css:45))
  - `.stopv-small` 36 tall, including the banner retry ([:31](../web/css/arrivals.css:31))
  - «Βρες τη στάση μου» 40 tall ([web/css/nearby.css:35](../web/css/nearby.css:35))
  - «Περισσότερα» summary 28 tall ([:37](../web/css/nearby.css:37))
  - hero stop link 19 tall ([:78](../web/css/nearby.css:78))
  - `.nb-stop-name` 21 tall ([:99](../web/css/nearby.css:99))
  - Fix: grow only the hit area with `::before { inset: -4px }` or padding plus a negative margin.

**LIVE vs scheduled**
- **P2-8. No on-screen legend for LIVE vs ΠΡΟΓΡ., and ″-for-seconds is unexplained** on the stop view.
  - It is explained only in Settings → Σχετικά, the Guide and the planner's ⋯ menu.
  - Fix: a one-time quiet footer line, or a `title`/`aria-describedby` on the flag. See [web/js/arrivals-view.js:40](../web/js/arrivals-view.js:40).

**Screen reader / keyboard**
- **P2-9. Compact symbols are spoken** (′ ″ ≈ <):
  - «συνήθως +4′» ([web/js/api.js:317](../web/js/api.js:317))
  - nearby live region and row names ([web/js/nearby.js:142](../web/js/nearby.js:142), [:466](../web/js/nearby.js:466), [:548](../web/js/nearby.js:548))
  - stop footer «ανανέωση σε 17″» and «Νέα προσπάθεια σε 5″» ([web/js/arrivals-view.js:315](../web/js/arrivals-view.js:315), [:326](../web/js/arrivals-view.js:326))
  - bus view «≈ 22:25 σε <1′» ([web/js/bus-view.js:95](../web/js/bus-view.js:95), [:259](../web/js/bus-view.js:259), [:288](../web/js/bus-view.js:288))
  - line view «~46′» ([web/js/lines-view.js:197](../web/js/lines-view.js:197))
  - Fix: in labels and live regions use `etaSay`, `a.spoken`, or new spoken keys.
- **P2-10. MapLibre's English names leak into the Greek UI.**
  - Markers become `aria-label="Map marker"` (this overwrites Greek marker labels), and the attribution toggle reads "Toggle attribution".
  - Fix: pass `locale` to `new maplibregl.Map`, and re-label after `addTo`.
  - See [web/js/map.js:91](../web/js/map.js:91), [:357](../web/js/map.js:357), [:436](../web/js/map.js:436), [:532](../web/js/map.js:532), [:597](../web/js/map.js:597).
  - Related: #27.
- **P2-11. `t('live')` and literal `'LIVE'` bypass i18n.**
  - The Greek bus view reads «22:26 σε 1′ live».
  - `check:i18n` misses these because the keys contain no Greek.
  - See [web/js/bus-view.js:261](../web/js/bus-view.js:261), [:103](../web/js/bus-view.js:103), [web/js/places.js:163](../web/js/places.js:163).
- **P2-12. Focus lost or misplaced on navigation** (2.4.3).
  - Choosing a menu link leaves focus on `<body>`.
  - Choosing a search result leaves focus on the unnamed `#sheet-body`.
  - «Κοινοποίηση»/«Οδηγίες» in the ⋯ menu drop focus.
  - Fix: focus the new view's `h1` (`tabindex=-1`). See [web/js/app.js:818](../web/js/app.js:818), [:124](../web/js/app.js:124), [web/js/arrivals-view.js:146](../web/js/arrivals-view.js:146).
- **P2-13. Stop rows and search options have noisy names.**
  - Example: «Ερμού #437 601 606 607 608 609 120 μ». The "#" is read as «δίεση», the line numbers have no context, and «μ» is read as a letter.
  - Fix: `aria-label` with «{name}, στάση {code}, γραμμές {lines}». See [web/js/app.js:67](../web/js/app.js:67), [:368](../web/js/app.js:368).
- **P2-14. The nearby card's screen-reader summary always says «Δεν υπάρχουν προσεχή δρομολόγια κοντά σου.»**
  - It says this even on a load failure, while loading, or with no service.
  - See [web/js/nearby.js:361](../web/js/nearby.js:361), [:540](../web/js/nearby.js:540).
- **P2-15. The bus view's live summary is re-inserted with the same text every ~5 s,** so it is re-announced.
  - See [web/js/bus-view.js:157](../web/js/bus-view.js:157), [:288](../web/js/bus-view.js:288).
- **P2-16. The onboard ("Κατεβαίνεις") card is rebuilt as a new `role=status` on every poll and GPS fix.**
  - It is re-announced each time, and focus on «Τέλος» is lost.
  - See [web/js/onboard.js:129](../web/js/onboard.js:129), [:262](../web/js/onboard.js:262).
- **P2-17. Planner suggestions use `role=listbox`, but the items are buttons and paragraphs** (4.1.2).
  - Fix: use `role=group`. See [web/js/planner-view.js:217](../web/js/planner-view.js:217).
- **P2-18. Ambiguous control names** (2.4.6):
  - Two «Ορισμός»/«Αλλαγή» buttons (Σπίτι and Δουλειά).
  - Five «Περισσότερα» info buttons.
  - The line-view h2 contains its info button.
  - See [web/js/places.js:284](../web/js/places.js:284), [web/js/settings-view.js:63](../web/js/settings-view.js:63), [web/js/lines-view.js:139](../web/js/lines-view.js:139).
- **P2-19. «Ελληνικά» / «English» options have no `lang`,** so each is spoken by the wrong voice (3.1.2).
  - See [web/js/settings-view.js:110](../web/js/settings-view.js:110).
- **Copy bug.** The nearby card reads «Το 601 σε τώρα φεύγει πριν φτάσεις στη στάση.» / "The 601 in now leaves…": the "σε {when}" template breaks when `when` is "τώρα".
  - See [web/js/nearby.js:398](../web/js/nearby.js:398). Counted under P2-9.

## P3: polish

**Contrast and colour**
- **`--text-2` only just passes in sunlight:** 5.2:1 over sea. It carries «Στάση 1011», the refresh footer and the header icons.
  - Fix: `#55595e` light / `#a8aeb4` dark.
  - See [web/css/tokens.css:4](../web/css/tokens.css:4), [:46](../web/css/tokens.css:46), [:57](../web/css/tokens.css:57).
- **Forced colours lose the at-a-glance cues:**
  - the LIVE dot disappears;
  - live and scheduled stripes become the same;
  - the selected chip looks like the others.
  - The text labels remain.
  - Fix: `@media (forced-colors: active)` rules. See [web/css/arrivals.css:47](../web/css/arrivals.css:47), [:68](../web/css/arrivals.css:68), [:87](../web/css/arrivals.css:87).
- **Light `theme-color` mismatch:** the meta is `#ffffff`, while the manifest and body use `#f6f7f9`.
  - See [web/index.html:7](../web/index.html:7), [web/manifest.webmanifest:11](../web/manifest.webmanifest:11).

**Tap targets and gestures**
- **Secondary controls under 44 px:**
  - `.ex-info` 40×40
  - `.ex-btn-sm` 36 tall
  - `.lines-stop-link` 30 tall
  - See [web/css/extras.css:43](../web/css/extras.css:43), [:120](../web/css/extras.css:120), [:240](../web/css/extras.css:240).
- **No `touch-action: manipulation` on controls.** Fast repeated taps can trigger double-tap zoom on iOS.
  - See [web/app.css:12](../web/app.css:12).

**Arrival states**
- **`noService` and "empty but in service" look the same.** Nearby already tells them apart.
  - Fix: use «Δεν υπάρχει εξυπηρέτηση αυτή την ώρα» when `noService`. See [web/js/arrivals-view.js:262](../web/js/arrivals-view.js:262).
- **Line view: the terminal-departures status announces «Ενημερώθηκε πριν 20″» and then «…μόλις τώρα» on every poll.**
  - See [web/js/lines-view.js:135](../web/js/lines-view.js:135), [:209](../web/js/lines-view.js:209).
- **Line view: the terminal-departures error has no retry.**
  - See [web/js/lines-view.js:202](../web/js/lines-view.js:202).

**LIVE vs scheduled**
- **Visible «LIVE»/«ΠΡΟΓΡ.» flags outside the tiles are read literally.**
  - Fix: `aria-hidden` plus a visually-hidden «ζωντανά»/«προγραμματισμένο».
  - See [web/js/nearby.js:380](../web/js/nearby.js:380), [web/js/settings-view.js:247](../web/js/settings-view.js:247), [web/js/guide-view.js:77](../web/js/guide-view.js:77), [web/js/planner-view.js:430](../web/js/planner-view.js:430).
- **The Settings legend's «ΠΡΟΓΡ.» chip has no clock icon,** unlike everywhere else.
  - See [web/js/settings-view.js:250](../web/js/settings-view.js:250).

**Screen reader / keyboard**
- **Filter chips are named only by number ("609").**
  - Fix: use t('Γραμμή {code}'). See [web/js/arrivals-view.js:242](../web/js/arrivals-view.js:242).
- **The search listbox still has section headers as children** (`role=presentation`).
  - Fix: wrap each section in a `role=group`. See [web/js/app.js:380](../web/js/app.js:380), [:395](../web/js/app.js:395), [:404](../web/js/app.js:404), [:409](../web/js/app.js:409).
- **Menu semantics without menu keyboard support:**
  - `#menu-btn` has `aria-haspopup="true"`;
  - the stop ⋯ menu uses `role=menu` but has no arrow keys;
  - the theme radios have no arrow keys.
  - See [web/index.html:59](../web/index.html:59), [web/js/app.js:353](../web/js/app.js:353), [:174](../web/js/app.js:174), [web/js/arrivals-view.js:146](../web/js/arrivals-view.js:146).
- **The sheet handle says «κλειστός» while the peek card is visible.**
  - Fix: «συμπτυγμένος» (the English is already "collapsed"). See [web/js/sheet.js:12](../web/js/sheet.js:12).
- **No `<main>` landmark or skip link, and the map canvas is the first Tab stop.**
  - See [web/index.html:56](../web/index.html:56), [:79](../web/index.html:79), [web/js/map.js:109](../web/js/map.js:109).
- **Heading structure:**
  - the planner has no h1 ([web/js/planner-view.js:92](../web/js/planner-view.js:92));
  - Settings jumps from h1 to h3 ([web/js/settings-view.js:254](../web/js/settings-view.js:254), [web/js/places.js:299](../web/js/places.js:299));
  - the line-view h1 omits the line number ([web/js/lines-view.js:155](../web/js/lines-view.js:155)).
- **The nearby visually-hidden live region is also read when browsing,** so the summary is heard twice.
  - See [web/js/nearby.js:168](../web/js/nearby.js:168).
- **Toast actions vanish after 7 s** (2.2.1).
  - See [web/js/ui.js:85](../web/js/ui.js:85).

**Web Interface Guidelines**
- No `translate="no"` on line badges or the brand ([web/js/ui.js:89](../web/js/ui.js:89)).
- External links open a new tab without saying so ([web/js/settings-view.js:256](../web/js/settings-view.js:256)).
- Notification text «σε ~1′» ([web/js/onboard.js:148](../web/js/onboard.js:148), [:251](../web/js/onboard.js:251)).
- «+ Προσθήκη τόπου» is read as «συν» ([web/js/places.js:296](../web/js/places.js:296)).
- Straight apostrophes in the English copy, e.g. [web/js/i18n-en.js:287](../web/js/i18n-en.js:287).

## Checked and fine

**Contrast and theming**
- Dark theme: every text token is ≥ 5.08:1. The only dark failures were the line badges (P1-1) and the toast action (P2-2).
- `color-scheme` is correct per theme, even when the theme is forced against the OS.
- The native `<select>` has explicit colours.
- `tabular-nums` is on every countdown and clock.
- The 3 px focus ring is ≥ 3.89:1 everywhere.
- Icons are ≥ 3:1.
- No zoom lock, and reduced motion is respected.

**Layout**
- No horizontal overflow at 360 px in any state or language.
- The sheet body has `overscroll-behavior: contain`.

**Tap targets**
- Menu, search, clear and locate are 48 px.
- Star, ⋯ and close are 44 px.
- Tiles are 72–114 px tall.
- The handle is a 360×44 button with arrow keys.

**Screen reader and keyboard**
- Tile focus survives the 20 s refresh.
- The footer countdown is not a live region.
- Loading strings end in "…".
- The favourites star uses `aria-pressed` with a state-dependent label.
- `html lang` and the document title follow the language and the view.
- The welcome dialog is a proper modal.
- The report form has labels, alert errors, and moves focus to the first error.
- No click handlers on `div`/`span`.
- `check:i18n` passes.
