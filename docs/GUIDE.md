# In-app guide + install tutorial: contract

Goal: one minimal in-app guide (`#/guide`) that tells a new user **what Telematica is**, **how to use it** and
**where to tap for what**, and that detects how the app is running (installed app vs browser tab, iOS vs Android)
to show the **right "add to home screen" tutorial**, or none when it is already installed.
Binding rules: `docs/DESIGN.md` (springs, materials, press feedback, reduced motion), CLAUDE.md (vanilla JS, no build,
relative paths, SW SHELL list), i18n (every Greek `t('…')` literal has an English pair).

Three parts, three owners, **no shared files**. Names below are the contract: other parts import them blind.

## Part A: platform detection + install tutorial
Files: `web/js/platform.js`, `web/js/install-guide.js`, `web/css/install.css`, `web/js/i18n-en-install.js`,
`tests/platform.test.mjs`.

- `platform.js` (pure, no DOM at import, node-testable):
  `detectPlatform({ ua, platform, maxTouchPoints, standalone, displayModeStandalone, hasInstallPrompt })` →
  `{ os: 'ios'|'android'|'other', mode: 'app'|'browser', browser: 'safari'|'chrome'|'firefox'|'edge'|'samsung'|'inapp'|'other', canPrompt: boolean }`.
  `standalone` = `navigator.standalone` (iOS), `displayModeStandalone` = `matchMedia('(display-mode: standalone)')`
  (also `fullscreen`/`minimal-ui`/`window-controls-overlay` count as app). iPadOS reports `MacIntel` + touch → `ios`.
  In-app browsers (Instagram, Facebook, Messenger, TikTok, LinkedIn, Gmail/Google app webviews, generic `; wv)`) → `inapp`.
  Plus `currentPlatform()` that reads the real globals (safe when they are missing).
- `install-guide.js`:
  - `captureInstallPrompt()`: idempotent; listens for `beforeinstallprompt` (preventDefault, keep the event) and
    `appinstalled`. Called once, early, by app.js.
  - `renderInstallSection()` → an `HTMLElement` (`<section class="install">`) with the tutorial for the detected case:
    - **installed app** (any OS): one short line confirming it is installed (no steps);
    - **iOS Safari**: Share button → "Add to Home Screen" → Add (numbered steps with small inline SVG glyphs that look
      like the real Share icon / plus-square);
    - **iOS other browser** (Chrome/Firefox/Edge on iOS ≥ 16.4 also have Share → Add to Home Screen; say so, with
      "or open in Safari" as fallback);
    - **iOS / Android in-app browser**: "open this page in Safari / Chrome first" (+ a copy-link button);
    - **Android with `canPrompt`**: a single "Install" button that calls the saved prompt;
    - **Android Chrome/Edge without prompt**: ⋮ menu → "Install app" / "Add to Home screen";
      **Samsung Internet**: ≡ menu → "Add page to" → "Home screen"; **Firefox**: ⋮ → "Install";
    - **desktop/other**: one line (install icon in the address bar, or just bookmark) — keep it short.
    Also mention why install is worth it in one line (full screen, quick launch, and on iPhone push reminders only
    work in the installed app).
  - `installHint()` → `null` or `{ os, browser }` when an install suggestion makes sense (mobile + browser mode).
  All own icons are inline SVG inside the module (do not edit `ui.js`).

## Part B: guide content + view
Files: `web/js/guide-view.js`, `web/css/guide.css`, `web/js/i18n-en-guide.js`, `tests/guide.test.mjs`.

- `mountGuide(el, ctx)` (same mount style as `settings-view.js`, returns `{ destroy }` or whatever the other views
  return): renders into `el`. Sections, short and scannable, in this order:
  1. **What it is**: Telematica = live arrivals of city buses (Patras, Corfu); the key idea **LIVE vs ΠΡΟΓΡ.**
     (a tracked bus vs a timetable entry), with the real tile look.
  2. **Install as app**: `ctx.renderInstall?.()` returns an element (Part A's section) or nothing; insert it if given.
     When the URL has `?section=install`, scroll that section into view on mount.
  3. **How to use**: find a stop (map, search, "next bus near you"), read arrivals, plan a trip and "Leave in N′",
     lines and a line's route, favorites, reminders and weekly routines, on-board "wake me" alert, offline map,
     switching city and language. One or two sentences each.
  4. **Where to tap for what**: a compact list "control → what it does" with the app's real icons
     (`icon(name)` and `h()` from `ui.js`, read-only) for menu, search, locate, star, share, bell, etc.
  Each section collapsible or simply stacked; follow DESIGN.md (materials, typography tokens, press feedback,
  reduced motion). Back button like the other views (`ctx`/`cityHash` patterns from settings-view.js).
- Use the real current UI as the source of truth (read `app.js`, `arrivals-view.js`, `planner-view.js`,
  `lines-view.js`, `settings-view.js`, `nearby.js`, `onboard.js`, `routines.js`, `notify.js`); never describe a
  feature that does not exist.

## Part C: integration
Files: `web/js/app.js`, `web/index.html`, `web/sw.js`, `web/js/store.js`, `web/js/settings-view.js`,
`web/js/i18n-en.js` (its own new strings only), `docs/ARCHITECTURE.md`, `tests/` for its own changes
(e.g. `tests/guide-route.test.mjs`, `tests/store.test.mjs`).

- Route `#/guide` (also with city prefix and `?section=install`): mounts `guide-view.js` via the same `mount()`
  pattern; `ctx.renderInstall = () => installModule.renderInstallSection()` (dynamic import of `install-guide.js`).
  SNAP for `guide`: `full`.
- Entry points: menu popover item "Οδηγός" (above Settings), a row in Settings ("Οδηγός χρήσης" and, when
  `installHint()` is non-null, "Εγκατάσταση ως εφαρμογή" → `#/guide?section=install`).
- First run: when the store has no `guideSeen`, show once a small dismissible material card/pill in the sheet's peek
  ("Πρώτη φορά εδώ; Δες τον οδηγό") → opens `#/guide`, sets `guideSeen`. Separately, on mobile **browser** mode
  (`installHint()` non-null) and not dismissed before (`installHintDismissed`), a one-time hint to install.
  Never both at once; never on the first frame of a deep link (`#/stop/…`).
- Call `captureInstallPrompt()` early at boot (dynamic import is fine; must not delay first paint).
- `index.html`: link `css/guide.css` and `css/install.css`. `sw.js`: bump `CACHE`, add `js/guide-view.js`,
  `js/platform.js`, `js/install-guide.js`, `css/guide.css`, `css/install.css` to SHELL.
- `store.js`: settings keys `guideSeen` (bool) and `installHintDismissed` (bool), validated like the others.
