import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRoute } from '../worker/src/routes.js';
import { statsName, recordStats, readStats } from '../worker/src/stats.js';
import { validateReminder, ReminderBase } from '../worker/src/reminders.js';
import { validateRoutine, RoutineBase } from '../worker/src/routines.js';
import worker, { liveBody } from '../worker/src/index.js';
import { CITIES, apiBase } from '../web/js/cities.js';

// --- parseRoute ---
test('parseRoute: city-prefixed routes', () => {
  assert.deepEqual(parseRoute('/api/corfu/live/801'), { city: 'corfu', kind: 'live', args: ['801'] });
  assert.deepEqual(parseRoute('/api/patra/live/1011'), { city: 'patra', kind: 'live', args: ['1011'] });
  assert.deepEqual(parseRoute('/api/corfu/stops'), { city: 'corfu', kind: 'stops', args: [] });
  assert.deepEqual(parseRoute('/api/patra/lines'), { city: 'patra', kind: 'lines', args: [] });
  assert.deepEqual(parseRoute('/api/corfu/stats/2015/801'), { city: 'corfu', kind: 'stats', args: ['2015', '801'] });
});

test('parseRoute: un-prefixed aliases are Patras', () => {
  assert.deepEqual(parseRoute('/api/live/1011'), { city: 'patra', kind: 'live', args: ['1011'] });
  assert.deepEqual(parseRoute('/api/stops'), { city: 'patra', kind: 'stops', args: [] });
  assert.deepEqual(parseRoute('/api/lines'), { city: 'patra', kind: 'lines', args: [] });
  assert.deepEqual(parseRoute('/api/stats/2015/1011'), { city: 'patra', kind: 'stats', args: ['2015', '1011'] });
});

test('parseRoute: unknown city or shape is null (404)', () => {
  for (const p of [
    '/api/nope/lines',
    '/api/nope/live/1',
    '/api/CORFU/lines',
    '/api/constructor/lines',
    '/api/__proto__/stops',
    '/api/toString/stops',
    '/api/corfu',
    '/api/corfu/',
    '/api/corfu/nope',
    '/api/corfu/corfu/lines',
    '/api/corfu/live',
    '/api/corfu/live/',
    '/api/corfu/live/abc',
    '/api/corfu/live/1234567',
    '/api/corfu/live/1/2',
    '/api/corfu/stops/extra',
    '/api/corfu/stats/1',
    '/api/corfu/stats//1',
    '/api/live',
    '/api/stats/1',
    '/api',
    '/api/',
    '/health',
    '/corfu/lines',
    '',
  ]) {
    assert.equal(parseRoute(p), null, p);
  }
});

test('parseRoute: stats args are passed through for the caller to validate (400, not 404)', () => {
  assert.deepEqual(parseRoute('/api/stats/abc/1'), { city: 'patra', kind: 'stats', args: ['abc', '1'] });
});

// --- stats keys ---
test('statsName: Patras keeps the old name, other cities are prefixed', () => {
  assert.equal(statsName('patra', '2015', '1011'), '2015/1011');
  assert.equal(statsName('corfu', '2015', '1011'), 'corfu/2015/1011');
});

function fakeStats() {
  const names = [];
  const posts = [];
  return {
    names,
    posts,
    STATS: {
      idFromName: (n) => { names.push(n); return n; },
      get: (id) => ({
        fetch: async (url, init = {}) => {
          if (init.method === 'POST') { posts.push([id, JSON.parse(init.body)]); return new Response('{}'); }
          return new Response(JSON.stringify({ samples: 0, id }));
        },
      }),
    },
  };
}

test('recordStats / readStats pick the DO name per city', async () => {
  const result = { fetchedAt: 1, vehicles: [{ routeCode: '2015', vehicleCode: 'v1', live: false, etaSec: 300 }] };
  const patra = fakeStats();
  await recordStats(patra, 'patra', '1011', result);
  assert.deepEqual(patra.names, ['2015/1011']);
  assert.equal(patra.posts.length, 1);
  const corfu = fakeStats();
  await recordStats(corfu, 'corfu', '801', result);
  assert.deepEqual(corfu.names, ['corfu/2015/801']);
  assert.equal(JSON.parse(await readStats(corfu, 'corfu', '2015', '801')).id, 'corfu/2015/801');
  assert.equal(JSON.parse(await readStats(patra, 'patra', '2015', '1011')).id, '2015/1011');
});

// --- push validation: city ---
const RFC_UA = 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
const RFC_AUTH = 'BTBZMqHH6r4Tts7J_aSIgg';
const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const sub = () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: RFC_UA, auth: RFC_AUTH } });
const remReq = (over = {}) => ({
  subscription: sub(),
  at: NOW + 600e3,
  title: 'Ώρα να φύγεις',
  tag: 't-1',
  trip: { stopCode: '801', routeCode: '2015', lineCode: '201', offsetSec: 300 },
  ...over,
});
const rouReq = (over = {}) => ({
  subscription: sub(),
  days: [1],
  time: '08:10',
  tz: 'Europe/Athens',
  title: 'Φύγε',
  trip: { stopCode: '801', routeCode: '2015', lineCode: '201', offsetSec: 300 },
  leadMin: 2,
  ...over,
});

test('validateReminder / validateRoutine: optional city, default patra', () => {
  assert.equal(validateReminder(remReq(), NOW).value.city, 'patra');
  assert.equal(validateReminder(remReq({ city: 'corfu' }), NOW).value.city, 'corfu');
  assert.equal(validateReminder(remReq({ city: 'patra' }), NOW).value.city, 'patra');
  assert.equal(validateRoutine(rouReq()).value.city, 'patra');
  assert.equal(validateRoutine(rouReq({ city: 'corfu' })).value.city, 'corfu');
});

test('validateReminder / validateRoutine: bad city is field "city"', () => {
  for (const city of ['nope', 'CORFU', '', 5, null, true, ['corfu'], { id: 'corfu' }, 'constructor', '__proto__']) {
    assert.equal(validateReminder(remReq({ city }), NOW).error, 'city', JSON.stringify(city));
    assert.equal(validateRoutine(rouReq({ city })).error, 'city', JSON.stringify(city));
  }
});

// --- Durable Objects pass the stored city to getLive ---
function fakeStorage() {
  const raw = new Map();
  return {
    raw,
    alarm: null,
    async get(k) { return raw.get(k); },
    async put(k, v) { raw.set(k, v); },
    async setAlarm(t) { this.alarm = t; },
    async deleteAlarm() { this.alarm = null; },
    async deleteAll() { raw.clear(); },
  };
}

async function withQuietConsole(fn) {
  const realErr = console.error;
  console.error = () => {};
  try { return await fn(); } finally { console.error = realErr; }
}

test('Reminder DO: getLive gets the stored city; reminders without city are Patras', () => withQuietConsole(async () => {
  const calls = [];
  class T extends ReminderBase {
    async getLive(city, code) { calls.push([city, code]); return null; }
  }
  for (const [city, want] of [['corfu', 'corfu'], [undefined, 'patra']]) {
    const storage = fakeStorage();
    const r = { ...validateReminder(remReq({ city }), NOW).value, rearms: 0, pending: null };
    if (!city) delete r.city; // stored before multi-city
    await storage.put('r', r);
    await new T({ storage }, {}).alarm();
    assert.deepEqual(calls.pop(), [want, '801']);
  }
}));

test('Routine DO: getLive gets the stored city; routines without city are Patras', async () => {
  const calls = [];
  class T extends RoutineBase {
    async getLive(city, code) { calls.push([city, code]); return null; }
  }
  const realNow = Date.now;
  try {
    for (const withCity of ['corfu', undefined]) {
      const storage = fakeStorage();
      const routine = { id: 'abc', ...validateRoutine(rouReq({ days: [0, 1, 2, 3, 4, 5, 6] })).value };
      if (withCity) routine.city = withCity;
      else delete routine.city;
      await new T({ storage }, {}).fetch(new Request('https://routine/', { method: 'POST', body: JSON.stringify(routine) }));
      Date.now = () => storage.alarm; // the check alarm fires
      await withQuietConsole(() => new T({ storage }, {}).alarm());
      assert.deepEqual(calls.pop(), [withCity || 'patra', '801']);
    }
  } finally {
    Date.now = realNow;
  }
});

// --- the worker end to end (fake KV, Cache API and upstream) ---
const b64u = (o) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const jwt = (exp) => `h.${b64u({ exp })}.s`;
const EXP = Math.floor(Date.now() / 1000) + 48 * 3600;

async function withWorld(fn, { upstream } = {}) {
  const kv = new Map();
  const cacheStore = new Map();
  const fetched = [];
  const realFetch = globalThis.fetch;
  const realCaches = globalThis.caches;
  globalThis.caches = {
    default: {
      match: async (req) => cacheStore.get(req.url)?.clone(),
      put: async (req, res) => { cacheStore.set(req.url, res); },
    },
  };
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    fetched.push({ url, auth: init.headers?.Authorization });
    const page = Object.values(CITIES).find((c) => c.page === url);
    if (page) return new Response(`<script>const token = '${jwt(EXP + page.agency)}';</script>`);
    if (upstream) return upstream(url);
    return new Response(JSON.stringify({ vehicles: [] }));
  };
  const env = {
    KV: {
      get: async (k, type) => (kv.has(k) ? (type === 'json' ? JSON.parse(kv.get(k)) : kv.get(k)) : null),
      put: async (k, v) => { kv.set(k, v); },
    },
    STATS: fakeStats().STATS,
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
    return await fn({ get, env, ctx, kv, fetched, cacheStore });
  } finally {
    globalThis.fetch = realFetch;
    globalThis.caches = realCaches;
  }
}

test('worker: unknown city and unknown paths are 404 not_found', () => withWorld(async ({ get, fetched }) => {
  for (const p of ['/api/nope/lines', '/api/nope/live/1', '/api/corfu/nope', '/api/live/abc', '/nothing']) {
    const res = await get(p);
    assert.equal(res.status, 404, p);
    assert.deepEqual(await res.json(), { error: 'not_found' });
  }
  assert.equal(fetched.length, 0, 'no upstream call for a rejected request');
}));

test('worker: live per city uses that city\'s page, token, agency and cache key', () => withWorld(async ({ get, kv, fetched, cacheStore }) => {
  const c = await get('/api/corfu/live/801');
  assert.equal(c.status, 200);
  assert.equal((await c.json()).vehicles.length, 0);
  assert.equal(c.headers.get('X-Cache'), 'MISS');
  assert.ok(fetched.some((f) => f.url === CITIES.corfu.page));
  const upstreamCall = fetched.find((f) => f.url === `${apiBase(CITIES.corfu)}/stops/live/801`);
  assert.ok(upstreamCall, 'corfu agency path');
  assert.equal(upstreamCall.auth, `Bearer ${jwt(EXP + CITIES.corfu.agency)}`);
  assert.ok(kv.has('token/corfu') && !kv.has('token/patra'));
  assert.ok(cacheStore.has('https://patra-bus.cache/live/corfu/801'));

  // same stop code in Patras is a different cache entry and a different upstream
  const p = await get('/api/patra/live/801');
  assert.equal(p.headers.get('X-Cache'), 'MISS');
  assert.ok(fetched.some((f) => f.url === `${apiBase(CITIES.patra)}/stops/live/801`));
  assert.ok(kv.has('token/patra'));
  assert.ok(cacheStore.has('https://patra-bus.cache/live/patra/801'));

  // alias hits the Patras entry; second corfu call is a cache hit (15 s floor)
  assert.equal((await get('/api/live/801')).headers.get('X-Cache'), 'HIT');
  assert.equal((await get('/api/corfu/live/801')).headers.get('X-Cache'), 'HIT');
  assert.equal(fetched.filter((f) => f.url.endsWith('/stops/live/801')).length, 2);
}));

test('worker: live 404 upstream is noService', () => withWorld(
  async ({ get }) => {
    const res = await get('/api/corfu/live/801');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.noService, true);
    assert.deepEqual(body.vehicles, []);
  },
  { upstream: () => new Response('', { status: 404 }) },
));

test('worker: stops and lines per city, with Patras aliases', () => withWorld(
  async ({ get, fetched, cacheStore }) => {
    assert.deepEqual(await (await get('/api/corfu/stops')).json(), [{ ok: 1 }]);
    await get('/api/corfu/lines');
    await get('/api/patra/lines');
    await get('/api/lines');
    await get('/api/stops');
    const urls = fetched.map((f) => f.url).filter((u) => u.includes('/api/v1/'));
    assert.deepEqual(urls, [
      `${apiBase(CITIES.corfu)}/stops`,
      `${apiBase(CITIES.corfu)}/lines`,
      `${apiBase(CITIES.patra)}/lines`, // alias /api/lines is a cache hit on patra/lines
      `${apiBase(CITIES.patra)}/stops`,
    ]);
    for (const k of ['corfu/stops', 'corfu/lines', 'patra/lines', 'patra/stops']) {
      assert.ok(cacheStore.has(`https://patra-bus.cache/${k}`), k);
    }
  },
  { upstream: () => new Response(JSON.stringify([{ ok: 1 }])) },
));

test('worker: stats route validates codes and uses a per-city cache key', () => withWorld(async ({ get, cacheStore }) => {
  assert.equal((await get('/api/corfu/stats/abc/1')).status, 400);
  assert.equal((await get('/api/stats/1/x')).status, 400);
  const res = await get('/api/corfu/stats/2015/801');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).id, 'corfu/2015/801');
  assert.ok(cacheStore.has('https://patra-bus.cache/stats/corfu/2015/801'));
  const alias = await get('/api/stats/2015/1011');
  assert.equal((await alias.json()).id, '2015/1011');
  assert.ok(cacheStore.has('https://patra-bus.cache/stats/patra/2015/1011'));
}));

test('worker: a failed stats Durable Object is a 503, never cached as a 200 (TEL-404)', () => withWorld(async ({ env, ctx, cacheStore }) => {
  let ok = false;
  const senv = { ...env, STATS: { idFromName: (n) => n, get: (id) => ({ fetch: async () => (ok ? new Response(JSON.stringify({ samples: 0, id })) : new Response('boom', { status: 500 })) }) } };
  const call = () => worker.fetch(new Request('https://w.test/api/corfu/stats/2015/801'), senv, ctx);
  const bad = await call();
  assert.equal(bad.status, 503);
  assert.deepEqual(await bad.json(), { error: 'stats_unavailable', status: 503 });
  assert.equal(bad.headers.get('Cache-Control'), 'no-store');
  assert.ok(!cacheStore.has('https://patra-bus.cache/stats/corfu/2015/801'));
  const thrown = await worker.fetch(new Request('https://w.test/api/corfu/stats/2015/801'),
    { ...senv, STATS: { idFromName: (n) => n, get: () => ({ fetch: async () => { throw new Error('DO reset'); } }) } }, ctx);
  assert.equal(thrown.status, 503);
  ok = true;
  const good = await call();
  assert.equal(good.status, 200);
  assert.equal((await good.json()).id, 'corfu/2015/801');
}));

test('worker: our own bug is a 500 internal, citybus trouble stays 502 upstream (TEL-404)', () => withWorld(async ({ env, ctx }) => {
  const benv = { ...env, KV: { get: async () => { throw new TypeError('kv broke'); }, put: async () => {} } };
  const r = await worker.fetch(new Request('https://w.test/health'), benv, ctx);
  assert.equal(r.status, 500);
  assert.deepEqual(await r.json(), { error: 'internal', status: 500 });
  assert.equal(r.headers.get('Cache-Control'), 'no-store');
}, { upstream: () => new Response('', { status: 503 }) }).then(() => withWorld(async ({ get }) => {
  const r = await get('/api/corfu/live/801');
  assert.equal(r.status, 502);
  assert.equal((await r.json()).error, 'upstream');
}, { upstream: () => new Response('', { status: 503 }) })));

test('worker: no ALLOWED_ORIGIN or Origin: null -> no Access-Control-Allow-Origin, also on OPTIONS (TEL-404)', () => withWorld(async ({ env, ctx }) => {
  const call = (e, method, origin) => worker.fetch(new Request('https://w.test/api/corfu/live/801', { method, headers: origin ? { Origin: origin } : {} }), e, ctx);
  const none = { ...env };
  delete none.ALLOWED_ORIGIN;
  const prod = { ...env, ALLOWED_ORIGIN: 'https://costgal.github.io,http://localhost:8080' };
  for (const method of ['GET', 'OPTIONS']) {
    for (const origin of ['null', 'https://costgal.github.io', 'https://evil.test', undefined]) {
      assert.equal((await call(none, method, origin)).headers.get('Access-Control-Allow-Origin'), null, `${method} ${origin} without ALLOWED_ORIGIN`);
    }
    assert.equal((await call(prod, method, 'null')).headers.get('Access-Control-Allow-Origin'), null, `${method} Origin: null`);
    assert.equal((await call(prod, method, 'https://evil.test')).headers.get('Access-Control-Allow-Origin'), null, `${method} other site`);
    assert.equal((await call(prod, method, 'https://costgal.github.io')).headers.get('Access-Control-Allow-Origin'), 'https://costgal.github.io', `${method} app`);
    assert.equal((await call(prod, method, 'https://costgal.github.io')).headers.get('Vary'), 'Origin');
  }
}));

test('worker: /health lists every city, tokenExp stays the Patras one', () => withWorld(async ({ get }) => {
  let h = await (await get('/health')).json();
  assert.equal(h.ok, true);
  assert.equal(typeof h.now, 'number');
  assert.equal(h.tokenExp, null);
  assert.deepEqual(Object.keys(h.cities).sort(), Object.keys(CITIES).sort());
  assert.deepEqual(h.cities.corfu, { tokenExp: null });

  await get('/api/corfu/live/801');
  await get('/api/patra/live/1011');
  h = await (await get('/health')).json();
  assert.equal(h.cities.corfu.tokenExp, EXP + CITIES.corfu.agency);
  assert.equal(h.cities.patra.tokenExp, EXP + CITIES.patra.agency);
  assert.equal(h.tokenExp, h.cities.patra.tokenExp);
}));

test('liveBody: takes the city id and rejects ids outside the table', () => withWorld(async ({ env, ctx, fetched }) => {
  const r = await liveBody(env, ctx, 'corfu', '801');
  assert.equal(JSON.parse(r.body).vehicles.length, 0);
  await assert.rejects(() => liveBody(env, ctx, 'nope', '801'), { status: 404 });
  await assert.rejects(() => liveBody(env, ctx, 'constructor', '801'), { status: 404 });
  assert.ok(!fetched.some((f) => f.url.includes('nope')));
}));

test('worker: push sign-ups are closed (404 with CORS); DELETE and its preflight still work for old installs', () => withWorld(async ({ env, ctx }) => {
  const deleted = [];
  const ns = () => ({ idFromName: (n) => n, get: (id) => ({ fetch: async () => { deleted.push(id); return new Response(null, { status: 204 }); } }) });
  // Even with keys set, nothing new can be stored (TEL-256 step 1).
  const penv = { ...env, VAPID_PRIVATE_KEY: 'x', VAPID_PUBLIC_KEY: 'y', REMINDERS: ns(), ROUTINES: ns() };
  const call = (method, path, body) => worker.fetch(new Request(`https://w.test${path}`, {
    method, body: body && JSON.stringify(body), headers: { Origin: 'http://localhost:8080', 'CF-Connecting-IP': '10.9.1.1' },
  }), penv, ctx);

  for (const [method, path, body] of [
    ['GET', '/api/push/key'],
    ['POST', '/api/push/reminders', remReq({ at: Date.now() + 600e3 })],
    ['POST', '/api/push/routines', rouReq()],
  ]) {
    const r = await call(method, path, body);
    assert.equal(r.status, 404, `${method} ${path}`);
    assert.deepEqual(await r.json(), { error: 'not_found' });
    assert.ok(r.headers.get('Access-Control-Allow-Origin'), `${method} ${path} has CORS`);
  }
  const id = 'a'.repeat(32);
  for (const path of [`/api/push/reminders/${id}`, `/api/push/routines/${id}`]) {
    const r = await call('DELETE', path);
    assert.equal(r.status, 204, path);
    assert.ok(r.headers.get('Access-Control-Allow-Origin'), `${path} has CORS`);
  }
  assert.deepEqual(deleted, [id, id]);
  const pre = await call('OPTIONS', `/api/push/routines/${id}`);
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get('Access-Control-Allow-Methods'), /DELETE/);
}));
