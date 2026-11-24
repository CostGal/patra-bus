// The chosen trip as map features (TEL-295): js/trip-map.js. No network, itineraries built by hand (TEL-290 shape).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tripFeatures, rideGeometry, drawTrip, clearTrip } from '../web/js/trip-map.js';

const S = (code, lat, lng, displayName = `Στάση ${code}`) => ({ code, name: displayName.toUpperCase(), displayName, lat, lng });
const STOPS = [S('1', 38.240, 21.730), S('2', 38.242, 21.732), S('3', 38.244, 21.734), S('4', 38.246, 21.736), S('5', 38.248, 21.738)];
const stopByCode = new Map(STOPS.map((s) => [s.code, s]));
const R = (code, lineCode, stops, confidence = 1) => ({ code, lineCode, stops, confidence });
const routes = [R('0931', '608', ['1', '2', '3', '4']), R('r2', '501', ['3', '4', '5']), R('loop', '9', ['1', '2', '3', '2', '1'])];
const routeByCode = new Map(routes.map((r) => [r.code, r]));
const lineByCode = new Map([['608', { code: '608', color: '#1a7f37' }], ['501', { code: '501', color: '#b3261e' }]]);
const DATA = { routeByCode, stopByCode, lineByCode };

const pt = (lat, lng) => ({ lat, lng, name: null });
const walk = (from, to, meters = 300, geometry = null) => ({ kind: 'walk', from, to, meters, geometry, seconds: meters / 1.3 });
const bus = (routeCode, lineCode, bi, ai, extra = {}) => {
  const r = routeByCode.get(routeCode);
  return { kind: 'bus', lineCode, routeCode, board: stopByCode.get(r.stops[bi]), alight: stopByCode.get(r.stops[ai]), boardIndex: bi, alightIndex: ai, orderEstimated: false, ...extra };
};
const HOME = pt(38.2380, 21.7280), DEST = pt(38.2490, 21.7400);
const direct = () => ({ id: 'd', legs: [walk(HOME, stopByCode.get('1')), bus('0931', '608', 0, 3), walk(stopByCode.get('4'), DEST)] });
const coords = (o) => o.fc.features[0].geometry.coordinates;

test('direct trip: walk, ride, walk, in order, ids trip-0..2; 2 markers', () => {
  const f = tripFeatures(direct(), DATA);
  assert.deepEqual(f.overlays.map((o) => o.id), ['trip-0', 'trip-1', 'trip-2']);
  assert.deepEqual(f.overlays.map((o) => o.style.kind), ['walk', 'ride', 'walk']);
  assert.deepEqual(f.markers.map((m) => m.kind), ['board', 'alight']);
});

test('a walk uses the OSRM geometry when it has it, else the straight line', () => {
  const g = [[21.728, 38.238], [21.729, 38.239], [21.730, 38.240]];
  const it = { id: 'w', legs: [walk(HOME, stopByCode.get('1'), 300, g)] };
  assert.deepEqual(coords(tripFeatures(it, DATA).overlays[0]), g);
  it.legs[0].geometry = null;
  assert.deepEqual(coords(tripFeatures(it, DATA).overlays[0]), [[HOME.lng, HOME.lat], [21.730, 38.240]]);
});

test('a walk of 20 m is not drawn', () => {
  const it = { id: 'w', legs: [walk(HOME, pt(38.2381, 21.7281), 20)] };
  assert.equal(tripFeatures(it, DATA).overlays.length, 0);
});

test("the ride has the line's colour; an unknown line has none", () => {
  assert.equal(tripFeatures(direct(), DATA).overlays[1].style.color, '#1a7f37');
  const it = { id: 'x', legs: [bus('0931', '999', 0, 2)] };
  const o = tripFeatures(it, DATA).overlays[0];
  assert.equal(o.style.kind, 'ride');
  assert.ok(!('color' in o.style));
});

test('rideGeometry: along the shape between the two stops; with no shape, the stops in order', () => {
  const r = routeByCode.get('0931');
  assert.deepEqual(rideGeometry(r, stopByCode, null, 1, 3), [[21.732, 38.242], [21.734, 38.244], [21.736, 38.246]]);
  const shape = [[21.730, 38.240], [21.731, 38.2412], [21.732, 38.242], [21.7335, 38.2432], [21.734, 38.244], [21.736, 38.246]];
  const g = rideGeometry(r, stopByCode, shape, 1, 2);
  assert.deepEqual(g, [[21.732, 38.242], [21.732, 38.242], [21.7335, 38.2432], [21.734, 38.244], [21.734, 38.244]]);
  // the shape reaches the drawing through tripFeatures
  const it = { id: 's', legs: [bus('0931', '608', 1, 2)] };
  assert.deepEqual(coords(tripFeatures(it, { ...DATA, shapes: { '0931': shape } }).overlays[0]), g);
});

test("a loop route (a stop twice): the leg's own indexes are used", () => {
  const it = { id: 'l', legs: [bus('loop', '9', 2, 4)] }; // 3 → 2 → 1, the way back
  assert.deepEqual(coords(tripFeatures(it, DATA).overlays[0]), [[21.734, 38.244], [21.732, 38.242], [21.730, 38.240]]);
});

test('a guessed stop order: exactly 2 points, marked estimated', () => {
  const it = { id: 'e', legs: [bus('0931', '608', 0, 3, { orderEstimated: true })] };
  const o = tripFeatures(it, DATA).overlays[0];
  assert.equal(coords(o).length, 2);
  assert.equal(o.style.estimated, true);
  assert.equal(o.style.color, '#1a7f37');
});

test('transfer: two stops → 5 overlays and 4 markers; the same stop → 4 overlays and 3 markers', () => {
  const two = { id: 't2', legs: [walk(HOME, stopByCode.get('1')), bus('0931', '608', 0, 1), walk(stopByCode.get('2'), stopByCode.get('3'), 200), bus('r2', '501', 0, 2), walk(stopByCode.get('5'), DEST)] };
  let f = tripFeatures(two, DATA);
  assert.equal(f.overlays.length, 5);
  assert.equal(f.markers.length, 4);
  const one = { id: 't1', legs: [walk(HOME, stopByCode.get('1')), bus('0931', '608', 0, 2), bus('r2', '501', 0, 2), walk(stopByCode.get('5'), DEST)] };
  f = tripFeatures(one, DATA);
  assert.equal(f.overlays.length, 4);
  assert.deepEqual(f.markers.map((m) => `${m.kind}:${m.code}`), ['board:1', 'board:3', 'alight:5']);
});

test('walk only: 1 overlay, no marker', () => {
  const f = tripFeatures({ id: 'w', legs: [walk(HOME, DEST, 900)] }, DATA);
  assert.equal(f.overlays.length, 1);
  assert.equal(f.markers.length, 0);
});

test('0/0 or a non-finite coordinate never reaches an overlay, a marker or the points', () => {
  const zero = S('9', 0, 0);
  const it = { id: 'z', legs: [
    walk(HOME, stopByCode.get('1'), 300, [[21.728, 38.238], [0, 0], [NaN, 38.2], [21.730, 38.240]]),
    { kind: 'bus', lineCode: '608', routeCode: 'nope', board: stopByCode.get('1'), alight: zero, boardIndex: 0, alightIndex: 1 },
    walk(zero, DEST),
  ] };
  const f = tripFeatures(it, DATA);
  const all = [...f.overlays.flatMap(coords).map(([lng, lat]) => ({ lat, lng })), ...f.markers, ...f.points];
  for (const p of all) {
    assert.ok(Number.isFinite(p.lat) && Number.isFinite(p.lng));
    assert.ok(!(p.lat === 0 && p.lng === 0));
  }
  assert.equal(f.overlays.length, 1); // only the first walk
});

test("codes stay strings: route '0931' is found as '0931'", () => {
  const f = tripFeatures(direct(), { ...DATA, routeByCode: new Map([['0931', routeByCode.get('0931')]]) });
  assert.equal(coords(f.overlays[1]).length, 4); // the four stops, not the straight fallback
});

test('labels are the stop names exactly as given', () => {
  const it = { id: 'n', legs: [{ ...bus('0931', '608', 0, 3), board: S('1', 38.24, 21.73, 'Πανεπιστημίου & Αρέθα'), alight: S('4', 38.246, 21.736, 'ΑΓ. ΑΝΔΡΕΑ') }] };
  assert.deepEqual(tripFeatures(it, DATA).markers.map((m) => m.label), ['Πανεπιστημίου & Αρέθα', 'ΑΓ. ΑΝΔΡΕΑ']);
});

test('drawTrip draws every overlay and the markers; clearTrip removes them all', () => {
  const calls = [];
  const map = {
    setOverlay: (id) => calls.push(`set ${id}`), clearOverlay: (id) => calls.push(`clear ${id}`),
    setMarkers: (id, l) => calls.push(`markers ${id} ${l.length}`), clearMarkers: (id) => calls.push(`clearMarkers ${id}`),
  };
  globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) }); // no shapes.json here
  const { points } = drawTrip(map, direct(), DATA);
  assert.ok(points.length >= 6);
  assert.deepEqual(calls, ['set trip-0', 'set trip-1', 'set trip-2', 'markers trip 2']);
  calls.length = 0;
  clearTrip(map);
  assert.deepEqual(calls, ['clear trip-0', 'clear trip-1', 'clear trip-2', 'clearMarkers trip']);
});

test('trip-map.js imports only ./data.js and asks for nothing itself', () => {
  const src = readFileSync(new URL('../web/js/trip-map.js', import.meta.url), 'utf8');
  const imports = [...src.matchAll(/^import .* from '(.+)';$/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ['./data.js']);
  for (const bad of ['fetch(', 'localStorage', 'setInterval', 'setTimeout']) assert.ok(!src.includes(bad), bad);
});
