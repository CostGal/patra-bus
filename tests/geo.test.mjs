import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  haversine, bearing, fmtDist, nearestStops, inArea, PATRAS_BBOX, normDeg, angleDiff, lerpAngle,
  metersToLatLngDelta, offsetPoint, destinationPoint, pointAlong, pathLength, closestOnPath,
} from '../web/js/geo.js';

const raw = JSON.parse(readFileSync(new URL('../web/data/stops.json', import.meta.url), 'utf8'));
const stops = raw.map((s) => ({ code: String(s.code), name: s.name, lat: s.latitude, lng: s.longitude }));
const CENTER = { lat: 38.2466, lng: 21.7346 }; // Patras, Plateia Georgiou
const near = (a, b, eps) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b} (±${eps})`);

// deterministic PRNG so failures are reproducible
function rng(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }

test('haversine: zero, symmetry, known distances', () => {
  assert.equal(haversine(CENTER, CENTER), 0);
  const a = CENTER, b = { lat: 38.2566, lng: 21.7346 }; // 0.01° of latitude = 1112 m
  near(haversine(a, b), 1111.95, 1);
  assert.equal(haversine(a, b), haversine(b, a));
  // Patras → Athens (Syntagma 37.9755, 23.7348) is ~ 175 km as the crow flies
  near(haversine(CENTER, { lat: 37.9755, lng: 23.7348 }) / 1000, 178, 5);
  // 0.01° of longitude at 38.25° is ~ 874 m
  near(haversine(a, { lat: a.lat, lng: a.lng + 0.01 }), 874, 3);
});

test('bearing: cardinal directions', () => {
  near(bearing(CENTER, { lat: CENTER.lat + 0.01, lng: CENTER.lng }), 0, 0.01);
  near(bearing(CENTER, { lat: CENTER.lat, lng: CENTER.lng + 0.01 }), 90, 0.2);
  near(bearing(CENTER, { lat: CENTER.lat - 0.01, lng: CENTER.lng }), 180, 0.01);
  near(bearing(CENTER, { lat: CENTER.lat, lng: CENTER.lng - 0.01 }), 270, 0.2);
  // 874 m east, 1112 m north → atan(874/1112) ≈ 38.2°
  near(bearing(CENTER, { lat: CENTER.lat + 0.01, lng: CENTER.lng + 0.01 }), 38.2, 0.3);
  // equal metric offsets give exactly 45°
  near(bearing(CENTER, offsetPoint(CENTER, 500, 500)), 45, 0.2);
});

test('fmtDist', () => {
  assert.equal(fmtDist(0), '0 μ');
  assert.equal(fmtDist(184), '180 μ');
  assert.equal(fmtDist(186), '190 μ');
  assert.equal(fmtDist(999), '1000 μ');
  assert.equal(fmtDist(1000), '1,0 χλμ');
  assert.equal(fmtDist(1530), '1,5 χλμ');
  assert.equal(fmtDist(NaN), '—');
});

test('inArea / PATRAS_BBOX', () => {
  assert.ok(inArea(CENTER));
  assert.ok(!inArea({ lat: 37.9755, lng: 23.7348 })); // Athens
  assert.ok(!inArea(null));
  assert.ok(inArea({ lat: PATRAS_BBOX.minLat, lng: PATRAS_BBOX.minLng }));
});

test('angles: normDeg, angleDiff, lerpAngle across 0/360', () => {
  assert.equal(normDeg(-10), 350);
  assert.equal(normDeg(370), 10);
  assert.equal(normDeg(360), 0);
  assert.equal(angleDiff(350, 10), 20);
  assert.equal(angleDiff(10, 350), -20);
  assert.equal(angleDiff(0, 180), 180);
  near(lerpAngle(350, 10, 0.5), 0, 1e-9);
  near(lerpAngle(359, 1, 0.5), 0, 1e-9);
  near(lerpAngle(90, 100, 0.5), 95, 1e-9);
  near(lerpAngle(10, 350, 1), 350, 1e-9);
});

test('metersToLatLngDelta / offsetPoint / destinationPoint round-trip with haversine', () => {
  const { dLat, dLng } = metersToLatLngDelta(CENTER, 100, 200);
  near(dLat * 111320, 200, 1e-6);
  near(dLng * 111320 * Math.cos(CENTER.lat * Math.PI / 180), 100, 1e-6);
  const p = offsetPoint(CENTER, 300, 400);
  near(haversine(CENTER, p), 500, 1.5);
  const q = destinationPoint(CENTER, 90, 1000);
  near(haversine(CENTER, q), 1000, 3);
  near(bearing(CENTER, q), 90, 0.3);
  const r = destinationPoint(CENTER, 225, 700);
  near(haversine(CENTER, r), 700, 3);
  near(bearing(CENTER, r), 225, 0.3);
});

test('pointAlong', () => {
  const a = { lat: 38.2, lng: 21.7 }, b = { lat: 38.3, lng: 21.9 };
  assert.deepEqual(pointAlong(a, b, 0), a);
  assert.deepEqual(pointAlong(a, b, 1), b);
  const m = pointAlong(a, b, 0.5);
  near(m.lat, 38.25, 1e-12); near(m.lng, 21.8, 1e-12);
});

test('pathLength / closestOnPath', () => {
  const east = destinationPoint(CENTER, 90, 100), north = destinationPoint(east, 0, 100);
  const path = [[CENTER.lng, CENTER.lat], [east.lng, east.lat], [north.lng, north.lat]];
  near(pathLength(path), 200, 1);
  // a point 30 m north of the first leg's midpoint is 30 m from the path
  const mid = pointAlong(CENTER, east, 0.5);
  const c = closestOnPath(path, offsetPoint(mid, 0, 30));
  near(c.meters, 30, 0.5);
  assert.equal(c.index, 0);
  near(c.t, 0.5, 0.02);
  // beyond the end clamps to the last vertex
  const c2 = closestOnPath(path, offsetPoint(north, 0, 50));
  near(c2.meters, 50, 0.5);
  assert.equal(closestOnPath([], CENTER), null);
  near(closestOnPath([[CENTER.lng, CENTER.lat]], offsetPoint(CENTER, 0, 10)).meters, 10, 0.1);
});

// ---- nearestStops ----
const brute = (arr, p, { limit = 10, maxMeters = Infinity } = {}) =>
  arr.map((stop) => ({ stop, meters: haversine(p, stop) })).filter((x) => x.meters <= maxMeters).sort((a, b) => a.meters - b.meters).slice(0, limit);
const sameResult = (got, want) => {
  assert.equal(got.length, want.length);
  got.forEach((g, i) => { near(g.meters, want[i].meters, 1e-6); });
};

test('nearestStops: fixture has the expected size', () => { assert.ok(stops.length > 700); });

test('nearestStops: identical to brute force on random points (inside, edge, far away)', () => {
  const rnd = rng(42);
  for (let i = 0; i < 400; i++) {
    const p = { lat: 38.12 + rnd() * 0.22, lng: 21.58 + rnd() * 0.34 };
    const opts = [{}, { limit: 4, maxMeters: 500 }, { limit: 1 }, { limit: 20, maxMeters: 300 }, { limit: 6, maxMeters: 1500 }][i % 5];
    sameResult(nearestStops(stops, p, opts), brute(stops, p, opts));
  }
  for (const p of [{ lat: 37.9755, lng: 23.7348 }, { lat: 40.64, lng: 22.94 }, { lat: -33.9, lng: 151.2 }, { lat: 0, lng: 0 }]) {
    sameResult(nearestStops(stops, p, { limit: 3 }), brute(stops, p, { limit: 3 }));
    assert.equal(nearestStops(stops, p, { limit: 3, maxMeters: 5000 }).length, 0);
  }
});

test('nearestStops: exact hit, ordering, limits', () => {
  const s = stops.find((x) => x.code === '1011');
  const [first, second] = nearestStops(stops, s, { limit: 2 });
  assert.equal(first.stop.code, '1011');
  assert.equal(first.meters, 0);
  assert.ok(second.meters >= first.meters);
  assert.equal(nearestStops(stops, s, { limit: 5 }).length, 5);
  assert.equal(nearestStops(stops, s, { limit: 0 }).length, 0);
  const within = nearestStops(stops, s, { limit: 100, maxMeters: 200 });
  assert.ok(within.length >= 1 && within.every((x) => x.meters <= 200));
  for (let i = 1; i < within.length; i++) assert.ok(within[i].meters >= within[i - 1].meters);
  assert.equal(nearestStops(stops, s, { limit: 3, maxMeters: 0 }).length, 1); // only the stop itself
});

test('nearestStops: empty / invalid input, default limit, repeated calls use the cache', () => {
  assert.deepEqual(nearestStops([], CENTER), []);
  assert.deepEqual(nearestStops(null, CENTER), []);
  assert.deepEqual(nearestStops(stops, null), []);
  assert.deepEqual(nearestStops(stops, { lat: NaN, lng: 1 }), []);
  assert.equal(nearestStops(stops, CENTER).length, 10);
  // a stop with bad coordinates is ignored, not fatal
  const mixed = [{ code: 'x', lat: undefined, lng: undefined }, ...stops.slice(0, 50)];
  assert.ok(nearestStops(mixed, CENTER, { limit: 5 }).every((r) => r.stop.code !== 'x'));
});

test('nearestStops: index follows array growth and is fast', () => {
  const arr = stops.slice(0, 100);
  const before = nearestStops(arr, CENTER, { limit: 3 });
  arr.push({ code: 'new', lat: CENTER.lat, lng: CENTER.lng });
  assert.equal(nearestStops(arr, CENTER, { limit: 3 })[0].stop.code, 'new');
  assert.ok(before[0].stop.code !== 'new');
  const t0 = performance.now();
  for (let i = 0; i < 2000; i++) nearestStops(stops, { lat: CENTER.lat + (i % 50) * 1e-4, lng: CENTER.lng }, { limit: 4, maxMeters: 500 });
  const perCall = (performance.now() - t0) / 2000;
  assert.ok(perCall < 0.5, `${perCall.toFixed(3)} ms per call`);
});
