// Contract test (TEL-213): the fields the app reads from each worker answer.
// Rules in docs/WORKER.md section 12. Adding a field passes; removing, renaming or retyping one fails.
// If this test fails, the change breaks apps already installed on phones: add the new field next to
// the old one instead, and remove the old one only in a later release (and raise minApp if needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../worker/src/index.js';
import { summarize } from '../worker/src/stats.js';
import { MIN_APP_VERSION } from '../worker/src/version.js';
import { CITIES } from '../web/js/cities.js';

// --- the contract ---
// Type names: 'string' | 'number' | 'boolean' | 'array' | 'object', with '?' for "may be null".
const CONTRACT = {
  version: { api: 'number', minApp: 'string' },
  health: { ok: 'boolean', now: 'number', tokenExp: 'number?', cities: 'object' },
  healthCity: { tokenExp: 'number?' },
  live: { fetchedAt: 'number', vehicles: 'array' },
  liveNoService: { fetchedAt: 'number', vehicles: 'array', noService: 'boolean' },
  vehicle: {
    lineCode: 'string', lineName: 'string', routeCode: 'string', routeName: 'string',
    color: 'string?', textColor: 'string?', live: 'boolean', departureMins: 'number', etaSec: 'number',
    vehicleCode: 'string?',
  },
  liveVehicle: { lat: 'number', lng: 'number' },
  stats: { samples: 'number', medianDelaySec: 'number?', p80DelaySec: 'number?' },
  error: { error: 'string' },
};

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

function assertShape(body, shape, where) {
  assert.equal(typeOf(body), 'object', `${where}: body is an object`);
  for (const [key, want] of Object.entries(shape)) {
    assert.ok(Object.hasOwn(body, key), `${where}: field "${key}" is missing (removed or renamed?)`);
    const nullable = want.endsWith('?');
    const type = want.replace('?', '');
    const got = typeOf(body[key]);
    assert.ok(got === type || (nullable && got === 'null'), `${where}: "${key}" is ${got}, the contract says ${want}`);
  }
}

// --- a fake world: KV, Cache API and upstream (same idea as worker-routes.test.mjs) ---
const b64u = (o) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const EXP = Math.floor(Date.now() / 1000) + 48 * 3600;
const LIVE_1011 = readFileSync(new URL('../web/fixtures/live-1011.json', import.meta.url), 'utf8');
const STATS_STATE = { samples: [60, 120, 180, 240, 300].map((d, i) => ({ d, t: i })), updatedAt: 1 };

async function withWorld(fn) {
  const kv = new Map();
  const store = new Map();
  const realFetch = globalThis.fetch;
  const realCaches = globalThis.caches;
  globalThis.caches = {
    default: {
      match: async (req) => store.get(req.url)?.clone(),
      put: async (req, res) => { store.set(req.url, res); },
    },
  };
  globalThis.fetch = async (url) => {
    url = String(url);
    if (Object.values(CITIES).some((c) => c.page === url)) return new Response(`<script>const token = 'h.${b64u({ exp: EXP })}.s';</script>`);
    if (url.endsWith('/stops/live/1011')) return new Response(LIVE_1011);
    if (url.endsWith('/stops/live/999')) return new Response('', { status: 404 });
    return new Response('[]');
  };
  const env = {
    KV: {
      get: async (k, type) => (kv.has(k) ? (type === 'json' ? JSON.parse(kv.get(k)) : kv.get(k)) : null),
      put: async (k, v) => { kv.set(k, v); },
    },
    STATS: {
      idFromName: (n) => n,
      get: () => ({ fetch: async (_u, init = {}) => new Response(JSON.stringify(init.method === 'POST' ? {} : summarize(STATS_STATE))) }),
    },
    ALLOWED_ORIGIN: '*',
  };
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };
  const get = async (path) => {
    const res = await worker.fetch(new Request(`https://w.test${path}`), env, ctx);
    await Promise.allSettled(pending);
    return { status: res.status, body: await res.json() };
  };
  try {
    return await fn(get);
  } finally {
    globalThis.fetch = realFetch;
    globalThis.caches = realCaches;
  }
}

// --- the routes ---
test('contract: GET /version', () => withWorld(async (get) => {
  const { status, body } = await get('/version');
  assert.equal(status, 200);
  assertShape(body, CONTRACT.version, '/version');
}));

test('contract: GET /health', () => withWorld(async (get) => {
  await get('/api/patra/live/1011'); // stores a token, so tokenExp is a number
  const { status, body } = await get('/health');
  assert.equal(status, 200);
  assertShape(body, CONTRACT.health, '/health');
  for (const id of Object.keys(CITIES)) assertShape(body.cities[id], CONTRACT.healthCity, `/health cities.${id}`);
}));

test('contract: GET /api/{city}/live/:code, with live and scheduled vehicles', () => withWorld(async (get) => {
  for (const path of ['/api/patra/live/1011', '/api/live/1011']) {
    const { status, body } = await get(path);
    assert.equal(status, 200, path);
    assertShape(body, CONTRACT.live, path);
    assert.ok(body.vehicles.some((v) => v.live) && body.vehicles.some((v) => !v.live), `${path}: fixture has both kinds`);
    for (const v of body.vehicles) {
      assertShape(v, CONTRACT.vehicle, `${path} vehicle`);
      if (v.live) assertShape(v, CONTRACT.liveVehicle, `${path} live vehicle`);
    }
  }
}));

test('contract: live with no service (upstream 404)', () => withWorld(async (get) => {
  const { status, body } = await get('/api/patra/live/999');
  assert.equal(status, 200);
  assertShape(body, CONTRACT.liveNoService, 'no service');
  assert.equal(body.noService, true);
}));

test('contract: GET /api/{city}/stats/:route/:stop', () => withWorld(async (get) => {
  const { status, body } = await get('/api/patra/stats/2015/1011');
  assert.equal(status, 200);
  assertShape(body, CONTRACT.stats, 'stats');
}));

test('contract: errors carry "error"', () => withWorld(async (get) => {
  const notFound = await get('/nothing');
  assert.equal(notFound.status, 404);
  assertShape(notFound.body, CONTRACT.error, '404');
  const bad = await get('/api/patra/stats/abc/1011');
  assert.equal(bad.status, 400);
  assertShape(bad.body, CONTRACT.error, '400');
}));

// --- minApp never locks out the app we ship now ---
// Semver order with prereleases: 0.9.0-beta.1 < 0.9.0-beta.2 < 0.9.0 < 0.10.0.
export function compareVersions(a, b) {
  const [ma, pa = ''] = a.split('-');
  const [mb, pb = ''] = b.split('-');
  const na = ma.split('.').map(Number), nb = mb.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (na[i] !== nb[i]) return na[i] < nb[i] ? -1 : 1;
  if (pa === pb) return 0;
  if (!pa) return 1;
  if (!pb) return -1;
  const xa = pa.split('.'), xb = pb.split('.');
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    if (xa[i] === undefined) return -1;
    if (xb[i] === undefined) return 1;
    const da = /^\d+$/.test(xa[i]), db = /^\d+$/.test(xb[i]);
    if (da && db && Number(xa[i]) !== Number(xb[i])) return Number(xa[i]) < Number(xb[i]) ? -1 : 1;
    if (da !== db) return da ? -1 : 1;
    if (!da && xa[i] !== xb[i]) return xa[i] < xb[i] ? -1 : 1;
  }
  return 0;
}

test('compareVersions: semver order', () => {
  const order = ['0.8.9', '0.9.0-beta.1', '0.9.0-beta.2', '0.9.0-beta.10', '0.9.0', '0.9.1', '0.10.0', '1.0.0'];
  for (let i = 0; i < order.length - 1; i++) {
    assert.equal(compareVersions(order[i], order[i + 1]), -1, `${order[i]} < ${order[i + 1]}`);
    assert.equal(compareVersions(order[i + 1], order[i]), 1, `${order[i + 1]} > ${order[i]}`);
  }
  assert.equal(compareVersions('0.9.0-beta.1', '0.9.0-beta.1'), 0);
});

test('minApp is not newer than the app in web/ (the current app is never refused)', () => {
  // Read as text: i18n.js is a browser module.
  const app = readFileSync(new URL('../web/js/i18n.js', import.meta.url), 'utf8').match(/APP_VERSION = '([^']+)'/)?.[1];
  assert.ok(app, 'APP_VERSION found in web/js/i18n.js');
  assert.ok(compareVersions(MIN_APP_VERSION, app) <= 0, `minApp ${MIN_APP_VERSION} > app ${app}`);
});
