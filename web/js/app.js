// App shell and integrator (owner: shell). Boots data + map + sheet, wires location, search, theme and the hash router.
// Views are lazy-loaded modules with `mountX(container, ctx, params) -> { destroy() }` (docs/ARCHITECTURE.md).
import './boot-city.js'; // must stay first: picks the active city before any other module reads it
import { h, icon, toast, lineBadge } from './ui.js';
import { loadData, searchStops } from './data.js';
import { createMap } from './map.js';
import { createSheet } from './sheet.js';
import { createSpringLoop } from './motion.js';
import locationService from './location.js';
import { DEMO } from './api.js';
import { getRecents, addRecent, getFavorites, getSettings, setSetting, onChange } from './store.js';
import { t, tn, N_, onLangChange, lang, APP_NAME } from './i18n.js';
import { CITIES, city, cityId, cityName, isCity } from './cities.js';
import { cityToOffer } from './city-detect.js';
import { parseHash, formatHash, cityHash } from './route.js';
import { searchPlaces } from './geocode.js';
import { haversine, fmtDist, nearestStops, inArea } from './geo.js';
import './notify.js'; // re-arms persisted reminders after a reload

// Install-as-app helper (js/install-guide.js, docs/GUIDE.md). Started here, in parallel with boot and never awaited by it,
// so it cannot delay the first paint; captureInstallPrompt() keeps `beforeinstallprompt` for the guide's Install button.
let installP = null;
const installGuide = () => (installP ||= import('./install-guide.js').catch((err) => { installP = null; throw err; }));
installGuide().then((m) => m.captureInstallPrompt()).catch(() => {});
// Was the page opened on the home view (not a deep link)? Only then the first-run setup / guide / install hint may appear.
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
const ptStr = (p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
const planHash = (to, name) => cityHash(`#/plan?to=${ptStr(to)}${name ? `&name=${encodeURIComponent(name)}` : ''}`);
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
  return h('a', { class: 'stop-row', href: planHash(p, p.name) },
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
    item('#/lines', 'bus', t('Γραμμές')),
    item('#/plan', 'route', t('Διαδρομή')),
    h('div', { class: 'pop-sep' }),
    h('div', { class: 'pop-head', id: 'theme-label' }, t('Θέμα')),
    h('div', { class: 'theme-row', role: 'radiogroup', 'aria-labelledby': 'theme-label' },
      THEMES.map(([value, ico, label]) => h('button', {
        type: 'button', class: 'theme-opt', role: 'radio', 'data-value': value, 'data-keep': '', 'aria-checked': 'false',
        'aria-label': t(label), title: t(label), onclick: () => setSetting('theme', value),
      }, icon(ico)))),
    h('div', { class: 'pop-sep' }),
    item('#/guide', 'info', t('Οδηγός')),
    item('#/report', 'bug', t('Αναφορά προβλήματος')),
    item('#/settings', 'settings', t('Ρυθμίσεις και σχετικά')));
  paintThemeRow();
}
function paintThemeRow() {
  const cur = getSettings().theme || 'auto';
  menuPop.querySelectorAll('[role="radio"]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.value === cur)));
}

// Runs after the popover consts exist (applyTheme repaints the theme row).
applyTheme();
darkMQ.addEventListener('change', applyTheme);
onChange(applyTheme);

// ---------------------------------------------------------------- sheet <-> map/floating UI
const fabsBottom = $('fabs-bottom');
const desktopMQ = matchMedia('(min-width: 900px)');
const toastHost = $('toasts');
const chipsEl = $('chips');
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
    const top = Math.max(menuBtn.getBoundingClientRect().bottom, chipsEl.hidden ? 0 : chipsEl.getBoundingClientRect().bottom) + 8;
    map.setPadding({ top, bottom: Math.min(visible, innerHeight * 0.6), left: 0, right: 0 });
  }
  // As in Apple Maps (Kostas, TEL-222): between low and mid the map glides to centre its focus in the part left above
  // the sheet. Only once the sheet is let go (this fires when its target is chosen), never to or from full.
  const from = lastSnap;
  lastSnap = state;
  const lowMid = (from === 'peek' && state === 'half') || (from === 'half' && state === 'peek');
  if (!desktop && lowMid && !routeSnap && (currentHead === '' || focusPt)) map.recenter(focusPt);
}
function onMove({ lift, opacity }) {
  fabsBottom.style.transform = lift ? `translateY(${-lift}px)` : '';
  fabsBottom.style.opacity = String(opacity);
  fabsBottom.style.pointerEvents = opacity < 0.05 ? 'none' : '';
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
  // A real GPS fix inside the other city: offer to switch (TEL-142). The check runs on the device; no reload unless the user taps.
  const offer = !cityOffered && cityToOffer(fix, cityId());
  if (offer) {
    cityOffered = true;
    toast(t('Βρίσκεσαι στην {city}. Να αλλάξω πόλη;', { city: cityName(CITIES[offer], lang()) }), { action: { label: t('Αλλαγή πόλης'), onClick: () => switchCity(offer) }, ms: CITY_OFFER_MS });
    // Not tapped (a tap reloads the page, so this never runs then): a short hint that Settings can do it later.
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

function openSearch() {
  if (searchOpen) return;
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
  ctx.navigate(planHash(p, p.name));
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
    // One quiet, always-present way into "address → address" planning (From + To), not just destination search.
    out.push(srRow(`sr-${n++}`, 'route', t('Διαδρομή'), t('Διάλεξε αφετηρία και προορισμό'), () => { closeSearch(); ctx.navigate('#/plan'); }));
  } else {
    const stops = searchStops(data, q, 6);
    if (stops.length) out.push(srHead(t('Στάσεις')), ...stopRows(stops));
    const seen = new Set(stops.map((s) => s.code));
    const found = places.q === q
      ? places.results.filter((p) => !(p.kind === 'stop' && seen.has(String(p.stopCode)))) : [];
    if (found.length) {
      out.push(srHead(t('Τόποι')), ...found.map((p) => srRow(`sr-${n++}`, p.kind === 'stop' ? 'bus' : 'pin', p.name, p.subtitle, () => choosePlace(p))));
    }
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
      places = { q, loading: false, results: (results || []).slice(0, 6), failed: false };
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
// sheet up, then hands the focus to the real field, which is at the top by then. Any pan left over is undone, and
// --kb (the keyboard's height) keeps the last results above the keyboard.
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
    if (searchOpen && (window.scrollY || vv.offsetTop)) window.scrollTo(0, 0);
  };
  vv.addEventListener('resize', onViewport);
  vv.addEventListener('scroll', onViewport);
}
// ☰ stays the menu while searching (the search closes with its own ✕): it ends the search, then opens the menu
menuBtn.addEventListener('click', () => {
  if (searchOpen) closeSearch(false, true);
  if (menuPop.hidden) menuPopover.open();
  else menuPopover.close(true);
});
$('search-close').addEventListener('click', () => closeSearch(true, true));
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
// Home = ONE contextual card: onboard trip > saved place > nearby next bus. Favourites/recents show only when the sheet is expanded (CSS).
function mountHome(container, c) {
  const slot = (cls) => h('div', { class: `home-slot ${cls}`, hidden: true });
  const box = { onboard: slot('home-onboard'), places: slot('home-places'), nearby: slot('home-nearby') };
  const more = h('div', { class: 'home-more', hidden: true });
  const card = h('div', { class: 'home-card' }, box.onboard, box.places, box.nearby);
  const hint = h('div', { class: 'guide-hint', hidden: true }); // first-run guide card / install hint, under the card
  container.replaceChildren(h('h1', { class: 'visually-hidden' }, title()), card, hint, more);
  const views = {};
  const offs = [];
  let dead = false;
  let nearbyBusy = false;
  let nearbyFailed = false;
  const LEAVE_MS = 180; // matches .home-slot's transition duration (css/nearby.css)
  const hideTimers = {};
  // Cross-fades which card is shown (DESIGN.md §3): the leaving slot fades/lifts out, then hides; the
  // entering one shows right away (its own module adds "card-in" for its content's entrance animation).
  const showTop = (top) => {
    for (const k of Object.keys(box)) {
      if (k === top) {
        clearTimeout(hideTimers[k]); hideTimers[k] = null;
        box[k].classList.remove('is-leaving');
        box[k].hidden = false;
      } else if (!box[k].hidden && !hideTimers[k]) {
        box[k].classList.add('is-leaving');
        hideTimers[k] = setTimeout(() => {
          hideTimers[k] = null;
          if (dead) return;
          box[k].hidden = true;
          box[k].classList.remove('is-leaving');
        }, LEAVE_MS);
      }
    }
  };
  const load = (key, file, fn, after) => import(file).then((m) => {
    if (dead) return;
    views[key] = m[fn](box[key], c);
    after?.(m);
  });

  // The first card with content wins; nearby is mounted only when nothing above it renders (it polls live data).
  const evaluate = () => {
    if (dead) return;
    const top = box.onboard.childElementCount ? 'onboard' : box.places.childElementCount ? 'places' : 'nearby';
    showTop(top);
    if (top === 'nearby') {
      if (views.nearby || nearbyBusy || nearbyFailed) return;
      nearbyBusy = true;
      load('nearby', './nearby.js', 'mountNearby')
        .catch((err) => { console.error(err); nearbyFailed = true; box.nearby.replaceChildren(msgEl(t('Δεν φορτώθηκε η ενότητα «κοντά σου».'))); })
        .finally(() => { nearbyBusy = false; evaluate(); });
    } else if (views.nearby) {
      views.nearby.destroy?.();
      views.nearby = null;
      box.nearby.replaceChildren();
    }
  };
  const mo = new MutationObserver(evaluate);
  mo.observe(box.onboard, { childList: true });
  mo.observe(box.places, { childList: true });
  Promise.allSettled([
    load('onboard', './onboard.js', 'mountOnboardCard', (m) => { if (m.onTripChange) offs.push(m.onTripChange(evaluate)); }),
    load('places', './places.js', 'mountPlacesCard'),
  ]).then((rs) => { rs.forEach((r) => r.status === 'rejected' && console.error('[home]', r.reason)); evaluate(); });

  const paint = () => {
    const favs = getFavorites().map((code) => data.stopByCode.get(String(code))).filter(Boolean);
    const rs = recentStops(5);
    const rp = recentPlaces(3);
    more.replaceChildren(...[
      favs.length ? h('section', { class: 'home-section' }, h('h2', {}, t('Αγαπημένες στάσεις')), h('div', { class: 'list' }, favs.map((s) => stopRow(s)))) : null,
      rs.length || rp.length ? h('section', { class: 'home-section' }, h('h2', {}, t('Πρόσφατα')), h('div', { class: 'list' }, rs.map((s) => stopRow(s)), rp.map(placeRow))) : null].filter(Boolean));
    more.hidden = !more.childElementCount;
  };
  paint();
  offs.push(onChange(paint));

  // One small card, once: "first time here?" until the guide was opened or dismissed; after that, on a phone browser tab,
  // a one-time "add to home screen" hint. Never both, never on a deep-link boot (bootHome). Either action stores its flag.
  let hintTimer = 0;
  const paintHint = async () => {
    if (!bootHome) return;
    let spec = null;
    if (!getSettings().guideSeen) {
      spec = { flag: 'guideSeen', ico: 'info', href: '#/guide', text: t('Πρώτη φορά εδώ; Δες τον οδηγό') };
    } else if (!getSettings().installHintDismissed) {
      let ih = null;
      try { ih = (await installGuide()).installHint(); } catch { /* no install helper: no hint */ }
      if (ih && !getSettings().installHintDismissed) {
        spec = { flag: 'installHintDismissed', ico: 'home', href: '#/guide?section=install', text: t('Βάλε την εφαρμογή στην αρχική οθόνη') };
      }
    }
    if (!spec || dead) return;
    const done = () => setSetting(spec.flag, true);
    const go = h('a', { class: 'guide-hint-go press', href: cityHash(spec.href), onclick: done }, icon(spec.ico), h('span', {}, spec.text));
    const x = h('button', { type: 'button', class: 'guide-hint-x press', 'aria-label': t('Κλείσιμο'), onclick: () => {
      done();
      hint.classList.add('is-leaving');
      hintTimer = setTimeout(() => { hint.hidden = true; hint.replaceChildren(); }, reduceMotion.matches ? 0 : LEAVE_MS);
    } }, icon('close'));
    hint.className = 'guide-hint material card-in';
    hint.replaceChildren(go, x);
    hint.hidden = false;
  };
  paintHint();

  return {
    destroy() {
      dead = true;
      clearTimeout(hintTimer);
      mo.disconnect();
      Object.values(hideTimers).forEach((id) => id && clearTimeout(id));
      offs.forEach((f) => f?.());
      Object.values(views).forEach((v) => v?.destroy?.());
    },
  };
}

function mountFavorites(container, c) {
  const body = h('div');
  container.replaceChildren(
    h('div', { class: 'view-head' }, backBtn(), h('h1', {}, t('Αγαπημένες στάσεις'))), body);
  const paint = () => {
    const favs = getFavorites().map((code) => data.stopByCode.get(String(code))).filter(Boolean);
    body.replaceChildren(favs.length
      ? h('div', { class: 'list' }, favs.map((s) => stopRow(s)))
      : h('p', { class: 'hint' }, t('Δεν έχεις αγαπημένες στάσεις ακόμα. Άνοιξε μια στάση και πάτα το αστέρι για να την προσθέσεις.')));
  };
  paint();
  const off = onChange(paint);
  return { destroy: off };
}

function mountPin(container, c, p) {
  const fix = locationService.current;
  const near = nearestStops(data.stops, p, { limit: 5, maxMeters: 1500 });
  const sub = [`${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`];
  if (fix) sub.push(t('{d} από εσένα', { d: fmtDist(haversine(fix, p)) }));
  container.replaceChildren(
    h('div', { class: 'view-head' }, backBtn(), h('h1', {}, pinName(), h('span', { class: 'sub' }, sub.join(' · ')))),
    h('div', { class: 'btn-row' },
      h('a', { class: 'btn primary', href: planHash(p, pinName()) }, icon('route'), t('Διαδρομή ως εδώ'))),
    h('section', { class: 'home-section' },
      h('h2', {}, t('Κοντινές στάσεις')),
      near.length ? h('div', { class: 'list' }, near.map((n) => stopRow(n.stop, n.meters)))
        : h('p', { class: 'hint' }, t('Δεν υπάρχει στάση σε απόσταση 1,5 χλμ από αυτό το σημείο.'))));
  c.map.setMarkers('pin', [{ ...p, kind: 'pin' }]);
  return { destroy() { c.map.clearMarkers('pin'); } };
}

// ---------------------------------------------------------------- router
let view = null;
let routeToken = 0;
let nextSnap = null;
let currentHead = '';
// Where the user was before opening the report sheet: the screen name and a public stop/line code, never the query (no coordinates).
let reportCtx = { view: '', ref: '' };
let booted = false;
const SNAP = { '': 'half', stop: 'half', bus: 'half', plan: 'half', lines: 'half', line: 'half', favorites: 'half', pin: 'half', settings: 'full', guide: 'full', report: 'full' };

// Switching city = remember it, go to that city's home, reload (data, map and stored items are per city).
function switchCity(id) {
  if (!isCity(id) || id === cityId()) return;
  setSetting('city', id);
  try { history.replaceState(null, '', formatHash('#/', id)); } catch { /* ignore */ }
  location.reload();
}
function teardown() {
  try { view?.destroy?.(); } catch (err) { console.error('[view destroy]', err); }
  view = null;
  map.highlightStop(null);
  map.clearMarkers('pin');
}
// Contextual shortcuts: saved places (max 3), home screen only. Nothing is rendered when there are none.
let getPlaces = () => [];
import('./places.js').then((m) => { getPlaces = m.getPlaces; paintChips(); }).catch(() => {});
function paintChips() {
  let list = [];
  try { list = currentHead === '' ? getPlaces().filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng)).slice(0, 3) : []; } catch { /* ignore */ }
  chipsEl.replaceChildren(...list.map((p) => h('a', { class: 'chip', href: planHash(p, p.name) }, icon(p.id === 'home' ? 'home' : p.id === 'work' ? 'briefcase' : 'pin'), p.name)));
  chipsEl.hidden = !list.length;
  appEl.classList.toggle('has-chips', !chipsEl.hidden);
}

// A notification link (`#/notif?routine=…|ref=…&stop=…`, js/notif-link.js) → the hash it stands for on this device.
async function resolveNotifLink(params) {
  const stop = params.stop && data.stopByCode.has(String(params.stop)) ? `#/stop/${encodeURIComponent(params.stop)}` : '#/';
  try {
    const [nl, rt, pl] = await Promise.all([import('./notif-link.js'), import('./routines.js'), import('./places.js')]);
    return nl.resolveNotif(params, { routines: rt.getRoutines(), places: pl.getPlaces(), links: nl.createLinks(), hasStop: (c) => data.stopByCode.has(c) });
  } catch (err) {
    console.error('[notif]', err);
    return stop;
  }
}

async function route() {
  const token = ++routeToken;
  const { city: hashCity, rel, parts, params } = parseHash(location.hash);
  // A link into the other city (pasted, shared, history): the page is per city, so remember it and reload on that hash.
  if (hashCity && hashCity !== cityId()) { setSetting('city', hashCity); location.reload(); return; }
  if (parts[0] === 'notif') {
    const to = await resolveNotifLink(params);
    if (token !== routeToken) return;
    try { history.replaceState(history.state, '', cityHash(to)); } catch { /* ignore */ }
    route();
    return;
  }
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
  searchbarEl.hidden = currentHead !== '';
  if (currentHead !== 'report') reportCtx = { view: currentHead || 'home', ref: currentHead === 'stop' || currentHead === 'line' ? String(arg) : '' };
  if (SNAP[head] == null) history.replaceState(null, '', cityHash('#/'));
  const content = sheet.content;
  content.replaceChildren();
  sheet.scrollToTop();
  if (!reduceMotion.matches) { content.classList.remove('enter'); void content.offsetWidth; content.classList.add('enter'); }
  paintChips();
  document.title = title();

  focusPt = null;
  routeSnap = true;
  sheet.snap(nextSnap || SNAP[currentHead], { animate: booted });
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
    case 'plan':
      document.title = `${t('Διαδρομή')} · ${title()}`;
      await mount(() => import('./planner-view.js'), (m) => m.mountPlanner(content, ctx, {
        to: parsePt(params.to) || undefined, from: parsePt(params.from) || undefined, name: params.name || undefined,
      }));
      break;
    case 'lines':
      document.title = `${t('Γραμμές')} · ${title()}`;
      await mount(() => import('./lines-view.js'), (m) => m.mountLines(content, ctx));
      break;
    case 'line':
      document.title = `${t('Γραμμή {code}', { code: arg })} · ${title()}`;
      await mount(() => import('./lines-view.js'), (m) => m.mountLine(content, ctx, { code: String(arg), dir: params.dir ? Number(params.dir) : undefined, route: params.route || undefined }));
      break;
    case 'settings':
      document.title = `${t('Ρυθμίσεις')} · ${title()}`;
      await mount(() => import('./settings-view.js'), (m) => m.mountSettings(content, ctx));
      break;
    case 'report':
      document.title = `${t('Αναφορά προβλήματος')} · ${title()}`;
      await mount(() => import('./report-view.js'), (m) => m.mountReport(content, ctx, { context: reportCtx }));
      break;
    case 'guide': {
      document.title = `${t('Οδηγός')} · ${title()}`;
      // The install tutorial is optional: without install-guide.js the guide simply has no install section.
      let install = null;
      try { install = await installGuide(); } catch { /* the guide still works */ }
      if (token !== routeToken) break;
      ctx.renderInstall = install ? () => install.renderInstallSection() : undefined;
      await mount(() => import('./guide-view.js'), (m) => m.mountGuide(content, ctx, { section: params.section || undefined }));
      break;
    }
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
    default:
      view = mountHome(content, ctx);
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
  chipsEl.setAttribute('aria-label', t('Αποθηκευμένα μέρη'));
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
  sheet = createSheet($('sheet'), { onSnap, onMove });
  buildChrome();
  map = createMap($('map'), { theme: resolveTheme(), attribInto: fabsBottom, avoid: { top: ['#menu-btn', '#chips', '#offline-pill'], right: ['#fabs-bottom'] }, onStopClick, onVehicleClick, onMapClick, onLongPress, onUserMove, onBearing });
  if (!map.available) enterNoMap(map.reason);
  applyTheme();
  setLocMode('idle');

  try {
    data = await loadData();
  } catch (err) {
    console.error('[data]', err);
    sheet.content.replaceChildren(errorState(t('Δεν φορτώθηκαν τα δεδομένα στάσεων.'), () => location.reload()));
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
  try { setupClosed = (await setupP)?.maybeSetup({ bootHome, ctx }) ?? null; } catch (err) { console.error('[setup]', err); }
  await route();
  booted = true;
  // One-time thank-you for the testers, only when opened as an installed app (or with ?welcome to preview). Never blocks boot.
  // After the first-run setup, when both apply (first launch of the installed app).
  Promise.resolve(setupClosed).then(() => import('./welcome.js').then((m) => m.maybeWelcome()).catch(() => {}));
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
});
