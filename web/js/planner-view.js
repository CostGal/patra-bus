// Trip planner view (owner: planner): destination search, itinerary cards, "Φύγε σε X′" hero, timeline, map overlays.
// Contract: mountPlanner(container, ctx, { to?, from?, name? }) → { destroy }. Styles: css/planner.css (prefix .pl-).
import { h, icon, lineBadge, fmtClock, toast } from './ui.js';
import { arrivalTile } from './arrivals-view.js';
import { etaText } from './arrivals.js';
import { fmtDist, haversine, nearestStops } from './geo.js';
import { searchPlaces, stopPlaces } from './geocode.js';
import { planTripsDetailed, reminderTrip, retime, leaveState, rankItineraries, rideGeometry, snapStopsToShape } from './planner.js';
import { loadShapes } from './data.js';
import { getRecents, addRecent, getSettings } from './store.js';
import { scheduleReminder, cancelReminder, hasReminder, listReminders, ensurePermission } from './notify.js';
import { titleCase } from './text.js';

const REFRESH_MS = 20000; // live refresh (api.js keeps each stop at ≥ 15 s)
const MOVE_M = 75;        // re-plan when the user has moved this far
const REPLAN_GAP_MS = 5000;
const DEBOUNCE_MS = 300;
const MY_LOCATION = 'Η τοποθεσία μου';
const CENTER_NAME = 'Κέντρο του χάρτη';

// ---------------------------------------------------------------- helpers

export function parsePoint(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'string') { const [a, b] = v.split(',').map(Number); v = { lat: a, lng: b }; }
  else if (Array.isArray(v)) v = { lat: Number(v[0]), lng: Number(v[1]) };
  return Number.isFinite(v?.lat) && Number.isFinite(v?.lng) ? { lat: v.lat, lng: v.lng } : null;
}
const r5 = (n) => n.toFixed(5);
const dur = (sec) => {
  const m = Math.max(1, Math.round(sec / 60));
  return m < 60 ? `${m}′` : `${Math.floor(m / 60)} ώ ${String(m % 60).padStart(2, '0')}′`;
};
// "ΝΕΟΣ ΔΡΟΜΟΣ-ΤΑΡΑΜΠΟΥΡΑ" → "Ταραμπουρα": route names are "from-to", the bus goes towards the last part.
// Last terminal of "A - B (via-C)": the bracketed part may contain dashes too, so it is dropped first.
const towards = (name) => {
  const base = String(name || '').replace(/\s*\([^)]*\)?\s*$/, '').trim() || String(name || '');
  return titleCase(base.split(/\s*[-–]\s*/).filter(Boolean).at(-1) || base);
};
const svgPin = () => icon('pin');

function lineString(coords) {
  return { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } }] };
}

// ---------------------------------------------------------------- view

export function mountPlanner(container, ctx, params = {}) {
  let dead = false;
  const S = {
    from: null,          // { lat, lng, name, source: 'gps'|'map'|'place'|'url' }
    to: null,            // { lat, lng, name, subtitle?, stopCode? }
    its: [], result: null, selectedId: null, userPicked: false,
    loading: false, error: null, pending: 0,
    editing: null,       // 'from' | 'to' | null  (suggestions replace the results)
    sug: { query: '', places: [], loading: false, offline: false, error: false },
  };
  const walkCache = new Map();
  const prefer = new Map(); // itinerary id → bus key (keeps the bus you are about to miss on screen)
  const updaters = [];      // per-second DOM updates of the current render
  let planSeq = 0, planCtl = null, lastPlanAt = 0, lastPlanFrom = null, replanTimer = 0;
  let searchCtl = null, searchTimer = 0, keepOpenUntil = 0;
  let drawSeq = 0, lastFitKey = '', lastDrawSig = '', shapesP = null;
  const snapCache = new Map();
  const timers = [];
  const unsubs = [];

  const M = (fn, ...a) => { try { return ctx.map?.[fn]?.(...a); } catch (e) { console.warn('[planner] map.' + fn, e); } };
  const stopByCode = (c) => ctx.data?.stopByCode?.get(c);
  const here = () => ctx.location?.current || null;
  const near = () => (S.from ? { lat: S.from.lat, lng: S.from.lng } : here() ? { lat: here().lat, lng: here().lng } : M('getCenter') || null);

  // ---- initial state from params
  const toPt = parsePoint(params.to);
  if (toPt) {
    const s = nearestStops(ctx.data?.stops || [], toPt, { limit: 1, maxMeters: 40 })[0]?.stop;
    S.to = { ...toPt, name: params.name || s?.displayName || 'Επιλεγμένο σημείο', ...(s && !params.name ? { stopCode: s.code } : {}) };
  }
  const fromPt = parsePoint(params.from);
  if (fromPt) S.from = { ...fromPt, name: 'Σημείο εκκίνησης', source: 'url' };
  else if (here()) S.from = { lat: here().lat, lng: here().lng, name: MY_LOCATION, source: 'gps' };

  // ---------------------------------------------------------------- header

  const fromInput = h('input', { class: 'pl-input', type: 'search', id: 'pl-from', enterkeyhint: 'search', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Αφετηρία' });
  const toInput = h('input', { class: 'pl-input', type: 'search', id: 'pl-to', enterkeyhint: 'search', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: 'Πού πάμε;', 'aria-label': 'Προορισμός' });
  const swapBtn = h('button', { type: 'button', class: 'pl-icon-btn pl-swap', 'aria-label': 'Αντιστροφή αφετηρίας και προορισμού', onclick: () => swap() }, icon('swap'));
  const backBtn = h('button', { type: 'button', class: 'pl-icon-btn', 'aria-label': 'Πίσω', onclick: () => ctx.navigate('#/') }, icon('back'));
  const head = h('header', { class: 'pl-head' },
    h('div', { class: 'pl-head-top' }, backBtn, h('h2', { class: 'pl-title' }, 'Διαδρομή')),
    h('div', { class: 'pl-route' },
      h('div', { class: 'pl-rail', 'aria-hidden': 'true' }, h('span', { class: 'pl-rail-dot' }), h('span', { class: 'pl-rail-line' }), h('span', { class: 'pl-rail-pin' }, svgPin())),
      h('div', { class: 'pl-fields' },
        h('label', { class: 'pl-field' }, fromInput),
        h('label', { class: 'pl-field' }, toInput)),
      swapBtn));
  const body = h('div', { class: 'pl-body' });
  const live = h('p', { class: 'pl-sr', role: 'status', 'aria-live': 'polite' });
  const root = h('div', { class: 'pl' }, head, body, live);
  container.replaceChildren(root);

  const locStatus = () => ctx.location?.status;
  function fromPlaceholder() {
    const st = locStatus();
    if (st === 'locating') return 'Εντοπισμός τοποθεσίας…';
    if (st === 'denied' || st === 'unavailable' || st === 'timeout' || st === 'insecure') return 'Διάλεξε αφετηρία';
    return 'Αφετηρία';
  }
  function paintFields() {
    if (S.editing !== 'from') fromInput.value = S.from ? S.from.name : '';
    if (S.editing !== 'to') toInput.value = S.to ? S.to.name : '';
    fromInput.placeholder = fromPlaceholder();
    fromInput.classList.toggle('pl-input-gps', S.from?.source === 'gps' && S.editing !== 'from');
  }

  // ---- field events
  const inputFor = (f) => (f === 'from' ? fromInput : toInput);
  for (const field of ['from', 'to']) {
    const input = inputFor(field);
    input.addEventListener('focus', () => { openSuggest(field); input.select?.(); });
    input.addEventListener('input', () => onType(field));
    input.addEventListener('blur', () => {
      setTimeout(() => { if (!dead && S.editing === field && document.activeElement !== input && Date.now() > keepOpenUntil) closeSuggest(); }, 180);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { closeSuggest(); input.blur(); }
      else if (e.key === 'Enter') { e.preventDefault(); body.querySelector('.pl-sug')?.click(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); body.querySelector('.pl-sug')?.focus(); }
    });
  }

  // ---------------------------------------------------------------- suggestions

  function openSuggest(field) {
    if (S.editing === field) return;
    S.editing = field;
    S.sug = { query: '', places: [], loading: false, offline: false, error: false };
    ctx.sheet?.snap?.('full');
    render();
  }
  function closeSuggest() {
    if (!S.editing) return;
    clearTimeout(searchTimer);
    searchCtl?.abort();
    S.editing = null;
    ctx.sheet?.snap?.('half');
    render();
  }
  function onType(field) {
    const q = inputFor(field).value.trim();
    S.sug.query = q;
    clearTimeout(searchTimer);
    searchCtl?.abort();
    S.sug.places = q.length >= 2 && ctx.data ? stopPlaces(ctx.data, q, { near: near() || undefined }) : [];
    S.sug.loading = q.length >= 3;
    S.sug.offline = S.sug.error = false;
    renderSuggest();
    if (q.length < 3) return;
    searchTimer = setTimeout(async () => {
      const ctl = (searchCtl = new AbortController());
      try {
        const places = await searchPlaces(q, { near: near() || undefined, signal: ctl.signal, data: ctx.data });
        if (dead || ctl.signal.aborted) return;
        S.sug.places = places; S.sug.offline = !!places.offline; S.sug.loading = false;
      } catch (e) {
        if (e?.name === 'AbortError' || dead) return;
        S.sug.loading = false; S.sug.error = true;
      }
      renderSuggest();
    }, DEBOUNCE_MS);
  }

  function sugRow(place, { iconName, sub, onPick }) {
    const n = near();
    const dist = n && Number.isFinite(place.lat) ? fmtDist(haversine(n, place)) : '';
    return h('button', { type: 'button', class: 'pl-sug', onclick: onPick },
      h('span', { class: `pl-sug-ic${place.kind === 'stop' ? ' is-stop' : ''}` }, icon(iconName)),
      h('span', { class: 'pl-sug-t' }, h('span', { class: 'pl-sug-name' }, place.name), (sub ?? place.subtitle) ? h('span', { class: 'pl-sug-sub' }, sub ?? place.subtitle) : null),
      dist && !place.special ? h('span', { class: 'pl-sug-d' }, dist) : null);
  }
  const placeIcon = (p) => (p.kind === 'stop' ? 'bus' : 'pin');

  function renderSuggest() {
    if (!S.editing) return;
    const field = S.editing;
    const q = S.sug.query;
    const rows = [];
    if (!q) {
      if (field === 'from') {
        const st = locStatus();
        const hasFix = !!here();
        rows.push(sugRow({ name: MY_LOCATION, kind: 'special', special: true }, {
          iconName: 'locate', sub: hasFix ? 'Από το GPS' : st === 'denied' ? 'Δεν δόθηκε άδεια τοποθεσίας' : 'Εντοπισμός με GPS',
          onPick: () => useMyLocation(),
        }));
      }
      if (M('getCenter')) {
        rows.push(sugRow({ name: CENTER_NAME, kind: 'special', special: true }, {
          iconName: 'pin', sub: 'Μετακίνησε τον χάρτη και διάλεξε το σημείο', onPick: () => pick(field, { ...M('getCenter'), name: CENTER_NAME, kind: 'place' }, 'map'),
        }));
      }
      const recents = getRecents('place').filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lng));
      if (recents.length) rows.push(h('div', { class: 'pl-sug-head' }, 'Πρόσφατα'));
      for (const p of recents) rows.push(sugRow(p, { iconName: 'history', onPick: () => pick(field, p, 'place') }));
      if (!rows.length || (!recents.length && field === 'to')) rows.push(h('p', { class: 'pl-hint' }, 'Γράψε όνομα στάσης, οδού ή τόπου (π.χ. Πανεπιστήμιο, Πλατεία Γεωργίου).'));
    } else {
      for (const p of S.sug.places) rows.push(sugRow(p, { iconName: placeIcon(p), onPick: () => pick(field, p, 'place') }));
      if (S.sug.loading) rows.push(h('p', { class: 'pl-hint pl-hint-busy' }, 'Αναζήτηση…'));
      else if (!S.sug.places.length) rows.push(h('p', { class: 'pl-hint' }, q.length < 3 ? 'Γράψε τουλάχιστον 3 γράμματα.' : 'Δεν βρέθηκε κάτι. Δοκίμασε άλλη γραφή ή ψάξε μια στάση.'));
      if (S.sug.offline || S.sug.error) rows.push(h('p', { class: 'pl-hint pl-hint-warn' }, 'Η αναζήτηση διευθύνσεων δεν είναι διαθέσιμη τώρα — εμφανίζονται μόνο στάσεις.'));
    }
    const list = h('div', { class: 'pl-sug-list', role: 'listbox', 'aria-label': 'Προτάσεις' }, rows);
    list.addEventListener('pointerdown', () => { keepOpenUntil = Date.now() + 700; });
    list.addEventListener('keydown', (e) => {
      const items = [...list.querySelectorAll('.pl-sug')];
      const i = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); items[Math.min(items.length - 1, i + 1)]?.focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (i <= 0) inputFor(field).focus(); else items[i - 1].focus(); }
      else if (e.key === 'Escape') { closeSuggest(); }
    });
    body.replaceChildren(list);
  }

  function pick(field, place, source) {
    keepOpenUntil = 0;
    const p = { lat: place.lat, lng: place.lng, name: place.name, subtitle: place.subtitle, kind: place.kind, ...(place.stopCode ? { stopCode: place.stopCode } : {}) };
    if (field === 'to') {
      S.to = p;
      if (source === 'place') addRecent('place', { ...p, subtitle: p.subtitle || '' });
    } else {
      S.from = { ...p, source: source === 'map' ? 'map' : 'place' };
    }
    clearTimeout(searchTimer);
    searchCtl?.abort();
    S.editing = null;
    inputFor(field).blur();
    resetPlan();
    writeUrl();
    ctx.sheet?.snap?.('half');
    runPlan();
  }

  function useMyLocation() {
    const f = here();
    if (f) {
      S.from = { lat: f.lat, lng: f.lng, name: MY_LOCATION, source: 'gps' };
      S.editing = null; fromInput.blur();
      resetPlan(); writeUrl(); ctx.sheet?.snap?.('half'); runPlan();
      return;
    }
    try { ctx.location?.start?.(); } catch { /* ignore */ }
    toast('Εντοπισμός τοποθεσίας…');
    S.editing = null; fromInput.blur(); render();
  }

  function swap() {
    if (!S.to) return;
    const a = S.from, b = S.to;
    S.from = { lat: b.lat, lng: b.lng, name: b.name, source: 'place' };
    S.to = a ? { lat: a.lat, lng: a.lng, name: a.source === 'gps' ? MY_LOCATION : a.name } : null;
    S.editing = null;
    resetPlan(); writeUrl(); runPlan();
  }

  function resetPlan() {
    planCtl?.abort(); planSeq++;
    S.its = []; S.result = null; S.selectedId = null; S.userPicked = false; S.error = null; S.loading = false; S.pending = 0;
    prefer.clear(); lastFitKey = '';
    clearMap();
  }

  // The URL stays shareable, but never carries the user's own GPS position.
  function writeUrl() {
    try {
      const q = [];
      if (S.to) { q.push(`to=${r5(S.to.lat)},${r5(S.to.lng)}`, `name=${encodeURIComponent(S.to.name)}`); }
      if (S.from && S.from.source !== 'gps') q.push(`from=${r5(S.from.lat)},${r5(S.from.lng)}`);
      history.replaceState(history.state, '', `#/plan${q.length ? `?${q.join('&')}` : ''}`);
    } catch { /* ignore */ }
  }

  // ---------------------------------------------------------------- planning

  async function runPlan({ silent = false } = {}) {
    if (dead) return;
    if (!S.from || !S.to) { render(); drawMap(); return; }
    planCtl?.abort();
    const ctl = (planCtl = new AbortController());
    const seq = ++planSeq;
    for (const it of S.its) if (it.bus) prefer.set(it.id, it.bus.key);
    if (!silent && !S.its.length) { S.loading = true; S.error = null; render(); }
    const from = { lat: S.from.lat, lng: S.from.lng }, to = { lat: S.to.lat, lng: S.to.lng };
    lastPlanFrom = from;
    try {
      const res = await planTripsDetailed(ctx, from, to, {
        signal: ctl.signal, walkCache, prefer, deps: params.deps,
        onUpdate: (r) => { if (seq === planSeq && !dead) applyResult(r); },
      });
      if (seq !== planSeq || dead) return;
      S.loading = false; S.error = null; lastPlanAt = Date.now();
      applyResult(res);
      if (!silent && res.itineraries.length) live.textContent = `Βρέθηκαν ${res.itineraries.length} επιλογές διαδρομής`;
    } catch (e) {
      if (e?.name === 'AbortError' || seq !== planSeq || dead) return;
      console.warn('[planner]', e);
      S.loading = false;
      if (!S.its.length) S.error = e;
      render();
    }
  }

  function applyResult(res) {
    S.result = res; S.its = res.itineraries; S.pending = res.pending || 0; S.loading = false;
    if (!S.its.length) S.selectedId = null;
    else if (!S.its.some((i) => i.id === S.selectedId) || !S.userPicked) S.selectedId = S.its[0].id;
    if (!S.editing) render();
    drawMap();
    syncReminders();
  }

  const selected = () => S.its.find((i) => i.id === S.selectedId) || null;
  function select(id) {
    if (S.selectedId === id) return;
    S.selectedId = id; S.userPicked = true;
    render(); drawMap({ fit: true });
  }

  // ---------------------------------------------------------------- results rendering

  function render() {
    if (dead) return;
    updaters.length = 0;
    paintFields();
    if (S.editing) return renderSuggest();
    if (!S.to) return renderNoDest();
    if (!S.from) return renderNoFrom();
    if (S.error && !S.its.length) return renderError();
    if (S.loading && !S.its.length) return renderLoading();
    if (!S.its.length) return renderEmpty(S.result?.reason);
    renderResults();
  }

  function stateBox(iconName, title, sub, ...extra) {
    return h('div', { class: 'pl-state' }, icon(iconName), h('p', { class: 'pl-state-title' }, title), sub ? h('p', { class: 'pl-state-sub' }, sub) : null, ...extra);
  }
  const btn = (label, onclick, cls = '', ic = null) => h('button', { type: 'button', class: `pl-btn ${cls}`.trim(), onclick }, ic ? icon(ic) : null, label);

  function renderNoDest() {
    const recents = getRecents('place').filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lng)).slice(0, 5);
    body.replaceChildren(
      stateBox('route', 'Πού θέλεις να πας;', 'Διάλεξε προορισμό και θα σου πω πότε να ξεκινήσεις ώστε να μην περιμένεις στη στάση.',
        btn('Αναζήτηση προορισμού', () => toInput.focus(), 'is-primary', 'search')),
      recents.length ? h('div', { class: 'pl-sug-list' }, h('div', { class: 'pl-sug-head' }, 'Πρόσφατα'),
        recents.map((p) => sugRow(p, { iconName: 'history', onPick: () => pick('to', p, 'place') }))) : null);
  }

  function renderNoFrom() {
    const st = locStatus();
    const why = st === 'denied' ? 'Δεν έχεις δώσει άδεια τοποθεσίας στον περιηγητή.'
      : st === 'insecure' ? 'Η τοποθεσία χρειάζεται ασφαλή σύνδεση (https).'
        : st === 'unavailable' || st === 'timeout' ? 'Η τοποθεσία σου δεν είναι διαθέσιμη αυτή τη στιγμή.'
          : st === 'locating' ? 'Εντοπισμός τοποθεσίας…' : 'Χρειάζομαι την αφετηρία σου.';
    body.replaceChildren(stateBox('locate', 'Από πού ξεκινάς;', why,
      h('div', { class: 'pl-btnrow' },
        st === 'denied' || st === 'insecure' ? null : btn('Εντόπισέ με', useMyLocation, 'is-primary', 'locate'),
        M('getCenter') ? btn('Κέντρο του χάρτη', () => pick('from', { ...M('getCenter'), name: CENTER_NAME, kind: 'place' }, 'map'), '', 'pin') : null,
        btn('Γράψε αφετηρία', () => fromInput.focus(), '', 'search'))));
  }

  function renderLoading() {
    const sk = () => h('div', { class: 'pl-card pl-skel', 'aria-hidden': 'true' }, h('span', { class: 'pl-skel-b' }), h('span', { class: 'pl-skel-l' }), h('span', { class: 'pl-skel-s' }));
    body.replaceChildren(h('p', { class: 'pl-hint pl-hint-busy', role: 'status' }, 'Ψάχνω την καλύτερη διαδρομή…'), sk(), sk());
  }

  function renderError() {
    body.replaceChildren(stateBox('alert', 'Δεν ήταν δυνατός ο υπολογισμός', 'Έλεγξε τη σύνδεσή σου και δοκίμασε ξανά.', btn('Δοκίμασε ξανά', () => runPlan(), 'is-primary', 'refresh')));
  }

  function nearestToDest() {
    if (!S.to || !ctx.data?.stops) return null;
    const list = nearestStops(ctx.data.stops, S.to, { limit: 4, maxMeters: 3000 });
    if (!list.length) return null;
    return h('div', { class: 'pl-sug-list' }, h('div', { class: 'pl-sug-head' }, 'Κοντινότερες στάσεις στον προορισμό'),
      list.map(({ stop, meters }) => h('a', { class: 'pl-sug', href: `#/stop/${encodeURIComponent(stop.code)}` },
        h('span', { class: 'pl-sug-ic is-stop' }, icon('bus')),
        h('span', { class: 'pl-sug-t' }, h('span', { class: 'pl-sug-name' }, stop.displayName), h('span', { class: 'pl-sug-sub' }, `Στάση ${stop.code}`)),
        h('span', { class: 'pl-sug-d' }, fmtDist(meters)))));
  }

  function renderEmpty(reason) {
    const walkHint = S.from && S.to ? `Απόσταση σε ευθεία: ${fmtDist(haversine(S.from, S.to))}.` : '';
    const edit = (f) => btn(f === 'from' ? 'Άλλη αφετηρία' : 'Άλλος προορισμός', () => inputFor(f).focus(), '', 'search');
    const m = {
      'outside-to': () => stateBox('info', 'Ο προορισμός είναι εκτός Πάτρας', 'Τα αστικά λεωφορεία Πάτρας δεν εξυπηρετούν αυτή την περιοχή.', edit('to')),
      'outside-from': () => stateBox('info', 'Η αφετηρία είναι εκτός Πάτρας', 'Διάλεξε ένα σημείο μέσα στην περιοχή των αστικών λεωφορείων.', edit('from')),
      'no-data': () => stateBox('alert', 'Τα δεδομένα διαδρομών δεν είναι διαθέσιμα', 'Δοκίμασε ξανά σε λίγο ή δες τη στάση που σε ενδιαφέρει.', btn('Δοκίμασε ξανά', () => runPlan(), '', 'refresh')),
      'no-board-stops': () => stateBox('info', 'Δεν υπάρχει στάση κοντά στην αφετηρία', `Η πλησιέστερη στάση είναι πάνω από 1,5 χλμ μακριά. ${walkHint}`, edit('from')),
      'no-alight-stops': () => stateBox('info', 'Δεν υπάρχει στάση κοντά στον προορισμό', `${walkHint} Δες τις πιο κοντινές στάσεις παρακάτω.`, edit('to')),
    };
    const box = (m[reason] || (() => stateBox('info', 'Δεν βρέθηκε διαδρομή με λεωφορείο', `Δεν υπάρχει γραμμή, ούτε με μία αλλαγή, που να σε πάει εκεί. ${walkHint}`.trim(), edit('to'))))();
    const links = h('p', { class: 'pl-hint' }, 'Δες τις ', h('a', { href: '#/lines' }, 'γραμμές'), ' ή δοκίμασε άλλον προορισμό.');
    body.replaceChildren(box, reason === 'outside-from' || reason === 'outside-to' ? null : nearestToDest(), links);
  }

  // ---- when / hero text

  function whenInfo(it, now) {
    const st = leaveState(it, now);
    switch (st.kind) {
      case 'walk': return { kind: 'walk', lead: 'Περπάτημα', big: dur(it.walkTo.seconds), short: dur(it.walkTo.seconds) };
      case 'none': return { kind: 'none', lead: '', big: 'Χωρίς δρομολόγιο τώρα', short: 'Χωρίς δρομολόγιο τώρα' };
      case 'later': { const t = etaText(st.leaveInSec); return { kind: 'later', lead: 'Φύγε σε', big: t, short: `Φύγε σε ${t}` }; }
      case 'now': return { kind: 'now', lead: '', big: 'Φύγε τώρα', short: 'Φύγε τώρα' };
      case 'run': {
        const big = st.remainingSec < 15 ? 'φεύγει τώρα!' : `φεύγει σε ${etaText(st.remainingSec)}`;
        return { kind: 'run', lead: 'Τρέξε!', big, short: `Τρέξε! ${big[0].toUpperCase()}${big.slice(1)}` };
      }
      default: return { kind: 'none', lead: '', big: 'Ψάχνω το επόμενο…', short: 'Ψάχνω το επόμενο…' };
    }
  }

  const flag = (liveBus) => (liveBus
    ? h('span', { class: 'pl-flag is-live' }, h('span', { class: 'pl-dot', 'aria-hidden': 'true' }), 'LIVE')
    : h('span', { class: 'pl-flag' }, icon('clock'), 'ΠΡΟΓΡ.'));

  function renderResults() {
    const cards = S.its.map((it) => card(it, it.id === S.selectedId));
    const notes = [];
    const r = S.result;
    if (r && r.liveTotal && r.liveFailed >= r.liveTotal && S.its.some((i) => i.kind !== 'walk')) {
      notes.push(h('div', { class: 'pl-banner' }, h('span', {}, 'Δεν φορτώθηκαν δεδομένα live για τις στάσεις — οι ώρες αναχώρησης λείπουν.'), btn('Δοκίμασε ξανά', () => runPlan({ silent: true }), 'is-small')));
    } else if (S.its.length && S.its.every((i) => i.kind !== 'walk' && i.status === 'none')) {
      notes.push(h('div', { class: 'pl-banner' }, h('span', {}, 'Δεν υπάρχουν αναχωρήσεις αυτή τη στιγμή για αυτές τις γραμμές (ίσως έχουν τελειώσει τα δρομολόγια).')));
    }
    if (S.pending > 0) notes.push(h('p', { class: 'pl-hint pl-hint-busy' }, 'Υπολογίζω ακριβώς τον χρόνο περπατήματος…'));
    body.replaceChildren(...notes, h('div', { class: 'pl-cards' }, cards),
      h('p', { class: 'pl-foot' }, `LIVE = θέση οχήματος σε πραγματικό χρόνο · ΠΡΟΓΡ. = ώρα από το πρόγραμμα. Ο χρόνος διαδρομής είναι εκτίμηση, εκτός αν αναγράφεται «από το όχημα».${S.its.some((i) => i.kind === 'transfer') ? ' Στις διαδρομές με αλλαγή, η ώρα του δεύτερου λεωφορείου είναι εκτίμηση όταν δεν υπάρχει καταχωρημένη αναχώρηση.' : ''}${getSettings().bufferMin ? ` Η ώρα εκκίνησης έχει περιθώριο ${getSettings().bufferMin}′ (ρυθμίσεις).` : ''}`));
  }

  function card(it, isSel) {
    const now = Date.now();
    const isWalk = it.kind === 'walk';
    const w = whenInfo(it, now);
    const isX = it.kind === 'transfer';
    const dest = isWalk ? 'Περπάτημα' : isX ? `Αλλαγή: ${it.transfer.stop.displayName}` : `προς ${towards(it.bus?.routeName || it.route.name)}`;
    const when = h('span', { class: `pl-when is-${w.kind}` }, w.short);
    const guess = isX && it.transfer.estimated;
    const arrive = h('span', { class: 'pl-card-end' },
      it.arriveAt != null ? [h('strong', {}, `${guess ? '~' : ''}${fmtClock(it.arriveAt)}`), h('small', {}, guess ? 'εκτίμηση' : 'άφιξη')] : [h('strong', {}, `~${dur(it.estTotalSec)}`), h('small', {}, 'διαδρομή')]);
    const walkTotal = (it.walkTo?.seconds || 0) + (it.walkFrom?.seconds || 0) + (it.transfer?.walk?.seconds || 0);
    const meta = h('span', { class: 'pl-card-meta' },
      isWalk ? `${fmtDist(it.walkTo.meters)}` : [icon('walk'), `${dur(walkTotal)}`, ` · ${it.nStops} στάσεις${isX ? ' · 1 αλλαγή' : ''}`]);
    const lead = isWalk ? h('span', { class: 'pl-walk-ic' }, icon('walk'))
      : isX ? h('span', { class: 'pl-xlead', role: 'img', 'aria-label': `Γραμμή ${it.legs[0].route.lineCode}, μετά γραμμή ${it.legs[1].route.lineCode}` },
        lineBadge(it.legs[0].line || { code: it.legs[0].route.lineCode }), h('span', { class: 'pl-xarrow', 'aria-hidden': 'true' }, '→'), lineBadge(it.legs[1].line || { code: it.legs[1].route.lineCode }))
        : lineBadge(it.line || { code: it.route.lineCode });
    const headBtn = h('button', { type: 'button', class: 'pl-card-head', 'aria-expanded': String(isSel), onclick: () => select(it.id) },
      h('span', { class: 'pl-card-lead' }, lead),
      h('span', { class: 'pl-card-main' }, h('span', { class: 'pl-card-dest' }, dest),
        h('span', { class: 'pl-card-when' }, when, !isWalk && it.bus ? flag(it.bus.live) : null, guess ? h('span', { class: 'pl-flag is-est' }, 'αλλαγή: εκτίμηση') : null), meta),
      arrive);
    const el = h('article', { class: `pl-card${isSel ? ' is-selected' : ''}${it.status === 'none' ? ' is-none' : ''}`, 'data-id': it.id }, headBtn);
    updaters.push((t) => {
      const wi = whenInfo(it, t);
      when.className = `pl-when is-${wi.kind}`;
      if (when.textContent !== wi.short) when.textContent = wi.short;
    });
    if (isSel) el.append(detail(it));
    return el;
  }

  // ---- selected card: hero + notes + timeline + actions

  function detail(it) {
    const now = Date.now();
    const isWalk = it.kind === 'walk';
    const lead = h('div', { class: 'pl-hero-lead' });
    const big = h('div', { class: 'pl-hero-big' });
    const sub = h('div', { class: 'pl-hero-sub' });
    const hero = h('div', { class: 'pl-hero', role: 'group', 'aria-label': 'Πότε να φύγεις' }, lead, big, sub);
    if (isWalk) sub.append(`${fmtDist(it.walkTo.meters)} · άφιξη ${fmtClock(it.arriveAt)}`);
    else if (it.bus) sub.append(`Ξεκίνα στις ${fmtClock(it.leaveAt)} · περπάτημα ${dur(it.walkTo.seconds)} ως τη στάση «${it.board.displayName}»`);
    else if (it.liveError) sub.append('Δεν φορτώθηκαν δεδομένα live για τη στάση.');
    else if (it.missed) sub.append(`Το επόμενο λεωφορείο φεύγει σε ${etaText(it.missed.remainingSec)}, αλλά χρειάζεσαι ${dur(it.walkTo.seconds)} για να φτάσεις στη στάση.`);
    else sub.append('Δεν υπάρχει καταχωρημένη αναχώρηση για αυτή τη γραμμή στη στάση αυτή τη στιγμή.');
    const paintHero = (t) => {
      const wi = whenInfo(it, t);
      hero.className = `pl-hero is-${wi.kind}`;
      lead.textContent = wi.lead; lead.hidden = !wi.lead;
      big.textContent = wi.big;
    };
    paintHero(now);
    updaters.push(paintHero);

    const notes = [];
    if (!isWalk && it.bus && it.missed) {
      notes.push(h('p', { class: 'pl-note is-warn' }, `Δεν προλαβαίνεις το ${fmtClock(it.missed.departAt)} (σε ${etaText(it.missed.remainingSec)}) — χρειάζεσαι ${dur(it.walkTo.seconds)} για τη στάση. Δείχνω το επόμενο.`));
    }
    if (!isWalk && it.bus && it.hurry) {
      notes.push(h('p', { class: 'pl-note' }, `Αν τρέξεις, προλαβαίνεις και το προηγούμενο: φεύγει στις ${fmtClock(it.hurry.bus.departAt)} (σε ${etaText(it.hurry.bus.remainingSec)}).`));
    }
    if (!isWalk && it.bus && it.next) {
      notes.push(h('p', { class: 'pl-note' }, `Επόμενο: φεύγει στις ${fmtClock(it.next.bus.departAt)} (σε ${etaText(it.next.bus.remainingSec)}) — άφιξη ${fmtClock(it.next.arriveAt)}.`));
    }
    if (it.kind === 'transfer' && it.bus) {
      const tr = it.transfer, B = it.legs[1];
      if (tr.missed) notes.push(h('p', { class: 'pl-note is-warn' }, `Η γραμμή ${B.route.lineCode} των ${fmtClock(tr.missed.departAt)} θα έχει φύγει όταν φτάσεις στη στάση αλλαγής — περιμένεις το επόμενο.`));
      if (it.xLiveError) notes.push(h('p', { class: 'pl-note' }, 'Δεν φορτώθηκαν δεδομένα live για τη στάση αλλαγής — η αναμονή είναι εκτίμηση.'));
      else if (tr.estimated) notes.push(h('p', { class: 'pl-note' }, `Δεν υπάρχει ακόμη καταχωρημένη αναχώρηση της γραμμής ${B.route.lineCode} για την ώρα που θα φτάσεις — η αναμονή (~${dur(tr.waitSec)}) είναι εκτίμηση.`));
    }
    if (!isWalk && !it.bus && it.estTotalSec) {
      notes.push(h('p', { class: 'pl-note' }, `Όταν υπάρξει δρομολόγιο: περίπου ${dur(it.estTotalSec)} συνολικά (περπάτημα ${dur(it.walkTo.seconds + it.walkFrom.seconds + (it.transfer?.walk?.seconds || 0))} + λεωφορείο ${dur(it.rideEstSec)}).`));
    }

    return h('div', { class: 'pl-detail' }, hero, ...notes, timeline(it, now), actions(it));
  }

  function step(kind, time, ic, title, subText, extra, line) {
    const li = h('li', { class: `pl-step is-${kind}` },
      h('span', { class: 'pl-step-time' }, time || ''),
      h('span', { class: 'pl-step-ic' }, ic),
      h('div', { class: 'pl-step-body' }, h('div', { class: 'pl-step-title' }, title), subText ? h('div', { class: 'pl-step-sub' }, subText) : null, extra || null));
    if (line?.color) li.style.setProperty('--pl-line', line.color);
    if (line?.textColor) li.style.setProperty('--pl-line-text', line.textColor);
    return li;
  }
  const estTag = (w) => (w?.source === 'estimate' ? ' · εκτίμηση' : '');

  function timeline(it, now) {
    const dest = S.to?.name || 'προορισμό';
    if (it.kind === 'walk') {
      return h('ol', { class: 'pl-tl' },
        step('walk', fmtClock(now), icon('walk'), `Περπάτα ${dur(it.walkTo.seconds)}`, `${fmtDist(it.walkTo.meters)} ως «${dest}»${estTag(it.walkTo)}`),
        step('arrive', fmtClock(it.arriveAt), icon('pin'), `Άφιξη στο «${dest}»`));
    }
    if (it.kind === 'transfer') return timelineTransfer(it, now, dest);
    const items = [];
    const bus = it.bus;
    items.push(step('walk', bus ? fmtClock(it.leaveAt) : '', icon('walk'), `Περπάτα ${dur(it.walkTo.seconds)} ως τη στάση «${it.board.displayName}»`,
      `${fmtDist(it.walkTo.meters)}${estTag(it.walkTo)}`));
    if (bus) {
      const tile = arrivalTile({ lineCode: it.line?.code ?? it.route.lineCode, routeName: bus.routeName || it.route.name, live: bus.live, etaSec: (bus.departAt - bus.fetchedAt) / 1000, color: it.line?.color, textColor: it.line?.textColor },
        bus.fetchedAt, { compact: true, line: it.line || undefined, now });
      updaters.push((t) => tile.tick?.(t));
      items.push(step('bus', fmtClock(bus.departAt), icon('bus'), `Γραμμή ${it.line?.code ?? it.route.lineCode} προς ${towards(bus.routeName || it.route.name)}`,
        it.bufferSec ? `Περίμενε ~${dur(it.bufferSec)} στη στάση` : '', tile));
      const rideLabel = it.rideSource === 'live-match' ? 'από το ίδιο όχημα' : 'εκτίμηση';
      items.push(step('ride', fmtClock(bus.departAt + it.rideSec * 1000), icon('route'), `Μετακίνηση ${dur(it.rideSec)} · ${it.nStops} στάσεις`,
        `Κατέβα στη στάση «${it.alight.displayName}» · ${rideLabel}`));
    } else {
      items.push(step('bus', '', icon('bus'), `Γραμμή ${it.line?.code ?? it.route.lineCode} προς ${towards(it.route.name)}`, 'Χωρίς δρομολόγιο τώρα'));
      items.push(step('ride', '', icon('route'), `Μετακίνηση ~${dur(it.rideEstSec)} · ${it.nStops} στάσεις`, `Κατέβα στη στάση «${it.alight.displayName}» · εκτίμηση`));
    }
    if (it.walkFrom.meters >= 25) items.push(step('walk', bus ? fmtClock(bus.departAt + it.rideSec * 1000) : '', icon('walk'), `Περπάτα ${dur(it.walkFrom.seconds)} ως «${dest}»`, `${fmtDist(it.walkFrom.meters)}${estTag(it.walkFrom)}`));
    items.push(step('arrive', it.arriveAt != null ? fmtClock(it.arriveAt) : '', icon('pin'), 'Άφιξη', it.arriveAt != null ? `«${dest}»` : null));
    const ol = h('ol', { class: 'pl-tl' }, items);
    if (it.line?.color) ol.style.setProperty('--pl-line', it.line.color);
    if (it.line?.textColor) ol.style.setProperty('--pl-line-text', it.line.textColor);
    return ol;
  }

  // walk → bus A → ride → change (wait, walk) → bus B → ride → walk → arrive
  function timelineTransfer(it, now, dest) {
    const [A, B] = it.legs, tr = it.transfer, items = [];
    const code = (l) => l.line?.code ?? l.route.lineCode;
    const lineVars = (l) => ({ color: l.line?.color, textColor: l.line?.textColor });
    const tile = (l) => {
      const b = l.bus;
      const t = arrivalTile({ lineCode: code(l), routeName: b.routeName || l.route.name, live: b.live, etaSec: (b.departAt - b.fetchedAt) / 1000, color: l.line?.color, textColor: l.line?.textColor },
        b.fetchedAt, { compact: true, line: l.line || undefined, now });
      updaters.push((t2) => t.tick?.(t2));
      return t;
    };
    const rideNote = (l, name) => `Κατέβα στη στάση «${name}» · ${l.rideSource === 'live-match' ? 'από το ίδιο όχημα' : 'εκτίμηση'}`;
    items.push(step('walk', it.bus ? fmtClock(it.leaveAt) : '', icon('walk'), `Περπάτα ${dur(it.walkTo.seconds)} ως τη στάση «${it.board.displayName}»`, `${fmtDist(it.walkTo.meters)}${estTag(it.walkTo)}`));
    if (!it.bus) {
      items.push(step('bus', '', icon('bus'), `Γραμμή ${code(A)} προς ${towards(A.route.name)}`, 'Χωρίς δρομολόγιο τώρα', null, lineVars(A)));
      items.push(step('arrive', '', icon('pin'), 'Άφιξη', null));
      return h('ol', { class: 'pl-tl' }, items);
    }
    items.push(step('bus', fmtClock(A.bus.departAt), icon('bus'), `Γραμμή ${code(A)} προς ${towards(A.bus.routeName || A.route.name)}`,
      it.bufferSec ? `Περίμενε ~${dur(it.bufferSec)} στη στάση` : '', tile(A), lineVars(A)));
    items.push(step('ride', fmtClock(tr.arriveAt), icon('route'), `Μετακίνηση ${dur(A.rideSec)} · ${A.nStops} στάσεις`, rideNote(A, tr.stop.displayName), null, lineVars(A)));
    const wait = `Περίμενε ${dur(tr.waitSec)}${tr.estimated ? ' · εκτίμηση' : ''} για τη γραμμή ${code(B)}`;
    items.push(step('change', fmtClock(tr.arriveAt), icon('swap'),
      tr.walk ? `Αλλαγή: περπάτα ${dur(tr.walk.seconds)} ως τη στάση «${tr.to.displayName}»` : `Αλλαγή λεωφορείου στη στάση «${tr.stop.displayName}»`,
      tr.walk ? `${fmtDist(tr.walk.meters)} · ${wait}` : wait));
    items.push(step('bus', `${tr.estimated ? '~' : ''}${fmtClock(B.bus.departAt)}`, icon('bus'), `Γραμμή ${code(B)} προς ${towards(B.bus.routeName || B.route.name)}`,
      tr.estimated ? 'Εκτίμηση: δεν υπάρχει καταχωρημένη αναχώρηση' : '', tr.estimated ? null : tile(B), lineVars(B)));
    items.push(step('ride', fmtClock(B.bus.departAt + B.rideSec * 1000), icon('route'), `Μετακίνηση ${dur(B.rideSec)} · ${B.nStops} στάσεις`, rideNote(B, it.alight.displayName), null, lineVars(B)));
    if (it.walkFrom.meters >= 25) items.push(step('walk', fmtClock(B.bus.departAt + B.rideSec * 1000), icon('walk'), `Περπάτα ${dur(it.walkFrom.seconds)} ως «${dest}»`, `${fmtDist(it.walkFrom.meters)}${estTag(it.walkFrom)}`));
    items.push(step('arrive', `${tr.estimated ? '~' : ''}${fmtClock(it.arriveAt)}`, icon('pin'), 'Άφιξη', `«${dest}»`));
    return h('ol', { class: 'pl-tl' }, items);
  }

  // ---- reminder + actions

  const tagOf = (it) => `plan:${it.id}`;
  function actions(it) {
    if (it.kind === 'walk') return null;
    const tag = tagOf(it);
    const bell = h('button', { type: 'button', class: 'pl-btn is-primary', onclick: () => toggleReminder(it, bell) });
    const paintBell = () => {
      const on = hasReminder(tag);
      bell.replaceChildren(icon('bell'), on ? 'Ακύρωση υπενθύμισης' : 'Υπενθύμισέ μου');
      bell.classList.toggle('is-on', on);
      bell.disabled = !it.bus && !on;
    };
    paintBell();
    return h('div', { class: 'pl-actions' }, bell, btn('Στάση επιβίβασης', () => ctx.navigate(`#/stop/${encodeURIComponent(it.board.code)}`), '', 'bus'));
  }

  // reminderMin = minutes BEFORE the moment you must leave; if that is already past, remind at the leave time itself.
  const reminderAt = (it) => {
    const early = it.leaveAt - (getSettings().reminderMin || 0) * 60000;
    return early > Date.now() + 5000 ? early : it.leaveAt;
  };
  async function toggleReminder(it, bell) {
    const tag = tagOf(it);
    if (hasReminder(tag)) {
      cancelReminder(tag);
      toast('Η υπενθύμιση ακυρώθηκε');
      render();
      return;
    }
    if (!it.bus) { toast('Δεν υπάρχει δρομολόγιο για υπενθύμιση'); return; }
    const at = reminderAt(it);
    if (at <= Date.now() + 5000) { toast('Πρέπει να ξεκινήσεις ήδη τώρα — δεν χρειάζεται υπενθύμιση'); return; }
    bell.disabled = true;
    const granted = await ensurePermission().catch(() => false);
    scheduleReminder({ at, title: 'Ώρα να φύγεις', body: reminderBody(it), tag, url: location.hash.startsWith('#/plan') ? location.hash : undefined, trip: reminderTrip(it) });
    toast(`Θα σε ειδοποιήσω στις ${fmtClock(at)}, όσο η εφαρμογή είναι ανοιχτή${granted ? '' : ' (χωρίς ειδοποίηση συστήματος)'}`);
    if (!dead) render();
  }
  const reminderBody = (it) => `Φύγε ${getSettings().reminderMin ? `σε ${getSettings().reminderMin}′ ` : 'τώρα '}για τη γραμμή ${it.line?.code ?? it.route.lineCode} (${fmtClock(it.bus.departAt)}) από τη στάση «${it.board.displayName}»${it.kind === 'transfer' ? `, μετά αλλαγή στη γραμμή ${it.legs[1].line?.code ?? it.legs[1].route.lineCode}` : ''}.`;

  // Live ETAs drift: move an existing reminder when the leave time shifts by more than a minute.
  function syncReminders() {
    try {
      const list = listReminders();
      for (const it of S.its) {
        if (it.kind === 'walk' || !it.bus) continue;
        const r = list.find((x) => x.tag === tagOf(it));
        if (r && Math.abs(r.at - reminderAt(it)) > 60000 && reminderAt(it) > Date.now() + 5000) {
          scheduleReminder({ at: reminderAt(it), title: r.title, body: reminderBody(it), tag: r.tag, url: r.url, trip: reminderTrip(it) });
        }
      }
    } catch { /* ignore */ }
  }

  // ---------------------------------------------------------------- map

  function clearMap() {
    drawSeq++; lastDrawSig = '';
    for (const id of ['plan-walk-1', 'plan-walk-2', 'plan-walk-3', 'plan-ride', 'plan-ride-2']) M('clearOverlay', id);
    M('clearMarkers', 'plan'); M('clearVehicles', 'plan');
  }

  async function shapeFor(route) {
    shapesP ||= Promise.resolve().then(loadShapes).catch(() => ({}));
    const shapes = await shapesP;
    const shape = shapes?.[route.code];
    if (!shape || shape.length < 2) return { shape: null, snapped: null };
    let snapped = snapCache.get(route.code);
    if (!snapped) {
      snapped = snapStopsToShape(route.stops.map((c) => stopByCode(c) || { lat: shape[0][1], lng: shape[0][0] }), shape);
      snapCache.set(route.code, snapped);
    }
    return { shape, snapped };
  }

  // Ride overlay: straight through the stops at once, swapped for the sliced road shape when it has loaded.
  function drawRide(id, leg, seq) {
    const color = leg.line?.color || undefined;
    M('setOverlay', id, lineString(rideGeometry(leg.route, ctx.data.stopByCode, null, leg.bi, leg.ai)), { kind: 'ride', color });
    shapeFor(leg.route).then(({ shape, snapped }) => {
      if (dead || seq !== drawSeq || !shape) return;
      M('setOverlay', id, lineString(rideGeometry(leg.route, ctx.data.stopByCode, shape, leg.bi, leg.ai, snapped)), { kind: 'ride', color });
    });
  }

  function drawMap({ fit = false } = {}) {
    const it = selected();
    if (!it || !S.from || !S.to) { clearMap(); return; }
    const from = S.from, to = S.to;
    const wc = (w, a, b) => (w?.geometry?.length > 1 ? w.geometry : [[a.lng, a.lat], [b.lng, b.lat]]);
    const isX = it.kind === 'transfer';
    const pts = [from, to];
    if (it.kind !== 'walk') pts.push(it.board, it.alight);
    if (isX) pts.push(it.transfer.stop, it.transfer.to);
    const sig = [it.id, r5(from.lat), r5(from.lng), r5(to.lat), r5(to.lng), it.walkTo?.source, it.walkTo?.seconds | 0, it.walkFrom?.source, it.walkFrom?.seconds | 0].join('|');
    const same = sig === lastDrawSig;
    lastDrawSig = sig;
    const seq = same ? drawSeq : ++drawSeq;
    if (same && it.kind !== 'walk') { drawVehicle(it); return fitIfNeeded(it, from, to, pts, fit); }
    if (it.kind === 'walk') {
      M('setOverlay', 'plan-walk-1', lineString(wc(it.walkTo, from, to)), { kind: 'walk' });
      for (const id of ['plan-walk-2', 'plan-walk-3', 'plan-ride', 'plan-ride-2']) M('clearOverlay', id);
      M('clearVehicles', 'plan');
      M('setMarkers', 'plan', [{ lat: from.lat, lng: from.lng, kind: 'origin', label: from.name }, { lat: to.lat, lng: to.lng, kind: 'dest', label: to.name }]);
    } else {
      M('setOverlay', 'plan-walk-1', lineString(wc(it.walkTo, from, it.board)), { kind: 'walk' });
      M('setOverlay', 'plan-walk-2', lineString(wc(it.walkFrom, it.alight, to)), { kind: 'walk' });
      const marks = [{ lat: from.lat, lng: from.lng, kind: 'origin', label: from.name }, { lat: it.board.lat, lng: it.board.lng, kind: 'board', label: it.board.displayName }];
      if (isX) {
        const [A, B] = it.legs, tr = it.transfer;
        drawRide('plan-ride', A, seq);
        drawRide('plan-ride-2', B, seq);
        if (tr.walk) M('setOverlay', 'plan-walk-3', lineString(wc(tr.walk, tr.stop, tr.to)), { kind: 'walk' }); else M('clearOverlay', 'plan-walk-3');
        // transfer marker(s): one at a shared stop, alight + board when the change crosses the road
        if (tr.walk) marks.push({ lat: tr.stop.lat, lng: tr.stop.lng, kind: 'alight', label: `Αλλαγή · κατέβα: ${tr.stop.displayName}` }, { lat: tr.to.lat, lng: tr.to.lng, kind: 'board', label: `Αλλαγή · ανέβα: ${tr.to.displayName}` });
        else marks.push({ lat: tr.stop.lat, lng: tr.stop.lng, kind: 'board', label: `Αλλαγή: ${tr.stop.displayName}` });
      } else {
        drawRide('plan-ride', it, seq);
        M('clearOverlay', 'plan-ride-2'); M('clearOverlay', 'plan-walk-3');
      }
      marks.push({ lat: it.alight.lat, lng: it.alight.lng, kind: 'alight', label: it.alight.displayName }, { lat: to.lat, lng: to.lng, kind: 'dest', label: to.name });
      M('setMarkers', 'plan', marks);
      drawVehicle(it);
    }
    fitIfNeeded(it, from, to, pts, fit);
  }

  function drawVehicle(it) {
    const legs = it.kind === 'transfer' ? it.legs : [it];
    const vs = legs.filter((l) => l.bus?.live && Number.isFinite(l.bus.lat) && Number.isFinite(l.bus.lng)).map((l) => {
      const code = l.line?.code ?? l.route.lineCode;
      return { lat: l.bus.lat, lng: l.bus.lng, lineCode: code, color: l.line?.color, textColor: l.line?.textColor, label: code, vehicleCode: l.bus.vehicleCode || undefined };
    });
    if (vs.length) M('setVehicles', 'plan', vs); else M('clearVehicles', 'plan');
  }

  function fitIfNeeded(it, from, to, pts, fit) {
    const key = `${it.id}|${r5(to.lat)},${r5(to.lng)}|${from.source === 'gps' ? 'gps' : `${r5(from.lat)},${r5(from.lng)}`}`;
    if (fit || key !== lastFitKey) {
      lastFitKey = key;
      M('fitTo', pts.map((p) => ({ lat: p.lat, lng: p.lng })), { maxZoom: 17 });
    }
  }

  // ---------------------------------------------------------------- per-second tick, refresh, location

  function tick() {
    if (dead || document.visibilityState === 'hidden') return;
    const now = Date.now();
    let changed = false;
    for (const it of S.its) {
      if (it.kind === 'walk' || !it.bus) continue;
      if (leaveState(it, now).kind === 'missed') {
        const before = it.bus.key;
        retime(it, now);
        if ((it.bus?.key ?? null) !== before) changed = true;
      }
    }
    if (changed) {
      S.its = rankItineraries(S.its);
      if (!S.userPicked) S.selectedId = S.its[0]?.id ?? S.selectedId;
      if (!S.editing) render();
      drawMap();
      return;
    }
    for (const u of updaters) u(now);
  }

  function refresh() {
    if (dead || document.visibilityState === 'hidden' || !S.from || !S.to || S.editing) return;
    runPlan({ silent: true });
  }

  function onVisibility() {
    if (document.visibilityState !== 'visible' || dead) return;
    tick();
    if (Date.now() - lastPlanAt >= REFRESH_MS) refresh();
  }

  function onFix(fix) {
    if (dead) return;
    if (!fix) { paintFields(); return; }
    if (!S.from && !S.editing && !params.from) {
      S.from = { lat: fix.lat, lng: fix.lng, name: MY_LOCATION, source: 'gps' };
      writeUrl();
      if (S.to) runPlan();
      else render();
      return;
    }
    if (S.from?.source !== 'gps') return;
    S.from = { ...S.from, lat: fix.lat, lng: fix.lng };
    if (lastPlanFrom && haversine(lastPlanFrom, fix) > MOVE_M && S.to && !replanTimer) {
      replanTimer = setTimeout(() => { replanTimer = 0; if (!dead) runPlan({ silent: true }); }, REPLAN_GAP_MS);
    }
    paintFields();
  }

  if (ctx.location?.subscribe) unsubs.push(ctx.location.subscribe((fix) => onFix(fix)));
  timers.push(setInterval(tick, 1000), setInterval(refresh, REFRESH_MS));
  document.addEventListener('visibilitychange', onVisibility);

  // ---------------------------------------------------------------- go

  ctx.sheet?.snap?.('half');
  render();
  if (S.to && S.from) runPlan();
  else if (!S.to) setTimeout(() => { if (!dead && !S.to && !S.editing) toInput.focus({ preventScroll: true }); }, 50);

  return {
    destroy() {
      dead = true;
      planCtl?.abort(); searchCtl?.abort();
      clearTimeout(searchTimer); clearTimeout(replanTimer);
      timers.forEach(clearInterval);
      unsubs.forEach((u) => { try { u(); } catch { /* ignore */ } });
      document.removeEventListener('visibilitychange', onVisibility);
      drawSeq++;
      clearMap();
    },
  };
}
