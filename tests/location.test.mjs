import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocationService } from '../web/js/location.js';
import { offsetPoint, bearing, destinationPoint } from '../web/js/geo.js';

const A = { lat: 38.2466, lng: 21.7346 };
const near = (a, b, eps) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b} (±${eps})`);
const flush = () => new Promise((r) => setImmediate(r));

// Fake browser: geolocation, Permissions API, document visibility, window events, virtual clock.
function rig({ perm = null, secure = true, geo = true, storage = null, compassWaitMs = 60, DOE, angle } = {}) {
  const r = { t: 1_700_000_000_000, calls: [], watchers: new Map(), nextId: 1, once: null, permState: perm, permObj: null, wl: new Map(), dl: new Map() };
  const geolocation = geo ? {
    getCurrentPosition(ok, err, opts) { r.calls.push(['get', opts]); r.once = { ok, err, opts }; },
    watchPosition(ok, err, opts) { const id = r.nextId++; r.watchers.set(id, { ok, err, opts }); r.calls.push(['watch', opts]); return id; },
    clearWatch(id) { r.watchers.delete(id); r.calls.push(['clear', id]); },
  } : undefined;
  const permissions = perm ? { query: async () => (r.permObj = { state: r.permState, onchange: null }) } : undefined;
  const bus = (m) => ({
    addEventListener(n, f) { (m.get(n) || m.set(n, new Set()).get(n)).add(f); },
    removeEventListener(n, f) { m.get(n)?.delete(f); },
  });
  r.doc = { visibilityState: 'visible', ...bus(r.dl), fire(n) { r.dl.get(n)?.forEach((f) => f({})); } };
  r.win = { ...bus(r.wl), DeviceOrientationEvent: DOE === undefined ? class {} : DOE, emit(n, ev) { r.wl.get(n)?.forEach((f) => f(ev)); } };
  if (angle !== undefined) { // screen.orientation: angle + 'change' events
    const so = { angle, ...bus(r.sl = new Map()) };
    r.win.screen = { orientation: so };
    r.turn = (a) => { so.angle = a; r.sl.get('change')?.forEach((f) => f({})); };
  }
  r.store = storage || new Map();
  const ls = { getItem: (k) => (r.store.has(k) ? r.store.get(k) : null), setItem: (k, v) => r.store.set(k, String(v)) };
  r.svc = createLocationService({ nav: { geolocation, permissions }, doc: r.doc, win: r.win, now: () => r.t, secure, storage: ls, compassWaitMs });
  r.events = [];
  r.svc.subscribe((fix, status) => r.events.push({ fix, status }));
  r.pos = (p, acc = 10, extra = {}) => ({ coords: { latitude: p.lat, longitude: p.lng, accuracy: acc, heading: null, speed: null, ...extra }, timestamp: r.t });
  r.watch = () => [...r.watchers.values()].at(-1);
  r.fire = (p, acc, extra) => r.watch().ok(r.pos(p, acc, extra));
  r.count = (k) => r.calls.filter((c) => c[0] === k).length;
  return r;
}
const started = async (opts) => { const r = rig(opts); r.svc.start(); await flush(); return r; };

test('start: fast coarse fix and accurate watch, status machine idle → locating → ok', async () => {
  const r = rig({ perm: 'granted' });
  assert.equal(r.svc.status, 'idle');
  r.svc.start(); assert.equal(r.svc.status, 'locating');
  await flush();
  const get = r.calls.find((c) => c[0] === 'get')[1], watch = r.calls.find((c) => c[0] === 'watch')[1];
  assert.equal(get.enableHighAccuracy, false); assert.equal(get.maximumAge, 30000);
  assert.equal(watch.enableHighAccuracy, true);
  assert.equal(r.svc.current, null);
  r.once.ok(r.pos(A, 800));
  assert.equal(r.svc.status, 'ok');
  assert.equal(r.svc.current.accuracy, 800);
  assert.equal(r.svc.current.source, 'gps');
  r.t += 4000; r.fire(offsetPoint(A, 30, 0), 8); // better fix replaces the coarse one
  assert.equal(r.svc.current.accuracy, 8);
  assert.ok(r.events.length >= 3 && r.events.at(-1).status === 'ok');
  r.svc.start(); await flush(); // idempotent: no second watch
  assert.equal(r.count('watch'), 1);
});

test('permission denied up front (Permissions API): no geolocation calls, status denied', async () => {
  const r = rig({ perm: 'denied' });
  await flush(); await flush();
  assert.equal(r.svc.status, 'denied');
  r.svc.start(); await flush();
  assert.equal(r.svc.status, 'denied');
  assert.equal(r.count('get') + r.count('watch'), 0);
  // user re-enables it in the browser settings → we pick it up and start
  r.permState = 'granted'; r.permObj.state = 'granted'; r.permObj.onchange();
  assert.equal(r.svc.status, 'locating');
  assert.equal(r.count('watch'), 1);
  r.fire(A, 15);
  assert.equal(r.svc.status, 'ok');
  // and revoking it later drops the fix and the watch
  r.permObj.state = 'denied'; r.permObj.onchange();
  assert.equal(r.svc.status, 'denied');
  assert.equal(r.svc.current, null);
  assert.equal(r.watchers.size, 0);
});

test('PERMISSION_DENIED error → denied; start() retries', async () => {
  const r = await started();
  r.watch().err({ code: 1 });
  assert.equal(r.svc.status, 'denied');
  assert.equal(r.watchers.size, 0);
  r.svc.start(); await flush();
  assert.equal(r.svc.status, 'locating');
  assert.equal(r.count('watch'), 2);
});

test('insecure context and missing geolocation', async () => {
  const a = rig({ secure: false }); a.svc.start(); await flush();
  assert.equal(a.svc.status, 'insecure'); assert.equal(a.count('get') + a.count('watch'), 0);
  const b = rig({ geo: false }); b.svc.start(); await flush();
  assert.equal(b.svc.status, 'unavailable');
});

test('timeout / unavailable only while there is no fix; the one-shot call never reports them', async () => {
  const r = await started();
  r.once.err({ code: 3 }); // one-shot timed out, watch still warming up
  assert.equal(r.svc.status, 'locating');
  r.watch().err({ code: 3 });
  assert.equal(r.svc.status, 'timeout');
  r.fire(A, 12); // a late fix recovers
  assert.equal(r.svc.status, 'ok');
  r.watch().err({ code: 3 }); r.watch().err({ code: 2 });
  assert.equal(r.svc.status, 'ok', 'errors with a recent fix are ignored');
  const u = await started(); u.watch().err({ code: 2 });
  assert.equal(u.svc.status, 'unavailable');
});

test('rejects teleports (> 60 m/s) but accepts a real relocation after three consistent fixes', async () => {
  const r = await started();
  r.fire(A, 10);
  const far = offsetPoint(A, 100000, 0);
  r.t += 1000; r.fire(far, 10);
  assert.equal(r.svc.current.lat, A.lat, 'single jump ignored');
  r.t += 1000; r.fire(A, 10); // back home: still fine
  assert.ok(Math.abs(r.svc.current.lat - A.lat) < 1e-4);
  // 50 m/s is fast but legal (a train); 80 m/s is not
  r.t += 1000; r.fire(offsetPoint(A, 50, 0), 5);
  near(r.svc.current.lng, offsetPoint(A, 50, 0).lng, 3e-4);
  const x = await started(); x.fire(A, 10);
  for (let i = 0; i < 3; i++) { x.t += 1000; x.fire(offsetPoint(far, i, 0), 10); }
  near(x.svc.current.lng, far.lng, 1e-4);
});

test('fixes much worse than the current one are ignored unless the current is stale', async () => {
  const r = await started();
  r.fire(A, 10);
  r.t += 5000; r.fire(offsetPoint(A, 40, 0), 200);
  assert.ok(r.svc.current.accuracy <= 12, 'coarse fix ignored');
  r.t += 5000; r.fire(offsetPoint(A, 5, 0), 30); // 30 ≤ 2×10+15 → not "much worse"
  r.t += 31000; r.fire(offsetPoint(A, 40, 0), 200); // current is now > 30 s old
  assert.equal(r.svc.current.accuracy, 200);
  // out-of-order and garbage are dropped
  const before = r.svc.current;
  const old = r.pos(A, 5); old.timestamp = r.t - 10000;
  r.watch().ok(old);
  r.fire({ lat: 0, lng: 0 }, 5); r.fire({ lat: NaN, lng: 1 }, 5); r.fire({ lat: 95, lng: 1 }, 5);
  assert.equal(r.svc.current, before);
});

test('stationary fixes are smoothed, moving ones are not', async () => {
  const r = await started();
  r.fire(A, 20);
  const jitter = [[8, 0], [-8, 3], [5, -6], [-7, -2], [6, 5]];
  let maxRaw = 0, maxSmooth = 0;
  for (const [e, n] of jitter) {
    r.t += 1000;
    const raw = offsetPoint(A, e, n); r.fire(raw, 20, { speed: 0 });
    const c = r.svc.current;
    maxRaw = Math.max(maxRaw, Math.hypot(e, n));
    maxSmooth = Math.max(maxSmooth, Math.hypot((c.lng - A.lng) * 111320 * Math.cos(A.lat * Math.PI / 180), (c.lat - A.lat) * 111320));
  }
  assert.ok(maxSmooth < maxRaw * 0.8, `smoothed ${maxSmooth.toFixed(1)} vs raw ${maxRaw}`);
  assert.ok(r.svc.current.accuracy <= 20);
  // walking: the newest raw position is taken as is
  const target = offsetPoint(A, 25, 0);
  r.t += 1000; r.fire(target, 10, { speed: 1.4 });
  near(r.svc.current.lng, target.lng, 1e-9);
});

test('heading: GPS course when moving, held briefly, then gone; derived from track if the device gives none', async () => {
  const r = await started();
  r.fire(A, 8, { speed: 6, heading: 90 });
  assert.equal(r.svc.current.heading, 90);
  assert.equal(r.svc.current.headingSource, 'gps');
  r.t += 1000; r.fire(offsetPoint(A, 8, 0), 8, { speed: 0 });
  assert.equal(r.svc.current.heading, 90, 'held for a few seconds');
  r.t += 10000; r.fire(offsetPoint(A, 8, 1), 8, { speed: 0 });
  assert.equal(r.svc.current.heading, null);
  // no heading from the device, no speed: bearing from consecutive positions
  const x = await started();
  x.fire(A, 5);
  x.t += 4000; x.fire(destinationPoint(A, 45, 25), 5);
  near(x.svc.current.heading, 45, 3);
  near(x.svc.current.speed, 25 / 4, 0.5);
});

test('compass (iOS): permission requested synchronously inside the gesture, webkitCompassHeading used when stationary', async () => {
  let asked = 0;
  const DOE = { requestPermission: () => { asked++; return Promise.resolve('granted'); } };
  const r = await started({ DOE });
  r.fire(A, 8, { speed: 0 });
  const p = r.svc.enableCompass();
  assert.equal(asked, 1, 'requestPermission called before enableCompass returned');
  await flush();
  r.win.emit('deviceorientation', { webkitCompassHeading: 120 });
  assert.equal(await p, true);
  assert.equal(r.svc.compassActive, true);
  near(r.svc.current.heading, 120, 0.01);
  assert.equal(r.svc.current.headingSource, 'compass');
  // moving fast: GPS course takes over
  r.t += 1000; r.fire(offsetPoint(A, 10, 0), 8, { speed: 5, heading: 200 });
  near(r.svc.current.heading, 200, 0.01);
  assert.equal(r.svc.current.headingSource, 'gps');
  // denied
  const d = await started({ DOE: { requestPermission: async () => 'denied' } });
  assert.equal(await d.svc.enableCompass(), false);
  assert.equal(d.svc.compassActive, false);
});

test('compass (Android): only absolute events count; flat and upright phone', async () => {
  const r = await started();
  r.fire(A, 8, { speed: 0 });
  const p = r.svc.enableCompass();
  await flush();
  r.win.emit('deviceorientation', { absolute: false, alpha: 10, beta: 0, gamma: 0 }); // relative → ignored
  assert.equal(r.svc.current.heading, null);
  r.win.emit('deviceorientationabsolute', { absolute: true, alpha: 270, beta: 0, gamma: 0 }); // flat, top edge east
  assert.equal(await p, true);
  near(r.svc.current.heading, 90, 0.01);
  // upright phone (beta 90) facing west: alpha 90 (device rotated 90° ccw from north)
  const u = await started(); u.fire(A, 8, { speed: 0 });
  const q = u.svc.enableCompass(); await flush();
  u.win.emit('deviceorientationabsolute', { absolute: true, alpha: 90, beta: 90, gamma: 0 });
  assert.equal(await q, true);
  near(u.svc.current.heading, 270, 0.5);
});

test('compass in landscape: heading follows screen.orientation.angle and updates when the phone is turned', async () => {
  const r = await started({ angle: 0 });
  r.fire(A, 8, { speed: 0 });
  const p = r.svc.enableCompass(); await flush();
  r.win.emit('deviceorientation', { webkitCompassHeading: 270 }); // top edge points west
  assert.equal(await p, true);
  near(r.svc.current.heading, 270, 0.01);
  // turned to landscape (rotated left): the screen's top edge now faces north
  r.t += 200; r.turn(90);
  near(r.svc.current.heading, 0, 0.01);
  assert.equal(r.svc.current.headingSource, 'compass');
  r.t += 200; r.win.emit('deviceorientation', { webkitCompassHeading: 300 });
  r.t += 200; r.win.emit('deviceorientation', { webkitCompassHeading: 300 });
  assert.ok(Math.abs(((r.svc.current.heading + 540) % 360) - 180) < 20, `~30° after smoothing (${r.svc.current.heading})`);
  r.t += 200; r.turn(270); // rotated right: 270 − 90
  assert.ok(r.svc.current.heading > 190 && r.svc.current.heading < 230, `${r.svc.current.heading}`);
  r.t += 200; r.turn(180);
  assert.ok(r.svc.current.heading > 100 && r.svc.current.heading < 140, `${r.svc.current.heading}`);
  // listeners are removed with the compass
  r.svc.disableCompass();
  assert.equal(r.sl.get('change').size, 0);
  assert.equal(r.wl.get('orientationchange').size, 0);
});

test('compass in landscape: Android flat vs upright, window.orientation fallback and orientationchange', async () => {
  // flat phone, landscape: alpha 270 means the top edge faces east, the screen's top edge (user's view) faces south (90 + 90)
  const r = await started({ angle: 90 });
  r.fire(A, 8, { speed: 0 });
  const p = r.svc.enableCompass(); await flush();
  r.win.emit('deviceorientationabsolute', { absolute: true, alpha: 270, beta: 0, gamma: 0 });
  assert.equal(await p, true);
  near(r.svc.current.heading, 180, 0.01);
  // upright phone: the rear camera axis does not care about the screen rotation
  const u = await started({ angle: 90 }); u.fire(A, 8, { speed: 0 });
  const q = u.svc.enableCompass(); await flush();
  u.win.emit('deviceorientationabsolute', { absolute: true, alpha: 90, beta: 90, gamma: 0 });
  assert.equal(await q, true);
  near(u.svc.current.heading, 270, 0.5);
  // no screen.orientation: window.orientation (-90 = rotated right = 270) and the orientationchange event
  const w = await started(); w.fire(A, 8, { speed: 0 });
  w.win.orientation = 0;
  const z = w.svc.enableCompass(); await flush();
  w.win.emit('deviceorientation', { webkitCompassHeading: 100 });
  assert.equal(await z, true);
  near(w.svc.current.heading, 100, 0.01);
  w.win.orientation = -90; w.t += 200; w.win.emit('orientationchange', {});
  near(w.svc.current.heading, 10, 0.01);
  w.win.orientation = 90; w.t += 200; w.win.emit('orientationchange', {});
  near(w.svc.current.heading, 190, 0.01);
});

test('compass: smoothing goes the short way across 0/360; disable and no-sensor cases', async () => {
  const r = await started();
  r.fire(A, 8, { speed: 0 });
  const p = r.svc.enableCompass(); await flush();
  r.win.emit('deviceorientation', { webkitCompassHeading: 359 });
  await p;
  const seen = [];
  for (const h of [1, 359, 2, 358, 1, 359]) {
    r.t += 200; r.win.emit('deviceorientation', { webkitCompassHeading: h });
    seen.push(r.svc.current.heading);
  }
  assert.ok(seen.every((h) => h <= 10 || h >= 350), `no swing through the south: ${seen.map((x) => x.toFixed(0))}`);
  r.svc.disableCompass();
  assert.equal(r.svc.current.heading, null);
  assert.equal(r.wl.get('deviceorientation').size, 0);
  // no sensor events at all → false and listeners removed
  const n = await started({ compassWaitMs: 40 });
  assert.equal(await n.svc.enableCompass(), false);
  assert.equal(n.wl.get('deviceorientation').size, 0);
  // no DeviceOrientationEvent
  const m = await started({ DOE: null });
  assert.equal(await m.svc.enableCompass(), false);
});

test('hidden page pauses the watch, visible resumes it; compass listeners follow', async () => {
  const r = await started();
  r.fire(A, 10);
  const p = r.svc.enableCompass(); await flush();
  r.win.emit('deviceorientation', { webkitCompassHeading: 10 }); await p;
  r.doc.visibilityState = 'hidden'; r.doc.fire('visibilitychange');
  assert.equal(r.watchers.size, 0);
  assert.equal(r.win.wl?.size ?? r.wl.get('deviceorientation').size, 0);
  assert.equal(r.svc.status, 'ok');
  const gets = r.count('get');
  r.doc.visibilityState = 'visible'; r.doc.fire('visibilitychange');
  assert.equal(r.watchers.size, 1);
  assert.equal(r.count('get'), gets + 1, 'quick refresh on resume');
  assert.equal(r.wl.get('deviceorientation').size, 1);
  r.t += 120000; r.fire(offsetPoint(A, 500, 0), 40); // after a long pause any fix is accepted
  near(r.svc.current.lng, offsetPoint(A, 500, 0).lng, 1e-6);
});

test('setManual pins a point (source manual) until cleared; start() drops it', async () => {
  const r = await started();
  r.fire(A, 10);
  const spot = { lat: 38.25, lng: 21.74 };
  r.svc.setManual(spot);
  assert.equal(r.svc.current.source, 'manual');
  assert.equal(r.svc.current.lat, spot.lat);
  assert.equal(r.svc.current.accuracy, 0);
  r.t += 5000; r.fire(offsetPoint(A, 5, 5), 10);
  assert.equal(r.svc.current.source, 'manual', 'gps does not override');
  r.svc.setManual({ lat: NaN, lng: 1 });
  assert.equal(r.svc.current.lat, spot.lat, 'invalid input ignored');
  r.svc.setManual(null);
  assert.equal(r.svc.current.source, 'gps');
  r.svc.setManual(spot); r.svc.start();
  assert.equal(r.svc.current.source, 'gps');
  // works without any gps / permission
  const d = rig({ perm: 'denied' }); await flush();
  d.svc.setManual(spot);
  assert.equal(d.svc.current.source, 'manual');
  assert.equal(d.svc.status, 'denied');
  assert.equal(d.events.at(-1).fix.source, 'manual');
});

test('stop: clears the watch and the fix, ignores late callbacks', async () => {
  const r = await started();
  r.fire(A, 10);
  const w = r.watch();
  r.svc.stop();
  assert.equal(r.svc.status, 'idle');
  assert.equal(r.svc.current, null);
  assert.equal(r.watchers.size, 0);
  w.ok(r.pos(A, 5)); r.once.ok(r.pos(A, 5));
  assert.equal(r.svc.current, null);
  assert.equal(r.dl.get('visibilitychange').size, 0);
});

test('subscribe: unsubscribe, one failing subscriber does not break others, no duplicate notifications', async () => {
  const r = await started();
  const seen = [];
  const off = r.svc.subscribe((f, s) => seen.push(s));
  r.svc.subscribe(() => { throw new Error('boom'); });
  const origErr = console.error; console.error = () => {};
  try {
    r.fire(A, 10);
    assert.deepEqual(seen, ['ok']);
    off();
    r.t += 1000; r.fire(offsetPoint(A, 100, 0), 10, { speed: 3 });
    assert.deepEqual(seen, ['ok']);
  } finally { console.error = origErr; }
  const n = r.events.length;
  r.svc.setManual(null); // nothing changed → nothing emitted
  assert.equal(r.events.length, n);
});

test('autoStart: only when no prompt would appear', async () => {
  const granted = rig({ perm: 'granted' });
  assert.equal(await granted.svc.autoStart(), true);
  assert.equal(granted.svc.status, 'locating');
  const prompt = rig({ perm: 'prompt' });
  assert.equal(await prompt.svc.autoStart(), false);
  assert.equal(prompt.svc.status, 'idle'); assert.equal(prompt.count('watch'), 0);
  const denied = rig({ perm: 'denied' });
  assert.equal(await denied.svc.autoStart(), false);
  assert.equal(denied.svc.status, 'denied');
  // no Permissions API: remembered grant from an earlier successful fix
  const first = rig({ storage: new Map() });
  assert.equal(await first.svc.autoStart(), false);
  first.svc.start(); await flush(); first.fire(A, 10);
  assert.equal(first.store.get('patra-bus:loc-granted'), '1');
  const again = rig({ storage: first.store });
  assert.equal(await again.svc.autoStart(), true);
});

test('waitForFix resolves with the first fix, or null on timeout', async () => {
  const r = await started();
  const p = r.svc.waitForFix(1000);
  r.fire(A, 10);
  assert.equal((await p).lat, A.lat);
  assert.equal((await r.svc.waitForFix(10)).lat, A.lat, 'immediate when a fix exists');
  const n = rig();
  assert.equal(await n.svc.waitForFix(20), null);
});

test('bearing sanity for the derived-course test helper', () => {
  near(bearing(A, destinationPoint(A, 45, 25)), 45, 0.5);
});
