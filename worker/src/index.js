import { normalizeLive, noServiceResult } from '../../web/js/arrivals.js';

const PAGE = 'https://patra.citybus.gr/el/stops';
const API = 'https://rest.citybus.gr/api/v1/el/112';
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

async function getToken(env, { force = false } = {}) {
  if (!force) {
    const saved = await env.KV.get('token', 'json');
    if (saved && saved.token && saved.exp * 1000 >= Date.now() + TOKEN_MARGIN_MS) {
      return saved.token;
    }
  }
  const res = await fetch(PAGE, { headers: { 'User-Agent': 'Mozilla/5.0' } });
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
  await env.KV.put('token', JSON.stringify({ token, exp }), { expirationTtl: ttl });
  return token;
}

async function call(path, headers) {
  try {
    return await fetch(API + path, { headers });
  } catch {
    throw new UpstreamError('fetch failed');
  }
}

// opts.notFound: if set, an upstream 404 resolves to that value instead of throwing.
async function upstream(env, path, opts = {}) {
  let token = await getToken(env);
  let res = await call(path, { Authorization: `Bearer ${token}` });
  if (res.status === 401 || res.status === 403) {
    token = await getToken(env, { force: true });
    res = await call(path, {
      Authorization: `Bearer ${token}`,
      Referer: 'https://patra.citybus.gr/',
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

// Serves from caches.default or builds via produce() -> JSON string.
// The cached copy carries max-age; the response to the browser is no-store.
async function cached(cors, ctx, key, ttl, produce) {
  const cacheKey = new Request(`https://patra-bus.cache/${key}`);
  const hit = await caches.default.match(cacheKey);
  if (hit) {
    return new Response(await hit.text(), {
      headers: headers(cors, { 'Cache-Control': 'no-store', 'X-Cache': 'HIT' }),
    });
  }
  const body = await produce();
  ctx.waitUntil(
    caches.default.put(
      cacheKey,
      new Response(body, {
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${ttl}` },
      }),
    ),
  );
  return new Response(body, {
    headers: headers(cors, { 'Cache-Control': 'no-store', 'X-Cache': 'MISS' }),
  });
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
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Max-Age': '86400',
        },
      });
    }
    if (request.method !== 'GET') return json(cors, { error: 'not_found' }, 404);

    const { pathname } = new URL(request.url);
    try {
      const live = pathname.match(/^\/api\/live\/(\d{1,6})$/);
      if (live) {
        const code = live[1];
        return await cached(cors, ctx, `live/${code}`, 15, async () => {
          // 404 = nothing scheduled for this stop right now: a normal answer, cached like any other.
          const raw = await upstream(env, `/stops/live/${code}`, { notFound: null });
          const now = Date.now();
          return JSON.stringify(raw === null ? noServiceResult(now) : normalizeLive(raw, now));
        });
      }
      if (pathname === '/api/stops' || pathname === '/api/lines') {
        const name = pathname.slice('/api/'.length);
        return await cached(cors, ctx, name, 86400, async () =>
          JSON.stringify(await upstream(env, `/${name}`)),
        );
      }
      if (pathname === '/health') {
        const saved = await env.KV.get('token', 'json');
        return json(cors, { ok: true, tokenExp: saved?.exp ?? null, now: Date.now() });
      }
      return json(cors, { error: 'not_found' }, 404);
    } catch (err) {
      const status = err.status || 502;
      console.error(`${pathname}: ${err.message}`);
      return json(cors, { error: 'upstream', status }, status, { 'Cache-Control': 'no-store' });
    }
  },
};
