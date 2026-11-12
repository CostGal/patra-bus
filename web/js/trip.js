// Trip core (TEL-290): direct bus trips from A to B as plain data, no screen. Imports only ./geo.js (guard test).
import { haversine, nearestStops, inArea } from './geo.js';

// Hard limits of one plan; each one is enforced by a test in tests/trip.test.mjs.
export const LIMITS = {
  maxResults: 3, maxLiveStops: 5, maxOsrmLegs: 6,
  maxBoardStops: 3, maxAlightStops: 2, maxPerLine: 2,
  nearestBoard: 8, nearestAlight: 8,
  boardRadius: 800, alightRadius: 800, farRadius: 1500, // metres, straight line
  bufferSec: 120,          // spare time before the bus: fixed for the beta (docs/DECISIONS.md, 2026-11-12)
  lowConfidence: 0.7,      // routes.json stop order below this is shown as "estimated"
  walkOnlyMaxSec: 1200, walkOnlyFallbackSec: 2700,
};
const LEG_FALLBACK_SEC = 90; // bus seconds per stop when legSec is missing
const MAX_STALE_SEC = 20;    // a bus due "now" stays listed for a few seconds
const estWalkSec = (a, b) => (haversine(a, b) * 1.3) / 1.3; // straight ×1.3 at 1.3 m/s
const ROW_SOURCES = new Set(['live', 'scheduled']);

// Stop-order confidence of a route, 0..1. Missing or broken counts as 0 (estimated).
export const confOf = (route) => (Number.isFinite(route?.confidence) ? Math.min(1, Math.max(0, route.confidence)) : 0);

// ---------------------------------------------------------------- candidates

const posCache = new WeakMap();
// code → ascending indexes in route.stops (loop routes visit a stop twice).
export function positions(route) {
  let m = posCache.get(route);
  if (!m) {
    m = new Map();
    route.stops.forEach((c, i) => (m.get(c) || m.set(c, []).get(c)).push(i));
    posCache.set(route, m);
  }
  return m;
}

export function rideSecBetween(route, bi, ai) {
  let s = 0;
  for (let i = bi; i < ai; i++) s += route.legSec?.[i] ?? LEG_FALLBACK_SEC;
  return s;
}

// Best (board, alight) pair per route, pruned with straight-line walking estimates.
// A pair is valid only if the board stop comes before the alight stop in the route's order.
export function candidateTrips(data, from, to, opts = {}) {
  const o = { ...LIMITS, ...opts };
  const walk = o.walkEst || estWalkSec;
  const boards = nearestStops(data.stops, from, { limit: o.nearestBoard, maxMeters: o.boardRadius });
  const alights = nearestStops(data.stops, to, { limit: o.nearestAlight, maxMeters: o.alightRadius });
  if (!boards.length || !alights.length) return [];
  const direct = walk(from, to);
  const wTo = new Map(boards.map(({ stop }) => [stop.code, walk(from, stop)]));
  const wFrom = new Map(alights.map(({ stop }) => [stop.code, walk(stop, to)]));
  const best = new Map(); // routeCode → candidate
  for (const { stop: board } of boards) {
    for (const route of data.routesByStop.get(board.code) || []) {
      const bi = positions(route).get(board.code)?.[0];
      if (bi === undefined) continue;
      for (const { stop: alight } of alights) {
        const ai = positions(route).get(alight.code)?.find((i) => i > bi);
        if (ai === undefined) continue; // wrong direction (alight before board) or not served
        const walkToEst = wTo.get(board.code);
        const walkFromEst = wFrom.get(alight.code);
        if (walkToEst + walkFromEst >= direct) continue; // walking straight there is no worse
        const rideEst = rideSecBetween(route, bi, ai);
        const cost = walkToEst + rideEst + walkFromEst;
        const prev = best.get(route.code);
        if (!prev || cost < prev.cost) {
          best.set(route.code, { route, board, alight, bi, ai, nStops: ai - bi, walkToEst, walkFromEst, rideEst, cost, confidence: confOf(route) });
        }
      }
    }
  }
  return [...best.values()].sort((a, b) => a.cost - b.cost);
}

// Greedy shortlist honouring the live-fetch budget (distinct board/alight stops) and ≤ N per line.
export function shortlist(cands, opts = {}) {
  const o = { ...LIMITS, ...opts };
  const boards = new Set(), alights = new Set(), perLine = new Map(), out = [];
  for (const c of cands) {
    if (out.length >= o.maxResults) break;
    if ((perLine.get(c.route.lineCode) || 0) >= o.maxPerLine) continue;
    if (!boards.has(c.board.code) && boards.size >= o.maxBoardStops) continue;
    if (!alights.has(c.alight.code) && alights.size >= o.maxAlightStops) continue;
    boards.add(c.board.code); alights.add(c.alight.code);
    perLine.set(c.route.lineCode, (perLine.get(c.route.lineCode) || 0) + 1);
    out.push(c);
  }
  return out;
}

// ---------------------------------------------------------------- departures

// Vehicles of `route` at one stop, from a LiveResult. Absolute departAt = fetchedAt + etaSec.
// Each entry carries source 'live' | 'scheduled'; coordinates only for a live bus, never 0/0. null → live fetch failed.
export function departuresAt(route, res) {
  if (!res || !Array.isArray(res.vehicles)) return null;
  const byKey = new Map();
  let anon = 0;
  for (const v of res.vehicles) {
    if (String(v.routeCode) !== String(route.code) || !Number.isFinite(v.etaSec)) continue;
    const live = !!v.live;
    const hasPos = live && Number.isFinite(v.lat) && Number.isFinite(v.lng) && !(v.lat === 0 && v.lng === 0);
    const d = {
      vehicleCode: v.vehicleCode != null ? String(v.vehicleCode) : null, live, source: live ? 'live' : 'scheduled',
      etaSec: v.etaSec, fetchedAt: res.fetchedAt, departAt: res.fetchedAt + v.etaSec * 1000,
      lat: hasPos ? v.lat : undefined, lng: hasPos ? v.lng : undefined,
    };
    d.key = d.vehicleCode ? d.vehicleCode : `${live ? 'l' : 's'}:${Math.round(d.departAt / 60000)}:${anon++}`;
    const prev = byKey.get(d.key);
    if (!prev || (live && !prev.live)) byKey.set(d.key, d);
  }
  return [...byKey.values()].sort((a, b) => a.departAt - b.departAt);
}

// Which vehicle to catch. `deps` sorted by departAt.
//  chosen: first vehicle with remaining ≥ walk + buffer (leaveInSec ≥ 0); if none, the first one still
//          reachable by hurrying (leaveInSec < 0, status 'run'). `prefer` (key) keeps a bus you are about to
//          miss on screen instead of jumping to the next one.
//  missed: the soonest vehicle if it can no longer be reached (remaining < walk).
//  next:   the catchable vehicle after `chosen`.
export function chooseDeparture(deps, { walkSec, bufferSec = LIMITS.bufferSec, now = Date.now(), prefer = null } = {}) {
  const list = (deps || []).map((dep) => {
    const remainingSec = (dep.departAt - now) / 1000;
    const slackSec = remainingSec - walkSec;
    return { dep, remainingSec, slackSec, leaveInSec: slackSec - bufferSec };
  }).filter((x) => x.remainingSec > -MAX_STALE_SEC);
  const out = { chosen: null, missed: null, next: null };
  if (!list.length) return out;
  let chosen = list.find((x) => x.slackSec >= bufferSec) || null;
  const sticky = prefer ? list.find((x) => x.dep.key === prefer && x.slackSec >= 0 && x.slackSec < bufferSec) : null;
  if (sticky && (!chosen || sticky.dep.departAt < chosen.dep.departAt)) chosen = sticky;
  if (!chosen) chosen = list.find((x) => x.slackSec >= 0) || null;
  if (list[0].slackSec < 0 && list[0] !== chosen) out.missed = list[0];
  if (chosen) {
    out.chosen = chosen;
    out.next = list.find((x) => x.dep.departAt > chosen.dep.departAt && x.slackSec >= bufferSec) || null;
  }
  return out;
}

// Ride time: the same vehicle listed at both stops gives the exact difference (and confirms direction).
export function rideFor(dep, alightDeps, estSec) {
  if (dep.vehicleCode && alightDeps) {
    const m = alightDeps.find((x) => x.vehicleCode === dep.vehicleCode);
    if (m) {
      const d = (m.departAt - dep.departAt) / 1000;
      if (d >= 30 && d >= estSec * 0.35 && d <= estSec * 3 + 180) return { rideSec: d, rideSource: 'live-match' };
    }
  }
  return { rideSec: estSec, rideSource: 'estimate' };
}

// ---------------------------------------------------------------- itineraries

const place = (p, stop = null) => ({ lat: p.lat, lng: p.lng, name: stop ? stop.displayName || stop.name || null : p.name ?? null, stopCode: stop ? stop.code : null });
const stopInfo = (s) => ({ code: s.code, name: s.name, displayName: s.displayName, lat: s.lat, lng: s.lng });
const walkLegOf = (w, from, to) => ({
  kind: 'walk', from, to, seconds: w.seconds, meters: w.meters, geometry: w.geometry ?? null,
  source: w.source === 'osrm' ? 'osrm' : 'estimate', startAt: null, endAt: null,
});
const busLegOf = (it) => it.legs.find((l) => l.kind === 'bus');

// One direct itinerary (walk → bus → walk) from a candidate and its live answers. from/to are the trip's two ends.
export function buildDirect(cand, { boardRes, alightRes, walkTo, walkFrom, from, to, bufferSec = LIMITS.bufferSec, now = Date.now(), prefer = null }) {
  const departures = departuresAt(cand.route, boardRes);
  const alightDeps = departuresAt(cand.route, alightRes);
  for (const d of departures || []) Object.assign(d, rideFor(d, alightDeps, cand.rideEst));
  const confidence = cand.confidence ?? confOf(cand.route);
  const bus = {
    kind: 'bus', lineCode: cand.route.lineCode, routeCode: cand.route.code, routeName: cand.route.displayName || cand.route.name || '',
    board: stopInfo(cand.board), alight: stopInfo(cand.alight), boardIndex: cand.bi, alightIndex: cand.ai, nStops: cand.nStops,
    departAt: null, departSource: null, arriveAt: null, arriveSource: 'estimated', rideSec: cand.rideEst, rideEstSec: cand.rideEst, rideSource: 'estimate',
    key: null, vehicleCode: null, vehicle: null, fetchedAt: null,
    confidence, orderEstimated: confidence < LIMITS.lowConfidence, departures: departures || [],
  };
  const it = {
    id: `${cand.route.code}:${cand.board.code}:${cand.alight.code}`, kind: 'direct', transfers: 0,
    legs: [walkLegOf(walkTo, place(from), place(cand.board, cand.board)), bus, walkLegOf(walkFrom, place(cand.alight, cand.alight), place(to))],
    status: 'none', leaveAt: null, leaveInSec: null, leaveSource: null, arriveAt: null, arriveSource: 'estimated',
    confidence, estimated: confidence < LIMITS.lowConfidence, liveError: departures === null,
    next: null, missed: null, transfer: null, bufferSec,
  };
  return retime(it, now, prefer);
}

// Re-choose the bus and refresh every time for `now`. No network: reads only it.legs[*].departures.
export function retime(it, now = Date.now(), prefer = busLegOf(it)?.key ?? null) {
  if (it.kind === 'walk') return it;
  const walk0 = it.legs[0], walkN = it.legs[it.legs.length - 1], bus = busLegOf(it);
  const walkSec = walk0.seconds, walkFromSec = walkN.seconds;
  const d = chooseDeparture(bus.departures, { walkSec, bufferSec: it.bufferSec, now, prefer });
  const arriveOf = (dep) => dep.departAt + ((dep.rideSec ?? bus.rideEstSec) + walkFromSec) * 1000;
  it.missed = d.missed ? { departAt: d.missed.dep.departAt, source: d.missed.dep.source, needSec: walkSec } : null;
  it.next = d.next ? {
    departAt: d.next.dep.departAt, source: d.next.dep.source,
    leaveInSec: ROW_SOURCES.has(d.next.dep.source) ? d.next.leaveInSec : null, arriveAt: arriveOf(d.next.dep),
  } : null;
  if (!d.chosen) {
    Object.assign(bus, { departAt: null, departSource: null, arriveAt: null, arriveSource: 'estimated', rideSec: bus.rideEstSec, rideSource: 'estimate', key: null, vehicleCode: null, vehicle: null, fetchedAt: null });
    Object.assign(it, { status: 'none', leaveAt: null, leaveInSec: null, leaveSource: null, arriveAt: null, arriveSource: 'estimated' });
    walk0.startAt = walk0.endAt = walkN.startAt = walkN.endAt = null;
    it.estimated = it.confidence < LIMITS.lowConfidence;
    return it;
  }
  const dep = d.chosen.dep;
  const hasPos = dep.live && Number.isFinite(dep.lat) && Number.isFinite(dep.lng);
  Object.assign(bus, {
    departAt: dep.departAt, departSource: dep.source, rideSec: dep.rideSec ?? bus.rideEstSec, rideSource: dep.rideSource || 'estimate',
    key: dep.key, vehicleCode: dep.vehicleCode, vehicle: hasPos ? { lat: dep.lat, lng: dep.lng } : null, fetchedAt: dep.fetchedAt,
  });
  bus.arriveAt = bus.departAt + bus.rideSec * 1000;
  bus.arriveSource = dep.live && bus.rideSource === 'live-match' ? 'live' : 'estimated';
  const leaveSource = ROW_SOURCES.has(dep.source) ? dep.source : null;
  const leaveAt = dep.departAt - (walkSec + it.bufferSec) * 1000;
  Object.assign(it, {
    leaveAt, leaveSource, leaveInSec: leaveSource ? (leaveAt - now) / 1000 : null,
    arriveAt: bus.arriveAt + walkFromSec * 1000, arriveSource: bus.arriveSource,
    status: leaveAt < now ? 'run' : 'ok',
  });
  walk0.startAt = leaveAt; walk0.endAt = leaveAt + walkSec * 1000;
  walkN.startAt = bus.arriveAt; walkN.endAt = it.arriveAt;
  it.estimated = it.confidence < LIMITS.lowConfidence || bus.departSource === 'estimated';
  return it;
}

// State of the "leave in" line at time `now`; cheap enough to call every second.
export function leaveState(it, now = Date.now()) {
  if (it.kind === 'walk') return { kind: 'walk' };
  const bus = busLegOf(it);
  if (!bus || bus.departAt == null || !ROW_SOURCES.has(it.leaveSource)) return { kind: 'none' };
  const walkSec = it.legs[0].seconds;
  const remainingSec = (bus.departAt - now) / 1000;
  const leaveInSec = remainingSec - walkSec - it.bufferSec;
  if (remainingSec - walkSec < 0) return { kind: 'missed', leaveInSec, remainingSec };
  if (leaveInSec >= 60) return { kind: 'later', leaveInSec, remainingSec };
  if (leaveInSec >= 0) return { kind: 'now', leaveInSec, remainingSec };
  return { kind: 'run', leaveInSec, remainingSec };
}

// Walk-only itinerary: one walk leg, leave now.
export function walkItinerary(walk, from, to, now = Date.now()) {
  const leg = walkLegOf(walk, place(from), place(to));
  const arriveAt = now + walk.seconds * 1000;
  leg.startAt = now; leg.endAt = arriveAt;
  return {
    id: 'walk', kind: 'walk', transfers: 0, legs: [leg], status: 'ok',
    leaveAt: now, leaveInSec: 0, leaveSource: null, arriveAt, arriveSource: 'estimated',
    confidence: 1, estimated: false, liveError: false, next: null, missed: null, transfer: null, bufferSec: 0,
  };
}

const walkSecOf = (it) => it.legs.reduce((s, l) => s + (l.kind === 'walk' ? l.seconds || 0 : 0), 0);
const estTotalOf = (it) => it.legs.reduce((s, l) => s + (l.kind === 'walk' ? l.seconds || 0 : l.rideSec || 0), 0);

// Earlier arrival, then less walking, then live over scheduled. Itineraries without a bus go last.
export function rankItineraries(its) {
  const walkMin = (it) => Math.round(walkSecOf(it) / 60);
  const isLive = (it) => (busLegOf(it)?.departSource === 'live' ? 1 : 0);
  return [...its].sort((a, b) => {
    const A = a.arriveAt, B = b.arriveAt;
    if (A == null || B == null) return A == null && B == null ? estTotalOf(a) - estTotalOf(b) : A == null ? 1 : -1;
    const ma = Math.floor(A / 60000), mb = Math.floor(B / 60000);
    if (ma !== mb) return ma - mb;
    if (walkMin(a) !== walkMin(b)) return walkMin(a) - walkMin(b);
    if (isLive(a) !== isLive(b)) return isLive(b) - isLive(a);
    return A - B;
  });
}

// ---------------------------------------------------------------- orchestration

const wKey = (a, b) => `${a.lat.toFixed(5)},${a.lng.toFixed(5)}>${b.lat.toFixed(5)},${b.lng.toFixed(5)}`;
const RETRY_ESTIMATE_MS = 60000;
// Walking legs live in a caller-owned Map so the 20 s refresh never re-asks OSRM: key → { v: walk|null, p, at }.
// A leg that fell back to the estimate is retried after a minute.
function walkLeg(deps, cache, a, b) {
  const k = wKey(a, b);
  let e = cache.get(k);
  if (e?.v?.source === 'estimate' && Date.now() - e.at > RETRY_ESTIMATE_MS) e = null;
  if (!e) {
    e = { v: null, at: Date.now(), p: null };
    const mine = e;
    mine.p = Promise.resolve().then(() => deps.walkRoute(a, b)).catch(() => deps.walkEstimate(a, b)).then((w) => (mine.v = w));
    cache.set(k, mine);
  }
  return e;
}

const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });

export function whyNoCandidates(data, from, to) {
  const F = LIMITS.farRadius;
  if (!nearestStops(data.stops, from, { limit: 1, maxMeters: F }).length) return 'no-board-stops';
  if (!nearestStops(data.stops, to, { limit: 1, maxMeters: F }).length) return 'no-alight-stops';
  return 'no-route';
}

// The one function the app calls. data = the index from loadData().
// → { itineraries, reason, now, liveTotal, liveFailed, pending }
//   reason (only when itineraries is empty): 'no-data' | 'outside-from' | 'outside-to' | 'no-board-stops' | 'no-alight-stops' | 'no-route'
//   pending: walking legs still on the straight-line estimate (0 in the returned, final result)
// opts: { deps: { fetchLive, walkRoute, walkEstimate }, now, signal, bufferSec, walkCache: Map, prefer: Map<id, busKey>, onUpdate }
//   onUpdate fires as soon as live data is in (walks = estimates) and again as each OSRM leg arrives.
export async function planTrips(data, from, to, opts = {}) {
  const deps = opts.deps;
  if (!deps?.fetchLive || !deps?.walkRoute || !deps?.walkEstimate) throw new Error('trip: deps missing');
  const now = opts.now ?? Date.now();
  const res = { itineraries: [], reason: null, now, liveTotal: 0, liveFailed: 0, pending: 0 };
  if (!data?.routes?.length) return { ...res, reason: 'no-data' };
  if (!inArea(from)) return { ...res, reason: 'outside-from' };
  if (!inArea(to)) return { ...res, reason: 'outside-to' };
  const bufferSec = opts.bufferSec ?? LIMITS.bufferSec;
  const walkEst = (a, b) => deps.walkEstimate(a, b).seconds;
  const cache = opts.walkCache || new Map();
  const stale = () => { if (opts.signal?.aborted) throw abortError(); };

  let cands = candidateTrips(data, from, to, { walkEst });
  if (!cands.length) cands = candidateTrips(data, from, to, { walkEst, boardRadius: LIMITS.farRadius, alightRadius: LIMITS.farRadius });
  const picks = shortlist(cands);
  const direct = walkEst(from, to);
  const wantWalk = direct <= LIMITS.walkOnlyMaxSec * 1.15;
  const wantWalkFallback = !picks.length && direct <= LIMITS.walkOnlyFallbackSec;

  // Each stop once per plan, in parallel; api.fetchLive holds the 15 s per-stop floor.
  const liveCodes = [...new Set(picks.flatMap((c) => [c.board.code, c.alight.code]))].slice(0, LIMITS.maxLiveStops);
  const live = new Map();
  res.liveTotal = liveCodes.length;
  await Promise.all(liveCodes.map((code) => Promise.resolve().then(() => deps.fetchLive(code)).then((r) => live.set(code, r), () => { res.liveFailed++; })));
  stale();

  const walkFor = (a, b) => cache.get(wKey(a, b))?.v || deps.walkEstimate(a, b);
  const assemble = () => {
    let its = picks.map((c) => buildDirect(c, {
      boardRes: live.get(c.board.code) ?? null, alightRes: live.get(c.alight.code) ?? null,
      walkTo: walkFor(from, c.board), walkFrom: walkFor(c.alight, to), from, to,
      bufferSec, now, prefer: opts.prefer?.get(`${c.route.code}:${c.board.code}:${c.alight.code}`) ?? null,
    }));
    let walkIt = wantWalk || wantWalkFallback ? walkItinerary(walkFor(from, to), from, to, now) : null;
    if (!walkIt && its.length && direct <= LIMITS.walkOnlyFallbackSec) { // long walk: only when it beats every bus
      const best = Math.min(...its.map((i) => i.arriveAt ?? Infinity));
      if (now + direct * 1000 < best) walkIt = walkItinerary(walkFor(from, to), from, to, now);
    }
    if (walkIt && walkIt.legs[0].seconds <= LIMITS.walkOnlyMaxSec) { // short walk: buses that do not beat it are noise
      its = its.filter((i) => i.arriveAt != null && i.arriveAt < walkIt.arriveAt - 60000);
    }
    if (walkIt) its.push(walkIt);
    return rankItineraries(its).slice(0, LIMITS.maxResults);
  };

  // Precise walking legs, requested in rank order so the best result settles first.
  const first = assemble();
  const entries = new Map();
  for (const it of first) {
    const legs = it.kind === 'walk' ? [[from, to]] : [[from, busLegOf(it).board], [busLegOf(it).alight, to]];
    for (const [a, b] of legs) if (entries.size < LIMITS.maxOsrmLegs || entries.has(wKey(a, b))) entries.set(wKey(a, b), walkLeg(deps, cache, a, b));
  }
  const open = () => [...entries.values()].filter((e) => !e.v).length;
  let finished = false, queued = false;
  const emit = () => {
    if (finished || queued || !opts.onUpdate || opts.signal?.aborted) return;
    queued = true;
    Promise.resolve().then(() => { queued = false; if (!finished && !opts.signal?.aborted) opts.onUpdate({ ...res, itineraries: assemble(), pending: open() }); });
  };
  emit();
  for (const e of entries.values()) e.p.then(emit);
  await Promise.all([...entries.values()].map((e) => e.p));
  finished = true;
  stale();

  res.itineraries = assemble();
  if (!res.itineraries.length) res.reason = !picks.length ? whyNoCandidates(data, from, to) : 'no-route';
  return res;
}
