// node --test tests/trip.test.mjs — trip core (TEL-290). No network: fetchLive / walkRoute / walkEstimate are fakes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  LIMITS, candidateTrips, shortlist, chooseDeparture, rideFor, departuresAt, retime, leaveState, rankItineraries,
  planTrips, walkItinerary, transferCandidates, shortlistTransfers, buildTransfer, hideWeakTransfers,
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

// ================================================================ transfers (TEL-292)
// Line 601 runs p0→p3, line 201 runs p3→q3 (stops 600 m apart on one road): only a change links the two ends.
const S = (code, x, y = 0) => ({ code, name: code, displayName: code, ...pt(x, y), key: code });
function mkNet(stops, routes) {
  const routesByStop = new Map();
  for (const r of routes) for (const c of r.stops) (routesByStop.get(c) || routesByStop.set(c, []).get(c)).push(r);
  return { stops, routes, routesByStop, stopByCode: new Map(stops.map((x) => [x.code, x])), routeByCode: new Map(routes.map((r) => [r.code, r])) };
}
const netStops = () => [S('p0', 0), S('p1', 600), S('p2', 1200), S('p3', 1800), S('q1', 2400), S('q2', 3000), S('q3', 3600)];
const net = (o = {}) => mkNet([...netStops(), ...(o.stops || [])], [
  mkRoute('T1', '601', ['p0', 'p1', 'p2', 'p3']),
  mkRoute('T2', '201', o.t2 || ['p3', 'q1', 'q2', 'q3']),
  ...(o.routes || []),
]);
const XFROM = pt(0, 100), XTO = pt(3600, 100);   // ≈100 m from p0 and from q3, 3.6 km apart
const a1 = (eta, o = {}) => veh('T1', eta, { lineCode: '601', vehicleCode: 'V1', ...o });
const b1 = (eta, o = {}) => veh('T2', eta, { lineCode: '201', ...o });
const xplan = (data, live, o = {}) => planTrips(data, XFROM, XTO, { now: NOW, ...o, deps: mkDeps({ live, ...(o.deps || {}) }) });
const xferOf = (out) => out.itineraries.find((i) => i.kind === 'transfer');
const busA = (it) => it.legs.filter((l) => l.kind === 'bus')[0];
const busB = (it) => it.legs.filter((l) => l.kind === 'bus')[1];
const near = (a, b, tol = 1.5) => assert.ok(Math.abs(a - b) <= tol, `${a} ≉ ${b}`);

// ---- kept from the old planner tests
test('transferCandidates: finds the change when no single bus links the ends', () => {
  const data = net();
  assert.deepEqual(candidateTrips(data, XFROM, XTO), []);
  const c = transferCandidates(data, XFROM, XTO);
  assert.equal(c.length, 1);
  assert.deepEqual([c[0].a.route.code, c[0].a.board.code, c[0].x1.code, c[0].x2.code, c[0].b.route.code, c[0].b.alight.code], ['T1', 'p0', 'p3', 'p3', 'T2', 'q3']);
  assert.equal(c[0].xferMeters, 0);
  assert.equal(c[0].a.nStops + c[0].b.nStops, 6);
});

test('transferCandidates: skips trips a single bus already makes, and "changes" between routes of one line', () => {
  assert.deepEqual(transferCandidates(mkData(), FROM, TO), [], 'A1 serves both ends');
  const sameLine = net();
  sameLine.routeByCode.get('T2').lineCode = '601';
  assert.deepEqual(transferCandidates(sameLine, XFROM, XTO), []);
});

test('transferCandidates: walk between stops only within ~300 m; low-confidence routes cost more', () => {
  const c = transferCandidates(net({ stops: [S('h2', 1800, 150)], t2: ['h2', 'q1', 'q2', 'q3'] }), XFROM, XTO);
  assert.equal(c.length, 1);
  assert.equal(c[0].x2.code, 'h2');
  near(c[0].xferMeters, 150, 3);
  assert.deepEqual(transferCandidates(net({ stops: [S('h2', 1800, 450)], t2: ['h2', 'q1', 'q2', 'q3'] }), XFROM, XTO), []);
  const two = net({ routes: [mkRoute('T3', '202', ['p3', 'q1', 'q2', 'q3'])] });
  two.routeByCode.get('T2').confidence = 0.3; // shaky route
  assert.deepEqual(transferCandidates(two, XFROM, XTO).map((x) => x.b.route.code), ['T3', 'T2']);
});

test('shortlistTransfers: stays inside the shared live budget of 5 stops', () => {
  const c = transferCandidates(net(), XFROM, XTO);
  assert.equal(shortlistTransfers(c).length, 1);
  assert.equal(shortlistTransfers(c, new Set(['a', 'b', 'c', 'd', 'e'])).length, 0, 'no room for two more stops');
  assert.equal(shortlistTransfers(c, new Set(['a', 'b', 'c', 'p0'])).length, 1, 'p0 is already asked, only p3 is new');
});

test('planTrips: transfer-only network → a two-bus itinerary with exact timing when bus B is listed', async () => {
  const out = await xplan(net(), { p0: res([a1(600)]), p3: res([b1(1500)]) });
  assert.equal(out.itineraries.length, 1);
  const it = out.itineraries[0];
  assert.equal(it.kind, 'transfer');
  assert.equal(it.transfers, 1);
  assert.equal(it.id, 'T1:p0:p3~T2:p3:q3');
  assert.deepEqual(it.legs.map((l) => l.kind), ['walk', 'bus', 'bus', 'walk'], 'same stop: no walk between the buses');
  assert.deepEqual([busA(it).routeCode, busA(it).lineCode, busA(it).board.code, busA(it).alight.code], ['T1', '601', 'p0', 'p3']);
  assert.deepEqual([busB(it).routeCode, busB(it).lineCode, busB(it).board.code, busB(it).alight.code], ['T2', '201', 'p3', 'q3']);
  assert.equal(it.transfer.stop.code, 'p3');
  assert.equal(it.transfer.toStop, it.transfer.stop);
  assert.equal(it.transfer.sameStop, true);
  assert.equal(it.transfer.walkSec, 0);
  near(it.leaveInSec, 600 - it.legs[0].seconds - 120);           // first bus: same rule as a direct trip
  assert.equal(it.leaveSource, 'live');
  assert.equal(leaveState(it, NOW).kind, 'later');
  assert.equal(busA(it).rideSec, 180);                            // 3 legs × 60 s (estimate)
  assert.equal(busA(it).rideSource, 'estimate');
  assert.equal(it.transfer.arriveAt, NOW + 780 * 1000);           // at the change stop
  assert.equal(it.transfer.arriveSource, 'estimated');
  assert.equal(it.transfer.waitSec, 720);                         // B at +1500 s
  assert.equal(it.transfer.waitMaxSec, null);
  assert.equal(it.transfer.waitSource, 'live');
  assert.equal(busB(it).departAt, NOW + 1500 * 1000);
  assert.equal(busB(it).departSource, 'live');
  near(it.arriveAt, NOW + (1500 + 180 + it.legs[3].seconds) * 1000, 5);
  assert.equal(it.estimated, false);
  assert.equal(it.rankPenaltySec, 300);
});

test('transfer: a missed connection moves on to the next bus B, transfer.missed is filled', async () => {
  const it = xferOf(await xplan(net(), { p0: res([a1(600)]), p3: res([b1(800, { vehicleCode: 'W1' }), b1(1500, { live: false })]) }));
  assert.equal(busB(it).departAt, NOW + 1500 * 1000, 'B due at +800 leaves before we are ready (+780 +78 margin)');
  assert.equal(busB(it).departSource, 'scheduled');
  assert.equal(it.transfer.waitSource, 'scheduled');
  assert.deepEqual(it.transfer.missed, { departAt: NOW + 800 * 1000, source: 'live' });
  // margin boundary: ready at 780 + 60 + 18 (10 % of an estimated 180 s ride) = 858 s
  assert.equal(busB(xferOf(await xplan(net(), { p0: res([a1(600)]), p3: res([b1(858), b1(2000)]) }))).departAt, NOW + 858 * 1000);
  assert.equal(busB(xferOf(await xplan(net(), { p0: res([a1(600)]), p3: res([b1(857), b1(2000)]) }))).departAt, NOW + 2000 * 1000);
});

test('transfer: same stop → bus A is listed there too, so the ride time is exact (live-match)', async () => {
  const it = xferOf(await xplan(net(), { p0: res([a1(600)]), p3: res([a1(900), b1(1700)]) }));
  assert.equal(busA(it).rideSource, 'live-match');
  assert.equal(busA(it).rideSec, 300);
  assert.equal(it.transfer.arriveAt, NOW + 900 * 1000);
  assert.equal(it.transfer.arriveSource, 'live');
  assert.equal(it.transfer.waitSec, 800);                         // 1700 − 900
  assert.equal(busB(it).departAt, NOW + 1700 * 1000);             // margin is only 60 s now
});

test('transfer: across the road the walk comes before the wait; live is asked at the stop bus B leaves from', async () => {
  const data = net({ stops: [S('h2', 1800, 150)], t2: ['h2', 'q1', 'q2', 'q3'] });
  const deps = mkDeps({ live: { p0: res([a1(600)]), h2: res([b1(1500)]) } });
  const it = xferOf(await planTrips(data, XFROM, XTO, { now: NOW, deps }));
  assert.deepEqual(it.legs.map((l) => l.kind), ['walk', 'bus', 'walk', 'bus', 'walk']);
  assert.deepEqual([it.transfer.stop.code, it.transfer.toStop.code, it.transfer.sameStop], ['p3', 'h2', false]);
  near(it.transfer.walkSec, 150, 3);
  assert.equal(it.legs[2].source, 'estimate', 'no OSRM call for the walk between the change stops');
  near(it.transfer.waitSec, 1500 - 780 - it.transfer.walkSec, 1);
  assert.deepEqual([...deps.calls.live].sort(), ['h2', 'p0']);
  const tight = xferOf(await xplan(data, { p0: res([a1(600)]), h2: res([b1(900), b1(2100)]) }));
  assert.equal(busB(tight).departAt, NOW + 2100 * 1000);
  assert.equal(tight.transfer.missed.departAt, NOW + 900 * 1000);
});

test('transfer: retime picks the next bus A and re-derives bus B', async () => {
  const live = { p0: res([a1(600), a1(1800, { vehicleCode: 'V2', live: false })]), p3: res([b1(1500), b1(2400)]) };
  const it = xferOf(await xplan(net(), live));
  assert.equal(busB(it).departAt, NOW + 1500 * 1000);
  const later = NOW + 520 * 1000; // first bus (+600) is out of reach: 80 s left < the 100 s walk
  assert.equal(leaveState(it, later).kind, 'missed');
  retime(it, later);
  assert.equal(busA(it).vehicleCode, 'V2');
  assert.equal(it.leaveSource, 'scheduled');
  assert.equal(it.transfer.arriveAt, NOW + (1800 + 180) * 1000);
  assert.equal(busB(it).departAt, NOW + 2400 * 1000);             // 1500 is gone; ready at 1980 + 78
  assert.equal(it.missed.departAt, NOW + 600 * 1000);
});

test('planTrips: direct and transfer side by side — the earlier arrival is first', async () => {
  const live = { p0: res([a1(600), veh('D1', 700, { lineCode: '301' })]), p3: res([b1(1500)]) };
  const slow = await xplan(net({ routes: [mkRoute('D1', '301', ['p0', 'p2', 'q2', 'q3'], 900)] }), live); // 30′ ride to q2
  assert.deepEqual(slow.itineraries.map((i) => i.kind), ['transfer', 'direct']);
  const fast = await xplan(net({ routes: [mkRoute('D1', '301', ['p0', 'p2', 'q2', 'q3'], 200)] }), live);
  assert.equal(fast.itineraries[0].kind, 'direct', 'direct arrives first');
});

test('rankItineraries: a transfer carries a 5′ handicap and a direct bus wins a tie; unknown arrival last', () => {
  const mk = (kind, arriveMin, id, pen = 0) => ({
    id, kind, rankPenaltySec: pen, arriveAt: arriveMin == null ? null : NOW + arriveMin * 60000,
    legs: [{ kind: 'walk', seconds: 0 }, { kind: 'bus', rideSec: 0, departSource: 'live' }, { kind: 'walk', seconds: 0 }],
  });
  const order = (xs) => rankItineraries(xs).map((x) => x.id);
  assert.deepEqual(order([mk('transfer', 20, 'x', 300), mk('direct', 24, 'd')]), ['d', 'x'], 'direct 24 < transfer 20 + 5');
  assert.deepEqual(order([mk('transfer', 18, 'x', 300), mk('direct', 24, 'd')]), ['x', 'd'], 'transfer 18 + 5 < 24');
  assert.deepEqual(order([mk('transfer', 20, 'x', 300), mk('direct', 25, 'd')]), ['d', 'x'], 'tie → direct');
  assert.deepEqual(order([mk('direct', 25, 'd'), mk('transfer', 20, 'x', 300)]), ['d', 'x'], 'tie → direct, input order irrelevant');
  assert.deepEqual(order([mk('transfer', 18, 'est', 600), mk('transfer', 20, 'sure', 300)]), ['sure', 'est'], 'estimated wait ranks lower');
  assert.deepEqual(order([mk('transfer', null, 'unknown', 600), mk('direct', 90, 'd')]), ['d', 'unknown']);
});

// ---- new: the three wait cases
test('transfer case 2: two listed buses 15′ apart, none after the ready time → wait range, estimated', async () => {
  // bus A at +1200 s reaches p3 at +1380; ready at +1458. B listed at +100 and +1000 only.
  const it = xferOf(await xplan(net(), { p0: res([a1(1200)]), p3: res([b1(100), b1(1000)]) }));
  assert.equal(it.transfer.waitSource, 'estimated');
  assert.equal(it.transfer.waitSec, 450);
  assert.equal(it.transfer.waitMaxSec, 900);
  assert.equal(busB(it).departSource, 'estimated');
  assert.equal(busB(it).departAt, NOW + (1380 + 450) * 1000);
  assert.equal(it.estimated, true);
  assert.equal(it.arriveSource, 'estimated');
  assert.equal(it.rankPenaltySec, 600);
  assert.equal(typeof it.leaveInSec, 'number');
  assert.equal(it.leaveSource, 'live', '"leave in" still comes from bus A');
});

test('transfer case 3: one or zero listed buses → wait unknown, no departure and no arrival', async () => {
  for (const p3 of [res([b1(300)]), res([])]) {
    const it = xferOf(await xplan(net(), { p0: res([a1(600)]), p3 }));
    assert.ok(it, 'shown when there is no direct trip');
    assert.equal(it.transfer.waitSec, null);
    assert.equal(it.transfer.waitMaxSec, null);
    assert.equal(it.transfer.waitSource, 'estimated');
    assert.equal(busB(it).departAt, null);
    assert.equal(busB(it).departSource, 'estimated');
    assert.equal(it.arriveAt, null);
    assert.equal(it.estimated, true);
    assert.equal(typeof it.leaveInSec, 'number');
    assert.equal(it.leaveSource, 'live');
    // no flat wait: nothing equals "arrival at the change + 600 s"
    const flat = it.transfer.arriveAt + 600 * 1000;
    for (const l of it.legs) for (const v of [l.departAt, l.arriveAt, l.startAt, l.endAt]) assert.notEqual(v, flat);
    assert.notEqual(it.arriveAt, flat);
  }
});

test('transfer: with no bus A listed there is no "leave in" and the plan drops it', async () => {
  const data = net();
  const cand = transferCandidates(data, XFROM, XTO)[0];
  const w = { seconds: 100, meters: 130, geometry: null, source: 'estimate' };
  const it = buildTransfer(cand, { boardRes: res([]), changeRes: res([b1(1500)]), walkTo: w, walkFrom: w, from: XFROM, to: XTO, now: NOW });
  assert.equal(it.status, 'none');
  assert.equal(it.leaveInSec, null);
  assert.equal(it.leaveSource, null);
  assert.equal(it.transfer.waitSec, null);
  assert.equal(it.transfer.waitSource, 'estimated');
  assert.equal(xferOf(await xplan(data, { p0: res([]), p3: res([b1(1500)]) })), undefined);
});

// ---- new: when a transfer is hidden
const mkD = (arriveMin, o = {}) => ({
  id: o.id || `d${arriveMin}`, kind: 'direct', arriveAt: arriveMin == null ? null : NOW + arriveMin * 60000,
  confidence: o.confidence ?? 1, estimated: (o.confidence ?? 1) < 0.7, rankPenaltySec: 0,
  legs: [{ kind: 'walk', seconds: 0 }, { kind: 'bus', rideSec: 0, departSource: 'live' }, { kind: 'walk', seconds: 0 }],
});
const mkT = (arriveMin, waitSource, o = {}) => ({
  ...mkD(arriveMin, { id: o.id || `t${arriveMin}` }), kind: 'transfer', confidence: o.confidence ?? 1,
  estimated: waitSource === 'estimated', rankPenaltySec: 300, transfer: { waitSource },
});
const shown = (directs, transfers) => hideWeakTransfers(directs, transfers).map((t) => t.id);

test('hideWeakTransfers case 1 (known wait): a direct 4′ later hides it, 6′ later does not', () => {
  assert.deepEqual(shown([mkD(24)], [mkT(20, 'live')]), []);
  assert.deepEqual(shown([mkD(26)], [mkT(20, 'scheduled')]), ['t20']);
});

test('hideWeakTransfers case 2 (wait range): a direct 9′ later hides it, 11′ later does not', () => {
  assert.deepEqual(shown([mkD(29)], [mkT(20, 'estimated')]), []);
  assert.deepEqual(shown([mkD(31)], [mkT(20, 'estimated')]), ['t20']);
});

test('hideWeakTransfers case 3 (wait unknown): any direct bus hides it; with no direct trip it is shown', () => {
  assert.deepEqual(shown([mkD(90)], [mkT(null, 'estimated')]), []);
  assert.deepEqual(shown([], [mkT(null, 'estimated', { id: 'u' })]), ['u']);
  assert.deepEqual(shown([mkD(null)], [mkT(null, 'estimated', { id: 'u' })]), ['u'], 'a direct trip with no bus is no rival');
});

test('hideWeakTransfers: a low-confidence direct trip does not hide a transfer on two good routes; at most 2 shown', () => {
  assert.deepEqual(shown([mkD(21, { confidence: 0.5 })], [mkT(20, 'live', { confidence: 0.9 })]), ['t20']);
  assert.deepEqual(shown([mkD(21, { confidence: 0.5 })], [mkT(20, 'live', { confidence: 0.5 })]), []);
  assert.deepEqual(shown([], [mkT(30, 'live'), mkT(20, 'live'), mkT(25, 'live')]), ['t20', 't25']);
});

// ---- new: guards with transfers
// Six boarding stops near the start, six lines to a hub, six lines out of it: many more options than the budgets allow.
function hubNet() {
  const stops = [], routes = [], live = {};
  for (let i = 0; i < 6; i++) {
    stops.push(S(`b${i}`, i * 60, 40), S(`x${i}`, 1800 + i * 40, 60), S(`a${i}`, 3600 - i * 60, 40));
    routes.push(mkRoute(`R${i}`, `5${i}`, [`b${i}`, `x${i}`]), mkRoute(`Q${i}`, `7${i}`, [`x${i}`, `a${i}`]));
    live[`b${i}`] = res([veh(`R${i}`, 600 + i * 30, { lineCode: `5${i}` })]);
    live[`x${i}`] = res([veh(`Q${i}`, 1500 + i * 30, { lineCode: `7${i}` })]);
  }
  return { data: mkNet(stops, routes), live };
}

test('guard: never two changes — every itinerary has at most 2 bus legs', async () => {
  const { data, live } = hubNet();
  const out = await planTrips(data, pt(0, 100), pt(3600, 100), { now: NOW, deps: mkDeps({ live }) });
  assert.ok(out.itineraries.some((i) => i.kind === 'transfer'));
  for (const it of out.itineraries) {
    assert.ok(it.legs.filter((l) => l.kind === 'bus').length <= 2);
    assert.ok([0, 1].includes(it.transfers));
  }
});

test('guard: with transfers, at most 3 results, 5 distinct live stops each once, 6 OSRM calls, 2 transfers', async () => {
  const { data, live } = hubNet();
  const deps = mkDeps({ live });
  const out = await planTrips(data, pt(0, 100), pt(3600, 100), { now: NOW, deps });
  assert.ok(out.itineraries.length > 0 && out.itineraries.length <= LIMITS.maxResults);
  assert.ok(deps.calls.live.length > 0 && deps.calls.live.length <= LIMITS.maxLiveStops, deps.calls.live.join());
  assert.equal(new Set(deps.calls.live).size, deps.calls.live.length);
  assert.ok(deps.calls.walk <= LIMITS.maxOsrmLegs);
  assert.ok(out.itineraries.filter((i) => i.kind === 'transfer').length <= LIMITS.maxTransfers);
});

test('guard: every bus leg and the transfer object carry sources from the allowed list', async () => {
  const cases = [
    { p0: res([a1(600)]), p3: res([a1(900), b1(1700)]) },                          // case 1, live-match
    { p0: res([a1(600, { live: false })]), p3: res([b1(1500, { live: false })]) }, // case 1, scheduled
    { p0: res([a1(1200)]), p3: res([b1(100), b1(1000)]) },                         // case 2
    { p0: res([a1(600)]), p3: res([]) },                                           // case 3
  ];
  for (const live of cases) {
    const it = xferOf(await xplan(net(), live));
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
    assert.ok(['live', 'scheduled', 'estimated'].includes(it.transfer.waitSource));
    assert.ok(['live', 'estimated'].includes(it.transfer.arriveSource));
    if (it.transfer.waitMaxSec != null || it.transfer.waitSec == null) assert.equal(it.transfer.waitSource, 'estimated', 'an estimated wait never gets a row source');
  }
});

test('guard: codes with leading zeros survive in the transfer id and legs', async () => {
  const stops = [S('001', 0), S('002', 600), S('003', 1200), S('004', 1800), S('010', 2400), S('011', 3000), S('012', 3600)];
  const data = mkNet(stops, [mkRoute('0601', '060', ['001', '002', '003', '004']), mkRoute('0201', '020', ['004', '010', '011', '012'])]);
  const deps = mkDeps({ live: { '001': res([veh('0601', 600, { lineCode: '060', vehicleCode: '0412' })]), '004': res([veh('0201', 1500, { lineCode: '020' })]) } });
  const it = xferOf(await planTrips(data, XFROM, XTO, { now: NOW, deps }));
  assert.equal(it.id, '0601:001:004~0201:004:012');
  assert.deepEqual([busA(it).routeCode, busA(it).lineCode, busA(it).board.code, busA(it).vehicleCode], ['0601', '060', '001', '0412']);
  assert.deepEqual([busB(it).routeCode, busB(it).lineCode, busB(it).alight.code], ['0201', '020', '012']);
  assert.equal(it.transfer.stop.code, '004');
  for (const c of deps.calls.live) assert.equal(typeof c, 'string');
  assert.deepEqual([...deps.calls.live].sort(), ['001', '004']);
});

test('planTrips: neither a direct nor a transfer option → reason no-route', async () => {
  const lonely = mkNet(netStops(), [mkRoute('T1', '601', ['p0', 'p1', 'p2']), mkRoute('T2', '201', ['q1', 'q2', 'q3'])]);
  const out = await xplan(lonely, {});
  assert.deepEqual(out.itineraries, []);
  assert.equal(out.reason, 'no-route');
});
