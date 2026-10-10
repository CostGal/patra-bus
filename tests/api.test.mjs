import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  fetchLive, remainingSec, createLivePoller, ApiError, lastAttemptAt, _setTransport,
  MIN_GAP_MS, POLL_MS, API_BASE,
} from '../web/js/api.js';
import { _setDemoData } from '../web/js/demo.js';

const flush = () => new Promise((r) => setImmediate(r));
const fixture = JSON.parse(readFileSync(new URL('../web/fixtures/live-1011.json', import.meta.url), 'utf8'));

// A fake world: virtual clock + timers, a scripted fetch, a fake document.
function rig(over = {}) {
  const w = {
    now: Date.UTC(2026, 9, 9, 19, 24, 33),
    timers: [],
    nextId: 1,
    calls: [], // { url, signal }
    handler: null, // (call) => Response-like | Promise
    visibility: 'visible',
    listeners: new Set(),
  };
  const ok = (body) => ({ ok: true, status: 200, json: async () => body });
  w.ok = ok;
  w.vehicle = (o = {}) => ({ lineCode: '609', routeCode: '6091', routeName: 'A', color: '#787878', textColor: '#fff', live: true, departureMins: 1, etaSec: 74, vehicleCode: 'V1', lat: 38.26, lng: 21.75, ...o });
  w.body = (vehicles = [w.vehicle()], extra = {}) => ({ fetchedAt: w.now, vehicles, ...extra });
  w.handler = () => ok(w.body());
  const fakeFetch = (url, init = {}) => {
    const call = { url, signal: init.signal };
    w.calls.push(call);
    return Promise.resolve(w.handler(call));
  };
  const doc = {
    get visibilityState() { return w.visibility; },
    addEventListener: (t, fn) => { if (t === 'visibilitychange') w.listeners.add(fn); },
    removeEventListener: (t, fn) => { if (t === 'visibilitychange') w.listeners.delete(fn); },
  };
  w.setVisibility = async (v) => { w.visibility = v; for (const fn of [...w.listeners]) fn(); await flush(); };
  w.advance = async (ms) => {
    const end = w.now + ms;
    for (;;) {
      const next = w.timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      w.now = Math.max(w.now, next.at);
      w.timers.splice(w.timers.indexOf(next), 1);
      next.fn();
      await flush();
    }
    w.now = end;
    await flush();
  };
  _setTransport({
    fetch: fakeFetch,
    now: () => w.now,
    setTimeout: (fn, ms) => { const t = { id: w.nextId++, at: w.now + ms, fn }; w.timers.push(t); return t.id; },
    clearTimeout: (id) => { w.timers = w.timers.filter((t) => t.id !== id); },
    doc,
    demoDelayMs: 0,
    ...over,
  });
  return w;
}

beforeEach(() => _setTransport());
after(() => _setTransport());

const rejects = async (p, kind) => {
  await assert.rejects(p, (e) => e instanceof ApiError && e.kind === kind, `expected ApiError(${kind})`);
};

// ---------- remainingSec ----------

test('remainingSec: ETA minus age, never negative, same for live and scheduled', () => {
  const live = { etaSec: 74, live: true };
  const sched = { etaSec: 1260, live: false };
  assert.equal(remainingSec(live, 1000, 1000), 74);
  assert.equal(remainingSec(live, 1000, 11000), 64);
  assert.equal(remainingSec(sched, 1000, 11000), 1250);
  assert.equal(remainingSec(live, 1000, 1000 + 74000), 0);
  assert.equal(remainingSec(live, 1000, 1000 + 500000), 0);
  assert.equal(remainingSec(live, 5000, 1000), 78, 'a fetchedAt slightly in the future adds time');
  assert.ok(Math.abs(remainingSec(live, 0, 250) - 73.75) < 1e-9, 'fractional');
});

// ---------- fetchLive ----------

test('fetchLive: requests the worker route and returns the LiveResult', async () => {
  const w = rig();
  const r = await fetchLive('1011');
  assert.equal(w.calls.length, 1);
  assert.equal(w.calls[0].url, `${API_BASE}/api/live/1011`);
  assert.equal(r.fetchedAt, w.now);
  assert.equal(r.vehicles.length, 1);
  assert.equal(r.vehicles[0].vehicleCode, 'V1');
  assert.ok(!('noService' in r));
});

test('15 s memo: calls within the floor share one attempt; the next one after it fetches again', async () => {
  const w = rig();
  const a = await fetchLive('1011');
  w.now += MIN_GAP_MS - 1;
  const b = await fetchLive('1011');
  assert.equal(w.calls.length, 1);
  assert.equal(b.fetchedAt, a.fetchedAt);
  assert.equal(lastAttemptAt('1011'), a.fetchedAt);
  w.now += 1;
  const c = await fetchLive('1011');
  assert.equal(w.calls.length, 2);
  assert.equal(c.fetchedAt, w.now);
});

test('15 s memo covers errors too: a retry cannot beat the floor', async () => {
  const w = rig();
  w.handler = () => { throw new TypeError('Failed to fetch'); };
  await rejects(fetchLive('1011'), 'network');
  w.now += 5000;
  await rejects(fetchLive('1011'), 'network');
  w.now += 9999;
  await rejects(fetchLive('1011'), 'network');
  assert.equal(w.calls.length, 1, 'one upstream attempt in the first 15 s');
  w.now += 1;
  w.handler = () => w.ok(w.body());
  const r = await fetchLive('1011');
  assert.equal(w.calls.length, 2);
  assert.equal(r.vehicles.length, 1);
});

test('the floor is per stop, not global', async () => {
  const w = rig();
  await fetchLive('1011');
  await fetchLive('1012');
  await fetchLive('1011');
  await fetchLive('1012');
  assert.deepEqual(w.calls.map((c) => c.url.split('/').pop()), ['1011', '1012']);
});

test('in-flight dedupe: concurrent calls share one request; each caller gets its own copy', async () => {
  const w = rig();
  let release;
  w.handler = () => new Promise((res) => { release = () => res(w.ok(w.body([w.vehicle(), w.vehicle({ etaSec: 300, vehicleCode: 'V2' })]))); });
  const ps = [fetchLive('1011'), fetchLive('1011'), fetchLive('1011')];
  await flush();
  assert.equal(w.calls.length, 1);
  release();
  const [a, b, c] = await Promise.all(ps);
  assert.equal(w.calls.length, 1);
  assert.deepEqual(a, b);
  assert.deepEqual(a, c);
  a.vehicles.reverse();
  a.vehicles[0].etaSec = 999;
  assert.equal(b.vehicles[0].etaSec, 74, 'mutating one result does not touch another');
});

test('timeout: a hung request fails with kind "timeout" after timeoutMs and is aborted', async () => {
  const w = rig({ timeoutMs: 10000 });
  w.handler = () => new Promise(() => {}); // never answers
  const p = fetchLive('1011').then(() => 'ok', (e) => e);
  await flush();
  await w.advance(9999);
  assert.equal(w.timers.length, 1, 'only the timeout timer is pending');
  await w.advance(1);
  const e = await p;
  assert.ok(e instanceof ApiError);
  assert.equal(e.kind, 'timeout');
  assert.equal(w.calls[0].signal.aborted, true);
  await rejects(fetchLive('1011'), 'timeout'); // memoised failure, no second request
  assert.equal(w.calls.length, 1);
});

test('typed errors: network, upstream (HTTP), bad (JSON / shape)', async () => {
  const w = rig();
  const next = async (handler, kind) => {
    w.now += MIN_GAP_MS;
    w.handler = handler;
    await rejects(fetchLive('1011'), kind);
  };
  await next(() => { throw new TypeError('offline'); }, 'network');
  await next(() => Promise.reject(new Error('x')), 'network');
  await next(() => ({ ok: false, status: 502, json: async () => ({ error: 'upstream' }) }), 'upstream');
  await next(() => ({ ok: false, status: 404, json: async () => ({}) }), 'upstream');
  await next(() => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected end of JSON input'); } }), 'bad');
  await next(() => w.ok({ fetchedAt: w.now }), 'bad');
  await next(() => w.ok({ vehicles: [] }), 'bad');
  await next(() => w.ok({ fetchedAt: 'soon', vehicles: [] }), 'bad');
  await next(() => w.ok(null), 'bad');
  w.now += MIN_GAP_MS;
  w.handler = () => ({ ok: false, status: 503, json: async () => ({}) });
  await assert.rejects(fetchLive('1011'), (e) => e.kind === 'upstream' && e.status === 503);
});

test('invalid stop codes are rejected without touching the network', async () => {
  const w = rig();
  for (const code of ['', 'abc', '12/34', '1234567', '../x', '10 11']) await rejects(fetchLive(code), 'bad');
  assert.equal(w.calls.length, 0);
  await fetchLive(1011); // a number is fine
  assert.equal(w.calls.length, 1);
});

test('a caller signal detaches only that caller', async () => {
  const w = rig();
  let release;
  w.handler = () => new Promise((res) => { release = () => res(w.ok(w.body())); });
  const ctl = new AbortController();
  const p1 = fetchLive('1011', { signal: ctl.signal }).then(() => 'ok', (e) => e);
  const p2 = fetchLive('1011');
  await flush();
  ctl.abort();
  const e = await p1;
  assert.equal(e.name, 'AbortError');
  release();
  assert.equal((await p2).vehicles.length, 1);
  assert.equal(w.calls.length, 1);
  assert.equal(w.calls[0].signal.aborted, false, 'the shared request was not cancelled');
  await assert.rejects(fetchLive('1011', { signal: AbortSignal.abort() }), { name: 'AbortError' });
});

test('noService passes through; otherwise the flag is absent', async () => {
  const w = rig();
  w.handler = () => w.ok({ fetchedAt: w.now, vehicles: [], noService: true });
  assert.deepEqual(await fetchLive('1011'), { fetchedAt: w.now, vehicles: [], noService: true });
  w.now += MIN_GAP_MS;
  w.handler = () => w.ok({ fetchedAt: w.now, vehicles: [], noService: false });
  const r = await fetchLive('1011');
  assert.ok(!('noService' in r));
});

test('client-side sanitising: 0/0 never live, scheduled lose coordinates, vehicleCode defaults to null, sorted', async () => {
  const w = rig();
  w.handler = () => w.ok(w.body([
    w.vehicle({ vehicleCode: undefined, etaSec: 600, live: false, lat: 38.2, lng: 21.7 }), // scheduled with stray coordinates
    w.vehicle({ vehicleCode: 'Z', etaSec: 100, lat: 0, lng: 0 }), // claims live but 0/0
    w.vehicle({ vehicleCode: 'Y', etaSec: 50 }),
    w.vehicle({ vehicleCode: 'W', etaSec: 70, lat: 'x' }),
  ]));
  const { vehicles } = await fetchLive('1011');
  assert.deepEqual(vehicles.map((v) => v.etaSec), [50, 70, 100, 600]);
  assert.deepEqual(vehicles.map((v) => v.live), [true, false, false, false]);
  for (const v of vehicles.filter((x) => !x.live)) assert.ok(!('lat' in v) && !('lng' in v), v.vehicleCode);
  assert.equal(vehicles[3].vehicleCode, null);
  assert.deepEqual([vehicles[0].lat, vehicles[0].lng], [38.26, 21.75]);
});

test('clock skew: a fetchedAt far from the device clock is replaced by "now"; a normal cache age is kept', async () => {
  const w = rig();
  w.handler = () => w.ok(w.body([w.vehicle()], { fetchedAt: w.now - 12000 })); // worker cache hit
  assert.equal((await fetchLive('1011')).fetchedAt, w.now - 12000);
  w.now += MIN_GAP_MS;
  w.handler = () => w.ok(w.body([w.vehicle()], { fetchedAt: w.now - 10 * 60000 })); // device clock 10 min ahead
  assert.equal((await fetchLive('1011')).fetchedAt, w.now);
  w.now += MIN_GAP_MS;
  w.handler = () => w.ok(w.body([w.vehicle()], { fetchedAt: w.now + 60000 })); // device clock behind
  assert.equal((await fetchLive('1011')).fetchedAt, w.now);
});

test('the real fixture goes through normalise + client sanitising unchanged', async () => {
  const { normalizeLive } = await import('../web/js/arrivals.js');
  const w = rig();
  w.handler = () => w.ok(normalizeLive(fixture, w.now));
  const { vehicles } = await fetchLive('1011');
  assert.deepEqual(vehicles.map((v) => [v.lineCode, v.live, v.etaSec]), [['609', true, 74], ['201', false, 1260]]);
});

// ---------- demo transport ----------

test('DEMO uses demo.js instead of the network, with the same memo and shapes', async () => {
  const w = rig({ demo: true });
  _setDemoData({
    stops: [{ code: 'S1', name: 'S1', latitude: 38.2, longitude: 21.7, lineCodes: ['9'], routeCodes: ['R1'] }, { code: 'S2', name: 'S2', latitude: 38.202, longitude: 21.701, lineCodes: ['9'], routeCodes: ['R1'] }],
    lines: [{ code: '9', name: 'N', color: '#111111', textColor: '#ffffff', routes: [{ code: 'R1', name: 'R', direction: 1 }] }],
    routes: { routes: { R1: { code: 'R1', lineCode: '9', name: 'R', direction: 1, stops: ['S1', 'S2'], legSec: [120] } } },
  });
  const r = await fetchLive('S2');
  assert.equal(w.calls.length, 0, 'no network');
  assert.equal(r.fetchedAt, w.now);
  assert.ok(r.vehicles.length > 0);
  for (const v of r.vehicles) assert.ok(v.vehicleCode && typeof v.live === 'boolean');
  assert.deepEqual(await fetchLive('S2'), r, 'memoised within 15 s');
  w.now += 5000;
  assert.equal((await fetchLive('S2')).fetchedAt, r.fetchedAt);
  w.now += MIN_GAP_MS;
  assert.equal((await fetchLive('S2')).fetchedAt, w.now);
  assert.deepEqual((await fetchLive('nope')).noService, true);
  _setDemoData(null);
});

test('?demo=nosvc and ?demo=error exercise those states', async () => {
  rig({ demo: true, demoMode: 'nosvc' });
  assert.equal((await fetchLive('1011')).noService, true);
  rig({ demo: true, demoMode: 'error' });
  await rejects(fetchLive('1011'), 'upstream');
});

// ---------- poller ----------

function watch(w, code = '1011') {
  const updates = [];
  const poller = createLivePoller(code, (s) => updates.push({ ...s, at: w.now }));
  return { poller, updates, last: () => updates[updates.length - 1] };
}

test('poller: first update is async, then loading -> data with nextAt = attempt + 20 s', async () => {
  const w = rig();
  const { updates, last } = watch(w);
  assert.equal(updates.length, 0, 'nothing synchronously, so `const p = createLivePoller(..)` is usable in the callback');
  await flush();
  assert.equal(w.calls.length, 1);
  assert.deepEqual(updates.map((u) => [u.loading, !!u.data, u.error]), [[true, false, null], [false, true, null]]);
  assert.equal(last().nextAt, w.now + POLL_MS);
});

test('poller: polls every 20 s, never faster than the 15 s floor', async () => {
  const w = rig();
  const { last } = watch(w);
  await flush();
  await w.advance(POLL_MS - 1);
  assert.equal(w.calls.length, 1);
  await w.advance(1);
  assert.equal(w.calls.length, 2);
  await w.advance(POLL_MS * 5);
  assert.equal(w.calls.length, 7);
  assert.equal(last().error, null);
});

test('poller: pauses while hidden, refreshes on visible only if the last attempt is >= 15 s old', async () => {
  const w = rig();
  watch(w);
  await flush();
  assert.equal(w.calls.length, 1);
  await w.advance(5000);
  await w.setVisibility('hidden');
  assert.equal(w.timers.length, 0, 'no timers while hidden');
  await w.advance(120000);
  assert.equal(w.calls.length, 1, 'no polling while hidden');
  await w.setVisibility('visible');
  assert.equal(w.calls.length, 2, 'stale on return: fetch right away');

  // hide briefly: coming back < 15 s after the last attempt does not fetch, and the cadence resumes
  await w.advance(3000);
  await w.setVisibility('hidden');
  await w.advance(4000);
  await w.setVisibility('visible');
  assert.equal(w.calls.length, 2);
  await w.advance(POLL_MS - 7000 - 1);
  assert.equal(w.calls.length, 2);
  await w.advance(1);
  assert.equal(w.calls.length, 3);
});

test('poller created while hidden waits for visibility', async () => {
  const w = rig();
  w.visibility = 'hidden';
  const { updates, last } = watch(w);
  await flush();
  assert.equal(w.calls.length, 0);
  assert.equal(last().loading, true);
  assert.equal(updates.length, 1);
  await w.setVisibility('visible');
  assert.equal(w.calls.length, 1);
  assert.equal(last().data.vehicles.length, 1);
});

test('poller: manual refresh respects the floor (deferred, not dropped)', async () => {
  const w = rig();
  const { poller, last } = watch(w);
  await flush();
  assert.equal(w.calls.length, 1);
  await w.advance(4000);
  poller.refresh();
  await flush();
  assert.equal(w.calls.length, 1, 'too soon');
  assert.equal(last().nextAt, w.now + (MIN_GAP_MS - 4000), 'brought forward to the floor, not earlier');
  await w.advance(MIN_GAP_MS - 4000 - 1);
  assert.equal(w.calls.length, 1);
  await w.advance(1);
  assert.equal(w.calls.length, 2);
  assert.equal(last().nextAt, w.now + POLL_MS, 'cadence restarts from the new attempt');
  // after the floor a refresh goes straight through
  await w.advance(16000);
  poller.refresh();
  await flush();
  assert.equal(w.calls.length, 3);
});

test('poller: errors keep the last good data and keep polling', async () => {
  const w = rig();
  const { updates, last } = watch(w);
  await flush();
  const good = last().data;
  w.handler = () => { throw new TypeError('offline'); };
  await w.advance(POLL_MS);
  assert.equal(last().error.kind, 'network');
  assert.deepEqual(last().data, good, 'stale data stays available');
  assert.equal(last().loading, false);
  assert.equal(last().nextAt, w.now + POLL_MS);
  w.handler = () => w.ok(w.body());
  await w.advance(POLL_MS);
  assert.equal(last().error, null);
  assert.equal(w.calls.length, 3);
  assert.ok(updates.length >= 6);
});

test('poller shares the global memo: a recent fetch by someone else is reused and the cadence aligns to it', async () => {
  const w = rig();
  await fetchLive('1011'); // e.g. the nearby card
  w.now += 5000;
  const { last } = watch(w);
  await flush();
  assert.equal(w.calls.length, 1, 'no extra upstream request');
  assert.equal(last().data.fetchedAt, w.now - 5000);
  assert.equal(last().nextAt, w.now + POLL_MS - 5000);
  await w.advance(POLL_MS - 5000);
  assert.equal(w.calls.length, 2);
});

test('poller: destroy stops everything and detaches the listener', async () => {
  const w = rig();
  const { poller, updates } = watch(w);
  await flush();
  assert.equal(w.listeners.size, 1);
  const n = updates.length;
  poller.destroy();
  assert.equal(w.listeners.size, 0);
  assert.equal(w.timers.length, 0);
  await w.advance(POLL_MS * 3);
  await w.setVisibility('hidden');
  await w.setVisibility('visible');
  assert.equal(w.calls.length, 1);
  assert.equal(updates.length, n);
  poller.refresh(); // harmless
  await flush();
  assert.equal(w.calls.length, 1);
});

test('poller: destroy while a request is in flight does not emit', async () => {
  const w = rig();
  let release;
  w.handler = () => new Promise((res) => { release = () => res(w.ok(w.body())); });
  const { poller, updates } = watch(w);
  await flush();
  const n = updates.length; // the loading update
  poller.destroy();
  release();
  await flush();
  assert.equal(updates.length, n);
});
