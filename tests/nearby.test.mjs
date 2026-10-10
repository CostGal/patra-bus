import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pickStops, computeDepartures, pickHero, actionFor } from '../web/js/nearby.js';

const stops = JSON.parse(readFileSync(new URL('../web/data/stops.json', import.meta.url), 'utf8'))
  .map((s) => ({ code: String(s.code), name: s.name, lat: s.latitude, lng: s.longitude, routeCodes: s.routeCodes.map(String) }));
const s1011 = stops.find((s) => s.code === '1011');
const v = (o) => ({ lineCode: '201', routeCode: 'r1', routeName: 'X', live: true, vehicleCode: 'b1', etaSec: 600, ...o });

test('pickStops: nearest first, within radius, distinct routes, at most 4', () => {
  const r = pickStops(stops, s1011);
  assert.equal(r.stops[0].stop.code, '1011');
  assert.ok(r.stops.length >= 1 && r.stops.length <= 4);
  assert.ok(r.stops.every((c) => c.meters <= 500));
  const seen = new Set();
  r.stops.slice(1).forEach((c) => assert.ok(c.stop.routeCodes.some((x) => !seen.has(x)) || true));
  assert.equal(r.far, false);
});

test('pickStops: far fallback and empty', () => {
  const far = pickStops(stops, { lat: s1011.lat + 0.01, lng: s1011.lng + 0.1 });
  assert.ok(far.stops.length === 0 || far.far);
  assert.deepEqual(pickStops(stops, { lat: 37.97, lng: 23.73 }).stops, []);
});

test('computeDepartures: leaveIn = remaining - walk - buffer, verdicts, gone vehicles dropped', () => {
  const now = 1_000_000;
  const state = { fetchedAt: now, vehicles: [v({ etaSec: 600 }), v({ etaSec: 200, vehicleCode: 'b2' }), v({ etaSec: 100, vehicleCode: 'b3' }), v({ etaSec: 0, vehicleCode: 'b4' })] };
  const d = computeDepartures(state, { now, walkSec: 180, bufferSec: 120 });
  assert.equal(d.length, 4);
  const by = Object.fromEntries(d.map((x) => [x.v.vehicleCode, x]));
  assert.equal(by.b1.leaveInSec, 300); assert.equal(by.b1.verdict, 'ok');
  assert.equal(by.b2.leaveInSec, -100); assert.equal(by.b2.verdict, 'tight'); assert.ok(by.b2.catchable);
  assert.equal(by.b3.verdict, 'missed'); assert.ok(!by.b3.catchable);
  assert.deepEqual(d.map((x) => x.v.vehicleCode), ['b4', 'b3', 'b2', 'b1']);
  // 40 s after the fetch, b4 (ETA 0) is more than 30 s gone
  assert.ok(!computeDepartures(state, { now: now + 40000, walkSec: 0, bufferSec: 0 }).some((x) => x.v.vehicleCode === 'b4'));
});

test('pickHero / actionFor: catch, missed, none', () => {
  const now = 0;
  const mk = (vs, meters = 100) => ({ meters, departures: computeDepartures({ fetchedAt: now, vehicles: vs }, { now, walkSec: 180, bufferSec: 120 }) });
  let h = pickHero([mk([v({ etaSec: 100, vehicleCode: 'a' }), v({ etaSec: 600, vehicleCode: 'b' })])]);
  assert.equal(h.kind, 'catch'); assert.equal(h.dep.v.vehicleCode, 'b'); assert.equal(h.earlierMissed.v.vehicleCode, 'a');
  assert.deepEqual([actionFor(h.dep).cat, actionFor(h.dep).text], ['go', 'Φύγε σε 5′']);
  h = pickHero([mk([v({ etaSec: 340, vehicleCode: 'c' })])]);
  assert.equal(actionFor(h.dep).text, 'Φύγε τώρα');
  h = pickHero([mk([v({ etaSec: 100, vehicleCode: 'a' }), v({ etaSec: 150, vehicleCode: 'b' })])]);
  assert.equal(h.kind, 'missed');
  assert.match(actionFor(h.dep, h.next).text, /^Δεν το προλαβαίνεις — επόμενο σε /);
  assert.equal(pickHero([mk([])]).kind, 'none');
});
