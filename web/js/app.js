// App shell and integrator (owner: shell). Boots data + map + sheet, wires location, search, theme and the hash router.
// Views are lazy-loaded modules with `mountX(container, ctx, params) -> { destroy() }` (docs/ARCHITECTURE.md).
import { h, icon, toast, lineBadge } from './ui.js';
import { loadData, searchStops } from './data.js';
import { createMap } from './map.js';
import { createSheet } from './sheet.js';
import locationService from './location.js';
import { DEMO } from './api.js';
import { getRecents, addRecent, getFavorites, getSettings, setSetting, onChange } from './store.js';
import { searchPlaces } from './geocode.js';
import { haversine, fmtDist, nearestStops, inArea } from './geo.js';
import './notify.js'; // re-arms persisted reminders after a reload

const $ = (id) => document.getElementById(id);
const root = document.documentElement;
const appEl = $('app');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const darkMQ = matchMedia('(prefers-color-scheme: dark)');
const TITLE = 'Λεωφορεία Πάτρας';
const PIN_NAME = 'Επιλεγμένο σημείο';

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
  paintLayersPop();
}

// ---------------------------------------------------------------- small helpers
const parsePt = (s) => {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(s || '');
  return m ? { lat: Number(m[1]), lng: Number(m[2]) } : null;
};
const ptStr = (p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
const planHash = (to, name) => `#/plan?to=${ptStr(to)}${name ? `&name=${encodeURIComponent(name)}` : ''}`;
const msgEl = (text) => h('p', { class: 'state-msg' }, text);
const errorState = (text, retry) => h('div', {}, msgEl(text), h('button', { type: 'button', class: 'btn primary', onclick: retry }, 'Δοκίμασε ξανά'));
const backBtn = (to = '#/') => h('a', { class: 'icon-btn', href: to, 'aria-label': 'Πίσω' }, icon('back'));

function lineBadges(stop, max = 6) {
  return stop.lineCodes.slice(0, max).map((c) => lineBadge(data.lineByCode.get(c) || { code: c }));
}
function stopRow(stop, meters) {
  return h('a', { class: 'stop-row', href: `#/stop/${encodeURIComponent(stop.code)}` },
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
const pops = [];
function makePopover(btn, pop) {
  const onDown = (e) => { if (!pop.contains(e.target) && !btn.contains(e.target)) close(false); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(true); } };
  function close(focusBtn) {
    if (pop.hidden) return;
    pop.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    if (focusBtn) btn.focus();
  }
  function open() {
    pops.forEach((p) => p.close(false));
    pop.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    (pop.querySelector('[aria-checked="true"], [aria-current="page"], a, button'))?.focus();
  }
  const p = { open, close };
  pops.push(p);
  pop.addEventListener('click', (e) => { if (e.target.closest('a, button')) close(false); });
  return p;
}

// ---------------------------------------------------------------- menu + layers popovers
const menuBtn = $('menu-btn');
const menuPop = $('menu-pop');
const layersBtn = $('layers-btn');
const layersPop = $('layers-pop');
let menuPopover;
let layersPopover;

function buildMenu() {
  const item = (href, ico, label) => h('a', { class: 'pop-item', href }, icon(ico), label);
  menuPop.replaceChildren(
    item('#/', 'home', 'Αρχική'),
    item('#/favorites', 'star', 'Αγαπημένες στάσεις'),
    item('#/lines', 'bus', 'Γραμμές'),
    item('#/plan', 'route', 'Διαδρομή'),
    h('div', { class: 'pop-sep' }),
    item('#/settings', 'settings', 'Ρυθμίσεις και σχετικά'));
}
const THEMES = [['auto', 'layers', 'Αυτόματο'], ['light', 'sun', 'Φωτεινό'], ['dark', 'moon', 'Σκοτεινό']];
function buildLayersPop() {
  layersPop.replaceChildren(
    h('div', { class: 'pop-head', id: 'theme-label' }, 'Θέμα χάρτη'),
    h('div', { role: 'radiogroup', 'aria-labelledby': 'theme-label' },
      THEMES.map(([value, ico, label]) => h('button', {
        type: 'button', class: 'pop-item', role: 'radio', 'data-value': value, 'aria-checked': 'false',
        onclick: () => setSetting('theme', value),
      }, icon(ico), label, h('span', { class: 'tick' }, icon('check'))))));
  paintLayersPop();
}
function paintLayersPop() {
  const cur = getSettings().theme || 'auto';
  layersPop.querySelectorAll('[role="radio"]').forEach((b) => {
    const on = b.dataset.value === cur;
    b.setAttribute('aria-checked', String(on));
    b.querySelector('.tick').hidden = !on;
  });
}

// Runs after the popover consts exist (applyTheme repaints the layers popover).
applyTheme();
darkMQ.addEventListener('change', applyTheme);
onChange(applyTheme);

// ---------------------------------------------------------------- sheet <-> map/floating UI
const fabsBottom = $('fabs-bottom');
const fabsTop = $('fabs-top');
const desktopMQ = matchMedia('(min-width: 900px)');
const toastHost = $('toasts');
let attribEl = null;
const chipsEl = $('chips');
function onSnap({ visible, desktop }) {
  if (!map) return;
  if (desktop) {
    map.setPadding({ top: 72, bottom: 0, left: sheet.el.offsetWidth, right: 0 });
  } else {
    const top = chipsEl.getBoundingClientRect().bottom + 8;
    map.setPadding({ top, bottom: Math.min(visible, innerHeight * 0.6), left: 0, right: 0 });
  }
}
function onMove({ lift, opacity }) {
  fabsBottom.style.transform = lift ? `translateY(${-lift}px)` : '';
  fabsBottom.style.opacity = String(opacity);
  fabsBottom.style.pointerEvents = opacity < 0.05 ? 'none' : '';
  if (!desktopMQ.matches) {
    fabsTop.style.opacity = String(opacity);
    fabsTop.style.pointerEvents = opacity < 0.05 ? 'none' : '';
    fabsTop.style.visibility = opacity < 0.05 ? 'hidden' : '';
  } else { fabsTop.style.opacity = ''; fabsTop.style.pointerEvents = ''; fabsTop.style.visibility = ''; }
  toastHost.style.transform = `translate(-50%, ${-lift}px)`;
  attribEl ||= appEl.querySelector('.maplibregl-ctrl-bottom-right');
  if (attribEl) attribEl.style.transform = lift ? `translateY(${-lift}px)` : '';
}

// ---------------------------------------------------------------- locate FAB (idle -> centre -> follow -> compass)
const locateBtn = $('locate-btn');
const northBtn = $('north-btn');
const LOC_ICON = { idle: 'locate', centre: 'locate-fixed', follow: 'locate-fixed', compass: 'compass' };
const LOC_LABEL = {
  idle: 'Εντοπισμός τοποθεσίας', centre: 'Ακολούθησε τη θέση μου',
  follow: 'Περιστροφή χάρτη με την πυξίδα', compass: 'Σταμάτα την περιστροφή του χάρτη',
};
let locMode = 'idle';
let wantFix = false; // the user asked for a location and we are waiting for the first fix
let firstFixHandled = false;

function setLocMode(m) {
  locMode = m;
  locateBtn.dataset.mode = m;
  locateBtn.setAttribute('aria-label', LOC_LABEL[m]);
  locateBtn.title = LOC_LABEL[m];
  locateBtn.replaceChildren(icon(LOC_ICON[m]));
  map?.setFollow(m === 'idle' ? 'off' : m);
}
function paintLocating() {
  locateBtn.classList.toggle('locating', wantFix || locationService.status === 'locating');
}
const LOC_ERR = {
  denied: 'Δεν δόθηκε άδεια τοποθεσίας. Μπορείς να την ενεργοποιήσεις από τις ρυθμίσεις του προγράμματος περιήγησης.',
  unavailable: 'Η τοποθεσία δεν είναι διαθέσιμη αυτή τη στιγμή.',
  insecure: 'Η τοποθεσία χρειάζεται ασφαλή σύνδεση (https).',
};
function onLocation(fix, status) {
  map?.setUserFix(fix);
  if (fix && wantFix) { wantFix = false; setLocMode('centre'); }
  if (!fix && wantFix && status !== 'locating' && status !== 'idle') {
    wantFix = false;
    if (status === 'timeout') toast('Δεν βρέθηκε η τοποθεσία σου. Δοκίμασε ξανά.', { action: { label: 'Ξανά', onClick: () => requestCentre() } });
    else if (LOC_ERR[status]) toast(LOC_ERR[status]);
  }
  // First fix of the session while browsing the home screen inside Patras: show where you are.
  if (fix && !firstFixHandled && inArea(fix)) {
    firstFixHandled = true;
    if (currentHead === '' && locMode === 'idle') map?.flyTo(fix, 15.5);
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
    else toast('Η πυξίδα δεν είναι διαθέσιμη σε αυτή τη συσκευή.');
  } else setLocMode('follow');
});
northBtn.addEventListener('click', () => map?.resetNorth());
function onBearing(b) {
  const off = Math.abs(b) < 1;
  northBtn.hidden = off;
  northBtn.firstChild.style.transform = `rotate(${-b}deg)`;
}
function onUserMove() { wantFix = false; setLocMode('idle'); paintLocating(); }

// ---------------------------------------------------------------- search
const searchInput = $('search-input');
const searchPanel = $('search-panel');
const searchList = $('search-list');
const searchClear = $('search-clear');
const searchDecor = $('search-decor');
let searchOpen = false;
let activeIdx = -1;
let rows = [];
let placeTimer = 0;
let placeCtl = null;
let places = { q: '', loading: false, results: [], failed: false };

function openSearch() {
  if (searchOpen) return;
  searchOpen = true;
  searchPanel.hidden = false;
  searchInput.setAttribute('aria-expanded', 'true');
  menuPopover.close(false);
  menuBtn.replaceChildren(icon('back'));
  menuBtn.setAttribute('aria-label', 'Κλείσιμο αναζήτησης');
  menuBtn.removeAttribute('aria-haspopup');
  menuBtn.removeAttribute('aria-expanded');
  renderSearch();
}
function closeSearch(focusMenu = false) {
  if (!searchOpen) return;
  searchOpen = false;
  clearTimeout(placeTimer);
  placeCtl?.abort();
  places = { q: '', loading: false, results: [], failed: false };
  searchPanel.hidden = true;
  searchInput.value = '';
  searchInput.setAttribute('aria-expanded', 'false');
  searchInput.removeAttribute('aria-activedescendant');
  searchClear.hidden = true;
  searchDecor.hidden = false;
  menuBtn.replaceChildren(icon('menu'));
  menuBtn.setAttribute('aria-label', 'Μενού');
  menuBtn.setAttribute('aria-haspopup', 'true');
  menuBtn.setAttribute('aria-expanded', 'false');
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
  const stopRows = (list) => list.map((s) => srRow(`sr-${n++}`, 'bus', s.displayName, stopSub(s), () => chooseStop(s)));
  if (!q) {
    const rs = recentStops(4);
    const rp = recentPlaces(4);
    if (rs.length || rp.length) {
      out.push(srHead('Πρόσφατα'), ...stopRows(rs),
        ...rp.map((p) => srRow(`sr-${n++}`, 'history', p.name, p.subtitle, () => choosePlace(p))));
    } else {
      out.push(h('p', { class: 'sr-msg' }, 'Γράψε το όνομα μιας στάσης, έναν κωδικό στάσης ή έναν τόπο.'));
    }
  } else {
    const stops = searchStops(data, q, 6);
    if (stops.length) out.push(srHead('Στάσεις'), ...stopRows(stops));
    const seen = new Set(stops.map((s) => s.code));
    const found = places.q === q
      ? places.results.filter((p) => !(p.kind === 'stop' && seen.has(String(p.stopCode)))) : [];
    if (found.length) {
      out.push(srHead('Τόποι'), ...found.map((p) => srRow(`sr-${n++}`, p.kind === 'stop' ? 'bus' : 'pin', p.name, p.subtitle, () => choosePlace(p))));
    }
    if (places.q === q && places.loading) out.push(h('p', { class: 'sr-msg', role: 'status' }, 'Αναζήτηση τόπων…'));
    else if (places.q === q && places.failed && !found.length) out.push(h('p', { class: 'sr-msg' }, 'Δεν ήταν δυνατή η αναζήτηση τόπων.'));
    else if (!stops.length && !found.length && q.length >= 3 && places.q === q) out.push(h('p', { class: 'sr-msg' }, 'Κανένα αποτέλεσμα'));
    else if (!stops.length && q.length < 3) out.push(h('p', { class: 'sr-msg' }, 'Κανένα αποτέλεσμα'));
  }
  searchList.replaceChildren(...out);
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
  searchDecor.hidden = !!searchInput.value;
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
    closeSearch(true);
  }
});
searchClear.addEventListener('click', () => {
  searchInput.value = '';
  searchClear.hidden = true;
  searchDecor.hidden = false;
  clearTimeout(placeTimer);
  placeCtl?.abort();
  places = { q: '', loading: false, results: [], failed: false };
  renderSearch();
  searchInput.focus();
});
$('searchbar').addEventListener('click', (e) => { if (!e.target.closest('button')) searchInput.focus(); });
menuBtn.addEventListener('click', () => {
  if (searchOpen) closeSearch(true);
  else if (menuPop.hidden) menuPopover.open();
  else menuPopover.close(true);
});
searchPanel.addEventListener('scroll', () => { if (document.activeElement === searchInput && matchMedia('(pointer: coarse)').matches) searchInput.blur(); }, { passive: true });
document.addEventListener('pointerdown', (e) => {
  if (searchOpen && !e.target.closest('#searchbar, #search-panel')) closeSearch();
}, true);

// ---------------------------------------------------------------- views owned by the shell
function mountHome(container, c) {
  const nearbyBox = h('div', { class: 'home-nearby' });
  const favBox = h('section', { class: 'home-section' });
  const recBox = h('section', { class: 'home-section' });
  container.replaceChildren(
    h('div', { class: 'view-head root' }, h('h1', {}, TITLE)),
    nearbyBox, favBox, recBox);
  let nearby = null;
  let dead = false;
  import('./nearby.js').then((m) => {
    if (dead) return;
    nearby = m.mountNearby(nearbyBox, c);
  }).catch((err) => { console.error(err); nearbyBox.replaceChildren(msgEl('Δεν φορτώθηκε η ενότητα «κοντά σου».')); });

  const paint = () => {
    const favs = getFavorites().map((code) => data.stopByCode.get(String(code))).filter(Boolean);
    favBox.replaceChildren(h('h2', {}, 'Αγαπημένες στάσεις'),
      favs.length ? h('div', { class: 'list' }, favs.map((s) => stopRow(s)))
        : h('p', { class: 'hint' }, 'Πάτα το αστέρι σε μια στάση για να τη βρίσκεις εδώ.'));
    const rs = recentStops(5);
    const rp = recentPlaces(3);
    recBox.hidden = !rs.length && !rp.length;
    recBox.replaceChildren(h('h2', {}, 'Πρόσφατα'), h('div', { class: 'list' }, rs.map((s) => stopRow(s)), rp.map(placeRow)));
  };
  paint();
  const off = onChange(paint);
  return { destroy() { dead = true; off(); nearby?.destroy(); } };
}

function mountFavorites(container, c) {
  const body = h('div');
  container.replaceChildren(
    h('div', { class: 'view-head' }, backBtn(), h('h1', {}, 'Αγαπημένες στάσεις')), body);
  const paint = () => {
    const favs = getFavorites().map((code) => data.stopByCode.get(String(code))).filter(Boolean);
    body.replaceChildren(favs.length
      ? h('div', { class: 'list' }, favs.map((s) => stopRow(s)))
      : h('p', { class: 'hint' }, 'Δεν έχεις αγαπημένες στάσεις ακόμα. Άνοιξε μια στάση και πάτα το αστέρι για να την προσθέσεις.'));
  };
  paint();
  const off = onChange(paint);
  return { destroy: off };
}

function mountPin(container, c, p) {
  const fix = locationService.current;
  const near = nearestStops(data.stops, p, { limit: 5, maxMeters: 1500 });
  const sub = [`${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`];
  if (fix) sub.push(`${fmtDist(haversine(fix, p))} από εσένα`);
  container.replaceChildren(
    h('div', { class: 'view-head' }, backBtn(), h('h1', {}, PIN_NAME, h('span', { class: 'sub' }, sub.join(' · ')))),
    h('div', { class: 'btn-row' },
      h('a', { class: 'btn primary', href: planHash(p, PIN_NAME) }, icon('route'), 'Διαδρομή ως εδώ')),
    h('section', { class: 'home-section' },
      h('h2', {}, 'Κοντινές στάσεις'),
      near.length ? h('div', { class: 'list' }, near.map((n) => stopRow(n.stop, n.meters)))
        : h('p', { class: 'hint' }, 'Δεν υπάρχει στάση σε απόσταση 1,5 χλμ από αυτό το σημείο.')));
  c.map.setMarkers('pin', [{ ...p, kind: 'pin' }]);
  return { destroy() { c.map.clearMarkers('pin'); } };
}

// ---------------------------------------------------------------- router
let view = null;
let routeToken = 0;
let nextSnap = null;
let currentHead = '';
let booted = false;
const SNAP = { '': 'half', stop: 'half', plan: 'half', lines: 'half', line: 'half', favorites: 'half', pin: 'half', settings: 'full' };
const CHIP_FOR = { '': 'home', favorites: 'favorites', lines: 'lines', line: 'lines', plan: 'plan' };

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, qs = ''] = raw.split('?');
  return { parts: path.split('/').filter(Boolean).map(safeDecode), params: Object.fromEntries(new URLSearchParams(qs)) };
}
function teardown() {
  try { view?.destroy?.(); } catch (err) { console.error('[view destroy]', err); }
  view = null;
  map.highlightStop(null);
  map.clearMarkers('pin');
}
function paintChips(head) {
  const active = CHIP_FOR[head];
  chipsEl.querySelectorAll('.chip').forEach((a) => {
    if (a.dataset.chip === active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
}

async function route() {
  const token = ++routeToken;
  closeSearch();
  menuPopover.close(false);
  layersPopover.close(false);
  teardown();
  const { parts, params } = parseHash();
  const head = parts[0] || '';
  const arg = parts[1];
  currentHead = SNAP[head] != null ? head : '';
  if (SNAP[head] == null) history.replaceState(null, '', '#/');
  const content = sheet.content;
  content.replaceChildren();
  sheet.scrollToTop();
  if (!reduceMotion.matches) { content.classList.remove('enter'); void content.offsetWidth; content.classList.add('enter'); }
  paintChips(currentHead);
  document.title = TITLE;

  sheet.snap(nextSnap || SNAP[currentHead], { animate: booted });
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
      if (token === routeToken) content.replaceChildren(errorState('Δεν φορτώθηκε αυτή η οθόνη.', () => route()));
    }
  };

  switch (currentHead) {
    case 'stop': {
      const stop = data.stopByCode.get(String(arg));
      if (!stop) {
        content.replaceChildren(h('div', { class: 'view-head' }, backBtn(), h('h1', {}, 'Η στάση δεν βρέθηκε')));
        break;
      }
      document.title = `${stop.displayName} · ${TITLE}`;
      noteStop(stop);
      map.highlightStop(stop.code);
      map.flyTo(stop, 17);
      await mount(() => import('./arrivals-view.js'), (m) => m.mountStop(content, ctx, { code: stop.code }));
      break;
    }
    case 'plan':
      document.title = `Διαδρομή · ${TITLE}`;
      await mount(() => import('./planner-view.js'), (m) => m.mountPlanner(content, ctx, {
        to: parsePt(params.to) || undefined, from: parsePt(params.from) || undefined, name: params.name || undefined,
      }));
      break;
    case 'lines':
      document.title = `Γραμμές · ${TITLE}`;
      await mount(() => import('./lines-view.js'), (m) => m.mountLines(content, ctx));
      break;
    case 'line':
      document.title = `Γραμμή ${arg} · ${TITLE}`;
      await mount(() => import('./lines-view.js'), (m) => m.mountLine(content, ctx, { code: String(arg), dir: params.dir ? Number(params.dir) : undefined, route: params.route || undefined }));
      break;
    case 'settings':
      document.title = `Ρυθμίσεις · ${TITLE}`;
      await mount(() => import('./settings-view.js'), (m) => m.mountSettings(content, ctx));
      break;
    case 'favorites':
      document.title = `Αγαπημένες στάσεις · ${TITLE}`;
      view = mountFavorites(content, ctx);
      break;
    case 'pin': {
      const p = parsePt(`${params.lat},${params.lng}`);
      if (!p) { ctx.navigate('#/'); break; }
      document.title = `${PIN_NAME} · ${TITLE}`;
      view = mountPin(content, ctx, p);
      map.flyTo(p, 17);
      break;
    }
    default:
      view = mountHome(content, ctx);
  }
  if (booted && (document.activeElement === document.body || !document.activeElement)) sheet.body.focus({ preventScroll: true });
}

function navigate(hash, opts = {}) {
  nextSnap = opts.snap || null;
  const cur = location.hash || '#/';
  if (cur === hash || (hash === '#/' && (cur === '#' || cur === '#/'))) route();
  else location.hash = hash;
}

// ---------------------------------------------------------------- map events
function onStopClick(code) { navigate(`#/stop/${encodeURIComponent(code)}`); }
function onMapClick() {
  if (currentHead === 'stop' || currentHead === 'pin') navigate('#/', { snap: 'peek' });
  else if (currentHead === '' && sheet.state !== 'peek') sheet.snap('peek');
}
function onLongPress(p) {
  if (!inArea(p)) toast('Το σημείο είναι εκτός της περιοχής της Πάτρας.');
  navigate(`#/pin?lat=${p.lat.toFixed(5)}&lng=${p.lng.toFixed(5)}`);
}

// ---------------------------------------------------------------- boot
function enterNoMap(reason) {
  appEl.classList.add('no-map');
  sheet.setFixed(true);
  const note = $('map-note');
  note.textContent = reason === 'script'
    ? 'Δεν φορτώθηκε ο χάρτης (έλεγξε τη σύνδεσή σου). Η εφαρμογή λειτουργεί ως λίστα.'
    : 'Ο χάρτης δεν είναι διαθέσιμος σε αυτή τη συσκευή. Η εφαρμογή λειτουργεί ως λίστα.';
  note.hidden = false;
}

function buildChrome() {
  menuBtn.append(icon('menu'));
  searchClear.append(icon('close'));
  searchDecor.append(icon('search'));
  layersBtn.append(icon('layers'));
  northBtn.append(icon('compass'));
  locateBtn.append(icon('locate'));
  layersBtn.title = 'Θέμα χάρτη';
  northBtn.title = 'Επαναφορά βορρά';
  locateBtn.title = LOC_LABEL.idle;
  const chips = [['near', 'locate', 'Κοντά μου', '#/'], ['favorites', 'star', 'Αγαπημένα', '#/favorites'],
    ['lines', 'bus', 'Γραμμές', '#/lines'], ['plan', 'route', 'Διαδρομή', '#/plan']];
  chipsEl.replaceChildren(...chips.map(([key, ico, label, href]) => {
    const a = h('a', { class: 'chip', href, 'data-chip': key === 'near' ? 'home' : key }, icon(ico), label);
    if (key === 'near') a.addEventListener('click', () => { requestCentre(); });
    return a;
  }));
  buildMenu();
  buildLayersPop();
  menuPopover = makePopover(menuBtn, menuPop);
  layersPopover = makePopover(layersBtn, layersPop);
  layersBtn.addEventListener('click', () => (layersPop.hidden ? layersPopover.open() : layersPopover.close(true)));
  if (DEMO) $('demo-tag').hidden = false;
}

async function boot() {
  sheet = createSheet($('sheet'), { onSnap, onMove });
  buildChrome();
  map = createMap($('map'), { theme: resolveTheme(), onStopClick, onMapClick, onLongPress, onUserMove, onBearing });
  if (!map.available) enterNoMap(map.reason);
  applyTheme();
  setLocMode('idle');

  try {
    data = await loadData();
  } catch (err) {
    console.error('[data]', err);
    sheet.content.replaceChildren(errorState('Δεν φορτώθηκαν τα δεδομένα στάσεων.', () => location.reload()));
    return;
  }
  map.setStops(data.stops);
  ctx = {
    data, map, location: locationService, navigate,
    sheet: { snap: (to) => sheet.snap(to), get state() { return sheet.state; } },
    toast,
  };

  if (new URLSearchParams(location.search).has('debug')) window.__app = { map, sheet, ctx, data };
  locationService.subscribe(onLocation);
  onLocation(locationService.current, locationService.status);
  locationService.autoStart?.(); // only if permission is already granted: no prompt on load

  window.addEventListener('hashchange', () => route());
  await route();
  booted = true;

  if ('serviceWorker' in navigator) {
    const reg = () => navigator.serviceWorker.register('sw.js').catch(() => {});
    if (document.readyState === 'complete') reg(); else window.addEventListener('load', reg, { once: true });
  }
}

boot().catch((err) => {
  console.error('[boot]', err);
  sheet?.content.replaceChildren(errorState('Κάτι πήγε στραβά.', () => location.reload()));
});
