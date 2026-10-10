// Saved places (Σπίτι/Δουλειά + up to 3 custom) and the one-line home card (owner: places). See docs/ARCHITECTURE.md (Round 3).
// Storage is its own key and never throws: when localStorage is unavailable the places live in memory for the page.
import { h, icon, lineBadge, fmtClock } from './ui.js';
import { t, N_ } from './i18n.js';
import { haversine } from './geo.js';
import { planTrips, leaveState } from './planner.js';
import { searchPlaces } from './geocode.js';

export const KEY = 'patra-bus:places';
export const MAX_CUSTOM = 3;
export const FAR_M = 300;        // the card appears only when you are farther than this from the place
export const REPLAN_MS = 60000;  // plan refresh floor while visible
const TICK_MS = 15000;           // repaint of the countdown
const DEFAULT_NAMES = { home: N_('Σπίτι'), work: N_('Δουλειά') };
const PLACE_NAME = N_('Τόπος'); // stored default name for custom places, shown translated

// JSON in localStorage with a memory fallback (private mode, quota, no storage at all).
export function jsonStore(key, { storage } = {}) {
  let mem = null; // set only after a failed write: it is then newer than whatever storage holds
  const ls = () => { try { return storage !== undefined ? storage : globalThis.localStorage ?? null; } catch { return null; } };
  return {
    read(def = null) {
      if (mem !== null) return mem;
      try { const s = ls()?.getItem(key); return s == null ? def : JSON.parse(s); } catch { return def; }
    },
    write(v) {
      try { ls().setItem(key, JSON.stringify(v)); mem = null; } catch { mem = v; }
    },
  };
}

const clip = (s, n) => String(s ?? '').trim().slice(0, n);
export function cleanPlace(p) {
  if (!p || typeof p !== 'object') return null;
  const lat = Number(p.lat), lng = Number(p.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (!lat && !lng)) return null;
  const id = clip(p.id, 40);
  if (!id) return null;
  return { id, name: clip(p.name, 40) || DEFAULT_NAMES[id] || PLACE_NAME, lat, lng };
}

const slotOrder = (p) => (p.id === 'home' ? 0 : p.id === 'work' ? 1 : 2);

export function createPlaces({ storage, now = Date.now, rand = Math.random } = {}) {
  const kv = jsonStore(KEY, { storage });
  const subs = new Set();
  const load = () => {
    const seen = new Set();
    const list = (Array.isArray(kv.read([])) ? kv.read([]) : []).map(cleanPlace).filter((p) => p && !seen.has(p.id) && seen.add(p.id));
    const custom = list.filter((p) => slotOrder(p) === 2).slice(0, MAX_CUSTOM);
    return [...list.filter((p) => slotOrder(p) < 2), ...custom].sort((a, b) => slotOrder(a) - slotOrder(b));
  };
  const save = (list) => { kv.write(list); for (const fn of [...subs]) { try { fn(list); } catch { /* ignore */ } } };
  return {
    getPlaces: load,
    // → the stored place, or null (invalid, or a 4th custom place). No id = a new custom place.
    setPlace(p) {
      const list = load();
      const raw = { ...p, id: p?.id || `p${now().toString(36)}${Math.floor(rand() * 1296).toString(36)}` };
      const clean = cleanPlace(raw);
      if (!clean) return null;
      const i = list.findIndex((x) => x.id === clean.id);
      if (i < 0 && slotOrder(clean) === 2 && list.filter((x) => slotOrder(x) === 2).length >= MAX_CUSTOM) return null;
      if (i >= 0) list[i] = clean; else list.push(clean);
      save(list.sort((a, b) => slotOrder(a) - slotOrder(b)));
      return clean;
    },
    removePlace(id) {
      const list = load();
      const next = list.filter((p) => p.id !== id);
      if (next.length === list.length) return false;
      save(next);
      return true;
    },
    onPlacesChange(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
}

const real = createPlaces();
export const { getPlaces, setPlace, removePlace, onPlacesChange } = real;

// Helpers for other views ("Αποθήκευση ως Σπίτι/Δουλειά"). `pt` = { lat, lng }.
export const saveAs = (id, pt) => real.setPlace({ id, name: DEFAULT_NAMES[id], lat: pt?.lat, lng: pt?.lng });
export const saveAsHome = (pt) => saveAs('home', pt);
export const saveAsWork = (pt) => saveAs('work', pt);

// ---------------------------------------------------------------- pure logic

// Display name: the default Σπίτι/Δουλειά is translated, anything the user typed is shown as is.
export const placeLabel = (p) => (DEFAULT_NAMES[p.id] === p.name || p.name === PLACE_NAME ? t(p.name) : p.name);
// "Για το σπίτι" / "Για τη δουλειά" / "Προς {name}"
export function placeTitle(p) {
  if (p.id === 'home' && p.name === DEFAULT_NAMES.home) return t('Για το σπίτι');
  if (p.id === 'work' && p.name === DEFAULT_NAMES.work) return t('Για τη δουλειά');
  return t('Προς {name}', { name: p.name });
}
const fix2 = (n) => Number(n).toFixed(5);
export const placeHash = (p) => `#/plan?to=${fix2(p.lat)},${fix2(p.lng)}&name=${encodeURIComponent(p.name)}`;

export const athensHour = (ms = Date.now()) =>
  Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: 'Europe/Athens' }).format(new Date(ms)));

// The place worth a card right now: only places farther than minM; mornings → Δουλειά, evenings → Σπίτι,
// otherwise (or when that one is too close / not saved) the farthest.
export function pickPlace(places, here, { hour = athensHour(), minM = FAR_M } = {}) {
  if (!here || !Number.isFinite(here.lat) || !Number.isFinite(here.lng)) return null;
  const far = (places || []).map((p) => ({ p, d: haversine(here, p) })).filter((x) => x.d > minM);
  if (!far.length) return null;
  const want = hour >= 5 && hour < 12 ? 'work' : hour >= 16 || hour < 4 ? 'home' : null;
  const hit = want && far.find((x) => x.p.id === want);
  return (hit || far.reduce((a, b) => (b.d > a.d ? b : a))).p;
}

// First itinerary worth showing: a walk, or a bus that can still be caught.
export function usableItinerary(its, now = Date.now()) {
  for (const it of its || []) {
    const k = leaveState(it, now).kind;
    if (k === 'walk' || k === 'later' || k === 'now' || k === 'run') return it;
  }
  return null;
}

export function leaveText(st, it) {
  if (st.kind === 'walk') return t('Περπάτησε {n}′', { n: Math.max(1, Math.round(it.estTotalSec / 60)) });
  if (st.kind === 'later') return t('Φύγε σε {n}′', { n: Math.ceil(st.leaveInSec / 60) });
  return t('Φύγε τώρα');
}

// ---------------------------------------------------------------- home card

export function mountPlacesCard(container, ctx = {}) {
  let dead = false, ctl = null, best = null, place = null, planFrom = null, lastPlanAt = 0;
  const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

  function paint() {
    if (dead) return;
    const now = Date.now();
    const st = best && place ? leaveState(best, now) : null;
    if (!st || !['walk', 'later', 'now', 'run'].includes(st.kind)) {
      best = null;
      container.replaceChildren();
      return;
    }
    const head = [h('span', { class: 'plc-to' }, placeTitle(place))];
    const metaBits = [];
    if (best.kind === 'walk') {
      metaBits.push(t('Φτάνεις {time}', { time: fmtClock(best.arriveAt) }));
    } else {
      const line = best.line || { code: best.route?.lineCode };
      head.push(h('span', { class: 'plc-sep', 'aria-hidden': 'true' }, '·'), lineBadge(line));
      metaBits.push(t('Φτάνεις {time}', { time: fmtClock(best.arriveAt) }));
      if (best.walkTo?.seconds >= 60) metaBits.push(t('{n}′ περπάτημα', { n: Math.round(best.walkTo.seconds / 60) }));
    }
    head.push(h('span', { class: 'plc-sep', 'aria-hidden': 'true' }, '·'), h('b', { class: 'plc-leave' }, leaveText(st, best)));
    if (best.kind !== 'walk') {
      head.push(best.bus?.live
        ? h('span', { class: 'ex-chip ex-chip-live plc-flag' }, h('span', { class: 'ex-chip-dot', 'aria-hidden': 'true' }), 'LIVE')
        : h('span', { class: 'ex-chip ex-chip-sched plc-flag' }, icon('clock'), t('ΠΡΟΓΡ.')));
    }
    container.replaceChildren(h('a', { class: 'plc-card', href: placeHash(place) },
      h('div', { class: 'plc-head' }, ...head),
      h('div', { class: 'plc-meta' }, metaBits.join(' · '))));
  }

  function apply(pl, its) {
    if (dead) return;
    place = pl;
    best = usableItinerary(its);
    paint();
  }

  async function plan() {
    if (dead || !visible()) return;
    const here = ctx.location?.current;
    const pl = pickPlace(getPlaces(), here);
    if (!pl) { best = null; place = null; paint(); return; }
    ctl?.abort();
    const my = (ctl = new AbortController());
    lastPlanAt = Date.now();
    planFrom = { lat: here.lat, lng: here.lng };
    try {
      const its = await planTrips(ctx, planFrom, { lat: pl.lat, lng: pl.lng }, { signal: my.signal, onUpdate: (r) => { if (!my.signal.aborted) apply(pl, r.itineraries); } });
      if (!my.signal.aborted) apply(pl, its);
    } catch (e) {
      if (!my.signal.aborted && e?.name !== 'AbortError') { best = null; paint(); }
    }
  }

  const tick = () => {
    if (dead || !visible()) return;
    if (Date.now() - lastPlanAt >= REPLAN_MS || (!best && planFrom && Date.now() - lastPlanAt >= TICK_MS)) plan(); else paint();
  };
  const onVis = () => { if (visible()) tick(); };
  const timer = setInterval(tick, TICK_MS);
  document.addEventListener?.('visibilitychange', onVis);
  const offLoc = ctx.location?.subscribe?.((fix) => { if (fix && !planFrom) plan(); });
  const offPlaces = onPlacesChange(() => { lastPlanAt = 0; planFrom = null; plan(); });

  container.replaceChildren();
  plan();
  return {
    destroy() {
      dead = true; ctl?.abort(); clearInterval(timer);
      document.removeEventListener?.('visibilitychange', onVis);
      try { offLoc?.(); } catch { /* ignore */ }
      offPlaces();
      container.replaceChildren();
    },
  };
}

// ---------------------------------------------------------------- settings

export function mountPlacesSettings(container, ctx = {}) {
  let dead = false, editing = null, abort = null, timer = null;
  const root = h('section', { class: 'plc-set' });
  container.replaceChildren(root);

  const pointHere = () => { const c = ctx.location?.current; return c && Number.isFinite(c.lat) ? { lat: c.lat, lng: c.lng } : null; };
  const pointCenter = () => { try { const c = ctx.map?.getCenter?.(); return c && Number.isFinite(c.lat) ? { lat: c.lat, lng: c.lng } : null; } catch { return null; } };

  function store(slot, pt, fallbackName) {
    const cur = getPlaces().find((p) => p.id === slot.id);
    const typed = slot.nameEl?.value.trim();
    const name = DEFAULT_NAMES[slot.id] ? (cur?.name || DEFAULT_NAMES[slot.id]) : (typed || cur?.name || fallbackName || PLACE_NAME);
    const saved = setPlace({ id: slot.id === 'new' ? undefined : slot.id, name, lat: pt.lat, lng: pt.lng });
    if (!saved) { ctx.toast?.(t('Έχεις ήδη 3 δικούς σου τόπους')); return; }
    ctx.toast?.(t('Αποθηκεύτηκε: {name}', { name: placeLabel(saved) }));
    editing = null;
    render();
  }

  function editor(slot) {
    const results = h('div', { class: 'plc-results', 'aria-live': 'polite' });
    const custom = slot.id === 'new' || !DEFAULT_NAMES[slot.id];
    const cur = getPlaces().find((p) => p.id === slot.id);
    slot.nameEl = custom ? h('input', { class: 'plc-input', type: 'text', maxlength: '40', value: cur?.name || '', placeholder: t('Όνομα (π.χ. Γυμναστήριο)'), 'aria-label': t('Όνομα') }) : null;
    if (slot.nameEl && cur) slot.nameEl.addEventListener('change', () => { const n = slot.nameEl.value.trim(); if (n) setPlace({ ...cur, name: n }); });
    const here = pointHere(), center = pointCenter();
    const q = h('input', { class: 'plc-input', type: 'search', placeholder: t('Αναζήτηση διεύθυνσης ή στάσης'), 'aria-label': t('Αναζήτηση') });
    q.addEventListener('input', () => {
      clearTimeout(timer); abort?.abort();
      const text = q.value.trim();
      if (text.length < 2) { results.replaceChildren(); return; }
      timer = setTimeout(async () => {
        const my = (abort = new AbortController());
        try {
          const near = here || pointCenter() || undefined;
          const list = await searchPlaces(text, { near, signal: my.signal, data: ctx.data });
          if (dead || my.signal.aborted) return;
          results.replaceChildren(...(list.length
            ? list.map((r) => h('button', { type: 'button', class: 'plc-result', onclick: () => store(slot, r, r.name) },
              h('span', { class: 'plc-result-name' }, r.name), r.subtitle ? h('span', { class: 'ex-sub' }, r.subtitle) : null))
            : [h('p', { class: 'ex-sub' }, t('Δεν βρέθηκε τίποτα.'))]));
        } catch (e) { if (e?.name !== 'AbortError') results.replaceChildren(h('p', { class: 'ex-sub' }, t('Η αναζήτηση δεν δουλεύει τώρα.'))); }
      }, 300);
    });
    return h('div', { class: 'plc-editor' },
      slot.nameEl,
      h('div', { class: 'set-actions' },
        here ? h('button', { type: 'button', class: 'ex-btn ex-btn-sm', onclick: () => store(slot, here, t('Η θέση μου')) }, icon('locate'), t('Η τρέχουσα θέση')) : null,
        center ? h('button', { type: 'button', class: 'ex-btn ex-btn-sm', onclick: () => store(slot, center, t('Σημείο χάρτη')) }, icon('pin'), t('Το κέντρο του χάρτη')) : null,
        h('button', { type: 'button', class: 'ex-btn ex-btn-sm', onclick: () => { editing = null; render(); } }, t('Άκυρο'))),
      q, results);
  }

  function row(slot, p) {
    const open = editing?.id === slot.id;
    return h('div', { class: 'plc-slot' },
      h('div', { class: 'set-item plc-row' },
        h('div', { class: 'set-item-main' },
          h('div', { class: 'set-label' }, p ? placeLabel(p) : t(DEFAULT_NAMES[slot.id])),
          h('span', { class: 'ex-sub' }, p ? `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}` : t('Δεν έχει οριστεί'))),
        h('button', { type: 'button', class: 'ex-btn ex-btn-sm', 'aria-expanded': String(open), onclick: () => { editing = open ? null : slot; render(); } }, p ? t('Αλλαγή') : t('Ορισμός')),
        p ? h('button', { type: 'button', class: 'ex-btn ex-btn-sm ex-btn-danger', 'aria-label': t('Διαγραφή: {name}', { name: placeLabel(p) }), onclick: () => { removePlace(p.id); if (editing?.id === p.id) editing = null; render(); } }, icon('trash')) : null),
      open ? editor(slot) : null);
  }

  function render() {
    if (dead) return;
    const places = getPlaces();
    const rows = ['home', 'work'].map((id) => row({ id }, places.find((p) => p.id === id)));
    for (const p of places.filter((x) => slotOrder(x) === 2)) rows.push(row({ id: p.id }, p));
    if (editing?.id === 'new') rows.push(h('div', { class: 'plc-slot' }, h('div', { class: 'set-label' }, t('Νέος τόπος')), editor(editing)));
    else if (places.filter((x) => slotOrder(x) === 2).length < MAX_CUSTOM) {
      rows.push(h('div', { class: 'set-actions' }, h('button', { type: 'button', class: 'ex-btn ex-btn-sm', onclick: () => { editing = { id: 'new' }; render(); } }, '+ ', t('Προσθήκη τόπου'))));
    }
    root.replaceChildren(h('h3', { class: 'set-sub plc-title' }, t('Αγαπημένοι τόποι')), h('div', { class: 'set-list' }, ...rows));
  }

  const off = onPlacesChange(() => { if (!editing) render(); });
  render();
  return { destroy() { dead = true; clearTimeout(timer); abort?.abort(); off(); container.replaceChildren(); } };
}
