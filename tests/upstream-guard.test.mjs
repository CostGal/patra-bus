// TEL-399: the worker asks a broken citybus.gr less, not more.
// TEL-400: every kind of citybus.gr error gives a clean 502 (token missing, 401/403, empty, bad JSON, 5xx).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { UPSTREAM_TIMEOUT_MS } from '../worker/src/index.js';
import { CITIES } from '../web/js/cities.js';

const b64u = (o) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const jwt = (exp) => `h.${b64u({ exp })}.s`;
const future = () => Math.floor(Date.now() / 1000) + 48 * 3600;

// Fake KV, Cache API and upstream. page(): the city page answer; live(): the /stops/live answer.
async function withWorld(fn, { page, live, kvPut, cacheBroken } = {}) {
  const kv = new Map();
  const cacheStore = new Map();
  const calls = { page: 0, live: 0, signals: [], headers: [] };
  const realFetch = globalThis.fetch;
  const realCaches = globalThis.caches;
  const realError = console.error;
  console.error = () => {};
  globalThis.caches = {
    default: {
      match: async (req) => { if (cacheBroken) throw new Error('no cache'); return cacheStore.get(req.url)?.clone(); },
      put: async (req, res) => { if (cacheBroken) throw new Error('no cache'); cacheStore.set(req.url, res); },
    },
  };
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    calls.signals.push(init.signal);
    if (Object.values(CITIES).some((c) => c.page === url)) {
      calls.page++;
      return page ? page() : new Response(`<script>const token = '${jwt(future())}';</script>`);
    }
    calls.live++;
    calls.headers.push(init.headers || {});
    return live ? live(calls.live) : new Response(JSON.stringify({ vehicles: [] }));
  };
  const env = {
    KV: {
      get: async (k, type) => (kv.has(k) ? (type === 'json' ? JSON.parse(kv.get(k)) : kv.get(k)) : null),
      put: kvPut || (async (k, v) => { kv.set(k, v); }),
    },
    STATS: { idFromName: (n) => n, get: () => ({ fetch: async () => new Response('{}') }) },
    ALLOWED_ORIGIN: '*',
  };
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };
  const get = async (path) => {
    const res = await worker.fetch(new Request(`https://w.test${path}`), env, ctx);
    await Promise.allSettled(pending);
    return res;
  };
  try {
    return await fn({ get, env, ctx, kv, calls });
  } finally {
    globalThis.fetch = realFetch;
    globalThis.caches = realCaches;
    console.error = realError;
  }
}

for (const [name, live] of [
  ['5xx', () => new Response('oops', { status: 503 })],
  ['empty body', () => new Response('')],
  ['bad JSON', () => new Response('{nope')],
  ['network error', () => { throw new TypeError('network'); }],
]) {
  test(`live: after an upstream ${name}, the same stop is not asked again for 15 s`, () => withWorld(async ({ get, calls }) => {
    const first = await get('/api/patra/live/1011');
    assert.equal(first.status, 502);
    assert.equal(calls.live, 1);
    const second = await get('/api/patra/live/1011');
    assert.equal(second.status, 502);
    assert.deepEqual(await second.json(), { error: 'upstream', status: 502 });
    assert.equal(calls.live, 1, 'second request is answered from the failure marker');
    // Another stop and another city are not blocked.
    await get('/api/patra/live/2000');
    await get('/api/corfu/live/1011');
    assert.equal(calls.live, 3);
  }, { live }));
}

test('live: a 404 (no service) is a normal answer, not a failure', () => withWorld(async ({ get, calls }) => {
  assert.equal((await get('/api/patra/live/999')).status, 200);
  assert.equal(calls.live, 1);
}, { live: () => new Response('', { status: 404 }) }));

test('token: parallel requests share one scrape of the city page', () => withWorld(async ({ get, calls }) => {
  const res = await Promise.all(['1', '2', '3', '4'].map((c) => get(`/api/patra/live/${c}`)));
  for (const r of res) assert.equal(r.status, 200);
  assert.equal(calls.page, 1);
}));

test('token: an already expired token is not stored and the request fails', () => withWorld(async ({ get, kv }) => {
  assert.equal((await get('/api/patra/live/1011')).status, 502);
  assert.equal(kv.has('token/patra'), false);
}, { page: () => new Response(`<script>const token = '${jwt(Math.floor(Date.now() / 1000) - 10)}';</script>`) }));

test('token: a KV put that throws does not break the request', () => withWorld(async ({ get }) => {
  assert.equal((await get('/api/patra/live/1011')).status, 200);
}, { kvPut: async () => { throw new Error('KV down'); } }));

test('every call to citybus has a time limit', () => withWorld(async ({ get, calls }) => {
  await get('/api/patra/live/1011');
  assert.ok(UPSTREAM_TIMEOUT_MS > 0 && UPSTREAM_TIMEOUT_MS <= 10000);
  assert.equal(calls.signals.length, 2);
  for (const s of calls.signals) assert.ok(s instanceof AbortSignal);
}));

// TEL-400: token problems.
const tokenPage = (exp) => () => new Response(`<script>const token = '${jwt(exp)}';</script>`);
for (const [name, page] of [
  ['no token on the city page', () => new Response('<html>nothing here</html>')],
  ['city page 5xx', () => new Response('down', { status: 500 })],
  ['token that is not a JWT', () => new Response("<script>const token = 'garbage';</script>")],
  ['city page unreachable', () => { throw new TypeError('network'); }],
]) {
  test(`token: ${name} gives 502 and citybus API is not called`, () => withWorld(async ({ get, calls, kv }) => {
    const res = await get('/api/patra/live/1011');
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: 'upstream', status: 502 });
    assert.equal(calls.live, 0);
    assert.equal(kv.has('token/patra'), false);
  }, { page }));
}

test('token: a stored token that is still good is reused, no scrape', () => withWorld(async ({ get, calls, kv }) => {
  kv.set('token/patra', JSON.stringify({ token: jwt(future()), exp: future() }));
  assert.equal((await get('/api/patra/live/1011')).status, 200);
  assert.equal(calls.page, 0);
}));

test('token: a stored token about to expire is replaced', () => withWorld(async ({ get, calls, kv }) => {
  const soon = Math.floor(Date.now() / 1000) + 60;
  kv.set('token/patra', JSON.stringify({ token: jwt(soon), exp: soon }));
  assert.equal((await get('/api/patra/live/1011')).status, 200);
  assert.equal(calls.page, 1);
  assert.ok(JSON.parse(kv.get('token/patra')).exp > soon);
}, { page: tokenPage(future()) }));

for (const status of [401, 403]) {
  test(`${status}: the worker takes a fresh token and retries once, with a Referer`, () => withWorld(async ({ get, calls }) => {
    const res = await get('/api/patra/live/1011');
    assert.equal(res.status, 200);
    assert.equal(calls.live, 2);
    assert.equal(calls.page, 2, 'first scrape, then a forced one');
    assert.equal(calls.headers[0].Referer, undefined);
    assert.ok(calls.headers[1].Referer?.startsWith('https://'));
    assert.match(calls.headers[1].Authorization, /^Bearer /);
  }, { live: (n) => (n === 1 ? new Response('', { status }) : new Response(JSON.stringify({ vehicles: [] }))) }));

  test(`${status} twice: one retry only, then 502`, () => withWorld(async ({ get, calls }) => {
    assert.equal((await get('/api/patra/live/1011')).status, 502);
    assert.equal(calls.live, 2);
  }, { live: () => new Response('', { status }) }));
}

// TEL-400: stops and lines fail the same way and an error is never cached.
for (const kind of ['stops', 'lines']) {
  for (const [name, live] of [
    ['5xx', () => new Response('oops', { status: 500 })],
    ['empty body', () => new Response('  ')],
    ['bad JSON', () => new Response('<html>')],
  ]) {
    test(`${kind}: upstream ${name} gives 502 and is not cached`, () => withWorld(async ({ get, calls }) => {
      assert.equal((await get(`/api/patra/${kind}`)).status, 502);
      assert.equal((await get(`/api/patra/${kind}`)).status, 502);
      assert.equal(calls.live, 2, 'second request asks again: a failure is not stored');
    }, { live }));
  }
}

// TEL-400: when the Cache API is unusable, the KV memo keeps the 15 s floor.
test('cache: without the Cache API, live is cached in KV and served as a HIT', () => withWorld(async ({ get, calls, kv }) => {
  const first = await get('/api/patra/live/1011');
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('X-Cache'), 'MISS');
  assert.ok(kv.has('memo/live/patra/1011'));
  const second = await get('/api/patra/live/1011');
  assert.equal(second.headers.get('X-Cache'), 'HIT');
  assert.equal(calls.live, 1);
}, { cacheBroken: true }));

test('cache: without the Cache API, an old KV memo is not used', () => withWorld(async ({ get, calls, kv }) => {
  kv.set('memo/live/patra/1011', JSON.stringify({ t: Date.now() - 16000, body: '{"old":true}' }));
  const res = await get('/api/patra/live/1011');
  assert.equal(res.headers.get('X-Cache'), 'MISS');
  assert.equal(calls.live, 1);
}, { cacheBroken: true }));

test('cache: without the Cache API, the failure marker also lives in KV', () => withWorld(async ({ get, calls, kv }) => {
  assert.equal((await get('/api/patra/live/1011')).status, 502);
  assert.ok(kv.has('memo/fail/live/patra/1011'));
  assert.equal((await get('/api/patra/live/1011')).status, 502);
  assert.equal(calls.live, 1);
}, { cacheBroken: true, live: () => new Response('oops', { status: 503 }) }));
