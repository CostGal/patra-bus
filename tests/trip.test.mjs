// node --test tests/trip.test.mjs — trip core (TEL-290). No network: fetchLive / walkRoute / walkEstimate are fakes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  LIMITS, candidateTrips, shortlist, chooseDeparture, rideFor, departuresAt, retime, leaveState, rankItineraries,
  planTrips, walkItinerary,
} from '../web/js/trip.js';
import { haversine } from '../web/js/geo.js';

// ---- synthetic city: 10 stops 600 m apart on a west→east road, y = metres north
const KM = 111320;
const LNG = KM * Math.cos((38.24 * Math.PI) / 180);
const pt = (x, y = 0) => ({ lat: 38.24 + y / KM, lng: 21.70 + x / LNG });
const NOW = Date.UTC(2026, 9, 10, 19, 0, 0);

function mkRoute(code, lineCode, codes, legSec = 60, confidence = 1) {
  return { code, lineCode, name: code, displayName: code, direction: 1, stops: codes, legSec: codes.slice(1).map(() => legSec), confidence };
}
function mkData(extraRoutes = [], extraStops = [], { base = true } = {}) {
  const stops = [
    ...Array.from({ length: 10 }, (_, i) => ({ code: `s${i}`, name: `S${i}`, displayName: `Στάση ${i}`, ...pt(i * 600), key: `s${i}` })),
    ...extraStops,
  ];
  const s = (n) => Array.from({ length: n }, (_, i) => `s${i}`);
  const routes = [
    ...(base ? [
      mkRoute('A1', '201', s(10)),           // west → east, all stops
      mkRoute('B1', '202', s(10).reverse()), // east → west
      mkRoute('C1', '203', s(5)),            // short: s0..s4 only
    ] : []),
    ...extraRoutes,
  ];
  const routesByStop = new Map();
  for (const r of routes) for (const c of r.stops) (routesByStop.get(c) || routesByStop.set(c, []).get(c)).push(r);
  return { stops, routes, routesByStop, stopByCode: new Map(stops.map((x) => [x.code, x])), routeByCode: new Map(routes.map((r) => [r.code, r])) };
}
const veh = (routeCode, etaSec, o = {}) => ({
  lineCode: o.lineCode || '201', routeCode, routeName: 'ΠΡΟΣ ΝΤΕΣΤΙΝΑΣΙΟΝ', live: o.live ?? true, etaSec,
  vehicleCode: o.vehicleCode ?? null, ...(o.pos ? o.pos : o.live === false ? {} : { lat: 38.24, lng: 21.7 }),
});
const res = (vehicles, fetchedAt = NOW) => ({ fetchedAt, vehicles });
function mkDeps({ live = {}, walk = (a, b) => haversine(a, b), fail = [] } = {}) {
  const calls = { live: [], walk: 0 };
  return {
    calls,
    fetchLive: async (code) => { calls.live.push(code); if (fail.includes(code)) throw new Error('boom'); return live[code] ?? res([]); },
    walkRoute: async (a, b) => { calls.walk++; const seconds = walk(a, b); return { seconds, meters: seconds * 1.3, geometry: null, source: 'osrm' }; },
    walkEstimate: (a, b) => ({ seconds: haversine(a, b), meters: haversine(a, b) * 1.3, geometry: null, source: 'estimate' }),
  };
}
const bus = (it) => it.legs.find((l) => l.kind === 'bus');
const direct = (out) => out.itineraries.find((i) => i.kind === 'direct');

// "owner scenario": 10 min walk to s1, 2 min walk from s8, bus in 30 min, spare 2 min.
const FROM = pt(600, 300);   // 300 m north of s1
const TO = pt(4800, 0);      // at s8
const ownerWalk = (a, b) => (b.code === 's1' ? 600 : a.code === 's8' ? 120 : haversine(a, b));

// ---------------------------------------------------------------- candidates
test('candidateTrips keeps only routes where board comes before alight (direction)', () => {
  const data = mkData();
  const c = candidateTrips(data, FROM, TO);
  const codes = c.map((x) => x.route.code);
  assert.ok(codes.includes('A1'));
  assert.ok(!codes.includes('B1'), 'westbound route never reaches s8 after s1');
  assert.ok(!codes.includes('C1'), 'short route does not serve the destination');
  for (const x of c) assert.ok(x.bi < x.ai);
  assert.deepEqual(candidateTrips(data, TO, FROM).map((x) => x.route.code), ['B1']);
});

test('candidateTrips picks one (board, alight) pair per route, minimising walk + ride + walk', () => {
  const a1 = candidateTrips(mkData(), FROM, TO).filter((x) => x.route.code === 'A1');
  assert.equal(a1.length, 1);
  assert.equal(a1[0].board.code, 's1');
  assert.equal(a1[0].alight.code, 's8');
  assert.equal(a1[0].nStops, 7);
  assert.equal(a1[0].rideEst, 7 * 60);
  assert.equal(a1[0].confidence, 1);
});

test('candidateTrips drops buses when walking straight is no worse', () => {
  assert.deepEqual(candidateTrips(mkData(), pt(300, 100), pt(900, 100)), []);
});

test('candidateTrips ignores stops beyond 800 m', () => {
  const data = mkData();
  assert.deepEqual(candidateTrips(data, pt(600, 2000), TO), []);
  assert.ok(candidateTrips(data, pt(600, 2000), TO, { boardRadius: 2500 }).length > 0);
});

// ---------------------------------------------------------------- departure choice
const dep = (eta, o = {}) => ({ key: o.key || `k${eta}`, vehicleCode: o.vehicleCode ?? null, live: o.live ?? true, source: o.source || ((o.live ?? true) ? 'live' : 'scheduled'), etaSec: eta, fetchedAt: NOW, departAt: NOW + eta * 1000 });

test('chooseDeparture: owner scenario — walk 10′, bus in 30′, spare 2′ → leave in 18′', () => {
  const d = chooseDeparture([dep(1800)], { walkSec: 600, bufferSec: 120, now: NOW });
  assert.equal(d.chosen.leaveInSec, 18 * 60);
  assert.equal(d.missed, null);
  assert.equal('hurry' in d, false);
});

test('chooseDeparture: skips a bus that cannot be caught and reports it as missed', () => {
  const d = chooseDeparture([dep(300), dep(1500), dep(2700)], { walkSec: 600, bufferSec: 120, now: NOW });
  assert.equal(d.missed.remainingSec, 300);
  assert.equal(d.chosen.remainingSec, 1500);
  assert.equal(d.next.remainingSec, 2700);
});

test('chooseDeparture: boundary remaining == walk + spare is catchable with leaveIn 0', () => {
  assert.equal(chooseDeparture([dep(720)], { walkSec: 600, bufferSec: 120, now: NOW }).chosen.leaveInSec, 0);
});

test('chooseDeparture: if only a tight bus remains it is chosen (run)', () => {
  const d = chooseDeparture([dep(660)], { walkSec: 600, bufferSec: 120, now: NOW });
  assert.equal(d.chosen.remainingSec, 660);
  assert.ok(d.chosen.leaveInSec < 0);
});

test('chooseDeparture: nothing reachable → chosen null, soonest reported missed', () => {
  const d = chooseDeparture([dep(200)], { walkSec: 600, now: NOW });
  assert.equal(d.chosen, null);
  assert.equal(d.missed.remainingSec, 200);
  assert.equal(chooseDeparture([], { walkSec: 600, now: NOW }).chosen, null);
});

test('chooseDeparture: prefer keeps the bus you are about to miss instead of jumping to the next', () => {
  const list = [dep(630, { key: 'a' }), dep(2400, { key: 'b' })];
  assert.equal(chooseDeparture(list, { walkSec: 600, bufferSec: 120, now: NOW }).chosen.dep.key, 'b');
  assert.equal(chooseDeparture(list, { walkSec: 600, bufferSec: 120, now: NOW, prefer: 'a' }).chosen.dep.key, 'a');
  const gone = chooseDeparture(list, { walkSec: 600, bufferSec: 120, now: NOW + 60000, prefer: 'a' });
  assert.equal(gone.chosen.dep.key, 'b');
  assert.equal(gone.missed.dep.key, 'a');
});

// ---------------------------------------------------------------- ride time, departures
test('rideFor: same vehicle at both stops gives the exact ride; a silly match falls back to the estimate', () => {
  const board = dep(1800, { vehicleCode: 'V1' });
  assert.deepEqual(rideFor(board, [dep(2100, { vehicleCode: 'V1' }), dep(2900, { vehicleCode: 'V2' })], 420), { rideSec: 300, rideSource: 'live-match' });
  assert.equal(rideFor(board, [dep(2900, { vehicleCode: 'V9' })], 420).rideSource, 'estimate');
  assert.equal(rideFor(board, null, 420).rideSource, 'estimate');
  assert.equal(rideFor(board, [dep(1810, { vehicleCode: 'V1' })], 420).rideSource, 'estimate');        // 10 s: too short
  assert.equal(rideFor(board, [dep(1800 + 9000, { vehicleCode: 'V1' })], 420).rideSource, 'estimate'); // another lap
  assert.equal(rideFor(dep(1800), [dep(2100, { vehicleCode: 'V1' })], 420).rideSource, 'estimate');   // no vehicle code
});

test('departuresAt filters by route, removes duplicates (live wins), sorts by time, adds the source', () => {
  const route = mkData().routeByCode.get('A1');
  const d = departuresAt(route, res([
    veh('A1', 900, { live: false, vehicleCode: 'V2' }), veh('A1', 300, { vehicleCode: 'V1' }), veh('B1', 100, { vehicleCode: 'V3' }),
    veh('A1', 905, { vehicleCode: 'V2' }),
    veh('A1', 1500, { live: false }),
  ]));
  assert.deepEqual(d.map((x) => x.vehicleCode), ['V1', 'V2', null]);
  assert.equal(d[1].live, true);
  assert.deepEqual(d.map((x) => x.source), ['live', 'live', 'scheduled']);
  assert.equal(d[0].departAt, NOW + 300000);
  assert.equal(d[2].lat, undefined);
  assert.equal(departuresAt(route, null), null);
  assert.deepEqual(departuresAt(route, { fetchedAt: NOW, vehicles: [], noService: true }), []);
});

// ---------------------------------------------------------------- full plans
test('planTrips: owner scenario end to end — leave in 18′', async () => {
  const deps = mkDeps({ walk: ownerWalk, live: { s1: res([veh('A1', 1800, { vehicleCode: 'V1' })]) } });
  const out = await planTrips(mkData(), FROM, TO, { now: NOW, deps });
  const it = out.itineraries[0];
  assert.equal(it.kind, 'direct');
  assert.equal(it.transfers, 0);
  assert.equal(it.id, 'A1:s1:s8');
  assert.deepEqual(it.legs.map((l) => l.kind), ['walk', 'bus', 'walk']);
  const b = bus(it);
  assert.equal(b.routeCode, 'A1');
  assert.equal(b.lineCode, '201');
  assert.equal(b.board.code, 's1');
  assert.equal(b.alight.code, 's8');
  assert.equal(b.departSource, 'live');
  assert.equal(b.rideSource, 'estimate');
  assert.equal(b.vehicleCode, 'V1');
  assert.deepEqual(b.vehicle, { lat: 38.24, lng: 21.7 });
  assert.equal(it.legs[0].seconds, 600);
  assert.equal(it.leaveInSec, 1080);
  assert.equal(it.leaveAt, NOW + 1080 * 1000);
  assert.equal(it.leaveSource, 'live');
  assert.equal(it.arriveAt, NOW + (1800 + 7 * 60 + 120) * 1000);
  assert.equal(it.arriveSource, 'estimated');
  assert.equal(it.status, 'ok');
  assert.equal(it.estimated, false);
  assert.equal(it.legs[0].startAt, it.leaveAt);
  assert.equal(it.legs[2].endAt, it.arriveAt);
  assert.equal(leaveState(it, NOW).kind, 'later');
  assert.equal(Math.floor(leaveState(it, NOW).leaveInSec / 60), 18);
});

test('planTrips: a bus you cannot catch is skipped and reported as missed', async () => {
  const deps = mkDeps({ walk: ownerWalk, live: { s1: res([veh('A1', 300, { vehicleCode: 'V1' }), veh('A1', 2400, { live: false, vehicleCode: 'V2' })]) } });
  const it = direct(await planTrips(mkData(), FROM, TO, { now: NOW, deps }));
  assert.deepEqual(it.missed, { departAt: NOW + 300000, source: 'live', needSec: 600 });
  assert.equal(bus(it).departSource, 'scheduled');
  assert.equal(it.leaveSource, 'scheduled');
  assert.equal(it.leaveInSec, 2400 - 600 - 120);
});

test('planTrips: live-match ride gives a live arrival', async () => {
  const deps = mkDeps({ walk: ownerWalk, live: { s1: res([veh('A1', 1800, { vehicleCode: 'V1' })]), s8: res([veh('A1', 2100, { vehicleCode: 'V1' })]) } });
  const it = direct(await planTrips(mkData(), FROM, TO, { now: NOW, deps }));
  assert.equal(bus(it).rideSource, 'live-match');
  assert.equal(bus(it).rideSec, 300);
  assert.equal(it.arriveSource, 'live');
  assert.equal(it.arriveAt, NOW + (1800 + 300 + 120) * 1000);
});

test('planTrips: a route with no bus listed is kept, ranked last, with leaveInSec null', async () => {
  const data = mkData([mkRoute('A2', '204', ['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9'], 90)]);
  const deps = mkDeps({ walk: ownerWalk, live: { s1: res([veh('A2', 3000, { lineCode: '204' })]) } });
  const out = (await planTrips(data, FROM, TO, { now: NOW, deps })).itineraries;
  const a1 = out.find((i) => bus(i)?.routeCode === 'A1');
  assert.equal(a1.status, 'none');
  assert.equal(a1.leaveInSec, null);
  assert.equal(a1.leaveSource, null);
  assert.equal(a1.arriveAt, null);
  assert.equal(bus(a1).departAt, null);
  assert.equal(leaveState(a1, NOW).kind, 'none');
  assert.equal(bus(out[0]).routeCode, 'A2');
  assert.equal(bus(out.at(-1)).routeCode, 'A1');
});

test('planTrips: a failed live request sets liveError, the plan still returns', async () => {
  const out = await planTrips(mkData(), FROM, TO, { now: NOW, deps: mkDeps({ walk: ownerWalk, fail: ['s1'] }) });
  assert.ok(out.liveFailed >= 1);
  assert.equal(direct(out).liveError, true);
  assert.equal(direct(out).status, 'none');
});

test('planTrips: short trip → walk-only result; buses that do not beat the walk are dropped', async () => {
  const data = mkData();
  const A = pt(0), B = pt(1100);
  let out = (await planTrips(data, A, B, { now: NOW, deps: mkDeps({ live: { s0: res([veh('A1', 1500)]) } }) })).itineraries;
  assert.deepEqual(out.map((i) => i.kind), ['walk']);
  assert.equal(out[0].leaveInSec, 0);
  assert.equal(out[0].leaveSource, null);
  assert.equal(out[0].arriveSource, 'estimated');
  assert.equal(out[0].arriveAt, NOW + out[0].legs[0].seconds * 1000);
  out = (await planTrips(data, A, B, { now: NOW, deps: mkDeps({ live: { s0: res([veh('A1', 300)]) } }) })).itineraries;
  assert.deepEqual(out.map((i) => i.kind), ['direct', 'walk']);
});

test('planTrips: with no bus a walk up to ~45′ is offered first; a long walk is not offered when the bus is faster', async () => {
  let out = (await planTrips(mkData(), FROM, pt(3000, 0), { now: NOW, deps: mkDeps() })).itineraries;
  assert.equal(out[0].kind, 'walk');
  out = (await planTrips(mkData(), FROM, TO, { now: NOW, deps: mkDeps({ walk: ownerWalk, live: { s1: res([veh('A1', 900)]) } }) })).itineraries;
  assert.ok(out.every((i) => i.kind === 'direct'));
});

test('planTrips: empty-state reasons', async () => {
  const deps = mkDeps();
  const data = mkData();
  const far = { lat: 40.6, lng: 22.9 };
  assert.equal((await planTrips(data, far, TO, { now: NOW, deps })).reason, 'outside-from');
  assert.equal((await planTrips(data, FROM, far, { now: NOW, deps })).reason, 'outside-to');
  assert.equal((await planTrips({ ...data, routes: [] }, FROM, TO, { now: NOW, deps })).reason, 'no-data');
  assert.equal((await planTrips(data, pt(300, 5000), TO, { now: NOW, deps })).reason, 'no-board-stops');
  assert.equal((await planTrips(data, FROM, pt(2400, 5000), { now: NOW, deps })).reason, 'no-alight-stops');
  const onlyB = mkData([mkRoute('B1', '202', Array.from({ length: 10 }, (_, i) => `s${9 - i}`))], [], { base: false });
  assert.equal((await planTrips(onlyB, FROM, TO, { now: NOW, deps })).reason, 'no-route');
});

test('planTrips: AbortError when the signal is aborted', async () => {
  const ctl = new AbortController();
  const p = planTrips(mkData(), FROM, TO, { now: NOW, deps: mkDeps({ walk: ownerWalk }), signal: ctl.signal });
  ctl.abort();
  await assert.rejects(p, { name: 'AbortError' });
});

test('planTrips: missing deps is a clear error', async () => {
  await assert.rejects(planTrips(mkData(), FROM, TO, { now: NOW }), /trip: deps missing/);
});

test('planTrips: the walk cache means a second plan does not ask OSRM again', async () => {
  const deps = mkDeps({ walk: ownerWalk });
  const walkCache = new Map();
  await planTrips(mkData(), FROM, TO, { now: NOW, deps, walkCache });
  const first = deps.calls.walk;
  assert.ok(first > 0);
  await planTrips(mkData(), FROM, TO, { now: NOW + 20000, deps, walkCache });
  assert.equal(deps.calls.walk, first);
});

test('retime + leaveState over time: later, now, run, then the next bus', async () => {
  const deps = mkDeps({ walk: ownerWalk, live: { s1: res([veh('A1', 1800, { vehicleCode: 'V1' }), veh('A1', 3600, { live: false })]) } });
  const it = direct(await planTrips(mkData(), FROM, TO, { now: NOW, deps }));
  assert.equal(leaveState(it, NOW + 1018 * 1000).kind, 'later');
  assert.equal(leaveState(it, NOW + 1030 * 1000).kind, 'now');
  assert.equal(leaveState(it, NOW + 1090 * 1000).kind, 'run');
  assert.equal(leaveState(it, NOW + 1250 * 1000).kind, 'missed');
  retime(it, NOW + 1090 * 1000);
  assert.equal(bus(it).vehicleCode, 'V1', 'sticky: keeps the bus you are running for');
  assert.equal(it.status, 'run');
  retime(it, NOW + 1250 * 1000);
  assert.equal(bus(it).departSource, 'scheduled');
  assert.equal(it.missed.departAt, NOW + 1800 * 1000);
  assert.equal(it.status, 'ok');
  assert.equal(it.leaveInSec, 3600 - 1250 - 600 - 120);
});

test('planTrips: onUpdate fires first with estimates, the final result has pending 0', async () => {
  const deps = mkDeps({ walk: ownerWalk, live: { s1: res([veh('A1', 1800)]) } });
  const updates = [];
  const out = await planTrips(mkData(), FROM, TO, { now: NOW, deps, onUpdate: (r) => updates.push(r) });
  assert.ok(updates.length >= 1);
  assert.ok(updates[0].pending > 0);
  assert.equal(updates[0].itineraries[0].legs[0].source, 'estimate');
  assert.equal(out.pending, 0);
  assert.equal(out.itineraries[0].legs[0].source, 'osrm');
});

test('rankItineraries: earlier arrival, then less walking, then live before scheduled; no bus last', () => {
  const mk = (arriveMin, o = {}) => ({
    id: o.id, kind: 'direct', arriveAt: arriveMin == null ? null : NOW + arriveMin * 60000 + (o.sec || 0) * 1000,
    legs: [{ kind: 'walk', seconds: (o.walk ?? 5) * 60 }, { kind: 'bus', rideSec: o.ride ?? 0, departSource: o.src ?? 'live' }, { kind: 'walk', seconds: 0 }],
  });
  const order = (xs) => rankItineraries(xs).map((x) => x.id);
  assert.deepEqual(order([mk(30, { id: 'late' }), mk(20, { id: 'early' })]), ['early', 'late']);
  assert.deepEqual(order([mk(20, { id: 'walky', walk: 12 }), mk(20, { id: 'short', walk: 4 })]), ['short', 'walky']);
  assert.deepEqual(order([mk(20, { id: 'sched', src: 'scheduled' }), mk(20, { id: 'live' })]), ['live', 'sched']);
  assert.deepEqual(order([mk(null, { id: 'none-b', ride: 900 }), mk(null, { id: 'none-a', ride: 600 }), mk(99, { id: 'ok' })]), ['ok', 'none-a', 'none-b']);
});

test('walkItinerary shape', () => {
  const w = walkItinerary({ seconds: 600, meters: 700, geometry: null, source: 'osrm' }, FROM, TO, NOW);
  assert.equal(w.kind, 'walk');
  assert.equal(w.legs.length, 1);
  assert.equal(w.arriveAt, NOW + 600000);
  assert.equal(w.arriveSource, 'estimated');
  assert.equal(leaveState(w, NOW).kind, 'walk');
});

// ---------------------------------------------------------------- guards (one per rule of the card)
test('guard: trip.js imports only ./geo.js and has no network, storage or timers', () => {
  const src = readFileSync(new URL('../web/js/trip.js', import.meta.url), 'utf8');
  const imports = [...src.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ['./geo.js']);
  for (const bad of [/\bimport\s*\(/, /\bfetch\s*\(/, /localStorage/, /setInterval/, /setTimeout/]) assert.doesNotMatch(src, bad);
});

// 6 routes from 6 distinct board stops north of s1 to s8: more than the budget allows.
function wideData() {
  const nStops = [0, 1, 2, 3, 4, 5].map((k) => ({ code: `n${k}`, name: `N${k}`, displayName: `N${k}`, ...pt(1200 + k * 40, 100), key: `n${k}` }));
  const extra = nStops.flatMap((n, i) => ['s7', 's8', 's9'].map((a, j) => mkRoute(`X${i}${j}`, `9${i}${j}`, [n.code, a])));
  return mkData(extra, nStops);
}

test('guard: at most 3 itineraries per plan', async () => {
  const data = wideData();
  const live = Object.fromEntries(['n0', 'n1', 'n2', 'n3', 'n4', 'n5'].map((c, i) => [c, res(['0', '1', '2'].map((j) => veh(`X${i}${j}`, 600 + i * 60, { lineCode: `9${i}${j}` })))]));
  const out = await planTrips(data, pt(1200, 100), pt(4800, 0), { now: NOW, deps: mkDeps({ live }) });
  assert.ok(candidateTrips(data, pt(1200, 100), pt(4800, 0)).length >= 6);
  assert.ok(out.itineraries.length > 0 && out.itineraries.length <= LIMITS.maxResults);
});

test('guard: at most 5 distinct live stops, each once per plan', async () => {
  const deps = mkDeps({ walk: ownerWalk });
  await planTrips(wideData(), pt(1200, 100), pt(4800, 0), { now: NOW, deps });
  assert.ok(deps.calls.live.length > 0 && deps.calls.live.length <= LIMITS.maxLiveStops, deps.calls.live.join());
  assert.equal(new Set(deps.calls.live).size, deps.calls.live.length);
});

test('guard: OSRM is asked at most 6 times per plan', async () => {
  const deps = mkDeps({ walk: ownerWalk });
  await planTrips(wideData(), pt(1200, 100), pt(4800, 0), { now: NOW, deps });
  assert.ok(deps.calls.walk <= LIMITS.maxOsrmLegs);
});

test('guard: every time carries an allowed source', async () => {
  const deps = mkDeps({ walk: ownerWalk, live: { s1: res([veh('A1', 1800, { vehicleCode: 'V1' }), veh('A1', 2400, { live: false })]) } });
  const out = await planTrips(mkData(), FROM, TO, { now: NOW, deps });
  for (const it of out.itineraries) {
    assert.ok([null, 'live', 'scheduled'].includes(it.leaveSource));
    assert.ok(['live', 'estimated'].includes(it.arriveSource));
    for (const l of it.legs) {
      if (l.kind === 'walk') assert.ok(['osrm', 'estimate'].includes(l.source));
      else {
        assert.ok([null, 'live', 'scheduled', 'estimated'].includes(l.departSource));
        assert.ok(['live', 'estimated'].includes(l.arriveSource));
        assert.ok(['live-match', 'estimate'].includes(l.rideSource));
      }
    }
  }
});

test('guard: leave-in only from a live or scheduled row', () => {
  const b = { kind: 'bus', rideEstSec: 420, departures: [dep(1800, { source: 'estimated', live: false })] };
  const it = { id: 'x', kind: 'direct', legs: [{ kind: 'walk', seconds: 600 }, b, { kind: 'walk', seconds: 120 }], bufferSec: 120, confidence: 1 };
  retime(it, NOW);
  assert.equal(b.departSource, 'estimated');
  assert.equal(it.leaveInSec, null);
  assert.equal(it.leaveSource, null);
  assert.equal(it.estimated, true);
  assert.equal(leaveState(it, NOW).kind, 'none');
});

test('guard: a low-confidence route is kept and marked estimated', async () => {
  const all = Array.from({ length: 10 }, (_, i) => `s${i}`);
  for (const [conf, want] of [[0.5, true], [0.9, false], [null, true]]) { // null: missing confidence counts as 0
    const d2 = mkData([mkRoute('A1', '201', all, 60, conf)], [], { base: false });
    const deps = mkDeps({ walk: ownerWalk, live: { s1: res([veh('A1', 1800)]) } });
    const it = direct(await planTrips(d2, FROM, TO, { now: NOW, deps }));
    assert.ok(it, `kept at confidence ${conf}`);
    assert.equal(it.estimated, want, `confidence ${conf}`);
    assert.equal(bus(it).orderEstimated, want);
  }
});

test('guard: codes stay strings with their leading zeros', async () => {
  const z = { code: '093', name: 'Z', displayName: 'Z', ...pt(600), key: '093' };
  const data = mkData([mkRoute('0931', '093', ['s0', '093', 's2', 's3', 's4', 's5', 's6', 's7', 's8'])], [z], { base: false });
  data.stops = data.stops.filter((s) => s.code !== 's1');
  const deps = mkDeps({ walk: (a, b) => haversine(a, b), live: { '093': res([veh('0931', 1800, { lineCode: '093', vehicleCode: '0412' })]) } });
  const it = direct(await planTrips(data, FROM, TO, { now: NOW, deps }));
  assert.equal(bus(it).board.code, '093');
  assert.equal(bus(it).routeCode, '0931');
  assert.equal(bus(it).lineCode, '093');
  assert.equal(bus(it).vehicleCode, '0412');
  assert.ok(deps.calls.live.includes('093'));
  for (const c of deps.calls.live) assert.equal(typeof c, 'string');
});

test('guard: a row at 0/0 never becomes a vehicle position', async () => {
  const deps = mkDeps({ walk: ownerWalk, live: { s1: res([veh('A1', 1800, { live: false, pos: { lat: 0, lng: 0 } }), veh('A1', 2400, { pos: { lat: 0, lng: 0 } })]) } });
  const it = direct(await planTrips(mkData(), FROM, TO, { now: NOW, deps }));
  assert.equal(bus(it).departSource, 'scheduled');
  assert.equal(bus(it).vehicle, null);
  retime(it, NOW + 1500 * 1000);
  assert.equal(bus(it).departSource, 'live');
  assert.equal(bus(it).vehicle, null);
});

test('guard: no itinerary id contains a coordinate of the start', async () => {
  const deps = mkDeps({ walk: ownerWalk, live: { s1: res([veh('A1', 1800)]) } });
  for (const [a, b] of [[FROM, TO], [pt(0), pt(1100)]]) {
    const out = await planTrips(mkData(), a, b, { now: NOW, deps });
    for (const it of out.itineraries) {
      for (const n of [a.lat, a.lng]) for (const d of [2, 3, 4, 5]) assert.ok(!it.id.includes(n.toFixed(d)), `${it.id} has ${n.toFixed(d)}`);
    }
  }
});
