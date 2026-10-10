// Walking time + route (owner: location). OSRM foot server first, straight-line estimate as fallback.
// Only the two coordinates of the walk leave the device, and only to the routing server (see ARCHITECTURE.md).
import { haversine } from './geo.js';
import { getSettings } from './store.js';

export const OSRM_FOOT = 'https://routing.openstreetmap.de/routed-foot/route/v1/driving';
export const WALK_SPEEDS = { slow: 1.0, normal: 1.3, fast: 1.6 }; // m/s
export const DETOUR = 1.3; // straight line → street distance
const MIN_ROUTE_M = 30; // closer than this the estimate is as good as a route
const MAX_ROUTE_M = 5000; // farther is not a walk worth routing

// m/s from the walkSpeed setting; never throws.
export function walkSpeed() {
  try { return WALK_SPEEDS[getSettings().walkSpeed] || WALK_SPEEDS.normal; } catch { return WALK_SPEEDS.normal; }
}

export function walkEstimate(from, to, speed = walkSpeed()) {
  const meters = haversine(from, to) * DETOUR;
  return { seconds: meters / speed, meters, geometry: null, source: 'estimate' };
}

const abortError = () => new DOMException('Aborted', 'AbortError');
const r4 = (n) => Math.round(n * 1e4) / 1e4; // ~11 m of latitude, ~9 m of longitude here
const keyOf = (a, b) => `${r4(a.lat)},${r4(a.lng)}>${r4(b.lat)},${r4(b.lng)}`;
const pt = (c) => ({ lat: c[1], lng: c[0] });

// Factory so tests can inject fetch / clock / sleep; the module exports a ready-made instance below.
export function createWalker(o = {}) {
  const doFetch = o.fetch || ((...a) => globalThis.fetch(...a));
  const now = o.now || (() => Date.now());
  const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const speedOf = o.speed || walkSpeed;
  const timeoutMs = o.timeoutMs ?? 6000;
  const gapMs = o.minGapMs ?? 1000; // client-side rate limit: one request per second
  const cacheMax = o.cacheSize ?? 200;
  const base = o.baseUrl || OSRM_FOOT;

  const cache = new Map(); // key -> { meters, geometry }, Map order = LRU order
  const inflight = new Map(); // key -> { promise, waiters, ctl }
  let chain = Promise.resolve();
  let lastStart = -Infinity;
  let fails = 0, downUntil = 0;
  const stats = { requests: 0 };

  const touch = (key, v) => { cache.delete(key); cache.set(key, v); if (cache.size > cacheMax) cache.delete(cache.keys().next().value); };

  // Result for these exact endpoints from a (possibly ~10 m off) cached route; seconds follow today's walk speed.
  function shape(route, from, to) {
    const g = route.geometry;
    const snap = g && g.length ? haversine(from, pt(g[0])) + haversine(to, pt(g[g.length - 1])) : 0; // off-road bits at both ends
    const meters = route.meters + snap;
    return { seconds: meters / speedOf(), meters, geometry: g, source: 'osrm' };
  }

  async function fetchRoute(from, to, key, ctl) {
    // Serialised start times; a request cancelled while still queued costs no budget.
    const turn = chain.then(async () => {
      if (ctl.signal.aborted) return null;
      const wait = lastStart + gapMs - now();
      if (wait > 0) await sleep(wait);
      if (ctl.signal.aborted || now() < downUntil) return null;
      lastStart = now();
      return true;
    });
    chain = turn.catch(() => {});
    if (!(await turn.catch(() => null))) return null;

    stats.requests++;
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const url = `${base}/${from.lng.toFixed(5)},${from.lat.toFixed(5)};${to.lng.toFixed(5)},${to.lat.toFixed(5)}?overview=full&geometries=geojson`;
    try {
      const res = await doFetch(url, { signal: ctl.signal, referrerPolicy: 'no-referrer', credentials: 'omit' });
      if (res.status === 429) { downUntil = now() + 60000; return null; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      const r = j && j.code === 'Ok' && j.routes && j.routes[0];
      const coords = r && r.geometry && r.geometry.coordinates;
      if (!r || !Number.isFinite(r.distance) || !Array.isArray(coords) || coords.length < 2) throw new Error('bad route');
      fails = 0;
      const route = { meters: r.distance, geometry: coords };
      touch(key, route);
      return route;
    } catch {
      // A cancelled request is the caller's choice; a timeout, network error or bad body counts against the server.
      if (!ctl.cancelled && ++fails >= 3) { downUntil = now() + 60000; fails = 0; } // struggling: estimates for a minute
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function walkRoute(from, to, { signal } = {}) {
    if (signal?.aborted) throw abortError();
    const straight = haversine(from, to);
    if (straight < MIN_ROUTE_M || straight > MAX_ROUTE_M || now() < downUntil) return walkEstimate(from, to, speedOf());
    const key = keyOf(from, to);
    const hit = cache.get(key);
    if (hit) { touch(key, hit); return shape(hit, from, to); }

    let entry = inflight.get(key);
    if (!entry || entry.ctl.cancelled) {
      const e = entry = { waiters: 0, ctl: new AbortController(), promise: null };
      e.promise = fetchRoute(from, to, key, e.ctl).finally(() => { if (inflight.get(key) === e) inflight.delete(key); });
      inflight.set(key, e);
    }
    entry.waiters++;
    let onAbort;
    const aborted = new Promise((_, reject) => {
      if (!signal) return;
      onAbort = () => { if (--entry.waiters <= 0) { entry.ctl.cancelled = true; entry.ctl.abort(); } reject(abortError()); };
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      const route = await Promise.race([entry.promise, aborted]);
      return route ? shape(route, from, to) : walkEstimate(from, to, speedOf());
    } finally {
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  return { walkRoute, walkEstimate: (a, b) => walkEstimate(a, b, speedOf()), clear: () => { cache.clear(); fails = 0; downUntil = 0; }, stats,
    _state: () => ({ cache, inflight, downUntil }) };
}

const walker = createWalker();
// walkRoute(from, to, { signal }) → { seconds, meters, geometry: [lng,lat][] | null, source: 'osrm'|'estimate' }
// Rejects with AbortError only when `signal` aborts; every other failure resolves with the estimate.
export const walkRoute = walker.walkRoute;
export const clearWalkCache = walker.clear;
