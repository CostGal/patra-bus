import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWalker, walkEstimate, WALK_SPEEDS, DETOUR, OSRM_FOOT } from '../web/js/walk.js';
import { haversine, offsetPoint } from '../web/js/geo.js';

const A = { lat: 38.2466, lng: 21.7346 };
const at = (e, n) => offsetPoint(A, e, n);
const near = (a, b, eps) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b} (±${eps})`);
const okBody = (from, to, distance = 400) => ({
  code: 'Ok',
  routes: [{ distance, duration: distance / 1.39, geometry: { type: 'LineString', coordinates: [[from.lng, from.lat], [(from.lng + to.lng) / 2, from.lat], [to.lng, to.lat]] } }],
});

// Virtual clock + fake fetch. sleep() advances time instantly so rate limiting is testable without waiting.
function rig({ speed = 1.3, body = okBody, status = 200, ...opts } = {}) {
  const r = { t: 1_000_000, urls: [], starts: [], speed, behavior: null };
  r.fetch = async (url, init) => {
    r.urls.push(url); r.starts.push(r.t);
    if (r.behavior === 'hang') await new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError'))));
    if (r.behavior === 'throw') throw new TypeError('Failed to fetch');
    const m = /\/([-\d.]+),([-\d.]+);([-\d.]+),([-\d.]+)\?/.exec(url);
    const from = { lng: +m[1], lat: +m[2] }, to = { lng: +m[3], lat: +m[4] };
    const st = r.status ?? status;
    return { ok: st >= 200 && st < 300, status: st, json: async () => (r.respond ? r.respond(from, to) : body(from, to)) };
  };
  r.w = createWalker({ fetch: r.fetch, now: () => r.t, sleep: async (ms) => { r.t += ms; }, speed: () => r.speed, timeoutMs: 40, ...opts });
  return r;
}

test('walkEstimate: straight line × detour at the walking speed', () => {
  const b = at(0, 500);
  const e = walkEstimate(A, b, 1.3);
  near(e.meters, 500 * DETOUR, 2);
  near(e.seconds, e.meters / 1.3, 1e-9);
  assert.equal(e.geometry, null);
  assert.equal(e.source, 'estimate');
  assert.ok(walkEstimate(A, b, WALK_SPEEDS.slow).seconds > walkEstimate(A, b, WALK_SPEEDS.fast).seconds);
  assert.deepEqual(WALK_SPEEDS, { slow: 1.0, normal: 1.3, fast: 1.6 });
  // default speed comes from the store (no localStorage in node → normal)
  near(walkEstimate(A, b).seconds, e.seconds, 1e-6);
});

test('walkRoute: OSRM success returns geometry [lng,lat][] and seconds from our walking speed', async () => {
  const x = rig();
  const to = at(100, 300);
  const res = await x.w.walkRoute(A, to);
  assert.equal(res.source, 'osrm');
  assert.equal(res.geometry.length, 3);
  assert.deepEqual(res.geometry[0], [A.lng, A.lat]);
  near(res.meters, 400, 2); // distance + the tiny off-road bits (endpoints are exact here)
  near(res.seconds, 400 / 1.3, 2); // not OSRM's own duration
  assert.equal(x.urls.length, 1);
  assert.ok(x.urls[0].startsWith(`${OSRM_FOOT}/${A.lng.toFixed(5)},${A.lat.toFixed(5)};${to.lng.toFixed(5)},${to.lat.toFixed(5)}?`));
  assert.ok(x.urls[0].endsWith('overview=full&geometries=geojson'));
});

test('walkRoute: cache by ~10 m, speed applied at read time', async () => {
  const x = rig();
  const to = at(0, 300);
  await x.w.walkRoute(A, to);
  await x.w.walkRoute(offsetPoint(A, 2, 2), offsetPoint(to, -2, 1)); // within rounding
  assert.equal(x.urls.length, 1);
  x.speed = 1.0;
  const slow = await x.w.walkRoute(A, to);
  near(slow.seconds, slow.meters / 1.0, 1e-6);
  await x.w.walkRoute(offsetPoint(A, 40, 0), to); // clearly another origin
  assert.equal(x.urls.length, 2);
  x.w.clear();
  await x.w.walkRoute(A, to);
  assert.equal(x.urls.length, 3);
});

test('walkRoute: LRU eviction', async () => {
  const x = rig({ cacheSize: 2 });
  const t1 = at(0, 200), t2 = at(0, 300), t3 = at(0, 400);
  await x.w.walkRoute(A, t1); await x.w.walkRoute(A, t2);
  await x.w.walkRoute(A, t1); // refresh t1 → t2 is now the oldest
  await x.w.walkRoute(A, t3); // evicts t2
  assert.equal(x.urls.length, 3);
  await x.w.walkRoute(A, t1); await x.w.walkRoute(A, t3);
  assert.equal(x.urls.length, 3);
  await x.w.walkRoute(A, t2);
  assert.equal(x.urls.length, 4);
});

test('walkRoute: requests are spaced by the minimum gap, in order (real clock, 60 ms gap)', async () => {
  const stamps = [];
  const x = rig({ minGapMs: 60, now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
  const inner = x.fetch;
  x.w = createWalker({ fetch: (u, i) => { stamps.push(Date.now()); return inner(u, i); }, minGapMs: 60, timeoutMs: 500 });
  const dests = [at(0, 200), at(0, 300), at(0, 400), at(0, 500)];
  const out = await Promise.all(dests.map((d) => x.w.walkRoute(A, d)));
  assert.ok(out.every((r) => r.source === 'osrm'));
  assert.equal(stamps.length, 4);
  for (let i = 1; i < stamps.length; i++) assert.ok(stamps[i] - stamps[i - 1] >= 55, `gap ${stamps[i] - stamps[i - 1]}`);
  assert.deepEqual(x.urls.map((u) => /;[-\d.]+,([-\d.]+)\?/.exec(u)[1]), dests.map((d) => d.lat.toFixed(5)), 'FIFO');
});

test('walkRoute: default gap is one second (virtual clock)', async () => {
  const x = rig();
  let sleeps = [];
  x.w = createWalker({ fetch: x.fetch, now: () => x.t, sleep: async (ms) => { sleeps.push(ms); x.t += ms; }, timeoutMs: 500 });
  await Promise.all([at(0, 200), at(0, 300), at(0, 400)].map((d) => x.w.walkRoute(A, d)));
  assert.equal(x.urls.length, 3);
  assert.equal(sleeps.length, 2);
  assert.ok(sleeps.every((ms) => ms >= 999 && ms <= 1000), JSON.stringify(sleeps));
});

test('walkRoute: identical concurrent requests share one fetch', async () => {
  const x = rig();
  const to = at(0, 300);
  const [a, b] = await Promise.all([x.w.walkRoute(A, to), x.w.walkRoute(A, to)]);
  assert.equal(x.urls.length, 1);
  assert.equal(a.source, 'osrm'); assert.equal(b.source, 'osrm');
});

test('walkRoute: timeout, HTTP error, network error and bad bodies fall back to the estimate', async () => {
  const to = at(0, 300);
  const x = rig();
  x.behavior = 'hang';
  const t = await x.w.walkRoute(A, to);
  assert.equal(t.source, 'estimate');
  assert.equal(t.geometry, null);
  near(t.meters, haversine(A, to) * DETOUR, 1e-6);

  for (const mut of [
    (y) => { y.behavior = 'throw'; },
    (y) => { y.status = 503; },
    (y) => { y.respond = () => ({ code: 'NoRoute', routes: [] }); },
    (y) => { y.respond = () => ({ code: 'Ok', routes: [{ distance: 'x', geometry: { coordinates: [] } }] }); },
    (y) => { y.respond = () => null; },
  ]) {
    const y = rig(); mut(y);
    const r = await y.w.walkRoute(A, to);
    assert.equal(r.source, 'estimate');
  }
});

test('walkRoute: three failures in a row pause routing for a minute; 429 pauses at once', async () => {
  const y = rig(); y.behavior = 'throw';
  for (let i = 0; i < 3; i++) await y.w.walkRoute(A, at(0, 200 + i * 50));
  assert.equal(y.urls.length, 3);
  const r = await y.w.walkRoute(A, at(0, 700));
  assert.equal(r.source, 'estimate');
  assert.equal(y.urls.length, 3, 'no request while paused');
  y.t += 61000; y.behavior = null;
  assert.equal((await y.w.walkRoute(A, at(0, 700))).source, 'osrm');

  const z = rig(); z.status = 429;
  await z.w.walkRoute(A, at(0, 300));
  await z.w.walkRoute(A, at(0, 400));
  assert.equal(z.urls.length, 1);
});

test('walkRoute: very short or very long walks are estimated without a request', async () => {
  const x = rig();
  assert.equal((await x.w.walkRoute(A, at(0, 10))).source, 'estimate');
  assert.equal((await x.w.walkRoute(A, at(0, 9000))).source, 'estimate');
  assert.equal(x.urls.length, 0);
});

test('walkRoute: abort', async () => {
  const x = rig();
  const pre = new AbortController(); pre.abort();
  await assert.rejects(x.w.walkRoute(A, at(0, 300), { signal: pre.signal }), { name: 'AbortError' });
  assert.equal(x.urls.length, 0);

  // queued behind another request, aborted before its turn: never fetched, no budget used
  const c1 = new AbortController(), c2 = new AbortController();
  const p1 = x.w.walkRoute(A, at(0, 200), { signal: c1.signal });
  const p2 = x.w.walkRoute(A, at(0, 300), { signal: c2.signal });
  c2.abort();
  await assert.rejects(p2, { name: 'AbortError' });
  assert.equal((await p1).source, 'osrm');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(x.urls.length, 1);

  // a shared request survives when only one of two waiters aborts
  const y = rig();
  const d1 = new AbortController();
  const q1 = y.w.walkRoute(A, at(0, 300), { signal: d1.signal });
  const q2 = y.w.walkRoute(A, at(0, 300));
  d1.abort();
  await assert.rejects(q1, { name: 'AbortError' });
  assert.equal((await q2).source, 'osrm');
});

test('walkRoute: snapped ends add the off-road distance', async () => {
  const to = at(0, 300);
  const x = rig({ body: (f, t) => {
    const b = okBody(f, t, 300);
    b.routes[0].geometry.coordinates[0] = [offsetPoint(f, 0, 20).lng, offsetPoint(f, 0, 20).lat]; // route starts 20 m from the real point
    return b;
  } });
  const r = await x.w.walkRoute(A, to);
  near(r.meters, 320, 1);
});
