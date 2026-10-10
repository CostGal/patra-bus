// "Επόμενο λεωφορείο κοντά σου" (owner: location). Contract in docs/ARCHITECTURE.md; styles in css/nearby.css (.nb-*).
// Pure logic first (pickStops, computeDepartures, pickHero: unit-tested), then the card.
import { h, icon, lineBadge, fmtClock } from './ui.js';
import { titleCase } from './text.js';
import { fetchLive, remainingSec } from './api.js';
import { etaText, etaSpoken, ageText } from './arrivals.js';
import { getSettings, onChange } from './store.js';
import { haversine, nearestStops, fmtDist, inArea } from './geo.js';
import { walkRoute, walkEstimate, walkSpeed } from './walk.js';

export const RADIUS_M = 500; // stops considered "near"
export const FAR_RADIUS_M = 1500; // fallback when nothing is within RADIUS_M
export const MAX_STOPS = 4; // listed / highlighted on the map
export const LIVE_STOPS = 3; // of those, how many we fetch live data for
const ROUTE_WORTH_M = 80; // a stop that adds a new route is worth this many extra metres of walking
const GONE_SEC = 30; // a vehicle this far past its ETA has left
const ROWS_PER_STOP = 3;
const REFRESH_MS = 20000; // live refresh while visible (api.js enforces the 15 s floor per stop)
const MOVE_M = 50; // recompute when the fix moved more than this
const RECOMPUTE_GAP_MS = 8000;
const MAX_ACC_M = 1500; // coarser fixes are not used to pick stops
const LOW_ACC_M = 200;

// ---------- pure logic ----------

// Up to `max` stops within `radius`, nearest first, then greedily the ones that add the most distinct routes
// (the opposite side of the road, another line) per extra metre walked. Nothing near: widen to farRadius.
export function pickStops(stops, p, { radius = RADIUS_M, farRadius = FAR_RADIUS_M, max = MAX_STOPS } = {}) {
  let cand = nearestStops(stops, p, { limit: 16, maxMeters: radius });
  let far = false;
  if (!cand.length) { cand = nearestStops(stops, p, { limit: 8, maxMeters: farRadius }); far = cand.length > 0; }
  if (!cand.length) return { stops: [], far: false };
  const chosen = [cand[0]];
  const covered = new Set(cand[0].stop.routeCodes || []);
  while (chosen.length < max) {
    let best = null, bestScore = 0;
    for (const c of cand) {
      if (chosen.includes(c)) continue;
      const fresh = (c.stop.routeCodes || []).filter((r) => !covered.has(r)).length;
      if (!fresh) continue;
      const score = fresh * ROUTE_WORTH_M - (c.meters - cand[0].meters);
      if (score > bestScore) { bestScore = score; best = c; }
    }
    if (!best) break;
    chosen.push(best);
    for (const r of best.stop.routeCodes || []) covered.add(r);
  }
  return { stops: chosen, far };
}

// state: { vehicles, fetchedAt }. Every departure gets remaining / walk / leave-in and a verdict:
//   leaveInSec = remaining − walkSec − bufferSec;  'ok' (leaveIn ≥ 0) · 'tight' (arrive before it, no margin) · 'missed'.
export function computeDepartures(state, { now = Date.now(), walkSec = 0, bufferSec = 120 } = {}) {
  if (!state || !state.vehicles) return [];
  const out = [];
  state.vehicles.forEach((v, i) => {
    if ((now - state.fetchedAt) / 1000 - v.etaSec > GONE_SEC) return; // already left
    const remaining = remainingSec(v, state.fetchedAt, now);
    const leaveInSec = remaining - walkSec - bufferSec;
    const verdict = leaveInSec >= 0 ? 'ok' : remaining - walkSec >= 0 ? 'tight' : 'missed';
    const id = v.live ? (v.vehicleCode ?? `i${i}`) : Math.round((state.fetchedAt + v.etaSec * 1000) / 60000);
    out.push({ v, key: `${v.routeCode}|${v.live ? 'L' : 'S'}|${id}`, remaining, walkSec, leaveInSec, verdict, catchable: verdict !== 'missed', live: !!v.live, fetchedAt: state.fetchedAt });
  });
  out.sort((a, b) => a.remaining - b.remaining || (b.live - a.live));
  return out;
}

// states: [{ departures, ... }] → what the hero shows.
//   'catch'  the earliest departure you can still make (+ an earlier one you can't, for context)
//   'missed' departures exist but none can be made: the earliest, and the one after it
//   'none'   nothing to show
export function pickHero(states) {
  const all = states.flatMap((s) => (s.departures || []).map((d) => ({ ...d, s })));
  all.sort((a, b) => a.remaining - b.remaining || (b.live - a.live) || (a.s.meters - b.s.meters));
  const first = all.find((d) => d.catchable);
  if (first) return { kind: 'catch', dep: first, earlierMissed: all.find((d) => !d.catchable && d.remaining < first.remaining) || null, next: null };
  if (all.length) return { kind: 'missed', dep: all[0], earlierMissed: null, next: all[1] || null };
  return { kind: 'none', dep: null, earlierMissed: null, next: null };
}

// "Φύγε σε 3′" / "Φύγε τώρα" / … : { cat: 'go'|'now'|'tight'|'missed', text, spoken }
export function actionFor(dep, next) {
  const mins = (sec) => Math.max(1, Math.floor(sec / 60));
  if (dep.verdict === 'ok') {
    if (dep.leaveInSec >= 60) { const m = mins(dep.leaveInSec); return { cat: 'go', text: `Φύγε σε ${m}′`, spoken: `Φύγε σε ${m === 1 ? 'ένα λεπτό' : `${m} λεπτά`}` }; }
    return { cat: 'now', text: 'Φύγε τώρα', spoken: 'Φύγε τώρα' };
  }
  if (dep.verdict === 'tight') {
    const t = dep.walkSec < 60 ? 'Πήγαινε στη στάση τώρα' : 'Φύγε τώρα — στο όριο';
    return { cat: 'tight', text: t, spoken: t };
  }
  const tail = next ? ` — επόμενο σε ${etaText(next.remaining)}` : ' — δεν υπάρχει άλλο προσεχώς';
  return { cat: 'missed', text: `Δεν το προλαβαίνεις${tail}`, spoken: `Δεν το προλαβαίνεις${next ? `. Επόμενο σε ${etaSpoken(next.remaining)}` : '. Δεν υπάρχει άλλο προσεχώς'}` };
}

const bufferOf = () => { try { const m = Number(getSettings().bufferMin); return (Number.isFinite(m) && m >= 0 ? m : 2) * 60; } catch { return 120; } };
const walkSecOf = (s) => s.walkMeters / walkSpeed();

function makeState(stop, meters, live, fix) {
  return { stop, meters, live, vehicles: null, fetchedAt: 0, noService: false, error: null, walkMeters: walkEstimate(fix, stop).meters, walkSource: 'estimate', walkGeom: null, departures: [] };
}
async function loadLive(s, signal) {
  try {
    const r = await fetchLive(s.stop.code, { signal });
    s.vehicles = r.vehicles; s.fetchedAt = r.fetchedAt; s.noService = !!r.noService; s.error = null;
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    s.error = e || new Error('live');
  }
}
async function loadWalk(s, fix, signal) {
  const r = await walkRoute(fix, s.stop, { signal });
  s.walkMeters = r.meters; s.walkSource = r.source; s.walkGeom = r.geometry;
}

// One-shot: stops near `fix` with live departures and walking times (OSRM, or the estimate on failure).
// → NearbyStop[] sorted by distance: { stop, meters, live, vehicles, fetchedAt, noService, error, walkMeters, walkSource,
//   walkGeom, walkSec, far, departures: [{ v, key, remaining, walkSec, leaveInSec, verdict, catchable, live, fetchedAt }] }
export async function findNextBuses(ctx, fix, { signal, walk = 'route', now = Date.now() } = {}) {
  const { stops: picked, far } = pickStops((ctx.data && ctx.data.stops) || [], fix);
  const states = picked.map((c, i) => makeState(c.stop, c.meters, i < LIVE_STOPS, fix));
  await Promise.all(states.filter((s) => s.live).map((s) => Promise.all([loadLive(s, signal), walk === 'route' ? loadWalk(s, fix, signal) : null])));
  const bufferSec = bufferOf();
  for (const s of states) {
    s.far = far;
    s.walkSec = walkSecOf(s);
    s.departures = computeDepartures(s, { now, walkSec: s.walkSec, bufferSec });
  }
  return states.sort((a, b) => a.meters - b.meters);
}

// ---------- the card ----------

const mapDo = (ctx, fn) => { try { fn(ctx.map); } catch { /* map not ready / absent */ } };
const hashFor = (code) => `#/stop/${encodeURIComponent(code)}`;
const minText = (sec) => `${Math.max(1, Math.round(sec / 60))}′`;
const isIOS = () => /iP(hone|ad|od)/.test(globalThis.navigator?.userAgent || '');

// Fallback tile when arrivals-view.js has no arrivalTile: same shape (.tick), own markup.
function miniTile(v, fetchedAt, { now = Date.now(), line } = {}) {
  const at = fetchedAt + v.etaSec * 1000;
  const num = h('span', { class: 'nb-mini-num' });
  const el = h('div', { class: `nb-mini ${v.live ? 'nb-mini-live' : ''}` },
    lineBadge({ code: v.lineCode, color: line?.color || v.color, textColor: line?.textColor || v.textColor }),
    h('span', { class: 'nb-mini-dest' }, titleCase(v.routeName)),
    h('span', { class: `nb-flag ${v.live ? 'nb-flag-live' : ''}` }, v.live ? 'LIVE' : 'ΠΡΟΓΡ.', ' ', fmtClock(at)),
    num);
  el.tick = (t = Date.now()) => { num.textContent = etaText(remainingSec(v, fetchedAt, t)); };
  el.tick(now);
  return el;
}

export function mountNearby(container, ctx) {
  const loc = ctx.location;
  const st = {
    fix: loc.current, status: loc.status, anchor: null, states: [], far: false, fitted: false,
    lastRecompute: 0, lastRefreshAt: 0, mode: null, heroKey: null, srKey: null, markersKey: null, overlayKey: null,
  };
  let dead = false, tickTimer = null, refreshTimer = null, recomputeTimer = null, walkCtl = null, tileFn = null;
  const titleId = `nb-t${Math.random().toString(36).slice(2, 7)}`;
  const body = h('div', { class: 'nb-body' });
  const sr = h('div', { class: 'nb-sr', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const root = h('section', { class: 'nb', 'aria-labelledby': titleId }, sr, body);
  container.replaceChildren(root);

  // arrivals-view.js is optional; the card works (with its own rows) if it is missing.
  import('./arrivals-view.js').then((m) => { if (!dead && typeof m.arrivalTile === 'function') { tileFn = m.arrivalTile; rebuildGroups(); paint(); } }).catch(() => {});

  const lineOf = (code) => ctx.data && ctx.data.lineByCode && ctx.data.lineByCode.get(String(code));
  const tile = (v, fetchedAt, now) => (tileFn ? tileFn(v, fetchedAt, { compact: true, now, line: lineOf(v.lineCode) }) : miniTile(v, fetchedAt, { now, line: lineOf(v.lineCode) }));
  const go = (e, hash) => { if (e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; e.preventDefault(); ctx.navigate(hash); };
  const link = (cls, code, ...kids) => h('a', { class: cls, href: hashFor(code), onclick: (e) => go(e, hashFor(code)) }, ...kids);
  const btn = (cls, label, fn, ...kids) => h('button', { type: 'button', class: `nb-btn ${cls}`, onclick: fn }, ...(kids.length ? kids : [label]));

  // ----- location → stops -----
  const useGpsNow = () => { try { loc.start(); } catch { /* ignore */ } };
  const pinMapCentre = () => {
    let c = null;
    try { c = ctx.map.getCenter(); } catch { /* ignore */ }
    if (c) loc.setManual(c);
  };

  function usable(fix) { return !!fix && (fix.source === 'manual' || !(fix.accuracy > MAX_ACC_M)); }

  function onLoc(fix, status) {
    if (dead) return;
    st.status = status; st.fix = fix;
    if (!usable(fix)) { if (!fix) clearResults(); paint(); return; }
    const a = st.anchor;
    const thr = Math.min(100, Math.max(MOVE_M, (fix.accuracy || 0) / 2));
    if (!a || a.source !== fix.source || haversine(a, fix) > thr) schedule(!a || a.source !== fix.source ? 0 : Math.max(0, st.lastRecompute + RECOMPUTE_GAP_MS - Date.now()));
    else paint();
  }
  function schedule(delay) {
    clearTimeout(recomputeTimer);
    recomputeTimer = delay > 0 ? setTimeout(recompute, delay) : null;
    if (delay <= 0) recompute();
  }
  function clearResults() {
    st.anchor = null; st.states = []; st.far = false;
    if (walkCtl) walkCtl.abort();
    clearTimeout(refreshTimer); clearTimeout(recomputeTimer);
    mapDo(ctx, (m) => { m.clearMarkers('nearby'); m.clearOverlay('nearby-walk'); });
    st.markersKey = st.overlayKey = null;
  }

  function recompute() {
    recomputeTimer = null;
    const fix = st.fix;
    if (dead || !usable(fix) || !(ctx.data && ctx.data.stops && ctx.data.stops.length)) { paint(); return; }
    st.lastRecompute = Date.now();
    st.anchor = fix;
    const { stops, far } = pickStops(ctx.data.stops, fix);
    st.far = far;
    const prev = new Map(st.states.map((s) => [s.stop.code, s]));
    st.states = stops.map((c, i) => {
      const s = makeState(c.stop, c.meters, i < LIVE_STOPS, fix);
      const old = prev.get(c.stop.code);
      if (old) { s.vehicles = old.vehicles; s.fetchedAt = old.fetchedAt; s.noService = old.noService; s.error = old.error; }
      return s;
    }).sort((a, b) => a.meters - b.meters);
    if (!st.fitted && st.states.length) {
      st.fitted = true;
      mapDo(ctx, (m) => m.fitTo([fix, ...st.states.map((s) => s.stop)], { maxZoom: 17 }));
    }
    paint();
    const fresh = st.states.filter((s) => s.live && !s.vehicles);
    if (fresh.length) refreshLive(fresh);
    scheduleRefresh();
    upgradeWalks(fix);
  }

  // Straight-line numbers show at once; OSRM results replace them as they arrive (≤ 1 request/s, cached).
  function upgradeWalks(fix) {
    if (walkCtl) walkCtl.abort();
    walkCtl = new AbortController();
    const signal = walkCtl.signal;
    for (const s of st.states.filter((x) => x.live)) {
      loadWalk(s, fix, signal).then(() => { if (!dead && !signal.aborted) paint(); }, () => {});
    }
  }

  async function refreshLive(targets) {
    const list = targets || st.states.filter((s) => s.live);
    if (!list.length) return;
    await Promise.all(list.map((s) => loadLive(s).catch(() => {})));
    if (dead) return;
    st.lastRefreshAt = Date.now();
    paint();
  }
  function scheduleRefresh() {
    clearTimeout(refreshTimer); refreshTimer = null;
    if (dead || document.hidden || !st.states.length) return;
    refreshTimer = setTimeout(async () => { await refreshLive(); scheduleRefresh(); }, REFRESH_MS);
  }
  const manualRefresh = () => { refreshLive().then(scheduleRefresh); };

  // ----- rendering -----
  function setMode(mode) {
    if (mode === st.mode) return;
    st.mode = mode; st.heroKey = null; st.srKey = null; groups.clear();
    body.replaceChildren(...buildMode(mode));
    body.dataset.mode = mode;
    root.setAttribute('aria-busy', mode === 'locating' ? 'true' : 'false');
  }
  function modeNow() {
    if (!(ctx.data && ctx.data.stops && ctx.data.stops.length)) return 'loading';
    if (usable(st.fix)) return st.anchor ? (st.states.length ? 'results' : 'outside') : 'locating';
    if (st.fix) return 'coarse';
    switch (st.status) {
      case 'denied': return 'denied';
      case 'insecure': return 'insecure';
      case 'unavailable': case 'timeout': return 'retry';
      case 'locating': return 'locating';
      default: return 'cta';
    }
  }

  const title = (extra) => h('div', { class: 'nb-head' }, h('h2', { class: 'nb-title', id: titleId }, 'Επόμενο λεωφορείο κοντά σου'), extra);
  const manualBtn = (label = 'Όρισε θέση στον χάρτη') => btn('nb-btn-ghost', label, pinMapCentre, icon('pin'), label);
  const hint = (t) => h('p', { class: 'nb-hint' }, t);
  const panel = (cls, ...kids) => h('div', { class: `nb-panel ${cls || ''}` }, ...kids);

  function buildMode(mode) {
    switch (mode) {
      case 'loading':
        return [title(), panel('', h('p', { class: 'nb-text' }, 'Φόρτωση στάσεων…'))];
      case 'cta':
        return [title(), panel('nb-cta',
          h('span', { class: 'nb-ico nb-ico-accent' }, icon('locate')),
          h('p', { class: 'nb-text' }, 'Δες ποιο λεωφορείο περνά από την κοντινότερη στάση και πότε πρέπει να φύγεις.'),
          btn('nb-btn-primary', 'Βρες τη στάση μου', useGpsNow, icon('locate'), 'Βρες τη στάση μου'),
          manualBtn(),
          hint('Η θέση σου δεν αποθηκεύεται. Χρησιμοποιείται μόνο για να βρούμε στάσεις και τη διαδρομή με τα πόδια.'))];
      case 'locating':
        return [title(), panel('nb-cta', h('span', { class: 'nb-spinner', 'aria-hidden': 'true' }),
          h('p', { class: 'nb-text', role: 'status' }, 'Εντοπισμός θέσης…'), manualBtn())];
      case 'coarse':
        return [title(), panel('nb-cta', h('span', { class: 'nb-spinner', 'aria-hidden': 'true' }),
          h('p', { class: 'nb-text', role: 'status' }, `Αναμονή για πιο ακριβή θέση (τώρα ±${fmtDist(st.fix.accuracy)})…`), manualBtn())];
      case 'denied':
        return [title(), panel('nb-warn',
          h('p', { class: 'nb-text nb-strong' }, 'Η πρόσβαση στην τοποθεσία είναι απενεργοποιημένη'),
          h('p', { class: 'nb-text' }, isIOS()
            ? 'Άνοιξε Ρυθμίσεις → Απόρρητο και ασφάλεια → Υπηρεσίες τοποθεσίας → Safari (ή την εφαρμογή) και επίλεξε «Όταν χρησιμοποιείται».'
            : 'Πάτα το εικονίδιο δίπλα στη διεύθυνση (κλειδαριά ή ρυθμίσεις) → Άδειες → Τοποθεσία → Να επιτρέπεται, και μετά «Δοκίμασε ξανά».'),
          btn('nb-btn-primary', 'Δοκίμασε ξανά', useGpsNow, 'Δοκίμασε ξανά'),
          manualBtn(),
          hint('Μετακίνησε τον χάρτη στο σημείο όπου βρίσκεσαι και πάτα «Όρισε θέση στον χάρτη».'))];
      case 'insecure':
        return [title(), panel('nb-warn',
          h('p', { class: 'nb-text nb-strong' }, 'Η τοποθεσία δεν λειτουργεί σε μη ασφαλή σύνδεση'),
          h('p', { class: 'nb-text' }, 'Άνοιξε την εφαρμογή μέσω https:// για να βρούμε τη στάση σου. Στο μεταξύ μπορείς να ορίσεις θέση στον χάρτη.'),
          manualBtn())];
      case 'retry':
        return [title(), panel('nb-warn',
          h('p', { class: 'nb-text nb-strong' }, st.status === 'timeout' ? 'Ο εντοπισμός αργεί' : 'Δεν βρέθηκε η θέση σου'),
          h('p', { class: 'nb-text' }, 'Δοκίμασε ξανά ή βγες σε ανοιχτό χώρο. Μπορείς επίσης να ορίσεις θέση στον χάρτη.'),
          btn('nb-btn-primary', 'Δοκίμασε ξανά', useGpsNow, 'Δοκίμασε ξανά'), manualBtn())];
      case 'outside': {
        const near = nearestStops(ctx.data.stops, st.fix, { limit: 1 })[0];
        return [title(), panel('nb-warn',
          h('p', { class: 'nb-text nb-strong' }, 'Δεν βρέθηκαν στάσεις κοντά σου'),
          h('p', { class: 'nb-text' }, `${near ? `Η πιο κοντινή στάση είναι σε ${fmtDist(near.meters)}. ` : ''}${inArea(st.fix) ? '' : 'Φαίνεται ότι είσαι εκτός Πάτρας. '}Η εφαρμογή καλύπτει τα αστικά της Πάτρας.`),
          manualBtn('Όρισε άλλη θέση στον χάρτη'))];
      }
      case 'results':
        return buildResults();
      default:
        return [];
    }
  }

  // results skeleton: refs updated in place by paint()
  const refs = {};
  function buildResults() {
    refs.noticeSig = null;
    refs.updated = h('span', { class: 'nb-updated' });
    refs.refresh = btn('nb-icon-btn', '', manualRefresh, icon('refresh'));
    refs.refresh.setAttribute('aria-label', 'Ανανέωση αφίξεων');
    refs.notice = h('div', { class: 'nb-notices' });
    refs.hero = h('div', { class: 'nb-hero-slot' });
    refs.groups = h('div', { class: 'nb-groups' });
    refs.foot = h('p', { class: 'nb-foot' });
    return [title(h('div', { class: 'nb-head-r' }, refs.updated, refs.refresh)), refs.notice, refs.hero, refs.groups, refs.foot];
  }

  // ----- hero -----
  function buildHero(m) {
    const r = { m };
    if (m.kind === 'none') {
      const noSvc = st.states.some((s) => s.live) && st.states.filter((s) => s.live).every((s) => s.noService || (s.vehicles && !s.vehicles.length));
      const loading = st.states.some((s) => s.live && !s.vehicles && !s.error);
      const failed = st.states.filter((s) => s.live).every((s) => s.error && !s.vehicles);
      r.el = h('div', { class: 'nb-hero nb-hero-none' },
        h('p', { class: 'nb-hero-msg' }, loading ? 'Φόρτωση αφίξεων…' : failed ? 'Δεν φορτώθηκαν οι αφίξεις' : noSvc ? 'Δεν υπάρχει εξυπηρέτηση αυτή την ώρα' : 'Δεν υπάρχουν προσεχή δρομολόγια στις κοντινές στάσεις'),
        failed && !loading ? btn('nb-btn-ghost', 'Δοκίμασε ξανά', manualRefresh, 'Δοκίμασε ξανά') : null);
      if (loading) r.el.setAttribute('aria-busy', 'true');
      return r;
    }
    const d = m.dep, v = d.v, line = lineOf(v.lineCode);
    const stopLine = h('div', { class: 'nb-hero-stop' }, icon('walk'), link('nb-hero-stoplink', d.s.stop.code, h('span', { class: 'nb-stopname' }, d.s.stop.displayName || titleCase(d.s.stop.name)), icon('chevron')));
    r.walk = h('span', { class: 'nb-walk' });
    stopLine.append(r.walk);
    r.in = h('span', { class: 'nb-hero-in' }, 'σε');
    r.num = h('span', { class: 'nb-hero-num' });
    r.act = h('div', { class: 'nb-action' });
    r.note = h('div', { class: 'nb-note' });
    r.el = h('div', { class: `nb-hero nb-hero-${m.kind} ${v.live ? 'nb-hero-live' : 'nb-hero-sched'}` },
      h('div', { class: 'nb-hero-main' },
        h('div', { class: 'nb-hero-badge' }, lineBadge({ code: v.lineCode, color: line?.color || v.color, textColor: line?.textColor || v.textColor })),
        h('div', { class: 'nb-hero-mid' },
          h('div', { class: 'nb-hero-dest' }, titleCase(v.routeName)),
          h('div', { class: 'nb-hero-flags' },
            v.live ? h('span', { class: 'nb-flag nb-flag-live' }, h('span', { class: 'nb-dot', 'aria-hidden': 'true' }), 'LIVE')
              : h('span', { class: 'nb-flag' }, icon('clock'), 'ΠΡΟΓΡ.'),
            h('span', { class: 'nb-clock' }, v.live ? `≈ ${fmtClock(d.fetchedAt + v.etaSec * 1000)}` : fmtClock(d.fetchedAt + v.etaSec * 1000)))),
        h('div', { class: 'nb-hero-eta' }, r.in, r.num)),
      stopLine, r.act, r.note);
    return r;
  }
  function updateHero(r, m, now) {
    const d = m.dep;
    if (!d) return;
    const eta = etaText(d.remaining);
    r.num.textContent = eta;
    r.in.hidden = eta === 'τώρα';
    r.el.classList.toggle('nb-hero-now', d.remaining < 15);
    const act = actionFor(d, m.next);
    r.act.className = `nb-action nb-act-${act.cat}`;
    if (r.act.textContent !== act.text) r.act.textContent = act.text;
    const w = `${walkLabel(d.s)}`;
    if (r.walk.textContent !== w) r.walk.textContent = w;
    const note = m.earlierMissed ? `Το ${m.earlierMissed.v.lineCode} σε ${etaText(m.earlierMissed.remaining)} φεύγει πριν φτάσεις στη στάση.` : staleNote(d.s, now);
    if (r.note.textContent !== note) r.note.textContent = note;
    r.note.hidden = !note;
    return act;
  }
  const staleNote = (s, now) => (s.error && s.vehicles ? `Παλιά δεδομένα · πριν ${ageText((now - s.fetchedAt) / 1000)}` : (now - s.fetchedAt > 60000 && s.vehicles ? `Τελευταία ενημέρωση πριν ${ageText((now - s.fetchedAt) / 1000)}` : ''));
  function walkLabel(s) {
    const m = s.walkSource === 'osrm' ? s.walkMeters : s.meters;
    return m < 40 ? ' · Είσαι στη στάση' : ` · ${fmtDist(m)} · ${minText(walkSecOf(s))} με τα πόδια`;
  }

  // ----- per-stop groups -----
  const groups = new Map(); // stop code → { el, head refs, list, rows: Map(key → row) }
  function rebuildGroups() { groups.clear(); if (refs.groups) refs.groups.replaceChildren(); }

  function makeGroup(s) {
    const g = { s, rows: new Map(), tiles: [] };
    g.meta = h('span', { class: 'nb-stop-meta' });
    g.list = h('ul', { class: 'nb-rows' });
    g.msg = h('p', { class: 'nb-stop-msg' });
    g.el = h('section', { class: 'nb-stop', 'aria-label': `Στάση ${s.stop.displayName || s.stop.name}` },
      h('div', { class: 'nb-stop-head' },
        link('nb-stop-name', s.stop.code, s.stop.displayName || titleCase(s.stop.name), icon('chevron')), g.meta),
      g.msg, g.list);
    return g;
  }
  function updateGroup(g, s, now) {
    g.s = s;
    g.meta.textContent = s.walkMeters < 40 ? 'Είσαι εδώ' : `${fmtDist(s.walkSource === 'osrm' ? s.walkMeters : s.meters)} · ${minText(walkSecOf(s))}`;
    g.meta.title = 'Απόσταση και χρόνος με τα πόδια';
    const deps = s.departures.slice(0, ROWS_PER_STOP);
    const msg = !s.live ? 'Δες τις αφίξεις'
      : !s.vehicles ? (s.error ? 'Δεν φορτώθηκαν οι αφίξεις' : 'Φόρτωση…')
        : !s.departures.length ? (s.noService ? 'Δεν υπάρχει εξυπηρέτηση αυτή την ώρα' : 'Καμία προσεχής άφιξη') : '';
    if (g.msg.textContent !== msg) g.msg.textContent = msg;
    g.msg.hidden = !msg;
    // keyed rows: an <a> row keeps focus and clicks across refreshes; only its tile is swapped
    const keep = new Set(deps.map((d) => d.key));
    for (const [k, row] of g.rows) if (!keep.has(k)) { row.el.remove(); g.rows.delete(k); }
    deps.forEach((d, i) => {
      let row = g.rows.get(d.key);
      if (!row) {
        row = { dep: null, slot: h('div', { class: 'nb-tile' }), leave: h('div', { class: 'nb-leave' }) };
        row.el = h('li', { class: 'nb-row' }, link('nb-row-link', s.stop.code, row.slot, row.leave));
        g.rows.set(d.key, row);
      }
      if (!row.dep || row.dep.fetchedAt !== d.fetchedAt || row.dep.v.etaSec !== d.v.etaSec || row.tileFn !== tileFn) {
        row.tile = tile(d.v, d.fetchedAt, now); row.tileFn = tileFn;
        row.slot.replaceChildren(row.tile);
      }
      row.dep = d;
      row.tile.tick(now);
      const l = leaveText(d);
      if (row.leave.textContent !== l.text) row.leave.textContent = l.text;
      row.leave.className = `nb-leave nb-leave-${l.cat}`;
      if (g.list.children[i] !== row.el) g.list.insertBefore(row.el, g.list.children[i] || null);
    });
  }
  const leaveText = (d) => {
    const a = actionFor(d, null);
    return a.cat === 'missed' ? { cat: 'missed', text: 'Δεν προλαβαίνεται' } : a.cat === 'tight' ? { cat: 'tight', text: 'Στο όριο' } : { cat: a.cat, text: a.text };
  };

  // ----- paint: cheap enough to run every second; touches text only when it changed -----
  function paint() {
    if (dead) return;
    const mode = modeNow();
    setMode(mode);
    if (mode !== 'results') {
      updateMap(null);
      // data arrived after the fix, or nothing computed yet
      if (usable(st.fix) && !st.anchor && !recomputeTimer && ctx.data && ctx.data.stops && ctx.data.stops.length) schedule(0);
      return;
    }
    const now = Date.now();
    const bufferSec = bufferOf();
    for (const s of st.states) {
      s.walkSec = walkSecOf(s);
      s.departures = s.live ? computeDepartures(s, { now, walkSec: s.walkSec, bufferSec }) : [];
    }
    // header
    const age = st.lastRefreshAt ? `Ενημερώθηκε πριν ${ageText((now - st.lastRefreshAt) / 1000)}` : 'Φόρτωση…';
    if (refs.updated.textContent !== age) refs.updated.textContent = age;
    paintNotices(now);
    // hero
    const m = pickHero(st.states);
    const key = `${m.kind}|${m.dep ? `${m.dep.s.stop.code}|${m.dep.key}` : ''}|${m.kind === 'none' ? st.states.map((s) => (s.vehicles ? 1 : 0) + (s.error ? 'e' : '') + (s.noService ? 'n' : '')).join('') : ''}`;
    if (key !== st.heroKey) { st.heroKey = key; refs.heroR = buildHero(m); refs.hero.replaceChildren(refs.heroR.el); }
    refs.heroR.m = m;
    const act = m.dep ? updateHero(refs.heroR, m, now) : null;
    announce(m, act);
    // groups
    const want = new Set(st.states.map((s) => s.stop.code));
    for (const [code, g] of groups) if (!want.has(code)) { g.el.remove(); groups.delete(code); }
    st.states.forEach((s, i) => {
      let g = groups.get(s.stop.code);
      if (!g) { g = makeGroup(s); groups.set(s.stop.code, g); }
      updateGroup(g, s, now);
      if (refs.groups.children[i] !== g.el) refs.groups.insertBefore(g.el, refs.groups.children[i] || null);
    });
    const bufMin = Math.round(bufferSec / 60);
    const foot = `Φύγε σε = άφιξη λεωφορείου − περπάτημα − περιθώριο ${bufMin}′ (Ρυθμίσεις). Ο χρόνος περπατήματος είναι εκτίμηση.`;
    if (refs.foot.textContent !== foot) refs.foot.textContent = foot;
    updateMap(m);
  }

  function paintNotices(now) {
    const f = st.fix, items = [];
    if (f && f.source === 'manual') {
      items.push(h('div', { class: 'nb-notice' }, icon('pin'), h('span', {}, 'Χειροκίνητη θέση'), btn('nb-btn-link', 'Χρήση GPS', useGpsNow, 'Χρήση GPS')));
    } else if (f) {
      if (f.accuracy > LOW_ACC_M) items.push(h('div', { class: 'nb-notice nb-notice-warn' }, icon('alert'), h('span', {}, `Χαμηλή ακρίβεια θέσης (±${fmtDist(f.accuracy)}). Οι στάσεις ίσως δεν είναι οι κοντινότερες.`)));
      else if (now - f.ts > 120000) items.push(h('div', { class: 'nb-notice nb-notice-warn' }, icon('alert'), h('span', {}, `Η θέση σου είναι από πριν ${ageText((now - f.ts) / 1000)}.`)));
    }
    if (st.far && st.states.length) items.push(h('div', { class: 'nb-notice' }, icon('info'), h('span', {}, `Η κοντινότερη στάση είναι σε ${fmtDist(st.states[0].meters)}.`)));
    const sig = items.map((n) => n.textContent).join('|');
    if (refs.noticeSig !== sig) { refs.noticeSig = sig; refs.notice.replaceChildren(...items); }
  }

  // Screen reader summary: only when the bus or the advice category changes, never per second.
  function announce(m, act) {
    const key = `${m.kind}|${m.dep ? m.dep.key : ''}|${act ? act.cat : ''}`;
    if (key === st.srKey) return;
    const first = st.srKey === null;
    st.srKey = key;
    if (first && !m.dep) return;
    if (!m.dep) { sr.textContent = 'Δεν υπάρχουν προσεχή δρομολόγια κοντά σου.'; return; }
    const d = m.dep, name = d.s.stop.displayName || d.s.stop.name;
    sr.textContent = `Γραμμή ${d.v.lineCode}, ${d.v.live ? 'ζωντανά' : 'προγραμματισμένο'}, ${d.remaining < 15 ? 'τώρα' : `σε ${etaSpoken(d.remaining)}`}, στάση ${name}, ${minText(d.walkSec)} με τα πόδια. ${act ? act.spoken : ''}.`;
  }

  function updateMap(m) {
    if (!m) {
      if (st.markersKey) { mapDo(ctx, (x) => { x.clearMarkers('nearby'); x.clearOverlay('nearby-walk'); }); st.markersKey = st.overlayKey = null; }
      return;
    }
    const heroCode = m.dep ? m.dep.s.stop.code : (st.states[0] && st.states[0].stop.code);
    const mk = `${st.states.map((s) => s.stop.code).join(',')}|${heroCode}`;
    if (mk !== st.markersKey) {
      st.markersKey = mk;
      mapDo(ctx, (x) => x.setMarkers('nearby', st.states.map((s) => ({
        lat: s.stop.lat, lng: s.stop.lng, kind: 'board', label: s.stop.code === heroCode ? (s.stop.displayName || s.stop.name) : undefined,
      }))));
    }
    const hs = st.states.find((s) => s.stop.code === heroCode);
    const ok = hs && hs.walkGeom && hs.walkGeom.length > 1;
    const ok2 = ok ? `${heroCode}|${hs.walkGeom.length}` : null;
    if (ok2 !== st.overlayKey) {
      st.overlayKey = ok2;
      mapDo(ctx, (x) => (ok
        ? x.setOverlay('nearby-walk', { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: hs.walkGeom } }] }, { kind: 'walk' })
        : x.clearOverlay('nearby-walk')));
    }
  }

  // ----- lifecycle -----
  function startTicker() { clearInterval(tickTimer); tickTimer = setInterval(paint, 1000); }
  function onVis() {
    if (dead) return;
    if (document.hidden) { clearTimeout(refreshTimer); refreshTimer = null; clearInterval(tickTimer); tickTimer = null; return; }
    startTicker();
    if (st.states.length && Date.now() - st.lastRefreshAt >= 15000) refreshLive().then(scheduleRefresh); else scheduleRefresh();
    paint();
  }
  document.addEventListener('visibilitychange', onVis);
  const offLoc = loc.subscribe(onLoc);
  const offStore = (() => { try { return onChange(() => { if (!dead) paint(); }); } catch { return () => {}; } })();

  paint();
  if (usable(st.fix)) schedule(0);
  if (!document.hidden) startTicker();
  if (typeof loc.autoStart === 'function' && !st.fix) Promise.resolve(loc.autoStart()).catch(() => {});

  return {
    destroy() {
      if (dead) return;
      dead = true;
      clearInterval(tickTimer); clearTimeout(refreshTimer); clearTimeout(recomputeTimer);
      if (walkCtl) walkCtl.abort();
      document.removeEventListener('visibilitychange', onVis);
      try { offLoc(); } catch { /* ignore */ }
      try { offStore(); } catch { /* ignore */ }
      mapDo(ctx, (m) => { m.clearMarkers('nearby'); m.clearOverlay('nearby-walk'); });
      container.replaceChildren();
    },
  };
}
