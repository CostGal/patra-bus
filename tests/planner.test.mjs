// node --test tests/planner.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  candidateTrips, shortlist, chooseDeparture, rideFor, departuresAt, retime, leaveState, rankItineraries,
  planTripsDetailed, planTrips, snapStopsToShape, rideGeometry, walkItinerary,
} from '../web/js/planner.js';
import { stopPlaces, mapPhoton, mergePlaces } from '../web/js/geocode.js';
import { haversine } from '../web/js/geo.js';

// ---- synthetic city: 10 stops 600 m apart on a west→east road, y = metres north
const KM = 111320;
const LNG = KM * Math.cos((38.24 * Math.PI) / 180);
const pt = (x, y = 0) => ({ lat: 38.24 + y / KM, lng: 21.70 + x / LNG });
const NOW = Date.UTC(2026, 9, 10, 19, 0, 0);

function mkRoute(code, lineCode, codes, legSec = 60) {
  return { code, lineCode, name: code, displayName: code, direction: 1, stops: codes, legSec: codes.slice(1).map(() => legSec), confidence: 1, pos: new Map(codes.map((c, i) => [c, i])) };
}
function mkData(extraRoutes = [], extraStops = []) {
  const stops = [
    ...Array.from({ length: 10 }, (_, i) => ({ code: `s${i}`, name: `S${i}`, displayName: `Στάση ${i}`, ...pt(i * 600), lineCodes: [], routeCodes: [], key: `s${i}` })),
    ...extraStops,
  ];
  const s = (n) => Array.from({ length: n }, (_, i) => `s${i}`);
  const routes = [
    mkRoute('A1', '201', s(10)),                            // west → east, all stops
    mkRoute('B1', '202', s(10).reverse()),                  // east → west
    mkRoute('C1', '203', s(5)),                             // short: s0..s4 only
    ...extraRoutes,
  ];
  const routesByStop = new Map();
  for (const r of routes) for (const c of r.stops) (routesByStop.get(c) || routesByStop.set(c, []).get(c)).push(r);
  const lines = ['201', '202', '203'].map((code) => ({ code, name: code, displayName: code, color: '#ff5722', textColor: '#fff', routes: [] }));
  return {
    stops, lines, routes, routesByStop,
    stopByCode: new Map(stops.map((x) => [x.code, x])), lineByCode: new Map(lines.map((l) => [l.code, l])), routeByCode: new Map(routes.map((r) => [r.code, r])),
  };
}
const veh = (routeCode, etaSec, o = {}) => ({ lineCode: o.lineCode || '201', lineName: '', routeCode, routeName: 'ΠΡΟΣ ΝΤΕΣΤΙΝΑΣΙΟΝ', color: null, textColor: null,
  live: o.live ?? true, departureMins: Math.floor(etaSec / 60), etaSec, vehicleCode: o.vehicleCode ?? null, ...(o.live === false ? {} : { lat: 38.24, lng: 21.7 }) });
const res = (vehicles, fetchedAt = NOW) => ({ fetchedAt, vehicles });
function mkDeps({ live = {}, walk = (a, b) => haversine(a, b), buffer = 2, fail = [] } = {}) {
  const calls = { live: [], walk: 0 };
  return {
    calls,
    fetchLive: async (code) => { calls.live.push(code); if (fail.includes(code)) throw new Error('boom'); return live[code] ?? res([]); },
    walkRoute: async (a, b) => { calls.walk++; const seconds = walk(a, b); return { seconds, meters: seconds * 1.3, geometry: null, source: 'osrm' }; },
    walkEstimate: (a, b) => ({ seconds: haversine(a, b), meters: haversine(a, b) * 1.3, geometry: null, source: 'estimate' }),
    getSettings: () => ({ bufferMin: buffer }),
  };
}
const ctxOf = (data) => ({ data });
const busOf = (out) => out.itineraries.find((i) => i.kind === 'bus');

// "owner scenario": 10 min walk to s1, 2 min walk from s8, bus in 30 min, buffer 2 min.
const FROM = pt(600, 300);   // 300 m north of s1
const TO = pt(4800, 0);      // at s8
const ownerWalk = (a, b) => (b.code === 's1' ? 600 : a.code === 's8' ? 120 : haversine(a, b));

// ---------------------------------------------------------------- candidates
test('candidateTrips keeps only routes where board comes before alight (direction)', () => {
  const data = mkData();
  const c = candidateTrips(data, FROM, TO);
  const codes = c.map((x) => x.route.code);
  assert.ok(codes.includes('A1'), 'eastbound route is a candidate');
  assert.ok(!codes.includes('B1'), 'westbound route never reaches s8 after s1');
  assert.ok(!codes.includes('C1'), 'short route does not serve the destination');
  for (const x of c) assert.ok(x.route.pos.get(x.board.code) < x.route.pos.get(x.alight.code));
  // and the reverse trip uses the reverse route
  const back = candidateTrips(data, TO, FROM).map((x) => x.route.code);
  assert.deepEqual(back, ['B1']);
});

test('candidateTrips picks one (board, alight) pair per route, minimising walk + ride + walk', () => {
  const c = candidateTrips(mkData(), FROM, TO);
  const a1 = c.filter((x) => x.route.code === 'A1');
  assert.equal(a1.length, 1);
  assert.equal(a1[0].board.code, 's1');
  assert.equal(a1[0].alight.code, 's8');
  assert.equal(a1[0].nStops, 7);
  assert.equal(a1[0].rideEst, 7 * 60);
});

test('candidateTrips drops buses when walking straight is no worse', () => {
  const data = mkData();
  assert.deepEqual(candidateTrips(data, pt(300, 100), pt(900, 100)), []);
});

test('candidateTrips respects the 800 m radius', () => {
  const data = mkData();
  assert.deepEqual(candidateTrips(data, pt(600, 2000), TO), []);
  assert.ok(candidateTrips(data, pt(600, 2000), TO, { boardRadius: 2500 }).length > 0);
});

test('shortlist honours the live-fetch budget (≤4 routes, ≤3 board stops, ≤2 alight stops)', () => {
  const data = mkData();
  const extra = ['s0', 's1', 's2', 's3'].flatMap((b, i) => ['s7', 's8', 's9'].map((a, j) => mkRoute(`X${i}${j}`, `9${i}${j}`, [b, a])));
  const cands = extra.map((r, i) => ({ route: r, board: data.stopByCode.get(r.stops[0]), alight: data.stopByCode.get(r.stops[1]), cost: i }));
  const out = shortlist(cands);
  assert.ok(out.length <= 4);
  assert.ok(new Set(out.map((c) => c.board.code)).size <= 3);
  assert.ok(new Set(out.map((c) => c.alight.code)).size <= 2);
  // at most two routes of the same line
  const sameLine = shortlist(Array.from({ length: 5 }, (_, i) => ({ route: { code: `r${i}`, lineCode: '7' }, board: { code: 'b' }, alight: { code: 'a' }, cost: i })));
  assert.equal(sameLine.length, 2);
});

// ---------------------------------------------------------------- departure choice
const dep = (eta, o = {}) => ({ key: o.key || `k${eta}`, vehicleCode: o.vehicleCode ?? null, live: o.live ?? true, etaSec: eta, fetchedAt: NOW, departAt: NOW + eta * 1000 });

test('chooseDeparture: owner scenario — walk 10′, bus in 30′, buffer 2′ → leave in 18′', () => {
  const d = chooseDeparture([dep(1800)], { walkSec: 600, bufferSec: 120, now: NOW });
  assert.equal(d.chosen.leaveInSec, 18 * 60);
  assert.equal(d.missed, null);
});

test('chooseDeparture: skips a bus that cannot be caught and reports it as missed', () => {
  const d = chooseDeparture([dep(300), dep(1500), dep(2700)], { walkSec: 600, bufferSec: 120, now: NOW });
  assert.equal(d.missed.remainingSec, 300);
  assert.equal(d.chosen.remainingSec, 1500);
  assert.equal(d.chosen.leaveInSec, 1500 - 600 - 120);
  assert.equal(d.next.remainingSec, 2700);
});

test('chooseDeparture: boundary remaining == walk + buffer is catchable with leaveIn 0', () => {
  const d = chooseDeparture([dep(720)], { walkSec: 600, bufferSec: 120, now: NOW });
  assert.equal(d.chosen.leaveInSec, 0);
});

test('chooseDeparture: tight bus (walk ≤ remaining < walk+buffer) is a hurry option, not the main pick', () => {
  const d = chooseDeparture([dep(660), dep(1800)], { walkSec: 600, bufferSec: 120, now: NOW });
  assert.equal(d.chosen.remainingSec, 1800);
  assert.equal(d.hurry.remainingSec, 660);
  assert.ok(d.hurry.leaveInSec < 0);
});

test('chooseDeparture: if only a tight bus remains it is chosen (run!)', () => {
  const d = chooseDeparture([dep(660)], { walkSec: 600, bufferSec: 120, now: NOW });
  assert.equal(d.chosen.remainingSec, 660);
  assert.ok(d.chosen.leaveInSec < 0);
});

test('chooseDeparture: nothing reachable → chosen null, soonest reported missed', () => {
  const d = chooseDeparture([dep(200)], { walkSec: 600, now: NOW });
  assert.equal(d.chosen, null);
  assert.equal(d.missed.remainingSec, 200);
  assert.deepEqual(chooseDeparture([], { walkSec: 600, now: NOW }).chosen, null);
});

test('chooseDeparture: prefer keeps the bus you are about to miss instead of jumping to the next', () => {
  const list = [dep(630, { key: 'a' }), dep(2400, { key: 'b' })];
  const free = chooseDeparture(list, { walkSec: 600, bufferSec: 120, now: NOW });
  const kept = chooseDeparture(list, { walkSec: 600, bufferSec: 120, now: NOW, prefer: 'a' });
  assert.equal(free.chosen.dep.key, 'b');
  assert.equal(kept.chosen.dep.key, 'a');
  // …but once it is unreachable, it moves on
  const gone = chooseDeparture(list, { walkSec: 600, bufferSec: 120, now: NOW + 60000, prefer: 'a' });
  assert.equal(gone.chosen.dep.key, 'b');
  assert.equal(gone.missed.key ?? gone.missed.dep.key, 'a');
});

// ---------------------------------------------------------------- ride time
test('rideFor: same vehicleCode at both stops gives the exact difference', () => {
  const board = dep(1800, { vehicleCode: 'V1' });
  const at = [dep(2100, { vehicleCode: 'V1' }), dep(2900, { vehicleCode: 'V2' })];
  assert.deepEqual(rideFor(board, at, 420), { rideSec: 300, rideSource: 'live-match' });
});

test('rideFor: falls back to the estimate when there is no match or the match is implausible', () => {
  const board = dep(1800, { vehicleCode: 'V1' });
  assert.equal(rideFor(board, [dep(2900, { vehicleCode: 'V9' })], 420).rideSource, 'estimate');
  assert.equal(rideFor(board, null, 420).rideSource, 'estimate');
  assert.equal(rideFor(board, [dep(1810, { vehicleCode: 'V1' })], 420).rideSource, 'estimate'); // 10 s: too short
  assert.equal(rideFor(board, [dep(1800 + 9000, { vehicleCode: 'V1' })], 420).rideSource, 'estimate'); // another lap
  assert.equal(rideFor(dep(1800), [dep(2100, { vehicleCode: 'V1' })], 420).rideSource, 'estimate'); // no vehicleCode
});

test('departuresAt filters by route, dedupes by vehicleCode preferring live, sorts by absolute time', () => {
  const route = mkData().routeByCode.get('A1');
  const r = res([
    veh('A1', 900, { live: false, vehicleCode: 'V2' }), veh('A1', 300, { vehicleCode: 'V1' }), veh('B1', 100, { vehicleCode: 'V3' }),
    veh('A1', 905, { vehicleCode: 'V2' }), // same trip listed live as well
  ]);
  const d = departuresAt(route, r);
  assert.deepEqual(d.map((x) => x.vehicleCode), ['V1', 'V2']);
  assert.equal(d[1].live, true);
  assert.equal(d[0].departAt, NOW + 300000);
  assert.equal(departuresAt(route, null), null);
  assert.deepEqual(departuresAt(route, { fetchedAt: NOW, vehicles: [], noService: true }), []);
});

// ---------------------------------------------------------------- full plans
test('planTrips: owner scenario end to end — "Φύγε σε 18′"', async () => {
  const deps = mkDeps({ walk: ownerWalk, live: { s1: res([veh('A1', 1800, { vehicleCode: 'V1' })]) } });
  const out = await planTripsDetailed(ctxOf(mkData()), FROM, TO, { now: NOW, deps });
  const it = out.itineraries[0];
  assert.equal(it.kind, 'bus', 'bus beats the 70 min walk, so no walk-only card');
  assert.equal(it.route.code, 'A1');
  assert.equal(it.board.code, 's1');
  assert.equal(it.alight.code, 's8');
  assert.equal(it.walkTo.seconds, 600);
  assert.equal(it.leaveInSec, 1080);
  assert.equal(it.leaveAt, NOW + 1080 * 1000);
  assert.equal(it.bus.remainingSec, 1800);
  assert.equal(it.bus.live, true);
  assert.equal(it.rideSource, 'estimate');
  assert.equal(it.arriveAt, NOW + (1800 + 7 * 60 + 120) * 1000);
  assert.equal(it.status, 'ok');
  assert.equal(leaveState(it, NOW).kind, 'later');
  assert.equal(Math.floor(leaveState(it, NOW).leaveInSec / 60), 18);
  assert.equal(it.line.code, '201');
  // planTrips returns the same list
  assert.equal((await planTrips(ctxOf(mkData()), FROM, TO, { now: NOW, deps })).length, out.itineraries.length);
});

test('planTrips: missed-bus fallback uses the next bus and exposes the missed one', async () => {
  const deps = mkDeps({ walk: ownerWalk, live: { s1: res([veh('A1', 300, { vehicleCode: 'V1' }), veh('A1', 2400, { live: false, vehicleCode: 'V2' })]) } });
  const it = busOf(await planTripsDetailed(ctxOf(mkData()), FROM, TO, { now: NOW, deps }));
  assert.equal(it.missed.remainingSec, 300);
  assert.equal(it.bus.remainingSec, 2400);
  assert.equal(it.bus.live, false);
  assert.equal(it.bus.scheduledAt, NOW + 2400 * 1000);
  assert.equal(it.leaveInSec, 2400 - 600 - 120);
});

test('planTrips: live-match ride time from the same vehicle at board and alight stops', async () => {
  const deps = mkDeps({ walk: ownerWalk, live: {
    s1: res([veh('A1', 1800, { vehicleCode: 'V1' })]),
    s8: res([veh('A1', 2100, { vehicleCode: 'V1' })]),
  } });
  const it = busOf(await planTripsDetailed(ctxOf(mkData()), FROM, TO, { now: NOW, deps }));
  assert.equal(it.rideSource, 'live-match');
  assert.equal(it.rideSec, 300);
  assert.equal(it.arriveAt, NOW + (1800 + 300 + 120) * 1000);
});

test('planTrips: a route without a departure is kept but ranked last, with no leave time', async () => {
  const data = mkData([mkRoute('A2', '203', ['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9'], 90)]);
  const deps = mkDeps({ walk: ownerWalk, live: { s1: res([veh('A2', 3000, { lineCode: '203' })]) } });
  const out = (await planTripsDetailed(ctxOf(data), FROM, TO, { now: NOW, deps })).itineraries;
  const a1 = out.find((i) => i.route.code === 'A1');
  assert.equal(a1.status, 'none');
  assert.equal(a1.bus, null);
  assert.equal(a1.leaveInSec, null);
  assert.equal(a1.arriveAt, null);
  assert.equal(leaveState(a1, NOW).kind, 'none');
  assert.equal(out[0].route.code, 'A2');
  assert.equal(out.at(-1).route.code, 'A1');
});

test('planTrips: failed live fetch is flagged, not fatal', async () => {
  const deps = mkDeps({ walk: ownerWalk, fail: ['s1'] });
  const out = await planTripsDetailed(ctxOf(mkData()), FROM, TO, { now: NOW, deps });
  assert.equal(out.liveFailed >= 1, true);
  assert.equal(busOf(out).liveError, true);
  assert.equal(busOf(out).status, 'none');
});

test('planTrips: never fetches more than 3 board + 2 alight stops, each once', async () => {
  const nStops = [0, 1, 2, 3, 4].map((k) => ({ code: `n${k}`, name: `N${k}`, displayName: `N${k}`, ...pt(1200 + k * 40, 100), lineCodes: [], routeCodes: [], key: `n${k}` }));
  const extra = nStops.flatMap((n, i) => ['s7', 's8', 's9'].map((a, j) => mkRoute(`X${i}${j}`, `9${i}${j}`, [n.code, a])));
  const data = mkData(extra, nStops);
  const deps = mkDeps({ walk: ownerWalk });
  const out = await planTripsDetailed(ctxOf(data), pt(1200, 100), pt(4800, 0), { now: NOW, deps });
  assert.ok(out.itineraries.filter((i) => i.kind === 'bus').length <= 4);
  assert.ok(deps.calls.live.length > 0 && deps.calls.live.length <= 5, `live fetches: ${deps.calls.live.join()}`);
  assert.equal(new Set(deps.calls.live).size, deps.calls.live.length);
  assert.ok(deps.calls.walk <= 6);
});

test('planTrips: short trip → walk-only card; buses that do not beat the walk are dropped', async () => {
  const data = mkData();
  const A = pt(0), B = pt(1100); // 1100 m: s0 → s2 is 2 stops
  // slow bus (due in 25 min) cannot beat a 18 min walk
  let out = (await planTripsDetailed(ctxOf(data), A, B, { now: NOW, deps: mkDeps({ live: { s0: res([veh('A1', 1500)]) } }) })).itineraries;
  assert.deepEqual(out.map((i) => i.kind), ['walk']);
  assert.equal(out[0].leaveInSec, 0);
  assert.equal(out[0].arriveAt, NOW + out[0].walkTo.seconds * 1000);
  // fast bus (due in 5 min, 2 min ride) beats it clearly → bus first, walk second
  out = (await planTripsDetailed(ctxOf(data), A, B, { now: NOW, deps: mkDeps({ live: { s0: res([veh('A1', 300)]) } }) })).itineraries;
  assert.deepEqual(out.map((i) => i.kind), ['bus', 'walk']);
});

test('planTrips: a long walk is not offered when the bus is faster', async () => {
  const deps = mkDeps({ walk: ownerWalk, live: { s1: res([veh('A1', 900)]) } });
  const out = (await planTripsDetailed(ctxOf(mkData()), FROM, TO, { now: NOW, deps })).itineraries;
  assert.ok(out.every((i) => i.kind === 'bus'));
});

test('planTrips: with no service a walk up to ~45 min is offered first; longer ones are not', async () => {
  const near = pt(3000, 0); // s5, ≈2.4 km from FROM
  let out = (await planTripsDetailed(ctxOf(mkData()), FROM, near, { now: NOW, deps: mkDeps() })).itineraries;
  assert.equal(out[0].kind, 'walk');
  assert.equal(out.at(-1).kind, 'bus');
  out = (await planTripsDetailed(ctxOf(mkData()), FROM, TO, { now: NOW, deps: mkDeps() })).itineraries; // 4.2 km
  assert.ok(out.every((i) => i.kind === 'bus'));
});

test('planTrips: empty-state reasons', async () => {
  const deps = mkDeps();
  const data = mkData();
  const far = { lat: 40.6, lng: 22.9 };
  assert.equal((await planTripsDetailed(ctxOf(data), far, TO, { now: NOW, deps })).reason, 'outside-from');
  assert.equal((await planTripsDetailed(ctxOf(data), FROM, far, { now: NOW, deps })).reason, 'outside-to');
  assert.equal((await planTripsDetailed(ctxOf({ ...data, routes: [] }), FROM, TO, { now: NOW, deps })).reason, 'no-data');
  assert.equal((await planTripsDetailed(ctxOf(data), pt(300, 5000), TO, { now: NOW, deps })).reason, 'no-board-stops');
  assert.equal((await planTripsDetailed(ctxOf(data), FROM, pt(2400, 5000), { now: NOW, deps })).reason, 'no-alight-stops');
  // stops on both ends but no route that goes the right way (only the westbound route runs)
  const onlyB = { ...data, routes: [data.routeByCode.get('B1')], routesByStop: new Map() };
  for (const c of onlyB.routes[0].stops) onlyB.routesByStop.set(c, onlyB.routes);
  assert.equal((await planTripsDetailed(ctxOf(onlyB), FROM, TO, { now: NOW, deps })).reason, 'no-route');
});

test('planTrips: AbortError when the signal is aborted', async () => {
  const ctl = new AbortController();
  const p = planTripsDetailed(ctxOf(mkData()), FROM, TO, { now: NOW, deps: mkDeps({ walk: ownerWalk }), signal: ctl.signal });
  ctl.abort();
  await assert.rejects(p, { name: 'AbortError' });
});

test('planTrips: walk legs are cached across runs (the 20 s refresh does not re-ask OSRM)', async () => {
  const deps = mkDeps({ walk: ownerWalk });
  const walkCache = new Map();
  await planTripsDetailed(ctxOf(mkData()), FROM, TO, { now: NOW, deps, walkCache });
  const first = deps.calls.walk;
  await planTripsDetailed(ctxOf(mkData()), FROM, TO, { now: NOW + 20000, deps, walkCache });
  assert.equal(deps.calls.walk, first);
});

// ---------------------------------------------------------------- retime / hero state
test('retime + leaveState: countdown, "now", run, then next bus once unreachable', async () => {
  const deps = mkDeps({ walk: ownerWalk, live: { s1: res([veh('A1', 1800, { vehicleCode: 'V1' }), veh('A1', 3600, { live: false })]) } });
  const it = busOf(await planTripsDetailed(ctxOf(mkData()), FROM, TO, { now: NOW, deps }));
  assert.equal(leaveState(it, NOW + 1018 * 1000).kind, 'later');   // leaveIn 62 s
  assert.equal(leaveState(it, NOW + 1030 * 1000).kind, 'now');     // leaveIn 50 s
  assert.equal(leaveState(it, NOW + 1090 * 1000).kind, 'run');     // 10 s late, bus in 710 s, walk 600
  assert.equal(leaveState(it, NOW + 1250 * 1000).kind, 'missed');  // remaining 550 < walk 600
  // retime keeps the same bus while it is still reachable (run!), then moves on
  retime(it, NOW + 1090 * 1000);
  assert.equal(it.bus.vehicleCode, 'V1');
  assert.equal(it.status, 'run');
  retime(it, NOW + 1250 * 1000);
  assert.equal(it.bus.live, false);
  assert.equal(it.missed.key, 'V1');
  assert.equal(it.status, 'ok');
  assert.equal(it.leaveInSec, 3600 - 1250 - 600 - 120);
});

// ---------------------------------------------------------------- ranking
const mk = (arriveMin, o = {}) => ({ kind: 'bus', id: o.id || String(arriveMin), arriveAt: arriveMin == null ? null : NOW + arriveMin * 60000 + (o.sec || 0) * 1000,
  walkTo: { seconds: (o.walk ?? 5) * 60 }, walkFrom: { seconds: 0 }, bus: arriveMin == null ? null : { live: o.live ?? true }, estTotalSec: o.est ?? 0 });

test('rankItineraries: arrival time, then less walking, then live over scheduled; no departure last', () => {
  const order = (xs) => rankItineraries(xs).map((x) => x.id);
  assert.deepEqual(order([mk(30, { id: 'late' }), mk(20, { id: 'early' })]), ['early', 'late']);
  assert.deepEqual(order([mk(20, { id: 'walky', walk: 12 }), mk(20, { id: 'short', walk: 4 })]), ['short', 'walky']);
  assert.deepEqual(order([mk(20, { id: 'sched', live: false }), mk(20, { id: 'live', live: true })]), ['live', 'sched']);
  assert.deepEqual(order([mk(null, { id: 'none-b', est: 900 }), mk(null, { id: 'none-a', est: 600 }), mk(99, { id: 'ok' })]), ['ok', 'none-a', 'none-b']);
  assert.deepEqual(order([mk(20, { id: 'a', sec: 10 }), mk(20, { id: 'b', sec: 40 })]), ['a', 'b']); // same minute: stable by time
});

test('walkItinerary shape', () => {
  const w = walkItinerary({ seconds: 600, meters: 700, geometry: null, source: 'osrm' }, NOW);
  assert.equal(w.kind, 'walk');
  assert.equal(w.arriveAt, NOW + 600000);
  assert.equal(leaveState(w, NOW).kind, 'walk');
});

// ---------------------------------------------------------------- ride geometry
test('snapStopsToShape: out-and-back road does not send the return stop to the outbound leg', () => {
  // shape goes east along y=0 then returns west along y=0.00005 (opposite carriageway)
  const out = Array.from({ length: 11 }, (_, i) => [21.70 + i * 0.001, 38.24]);
  const back = Array.from({ length: 11 }, (_, i) => [21.71 - i * 0.001, 38.24005]);
  const shape = [...out, ...back];
  const stops = [
    { lat: 38.24, lng: 21.702 }, { lat: 38.24, lng: 21.708 },     // outbound
    { lat: 38.24005, lng: 21.708 }, { lat: 38.24005, lng: 21.702 }, // return (almost the same spot)
  ];
  const idx = snapStopsToShape(stops, shape);
  assert.ok(idx.every((v, i) => i === 0 || v >= idx[i - 1]), `monotone: ${idx}`);
  assert.ok(idx[0] <= 10 && idx[1] <= 10, 'outbound stops on the outbound leg');
  assert.ok(idx[2] >= 11 && idx[3] >= 11, 'return stops on the return leg');
});

test('rideGeometry: slices the shape between board and alight, capped by the stops; falls back to straight lines', () => {
  const data = mkData();
  const route = data.routeByCode.get('A1');
  const shape = Array.from({ length: 56 }, (_, i) => { const p = pt(i * 100); return [p.lng, p.lat]; });
  const g = rideGeometry(route, data.stopByCode, shape, 1, 8);
  const s1 = data.stopByCode.get('s1'), s8 = data.stopByCode.get('s8');
  assert.deepEqual(g[0], [s1.lng, s1.lat]);
  assert.deepEqual(g.at(-1), [s8.lng, s8.lat]);
  assert.ok(g.length > 8, 'uses the shape vertices, not just the stops');
  const straight = rideGeometry(route, data.stopByCode, null, 1, 8);
  assert.equal(straight.length, 8);
  assert.deepEqual(straight[0], [s1.lng, s1.lat]);
});

// ---------------------------------------------------------------- geocode (pure parts)
test('mapPhoton builds Greek-friendly labels and rejects points outside Patras', () => {
  const f = (props, c = [21.7355, 38.2466]) => ({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: c } });
  const theatre = mapPhoton(f({ name: 'Δημοτικό Θέατρο Απόλλων', street: 'Μαιζώνος', locality: 'Ανοιχτό Εμπορικό Κέντρο Πάτρας', city: 'Πάτρα' }));
  assert.deepEqual(theatre, { kind: 'place', name: 'Δημοτικό Θέατρο Απόλλων', subtitle: 'Μαιζώνος · Ανοιχτό Εμπορικό Κέντρο Πάτρας', lat: 38.2466, lng: 21.7355 });
  const addr = mapPhoton(f({ street: 'Κορίνθου', housenumber: '100', city: 'Δημοτική Ενότητα Πατρέων' }));
  assert.equal(addr.name, 'Κορίνθου 100');
  assert.equal(addr.subtitle, 'Πατρέων');
  assert.equal(mapPhoton(f({ name: 'Αθήνα' }, [23.72, 37.98])), null);
  assert.equal(mapPhoton(f({ city: 'Πάτρα' })), null);
  assert.equal(mapPhoton({ properties: { name: 'x' } }), null);
});

test('mergePlaces drops remote duplicates of local stops', () => {
  const local = [{ kind: 'stop', name: 'Πανεπιστημίου', subtitle: '', ...pt(0) }];
  const remote = [
    { kind: 'place', name: 'Πανεπιστημίου', subtitle: '', ...pt(100) },   // same name, 100 m → duplicate
    { kind: 'place', name: 'Πανεπιστημίου', subtitle: '', ...pt(5000) },  // same name, far → kept
    { kind: 'place', name: 'Κάτι άλλο', subtitle: '', ...pt(5) },         // different name, same spot → duplicate
    { kind: 'place', name: 'Θέατρο', subtitle: '', ...pt(900, 900) },
  ];
  assert.deepEqual(mergePlaces(local, remote).map((p) => p.name), ['Πανεπιστημίου', 'Πανεπιστημίου', 'Θέατρο']);
});

test('stopPlaces groups both sides of a road and prefers the side nearest to the user', () => {
  const mkStop = (code, name, x, lines) => ({ code, name, displayName: name, ...pt(x), lineCodes: lines, routeCodes: [], key: name.toLowerCase() });
  const data = { stops: [mkStop('1', 'Πανεπιστήμιο', 0, ['201']), mkStop('2', 'Πανεπιστήμιο', 3000, ['606', '201']), mkStop('3', 'Λιμάνι', 10, ['101'])] };
  const places = stopPlaces(data, 'πανεπ', { near: pt(2900) });
  assert.equal(places.length, 1);
  assert.equal(places[0].stopCode, '2');
  assert.equal(places[0].kind, 'stop');
  assert.match(places[0].subtitle, /^Στάση 2 · 201 · 606$/);
});

test('planTripsDetailed: onUpdate paints with estimates first, then with OSRM walking; final result has pending 0', async () => {
  const deps = mkDeps({ walk: ownerWalk, live: { s1: res([veh('A1', 1800)]) } });
  const slow = deps.walkRoute;
  deps.walkRoute = async (a, b) => { await new Promise((r) => setTimeout(r, 5)); return slow(a, b); };
  const updates = [];
  const out = await planTripsDetailed(ctxOf(mkData()), FROM, TO, { now: NOW, deps, onUpdate: (r) => updates.push(r) });
  assert.ok(updates.length >= 1);
  assert.ok(updates[0].pending > 0);
  assert.notEqual(busOf(updates[0]).walkTo.seconds, 600, 'first paint uses the straight-line estimate');
  assert.equal(out.pending, 0);
  assert.equal(busOf(out).leaveInSec, 1080);
});
