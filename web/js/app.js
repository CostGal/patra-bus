// App shell and integrator (owner: shell). Boots data + map + sheet, wires location, search, theme and the hash router.
// Views are lazy-loaded modules with `mountX(container, ctx, params) -> { destroy() }` (docs/ARCHITECTURE.md).
import './boot-city.js'; // must stay first: picks the active city before any other module reads it
import { h, icon, toast, lineBadge } from './ui.js';
import { loadData, searchStops } from './data.js';
import { bootScreen } from './boot.js';
import { createMap } from './map.js';
import { createSheet } from './sheet.js';
import { createSpringLoop } from './motion.js';
import locationService from './location.js';
import { DEMO, fetchLive } from './api.js';
import { getRecents, addRecent, getFavorites, getSettings, setSetting, onChange } from './store.js';
import { t, tn, N_, onLangChange, lang, APP_NAME } from './i18n.js';
import { CITIES, city, cityId, cityName, isCity, setActiveCity } from './cities.js';
import { cityToOffer } from './city-detect.js';
import { parseHash, formatHash, cityHash } from './route.js';
import { searchPlaces, withoutShownStops } from './geocode.js';
import { searchKey } from './text.js';
import { haversine, fmtDist, nearestStops, inArea } from './geo.js';
import './notify.js'; // re-arms persisted reminders after a reload

// Was the page opened on the home view (not a deep link)? Only then the first-run setup may appear.
const bootHome = parseHash(location.hash).path === '/';
// First-run setup (js/setup.js, TEL-74): fetched in parallel with boot, opened just before the first route.
const setupP = import('./setup.js').catch(() => null);

const $ = (id) => document.getElementById(id);
const root = document.documentElement;
const appEl = $('app');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const darkMQ = matchMedia('(prefers-color-scheme: dark)');
const title = () => `${APP_NAME} · ${cityName(city(), lang())}`;
const pinName = () => t('Επιλεγμένο σημείο');

let data = null;
let map = null;
let sheet = null;
let ctx = null;

// ---------------------------------------------------------------- theme
const themeMetas = [...document.querySelectorAll('meta[name="theme-color"]')];
const themeMetaOrig = themeMetas.map((m) => m.content);
const resolveTheme = () => {
  const t = getSettings().theme;
  return t === 'dark' || (t !== 'light' && darkMQ.matches) ? 'dark' : 'light';
};
function applyTheme() {
  const t = getSettings().theme;
  if (t === 'light' || t === 'dark') root.dataset.theme = t;
  else delete root.dataset.theme;
  themeMetas.forEach((m, i) => { m.content = t === 'dark' ? '#1e2227' : t === 'light' ? '#ffffff' : themeMetaOrig[i]; });
  map?.setTheme(resolveTheme());
  paintThemeRow();
}

// ---------------------------------------------------------------- small helpers
const parsePt = (s) => {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(s || '');
  return m ? { lat: Number(m[1]), lng: Number(m[2]) } : null;
};
const pinHash = (to) => cityHash(`#/pin?lat=${to.lat.toFixed(5)}&lng=${to.lng.toFixed(5)}`);
// The trip to a stop or a place (TEL-294). City-relative. Only the destination is in it, never the start (CLAUDE.md rule 6).
const tripHash = (dest) => {
  if (dest.stopCode != null) return `#/trip?stop=${encodeURIComponent(String(dest.stopCode))}`;
  const name = String(dest.name || '').trim().slice(0, 80);
  return `#/trip?lat=${dest.lat.toFixed(5)}&lng=${dest.lng.toFixed(5)}${name ? `&name=${encodeURIComponent(name)}` : ''}`;
};
const msgEl = (text) => h('p', { class: 'state-msg' }, text);
const errorState = (text, retry) => h('div', {}, msgEl(text), h('button', { type: 'button', class: 'btn primary', onclick: retry }, t('Δοκίμασε ξανά')));
const backBtn = (to = '#/') => h('a', { class: 'btn round', href: cityHash(to), 'aria-label': t('Πίσω') }, icon('back'));

function lineBadges(stop, max = 6) {
  return stop.lineCodes.slice(0, max).map((c) => lineBadge(data.lineByCode.get(c) || { code: c }));
}
function stopRow(stop, meters) {
  return h('a', { class: 'stop-row', href: cityHash(`#/stop/${encodeURIComponent(stop.code)}`) },
    h('span', { class: 'stop-ico' }, icon('bus')),
    h('span', { class: 'stop-main' },
      h('div', { class: 'stop-name' }, stop.displayName),
      h('div', { class: 'stop-meta' }, `#${stop.code}`, lineBadges(stop))),
    meters != null ? h('span', { class: 'stop-dist' }, fmtDist(meters)) : null,
    h('span', { class: 'chev' }, icon('chevron')));
}
function placeRow(p) {
  return h('a', { class: 'stop-row', href: cityHash(tripHash({ lat: p.lat, lng: p.lng, name: p.name })) },
    h('span', { class: 'stop-ico' }, icon('pin')),
    h('span', { class: 'stop-main' },
      h('div', { class: 'stop-name' }, p.name),
      p.subtitle ? h('div', { class: 'stop-meta' }, p.subtitle) : null),
    h('span', { class: 'chev' }, icon('chevron')));
}
// Recents come from store.js as loose objects: stops {code,…} (or just a code), places {name,subtitle,lat,lng}.
function recentStops(limit = 5) {
  const seen = new Set();
  const out = [];
  for (const r of getRecents('stop')) {
    const code = String(r?.code ?? r?.id ?? r);
    const stop = data.stopByCode.get(code);
    if (stop && !seen.has(code)) { seen.add(code); out.push(stop); }
    if (out.length >= limit) break;
  }
  return out;
}
function recentPlaces(limit = 4) {
  return getRecents('place').filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && p.name).slice(0, limit);
}
const noteStop = (stop) => addRecent('stop', { code: stop.code, name: stop.displayName });

// ---------------------------------------------------------------- popovers
// Scale/fade from the trigger (DESIGN.md §3): transform-origin at the button, not the popover's centre.
// Driven by the shared spring (§2: "popovers" are explicitly in the spring list, not a fixed-duration
// transition), so a quick re-tap while it's still closing reverses from exactly where it is, no jump.
const SETTLE = { damping: 1, response: 0.35 }; // DESIGN.md §2 default for UI moves
function popOrigin(btn, pop) {
  const br = btn.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  pop.style.transformOrigin = `${br.left + br.width / 2 - pr.left}px ${br.top + br.height / 2 - pr.top}px`;
}
const pops = [];
function makePopover(btn, pop) {
  let v = 0; // 0 hidden .. 1 shown
  const paint = (val) => { pop.style.opacity = String(val); pop.style.transform = `scale(${0.86 + 0.14 * val})`; };
  const loop = createSpringLoop({
    get: () => v,
    set: (val) => { v = val; paint(val); },
    onSettle: () => { if (v < 0.5) pop.hidden = true; },
  });
  const onDown = (e) => { if (!pop.contains(e.target) && !btn.contains(e.target)) close(false); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(true); } };
  function close(focusBtn) {
    if (pop.hidden) return;
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    if (focusBtn) btn.focus();
    if (reduceMotion.matches) { loop.stop(); v = 0; paint(0); pop.hidden = true; return; }
    popOrigin(btn, pop);
    loop.to(0, SETTLE);
  }
  function open() {
    pops.forEach((p) => p.close(false));
    pop.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    (pop.querySelector('[aria-checked="true"], [aria-current="page"], a, button'))?.focus();
    popOrigin(btn, pop);
    if (reduceMotion.matches) { loop.stop(); v = 1; paint(1); return; }
    loop.to(1, SETTLE);
  }
  const p = { open, close };
  pops.push(p);
  pop.addEventListener('click', (e) => { if (e.target.closest('a, button:not([data-keep])')) close(false); });
  return p;
}
// Press feedback (DESIGN.md §1): `.sb-btn` has no :active rule of its own. app.css's shared `.press`
// utility (scale .97 on :active, instant down / eased up) covers it — just opt the trigger in.
function pressable(btn) { btn.classList.add('press'); }

// ---------------------------------------------------------------- menu popover (navigation + map theme)
const menuBtn = $('menu-btn');
const menuPop = $('menu-pop');
let menuPopover;

const THEMES = [['auto', 'layers', N_('Αυτόματο')], ['light', 'sun', N_('Φωτεινό')], ['dark', 'moon', N_('Σκοτεινό')]];
function buildMenu() {
  const item = (href, ico, label) => h('a', { class: 'pop-item', href: cityHash(href) }, icon(ico), label);
  menuPop.replaceChildren(
    // The active city, one tap from the picker in the settings.
    h('a', { class: 'pop-item pop-city', href: cityHash('#/settings') }, icon('pin'),
      h('span', { class: 'pop-city-name' }, cityName(city(), lang())), h('span', { class: 'pop-city-sub' }, t('Αλλαγή πόλης'))),
    h('div', { class: 'pop-sep' }),
    item('#/', 'home', t('Αρχική')),
    item('#/favorites', 'star', t('Αγαπημένες στάσεις')),
    h('div', { class: 'pop-sep' }),
    h('div', { class: 'pop-head', id: 'theme-label' }, t('Θέμα')),
    // TEL-253 (UI-PROTOCOL U25): one pick-one row, the chosen theme under the glass lens (js/glass.js: bar[data-lens] >
    // row > chip). paintThemeRow fills the row.
    h('div', { class: 'theme-bar', 'data-lens': true },
      h('div', { class: 'theme-row', role: 'radiogroup', 'aria-labelledby': 'theme-label' })),
    h('div', { class: 'pop-sep' }),
    item('#/report', 'bug', t('Αναφορά προβλήματος')),
    item('#/settings', 'settings', t('Ρυθμίσεις και σχετικά')));
  paintThemeRow();
}
// The row is rebuilt on every paint, not only re-marked: a rebuilt row is what moves the lens (js/glass.js). Also on
// every open, since a hidden menu can't be measured. Focus that was in the row goes to the chosen theme.
// `.theme-bar > .theme-row` and not `.theme-row`: while the lens's bubble is out (a drag, a glide after a tap) it holds a
// copy of the row, first in the bar; repainting that copy would leave the real row on the old theme.
function paintThemeRow() {
  const row = menuPop.querySelector('.theme-bar > .theme-row');
  if (!row) return;
  const cur = getSettings().theme || 'auto';
  const hadFocus = row.contains(document.activeElement);
  row.replaceChildren(...THEMES.map(([value, ico, label]) => h('button', {
    type: 'button', class: 'theme-opt', role: 'radio', 'data-value': value, 'data-keep': '', 'aria-checked': String(value === cur),
    'aria-label': t(label), title: t(label), onclick: () => setSetting('theme', value),
  }, icon(ico))));
  if (hadFocus) row.querySelector('[aria-checked="true"]')?.focus({ preventScroll: true });
}

// Runs after the popover consts exist (applyTheme repaints the theme row).
applyTheme();
darkMQ.addEventListener('change', applyTheme);
onChange(applyTheme);

// ---------------------------------------------------------------- sheet <-> map/floating UI
const fabsBottom = $('fabs-bottom');
const mapAttrib = $('map-attrib');
const desktopMQ = matchMedia('(min-width: 900px)');
const toastHost = $('toasts');
const searchbarEl = $('searchbar');
// What the map re-centres on between low and mid: home = the user's location (if the map has it), a stop or a pin =
// that point (route() sets it); other views keep the map still.
let focusPt = null;
let lastSnap = null;
let routeSnap = false; // the snap comes from route(), which moves the map itself
function onSnap({ state, visible, desktop }) {
  if (!map) return;
  if (desktop) {
    map.setPadding({ top: 72, bottom: 0, left: sheet.el.offsetWidth, right: 0 });
  } else {
    const top = menuBtn.getBoundingClientRect().bottom + 8;
    map.setPadding({ top, bottom: Math.min(visible, innerHeight * 0.6), left: 0, right: 0 });
  }
  // As in Apple Maps (Kostas, TEL-222): between low and mid the map glides to centre its focus in the part left above
  // the sheet. Only once the sheet is let go (this fires when its target is chosen), never to or from full.
  const from = lastSnap;
  lastSnap = state;
  const lowMid = (from === 'peek' && state === 'half') || (from === 'half' && state === 'peek');
  // Search mode (home) centres on the user; location mode (a stop, a pin) on that point, and stops following the user,
  // or the next GPS fix would pull the map back to them (TEL-227)
  if (!desktop && lowMid && !routeSnap) {
    if (focusPt) { if (locMode !== 'idle') setLocMode('idle'); map.recenter(focusPt); }
    else if (currentHead === '') map.recenter(null);
  }
}
function onMove({ visible, lift, opacity }) {
  // the map buttons stay opaque: past mid the sheet slides over them (z-index, app.css). Fading a glass (backdrop-filter)
  // layer drew it grey for a moment on iPhone (TEL-227)
  fabsBottom.style.transform = lift ? `translateY(${-lift}px)` : '';
  mapAttrib.style.transform = visible ? `translateY(${-visible}px)` : ''; // glued to the sheet's edge, every frame, all the way up
  mapAttrib.style.opacity = String(opacity);
  mapAttrib.style.visibility = opacity < 0.05 ? 'hidden' : '';
  toastHost.style.transform = `translate(-50%, ${-lift}px)`;
}

// ---------------------------------------------------------------- locate FAB (idle -> centre -> follow -> compass)
const locateBtn = $('locate-btn');
const northBtn = $('north-btn');
const LOC_ICON = { idle: 'locate', centre: 'locate-fixed', follow: 'locate-fixed', compass: 'compass' };
const LOC_LABEL = {
  idle: N_('Εντοπισμός τοποθεσίας'), centre: N_('Ακολούθησε τη θέση μου'),
  follow: N_('Περιστροφή χάρτη με την πυξίδα'), compass: N_('Σταμάτα την περιστροφή του χάρτη'),
};
const locLabel = (m) => t(LOC_LABEL[m]);
let locMode = 'idle';
let wantFix = false; // the user asked for a location and we are waiting for the first fix
let firstFixHandled = false;
let cityOffered = false; // the "switch city?" offer is shown at most once per launch
const CITY_OFFER_MS = 15000, CITY_HINT_MS = 5000;

function paintLocLabel() {
  locateBtn.setAttribute('aria-label', locLabel(locMode));
  locateBtn.title = locLabel(locMode);
}
function setLocMode(m) {
  locMode = m;
  locateBtn.dataset.mode = m;
  paintLocLabel();
  locateBtn.replaceChildren(icon(LOC_ICON[m]));
  map?.setFollow(m === 'idle' ? 'off' : m);
}
function paintLocating() {
  locateBtn.classList.toggle('locating', wantFix || locationService.status === 'locating');
}
const LOC_ERR = {
  denied: N_('Δεν δόθηκε άδεια τοποθεσίας. Μπορείς να την ενεργοποιήσεις από τις ρυθμίσεις του προγράμματος περιήγησης.'),
  unavailable: N_('Η τοποθεσία δεν είναι διαθέσιμη αυτή τη στιγμή.'),
  insecure: N_('Η τοποθεσία χρειάζεται ασφαλή σύνδεση (https).'),
};
function onLocation(fix, status) {
  map?.setUserFix(fix);
  if (fix && wantFix) { wantFix = false; setLocMode('centre'); }
  if (!fix && wantFix && status !== 'locating' && status !== 'idle') {
    wantFix = false;
    if (status === 'timeout') toast(t('Δεν βρέθηκε η τοποθεσία σου. Δοκίμασε ξανά.'), { action: { label: t('Ξανά'), onClick: () => requestCentre() } });
    else if (LOC_ERR[status]) toast(t(LOC_ERR[status]));
  }
  // First fix of the session while browsing the home screen inside the active city: show where you are.
  if (fix && !firstFixHandled && inArea(fix)) {
    firstFixHandled = true;
    if (currentHead === '' && locMode === 'idle') map?.flyTo(fix, 15.5);
  }
  // A real GPS fix inside the other city: offer to switch (TEL-142). The check runs on the device; nothing changes unless the user taps.
  const offer = !cityOffered && cityToOffer(fix, cityId());
  if (offer) {
    cityOffered = true;
    toast(t('Βρίσκεσαι στην {city}. Να αλλάξω πόλη;', { city: cityName(CITIES[offer], lang()) }), { action: { label: t('Αλλαγή πόλης'), onClick: () => switchCity(offer) }, ms: CITY_OFFER_MS });
    // Not tapped (a tap switches the city and ends this toast): a short hint that Settings can do it later.
    setTimeout(() => toast(t('Μπορείς να αλλάξεις πόλη και από τις Ρυθμίσεις.'), { action: { label: t('Ρυθμίσεις'), onClick: () => navigate('#/settings') }, ms: CITY_HINT_MS }), CITY_OFFER_MS);
  }
  paintLocating();
}
function requestCentre() {
  locationService.start();
  const fix = locationService.current;
  if (fix) { wantFix = false; setLocMode('centre'); } else { wantFix = true; }
  paintLocating();
}
locateBtn.addEventListener('click', async () => {
  if (locMode === 'idle') requestCentre();
  else if (locMode === 'centre') setLocMode('follow');
  else if (locMode === 'follow') {
    const ok = await locationService.enableCompass(); // must run inside the click gesture (iOS)
    if (ok) setLocMode('compass');
    else toast(t('Η πυξίδα δεν είναι διαθέσιμη σε αυτή τη συσκευή.'));
  } else setLocMode('follow');
});
northBtn.addEventListener('click', () => map?.resetNorth());
function onBearing(b) {
  const off = Math.abs(b) < 1;
  northBtn.hidden = off;
  northBtn.firstChild.style.transform = `rotate(${-b}deg)`;
}
function onUserMove() { wantFix = false; setLocMode('idle'); paintLocating(); }

// ---------------------------------------------------------------- offline cue
// A persistent pill under the search bar while offline; a toast when the connection returns.
const offlinePill = h('div', { class: 'offline-pill', id: 'offline-pill', role: 'status', hidden: true },
  icon('alert'), h('span', {}, t('Εκτός σύνδεσης — δείχνω αποθηκευμένα δεδομένα')));
appEl.append(offlinePill);
let wasOffline = false;
function paintOnline(announce) {
  const off = navigator.onLine === false;
  offlinePill.hidden = !off;
  appEl.classList.toggle('is-offline', off);
  if (announce && wasOffline && !off) toast(t('Ξανά σε σύνδεση'));
  wasOffline = off;
}
window.addEventListener('online', () => paintOnline(true));
window.addEventListener('offline', () => paintOnline(true));
paintOnline(false);

// ---------------------------------------------------------------- search
const searchInput = $('search-input');
const searchPanel = $('search-panel');
const searchList = $('search-list');
const searchClear = $('search-clear');
// Search messages and the result count are spoken from here, outside the listbox (WCAG 4.1.3). The visible message
// stays where it is, aria-hidden, so nothing moves on screen.
const searchStatus = h('p', { class: 'visually-hidden', role: 'status' });
searchPanel.append(searchStatus);
let statusTimer = 0;
function sayStatus(text) {
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { if (searchStatus.textContent !== text) searchStatus.textContent = text; }, text ? 500 : 0);
}
let searchOpen = false;
let activeIdx = -1;
let rows = [];
let placeTimer = 0;
let placeCtl = null;
let places = { q: '', loading: false, results: [], failed: false };
let sheetBefore = null; // where the sheet was when the search opened (it goes up while the search is open)

// TEL-366 TEMP DEBUG (remove before merge): shows what opened the search
const dbgLog = [];
for (const ev of ['touchstart', 'touchend', 'pointerdown', 'pointerup', 'click', 'focusin', 'hashchange']) {
  document.addEventListener(ev, (e) => { dbgLog.push(`${Math.round(performance.now() % 100000)} ${ev} ${e.target?.id || e.target?.className || e.target?.tagName}`); if (dbgLog.length > 10) dbgLog.shift(); }, true);
}
function dbgShow() {
  const d = document.createElement('pre');
  d.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#000c;color:#0f0;font:10px monospace;margin:0;padding:4px;white-space:pre-wrap;pointer-events:none';
  d.textContent = `openSearch ${Math.round(performance.now() % 100000)} from ${sheet.state}\n${new Error().stack.split('\n').slice(1, 5).join('\n')}\n${dbgLog.join('\n')}`;
  document.body.append(d);
}
function openSearch() {
  if (searchOpen) return;
  dbgShow();
  searchOpen = true;
  appEl.classList.add('searching');
  sheetBefore = sheet.state;
  if (sheetBefore !== 'full') sheet.snap('full');
  searchPanel.hidden = false;
  searchInput.setAttribute('aria-expanded', 'true');
  menuPopover.close(false);
  renderSearch();
}
// restore: the user closed it (back, Escape, a tap outside), so the sheet goes back to where it was
function closeSearch(focusMenu = false, restore = false) {
  if (!searchOpen) return;
  searchOpen = false;
  clearTimeout(kbHandoff);
  if (document.activeElement === kbProxy) kbProxy.blur();
  appEl.classList.remove('searching');
  if (restore && sheetBefore && sheetBefore !== 'full' && sheet.state === 'full') sheet.snap(sheetBefore);
  sheetBefore = null;
  clearTimeout(placeTimer);
  placeCtl?.abort();
  places = { q: '', loading: false, results: [], failed: false };
  searchPanel.hidden = true;
  searchInput.value = '';
  searchInput.setAttribute('aria-expanded', 'false');
  searchInput.removeAttribute('aria-activedescendant');
  searchClear.hidden = true;
  sayStatus('');
  if (focusMenu) menuBtn.focus(); else searchInput.blur();
}

function srRow(id, ico, name, sub, choose) {
  const row = h('div', { class: 'sr', role: 'option', id, 'aria-selected': 'false' },
    h('span', { class: 'sr-ico' }, icon(ico)),
    h('span', { class: 'sr-main' }, h('div', { class: 'sr-name' }, name), sub ? h('div', { class: 'sr-sub' }, sub) : null));
  row.addEventListener('pointerdown', (e) => e.preventDefault()); // keep the keyboard / focus
  row.addEventListener('click', choose);
  rows.push({ row, choose });
  return row;
}
const stopSub = (s) => [`#${s.code}`, ...lineBadges(s, 5)];
function chooseStop(stop) {
  noteStop(stop);
  closeSearch();
  ctx.navigate(`#/stop/${encodeURIComponent(stop.code)}`);
}
function choosePlace(p) {
  if (p.kind === 'stop' && p.stopCode && data.stopByCode.has(String(p.stopCode))) { chooseStop(data.stopByCode.get(String(p.stopCode))); return; }
  addRecent('place', { name: p.name, subtitle: p.subtitle || '', lat: p.lat, lng: p.lng });
  closeSearch();
  ctx.navigate(tripHash({ lat: p.lat, lng: p.lng, name: p.name }));
}
const srHead = (text) => h('div', { class: 'sr-head', role: 'presentation' }, text);

function renderSearch(keepActive = false) {
  const q = searchInput.value.trim();
  const prev = keepActive ? activeIdx : -1;
  rows = [];
  const out = [];
  let n = 0;
  let say = '';
  const msg = (text) => { say = text; return h('p', { class: 'sr-msg', 'aria-hidden': 'true' }, text); };
  const stopRows = (list) => list.map((s) => srRow(`sr-${n++}`, 'bus', s.displayName, stopSub(s), () => chooseStop(s)));
  if (!q) {
    const rs = recentStops(4);
    const rp = recentPlaces(4);
    if (rs.length || rp.length) {
      out.push(srHead(t('Πρόσφατα')), ...stopRows(rs),
        ...rp.map((p) => srRow(`sr-${n++}`, 'history', p.name, p.subtitle, () => choosePlace(p))));
    } else {
      out.push(msg(t('Γράψε το όνομα μιας στάσης, έναν κωδικό στάσης ή έναν τόπο.')));
    }
    // nearby stops, when the device already knows where it is (computed here: the location never leaves the device)
    const fix = locationService.current;
    const recent = new Set(rs.map((s) => s.code));
    const near = fix && inArea(fix) ? nearestStops(data.stops, fix, { limit: 4, maxMeters: 800 }).filter((x) => !recent.has(x.stop.code)) : [];
    if (near.length) {
      out.push(srHead(t('Κοντινές στάσεις')), ...near.map(({ stop: s, meters }) =>
        srRow(`sr-${n++}`, 'bus', s.displayName, [fmtDist(meters), ...lineBadges(s, 4)], () => chooseStop(s))));
    }
  } else {
    const stops = searchStops(data, q, 6);
    const found = places.q === q ? withoutShownStops(places.results, stops, 6) : [];
    const stopPart = () => { if (stops.length) out.push(srHead(t('Στάσεις')), ...stopRows(stops)); };
    const placePart = () => {
      if (found.length) out.push(srHead(t('Τόποι')), ...found.map((p) => srRow(`sr-${n++}`, p.kind === 'stop' ? 'bus' : 'pin', p.name, p.subtitle, () => choosePlace(p))));
    };
    // TEL-161: a place named like the query goes above stops that only look like it; a stop whose name
    // starts with the query (or its code) keeps the top.
    const k = searchKey(q);
    const stopFirst = !found[0]?.exact || stops.some((s) => s.code === q || s.key.startsWith(k));
    if (stopFirst) { stopPart(); placePart(); } else { placePart(); stopPart(); }
    if (places.q === q && places.loading) out.push(msg(t('Αναζήτηση τόπων…')));
    else if (places.q === q && places.failed && !found.length) out.push(msg(t('Δεν ήταν δυνατή η αναζήτηση τόπων.')));
    else if (!stops.length && !found.length && q.length >= 3 && places.q === q) out.push(msg(t('Κανένα αποτέλεσμα')));
    else if (!stops.length && q.length < 3) out.push(msg(t('Κανένα αποτέλεσμα')));
    const count = stops.length + found.length;
    if (count) say = [tn(count, '{n} αποτέλεσμα', '{n} αποτελέσματα'), say].filter(Boolean).join('. ');
  }
  searchList.replaceChildren(...out);
  sayStatus(say);
  setActive(Math.min(prev, rows.length - 1));
}
function setActive(i) {
  rows[activeIdx]?.row.setAttribute('aria-selected', 'false');
  activeIdx = i;
  const r = rows[i];
  if (r) {
    r.row.setAttribute('aria-selected', 'true');
    searchInput.setAttribute('aria-activedescendant', r.row.id);
    r.row.scrollIntoView({ block: 'nearest' });
  } else {
    searchInput.removeAttribute('aria-activedescendant');
  }
}
function schedulePlaces(q) {
  clearTimeout(placeTimer);
  placeCtl?.abort();
  if (q.length < 3) { places = { q, loading: false, results: [], failed: false }; return; }
  places = { q, loading: true, results: [], failed: false };
  placeTimer = setTimeout(async () => {
    const ctl = (placeCtl = new AbortController());
    try {
      const near = locationService.current ? { lat: locationService.current.lat, lng: locationService.current.lng } : map.getCenter();
      const results = await searchPlaces(q, { near, signal: ctl.signal, data });
      if (ctl.signal.aborted) return;
      places = { q, loading: false, results: results || [], failed: false };
    } catch (err) {
      if (ctl.signal.aborted || err?.name === 'AbortError') return;
      places = { q, loading: false, results: [], failed: true };
    }
    if (searchInput.value.trim() === q) renderSearch(true);
  }, 350);
}

searchInput.addEventListener('focus', openSearch);
searchInput.addEventListener('input', () => {
  const q = searchInput.value.trim();
  searchClear.hidden = !searchInput.value;
  openSearch();
  schedulePlaces(q);
  renderSearch();
});
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!rows.length) return;
    const d = e.key === 'ArrowDown' ? 1 : -1;
    setActive((activeIdx + d + rows.length) % rows.length);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    (rows[activeIdx] || rows[0])?.choose();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeSearch(true, true);
  }
});
searchClear.addEventListener('click', () => {
  searchInput.value = '';
  searchClear.hidden = true;
  clearTimeout(placeTimer);
  placeCtl?.abort();
  places = { q: '', loading: false, results: [], failed: false };
  renderSearch();
  searchInput.focus();
});
$('searchbar').addEventListener('click', (e) => { if (!e.target.closest('button')) searchInput.focus(); });

// The keyboard and the sheet (iOS): focusing the field while the sheet is low makes Safari pan the whole page to keep
// the field above the keyboard, and the pan stays once the sheet has gone up (Kostas, TEL-223). So a tap on the field
// while the sheet is not up opens the keyboard on a hidden field at the top (it must open inside the tap), takes the
// sheet up, then hands the focus to the real field, which is at the top by then, so Safari has nothing to pan.
// --kb (the keyboard's height) keeps the last results above the keyboard. No window.scrollTo() here: scrolling the page
// while the keyboard is open shifts where iOS thinks fixed elements are, and taps on ✕ and ☰ then miss (Kostas, TEL-223).
const kbProxy = h('input', { class: 'kb-proxy', type: 'text', tabindex: '-1', 'aria-hidden': 'true' });
document.body.append(kbProxy);
let kbHandoff = 0;
let tapY = null;
searchInput.addEventListener('touchstart', (e) => { tapY = e.touches.length === 1 ? e.touches[0].clientY : null; }, { passive: true });
searchInput.addEventListener('touchmove', (e) => { if (tapY != null && Math.abs(e.touches[0].clientY - tapY) > 6) tapY = null; }, { passive: true });
searchInput.addEventListener('touchend', (e) => {
  const tap = tapY != null;
  tapY = null;
  if (!tap || searchOpen || document.activeElement === searchInput || sheet.state === 'full' || desktopMQ.matches) return;
  e.preventDefault(); // no native focus, so no pan
  kbProxy.focus({ preventScroll: true });
  openSearch();
  kbHandoff = setTimeout(() => searchInput.focus({ preventScroll: true }), 320); // the sheet's up spring has settled
});
const vv = window.visualViewport;
if (vv) {
  const onViewport = () => {
    const kb = Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop));
    document.documentElement.style.setProperty('--kb', `${kb}px`);
  };
  vv.addEventListener('resize', onViewport);
  vv.addEventListener('scroll', onViewport);
}
// A tap on ☰ or the search's ✕ acts on touchend itself, not on the click iOS makes from it: with the keyboard open
// that click is lost (Kostas, TEL-223), and preventDefault() there also stops the click, so it runs once. pointerdown
// keeps the field focused until then; a drag that starts on the button does nothing. Mouse and keyboard use click
// (detail 0 = from the keyboard).
function onTap(btn, fn) {
  let down = null;
  btn.addEventListener('pointerdown', (e) => { if (searchOpen) e.preventDefault(); });
  btn.addEventListener('touchstart', (e) => { const p = e.touches[0]; down = e.touches.length === 1 ? { x: p.clientX, y: p.clientY } : null; }, { passive: true });
  btn.addEventListener('touchend', (e) => {
    const p = e.changedTouches[0];
    const tap = down && p && Math.hypot(p.clientX - down.x, p.clientY - down.y) < 10;
    down = null;
    if (!tap) return;
    if (e.cancelable) e.preventDefault();
    fn(false);
  });
  btn.addEventListener('click', (e) => fn(e.detail === 0));
}
// ☰ stays the menu while searching (the search closes with its own ✕): it ends the search, then opens the menu
onTap(menuBtn, (fromKeys) => {
  if (searchOpen) closeSearch(false, true);
  if (menuPop.hidden) { menuPopover.open(); paintThemeRow(); } // open first: the row is measured for the lens once shown
  else menuPopover.close(fromKeys);
});
onTap($('search-close'), (fromKeys) => closeSearch(fromKeys, true));
// Keyboard focus leaving the search for another control closes it: the full-screen panel would hide that control
// (WCAG 2.4.11). A blur with nowhere to go (touch scroll of the results) keeps it open.
for (const el of [$('searchbar'), searchPanel]) {
  el.addEventListener('focusout', (e) => {
    const to = e.relatedTarget;
    if (searchOpen && to && !to.closest('#searchbar, #search-panel, #menu-btn')) closeSearch(false, true);
  });
}
// the results scroll with the sheet: scrolling them puts the keyboard away
$('sheet-body').addEventListener('scroll', () => { if (searchOpen && document.activeElement === searchInput && matchMedia('(pointer: coarse)').matches) searchInput.blur(); }, { passive: true });
document.addEventListener('pointerdown', (e) => {
  if (searchOpen && !e.target.closest('#searchbar, #search-panel, #menu-btn, #sheet-handle')) closeSearch(false, true);
}, true);

// ---------------------------------------------------------------- views owned by the shell
// Home (TEL-232, Apple Maps search mode): low = the search alone; mid = Places (round buttons), then the recents (the
// sheet ends 20% into the 2nd one: [data-mid-end]); up = the favourites with their next arrival live (js/home-view.js).
function mountHome(container, c) {
  const places = h('section', { class: 'home-section home-places' });
  const recents = h('div', { class: 'home-recents' });
  const favs = h('div', { class: 'home-favs' });
  container.replaceChildren(h('h1', { class: 'visually-hidden' }, title()), places, recents, favs);
  const views = [];
  const offs = [];
  let dead = false;
  const add = (p) => p.then((v) => { if (dead) v?.destroy?.(); else if (v) views.push(v); }).catch((err) => console.error('[home]', err));
  add(import('./home-view.js').then((m) => m.mountPlacesRow(places, c)));
  add(import('./home-view.js').then((m) => m.mountFavoritesLive(favs, c, stopRow)));

  const paint = () => paintRecents(places, recents);
  paint();
  offs.push(onChange(paint));

  return {
    destroy() {
      dead = true;
      offs.forEach((f) => f?.());
      views.forEach((v) => v?.destroy?.());
    },
  };
}

// Recents: stops, then places. The first row whole, the second one 20% into it, is where mid ends.
function paintRecents(places, recents) {
  const rows = [...recentStops(5).map((s) => stopRow(s)), ...recentPlaces(3).map(placeRow)];
  delete places.dataset.midEnd;
  if (rows.length) rows[Math.min(1, rows.length - 1)].dataset.midEnd = rows.length > 1 ? '0.2' : '1';
  else places.dataset.midEnd = '1'; // no recents: mid ends under the places
  recents.replaceChildren(...(rows.length ? [h('section', { class: 'home-section' }, h('h2', {}, t('Πρόσφατα')), h('div', { class: 'list' }, rows))] : []));
}

// TEL-359: pulling Settings or Report below 65% shows the menu under the finger. It is a still copy: search, Places and
// Recents (all that mid shows), no favourites, so no bus data and no timers, and nothing in it can be tapped or focused.
let leaveMenu = null;
let homeParts = null; // js/home-view.js, loaded when Settings or Report opens, so a flick can show the copy at once
function dropLeaveMenu() {
  if (!leaveMenu) return;
  leaveMenu.places?.destroy?.();
  leaveMenu.el?.remove();
  leaveMenu.ghost?.remove();
  leaveMenu = null;
  sheet.setLeaveMenu(null);
  sheet.el.classList.remove('leave-swap');
}
function showLeaveMenu() {
  if (leaveMenu || !homeParts || reduceMotion.matches || !document.documentElement.classList.contains('glass')) return;
  const me = leaveMenu = { el: null, places: null, ghost: null };
  const search = searchbarEl.cloneNode(true);
  [search, ...search.querySelectorAll('[id]')].forEach((n) => n.removeAttribute('id'));
  // it keeps `hidden` (css/glass.css still draws it): a visible search bar anywhere in the sheet changes the sheet's layout
  search.hidden = true;
  search.removeAttribute('role');
  const input = search.querySelector('input');
  if (input) input.value = '';
  const places = h('section', { class: 'home-section home-places' });
  const recents = h('div', { class: 'home-recents' });
  me.places = homeParts.mountPlacesRow(places);
  paintRecents(places, recents);
  me.el = h('div', { class: 'leave-menu', 'aria-hidden': 'true' }, search, h('div', { class: 'sheet-content' }, places, recents));
  me.el.inert = true;
  sheet.el.append(me.el);
  sheet.setLeaveMenu(me.el);
}

// Favourites (TEL-250, UI-PROTOCOL U2–U5): the kit's .card-head (css/ui-kit.css), placed in app.css (fav-head):
// an empty slot · the title, 17 px, centred · ✕. The title is short and fixed, so it is not shrunk to fit. Halfway from
// mid to up it moves to its own row, 24 px, in a short blur (U4, U10); towards up it grows as a transform (U8).
function mountFavorites(container, c) {
  const body = h('div');
  const title = h('h1', { class: 'fav-title card-title' }, t('Αγαπημένες στάσεις'));
  const label = t('Κλείσιμο');
  const closeBtn = h('a', { class: 'btn round g-circle', href: cityHash('#/'), 'aria-label': label, title: label }, icon('close'));
  // the low marker is out of the grid (absolute) and before ✕, which the kit keeps right as the :last-child
  const head = h('header', { class: 'fav-head card-head' }, h('span', { 'aria-hidden': 'true' }), title,
    h('span', { class: 'fav-peek-end', 'aria-hidden': 'true', 'data-peek-end': '' }), closeBtn); // low ends under it (js/sheet.js)
  container.replaceChildren(h('div', { class: 'fav-view sheet-inset' }, head, body));
  const sheetEl = document.getElementById('sheet');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const setUp = (on) => {
    if (head.classList.contains('is-up') === on) return;
    head.classList.toggle('is-up', on);
    if (!reduceMotion.matches) title.animate([{ filter: 'blur(3px)' }, { filter: 'blur(0)' }], { duration: 180, easing: 'ease-out' });
  };
  // as js/bus-view.js: up while the sheet is full or dragged past halfway from mid to up; nothing runs per frame
  const upRow = () => !!sheetEl && (sheetEl.dataset.state === 'full' || sheetEl.classList.contains('dragging'))
    && (parseFloat(sheetEl.style.getPropertyValue('--sheet-t')) || 0) > 1.5;
  const onUpper = () => setUp(upRow());
  const onLeaveUp = () => setUp(false);
  const mo = new MutationObserver(onUpper);
  if (sheetEl) {
    mo.observe(sheetEl, { attributes: true, attributeFilter: ['class', 'data-state'] });
    sheetEl.addEventListener('sheet:upper', onUpper);
    sheetEl.addEventListener('sheet:leave-full', onLeaveUp);
  }
  setUp(upRow());
  const paint = () => {
    const favs = getFavorites().map((code) => data.stopByCode.get(String(code))).filter(Boolean);
    body.replaceChildren(favs.length
      ? h('div', { class: 'list' }, favs.map((s) => stopRow(s)))
      : h('p', { class: 'hint' }, t('Δεν έχεις αγαπημένες στάσεις ακόμα. Άνοιξε μια στάση και πάτα το αστέρι για να την προσθέσεις.')));
  };
  paint();
  const off = onChange(paint);
  return {
    destroy() {
      off?.();
      mo.disconnect();
      sheetEl?.removeEventListener('sheet:upper', onUpper);
      sheetEl?.removeEventListener('sheet:leave-full', onLeaveUp);
    },
  };
}

function mountPin(container, c, p) {
  const fix = locationService.current;
  const near = nearestStops(data.stops, p, { limit: 5, maxMeters: 1500 });
  const sub = [`${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`];
  if (fix) sub.push(t('{d} από εσένα', { d: fmtDist(haversine(fix, p)) }));
  container.replaceChildren(
    h('div', { class: 'view-head' }, backBtn(), h('h1', {}, pinName(), h('span', { class: 'sub' }, sub.join(' · ')))),
    h('section', { class: 'home-section' },
      h('h2', {}, t('Κοντινές στάσεις')),
      near.length ? h('div', { class: 'list' }, near.map((n) => stopRow(n.stop, n.meters)))
        : h('p', { class: 'hint' }, t('Δεν υπάρχει στάση σε απόσταση 1,5 χλμ από αυτό το σημείο.'))));
  c.map.setMarkers('pin', [{ ...p, kind: 'pin' }]);
  return { destroy() { c.map.clearMarkers('pin'); } };
}

// ---------------------------------------------------------------- trip (TEL-294)
// plan() is the only place that knows the start (your location). The start goes only to OSRM, through walk.js, as the
// end of a walking leg; the worker gets stop codes only. It is never put in the hash, history.state, the title, a toast,
// a log line, reportCtx or storage (CLAUDE.md rule 6).
const TRIP_WAIT_MS = 10000; // how long a trip waits for a first fix
const TRIP_KEEP_M = 50; // a new fix this close to the last start keeps the last start (the walk cache hits)
const NO_LOC = new Set(['denied', 'unavailable', 'insecure', 'timeout']);
let tripCtl = null; // the running plan() call; teardown() aborts it
let searchAfterRoute = false; // «Άλλος προορισμός»: open the search once home is on screen
const abortError = () => new DOMException('trip closed', 'AbortError');

// A fix, or null after TRIP_WAIT_MS, when the location cannot be had, or when the trip closes.
function waitTripFix(signal) {
  if (locationService.current) return Promise.resolve(locationService.current);
  if (NO_LOC.has(locationService.status) && locationService.status !== 'timeout') return Promise.resolve(null);
  return new Promise((resolve) => {
    let off = null;
    const done = (v) => { clearTimeout(timer); off?.(); signal.removeEventListener('abort', onAbort); resolve(v); };
    const onAbort = () => done(null);
    const timer = setTimeout(() => done(null), TRIP_WAIT_MS);
    signal.addEventListener('abort', onAbort);
    off = locationService.subscribe((fix, status) => { if (fix) done(fix); else if (NO_LOC.has(status)) done(null); });
  });
}

// dest = { lat, lng, name }; back = the city-relative hash of the stop or the place view.
function makeTripPlan(dest, back) {
  const walkCache = new Map();
  const prefer = new Map(); // the "sticky bus" of each itinerary
  let start = null;
  return async function plan({ onUpdate } = {}) {
    tripCtl?.abort();
    const ctl = (tripCtl = new AbortController());
    const { signal } = ctl;
    let fix = locationService.current;
    if (!fix && DEMO) fix = city().center; // the demo start, no prompt
    if (!fix) {
      if (!NO_LOC.has(locationService.status) || locationService.status === 'timeout') locationService.start();
      fix = await waitTripFix(signal);
    }
    if (signal.aborted) throw abortError();
    if (!fix) {
      toast(t('Δεν βρέθηκε η τοποθεσία σου. Δοκίμασε ξανά.'));
      history.replaceState(null, '', cityHash(back)); // so the browser's Back does not loop into the trip
      route();
      throw abortError();
    }
    if (!start || haversine(start, fix) >= TRIP_KEEP_M) start = { lat: fix.lat, lng: fix.lng };
    const [{ planTrips }, walk] = await Promise.all([import('./trip.js'), import('./walk.js')]);
    if (signal.aborted) throw abortError();
    const res = await planTrips(data,
      { lat: start.lat, lng: start.lng, name: null },
      { lat: dest.lat, lng: dest.lng, name: dest.name },
      {
        deps: { fetchLive: (code) => fetchLive(code), walkRoute: walk.walkRoute, walkEstimate: walk.walkEstimate },
        signal, walkCache, prefer, onUpdate,
      });
    prefer.clear();
    for (const it of res.itineraries || []) {
      const key = it.legs?.find((l) => l.kind === 'bus')?.key;
      if (key) prefer.set(it.id, key);
    }
    return res;
  };
}

// «Άλλος προορισμός»: home with the search open. The hidden field takes the focus now, inside the tap, so the phone
// keyboard opens (as the search's touchend handler does); route() hands it to the real field.
function tripOtherDest() {
  kbProxy.focus({ preventScroll: true });
  searchAfterRoute = true;
  navigate('#/');
}

// ---------------------------------------------------------------- router
let view = null;
let routeToken = 0;
let nextSnap = null;
let leftUp = false;
let leftUpVelocity = 0; // px/s of the finger when it let go, so the spring to mid carries on from it // TEL-352: the route comes from a swipe down out of Settings or Report (the content swaps in a short blur, U10)
let currentHead = '';
// Where the user was before opening the report sheet: the screen name and a public stop/line code, never the query (no coordinates).
let reportCtx = { view: '', ref: '' };
let booted = false;
const SNAP = { '': 'half', stop: 'half', bus: 'half', favorites: 'half', pin: 'half', trip: 'half', settings: 'full', report: 'full', place: 'full' };

// Switching city (TEL-347) = load that city's data, then remember it, move the map and redraw the screen: no page reload.
// Stored items, reminders and the api memo are keyed by city, so they follow cityId(). The active city changes only after
// the data is in, so nothing mounted reads a half-switched state. If the data cannot load, the city stays as it was.
let switching = false;
// `to`: the screen it opens on the new city (Settings asks for itself, TEL-251); home by default.
async function switchCity(id, to = '#/') {
  if (!isCity(id) || id === cityId() || switching) return;
  switching = true;
  try {
    let next;
    try { next = await loadData(CITIES[id]); } catch (err) {
      console.error('[switch city]', err);
      toast(t('Δεν φορτώθηκαν τα δεδομένα στάσεων.'));
      return;
    }
    routeToken++; // drop anything still loading for the old city
    teardown();
    setActiveCity(id);
    setSetting('city', id);
    data = next;
    ctx.data = next;
    map.setCity(next.stops);
    try { history.replaceState(null, '', cityHash(to)); } catch { /* ignore */ }
    localizeChrome(); // the menu shows the city name
    await route();
  } finally { switching = false; }
}
function teardown() {
  try { view?.destroy?.(); } catch (err) { console.error('[view destroy]', err); }
  view = null;
  tripCtl?.abort();
  tripCtl = null;
  map.highlightStop(null);
  map.clearMarkers('pin');
}
async function route() {
  const token = ++routeToken;
  const wantSearch = searchAfterRoute;
  searchAfterRoute = false;
  const { city: hashCity, rel, parts, params } = parseHash(location.hash);
  // A link into the other city (pasted, shared, history): the page is per city, so remember it and reload on that hash.
  if (hashCity && hashCity !== cityId()) { setSetting('city', hashCity); location.reload(); return; }
  // Canonical form: prefix for every city but the default (an unprefixed hash means "this city" while running).
  const canon = formatHash(rel);
  if ((location.hash || '#/') !== canon) { try { history.replaceState(history.state, '', canon); } catch { /* ignore */ } }
  closeSearch();
  menuPopover.close(false);
  teardown();
  const head = parts[0] || '';
  const arg = parts[1];
  currentHead = SNAP[head] != null ? head : '';
  // the search is home's first row (TEL-223); the other views put their own header there, with a ✕ back home
  const topBefore = leftUp ? sheet.el.getBoundingClientRect().top : null;
  const oldBox = leftUp ? sheet.content.getBoundingClientRect() : null; // where the old content is, before the search bar pushes it
  searchbarEl.hidden = currentHead !== '';
  if (topBefore != null) sheet.keepTop(topBefore);
  if (currentHead !== 'report') reportCtx = { view: currentHead || 'home', ref: currentHead === 'stop' ? String(arg) : '' };
  if (SNAP[head] == null) history.replaceState(null, '', cityHash('#/'));
  const content = sheet.content;
  // TEL-352: leaving Settings or Report by a swipe: the old content stays a moment as a still copy that blurs and fades
  // out over the new one, which blurs in (a cross-fade through blur, U10), so the swap is never a cut
  // TEL-359: the menu's still copy is already showing: it stays over the real menu (hidden) until the sheet is at rest
  const swap = leftUp && currentHead === '' && !!leaveMenu?.el;
  if (swap) {
    // the old content stays too, in the same spot, and melts with --leave (css/glass.css), as it does under the finger
    const box = sheet.el.getBoundingClientRect();
    const ghost = content.cloneNode(true);
    ghost.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
    ghost.removeAttribute('id');
    ghost.setAttribute('aria-hidden', 'true');
    ghost.inert = true;
    Object.assign(ghost.style, { position: 'absolute', left: `${oldBox.left - box.left}px`, top: `${oldBox.top - box.top}px`, width: `${oldBox.width}px`, maxHeight: `${innerHeight}px`, overflow: 'hidden', pointerEvents: 'none' });
    sheet.el.append(ghost);
    leaveMenu.ghost = ghost;
    const m = leaveMenu;
    const done = () => { if (leaveMenu === m) dropLeaveMenu(); };
    sheet.el.classList.add('leave-swap');
    sheet.el.addEventListener('sheet:settle', done, { once: true });
    setTimeout(done, 900);
  } else dropLeaveMenu();
  if (leftUp && !swap && !reduceMotion.matches) {
    const host = content.offsetParent;
    if (host) {
      const ghost = content.cloneNode(true);
      ghost.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
      ghost.removeAttribute('id');
      ghost.setAttribute('aria-hidden', 'true');
      ghost.inert = true;
      Object.assign(ghost.style, { position: 'absolute', left: `${content.offsetLeft}px`, top: `${content.offsetTop}px`, width: `${content.offsetWidth}px`, pointerEvents: 'none' });
      host.append(ghost);
      ghost.animate([{ filter: 'blur(0)', opacity: 1 }, { filter: 'blur(10px)', opacity: 0 }], { duration: 260, easing: 'ease-out', fill: 'forwards' }).onfinish = () => ghost.remove();
    }
  }
  content.replaceChildren();
  content.removeAttribute('aria-busy'); // set in index.html until the first view
  sheet.scrollToTop();
  if (leftUp && !swap && !reduceMotion.matches) content.animate([{ filter: 'blur(10px)', opacity: 0 }, { filter: 'blur(0)', opacity: 1 }], { duration: 320, delay: 120, easing: 'ease-out', fill: 'backwards' });
  const carry = leftUp ? leftUpVelocity : 0;
  leftUp = false;
  leftUpVelocity = 0;
  content.classList.remove('enter');
  if (!swap && !reduceMotion.matches) { void content.offsetWidth; content.classList.add('enter'); }
  document.title = title();

  focusPt = null;
  routeSnap = true;
  sheet.setUpOnly(currentHead === 'settings' || currentHead === 'report'); // no low or mid: down from up goes home (TEL-352)
  if ((currentHead === 'settings' || currentHead === 'report') && !homeParts) import('./home-view.js').then((m) => { homeParts = m; }).catch(() => {});
  sheet.snap(nextSnap || SNAP[currentHead], { animate: booted, velocity: carry });
  routeSnap = false;
  nextSnap = null;

  const mount = async (loader, build) => {
    try {
      const mod = await loader();
      if (token !== routeToken) return;
      const v = build(mod);
      if (token !== routeToken) { v?.destroy?.(); return; }
      view = v;
    } catch (err) {
      console.error('[view]', err);
      if (token === routeToken) content.replaceChildren(errorState(t('Δεν φορτώθηκε αυτή η οθόνη.'), () => route()));
    }
  };

  switch (currentHead) {
    case 'stop': {
      const stop = data.stopByCode.get(String(arg));
      if (!stop) {
        content.replaceChildren(h('div', { class: 'view-head' }, backBtn(), h('h1', {}, t('Η στάση δεν βρέθηκε'))));
        break;
      }
      document.title = `${stop.displayName} · ${title()}`;
      noteStop(stop);
      map.highlightStop(stop.code);
      map.flyTo(stop, 17);
      focusPt = stop;
      await mount(() => import('./arrivals-view.js'), (m) => m.mountStop(content, ctx, { code: stop.code }));
      break;
    }
    case 'bus':
      document.title = `${t('Διαδρομή οχήματος')} · ${title()}`;
      await mount(() => import('./bus-view.js'), (m) => m.mountBus(content, ctx, { vehicleCode: String(arg), route: params.route || undefined, stop: params.stop || undefined }));
      break;
    case 'settings':
      document.title = `${t('Ρυθμίσεις')} · ${title()}`;
      await mount(() => import('./settings-view.js'), (m) => m.mountSettings(content, ctx, { section: params.section || undefined }));
      break;
    case 'report':
      document.title = `${t('Αναφορά προβλήματος')} · ${title()}`;
      await mount(() => import('./report-view.js'), (m) => m.mountReport(content, ctx, { context: reportCtx }));
      break;
    case 'place': // TEL-239: set Σπίτι, Δουλειά or a new place in the sheet
      document.title = `${t('Μέρη')} · ${title()}`;
      await mount(() => import('./place-view.js'), (m) => m.mountPlace(content, ctx, { id: String(params.id || 'new') }));
      break;
    case 'favorites':
      document.title = `${t('Αγαπημένες στάσεις')} · ${title()}`;
      view = mountFavorites(content, ctx);
      break;
    case 'pin': {
      const p = parsePt(`${params.lat},${params.lng}`);
      if (!p) { ctx.navigate('#/'); break; }
      document.title = `${pinName()} · ${title()}`;
      view = mountPin(content, ctx, p);
      map.flyTo(p, 17);
      focusPt = p;
      break;
    }
    case 'trip': {
      let dest, back;
      if (params.stop != null) {
        const stop = data.stopByCode.get(String(params.stop));
        if (!stop) {
          content.replaceChildren(h('div', { class: 'view-head' }, backBtn(), h('h1', {}, t('Η στάση δεν βρέθηκε'))));
          break;
        }
        dest = { lat: stop.lat, lng: stop.lng, name: stop.displayName };
        back = `#/stop/${encodeURIComponent(stop.code)}`;
        map.highlightStop(stop.code);
      } else {
        const p = parsePt(`${params.lat},${params.lng}`);
        if (!p) { ctx.navigate('#/'); break; }
        dest = { ...p, name: String(params.name || '').trim().slice(0, 80) || pinName() };
        back = `#/pin?lat=${p.lat.toFixed(5)}&lng=${p.lng.toFixed(5)}`;
        map.setMarkers('pin', [{ ...p, kind: 'pin' }]); // teardown() clears it
      }
      document.title = `${t('Διαδρομή')} · ${title()}`;
      map.flyTo(dest, 16); // once; focusPt stays null until TEL-295 fits the whole trip
      const plan = makeTripPlan(dest, back);
      const lineFor = (code) => data.lineByCode.get(String(code));
      await mount(() => import('./trip-view.js'), (m) => m.mountTrip(content, ctx, {
        dest: dest.name, plan, lineFor, onBack: () => navigate(back), onOtherDest: tripOtherDest,
      }));
      break;
    }
    default:
      view = mountHome(content, ctx);
  }
  if (wantSearch && currentHead === '' && token === routeToken) {
    openSearch();
    clearTimeout(kbHandoff);
    kbHandoff = setTimeout(() => searchInput.focus({ preventScroll: true }), 320); // the sheet's up spring has settled
    return;
  }
  if (booted && (document.activeElement === document.body || !document.activeElement)) sheet.body.focus({ preventScroll: true });
}

function navigate(hash, opts = {}) {
  nextSnap = opts.snap || null;
  hash = cityHash(hash); // views pass city-relative hashes
  const cur = location.hash === '#' || !location.hash ? '#/' : location.hash;
  if (cur === hash) route();
  else location.hash = hash;
}

// ---------------------------------------------------------------- map events
function onStopClick(code) { navigate(`#/stop/${encodeURIComponent(code)}`); }
// A tapped live bus marker (carries vehicleCode + routeCode + stopCode): open its route and timeline.
function onVehicleClick(v) {
  if (!v || !v.vehicleCode || !v.routeCode) return;
  navigate(`#/bus/${encodeURIComponent(v.vehicleCode)}?route=${encodeURIComponent(v.routeCode)}${v.stopCode ? `&stop=${encodeURIComponent(v.stopCode)}` : ''}`);
}
function onMapClick() {
  if (currentHead === 'stop' || currentHead === 'pin') navigate('#/', { snap: 'peek' });
  else if (currentHead === '' && sheet.state !== 'peek') sheet.snap('peek');
}
function onLongPress(p) {
  if (!inArea(p)) toast(t('Το σημείο είναι εκτός της περιοχής: {city}.', { city: cityName(city(), lang()) }));
  navigate(`#/pin?lat=${p.lat.toFixed(5)}&lng=${p.lng.toFixed(5)}`);
}

// ---------------------------------------------------------------- boot
function enterNoMap(reason) {
  appEl.classList.add('no-map');
  sheet.setFixed(true);
  const note = $('map-note');
  note.textContent = reason === 'script'
    ? t('Δεν φορτώθηκε ο χάρτης (έλεγξε τη σύνδεσή σου). Η εφαρμογή λειτουργεί ως λίστα.')
    : t('Ο χάρτης δεν είναι διαθέσιμος σε αυτή τη συσκευή. Η εφαρμογή λειτουργεί ως λίστα.');
  note.hidden = false;
}

// Static Greek in index.html is the fallback; this (re)applies the current language.
function localizeChrome() {
  searchInput.placeholder = t('Πού πάμε;');
  searchInput.setAttribute('aria-label', t('Αναζήτηση στάσης ή τόπου'));
  searchClear.setAttribute('aria-label', t('Καθαρισμός αναζήτησης'));
  searchList.setAttribute('aria-label', t('Αποτελέσματα αναζήτησης'));
  menuBtn.setAttribute('aria-label', t('Μενού'));
  $('search-close').setAttribute('aria-label', t('Κλείσιμο αναζήτησης'));
  northBtn.setAttribute('aria-label', t('Επαναφορά βορρά'));
  northBtn.title = t('Επαναφορά βορρά');
  $('sheet').setAttribute('aria-label', t('Πληροφορίες'));
  $('demo-tag').title = t('Δεδομένα επίδειξης');
  paintLocLabel();
  buildMenu();
}

function buildChrome() {
  menuBtn.append(icon('menu'));
  searchClear.append(icon('close'));
  $('search-close').append(icon('close'));
  northBtn.append(icon('compass'));
  locateBtn.append(icon('locate'));
  menuPopover = makePopover(menuBtn, menuPop);
  pressable(menuBtn);
  localizeChrome();
  if (DEMO) $('demo-tag').hidden = false;
}

async function boot() {
  sheet = createSheet($('sheet'), { onSnap, onMove, follow: [$('menu-btn')] });
  // Settings and Report are "up only": a swipe down (or a tap on the handle) from up opens home at mid in one move
  $('sheet').addEventListener('sheet:leave-menu', (e) => { if (e.detail?.open) showLeaveMenu(); else dropLeaveMenu(); });
  $('sheet').addEventListener('sheet:leave', (e) => { e.preventDefault(); showLeaveMenu(); leftUp = true; leftUpVelocity = e.detail?.velocity || 0; navigate('#/', { snap: 'half' }); });
  buildChrome();
  map = createMap($('map'), { theme: resolveTheme(), attribInto: $('map-attrib'), avoid: { top: ['#menu-btn', '#offline-pill'], right: ['#fabs-bottom'] }, onStopClick, onVehicleClick, onMapClick, onLongPress, onUserMove, onBearing });
  if (!map.available) enterNoMap(map.reason);
  applyTheme();
  setLocMode('idle');

  try {
    data = await loadData();
  } catch (err) {
    console.error('[data]', err);
    sheet.content.replaceChildren(errorState(t('Δεν φορτώθηκαν τα δεδομένα στάσεων.'), () => location.reload()));
    sheet.content.removeAttribute('aria-busy');
    bootScreen.finish();
    return;
  }
  map.setStops(data.stops);
  ctx = {
    data, map, location: locationService, navigate,
    sheet: { snap: (to) => sheet.snap(to), get state() { return sheet.state; } },
    toast, switchCity,
  };

  if (new URLSearchParams(location.search).has('debug')) window.__app = { map, sheet, ctx, data };
  locationService.subscribe(onLocation);
  onLocation(locationService.current, locationService.status);
  locationService.autoStart?.(); // only if permission is already granted: no prompt on load

  window.addEventListener('hashchange', () => route());
  onLangChange(() => { localizeChrome(); route(); });
  // Opened before the home view mounts, so the home's "first time here?" card already sees the flags the setup sets.
  let setupClosed = null;
  // The setup sets its flags now and opens once the boot screen starts to leave (TEL-255).
  try { setupClosed = (await setupP)?.maybeSetup({ bootHome, ctx, after: bootScreen.leaving }) ?? null; } catch (err) { console.error('[setup]', err); }
  await route();
  booted = true;
  bootScreen.finish();
  // One-time thank-you for the testers, only when opened as an installed app (or with ?welcome to preview). Never blocks boot.
  // After the first-run setup, when both apply (first launch of the installed app), and never under the boot screen.
  Promise.resolve(setupClosed).then(() => bootScreen.leaving).then(() => import('./welcome.js').then((m) => m.maybeWelcome()).catch(() => {}));
  // Anonymous daily open/install count (CLAUDE.md rule 4): off the boot path, silent on failure.
  import('./usage.js').then((m) => m.reportUsage()).catch(() => {});

  if ('serviceWorker' in navigator) {
    const reg = () => navigator.serviceWorker.register('sw.js').catch(() => {});
    if (document.readyState === 'complete') reg(); else window.addEventListener('load', reg, { once: true });
  }
}

boot().catch((err) => {
  console.error('[boot]', err);
  sheet?.content.replaceChildren(errorState(t('Κάτι πήγε στραβά.'), () => location.reload()));
  sheet?.content.removeAttribute('aria-busy');
  bootScreen.finish();
});
