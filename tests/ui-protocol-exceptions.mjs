// TEL-269: what breaks the UI protocol today (docs/UI-PROTOCOL.md), with the reason. The checks
// (tests/ui-protocol.test.mjs and tests/e2e/ui-protocol.spec.mjs) fail on a break that is NOT listed here, and on a
// listed one that no longer breaks: every PR of block B0.5 that fixes something removes its line. Empty = v1.
// Never add a line to make a PR pass without saying why in the PR (UI-PROTOCOL "Changing the rules").
// Starting list: 2026-11-09, branch claude/TEL-83-glass-prototype after TEL-268.

// Static checks: rule → { 'file: selector { property }': reason }
export const STATIC_EXCEPTIONS = {
  U3: {
    'css/home.css: .hm-place .btn.round.g-circle { width }': 'Places are 48 px circles (Apple size for Places), not the card\'s 38',
    'css/home.css: .hm-place .btn.round.g-circle { height }': 'same',
    'css/home.css: .hm-place .btn.round.g-circle .icon { width }': 'same: a 22 px icon',
    'css/home.css: .hm-place .btn.round.g-circle .icon { height }': 'same',
  },
  U8: {
    'app.css: .app:has(.sheet-search:not([hidden])) .menu-fab { top }': '☰ moves 6 px down up (TEL-223) with top, not translateY',
    'css/glass.css: html.glass .sheet::before { left }': 'the card goes edge to edge up with left/right/bottom of its glass layer (nothing inside moves)',
    'css/glass.css: html.glass .sheet::before { right }': 'same',
    'css/glass.css: html.glass .sheet::before { bottom }': 'same',
    'css/glass.css: html.glass .sheet-search { padding-left }': 'the search field makes room for ☰ up with padding (TEL-223)',
    'css/glass.css: html.glass .stopv-chip[data-key="*"] { max-width }': 'the stop\'s chips fold into badges at low with sizes and gaps, not with scale (TEL-227)',
    'css/glass.css: html.glass .stopv-chip[data-key="*"] { padding-inline }': 'same',
    'css/glass.css: html.glass .stopv-chip[data-key="*"] { margin-right }': 'same',
    'css/glass.css: html.glass .stopv-chip[data-key="*"] { border-width }': 'same',
    'css/glass.css: html.glass .sheet .stopv-chip { flex-grow }': 'same',
    'css/glass.css: html.glass .sheet .stopv-chips { margin-right }': 'same',
    'css/glass.css: html.glass .sheet .stopv-chips { gap }': 'same',
    'css/glass.css: html.glass .sheet .stopv-chip:not([data-key="*"]) { padding-inline }': 'same',
    'css/glass.css: html.glass .sheet .stopv-chip[data-key="*"] { margin-right }': 'same',
  },
  U19: {
    'app.css: .view-head h1': 'old header (favourites): not on the kit\'s .card-head yet',
    'css/extras.css: .ex-head h1': 'old header (lines, line, bus, settings, report): not on the kit\'s .card-head yet',
  },
};

// Browser checks: view → { rule: reason }. Views: home, stop, lines, line, bus, favorites, settings, report; and
// "stop-long" for the stop with the longest name (826), "chrome" for what sits over the map in every view.
const OLD_HEAD = 'old header (.ex-head / .view-head), not the kit\'s .card-head yet';
const OLD_INSET = 'content 24 px from the card at low/mid, 32 up: its own 16 px on top of the sheet\'s';
export const VIEW_EXCEPTIONS = {
  home: {
    U2: 'the Places row starts 8 px from the card\'s edge at low/mid (its scroller reaches out 10 px so a held circle is not cut)',
    U3: 'Places are 48 px circles (see the static U3)',
    U4: 'home has no title row: the search field heads it (Apple Maps does the same; the rule may need a home case)',
    U5: 'same: low is the search row',
  },
  stop: {
    U2: 'up, the card is edge to edge but .sheet-inset keeps its 8 px: 24 px from the edge (ui-kit.css)',
    U20: 'low: the invisible chip bar covers the header circles\' tap area; mid/up: the chips\' 44 px tap areas are cut by their scroller, and the circles\' by the chip row',
  },
  lines: { U2: OLD_INSET, U3: `back button is a .btn.round, ${OLD_HEAD}`, U4: OLD_HEAD, U5: OLD_HEAD },
  line: { U2: OLD_INSET, U3: `back button is a .btn.round, ${OLD_HEAD}`, U4: OLD_HEAD, U5: OLD_HEAD,
    U20: 'a link in the header is covered by the subtitle (p.ex-sub) at its edge' },
  bus: { U2: OLD_INSET, U3: `close button is a .btn.round, ${OLD_HEAD}`, U4: OLD_HEAD, U5: OLD_HEAD },
  favorites: { U2: 'the old .view-head starts at the card\'s edge (0 px) at low/mid, 8 px up', U3: `back button is a .btn.round, ${OLD_HEAD}`, U4: OLD_HEAD, U5: OLD_HEAD },
  settings: { U2: OLD_INSET, U3: `back button is a .btn.round, ${OLD_HEAD}`, U4: OLD_HEAD, U5: OLD_HEAD },
  report: { U2: OLD_INSET, U3: `back button is a .btn.round, ${OLD_HEAD}`, U4: OLD_HEAD, U5: OLD_HEAD },
  chrome: {
    U11: 'the toast eases its transform in .3 s (none only while dragging): a programmatic snap leaves it behind',
  },
};
