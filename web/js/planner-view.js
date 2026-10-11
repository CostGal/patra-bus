// Trip planner view (owner: planner): destination search, itinerary cards, "Φύγε σε X′" hero, timeline, map overlays.
// Contract: mountPlanner(container, ctx, { to?, from?, name? }) → { destroy }. Styles: css/planner.css (prefix .pl-).
import { h, icon, lineBadge, fmtClock, toast } from './ui.js';
import { arrivalTile } from './arrivals-view.js';
import { fmtDist, haversine, nearestStops } from './geo.js';
import { searchPlaces, stopPlaces } from './geocode.js';
import { planTripsDetailed, reminderTrip, retime, leaveState, rankItineraries, rideGeometry, snapStopsToShape } from './planner.js';
import { loadShapes } from './data.js';
import { getRecents, addRecent, getSettings } from './store.js';
import { scheduleReminder, cancelReminder, hasReminder, listReminders, ensurePermission } from './notify.js';
import { titleCase } from './text.js';
import { t, tn, etaTxt } from './i18n.js';
import { activeTrip, startOnboard, stopOnboard } from './onboard.js';
import { cityHash, relHash, shareHash } from './route.js';

const REFRESH_MS = 20000; // live refresh (api.js keeps each stop at ≥ 15 s)
const MOVE_M = 75;        // re-plan when the user has moved this far
const REPLAN_GAP_MS = 5000;
const DEBOUNCE_MS = 300;
const MY_LOCATION = () => t('Η τοποθεσία μου');
const CENTER_NAME = () => t('Κέντρο του χάρτη');

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
  return m < 60 ? `${m}′` : `${Math.floor(m / 60)} ${t('ώ')} ${String(m % 60).padStart(2, '0')}′`;
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
    S.to = { ...toPt, name: params.name || s?.displayName || t('Επιλεγμένο σημείο'), ...(s && !params.name ? { stopCode: s.code } : {}) };
  }
  const fromPt = parsePoint(params.from);
  if (fromPt) S.from = { ...fromPt, name: t('Σημείο εκκίνησης'), source: 'url' };
  else if (here()) S.from = { lat: here().lat, lng: here().lng, name: MY_LOCATION(), source: 'gps' };

  // ---------------------------------------------------------------- header

  const fromInput = h('input', { class: 'pl-input', type: 'search', id: 'pl-from', enterkeyhint: 'search', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': t('Αφετηρία') });
  const toInput = h('input', { class: 'pl-input', type: 'search', id: 'pl-to', enterkeyhint: 'search', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: t('Πού πάμε;'), 'aria-label': t('Προορισμός') });
  const swapBtn = h('button', { type: 'button', class: 'btn round pl-swap press', 'aria-label': t('Αντιστροφή αφετηρίας και προορισμού'), onclick: () => swap() }, icon('swap'));
  const backBtn = h('button', { type: 'button', class: 'btn round press', 'aria-label': t('Πίσω'), onclick: () => ctx.navigate('#/') }, icon('back'));
  const head = h('header', { class: 'pl-head' },
    h('div', { class: 'pl-head-top' }, backBtn, h('h2', { class: 'pl-title' }, t('Διαδρομή'))),
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
    if (st === 'locating') return t('Εντοπισμός τοποθεσίας…');
    if (st === 'denied' || st === 'unavailable' || st === 'timeout' || st === 'insecure') return t('Διάλεξε αφετηρία');
    return t('Αφετηρία');
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
    const subText = sub ?? place.subtitle;
    // Honest, quiet flag: a street/nearby-POI match standing in for an exact house number (never silently wrong).
    const full = place.approx ? [subText, t('κατά προσέγγιση')].filter(Boolean).join(' · ') : subText;
    return h('button', { type: 'button', class: 'pl-sug press', onclick: onPick },
      h('span', { class: `pl-sug-ic${place.kind === 'stop' ? ' is-stop' : ''}` }, icon(iconName)),
      h('span', { class: 'pl-sug-t' }, h('span', { class: 'pl-sug-name' }, place.name), full ? h('span', { class: 'pl-sug-sub' }, full) : null),
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
        rows.push(sugRow({ name: MY_LOCATION(), kind: 'special', special: true }, {
          iconName: 'locate', sub: hasFix ? t('Από το GPS') : st === 'denied' ? t('Δεν δόθηκε άδεια τοποθεσίας') : t('Εντοπισμός με GPS'),
          onPick: () => useMyLocation(),
        }));
      }
      if (M('getCenter')) {
        rows.push(sugRow({ name: CENTER_NAME(), kind: 'special', special: true }, {
          iconName: 'pin', sub: t('Μετακίνησε τον χάρτη και διάλεξε το σημείο'), onPick: () => pick(field, { ...M('getCenter'), name: CENTER_NAME(), kind: 'place' }, 'map'),
        }));
      }
      const recents = getRecents('place').filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lng));
      if (recents.length) rows.push(h('div', { class: 'pl-sug-head' }, t('Πρόσφατα')));
      for (const p of recents) rows.push(sugRow(p, { iconName: 'history', onPick: () => pick(field, p, 'place') }));
      if (!rows.length || (!recents.length && field === 'to')) rows.push(h('p', { class: 'pl-hint' }, t('Γράψε όνομα στάσης, οδού ή τόπου (π.χ. Πανεπιστήμιο, Πλατεία Γεωργίου).')));
    } else {
      for (const p of S.sug.places) rows.push(sugRow(p, { iconName: placeIcon(p), onPick: () => pick(field, p, 'place') }));
      if (S.sug.loading) rows.push(h('p', { class: 'pl-hint pl-hint-busy' }, t('Αναζήτηση…')));
      else if (!S.sug.places.length) rows.push(h('p', { class: 'pl-hint' }, q.length < 3 ? t('Γράψε τουλάχιστον 3 γράμματα.') : t('Δεν βρέθηκε κάτι. Δοκίμασε άλλη γραφή ή ψάξε μια στάση.')));
      if (S.sug.offline || S.sug.error) rows.push(h('p', { class: 'pl-hint pl-hint-warn' }, t('Η αναζήτηση διευθύνσεων δεν είναι διαθέσιμη τώρα — εμφανίζονται μόνο στάσεις.')));
    }
    const list = h('div', { class: 'pl-sug-list', role: 'listbox', 'aria-label': t('Προτάσεις') }, rows);
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
    const p = { lat: place.lat, lng: place.lng, name: place.name, subtitle: place.subtitle, kind: place.kind, ...(place.stopCode ? { stopCode: place.stopCode } : {}), ...(place.approx ? { approx: true } : {}) };
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
      S.from = { lat: f.lat, lng: f.lng, name: MY_LOCATION(), source: 'gps' };
      S.editing = null; fromInput.blur();
      resetPlan(); writeUrl(); ctx.sheet?.snap?.('half'); runPlan();
      return;
    }
    try { ctx.location?.start?.(); } catch { /* ignore */ }
    toast(t('Εντοπισμός τοποθεσίας…'));
    S.editing = null; fromInput.blur(); render();
  }

  function swap() {
    if (!S.to) return;
    const a = S.from, b = S.to;
    S.from = { lat: b.lat, lng: b.lng, name: b.name, source: 'place', ...(b.approx ? { approx: true } : {}) };
    S.to = a ? { lat: a.lat, lng: a.lng, name: a.source === 'gps' ? MY_LOCATION() : a.name, ...(a.approx ? { approx: true } : {}) } : null;
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
      history.replaceState(history.state, '', cityHash(`#/plan${q.length ? `?${q.join('&')}` : ''}`));
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
      if (!silent && res.itineraries.length) live.textContent = tn(res.itineraries.length, 'Βρέθηκε {n} επιλογή διαδρομής', 'Βρέθηκαν {n} επιλογές διαδρομής');
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
  const btn = (label, onclick, cls = '', ic = null) => h('button', { type: 'button', class: `btn press ${cls}`.trim(), onclick }, ic ? icon(ic) : null, label);
  // secondary text / actions live behind "⋯"
  const moreBox = (...kids) => h('details', { class: 'pl-more' }, h('summary', { 'aria-label': t('Περισσότερα'), title: t('Περισσότερα') }, '⋯'), h('div', { class: 'pl-more-body' }, ...kids));

  function renderNoDest() {
    const recents = getRecents('place').filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lng)).slice(0, 5);
    body.replaceChildren(
      stateBox('route', t('Πού θέλεις να πας;'), t('Διάλεξε προορισμό και θα σου πω πότε να ξεκινήσεις ώστε να μην περιμένεις στη στάση.'),
        btn(t('Αναζήτηση προορισμού'), () => toInput.focus(), 'primary', 'search')),
      recents.length ? h('div', { class: 'pl-sug-list' }, h('div', { class: 'pl-sug-head' }, t('Πρόσφατα')),
        recents.map((p) => sugRow(p, { iconName: 'history', onPick: () => pick('to', p, 'place') }))) : null);
  }

  function renderNoFrom() {
    const st = locStatus();
    const why = st === 'denied' ? t('Δεν έχεις δώσει άδεια τοποθεσίας στον περιηγητή.')
      : st === 'insecure' ? t('Η τοποθεσία χρειάζεται ασφαλή σύνδεση (https).')
        : st === 'unavailable' || st === 'timeout' ? t('Η τοποθεσία σου δεν είναι διαθέσιμη αυτή τη στιγμή.')
          : st === 'locating' ? t('Εντοπισμός τοποθεσίας…') : t('Χρειάζομαι την αφετηρία σου.');
    body.replaceChildren(stateBox('locate', t('Από πού ξεκινάς;'), why,
      h('div', { class: 'pl-btnrow' },
        st === 'denied' || st === 'insecure' ? null : btn(t('Εντόπισέ με'), useMyLocation, 'primary', 'locate'),
        M('getCenter') ? btn(t('Κέντρο του χάρτη'), () => pick('from', { ...M('getCenter'), name: CENTER_NAME(), kind: 'place' }, 'map'), '', 'pin') : null,
        btn(t('Γράψε αφετηρία'), () => fromInput.focus(), '', 'search'))));
  }

  function renderLoading() {
    const sk = () => h('div', { class: 'pl-card pl-skel', 'aria-hidden': 'true' }, h('span', { class: 'pl-skel-b' }), h('span', { class: 'pl-skel-l' }), h('span', { class: 'pl-skel-s' }));
    body.replaceChildren(h('p', { class: 'pl-hint pl-hint-busy', role: 'status' }, t('Ψάχνω την καλύτερη διαδρομή…')), sk(), sk());
  }

  function renderError() {
    body.replaceChildren(stateBox('alert', t('Δεν ήταν δυνατός ο υπολογισμός'), t('Έλεγξε τη σύνδεσή σου και δοκίμασε ξανά.'), btn(t('Δοκίμασε ξανά'), () => runPlan(), 'primary', 'refresh')));
  }

  function nearestToDest() {
    if (!S.to || !ctx.data?.stops) return null;
    const list = nearestStops(ctx.data.stops, S.to, { limit: 4, maxMeters: 3000 });
    if (!list.length) return null;
    return h('div', { class: 'pl-sug-list' }, h('div', { class: 'pl-sug-head' }, t('Κοντινότερες στάσεις στον προορισμό')),
      list.map(({ stop, meters }) => h('a', { class: 'pl-sug press', href: cityHash(`#/stop/${encodeURIComponent(stop.code)}`) },
        h('span', { class: 'pl-sug-ic is-stop' }, icon('bus')),
        h('span', { class: 'pl-sug-t' }, h('span', { class: 'pl-sug-name' }, stop.displayName), h('span', { class: 'pl-sug-sub' }, t('Στάση {code}', { code: stop.code }))),
        h('span', { class: 'pl-sug-d' }, fmtDist(meters)))));
  }

  function renderEmpty(reason) {
    const walkHint = S.from && S.to ? t('Απόσταση σε ευθεία: {dist}.', { dist: fmtDist(haversine(S.from, S.to)) }) : '';
    const edit = (f) => btn(f === 'from' ? t('Άλλη αφετηρία') : t('Άλλος προορισμός'), () => inputFor(f).focus(), '', 'search');
    const m = {
      'outside-to': () => stateBox('info', t('Ο προορισμός είναι εκτός περιοχής'), t('Τα αστικά λεωφορεία δεν εξυπηρετούν αυτή την περιοχή.'), edit('to')),
      'outside-from': () => stateBox('info', t('Η αφετηρία είναι εκτός περιοχής'), t('Διάλεξε ένα σημείο μέσα στην περιοχή των αστικών λεωφορείων.'), edit('from')),
      'no-data': () => stateBox('alert', t('Τα δεδομένα διαδρομών δεν είναι διαθέσιμα'), t('Δοκίμασε ξανά σε λίγο ή δες τη στάση που σε ενδιαφέρει.'), btn(t('Δοκίμασε ξανά'), () => runPlan(), '', 'refresh')),
      'no-board-stops': () => stateBox('info', t('Δεν υπάρχει στάση κοντά στην αφετηρία'), `${t('Η πλησιέστερη στάση είναι πάνω από 1,5 χλμ μακριά.')} ${walkHint}`, edit('from')),
      'no-alight-stops': () => stateBox('info', t('Δεν υπάρχει στάση κοντά στον προορισμό'), `${walkHint} ${t('Δες τις πιο κοντινές στάσεις παρακάτω.')}`, edit('to')),
    };
    const box = (m[reason] || (() => stateBox('info', t('Δεν βρέθηκε διαδρομή με λεωφορείο'), `${t('Δεν υπάρχει γραμμή, ούτε με μία αλλαγή, που να σε πάει εκεί.')} ${walkHint}`.trim(), edit('to'))))();
    const links = h('p', { class: 'pl-hint' }, t('Δες τις '), h('a', { href: cityHash('#/lines') }, t('γραμμές')), t(' ή δοκίμασε άλλον προορισμό.'));
    body.replaceChildren(box, reason === 'outside-from' || reason === 'outside-to' ? null : nearestToDest(), links);
  }

  // ---- when / hero text

  function whenInfo(it, now) {
    const st = leaveState(it, now);
    switch (st.kind) {
      case 'walk': return { kind: 'walk', lead: t('Περπάτημα'), big: dur(it.walkTo.seconds), short: dur(it.walkTo.seconds) };
      case 'none': return { kind: 'none', lead: '', big: t('Χωρίς δρομολόγιο τώρα'), short: t('Χωρίς δρομολόγιο τώρα') };
      case 'later': { const when = etaTxt(st.leaveInSec); return { kind: 'later', lead: t('Φύγε σε'), big: when, short: t('Φύγε σε {when}', { when }) }; }
      case 'now': return { kind: 'now', lead: '', big: t('Φύγε τώρα'), short: t('Φύγε τώρα') };
      case 'run': {
        const big = st.remainingSec < 15 ? t('φεύγει τώρα!') : t('φεύγει σε {when}', { when: etaTxt(st.remainingSec) });
        return { kind: 'run', lead: t('Τρέξε!'), big, short: t('Τρέξε! {big}', { big: `${big[0].toUpperCase()}${big.slice(1)}` }) };
      }
      default: return { kind: 'none', lead: '', big: t('Ψάχνω το επόμενο…'), short: t('Ψάχνω το επόμενο…') };
    }
  }

  const flag = (liveBus) => (liveBus
    ? h('span', { class: 'pl-flag is-live' }, h('span', { class: 'pl-dot', 'aria-hidden': 'true' }), t('LIVE'))
    : h('span', { class: 'pl-flag' }, icon('clock'), t('ΠΡΟΓΡ.')));

  function renderResults() {
    const cards = S.its.map((it) => card(it, it.id === S.selectedId));
    const notes = [];
    const r = S.result;
    if (r && r.liveTotal && r.liveFailed >= r.liveTotal && S.its.some((i) => i.kind !== 'walk')) {
      notes.push(h('div', { class: 'pl-banner' }, h('span', {}, t('Δεν φορτώθηκαν δεδομένα live για τις στάσεις — οι ώρες αναχώρησης λείπουν.')), btn(t('Δοκίμασε ξανά'), () => runPlan({ silent: true }), 'sm current')));
    } else if (S.its.length && S.its.every((i) => i.kind !== 'walk' && i.status === 'none')) {
      notes.push(h('div', { class: 'pl-banner' }, h('span', {}, t('Δεν υπάρχουν αναχωρήσεις αυτή τη στιγμή για αυτές τις γραμμές (ίσως έχουν τελειώσει τα δρομολόγια).'))));
    }
    if (S.pending > 0) notes.push(h('p', { class: 'pl-hint pl-hint-busy' }, t('Υπολογίζω ακριβώς τον χρόνο περπατήματος…')));
    if (S.from?.approx || S.to?.approx) notes.push(h('p', { class: 'pl-hint' }, t('Η διεύθυνση αντιστοιχήθηκε κατά προσέγγιση (οδός ή κοντινό σημείο, όχι ο ακριβής αριθμός).')));
    body.replaceChildren(...notes, h('div', { class: 'pl-cards' }, cards),
      moreBox(h('p', { class: 'pl-foot' }, t('LIVE = θέση οχήματος σε πραγματικό χρόνο · ΠΡΟΓΡ. = ώρα από το πρόγραμμα. Ο χρόνος διαδρομής είναι εκτίμηση, εκτός αν αναγράφεται «από το όχημα».')
        + (S.its.some((i) => i.kind === 'transfer') ? ` ${t('Στις διαδρομές με αλλαγή, η ώρα του δεύτερου λεωφορείου είναι εκτίμηση όταν δεν υπάρχει καταχωρημένη αναχώρηση.')}` : '')
        + (getSettings().bufferMin ? ` ${t('Η ώρα εκκίνησης έχει περιθώριο {n}′ (ρυθμίσεις).', { n: getSettings().bufferMin })}` : ''))));
  }

  function card(it, isSel) {
    const now = Date.now();
    const isWalk = it.kind === 'walk';
    const w = whenInfo(it, now);
    const isX = it.kind === 'transfer';
    const dest = isWalk ? t('Περπάτημα') : isX ? t('Αλλαγή: {stop}', { stop: it.transfer.stop.displayName }) : t('προς {dest}', { dest: towards(it.bus?.routeName || it.route.name) });
    const when = h('span', { class: `pl-when is-${w.kind}` }, w.short);
    const guess = isX && it.transfer.estimated;
    const arrive = h('span', { class: 'pl-card-end' },
      it.arriveAt != null ? [h('strong', {}, `${guess ? '~' : ''}${fmtClock(it.arriveAt)}`), h('small', {}, guess ? t('εκτίμηση') : t('άφιξη'))] : [h('strong', {}, `~${dur(it.estTotalSec)}`), h('small', {}, t('διαδρομή'))]);
    const walkTotal = (it.walkTo?.seconds || 0) + (it.walkFrom?.seconds || 0) + (it.transfer?.walk?.seconds || 0);
    const meta = h('span', { class: 'pl-card-meta' },
      isWalk ? `${fmtDist(it.walkTo.meters)}` : [icon('walk'), `${dur(walkTotal)}`, ` · ${tn(it.nStops, '{n} στάση', '{n} στάσεις')}${isX ? ` · ${t('1 αλλαγή')}` : ''}`]);
    const lead = isWalk ? h('span', { class: 'pl-walk-ic' }, icon('walk'))
      : isX ? h('span', { class: 'pl-xlead', role: 'img', 'aria-label': t('Γραμμή {a}, μετά γραμμή {b}', { a: it.legs[0].route.lineCode, b: it.legs[1].route.lineCode }) },
        lineBadge(it.legs[0].line || { code: it.legs[0].route.lineCode }), h('span', { class: 'pl-xarrow', 'aria-hidden': 'true' }, '→'), lineBadge(it.legs[1].line || { code: it.legs[1].route.lineCode }))
        : lineBadge(it.line || { code: it.route.lineCode });
    const headBtn = h('button', { type: 'button', class: 'pl-card-head press', 'aria-expanded': String(isSel), onclick: () => select(it.id) },
      h('span', { class: 'pl-card-lead' }, lead),
      h('span', { class: 'pl-card-main' }, h('span', { class: 'pl-card-dest' }, dest),
        h('span', { class: 'pl-card-when' }, when, !isWalk && it.bus ? flag(it.bus.live) : null, guess ? h('span', { class: 'pl-flag is-est' }, t('αλλαγή: εκτίμηση')) : null), meta),
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
    const hero = h('div', { class: 'pl-hero', role: 'group', 'aria-label': t('Πότε να φύγεις') }, lead, big, sub);
    if (isWalk) sub.append(t('{dist} · άφιξη {clock}', { dist: fmtDist(it.walkTo.meters), clock: fmtClock(it.arriveAt) }));
    else if (it.bus) sub.append(t('Ξεκίνα {time} · {dur} ως «{stop}»', { time: fmtClock(it.leaveAt), dur: dur(it.walkTo.seconds), stop: it.board.displayName }));
    else if (it.liveError) sub.append(t('Δεν φορτώθηκαν δεδομένα live για τη στάση.'));
    else if (it.missed) sub.append(t('Το επόμενο λεωφορείο φεύγει σε {when}, αλλά χρειάζεσαι {dur} για να φτάσεις στη στάση.', { when: etaTxt(it.missed.remainingSec), dur: dur(it.walkTo.seconds) }));
    else sub.append(t('Δεν υπάρχει καταχωρημένη αναχώρηση για αυτή τη γραμμή στη στάση αυτή τη στιγμή.'));
    // quiet extra meta line (detail only): scheduled bus shifted by its typical delay
    if (it.bus?.delayAdjustSec) hero.append(h('div', { class: 'pl-hero-sub pl-hero-delay', title: it.bus.delayLabel }, t('+{n}′ συνήθης καθυστέρηση', { n: Math.max(1, Math.round(it.bus.delayAdjustSec / 60)) })));
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
      notes.push(h('p', { class: 'pl-note is-warn' }, t('Δεν προλαβαίνεις το {clock} (σε {when}) — χρειάζεσαι {dur} για τη στάση. Δείχνω το επόμενο.', { clock: fmtClock(it.missed.departAt), when: etaTxt(it.missed.remainingSec), dur: dur(it.walkTo.seconds) })));
    }
    if (!isWalk && it.bus && it.hurry) {
      notes.push(h('p', { class: 'pl-note' }, t('Αν τρέξεις, προλαβαίνεις και το προηγούμενο: φεύγει στις {clock} (σε {when}).', { clock: fmtClock(it.hurry.bus.departAt), when: etaTxt(it.hurry.bus.remainingSec) })));
    }
    if (!isWalk && it.bus && it.next) {
      notes.push(h('p', { class: 'pl-note' }, t('Επόμενο: φεύγει στις {clock} (σε {when}) — άφιξη {arrive}.', { clock: fmtClock(it.next.bus.departAt), when: etaTxt(it.next.bus.remainingSec), arrive: fmtClock(it.next.arriveAt) })));
    }
    if (it.kind === 'transfer' && it.bus) {
      const tr = it.transfer, B = it.legs[1];
      if (tr.missed) notes.push(h('p', { class: 'pl-note is-warn' }, t('Η γραμμή {line} των {clock} θα έχει φύγει όταν φτάσεις στη στάση αλλαγής — περιμένεις το επόμενο.', { line: B.route.lineCode, clock: fmtClock(tr.missed.departAt) })));
      if (it.xLiveError) notes.push(h('p', { class: 'pl-note' }, t('Δεν φορτώθηκαν δεδομένα live για τη στάση αλλαγής — η αναμονή είναι εκτίμηση.')));
      else if (tr.estimated) notes.push(h('p', { class: 'pl-note' }, t('Δεν υπάρχει ακόμη καταχωρημένη αναχώρηση της γραμμής {line} για την ώρα που θα φτάσεις — η αναμονή (~{dur}) είναι εκτίμηση.', { line: B.route.lineCode, dur: dur(tr.waitSec) })));
    }
    if (!isWalk && !it.bus && it.estTotalSec) {
      notes.push(h('p', { class: 'pl-note' }, t('Όταν υπάρξει δρομολόγιο: περίπου {total} συνολικά (περπάτημα {walk} + λεωφορείο {ride}).', { total: dur(it.estTotalSec), walk: dur(it.walkTo.seconds + it.walkFrom.seconds + (it.transfer?.walk?.seconds || 0)), ride: dur(it.rideEstSec) })));
    }

    const warns = notes.filter((n) => n.classList.contains('is-warn'));
    return h('div', { class: 'pl-detail' }, hero, ...warns, timeline(it, now), actions(it, notes.filter((n) => !warns.includes(n))));
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
  const stopsText = (n) => tn(n, '{n} στάση', '{n} στάσεις');
  const estTag = (w) => (w?.source === 'estimate' ? ` · ${t('εκτίμηση')}` : '');

  function timeline(it, now) {
    const dest = S.to?.name || t('προορισμό');
    if (it.kind === 'walk') {
      return h('ol', { class: 'pl-tl' },
        step('walk', fmtClock(now), icon('walk'), t('Περπάτα {dur}', { dur: dur(it.walkTo.seconds) }), `${t('{dist} ως «{dest}»', { dist: fmtDist(it.walkTo.meters), dest })}${estTag(it.walkTo)}`),
        step('arrive', fmtClock(it.arriveAt), icon('pin'), t('Άφιξη στο «{dest}»', { dest })));
    }
    if (it.kind === 'transfer') return timelineTransfer(it, now, dest);
    const items = [];
    const bus = it.bus;
    items.push(step('walk', bus ? fmtClock(it.leaveAt) : '', icon('walk'), t('Περπάτα {dur} ως τη στάση «{stop}»', { dur: dur(it.walkTo.seconds), stop: it.board.displayName }),
      `${fmtDist(it.walkTo.meters)}${estTag(it.walkTo)}`));
    if (bus) {
      const tile = arrivalTile({ lineCode: it.line?.code ?? it.route.lineCode, routeName: bus.routeName || it.route.name, live: bus.live, etaSec: (bus.departAt - bus.fetchedAt) / 1000, color: it.line?.color, textColor: it.line?.textColor },
        bus.fetchedAt, { compact: true, line: it.line || undefined, now });
      updaters.push((t) => tile.tick?.(t));
      items.push(step('bus', fmtClock(bus.departAt), icon('bus'), t('Γραμμή {line} προς {dest}', { line: it.line?.code ?? it.route.lineCode, dest: towards(bus.routeName || it.route.name) }),
        it.bufferSec ? t('Περίμενε ~{dur} στη στάση', { dur: dur(it.bufferSec) }) : '', tile));
      const rideLabel = it.rideSource === 'live-match' ? t('από το ίδιο όχημα') : t('εκτίμηση');
      items.push(step('ride', fmtClock(bus.departAt + it.rideSec * 1000), icon('route'), t('Μετακίνηση {dur} · {stops}', { dur: dur(it.rideSec), stops: stopsText(it.nStops) }),
        t('Κατέβα στη στάση «{stop}» · {how}', { stop: it.alight.displayName, how: rideLabel })));
    } else {
      items.push(step('bus', '', icon('bus'), t('Γραμμή {line} προς {dest}', { line: it.line?.code ?? it.route.lineCode, dest: towards(it.route.name) }), t('Χωρίς δρομολόγιο τώρα')));
      items.push(step('ride', '', icon('route'), t('Μετακίνηση ~{dur} · {stops}', { dur: dur(it.rideEstSec), stops: stopsText(it.nStops) }), t('Κατέβα στη στάση «{stop}» · {how}', { stop: it.alight.displayName, how: t('εκτίμηση') })));
    }
    if (it.walkFrom.meters >= 25) items.push(step('walk', bus ? fmtClock(bus.departAt + it.rideSec * 1000) : '', icon('walk'), t('Περπάτα {dur} ως «{dest}»', { dur: dur(it.walkFrom.seconds), dest }), `${fmtDist(it.walkFrom.meters)}${estTag(it.walkFrom)}`));
    items.push(step('arrive', it.arriveAt != null ? fmtClock(it.arriveAt) : '', icon('pin'), t('Άφιξη'), it.arriveAt != null ? `«${dest}»` : null));
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
    const rideNote = (l, name) => t('Κατέβα στη στάση «{stop}» · {how}', { stop: name, how: l.rideSource === 'live-match' ? t('από το ίδιο όχημα') : t('εκτίμηση') });
    items.push(step('walk', it.bus ? fmtClock(it.leaveAt) : '', icon('walk'), t('Περπάτα {dur} ως τη στάση «{stop}»', { dur: dur(it.walkTo.seconds), stop: it.board.displayName }), `${fmtDist(it.walkTo.meters)}${estTag(it.walkTo)}`));
    if (!it.bus) {
      items.push(step('bus', '', icon('bus'), t('Γραμμή {line} προς {dest}', { line: code(A), dest: towards(A.route.name) }), t('Χωρίς δρομολόγιο τώρα'), null, lineVars(A)));
      items.push(step('arrive', '', icon('pin'), t('Άφιξη'), null));
      return h('ol', { class: 'pl-tl' }, items);
    }
    items.push(step('bus', fmtClock(A.bus.departAt), icon('bus'), t('Γραμμή {line} προς {dest}', { line: code(A), dest: towards(A.bus.routeName || A.route.name) }),
      it.bufferSec ? t('Περίμενε ~{dur} στη στάση', { dur: dur(it.bufferSec) }) : '', tile(A), lineVars(A)));
    items.push(step('ride', fmtClock(tr.arriveAt), icon('route'), t('Μετακίνηση {dur} · {stops}', { dur: dur(A.rideSec), stops: stopsText(A.nStops) }), rideNote(A, tr.stop.displayName), null, lineVars(A)));
    const wait = t('Περίμενε {dur}{est} για τη γραμμή {line}', { dur: dur(tr.waitSec), est: tr.estimated ? ` · ${t('εκτίμηση')}` : '', line: code(B) });
    items.push(step('change', fmtClock(tr.arriveAt), icon('swap'),
      tr.walk ? t('Αλλαγή: περπάτα {dur} ως τη στάση «{stop}»', { dur: dur(tr.walk.seconds), stop: tr.to.displayName }) : t('Αλλαγή λεωφορείου στη στάση «{stop}»', { stop: tr.stop.displayName }),
      tr.walk ? `${fmtDist(tr.walk.meters)} · ${wait}` : wait));
    items.push(step('bus', `${tr.estimated ? '~' : ''}${fmtClock(B.bus.departAt)}`, icon('bus'), t('Γραμμή {line} προς {dest}', { line: code(B), dest: towards(B.bus.routeName || B.route.name) }),
      tr.estimated ? t('Εκτίμηση: δεν υπάρχει καταχωρημένη αναχώρηση') : '', tr.estimated ? null : tile(B), lineVars(B)));
    items.push(step('ride', fmtClock(B.bus.departAt + B.rideSec * 1000), icon('route'), t('Μετακίνηση {dur} · {stops}', { dur: dur(B.rideSec), stops: stopsText(B.nStops) }), rideNote(B, it.alight.displayName), null, lineVars(B)));
    if (it.walkFrom.meters >= 25) items.push(step('walk', fmtClock(B.bus.departAt + B.rideSec * 1000), icon('walk'), t('Περπάτα {dur} ως «{dest}»', { dur: dur(it.walkFrom.seconds), dest }), `${fmtDist(it.walkFrom.meters)}${estTag(it.walkFrom)}`));
    items.push(step('arrive', `${tr.estimated ? '~' : ''}${fmtClock(it.arriveAt)}`, icon('pin'), t('Άφιξη'), `«${dest}»`));
    return h('ol', { class: 'pl-tl' }, items);
  }

  // ---- reminder + actions

  const tagOf = (it) => `plan:${it.id}`;
  // The bus the rider boards first, and where to get off it (a transfer: at the change stop).
  function boardedLeg(it) {
    const leg = it.kind === 'transfer' ? { bus: it.legs[0].bus, route: it.legs[0].route, alight: it.transfer.stop } : { bus: it.bus, route: it.route, alight: it.alight };
    return leg.bus?.vehicleCode && leg.route && leg.alight ? { vehicleCode: leg.bus.vehicleCode, route: leg.route, alight: leg.alight } : null;
  }
  function onboardBtn(ob) {
    const mine = () => activeTrip()?.vehicleCode === ob.vehicleCode;
    const b = h('button', { type: 'button', class: 'btn', onclick: async () => {
      if (mine()) stopOnboard();
      else if (await startOnboard({ vehicleCode: ob.vehicleCode, routeCode: ob.route.code, lineCode: ob.route.lineCode, alightStop: ob.alight.code, stopName: ob.alight.displayName })) {
        toast(t('Θα σε ειδοποιήσω πριν τη «{name}»', { name: ob.alight.displayName }));
      }
      paint();
    } });
    const paint = () => b.replaceChildren(icon('bus'), mine() ? t('Τέλος') : t('Είμαι στο λεωφορείο'));
    paint();
    return b;
  }

  function actions(it, quietNotes = []) {
    if (it.kind === 'walk') return null;
    const ob = boardedLeg(it);
    const tag = tagOf(it);
    const bell = h('button', { type: 'button', class: 'btn primary', onclick: () => toggleReminder(it, bell) });
    const paintBell = () => {
      const on = hasReminder(tag);
      bell.replaceChildren(icon('bell'), on ? t('Ακύρωση υπενθύμισης') : t('Υπενθύμισέ μου'));
      bell.classList.toggle('on', on);
      bell.disabled = !it.bus && !on;
    };
    paintBell();
    return h('div', { class: 'pl-actions' }, bell, ob ? onboardBtn(ob) : null,
      moreBox(...quietNotes, btn(t('Στάση επιβίβασης'), () => ctx.navigate(`#/stop/${encodeURIComponent(it.board.code)}`), '', 'bus')));
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
      toast(t('Η υπενθύμιση ακυρώθηκε'));
      render();
      return;
    }
    if (!it.bus) { toast(t('Δεν υπάρχει δρομολόγιο για υπενθύμιση')); return; }
    const at = reminderAt(it);
    if (at <= Date.now() + 5000) { toast(t('Πρέπει να ξεκινήσεις ήδη τώρα — δεν χρειάζεται υπενθύμιση')); return; }
    bell.disabled = true;
    const granted = await ensurePermission().catch(() => false);
    scheduleReminder({ at, title: t('Ώρα να φύγεις'), body: reminderBody(it), tag, url: relHash(location.hash).startsWith('#/plan') ? shareHash(location.hash) : undefined, trip: reminderTrip(it) });
    toast(t('Θα σε ειδοποιήσω στις {clock}, όσο η εφαρμογή είναι ανοιχτή', { clock: fmtClock(at) }) + (granted ? '' : ` ${t('(χωρίς ειδοποίηση συστήματος)')}`));
    if (!dead) render();
  }
  const reminderBody = (it) => {
    const p = { line: it.line?.code ?? it.route.lineCode, clock: fmtClock(it.bus.departAt), stop: it.board.displayName };
    const rm = getSettings().reminderMin;
    const head = rm ? t('Φύγε σε {n}′ για τη γραμμή {line} ({clock}) από τη στάση «{stop}»', { ...p, n: rm }) : t('Φύγε τώρα για τη γραμμή {line} ({clock}) από τη στάση «{stop}»', p);
    return head + (it.kind === 'transfer' ? t(', μετά αλλαγή στη γραμμή {line}.', { line: it.legs[1].line?.code ?? it.legs[1].route.lineCode }) : '.');
  };

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
        if (tr.walk) marks.push({ lat: tr.stop.lat, lng: tr.stop.lng, kind: 'alight', label: t('Αλλαγή · κατέβα: {stop}', { stop: tr.stop.displayName }) }, { lat: tr.to.lat, lng: tr.to.lng, kind: 'board', label: t('Αλλαγή · ανέβα: {stop}', { stop: tr.to.displayName }) });
        else marks.push({ lat: tr.stop.lat, lng: tr.stop.lng, kind: 'board', label: t('Αλλαγή: {stop}', { stop: tr.stop.displayName }) });
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
      S.from = { lat: fix.lat, lng: fix.lng, name: MY_LOCATION(), source: 'gps' };
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
