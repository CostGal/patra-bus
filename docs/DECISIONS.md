# Decisions

Product decisions by Kostas that a session cannot read from the code. Newest first. Each entry: the date, what was
decided, and what it means for the work. A decision changes only with a new entry here; the Notion card is the history.
The list of features (keep / cut / later) is the Notion card TEL-216.

## 2026-11-25: the install guide comes back, in the ☰ menu (TEL-409)
- Feedback: some users do not know how to install the app. Kostas put TEL-409 in the current block and asked for it now.
- A new build on the glass UI, not the old guide: the ☰ menu shows «Εγκατάσταση εφαρμογής» only while the app runs in a
  browser tab. It opens a full-height sheet (`#/install`) with only the steps for that phone and browser, or one
  «Εγκατάσταση» button where the browser has its own install prompt (Android Chrome, Edge, desktop).
- No banner or hint on the home screen for now; that would be its own card if the menu row is not enough.

## 2026-11-24: the glass UI goes to `main` now; phone checks and speed come after, in B1
- The glass UI (TEL-83, PR #102) is merged into `main` on 2026-11-24, so real users see it on the one link they
  already have (`costgal.github.io/patra-bus/`). No separate preview link for it.
- It ships before its phone checks. These move to Block B1 and are done after: the iPhone look and motion
  (device-test issues #103, #127, #89 and #181–#229), «Οδηγίες ως εδώ» with real GPS, and speed on a cheap Android
  (TEL-70, TEL-218). The UI protocol exception list does not need to be empty first; it keeps shrinking on `main`.
- From now on UI PRs target `main`, not the glass branch.

## 2026-11-24: the «near you» card stays, but not in this version
- The «near you» card (`web/js/nearby.js`: the next bus at the stops around you, live) is kept, but it does not come
  back on the glass home in this version and does not go into `main` now. Where and how it shows is discussed in the
  feature list (TEL-216, #24).
- Until then the code and its tests stay as they are, not mounted. On the glass home, the empty search shows
  «Κοντινές στάσεις» (up to 4 stops within 800 m, without live times).

## 2026-11-21: the lines list and the line page are removed until they are planned
- The lines list (☰ → «Γραμμές», `#/lines`) and the line page (`#/line/{code}`) are removed (card TEL-248). They are hard
  to add and manage well, so they need a proper plan first. In the feature list (TEL-216) #5 is now «Αργότερα».
- What changed for the user: no «Γραμμές» in the menu or in the installed app's shortcuts; on a stop, a scheduled bus
  («ΠΡΟΓΡ.») is no longer a link (a live bus still opens the vehicle page); an old link to a line opens the home.
- They come back only with their own plan and card, as a new build on the glass UI (`docs/UI-PROTOCOL.md`), not as a
  revert of TEL-248.

## 2026-11-12: the trip planner's spare time before the bus is a fixed 2 minutes
- In the new trip planner the spare time before the bus is a fixed 2 minutes and is not read from Settings (card
  TEL-290, `LIMITS.bufferSec` in `web/js/trip.js`). The spare-time setting is a feature to rework later, in the B1 Block.

## 2026-11-11: Telematica is a navigation app for the bus; the trip planner is a beta feature
- **Direction.** The app should feel like a navigation app, as Google Maps and Apple Maps do, but focused on travelling
  by bus instead of travelling in general: you say where you are going and it takes you there by bus.
- **Trip planning from A to B by bus is in the beta.** The planner was removed in TEL-217 through a miscommunication,
  not because it is unwanted. It comes back as a new build on the glass UI (`docs/DESIGN.md` §4 and §10,
  `docs/UI-PROTOCOL.md`), with its own card, plan and PR, in its own session. It is not a revert of TEL-217.
- **Until then** the stop's "Οδηγίες ως εδώ" pill shows only the walk from where you are to that stop (glass branch,
  PR #102). Kostas finds that too little as it is; the planner replaces it.
- **The other cuts were a clean slate.** Routines, push reminders, the get-off alert ("Θα κατέβω σε…"), the offline map
  download, the old guide and the install hint were cut on purpose, more widely than what will stay cut in the end.
  Some may return. None returns without its own entry here and its own card: "it existed before" is not a reason to
  rebuild it, and "it was cut" is not a reason to refuse it.
