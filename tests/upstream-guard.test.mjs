// TEL-399: the worker asks a broken citybus.gr less, not more.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { UPSTREAM_TIMEOUT_MS } from '../worker/src/index.js';
import { CITIES } from '../web/js/cities.js';

const b64u = (o) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const jwt = (exp) => `h.${b64u({ exp })}.s`;
const future = () => Math.floor(Date.now() / 1000) + 48 * 3600;

// Fake KV, Cache API and upstream. page(): the city page answer; live(): the /stops/live answer.
async function withWorld(fn, { page, live, kvPut } = {}) {
  const kv = new Map();
  const cacheStore = new Map();
  const calls = { page: 0, live: 0, signals: [] };
  const realFetch = globalThis.fetch;
  const realCaches = globalThis.caches;
  const realError = console.error;
  console.error = () => {};
  globalThis.caches = {
    default: {
      match: async (req) => cacheStore.get(req.url)?.clone(),
      put: async (req, res) => { cacheStore.set(req.url, res); },
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
    return live ? live() : new Response(JSON.stringify({ vehicles: [] }));
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
