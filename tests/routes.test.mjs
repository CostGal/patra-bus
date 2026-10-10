import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as B from '../scripts/build-routes.mjs';

const lat0 = 38.2, lng0 = 21.7;
const P = (i, j = 0, extra = {}) => ({ code: String(100 + i), name: `S${i}`, lat: lat0 + i * 0.001, lng: lng0 + j * 0.001, ...extra });
// deterministic shuffle
const shuffle = (a) => { const r = a.slice(); let s = 7; for (let i = r.length - 1; i > 0; i--) { s = (s * 48271) % 2147483647; const j = s % (i + 1); [r[i], r[j]] = [r[j], r[i]]; } return r; };
const isMonotone = (o) => o.every((x, i) => i === 0 || x > o[i - 1]) || o.every((x, i) => i === 0 || x < o[i - 1]);

// ---------------------------------------------------------------- basics
test('haversine, kendallTau, pathLength', () => {
  assert.ok(Math.abs(B.haversine({ lat: 38, lng: 21 }, { lat: 39, lng: 21 }) - 111195) < 200);
  assert.equal(B.haversine(P(0), P(0)), 0);
  assert.equal(B.kendallTau([1, 2, 3, 4], [10, 20, 30, 40]), 1);
  assert.equal(B.kendallTau([1, 2, 3, 4], [4, 3, 2, 1]), -1);
  assert.equal(B.kendallTau([1], [1]), 0);
  const pts = [P(0), P(1), P(2)];
  assert.ok(Math.abs(B.pathLength(pts, [0, 1, 2]) - 2 * B.haversine(P(0), P(1))) < 1e-6);
});

test('legSecFromCar applies factor, dwell and a minimum; legSecFromDistance is the offline estimate', () => {
  assert.equal(B.legSecFromCar(100), Math.round(100 * B.K.BUS_FACTOR + B.K.DWELL_SEC));
  assert.equal(B.legSecFromCar(0), B.K.MIN_LEG_SEC);
  assert.equal(B.legSecFromCar(2), B.K.MIN_LEG_SEC);
  assert.equal(B.legSecFromDistance(1000), Math.round((1000 * B.K.ROAD_FACTOR) / B.K.OFFLINE_SPEED + B.K.DWELL_SEC));
  assert.equal(B.legSecFromDistance(0), B.K.MIN_LEG_SEC);
});

// ---------------------------------------------------------------- Douglas-Peucker
test('douglasPeucker: collinear points collapse, corners and first/last survive', () => {
  const line = Array.from({ length: 50 }, (_, i) => [21.7 + i * 0.0001, 38.2]);
  assert.deepEqual(B.douglasPeucker(line, 8), [line[0], line[49]]);
  const L = [...Array.from({ length: 20 }, (_, i) => [21.7 + i * 0.0001, 38.2]), ...Array.from({ length: 20 }, (_, i) => [21.7 + 19 * 0.0001, 38.2 + (i + 1) * 0.0001])];
  const out = B.douglasPeucker(L, 8);
  assert.deepEqual(out, [L[0], L[19], L[L.length - 1]]);
  assert.deepEqual(B.douglasPeucker([[1, 2]], 8), [[1, 2]]);
  assert.deepEqual(B.douglasPeucker([[1, 2], [3, 4]], 8), [[1, 2], [3, 4]]);
});

test('douglasPeucker: tolerance is in metres', () => {
  // a point ~5.5 m off the straight line: dropped at 8 m, kept at 2 m
  const pts = [[21.7, 38.2], [21.7005, 38.20005], [21.701, 38.2]];
  assert.equal(B.douglasPeucker(pts, 8).length, 2);
  assert.equal(B.douglasPeucker(pts, 2).length, 3);
});

test('simplifyShape rounds to 5 decimals and drops repeats', () => {
  const out = B.simplifyShape([[21.7000001, 38.2], [21.7000002, 38.2], [21.7123456, 38.2123456], [21.7123457, 38.2123457]], 0.1);
  for (const [x, y] of out) { assert.equal(x, Math.round(x * 1e5) / 1e5); assert.equal(y, Math.round(y * 1e5) / 1e5); }
  assert.deepEqual(out, [[21.7, 38.2], [21.71235, 38.21235]]);
});

// ---------------------------------------------------------------- NN + 2-opt
test('bestOpenPath recovers a shuffled line (free ends and fixed ends)', () => {
  const line = Array.from({ length: 15 }, (_, i) => P(i));
  const mix = shuffle(line);
  const o = B.bestOpenPath(mix);
  assert.equal(o.length, 15);
  assert.ok(isMonotone(o.map((i) => Number(mix[i].code))), 'monotone along the line');
  const first = mix.findIndex((p) => p.code === '100'), last = mix.findIndex((p) => p.code === '114');
  const f = B.nnTwoOpt(mix, first, last);
  assert.deepEqual(f.map((i) => Number(mix[i].code)), line.map((p) => Number(p.code)));
  const rev = B.nnTwoOpt(mix, last, first);
  assert.deepEqual(rev.map((i) => Number(mix[i].code)), line.map((p) => Number(p.code)).reverse());
});

test('bestOpenPath untangles a curved route and is a permutation', () => {
  const pts = Array.from({ length: 25 }, (_, i) => ({ code: String(i), name: 'x', lat: lat0 + 0.01 * Math.sin(i / 4), lng: lng0 + i * 0.001 }));
  const mix = shuffle(pts);
  const o = B.bestOpenPath(mix);
  assert.deepEqual([...o].sort((a, b) => a - b), mix.map((_, i) => i));
  assert.ok(isMonotone(o.map((i) => Number(mix[i].code))));
});

test('bestOpenPath on a ring cuts it at one gap (loop-like routes get adjacent end points)', () => {
  const n = 16;
  const ring = Array.from({ length: n }, (_, i) => ({ code: String(i), name: 'r', lat: lat0 + 0.003 * Math.sin((2 * Math.PI * i) / n), lng: lng0 + 0.003 * Math.cos((2 * Math.PI * i) / n) }));
  const o = B.bestOpenPath(shuffle(ring));
  const pts = shuffle(ring);
  const o2 = B.bestOpenPath(pts);
  const gap = B.haversine(ring[0], ring[1]);
  assert.ok(B.pathLength(pts, o2) < (n - 1) * gap * 1.05, 'open path ~ circumference minus one gap');
  assert.ok(B.haversine(pts[o2[0]], pts[o2[n - 1]]) < gap * 1.5, 'end points are neighbours on the ring');
  assert.equal(o.length, n);
});

test('bestOpenPath handles tiny inputs', () => {
  assert.deepEqual(B.bestOpenPath([P(0)]), [0]);
  assert.deepEqual(B.bestOpenPath([P(0), P(1)]), [0, 1]);
  assert.deepEqual(B.bestOpenPath([]), []);
  assert.equal(B.bestOpenPath([P(2), P(0), P(1)]).length, 3);
});

// ---------------------------------------------------------------- names
test('nameTokens: accents, case, final sigma, punctuation and Latin look-alikes', () => {
  assert.deepEqual(B.nameTokens('ΠΑΝΕΠΙΣΤΗΜΙΟΥ & ΑΡΕΘΑ'), ['πανεπιστημιου', 'αρεθα']);
  assert.deepEqual(B.nameTokens('ΖΑΡΟΥΧΛEIKA'), ['ζαρουχλεικα']);   // Latin E, I, K, A inside a Greek word
  assert.deepEqual(B.nameTokens('ΑΡΟH ΚΕΝΤΡΟ'), ['αροη', 'κεντρο']); // Latin H
  assert.deepEqual(B.nameTokens('ΝΙΚΗΣ Α.'), ['νικησ']);            // 1-letter tokens dropped
  assert.deepEqual(B.nameTokens('EXPRESS'), ['express']);          // pure Latin stays
});

test('tokenMatch tolerates Greek inflection but not unrelated words', () => {
  assert.ok(B.tokenMatch('εγλυκαδα', 'εγλυκαδασ'));
  assert.ok(B.tokenMatch('εγλυκαδα', 'εγλυκαδοσ'));
  assert.ok(B.tokenMatch('λυκοχωρο', 'λυκοχωροσ'));
  assert.ok(B.tokenMatch('πανεπιστημιο', 'πανεπιστημιακο'));
  assert.ok(!B.tokenMatch('ερμου', 'ερμησ'));
  assert.ok(!B.tokenMatch('κεντρο', 'κεντ'));
  assert.ok(B.tokenMatch('ab', 'ab'));
  assert.ok(!B.tokenMatch('ab', 'abc'));
});

test('parseRouteName: hyphen chunks, plain sequences, centre, return flag, school suffixes', () => {
  const tok = (n) => B.parseRouteName(n).items.map((i) => (i.center ? (i.implicit ? '(c)' : 'C') : i.token) + '@' + i.p.toFixed(1));
  assert.deepEqual(tok('ΤΕΡΨΙΘΕΑ-ΕΓΛΥΚΑΔΑ'), ['τερψιθεα@0.0', 'εγλυκαδα@1.0']);
  assert.deepEqual(tok('ΕΓΛΥΚΑΔΑ ΤΕΡΨΙΘΕΑ'), ['εγλυκαδα@0.0', 'τερψιθεα@1.0']);
  assert.deepEqual(tok('ΚΑΛΛΙΘΕΑ'), ['καλλιθεα@1.0', '(c)@0.0']);                    // lone place = centre -> place
  assert.deepEqual(tok('ΒΟΥΝΤΕΝΗ-ΚΕΝΤΡΟ'), ['βουντενη@0.0', 'C@1.0']);
  assert.deepEqual(tok('ΑΝΩ ΚΑΣΤΡΙΤΣΙ'), ['καστριτσι@1.0', '(c)@0.0']);                // ΑΝΩ is noise
  assert.deepEqual(tok('EXPRESS - ΚΕΝΤΡΟ-'), ['C@1.0']);
  assert.deepEqual(tok('ΣΧΟΛΙΚΟ ΡΙΟ-ΚΑΣΤΕΛΟΚΑΜΠΟΣ (μετάβαση)-Ν1'), ['ριο@0.0', 'καστελοκαμποσ@1.0']);
  assert.deepEqual(tok('ΣΧΟΛΙΚΟ ΡΙΟ-ΚΑΣΤΕΛΟΚΑΜΠΟΣ (επιστροφή)-Ν1'), ['ριο@1.0', 'καστελοκαμποσ@0.0']);  // return = reversed
  assert.deepEqual(tok('ΤΣΟΥΚΑΛΕΙΚΑ ΕΠΙΣΤΡΟΦΗ'), ['τσουκαλεικα@0.0', '(c)@1.0']);      // place -> centre
  assert.deepEqual(tok('ΣΧΟΛΙΚΟ ΕΛΕΚΙΣΤΡΑ (μεταβαση)'), ['ελεκιστρα@1.0']);              // school: no implicit centre
  assert.equal(B.parseRouteName('ΣΧΟΛΙΚΟ ΕΛΕΚΙΣΤΡΑ (επιστροφη)').flags.ret, true);
  assert.deepEqual(tok(''), []);
});

// Mini city: ALFA in the north, BHTA in the south, a generic street word everywhere.
const city = [
  { code: 'a1', name: 'ΑΛΦΑ ΤΕΡΜΑ', lat: 38.30, lng: 21.7 },
  { code: 'a2', name: 'ΑΛΦΑ ΣΧΟΛΕΙΟ', lat: 38.299, lng: 21.7 },
  { code: 'b1', name: 'ΒΗΤΑΣ', lat: 38.20, lng: 21.7 },
  { code: 'g1', name: 'ΑΓ. ΙΩΑΝΝΗΣ', lat: 38.25, lng: 21.7 },
  { code: 'g2', name: 'ΑΓ. ΝΙΚΟΛΑΟΣ', lat: 38.26, lng: 21.71 },
  { code: 'g3', name: 'ΑΓ. ΓΕΩΡΓΙΟΣ', lat: 38.27, lng: 21.69 },
];
const idx = B.buildNameIndex(city);
const byCode = (c) => city.find((s) => s.code === c);

test('buildNameIndex.find matches by stem and is cached', () => {
  assert.deepEqual(idx.find('αλφα').map((s) => s.code), ['a1', 'a2']);
  assert.deepEqual(idx.find('βητα').map((s) => s.code), ['b1']);   // ΒΗΤΑΣ inflection
  assert.equal(idx.find('αλφα'), idx.find('αλφα'));
  assert.deepEqual(idx.find('ζζζζ'), []);
});

test('itemLocations weighs rare compact words above generic ones', () => {
  const rare = B.itemLocations({ token: 'βητα' }, idx).weight;
  const generic = B.itemLocations({ token: 'αγ' }, idx).weight;
  assert.ok(rare > generic, `${rare} > ${generic}`);
  assert.equal(B.itemLocations({ token: 'ζζζζ' }, idx).weight, 0);
  assert.equal(B.itemLocations({ center: true, p: 1 }, idx).members.length, 1);
  assert.ok(B.itemLocations({ center: true, p: 0, implicit: true }, idx).weight < B.itemLocations({ center: true, p: 1 }, idx).weight);
});

test('orientationEvidence: terminal matching decides direction', () => {
  const { items } = B.parseRouteName('ΑΛΦΑ-ΒΗΤΑ');
  const fwd = B.orientationEvidence(items, idx, byCode('a1'), byCode('b1'));
  const rev = B.orientationEvidence(items, idx, byCode('b1'), byCode('a1'));
  assert.ok(fwd.e > 0.9 && fwd.w > 0.5, JSON.stringify(fwd));
  assert.ok(rev.e < -0.9);
  const none = B.orientationEvidence(B.parseRouteName('ΖΖΖΖ-ΩΩΩΩ').items, idx, byCode('a1'), byCode('b1'));
  assert.deepEqual(none, { e: 0, w: 0 });
});

test('orientationEvidence: a lone place name means centre -> place', () => {
  const { items } = B.parseRouteName('ΒΗΤΑ');
  const north = { lat: 38.246, lng: 21.7346 };            // ~ the centre
  assert.ok(B.orientationEvidence(items, idx, north, byCode('b1')).e > 0);
  assert.ok(B.orientationEvidence(items, idx, byCode('b1'), north).e < 0);
});

test('terminalMatches: start / end places near the chosen end points', () => {
  const { items } = B.parseRouteName('ΑΛΦΑ-ΒΗΤΑ');
  assert.equal(B.terminalMatches(items, idx, byCode('a1'), 'start'), true);
  assert.equal(B.terminalMatches(items, idx, byCode('a1'), 'end'), false);
  assert.equal(B.terminalMatches(items, idx, byCode('b1'), 'end'), true);
  assert.equal(B.terminalMatches(items, idx, byCode('g1'), 'start'), false);
  // the implicit centre of a lone place name is evidence for orientation, not a terminal match
  assert.equal(B.terminalMatches(B.parseRouteName('ΒΗΤΑ').items, idx, B.K.CENTER, 'start'), false);
});

// ---------------------------------------------------------------- side-of-road test
// A road running east along lat 38.2. In right-hand traffic the stops of an eastbound bus sit SOUTH of it.
const roadGeom = Array.from({ length: 11 }, (_, i) => [21.7 + i * 0.001, 38.2]);
const mkStops = (dLat) => Array.from({ length: 6 }, (_, i) => ({ lng: 21.7 + i * 0.002, lat: 38.2 + dLat }));
const snapOf = (ss) => ss.map((s) => [s.lng, 38.2]);
const legsOf = (ss) => ss.slice(1).map((s, i) => B.haversine(ss[i], s));

test('sideTest: stops on the right of the travel direction score +1, on the left -1', () => {
  const south = mkStops(-0.00005), north = mkStops(0.00005);          // ~5.5 m off the centre line
  const r = B.sideTest(roadGeom, legsOf(south), snapOf(south), south);
  assert.deepEqual([r.right, r.left, r.score], [6, 0, 1]);
  const l = B.sideTest(roadGeom, legsOf(north), snapOf(north), north);
  assert.deepEqual([l.right, l.left, l.score], [0, 6, -1]);
  // westbound along the same road swaps the sides
  const back = B.sideTest(roadGeom.slice().reverse(), legsOf(south), snapOf(south).reverse(), south.slice().reverse());
  assert.equal(back.score, -1);
});

test('sideTest ignores stops on the centre line and degenerate input', () => {
  const on = mkStops(0.0000001);
  const r = B.sideTest(roadGeom, legsOf(on), snapOf(on), on);
  assert.deepEqual([r.right, r.left, r.score], [0, 0, 0]);
  assert.deepEqual(B.sideTest([], [], [], []), { right: 0, left: 0, score: 0 });
  assert.deepEqual(B.sideTest(roadGeom, [], [[21.7, 38.2]], [{ lng: 21.7, lat: 38.2 }]), { right: 0, left: 0, score: 0 });
});

test('sideTest follows the geometry by distance, so an out-and-back road is not ambiguous', () => {
  // out along the road (east) and back (west) over the same coordinates; the stop on the south is on the right on
  // the way out and on the left on the way back
  const out = roadGeom, back = roadGeom.slice(0, -1).reverse();
  const geom = [...out, ...back];
  const s1 = { lng: 21.703, lat: 38.2 - 0.00005 }, s2 = { lng: 21.703, lat: 38.2 - 0.00005 };
  const stops = [{ lng: 21.7, lat: 38.2 }, s1, { lng: 21.71, lat: 38.2 }, s2, { lng: 21.7, lat: 38.2 }];
  const snapped = stops.map((s) => [s.lng, 38.2]);
  const legs = [B.haversine(stops[0], stops[1]), B.haversine(stops[1], stops[2]), B.haversine(stops[2], stops[3]), B.haversine(stops[3], stops[4])];
  const r = B.sideTest(geom, legs, snapped, stops);
  assert.deepEqual([r.right, r.left], [1, 1]);
});

// ---------------------------------------------------------------- confidence
test('computeConfidence: bounded, monotone, offline capped', () => {
  const best = B.computeConfidence({ terminal: 1, orient: 1, consistency: 1, pathRatio: 1, carRatio: 1.2, jumps: 0, osrm: true });
  assert.ok(best >= 0.95 && best <= 1, String(best));
  const worst = B.computeConfidence({ terminal: 0, orient: 0, consistency: 0, pathRatio: 3, carRatio: 5, jumps: 3, osrm: true });
  assert.ok(worst >= 0 && worst < 0.1, String(worst));
  const base = { terminal: 0.7, orient: 0.7, consistency: 0.7, pathRatio: 1, carRatio: 1.3, jumps: 0, osrm: true };
  assert.ok(B.computeConfidence({ ...base, pathRatio: 1.6 }) < B.computeConfidence(base));
  assert.ok(B.computeConfidence({ ...base, carRatio: 2.8 }) < B.computeConfidence(base));
  assert.ok(B.computeConfidence({ ...base, consistency: 0.1 }) < B.computeConfidence(base));
  assert.ok(B.computeConfidence({ ...base, terminal: 0.2 }) < B.computeConfidence(base));
  assert.ok(B.computeConfidence({ ...base, jumps: 1 }) < B.computeConfidence(base));
  assert.ok(B.computeConfidence({ ...base, osrm: false }) <= 0.4);
  assert.ok(B.computeConfidence({ ...base, consistency: null }) > 0);   // unknown consistency is neutral, not zero
  assert.equal(B.computeConfidence({ terminal: 1, orient: 1, consistency: 1, osrm: false }), 0.4);
});

// ---------------------------------------------------------------- consistency between routes
test('consistency: same-direction siblings agree, a reversed copy does not', () => {
  const stopByCode = new Map();
  const codes = Array.from({ length: 8 }, (_, i) => { const c = `s${i}`; stopByCode.set(c, { code: c, lat: lat0 + i * 0.002, lng: lng0 }); return c; });
  const mk = (code, stops, name = 'R') => ({ code, name, stops });
  const same = B.consistency([mk('A', codes), mk('B', codes)], stopByCode);
  assert.equal(same.get('A').value, 1);
  const rev = B.consistency([mk('A', codes), mk('B', codes.slice().reverse())], stopByCode);
  assert.equal(rev.get('A').value, 0);
  assert.ok(rev.get('A').notes[0].includes('vs B'));
  assert.equal(B.consistency([mk('A', codes)], stopByCode).get('A').value, null);   // nothing to compare with
});

test('consistency: opposite-direction partner found by proximity must run reversed', () => {
  const stopByCode = new Map();
  const mkStops = (prefix, dLng) => Array.from({ length: 10 }, (_, i) => { const c = `${prefix}${i}`; stopByCode.set(c, { code: c, lat: lat0 + i * 0.002, lng: lng0 + dLng }); return c; });
  const a = mkStops('a', 0), b = mkStops('b', 0.0002);      // ~18 m away, other side of the road
  const ok = B.consistency([{ code: 'A', name: 'x', stops: a }, { code: 'B', name: 'y', stops: b.slice().reverse() }], stopByCode);
  assert.equal(ok.get('A').value, 1);
  assert.equal(ok.get('B').value, 1);
  const bad = B.consistency([{ code: 'A', name: 'x', stops: a }, { code: 'B', name: 'y', stops: b }], stopByCode);
  assert.equal(bad.get('A').value, 0);
  assert.ok(bad.get('A').notes[0].includes('not reversed'));
});

test('consistency: school outbound/return pairs sharing stops are expected to mirror each other', () => {
  const stopByCode = new Map();
  const codes = Array.from({ length: 6 }, (_, i) => { const c = `k${i}`; stopByCode.set(c, { code: c, lat: lat0 + i * 0.002, lng: lng0 }); return c; });
  const r = B.consistency([{ code: 'go', name: 'ΣΧΟΛΙΚΟ Χ (μετάβαση)', stops: codes }, { code: 'back', name: 'ΣΧΟΛΙΚΟ Χ (επιστροφή)', stops: codes.slice().reverse() }], stopByCode);
  assert.equal(r.get('go').value, 1);
});

// ---------------------------------------------------------------- OSRM client (fake fetch)
const tripBody = (n, order) => ({
  code: 'Ok',
  waypoints: Array.from({ length: n }, (_, i) => ({ waypoint_index: order.indexOf(i), trips_index: 0, location: [21.7, 38.2], distance: 3 })),
  trips: [{ geometry: { coordinates: [[21.7, 38.2], [21.71, 38.2]] }, legs: Array.from({ length: n - 1 }, () => ({ duration: 30, distance: 200 })), duration: 30 * (n - 1), distance: 200 * (n - 1) }],
});
const fakeRes = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

test('createOsrm: parses a trip, caches on disk, replays without network', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'osrm-'));
  try {
    const calls = [];
    const fetchImpl = async (url, init) => { calls.push({ url, init }); return fakeRes(200, tripBody(4, [0, 2, 1, 3])); };
    const cacheDir = pathToFileURL(dir + '/');
    const o = B.createOsrm({ cacheDir, servers: ['https://osrm.example/routed-car'], fetchImpl, minGapMs: 0 });
    const pts = [P(0), P(1), P(2), P(3)];
    const t = await o.trip(pts);
    assert.deepEqual(t.order, [0, 2, 1, 3]);
    assert.equal(t.legs.length, 3);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.startsWith('https://osrm.example/routed-car/trip/v1/driving/'));
    assert.ok(calls[0].url.includes('roundtrip=false&source=first&destination=last'));
    assert.ok(calls[0].url.includes(`${pts[0].lng.toFixed(5)},${pts[0].lat.toFixed(5)};`));
    assert.match(calls[0].init.headers['User-Agent'], /^patra-bus\/2 \(github\.com\/CostGal\/patra-bus\)$/);
    assert.equal((await readdir(dir)).length, 1);
    const t2 = await o.trip(pts);
    assert.deepEqual(t2.order, t.order);
    assert.equal(calls.length, 1, 'second call served from the cache');
    assert.equal(o.stats.cached, 1);
    const off = B.createOsrm({ cacheDir, servers: [], fetchImpl, offline: true });
    assert.deepEqual((await off.trip(pts)).order, [0, 2, 1, 3]);
    await assert.rejects(off.trip([P(0), P(1), P(5), P(6)]), /offline/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('createOsrm: retries on 5xx, then falls back to the next server; definitive errors skip to the next server', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'osrm-'));
  try {
    const seen = [];
    const fetchImpl = async (url) => {
      seen.push(url.split('/trip/')[0]);
      if (url.startsWith('https://a.example')) return fakeRes(200, { code: 'NoTrips', message: 'nope' });
      if (url.startsWith('https://b.example') && seen.filter((x) => x.includes('b.example')).length < 2) return fakeRes(503, {});
      return fakeRes(200, tripBody(3, [0, 1, 2]));
    };
    const sleepless = B.createOsrm({ cacheDir: pathToFileURL(dir + '/'), servers: ['https://a.example', 'https://b.example'], fetchImpl, minGapMs: 0 });
    // 503 triggers a 2 s backoff in the client; keep the test fast by only asserting the first definitive failure path
    const t = await Promise.race([sleepless.trip([P(0), P(1), P(2)]), new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 8000))]);
    assert.deepEqual(t.order, [0, 1, 2]);
    assert.deepEqual(seen.slice(0, 2), ['https://a.example', 'https://b.example']);
    assert.ok(seen.length >= 3);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('createOsrm: rejects malformed trips', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'osrm-'));
  try {
    const bad = tripBody(3, [1, 0, 2]);                 // first input is not first in the trip
    const o = B.createOsrm({ cacheDir: pathToFileURL(dir + '/'), servers: ['https://x.example'], fetchImpl: async () => fakeRes(200, bad), minGapMs: 0 });
    await assert.rejects(o.trip([P(0), P(1), P(2)]), /bad permutation/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- processRoute with a simulated OSRM
// Road along lat 38.2 heading east; stops are 5.5 m off it, on the south side (= right of an eastbound bus).
function simOsrm(side) {
  const snap = (p) => [p.lng, 38.2];
  const lineOf = (ordered) => ordered.map(snap);
  const legs = (ordered) => ordered.slice(1).map((p, i) => ({ duration: 40, distance: Math.round(B.haversine(ordered[i], p)) }));
  const calls = { trip: 0, route: 0 };
  return {
    calls,
    stats: { cached: 0, network: 0 },
    async trip(pts) {
      calls.trip++;
      const a = pts[0], b = pts[pts.length - 1], dir = Math.sign(b.lng - a.lng) || 1;
      const order = pts.map((_, i) => i).sort((i, j) => dir * (pts[i].lng - pts[j].lng));
      // keep the pinned ends where they must be
      const ord = [0, ...order.filter((i) => i !== 0 && i !== pts.length - 1), pts.length - 1];
      const o = ord.map((i) => pts[i]);
      return { order: ord, geometry: lineOf(o), legs: legs(o), waypoints: o.map((p) => ({ location: snap(p), distance: 5 })), duration: 40 * (pts.length - 1), distance: 1 };
    },
    async route(pts) {
      calls.route++;
      return { geometry: lineOf(pts), legs: legs(pts), waypoints: pts.map((p) => ({ location: snap(p), distance: 5 })), duration: 40 * (pts.length - 1), distance: legs(pts).reduce((s, l) => s + l.distance, 0) };
    },
    side,
  };
}
const roadStops = (n, dLat) => Array.from({ length: n }, (_, i) => ({ code: String(200 + i), name: `R${i}`, lat: 38.2 + dLat, lng: 21.7 + i * 0.002 }));
const ctx = (osrm) => ({ index: B.buildNameIndex([]), osrm, log: () => {} });

test('processRoute: eastbound route with stops on the right keeps the guessed direction', async () => {
  const pts = shuffle(roadStops(10, -0.00005));
  const sim = simOsrm();
  // name gives no clue; natural ends are the two extremes, guess = heuristic start
  const r = await B.processRoute({ code: 'T1', lineCode: 'L', name: 'ΖΖΖ', direction: 1 }, pts, ctx(sim));
  assert.equal(r.stops.length, 10);
  assert.equal(r.legSec.length, 9);
  assert.ok(r.legSec.every((x) => x === B.legSecFromCar(40)));
  assert.ok(isMonotone(r.stops.map(Number)));
  assert.ok(r.shape.length >= 2);
  assert.match(r.method, /^osrm-trip/);
  assert.equal(r.diag.side.left, 0);
  assert.equal(sim.calls.route, 1);
});

test('processRoute: a westbound-looking guess is flipped when all stops are on the left, and the route call uses the flipped order', async () => {
  const pts = roadStops(10, 0.00005);          // north side: right of a WEST-bound bus
  const sim = simOsrm();
  const r = await B.processRoute({ code: 'T2', lineCode: 'L', name: 'ΖΖΖ', direction: 2 }, shuffle(pts), ctx(sim));
  const lngs = r.stops.map((c) => pts.find((p) => p.code === c).lng);
  assert.ok(lngs.every((x, i) => i === 0 || x < lngs[i - 1]), 'westbound order');
  assert.ok(r.diag.side.right >= 9 && r.diag.side.left === 0, JSON.stringify(r.diag.side));
  assert.ok(sim.calls.trip <= 2 && sim.calls.route === 1);
});

test('processRoute: name evidence wins when the side test has nothing to say', async () => {
  const stops = [
    { code: 's1', name: 'ΑΛΦΑ', lat: 38.2, lng: 21.7 }, { code: 's2', name: 'ΧΧΧ', lat: 38.2, lng: 21.702 },
    { code: 's3', name: 'ΨΨΨ', lat: 38.2, lng: 21.704 }, { code: 's4', name: 'ΒΗΤΑ', lat: 38.2, lng: 21.706 },
  ];                                            // exactly on the road: no side information
  const index = B.buildNameIndex(stops);
  const fwd = await B.processRoute({ code: 'T3', lineCode: 'L', name: 'ΑΛΦΑ-ΒΗΤΑ', direction: 1 }, shuffle(stops), { index, osrm: simOsrm(), log: () => {} });
  assert.deepEqual(fwd.stops, ['s1', 's2', 's3', 's4']);
  const rev = await B.processRoute({ code: 'T4', lineCode: 'L', name: 'ΒΗΤΑ-ΑΛΦΑ', direction: 2 }, shuffle(stops), { index, osrm: simOsrm(), log: () => {} });
  assert.deepEqual(rev.stops, ['s4', 's3', 's2', 's1']);
  assert.ok(fwd.parts.terminal > 0.9);
});

test('processRoute: OSRM failure falls back to the offline heuristic with a low confidence cap', async () => {
  const failing = { stats: {}, trip: async () => { throw new Error('boom'); }, route: async () => { throw new Error('boom'); } };
  const pts = shuffle(roadStops(8, -0.00005));
  const r = await B.processRoute({ code: 'T5', lineCode: 'L', name: 'ΖΖΖ', direction: 1 }, pts, ctx(failing));
  assert.equal(r.method, 'offline-2opt');
  assert.ok(isMonotone(r.stops.map(Number)));
  assert.equal(r.legSec.length, 7);
  assert.ok(r.legSec.every((x) => x >= B.K.MIN_LEG_SEC));
  assert.equal(r.parts.osrm, false);
  assert.ok(B.computeConfidence({ ...r.parts, consistency: null }) <= 0.4);
  assert.ok(r.diag.flags.includes('osrm-failed'));
  assert.ok(r.shape.length >= 2);
});

test('processRoute: one-stop and two-stop routes', async () => {
  const one = await B.processRoute({ code: 'T6', lineCode: 'L', name: 'X', direction: 1 }, [P(0)], ctx(simOsrm()));
  assert.deepEqual([one.stops, one.legSec, one.method], [['100'], [], 'single']);
  const two = await B.processRoute({ code: 'T7', lineCode: 'L', name: 'X', direction: 1 }, [P(0), P(1)], ctx(simOsrm()));
  assert.equal(two.stops.length, 2);
  assert.equal(two.legSec.length, 1);
});
