// Trip core (TEL-290, TEL-292): direct and one-transfer bus trips from A to B as plain data, no screen.
// Imports only ./geo.js (guard test).
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
  // transfers (TEL-292): change stops ≤ transferWalkM apart, ≤ maxTransfers shown (inside maxResults)
  transferWalkM: 300, nearestXfer: 6, maxTransfers: 2,
  waitEstSec: 300,         // wait assumed at the change while ranking candidates (no live data yet); never shown
};
const XFER_MARGIN_SEC = 60;       // minimum slack between reaching the change stop and bus B leaving
const XFER_PENALTY_SEC = 300;     // ranking handicap of a transfer (+5′), so a direct bus wins ties
const XFER_EST_PENALTY_SEC = 300; // +5′ more when the wait at the change is estimated
const HIDE_SEC = 300;             // a transfer with a known wait is hidden when a direct bus arrives ≤ 5′ after it
const HIDE_EST_SEC = 600;         // … ≤ 10′ after it when the wait is an estimated range
const MIN_GAP_SEC = 120;          // smallest headway believed from two listed buses
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

// ---------------------------------------------------------------- transfer candidates

// Two-bus trips: bus A board → x1, walk x1 → x2 (≤ transferWalkM, none when same stop), bus B x2 → alight.
// Joins "stops after a board stop" with "stops before an alight stop" on the same or a nearby stop.
// Routes that alone link the two ends are skipped (that is a direct trip). One option per line pair, cheapest
// first; low-confidence routes cost extra. Estimate only: the real wait comes from live data later.
export function transferCandidates(data, from, to, opts = {}) {
  const o = { ...LIMITS, ...opts };
  const walk = o.walkEst || estWalkSec;
  const boards = nearestStops(data.stops, from, { limit: o.nearestBoard, maxMeters: o.boardRadius });
  const alights = nearestStops(data.stops, to, { limit: o.nearestAlight, maxMeters: o.alightRadius });
  if (!boards.length || !alights.length) return [];
  const direct = walk(from, to);
  const wTo = new Map(boards.map(({ stop }) => [stop.code, walk(from, stop)]));
  const wFrom = new Map(alights.map(({ stop }) => [stop.code, walk(stop, to)]));
  const keep = (list, e, cost) => { // best entry per route
    const k = list.findIndex((x) => x.route === e.route);
    if (k < 0) list.push(e); else if (cost(e) < cost(list[k])) list[k] = e;
  };
  const fwd = new Map(); // stop code → [{ route, board, bi, xi, rideEst, walkToEst }]
  for (const { stop: board } of boards) {
    for (const route of data.routesByStop.get(board.code) || []) {
      const pos = positions(route);
      const bi = pos.get(board.code)?.[0];
      if (bi === undefined || alights.some(({ stop }) => pos.get(stop.code)?.some((i) => i > bi))) continue;
      const walkToEst = wTo.get(board.code);
      let ride = 0;
      for (let i = bi + 1; i < route.stops.length; i++) {
        ride += route.legSec?.[i - 1] ?? LEG_FALLBACK_SEC;
        if (walkToEst + ride >= direct) break;
        const code = route.stops[i];
        if (!data.stopByCode.has(code)) continue;
        keep(fwd.get(code) || fwd.set(code, []).get(code), { route, board, bi, xi: i, rideEst: ride, walkToEst }, (e) => e.rideEst + e.walkToEst);
      }
    }
  }
  const bwd = new Map(); // stop code → [{ route, alight, ai, xj, rideEst, walkFromEst }]
  for (const { stop: alight } of alights) {
    for (const route of data.routesByStop.get(alight.code) || []) {
      const pos = positions(route);
      const ai = pos.get(alight.code)?.at(-1);
      if (ai === undefined || boards.some(({ stop }) => pos.get(stop.code)?.some((i) => i < ai))) continue;
      const walkFromEst = wFrom.get(alight.code);
      let ride = 0;
      for (let j = ai - 1; j >= 0; j--) {
        ride += route.legSec?.[j] ?? LEG_FALLBACK_SEC;
        if (walkFromEst + ride >= direct) break;
        const code = route.stops[j];
        if (!data.stopByCode.has(code)) continue;
        keep(bwd.get(code) || bwd.set(code, []).get(code), { route, alight, ai, xj: j, rideEst: ride, walkFromEst }, (e) => e.rideEst + e.walkFromEst);
      }
    }
  }
  const best = new Map(); // "lineA>lineB" → candidate
  for (const [code, fs] of fwd) {
    const x1 = data.stopByCode.get(code);
    for (const { stop: x2, meters } of nearestStops(data.stops, x1, { limit: o.nearestXfer, maxMeters: o.transferWalkM })) {
      const bs = bwd.get(x2.code);
      if (!bs) continue;
      const same = x2.code === code;
      const walkXEst = same ? 0 : walk(x1, x2);
      for (const f of fs) {
        for (const b of bs) {
          if (f.route.lineCode === b.route.lineCode || f.board.code === b.alight.code) continue;
          const base = f.walkToEst + f.rideEst + walkXEst + o.waitEstSec + b.rideEst + b.walkFromEst;
          if (base >= direct) continue; // walking straight there is no worse
          const cost = base + (2 - confOf(f.route) - confOf(b.route)) * 300;
          const key = `${f.route.lineCode}>${b.route.lineCode}`;
          if (best.get(key)?.cost <= cost) continue;
          best.set(key, {
            kind: 'transfer', x1, x2, xferMeters: same ? 0 : meters, walkXEst, walkToEst: f.walkToEst, walkFromEst: b.walkFromEst,
            a: { route: f.route, board: f.board, alight: x1, bi: f.bi, ai: f.xi, nStops: f.xi - f.bi, rideEst: f.rideEst },
            b: { route: b.route, board: x2, alight: b.alight, bi: b.xj, ai: b.ai, nStops: b.ai - b.xj, rideEst: b.rideEst },
            rideEst: f.rideEst + b.rideEst, minConf: Math.min(confOf(f.route), confOf(b.route)), cost,
          });
        }
      }
    }
  }
  return [...best.values()].sort((a, b) => a.cost - b.cost);
}

// Greedy shortlist within the shared live-fetch budget; `used` = stop codes already asked for direct trips.
export function shortlistTransfers(tcands, used = new Set(), opts = {}) {
  const o = { ...LIMITS, ...opts };
  const codes = new Set(used), perLine = new Map(), out = [];
  for (const c of tcands) {
    if (out.length >= o.maxTransfers) break;
    const need = new Set([c.a.board.code, c.b.board.code].filter((x) => !codes.has(x)));
    if (codes.size + need.size > o.maxLiveStops || (perLine.get(c.a.route.lineCode) || 0) >= 2) continue;
    need.forEach((x) => codes.add(x));
    perLine.set(c.a.route.lineCode, (perLine.get(c.a.route.lineCode) || 0) + 1);
    out.push(c);
  }
  return out;
}

export const transferId = (c) => `${c.a.route.code}:${c.a.board.code}:${c.x1.code}~${c.b.route.code}:${c.x2.code}:${c.b.alight.code}`;

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
const busLegsOf = (it) => it.legs.filter((l) => l.kind === 'bus');
// s: { route, board, alight, bi, ai, nStops, rideEst } (a direct candidate, or cand.a / cand.b of a transfer)
const busLegFrom = (s, departures, confidence = confOf(s.route)) => ({
  kind: 'bus', lineCode: s.route.lineCode, routeCode: s.route.code, routeName: s.route.displayName || s.route.name || '',
  board: stopInfo(s.board), alight: stopInfo(s.alight), boardIndex: s.bi, alightIndex: s.ai, nStops: s.nStops,
  departAt: null, departSource: null, arriveAt: null, arriveSource: 'estimated', rideSec: s.rideEst, rideEstSec: s.rideEst, rideSource: 'estimate',
  key: null, vehicleCode: null, vehicle: null, fetchedAt: null,
  confidence, orderEstimated: confidence < LIMITS.lowConfidence, departures: departures || [],
});
const NO_BUS = { departAt: null, departSource: null, arriveAt: null, arriveSource: 'estimated', rideSource: 'estimate', key: null, vehicleCode: null, vehicle: null, fetchedAt: null };
// Copy one departure row onto a bus leg (no arrival: the caller sets it).
function fillBus(leg, dep) {
  const hasPos = dep.live && Number.isFinite(dep.lat) && Number.isFinite(dep.lng);
  Object.assign(leg, {
    departAt: dep.departAt, departSource: dep.source, rideSec: dep.rideSec ?? leg.rideEstSec, rideSource: dep.rideSource || 'estimate',
    key: dep.key, vehicleCode: dep.vehicleCode, vehicle: hasPos ? { lat: dep.lat, lng: dep.lng } : null, fetchedAt: dep.fetchedAt,
  });
}

// One direct itinerary (walk → bus → walk) from a candidate and its live answers. from/to are the trip's two ends.
export function buildDirect(cand, { boardRes, alightRes, walkTo, walkFrom, from, to, bufferSec = LIMITS.bufferSec, now = Date.now(), prefer = null }) {
  const departures = departuresAt(cand.route, boardRes);
  const alightDeps = departuresAt(cand.route, alightRes);
  for (const d of departures || []) Object.assign(d, rideFor(d, alightDeps, cand.rideEst));
  const confidence = cand.confidence ?? confOf(cand.route);
  const bus = busLegFrom(cand, departures, confidence);
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
  if (it.kind === 'transfer') return retimeTransfer(it, now, prefer);
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
    Object.assign(bus, NO_BUS, { rideSec: bus.rideEstSec });
    Object.assign(it, { status: 'none', leaveAt: null, leaveInSec: null, leaveSource: null, arriveAt: null, arriveSource: 'estimated' });
    walk0.startAt = walk0.endAt = walkN.startAt = walkN.endAt = null;
    it.estimated = it.confidence < LIMITS.lowConfidence;
    return it;
  }
  const dep = d.chosen.dep;
  fillBus(bus, dep);
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

// ---------------------------------------------------------------- transfers

// Timing of one concrete bus A departure through the change. Three cases for bus B:
//  1. a listed bus B leaves after we are ready → real wait, source of that row;
//  2. none listed after that, but ≥ 2 listed → headway range: wait ≈ half the gap, at most the whole gap ('estimated');
//  3. fewer than 2 listed → wait unknown: no number, no departure, no arrival ('estimated').
function connect(it, depA) {
  const [legA, legB] = busLegsOf(it);
  const walkX = it.transfer.walkSec;
  const walkFromSec = it.legs[it.legs.length - 1].seconds;
  const ds = legB.departures;
  const rideA = depA.rideSec ?? legA.rideEstSec;
  const rideSourceA = depA.rideSource || 'estimate';
  const arriveX = depA.departAt + rideA * 1000;
  const margin = XFER_MARGIN_SEC + (rideSourceA === 'live-match' ? 0 : Math.min(120, rideA * 0.1)); // estimated rides drift
  const readyAt = arriveX + (walkX + margin) * 1000;
  const depB = ds.find((d) => d.departAt >= readyAt) || null;
  let departB = null, waitSec = null, waitMaxSec = null, waitSource = 'estimated';
  if (depB) { // case 1
    departB = depB.departAt;
    waitSec = (departB - (arriveX + walkX * 1000)) / 1000;
    waitSource = depB.source;
  } else if (ds.length >= 2) { // case 2
    const gapSec = Math.max(MIN_GAP_SEC, (ds[ds.length - 1].departAt - ds[0].departAt) / (ds.length - 1) / 1000);
    waitSec = gapSec / 2;
    waitMaxSec = gapSec;
    departB = arriveX + (walkX + waitSec) * 1000;
  } // else case 3: everything stays null
  const rideB = depB?.rideSec ?? legB.rideEstSec;
  const missedB = depB ? ds.filter((d) => d.departAt < readyAt && d.departAt > arriveX - 120000).at(-1) || null : null;
  return {
    rideA, rideSourceA, arriveX, arriveSourceX: depA.live && rideSourceA === 'live-match' ? 'live' : 'estimated',
    depB, departB, departSourceB: depB ? depB.source : 'estimated', rideB, rideSourceB: depB?.rideSource || 'estimate',
    waitSec, waitMaxSec, waitSource, missedB,
    arriveAt: departB === null ? null : departB + (rideB + walkFromSec) * 1000,
  };
}

function retimeTransfer(it, now, prefer) {
  const [legA, legB] = busLegsOf(it);
  const walk0 = it.legs[0], walkN = it.legs[it.legs.length - 1];
  const walkX = it.transfer.sameStop ? null : it.legs[it.legs.indexOf(legA) + 1];
  const walkSec = walk0.seconds;
  const d = chooseDeparture(legA.departures, { walkSec, bufferSec: it.bufferSec, now, prefer });
  it.missed = d.missed ? { departAt: d.missed.dep.departAt, source: d.missed.dep.source, needSec: walkSec } : null;
  it.next = d.next ? {
    departAt: d.next.dep.departAt, source: d.next.dep.source,
    leaveInSec: ROW_SOURCES.has(d.next.dep.source) ? d.next.leaveInSec : null, arriveAt: connect(it, d.next.dep).arriveAt,
  } : null;
  const walks = [walk0, walkX, walkN].filter(Boolean);
  if (!d.chosen) {
    Object.assign(legA, NO_BUS, { rideSec: legA.rideEstSec });
    Object.assign(legB, NO_BUS, { rideSec: legB.rideEstSec, departSource: 'estimated' });
    Object.assign(it.transfer, { arriveAt: null, arriveSource: 'estimated', waitSec: null, waitMaxSec: null, waitSource: 'estimated', missed: null });
    Object.assign(it, { status: 'none', leaveAt: null, leaveInSec: null, leaveSource: null, arriveAt: null, arriveSource: 'estimated' });
    for (const w of walks) w.startAt = w.endAt = null;
    it.estimated = true;
    it.rankPenaltySec = XFER_PENALTY_SEC + XFER_EST_PENALTY_SEC;
    return it;
  }
  const dep = d.chosen.dep, k = connect(it, dep);
  fillBus(legA, dep);
  Object.assign(legA, { rideSec: k.rideA, rideSource: k.rideSourceA, arriveAt: k.arriveX, arriveSource: k.arriveSourceX });
  if (k.depB) fillBus(legB, k.depB); else Object.assign(legB, NO_BUS);
  Object.assign(legB, {
    departAt: k.departB, departSource: k.departSourceB, rideSec: k.rideB, rideSource: k.rideSourceB,
    arriveAt: k.departB === null ? null : k.departB + k.rideB * 1000,
    arriveSource: k.depB?.live && k.rideSourceB === 'live-match' ? 'live' : 'estimated',
  });
  Object.assign(it.transfer, {
    arriveAt: k.arriveX, arriveSource: k.arriveSourceX, waitSec: k.waitSec, waitMaxSec: k.waitMaxSec, waitSource: k.waitSource,
    missed: k.missedB ? { departAt: k.missedB.departAt, source: k.missedB.source } : null,
  });
  const leaveSource = ROW_SOURCES.has(dep.source) ? dep.source : null;
  const leaveAt = dep.departAt - (walkSec + it.bufferSec) * 1000;
  Object.assign(it, {
    leaveAt, leaveSource, leaveInSec: leaveSource ? (leaveAt - now) / 1000 : null,
    arriveAt: k.arriveAt, arriveSource: k.waitSource === 'estimated' ? 'estimated' : legB.arriveSource,
    status: leaveAt < now ? 'run' : 'ok',
  });
  walk0.startAt = leaveAt; walk0.endAt = leaveAt + walkSec * 1000;
  if (walkX) { walkX.startAt = legA.arriveAt; walkX.endAt = legA.arriveAt + walkX.seconds * 1000; }
  walkN.startAt = legB.arriveAt; walkN.endAt = it.arriveAt;
  it.estimated = it.confidence < LIMITS.lowConfidence || it.transfer.waitSource === 'estimated';
  it.rankPenaltySec = XFER_PENALTY_SEC + (it.transfer.waitSource === 'estimated' ? XFER_EST_PENALTY_SEC : 0);
  return it;
}

// One transfer itinerary (walk → bus A → [walk] → bus B → walk) from a transferCandidates() entry and its live answers.
// changeWalk: walk x1 → x2 ({ seconds, meters, … }), null when it is the same stop.
export function buildTransfer(cand, { boardRes, changeRes, alightRes = null, walkTo, walkFrom, changeWalk = null, from, to, bufferSec = LIMITS.bufferSec, now = Date.now(), prefer = null }) {
  const sameStop = cand.x1.code === cand.x2.code;
  const depsA = departuresAt(cand.a.route, boardRes);
  const depsB = departuresAt(cand.b.route, changeRes);
  const aAtChange = sameStop ? departuresAt(cand.a.route, changeRes) : null; // same stop: bus A is listed there too → exact ride
  for (const d of depsA || []) Object.assign(d, rideFor(d, aAtChange, cand.a.rideEst));
  const bAtAlight = departuresAt(cand.b.route, alightRes);
  for (const d of depsB || []) Object.assign(d, rideFor(d, bAtAlight, cand.b.rideEst));
  const legA = busLegFrom(cand.a, depsA), legB = busLegFrom(cand.b, depsB);
  const xw = sameStop ? null : changeWalk || { seconds: cand.walkXEst, meters: cand.xferMeters, geometry: null, source: 'estimate' };
  const stop = stopInfo(cand.x1);
  const legs = [
    walkLegOf(walkTo, place(from), place(cand.a.board, cand.a.board)), legA,
    ...(xw ? [walkLegOf(xw, place(cand.x1, cand.x1), place(cand.x2, cand.x2))] : []),
    legB, walkLegOf(walkFrom, place(cand.b.alight, cand.b.alight), place(to)),
  ];
  const confidence = cand.minConf;
  const it = {
    id: transferId(cand), kind: 'transfer', transfers: 1, legs,
    status: 'none', leaveAt: null, leaveInSec: null, leaveSource: null, arriveAt: null, arriveSource: 'estimated',
    confidence, estimated: true, liveError: depsA === null, next: null, missed: null, bufferSec,
    transfer: {
      stop, toStop: sameStop ? stop : stopInfo(cand.x2), sameStop,
      walkSec: xw ? xw.seconds : 0, walkMeters: xw ? xw.meters : 0,
      arriveAt: null, arriveSource: 'estimated', waitSec: null, waitMaxSec: null, waitSource: 'estimated', missed: null,
    },
    rankPenaltySec: XFER_PENALTY_SEC,
  };
  return retime(it, now, prefer);
}

// Which transfers are worth showing next to the direct trips (rules on card TEL-292), best first, ≤ maxTransfers.
export function hideWeakTransfers(directs, transfers) {
  const known = directs.filter((d) => d.arriveAt != null);
  const shown = transfers.filter((t) => {
    // a direct trip that is only "estimated" for its stop order does not hide a transfer on two good routes
    const rivals = t.confidence >= LIMITS.lowConfidence ? known.filter((d) => !(d.estimated && d.confidence < LIMITS.lowConfidence)) : known;
    if (t.arriveAt == null) return rivals.length === 0; // case 3: wait unknown
    const slackSec = ROW_SOURCES.has(t.transfer.waitSource) ? HIDE_SEC : HIDE_EST_SEC;
    return !rivals.some((d) => d.arriveAt <= t.arriveAt + slackSec * 1000);
  });
  return rankItineraries(shown).slice(0, LIMITS.maxTransfers);
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

// Earlier arrival (+ the handicap of a transfer, rankPenaltySec), then a direct bus before a transfer, then less
// walking, then live over scheduled. Itineraries without a known arrival go last.
export function rankItineraries(its) {
  const walkMin = (it) => Math.round(walkSecOf(it) / 60);
  const isLive = (it) => (busLegOf(it)?.departSource === 'live' ? 1 : 0);
  const at = (it) => (it.arriveAt == null ? null : it.arriveAt + (it.rankPenaltySec || 0) * 1000);
  const isXfer = (it) => it.kind === 'transfer';
  return [...its].sort((a, b) => {
    const A = at(a), B = at(b);
    if (A == null || B == null) return A == null && B == null ? estTotalOf(a) - estTotalOf(b) : A == null ? 1 : -1;
    const ma = Math.floor(A / 60000), mb = Math.floor(B / 60000);
    if (ma !== mb) return ma - mb;
    if (isXfer(a) !== isXfer(b)) return isXfer(a) ? 1 : -1; // a direct bus wins ties
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

  let radii = {};
  let cands = candidateTrips(data, from, to, { walkEst });
  if (!cands.length) {
    radii = { boardRadius: LIMITS.farRadius, alightRadius: LIMITS.farRadius };
    cands = candidateTrips(data, from, to, { walkEst, ...radii });
  }
  const tcands = transferCandidates(data, from, to, { walkEst, ...radii });
  // Live budget (≤ maxLiveStops in total): direct trips take ≤ 3 board + ≤ 2 alight stops (≤ 1 alight when transfers
  // compete); transfers add the stops where bus A and bus B are boarded.
  const picks = shortlist(cands, tcands.length ? { maxAlightStops: 1 } : {});
  const directCodes = new Set(picks.flatMap((c) => [c.board.code, c.alight.code]));
  const tpicks = shortlistTransfers(tcands, directCodes);
  const direct = walkEst(from, to);
  const wantWalk = direct <= LIMITS.walkOnlyMaxSec * 1.15;
  const wantWalkFallback = !picks.length && !tpicks.length && direct <= LIMITS.walkOnlyFallbackSec;

  // Each stop once per plan, in parallel; api.fetchLive holds the 15 s per-stop floor.
  const liveCodes = [...new Set([...directCodes, ...tpicks.flatMap((c) => [c.a.board.code, c.b.board.code])])].slice(0, LIMITS.maxLiveStops);
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
    const tits = tpicks.map((c) => buildTransfer(c, {
      boardRes: live.get(c.a.board.code) ?? null, changeRes: live.get(c.b.board.code) ?? null, alightRes: live.get(c.b.alight.code) ?? null,
      walkTo: walkFor(from, c.a.board), walkFrom: walkFor(c.b.alight, to),
      changeWalk: c.x1.code === c.x2.code ? null : deps.walkEstimate(c.x1, c.x2), // straight-line estimate: no OSRM leg
      from, to, bufferSec, now, prefer: opts.prefer?.get(transferId(c)) ?? null,
    })).filter((t) => t.status !== 'none');
    its.push(...hideWeakTransfers(its, tits));
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
    const legs = it.kind === 'walk' ? [[from, to]] : [[from, busLegOf(it).board], [busLegsOf(it).at(-1).alight, to]];
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
  if (!res.itineraries.length) res.reason = !picks.length && !tpicks.length ? whyNoCandidates(data, from, to) : 'no-route';
  return res;
}
