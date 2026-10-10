import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOnboard, stopsToGo, shouldAlert, passedByEta, loadTrip, KEY, MAX_AGE_MS } from '../web/js/onboard.js';

const NOW = 1_700_000_000_000;
const flush = () => new Promise((r) => setImmediate(r));

// Stops s0..s5 on one east-west line at lat 38.2, 0.002° of longitude apart. The alight stop is s4;
// s5 exists so a bus can pass s4 and the GPS end condition (stopsToGo 0) is reachable.
const STOPS = ['s0', 's1', 's2', 's3', 's4', 's5'];
const LNG = (i) => 21.7 + i * 0.002;
const fix = (dLng) => ({ lat: 38.2, lng: 21.7 + dLng });
const TRIP = { vehicleCode: 'v1', routeCode: 'r1', lineCode: '609', alightStop: 's4', stopName: 'N4' };
const data = {
  routeByCode: new Map([['r1', { stops: STOPS }]]),
  stopByCode: new Map(STOPS.map((c, i) => [c, { displayName: 'N' + i, lat: 38.2, lng: LNG(i) }])),
};

function fakeStorage(map = new Map()) {
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

// Fake browser: virtual clock, manual timers, counted wake lock / GPS stop, recorded notifications.
function rig({ map = new Map(), eta = 600 } = {}) {
  const clock = { t: NOW };
  const fake = fakeStorage(map);
  const r = { clock, map, eta, timers: [], alerts: [], booked: [], cancelled: [], released: 0, stopped: 0, fixFn: null };
  r.env = {
    now: () => clock.t,
    storage: () => fake,
    setTimer: (f) => { r.timers.push(f); return r.timers.length - 1; },
    clearTimer: (id) => { r.timers[id] = null; },
    doc: null,
    wake: () => ({ request: async () => ({ release() { r.released++; } }) }),
    loc: {
      status: 'idle', current: null, start() {}, stop() { r.stopped++; },
      subscribe(fn) { r.fixFn = fn; return () => { r.fixFn = null; }; },
    },
    getData: async () => data,
    fetchLive: async () => ({ fetchedAt: clock.t, vehicles: [{ vehicleCode: 'v1', live: true, etaSec: r.eta }] }),
    notify: {
      schedule(p) { r.booked.push(p); }, cancel(tag) { r.cancelled.push(tag); },
      has: () => false, onChange: () => () => {}, ensure: async () => true,
    },
    alertUser: (tr) => r.alerts.push(tr),
  };
  return r;
}

async function started(r) {
  const ob = createOnboard(r.env);
  assert.equal(await ob.startOnboard(TRIP), true);
  await flush();
  return ob;
}

const seed = { v: 1, vehicleCode: 'v1', routeCode: 'r1', lineCode: '609', alightStop: 's4', stopName: 'N4', startedAt: NOW, alerted: false, bookedAt: null };

// ---------------------------------------------------------------- pure core

test('stopsToGo: counts stops to the alight stop, 0 once past, null when unknown', () => {
  const stops = ['a', 'b', 'c', 'd', 'e'];
  assert.equal(stopsToGo(stops, 'd', 0), 3);
  assert.equal(stopsToGo(stops, 'd', 2), 1);
  assert.equal(stopsToGo(stops, 'd', 3), 0);
  assert.equal(stopsToGo(stops, 'd', 4), 0);
  assert.equal(stopsToGo(stops, 'zz', 0), null);
  assert.equal(stopsToGo(stops, 'd', 1.5), null);
  assert.equal(stopsToGo(stops, 'd', '1'), null);
  const loop = ['a', 'b', 'c', 'b', 'd'];
  assert.equal(stopsToGo(loop, 'b', 0), 1);
  assert.equal(stopsToGo(loop, 'b', 1), 2);
  assert.equal(stopsToGo(loop, 'b', 2), 1);
  assert.equal(stopsToGo(loop, 'b', 3), 0);
});

test('shouldAlert: one stop or 90 s before the alight stop, nothing else', () => {
  assert.equal(shouldAlert({ stopsToGo: 2, etaSec: 200 }), false);
  assert.equal(shouldAlert({ stopsToGo: 1 }), true);
  assert.equal(shouldAlert({ etaSec: 90 }), true);
  assert.equal(shouldAlert({ etaSec: 91, stopsToGo: 3 }), false);
  assert.equal(shouldAlert({}), false);
  assert.equal(shouldAlert({ stopsToGo: null, etaSec: null }), false);
});

test('passedByEta: true once the due time minus 45 s slack has come; false without a last ETA', () => {
  const last = { sec: 60, at: NOW };
  assert.equal(passedByEta(last, NOW + 10000), false);
  assert.equal(passedByEta(last, NOW + 16000), true);
  assert.equal(passedByEta(null, NOW + 999999), false);
});

// ---------------------------------------------------------------- persistence

const trip = (over = {}) => ({ v: 1, vehicleCode: 'v1', routeCode: 'r1', lineCode: '609', alightStop: 's4', stopName: 'X', startedAt: NOW, alerted: false, bookedAt: null, ...over });

test('loadTrip: a trip within MAX_AGE_MS is returned; an older one is dropped with its key', () => {
  const map = new Map([[KEY, JSON.stringify(trip())]]);
  const st = () => fakeStorage(map);
  assert.equal(loadTrip(st, NOW + MAX_AGE_MS).alightStop, 's4');
  assert.equal(map.has(KEY), true);
  assert.equal(loadTrip(st, NOW + MAX_AGE_MS + 1), null);
  assert.equal(map.has(KEY), false);
});

test('loadTrip: corrupt JSON, no storage and nothing stored all give null', () => {
  assert.equal(loadTrip(() => fakeStorage(new Map([[KEY, '{not json']])), NOW), null);
  assert.equal(loadTrip(() => null, NOW), null);
  assert.equal(loadTrip(() => fakeStorage(), NOW), null);
});

// ---------------------------------------------------------------- controller

test('start: persists the trip and books the reminder 90 s before the predicted arrival', async () => {
  const r = rig();
  const ob = await started(r);
  const tr = ob.activeTrip();
  assert.ok(tr);
  assert.equal(tr.alightStop, 's4');
  assert.ok(r.map.has(KEY));
  assert.equal(r.booked.length, 1);
  const b = r.booked[0];
  assert.equal(b.kind, 'alight');
  assert.equal(b.tag, 'alight');
  assert.equal(b.trip.stopCode, 's4');
  assert.equal(b.trip.offsetSec, 90);
  assert.equal(b.trip.vehicleCode, 'v1');
  assert.equal(b.at, NOW + 600000 - 90000);
});

test('start without an alight stop is refused and leaves no trip', async () => {
  const r = rig();
  const ob = createOnboard(r.env);
  assert.equal(await ob.startOnboard({ ...TRIP, alightStop: undefined }), false);
  assert.equal(ob.activeTrip(), null);
  assert.equal(r.map.has(KEY), false);
});

test('GPS: no alert at two stops out; one alert at one stop out, not repeated', async () => {
  const r = rig();
  const ob = await started(r);
  const seen = [];
  ob.onTripChange((s) => seen.push(s));
  r.fixFn(fix(0.0045)); // between s2 and s3: two stops to go
  assert.equal(r.alerts.length, 0);
  assert.equal(seen.at(-1).stopsToGo, 2);
  r.fixFn(fix(0.0065)); // between s3 and s4: one stop to go
  assert.equal(r.alerts.length, 1);
  assert.equal(ob.activeTrip().alerted, true);
  assert.ok(r.cancelled.includes('alight'));
  r.fixFn(fix(0.0065)); // same segment: ignored
  r.fixFn(fix(0.0066));
  assert.equal(r.alerts.length, 1);
});

test('GPS: a fix past the alight stop ends the trip and clears storage', async () => {
  const r = rig();
  const ob = await started(r);
  r.fixFn(fix(0.0085)); // between s4 and s5
  assert.equal(ob.activeTrip(), null);
  assert.equal(r.map.has(KEY), false);
});

test('ETA: a live ETA within 90 s alerts after the poll, without GPS', async () => {
  const r = rig({ eta: 80 });
  const ob = await started(r);
  assert.equal(r.alerts.length, 1);
  assert.equal(ob.activeTrip().alerted, true);
});

test('expiry: activeTrip() after MAX_AGE_MS ends the trip and removes the key', async () => {
  const r = rig();
  const ob = await started(r);
  r.clock.t += MAX_AGE_MS + 1000;
  assert.equal(ob.activeTrip(), null);
  assert.equal(r.map.has(KEY), false);
});

test('stopOnboard: clears trip, storage and reminder, releases the wake lock, stops own GPS and timer', async () => {
  const r = rig();
  const ob = await started(r);
  ob.stopOnboard();
  assert.equal(ob.activeTrip(), null);
  assert.equal(r.map.has(KEY), false);
  assert.ok(r.cancelled.includes('alight'));
  assert.equal(r.released, 1);
  assert.equal(r.stopped, 1);
  assert.ok(r.timers.every((f) => f === null));
});

test('resume: a stored fresh trip comes back; an expired one is dropped', async () => {
  const r = rig({ map: new Map([[KEY, JSON.stringify(seed)]]) });
  const ob = createOnboard(r.env);
  assert.equal(ob.resume(), true);
  assert.equal(ob.activeTrip().alightStop, 's4');

  const old = rig({ map: new Map([[KEY, JSON.stringify(seed)]]) });
  old.clock.t += MAX_AGE_MS + 1000;
  assert.equal(createOnboard(old.env).resume(), false);
  assert.equal(old.map.has(KEY), false);
});
