// Trip planner core (owner: planner). Single bus ride (+ walk-only). See docs/ARCHITECTURE.md.
// Pure helpers are exported for tests; everything networked is injected through `deps`
// (defaults load lazily so this module imports cleanly in Node).
import { haversine, nearestStops, inArea } from './geo.js';

export const DEFAULTS = {
  boardRadius: 800, alightRadius: 800, farRadius: 1500, // metres, straight line
  nearestBoard: 8, nearestAlight: 8,                    // candidate stops per end
  maxRoutes: 4, maxBoardStops: 3, maxAlightStops: 2, maxPerLine: 2, // live-fetch budget: ≤3 + ≤2 stops
  walkOnlyMaxSec: 1200, walkOnlyFallbackSec: 2700, bufferSec: 120,
};
const LEG_FALLBACK_SEC = 90; // bus seconds per stop when legSec is missing
const MAX_STALE_SEC = 20;    // a bus due "now" stays listed for a few seconds
const estWalkSec = (a, b) => (haversine(a, b) * 1.3) / 1.3; // straight ×1.3 at 1.3 m/s

// ---------------------------------------------------------------- candidates

const posCache = new WeakMap();
// code → ascending indexes in route.stops (loop routes visit a stop twice).
function positions(route) {
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
  const o = { ...DEFAULTS, ...opts };
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
          best.set(route.code, { route, board, alight, bi, ai, nStops: ai - bi, walkToEst, walkFromEst, rideEst, cost });
        }
      }
    }
  }
  return [...best.values()].sort((a, b) => a.cost - b.cost);
}

// Greedy shortlist honouring the live-fetch budget (distinct board/alight stops) and ≤ N per line.
export function shortlist(cands, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const boards = new Set(), alights = new Set(), perLine = new Map(), out = [];
  for (const c of cands) {
    if (out.length >= o.maxRoutes) break;
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

// Vehicles of `route` at one stop, from a LiveResult. Absolute departAt = fetchedAt + etaSec
// (stable for scheduled entries, same formula as api.remainingSec). null → live fetch failed.
export function departuresAt(route, res) {
  if (!res || !Array.isArray(res.vehicles)) return null;
  const byKey = new Map();
  let anon = 0;
  for (const v of res.vehicles) {
    if (String(v.routeCode) !== String(route.code) || !Number.isFinite(v.etaSec)) continue;
    const live = !!v.live;
    const d = {
      vehicleCode: v.vehicleCode ?? null, live, etaSec: v.etaSec, fetchedAt: res.fetchedAt,
      departAt: res.fetchedAt + v.etaSec * 1000, routeName: v.routeName || '', lineCode: String(v.lineCode ?? route.lineCode),
      lat: live ? v.lat : undefined, lng: live ? v.lng : undefined,
    };
    d.key = d.vehicleCode ? String(d.vehicleCode) : `${live ? 'l' : 's'}:${Math.round(d.departAt / 60000)}:${anon++}`;
    const prev = byKey.get(d.key);
    if (!prev || (live && !prev.live)) byKey.set(d.key, d);
  }
  return [...byKey.values()].sort((a, b) => a.departAt - b.departAt);
}

// Which vehicle to catch. `deps` sorted by departAt.
//  chosen: first vehicle with remaining ≥ walk + buffer (leaveInSec ≥ 0); if none, the first one still
//          reachable by hurrying (leaveInSec < 0, "run"). `prefer` (key) keeps a bus you are about to
//          miss on screen instead of jumping to the next one.
//  hurry:  an earlier vehicle you could only catch by running (0 ≤ slack < buffer).
//  missed: the soonest vehicle if it can no longer be reached (remaining < walk).
//  next:   the catchable vehicle after `chosen`.
export function chooseDeparture(deps, { walkSec, bufferSec = DEFAULTS.bufferSec, now = Date.now(), prefer = null } = {}) {
  const list = (deps || []).map((dep) => {
    const remainingSec = (dep.departAt - now) / 1000;
    const slackSec = remainingSec - walkSec;
    return { dep, remainingSec, slackSec, leaveInSec: slackSec - bufferSec };
  }).filter((x) => x.remainingSec > -MAX_STALE_SEC);
  const out = { chosen: null, hurry: null, missed: null, next: null };
  if (!list.length) return out;
  let chosen = list.find((x) => x.slackSec >= bufferSec) || null;
  const sticky = prefer ? list.find((x) => x.dep.key === prefer && x.slackSec >= 0 && x.slackSec < bufferSec) : null;
  if (sticky && (!chosen || sticky.dep.departAt < chosen.dep.departAt)) chosen = sticky;
  if (!chosen) chosen = list.find((x) => x.slackSec >= 0) || null;
  if (list[0].slackSec < 0 && list[0] !== chosen) out.missed = list[0];
  if (chosen) {
    out.chosen = chosen;
    if (chosen.slackSec >= bufferSec) out.hurry = list.find((x) => x !== chosen && x.dep.departAt < chosen.dep.departAt && x.slackSec >= 0) || null;
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

const busInfo = (dep, now) => ({
  key: dep.key, live: dep.live, vehicleCode: dep.vehicleCode, departAt: dep.departAt, fetchedAt: dep.fetchedAt,
  remainingSec: Math.max(0, (dep.departAt - now) / 1000), scheduledAt: dep.live ? undefined : dep.departAt,
  routeName: dep.routeName, lat: dep.lat, lng: dep.lng,
});

// (Re)select the departure from it.departures at time `now` and refresh the time-dependent fields.
export function retime(it, now = Date.now(), bufferSec = it.bufferSec, prefer = it.bus?.key ?? null) {
  if (it.kind !== 'bus') return it;
  it.bufferSec = bufferSec;
  const d = chooseDeparture(it.departures, { walkSec: it.walkTo.seconds, bufferSec, now, prefer });
  const walkFromSec = it.walkFrom.seconds;
  const arrive = (x) => x.dep.departAt + (x.dep.rideSec ?? it.rideEstSec) * 1000 + walkFromSec * 1000;
  it.missed = d.missed ? { ...busInfo(d.missed.dep, now), needSec: it.walkTo.seconds } : null;
  it.hurry = d.hurry ? { bus: busInfo(d.hurry.dep, now), leaveInSec: d.hurry.leaveInSec, arriveAt: arrive(d.hurry) } : null;
  it.next = d.next ? { bus: busInfo(d.next.dep, now), leaveInSec: d.next.leaveInSec, arriveAt: arrive(d.next) } : null;
  if (!d.chosen) {
    Object.assign(it, { bus: null, leaveAt: null, leaveInSec: null, arriveAt: null, rideSec: it.rideEstSec, rideSource: 'estimate', status: 'none' });
    return it;
  }
  const c = d.chosen;
  Object.assign(it, {
    bus: busInfo(c.dep, now), rideSec: c.dep.rideSec ?? it.rideEstSec, rideSource: c.dep.rideSource || 'estimate',
    leaveAt: c.dep.departAt - (it.walkTo.seconds + bufferSec) * 1000, leaveInSec: c.leaveInSec, arriveAt: arrive(c),
    status: c.leaveInSec < 0 ? 'run' : 'ok',
  });
  return it;
}

// UI state of the hero line at time `now`; cheap enough to call every second.
export function leaveState(it, now = Date.now()) {
  if (it.kind === 'walk') return { kind: 'walk' };
  if (!it.bus) return { kind: 'none' };
  const remainingSec = (it.bus.departAt - now) / 1000;
  const leaveInSec = remainingSec - it.walkTo.seconds - it.bufferSec;
  if (remainingSec - it.walkTo.seconds < 0) return { kind: 'missed', leaveInSec, remainingSec };
  if (leaveInSec >= 60) return { kind: 'later', leaveInSec, remainingSec };
  if (leaveInSec >= 0) return { kind: 'now', leaveInSec, remainingSec };
  return { kind: 'run', leaveInSec, remainingSec };
}

export function buildBusItinerary(cand, { line = null, boardRes, alightRes, walkTo, walkFrom, bufferSec = DEFAULTS.bufferSec, now = Date.now(), prefer = null }) {
  const departures = departuresAt(cand.route, boardRes);
  const alightDeps = departuresAt(cand.route, alightRes);
  for (const d of departures || []) Object.assign(d, rideFor(d, alightDeps, cand.rideEst));
  const it = {
    kind: 'bus', id: `${cand.route.code}:${cand.board.code}:${cand.alight.code}`, line, route: cand.route, board: cand.board, alight: cand.alight,
    walkTo, walkFrom, bi: cand.bi, ai: cand.ai, nStops: cand.nStops, rideEstSec: cand.rideEst, bufferSec,
    departures: departures || [], liveError: departures === null,
    estTotalSec: walkTo.seconds + cand.rideEst + walkFrom.seconds,
    bus: null, rideSec: cand.rideEst, rideSource: 'estimate', leaveInSec: null, leaveAt: null, arriveAt: null, status: 'none',
    missed: null, hurry: null, next: null,
  };
  return retime(it, now, bufferSec, prefer);
}

export function walkItinerary(walk, now = Date.now()) {
  return {
    kind: 'walk', id: 'walk', line: null, route: null, board: null, alight: null, walkTo: walk, walkFrom: null, nStops: 0,
    bus: null, rideSec: 0, rideSource: null, leaveInSec: 0, leaveAt: now, arriveAt: now + walk.seconds * 1000,
    status: 'ok', estTotalSec: walk.seconds, bufferSec: 0, missed: null, hurry: null, next: null, departures: [],
  };
}

// Arrival time, then less walking, then live over scheduled. Itineraries without a departure go last.
export function rankItineraries(its) {
  const walkMin = (it) => Math.round(((it.walkTo?.seconds || 0) + (it.walkFrom?.seconds || 0)) / 60);
  return [...its].sort((a, b) => {
    const A = a.arriveAt, B = b.arriveAt;
    if (A == null || B == null) return A == null && B == null ? a.estTotalSec - b.estTotalSec : A == null ? 1 : -1;
    const ma = Math.floor(A / 60000), mb = Math.floor(B / 60000);
    if (ma !== mb) return ma - mb;
    if (walkMin(a) !== walkMin(b)) return walkMin(a) - walkMin(b);
    const la = a.bus?.live ? 1 : 0, lb = b.bus?.live ? 1 : 0;
    if (la !== lb) return lb - la;
    return A - B;
  });
}

// ---------------------------------------------------------------- ride geometry

const KM_LNG = (lat) => Math.cos((lat * Math.PI) / 180);

// Snap an ordered stop list onto a route polyline so that vertex indexes never decrease
// (dynamic programming; robust for routes that run out and back along the same road).
export function snapStopsToShape(stopsLL, shape) {
  const S = stopsLL.length, V = shape.length;
  if (!S || V < 2) return null;
  const k = KM_LNG(shape[0][1]);
  const d = (s, v) => Math.hypot((s.lng - shape[v][0]) * k, s.lat - shape[v][1]);
  const back = Array.from({ length: S }, () => new Int32Array(V));
  let prev = new Float64Array(V);
  for (let v = 0; v < V; v++) prev[v] = d(stopsLL[0], v);
  for (let s = 1; s < S; s++) {
    const cur = new Float64Array(V);
    let bestU = 0, bestVal = Infinity;
    for (let v = 0; v < V; v++) {
      if (prev[v] < bestVal) { bestVal = prev[v]; bestU = v; }
      back[s][v] = bestU;
      cur[v] = bestVal + d(stopsLL[s], v);
    }
    prev = cur;
  }
  let v = 0;
  for (let i = 1; i < V; i++) if (prev[i] < prev[v]) v = i;
  const idx = new Array(S);
  for (let s = S - 1; s >= 0; s--) { idx[s] = v; if (s) v = back[s][v]; }
  return idx;
}

// [lng,lat][] for the ride between route positions bi..ai; stop coordinates cap both ends.
// Falls back to straight lines through the ordered stops when no shape (or snapping) is available.
export function rideGeometry(route, stopByCode, shape, bi, ai, snapped = null) {
  const pts = route.stops.slice(bi, ai + 1).map((c) => stopByCode.get(c)).filter(Boolean).map((s) => [s.lng, s.lat]);
  if (!shape || shape.length < 2 || pts.length < 2) return pts;
  const all = snapped || snapStopsToShape(route.stops.map((c) => stopByCode.get(c)).map((s) => s || { lat: shape[0][1], lng: shape[0][0] }), shape);
  if (!all || all[ai] <= all[bi]) return pts;
  const line = shape.slice(all[bi], all[ai] + 1);
  return [pts[0], ...line, pts[pts.length - 1]];
}

// ---------------------------------------------------------------- orchestration

async function resolveDeps(d = {}) {
  if (d.fetchLive && d.walkRoute && d.walkEstimate && d.getSettings) return d;
  const [api, walk, store] = await Promise.all([import('./api.js'), import('./walk.js'), import('./store.js')]);
  return { fetchLive: api.fetchLive, walkRoute: walk.walkRoute, walkEstimate: walk.walkEstimate, getSettings: store.getSettings, ...d };
}

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

// → { itineraries, reason, now, liveTotal, liveFailed, pending }
//   reason (only when itineraries is empty): 'no-data' | 'outside-from' | 'outside-to' | 'no-board-stops' | 'no-alight-stops' | 'no-route'
//   pending: walking legs still using straight-line estimates (0 in the returned, final result)
// opts: { now, signal, deps, walkCache: Map, prefer: Map<itineraryId, busKey>, onUpdate(partialResult) }
//   onUpdate fires as soon as live data is in (walking = estimates) and again as each OSRM leg arrives, so the
//   UI can paint within a second even though walk.js spaces OSRM requests 1 s apart.
export async function planTripsDetailed(ctx, from, to, opts = {}) {
  const now = opts.now ?? Date.now();
  const res = { itineraries: [], reason: null, now, liveTotal: 0, liveFailed: 0, pending: 0 };
  const data = ctx.data;
  if (!data?.routes?.length) return { ...res, reason: 'no-data' };
  if (!inArea(from)) return { ...res, reason: 'outside-from' };
  if (!inArea(to)) return { ...res, reason: 'outside-to' };
  const deps = await resolveDeps(opts.deps);
  const bufferSec = (deps.getSettings()?.bufferMin ?? DEFAULTS.bufferSec / 60) * 60;
  const walkEst = (a, b) => deps.walkEstimate(a, b).seconds;
  const cache = opts.walkCache || new Map();
  const stale = () => { if (opts.signal?.aborted) throw abortError(); };

  let cands = candidateTrips(data, from, to, { walkEst });
  if (!cands.length) cands = candidateTrips(data, from, to, { walkEst, boardRadius: DEFAULTS.farRadius, alightRadius: DEFAULTS.farRadius });
  const picks = shortlist(cands);
  const direct = walkEst(from, to);
  const wantWalk = direct <= DEFAULTS.walkOnlyMaxSec * 1.15 || (!picks.length && direct <= DEFAULTS.walkOnlyFallbackSec);

  // ≤3 board + ≤2 alight live fetches, in parallel (api.js adds the 15 s per-stop floor).
  const liveCodes = [...new Set([...picks.map((c) => c.board.code), ...picks.map((c) => c.alight.code)])];
  const live = new Map();
  res.liveTotal = liveCodes.length;
  await Promise.all(liveCodes.map((code) => Promise.resolve().then(() => deps.fetchLive(code)).then((r) => live.set(code, r), () => { res.liveFailed++; })));
  stale();

  const walkFor = (a, b) => cache.get(wKey(a, b))?.v || deps.walkEstimate(a, b);
  const assemble = () => {
    let its = picks.map((c) => buildBusItinerary(c, {
      line: data.lineByCode?.get(c.route.lineCode) || null,
      boardRes: live.get(c.board.code) ?? null, alightRes: live.get(c.alight.code) ?? null,
      walkTo: walkFor(from, c.board), walkFrom: walkFor(c.alight, to),
      bufferSec, now, prefer: opts.prefer?.get(`${c.route.code}:${c.board.code}:${c.alight.code}`) ?? null,
    }));
    let walkIt = wantWalk ? walkItinerary(walkFor(from, to), now) : null;
    if (!walkIt && its.length && direct <= DEFAULTS.walkOnlyFallbackSec) { // long walk: only when it beats every bus
      const best = Math.min(...its.map((i) => i.arriveAt ?? Infinity));
      if (now + direct * 1000 < best) walkIt = walkItinerary(walkFor(from, to), now);
    }
    if (walkIt && walkIt.estTotalSec <= DEFAULTS.walkOnlyMaxSec) { // short walk: buses that do not beat it are noise
      its = its.filter((i) => i.arriveAt != null && i.arriveAt < walkIt.arriveAt - 60000);
    }
    if (walkIt) its.push(walkIt);
    return rankItineraries(its);
  };

  // Precise walking legs, requested in rank order so the best card settles first (walk.js queues FIFO, 1 req/s).
  const first = assemble();
  const entries = new Map();
  for (const it of first) {
    const legs = it.kind === 'bus' ? [[from, it.board], [it.alight, to]] : [[from, to]];
    for (const [a, b] of legs) entries.set(wKey(a, b), walkLeg(deps, cache, a, b));
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

function whyNoCandidates(data, from, to) {
  const F = DEFAULTS.farRadius;
  if (!nearestStops(data.stops, from, { limit: 1, maxMeters: F }).length) return 'no-board-stops';
  if (!nearestStops(data.stops, to, { limit: 1, maxMeters: F }).length) return 'no-alight-stops';
  return 'no-route';
}

export async function planTrips(ctx, from, to, opts = {}) {
  return (await planTripsDetailed(ctx, from, to, opts)).itineraries;
}
