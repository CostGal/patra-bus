import { normalizeLive, noServiceResult } from '../../web/js/arrivals.js';
import { ReminderBase, validateReminder, MAX_BODY_BYTES } from './reminders.js';
import { RoutineBase, validateRoutine } from './routines.js';
import { StatsBase, recordStats, readStats, validCode } from './stats.js';
import { parseRoute } from './routes.js';
import { MAX_REPORT_BYTES, ForwardError, forwardReport, takeDailySlot } from './report.js';
import { validateReport, isHoneypot } from '../../web/js/report.js';
import { CITIES, DEFAULT_CITY, apiBase, isCity } from '../../web/js/cities.js';

const TOKEN_MARGIN_MS = 5 * 60 * 1000;

class UpstreamError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

// JWT payload is base64url JSON; we only need exp (seconds).
function jwtExp(token) {
  const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const exp = JSON.parse(atob(padded)).exp;
  if (!Number.isFinite(exp)) throw new Error('no exp');
  return exp;
}

// The city table is a whitelist: an id (or object) that is not in it never reaches fetch().
function cityOf(city) {
  const id = typeof city === 'string' ? city : city?.id;
  if (!isCity(id)) throw new UpstreamError('unknown city', 404);
  return CITIES[id];
}

// One token per city (KV `token/{city}`), scraped from that city's own page.
async function getToken(env, city, { force = false } = {}) {
  if (!force) {
    const saved = await env.KV.get(`token/${city.id}`, 'json');
    if (saved && saved.token && saved.exp * 1000 >= Date.now() + TOKEN_MARGIN_MS) {
      return saved.token;
    }
  }
  const res = await fetch(city.page, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const html = await res.text();
  const m = html.match(/const token = '([^']+)'/);
  if (!res.ok || !m) throw new UpstreamError('token not found');
  const token = m[1];
  let exp;
  try {
    exp = jwtExp(token);
  } catch {
    throw new UpstreamError('token undecodable');
  }
  const ttl = Math.max(60, exp - Math.floor(Date.now() / 1000));
  await env.KV.put(`token/${city.id}`, JSON.stringify({ token, exp }), { expirationTtl: ttl });
  return token;
}

async function call(city, path, headers) {
  try {
    return await fetch(apiBase(city) + path, { headers });
  } catch {
    throw new UpstreamError('fetch failed');
  }
}

// opts.notFound: if set, an upstream 404 resolves to that value instead of throwing.
async function upstream(env, city, path, opts = {}) {
  let token = await getToken(env, city);
  let res = await call(city, path, { Authorization: `Bearer ${token}` });
  if (res.status === 401 || res.status === 403) {
    token = await getToken(env, city, { force: true });
    res = await call(city, path, {
      Authorization: `Bearer ${token}`,
      Referer: new URL('/', city.page).href,
    });
  }
  if (res.status === 404 && 'notFound' in opts) return opts.notFound;
  const text = await res.text();
  // Upstream has been seen answering 200 with an empty body.
  if (!res.ok || !text.trim()) throw new UpstreamError(`upstream ${res.status}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new UpstreamError('upstream bad json');
  }
}

// ALLOWED_ORIGIN: "*" or a comma-separated list; a listed Origin is echoed back.
function corsOrigin(env, request) {
  const allowed = (env.ALLOWED_ORIGIN || '*').split(',').map((o) => o.trim());
  if (allowed.includes('*')) return '*';
  const origin = request.headers.get('Origin');
  return origin && allowed.includes(origin) ? origin : allowed[0];
}

function headers(cors, extra = {}) {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': cors,
    Vary: 'Origin',
    'Access-Control-Expose-Headers': 'X-Cache',
    ...extra,
  };
}

function json(cors, data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: headers(cors, extra) });
}

// Serves from caches.default or builds via produce() -> JSON string. Returns { body, hit }.
// The cached copy carries max-age. If the Cache API is unusable (seen as a risk inside Durable
// Objects) a short KV memo with the same TTL keeps the per-stop floor.
async function cachedBody(env, ctx, key, ttl, produce) {
  const cacheKey = new Request(`https://patra-bus.cache/${key}`);
  let viaKv = false;
  try {
    const hit = await caches.default.match(cacheKey);
    if (hit) return { body: await hit.text(), hit: true };
  } catch {
    viaKv = true;
    const memo = await env.KV.get(`memo/${key}`, 'json');
    if (memo && Date.now() - memo.t < ttl * 1000) return { body: memo.body, hit: true };
  }
  const body = await produce();
  ctx.waitUntil(
    viaKv
      ? env.KV.put(`memo/${key}`, JSON.stringify({ t: Date.now(), body }), { expirationTtl: 60 })
      : caches.default.put(
          cacheKey,
          new Response(body, {
            headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${ttl}` },
          }),
        ),
  );
  return { body, hit: false };
}

// The response to the browser is no-store.
async function cached(cors, ctx, key, ttl, produce, env) {
  const { body, hit } = await cachedBody(env, ctx, key, ttl, produce);
  return new Response(body, {
    headers: headers(cors, { 'Cache-Control': 'no-store', 'X-Cache': hit ? 'HIT' : 'MISS' }),
  });
}

// The one live path: used by /api/{city}/live/:code and by reminder/routine alarms, so the 15 s per-stop cache is
// shared. Stop codes collide across cities, hence the city in the key.
export async function liveBody(env, ctx, city, code) {
  const c = cityOf(city);
  return cachedBody(env, ctx, `live/${c.id}/${code}`, 15, async () => {
    // 404 = nothing scheduled for this stop right now: a normal answer, cached like any other.
    const raw = await upstream(env, c, `/stops/live/${code}`, { notFound: null });
    const now = Date.now();
    const result = raw === null ? noServiceResult(now) : normalizeLive(raw, now);
    // Stats feed on real upstream answers only (this runs on cache MISS), off the response path.
    if (raw !== null) ctx.waitUntil(recordStats(env, c.id, code, result));
    return JSON.stringify(result);
  });
}

// Live read for Durable Objects: same shared cache path as the HTTP route.
async function liveFor(env, city, code) {
  const pending = [];
  const { body } = await liveBody(env, { waitUntil: (p) => pending.push(p) }, city, code);
  await Promise.allSettled(pending);
  return JSON.parse(body);
}

export class Reminder extends ReminderBase {
  getLive(city, code) {
    return liveFor(this.env, city, code);
  }
}

export class Routine extends RoutineBase {
  getLive(city, code) {
    return liveFor(this.env, city, code);
  }
}

export class Stats extends StatsBase {}

const PUSH_ID = /^[0-9a-f]{32}$/;

// Best-effort abuse brake: per isolate, so not global, but it stops a single client hammering one edge.
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 12;
const REPORT_RATE_MAX = 3; // problem reports are rare and each one lands in a human's inbox
const recent = new Map(); // bucket:ip -> timestamps (memory only, never forwarded anywhere)
function rateLimited(ip, now, max = RATE_MAX) {
  const list = (recent.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (list.length >= max) { recent.set(ip, list); return true; }
  list.push(now);
  recent.set(ip, list);
  if (recent.size > 5000) recent.delete(recent.keys().next().value);
  return false;
}
const reminderStub = (env, id) => env.REMINDERS.get(env.REMINDERS.idFromName(id));
const routineStub = (env, id) => env.ROUTINES.get(env.ROUTINES.idFromName(id));
const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

// Shared POST preamble: push configured, per-IP rate limit, size cap, JSON. -> { raw } | { res }.
async function readPushBody(request, env, cors, bucket) {
  if (!env.VAPID_PRIVATE_KEY || !env.VAPID_PUBLIC_KEY) return { res: json(cors, { error: 'push_unavailable' }, 503) };
  if (rateLimited(`${bucket}:${request.headers.get('CF-Connecting-IP') || 'local'}`, Date.now())) {
    return { res: json(cors, { error: 'rate_limited' }, 429, { 'Retry-After': '600' }) };
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return { res: json(cors, { error: 'too_large' }, 413) };
  try {
    return { raw: JSON.parse(text) };
  } catch {
    return { res: json(cors, { error: 'bad_request', field: 'json' }, 400) };
  }
}

async function pushRoute(request, env, cors, pathname) {
  if (pathname === '/api/push/key' && request.method === 'GET') {
    if (!env.VAPID_PUBLIC_KEY) return json(cors, { error: 'push_unavailable' }, 503);
    return json(cors, { publicKey: env.VAPID_PUBLIC_KEY });
  }
  if (pathname === '/api/push/reminders' && request.method === 'POST') {
    const { raw, res: early } = await readPushBody(request, env, cors, 'reminder');
    if (early) return early;
    const v = validateReminder(raw, Date.now(), { allowLocal: env.DEV_ALLOW_LOCAL_PUSH === '1' });
    if (!v.ok) return json(cors, { error: 'bad_request', field: v.error }, 400);
    const id = newId();
    const res = await reminderStub(env, id).fetch('https://reminder/', { method: 'POST', body: JSON.stringify(v.value) });
    if (!res.ok) return json(cors, { error: 'internal' }, 500);
    return json(cors, { id }, 201, { 'Cache-Control': 'no-store' });
  }
  const del = pathname.match(/^\/api\/push\/reminders\/([^/]+)$/);
  if (del && request.method === 'DELETE') {
    if (!PUSH_ID.test(del[1])) return json(cors, { error: 'not_found' }, 404);
    await reminderStub(env, del[1]).fetch('https://reminder/', { method: 'DELETE' });
    return new Response(null, { status: 204, headers: headers(cors) });
  }
  if (pathname === '/api/push/routines' && request.method === 'POST') {
    const { raw, res: early } = await readPushBody(request, env, cors, 'routine');
    if (early) return early;
    const v = validateRoutine(raw, { allowLocal: env.DEV_ALLOW_LOCAL_PUSH === '1' });
    if (!v.ok) return json(cors, { error: 'bad_request', field: v.error }, 400);
    const id = newId();
    const res = await routineStub(env, id).fetch('https://routine/', { method: 'POST', body: JSON.stringify({ id, ...v.value }) });
    if (!res.ok) return json(cors, { error: 'internal' }, 500);
    return json(cors, { id }, 201, { 'Cache-Control': 'no-store' });
  }
  const delR = pathname.match(/^\/api\/push\/routines\/([^/]+)$/);
  if (delR && request.method === 'DELETE') {
    if (!PUSH_ID.test(delR[1])) return json(cors, { error: 'not_found' }, 404);
    await routineStub(env, delR[1]).fetch('https://routine/', { method: 'DELETE' });
    return new Response(null, { status: 204, headers: headers(cors) });
  }
  return null;
}

// A browser on another site can fire a POST at us (CORS only stops it reading the answer): refuse its Origin outright.
// Requests without an Origin (curl, the app's own native webview) pass; the rate limit and daily cap cover those.
function originAllowed(env, request) {
  const origin = request.headers.get('Origin');
  const allowed = (env.ALLOWED_ORIGIN || '*').split(',').map((o) => o.trim());
  return !origin || allowed.includes('*') || allowed.includes(origin);
}

// POST /api/report: problem report -> Notion. Order matters: cheap refusals first, the honeypot answers like a success.
async function reportRoute(request, env, cors) {
  if (request.method !== 'POST') return json(cors, { error: 'not_found' }, 404);
  if (!originAllowed(env, request)) return json(cors, { error: 'forbidden' }, 403);
  // Only application/json: a cross-site form or text/plain POST cannot carry it without a CORS preflight, which we refuse.
  if (!/^application\/json\b/i.test(request.headers.get('Content-Type') || '')) return json(cors, { error: 'bad_request', field: 'content-type' }, 415);
  if (!env.NOTION_TOKEN || !env.NOTION_DB_ID) return json(cors, { error: 'report_unavailable' }, 503);
  if (Number(request.headers.get('Content-Length')) > MAX_REPORT_BYTES) return json(cors, { error: 'too_large' }, 413);
  const now = Date.now();
  if (rateLimited(`report:${request.headers.get('CF-Connecting-IP') || 'local'}`, now, REPORT_RATE_MAX)) {
    return json(cors, { error: 'rate_limited' }, 429, { 'Retry-After': '600' });
  }
  const body = await request.text();
  if (new TextEncoder().encode(body).length > MAX_REPORT_BYTES) return json(cors, { error: 'too_large' }, 413);
  let raw;
  try {
    raw = JSON.parse(body);
  } catch {
    return json(cors, { error: 'bad_request', field: 'json' }, 400);
  }
  if (isHoneypot(raw)) return json(cors, { ok: true }, 200, { 'Cache-Control': 'no-store' }); // looks sent, goes nowhere
  const v = validateReport(raw);
  if (!v.ok) return json(cors, { error: 'bad_request', field: v.error }, 400);
  if (!(await takeDailySlot(env, now))) return json(cors, { error: 'rate_limited' }, 429, { 'Retry-After': '3600' });
  try {
    await forwardReport(env, v.value, now);
  } catch (err) {
    console.error(`/api/report: ${err instanceof ForwardError ? err.message : 'forward failed'}`); // status only, never the content
    return json(cors, { error: 'forward_failed' }, 502, { 'Cache-Control': 'no-store' });
  }
  return json(cors, { ok: true }, 200, { 'Cache-Control': 'no-store' });
}

export default {
  async fetch(request, env, ctx) {
    const cors = corsOrigin(env, request);
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': cors,
          Vary: 'Origin',
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    const { pathname } = new URL(request.url);
    try {
      if (pathname === '/api/report') return await reportRoute(request, env, cors);
      if (pathname.startsWith('/api/push/')) {
        const res = await pushRoute(request, env, cors, pathname);
        return res || json(cors, { error: 'not_found' }, 404);
      }
      if (request.method !== 'GET') return json(cors, { error: 'not_found' }, 404);

      if (pathname === '/health') {
        const cities = {};
        for (const id of Object.keys(CITIES)) cities[id] = { tokenExp: (await env.KV.get(`token/${id}`, 'json'))?.exp ?? null };
        return json(cors, { ok: true, tokenExp: cities[DEFAULT_CITY]?.tokenExp ?? null, cities, now: Date.now() });
      }
      const route = parseRoute(pathname);
      if (!route) return json(cors, { error: 'not_found' }, 404);
      const c = CITIES[route.city];

      if (route.kind === 'live') {
        const { body, hit } = await liveBody(env, ctx, c.id, route.args[0]);
        return new Response(body, {
          headers: headers(cors, { 'Cache-Control': 'no-store', 'X-Cache': hit ? 'HIT' : 'MISS' }),
        });
      }
      if (route.kind === 'stats') {
        const [routeCode, stopCode] = route.args;
        if (!validCode(routeCode) || !validCode(stopCode)) return json(cors, { error: 'bad_request' }, 400);
        const { body, hit } = await cachedBody(env, ctx, `stats/${c.id}/${routeCode}/${stopCode}`, 600, () => readStats(env, c.id, routeCode, stopCode));
        return new Response(body, { headers: headers(cors, { 'Cache-Control': 'public, max-age=600', 'X-Cache': hit ? 'HIT' : 'MISS' }) });
      }
      // stops | lines
      return await cached(cors, ctx, `${c.id}/${route.kind}`, 86400, async () => JSON.stringify(await upstream(env, c, `/${route.kind}`)), env);
    } catch (err) {
      const status = err.status || 502;
      console.error(`${pathname}: ${err.message}`);
      return json(cors, { error: 'upstream', status }, status, { 'Cache-Control': 'no-store' });
    }
  },
};
