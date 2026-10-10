// Live-data client. Contract in docs/ARCHITECTURE.md.
// Hard rule: live upstream is never hit more than once per 15 s per stop, retries included.
// Enforced here, globally, so no view or poller can beat it: a per-code memo of the last *attempt*
// (success or failure) plus in-flight dedupe.
import { isLive, noServiceResult, normalizeLive } from './arrivals.js';
import { demoLive, demoReady } from './demo.js';
import { t } from './i18n.js';
import { cityId } from './cities.js';

export const MIN_GAP_MS = 15000; // floor between upstream attempts for one stop
export const POLL_MS = 20000; // poller period
export const STALE_MS = 60000; // data older than this is "stale"
export const TIMEOUT_MS = 10000;

const here = typeof location !== 'undefined' ? location : null;
const params = new URLSearchParams(here ? here.search : '');
export const DEMO = params.has('demo');
const DEMO_MODE = params.get('demo') || ''; // ?demo=nosvc | ?demo=error exercise those states
export const API_BASE = here && ['localhost', '127.0.0.1'].includes(here.hostname)
  ? 'http://localhost:8787'
  : 'https://patra-bus.patra-bus.workers.dev';

// The worker routes are always city-prefixed (Patras too): /api/{city}/live/:code, /api/{city}/stats/:route/:stop.
export const liveUrl = (code, city = cityId()) => `${API_BASE}/api/${city}/live/${encodeURIComponent(code)}`;
export const statsUrl = (route, stop, city = cityId()) => `${API_BASE}/api/${city}/stats/${encodeURIComponent(route)}/${encodeURIComponent(stop)}`;
const memoKey = (code) => `${cityId()}/${code}`;

// kind: 'network' | 'timeout' | 'upstream' | 'bad'
export class ApiError extends Error {
  constructor(kind, msg, status) {
    super(msg || kind);
    this.name = 'ApiError';
    this.kind = kind;
    if (status != null) this.status = status;
  }
}

// ---- transport (overridable for tests via _setTransport) ----
const defaults = () => ({
  fetch: (...a) => globalThis.fetch(...a),
  now: () => Date.now(),
  setTimeout: (...a) => globalThis.setTimeout(...a),
  clearTimeout: (...a) => globalThis.clearTimeout(...a),
  doc: typeof document !== 'undefined' ? document : null,
  timeoutMs: TIMEOUT_MS,
  demo: DEMO,
  demoMode: DEMO_MODE,
  demoDelayMs: 250,
});
let env = defaults();
const memo = new Map(); // 'city/code' -> { at, pending, promise } (stop codes collide across cities)
const statsMemo = new Map(); // 'city/route/stop' -> { at, p }

// Tests only. _setTransport({ fetch, now, setTimeout, clearTimeout, doc, timeoutMs, demo, demoMode, demoDelayMs });
// no argument resets to the real thing. Always clears the memo.
export function _setTransport(over) {
  env = { ...defaults(), ...(over || {}) };
  memo.clear();
  statsMemo.clear();
}

const abortError = () => new DOMException('Aborted', 'AbortError');
const wait = (ms) => (ms > 0 ? new Promise((r) => globalThis.setTimeout(r, ms)) : Promise.resolve());

function cleanVehicle(v) {
  const mins = Number(v.departureMins) || 0;
  const eta = Number(v.etaSec);
  const out = {
    lineCode: String(v.lineCode ?? ''),
    lineName: v.lineName ?? '',
    routeCode: String(v.routeCode ?? ''),
    routeName: v.routeName ?? '',
    color: v.color || null,
    textColor: v.textColor || null,
    live: false,
    departureMins: mins,
    etaSec: Number.isFinite(eta) ? eta : mins * 60,
    vehicleCode: v.vehicleCode ? String(v.vehicleCode) : null, // older workers don't send it
  };
  // Re-check on the client: coordinates survive only for a live vehicle with real (non-0/0) ones.
  if (v.live && isLive({ latitude: v.lat, longitude: v.lng })) {
    out.live = true;
    out.lat = Number(v.lat);
    out.lng = Number(v.lng);
  }
  return out;
}

function parseResult(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.vehicles) || !Number.isFinite(Number(body.fetchedAt))) {
    throw new ApiError('bad', 'unexpected response shape');
  }
  // fetchedAt is the server's clock. A hit on the worker cache is at most ~15 s old; far off means a
  // skewed device clock, so trust "just now" rather than shifting every countdown by minutes.
  const now = env.now();
  const age = now - Number(body.fetchedAt);
  const fetchedAt = age < -10000 || age > 45000 ? now : Number(body.fetchedAt);
  const vehicles = body.vehicles.map(cleanVehicle).sort((a, b) => a.etaSec - b.etaSec);
  const out = { fetchedAt, vehicles };
  if (body.noService) out.noService = true;
  return out;
}

async function request(code, signal) {
  let res;
  try {
    res = await env.fetch(liveUrl(code), { signal, cache: 'no-store' });
  } catch (e) {
    throw new ApiError('network', e && e.message);
  }
  if (!res.ok) throw new ApiError('upstream', `HTTP ${res.status}`, res.status);
  let body;
  try {
    body = await res.json();
  } catch {
    throw new ApiError('bad', 'invalid JSON');
  }
  return parseResult(body);
}

async function demoAttempt(code) {
  await wait(env.demoDelayMs * (env.demoMode ? 2 : 1));
  if (env.demoMode === 'error') throw new ApiError('upstream', 'demo error', 502);
  if (env.demoMode === 'nosvc') return noServiceResult(env.now());
  if (await demoReady()) return parseResult(demoLive(code, env.now()));
  // No static data (shouldn't happen): fall back to the one real captured response.
  const raw = await (await env.fetch('./fixtures/live-1011.json')).json();
  return parseResult(normalizeLive(raw, env.now()));
}

function attempt(code) {
  if (env.demo) return demoAttempt(code);
  const ctl = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = env.setTimeout(() => { reject(new ApiError('timeout')); ctl.abort(); }, env.timeoutMs);
  });
  return Promise.race([request(code, ctl.signal), timeout]).finally(() => env.clearTimeout(timer));
}

// Each caller gets its own copy, so one consumer mutating/sorting can't corrupt another.
const clone = (r) => ({ ...r, vehicles: r.vehicles.map((v) => ({ ...v })) });

function withSignal(p, signal) {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

// Epoch ms of the last upstream attempt for this stop (any caller), 0 if none.
export const lastAttemptAt = (code) => memo.get(memoKey(String(code)))?.at ?? 0;

// A call within MIN_GAP_MS of the previous attempt for the same stop returns that attempt's result
// (or error), and concurrent calls share one request. `signal` only detaches this caller.
export function fetchLive(code, { signal } = {}) {
  code = String(code);
  if (!env.demo && !/^\d{1,6}$/.test(code)) return Promise.reject(new ApiError('bad', 'invalid stop code'));
  const now = env.now();
  const key = memoKey(code);
  let e = memo.get(key);
  if (!e || (!e.pending && now - e.at >= MIN_GAP_MS)) {
    e = { at: now, pending: true, promise: null };
    const mine = e;
    e.promise = attempt(code).finally(() => { mine.pending = false; });
    memo.set(key, e);
    if (memo.size > 200) for (const [k, v] of memo) if (!v.pending && now - v.at > 4 * MIN_GAP_MS) memo.delete(k);
  }
  return withSignal(e.promise.then(clone), signal);
}

// Seconds left, same for live and scheduled: the ETA is relative to fetchedAt.
export const remainingSec = (v, fetchedAt, now = Date.now()) => Math.max(0, v.etaSec - (now - fetchedAt) / 1000);

// Polls every POLL_MS while the page is visible. onUpdate({ data, error, loading, nextAt }):
// data = last good result (kept across errors), error = last attempt's error or null,
// nextAt = epoch ms of the next scheduled attempt (0 if none: loading, or paused while hidden).
// The first update arrives asynchronously, so `const p = createLivePoller(...)` is safe to use inside it.
export function createLivePoller(code, onUpdate) {
  code = String(code);
  const doc = env.doc;
  let dead = false;
  let timer = null;
  let inflight = null;
  let lastAttempt = 0;
  let nextAt = 0;
  let data = null;
  let error = null;
  let loading = true;

  const visible = () => !doc || doc.visibilityState === 'visible';
  const lastTry = () => Math.max(lastAttempt, lastAttemptAt(code));
  const emit = () => { if (!dead) onUpdate({ data, error, loading, nextAt }); };
  const clear = () => {
    if (timer != null) env.clearTimeout(timer);
    timer = null;
    nextAt = 0;
  };
  const schedule = (at) => {
    clear();
    if (dead || !visible()) return;
    const delay = Math.max(0, at - env.now());
    nextAt = env.now() + delay;
    timer = env.setTimeout(run, delay);
  };

  async function run() {
    timer = null;
    nextAt = 0;
    if (dead || inflight || !visible()) return;
    const ctl = new AbortController();
    inflight = ctl;
    loading = true;
    emit();
    try {
      data = await fetchLive(code, { signal: ctl.signal });
      error = null;
    } catch (e) {
      if (e && e.name === 'AbortError') { inflight = null; return; }
      error = e instanceof ApiError ? e : new ApiError('network', e && e.message);
    }
    inflight = null;
    loading = false;
    if (dead) return;
    lastAttempt = lastTry() || env.now();
    schedule(lastAttempt + POLL_MS);
    emit();
  }

  function onVisibility() {
    if (dead) return;
    if (!visible()) { clear(); emit(); return; } // pause
    if (inflight) return;
    if (env.now() - lastTry() >= MIN_GAP_MS) run();
    else { schedule(lastTry() + POLL_MS); emit(); }
  }
  if (doc) doc.addEventListener('visibilitychange', onVisibility);

  Promise.resolve().then(() => {
    if (dead) return;
    if (visible()) run();
    else emit();
  });

  return {
    // Manual refresh. Within the 15 s floor it is deferred to the floor, never fired early.
    refresh() {
      if (dead || inflight || !visible()) return;
      const left = lastTry() + MIN_GAP_MS - env.now();
      if (left <= 0) run();
      else { schedule(env.now() + left); emit(); }
    },
    destroy() {
      dead = true;
      clear();
      if (inflight) inflight.abort();
      if (doc) doc.removeEventListener('visibilitychange', onVisibility);
    },
  };
}

// ---- reliability stats: GET /api/{city}/stats/{route}/{stop} -> { samples, medianDelaySec, p80DelaySec } | null ----
export const STATS_TTL_MS = 10 * 60 * 1000; // per key, failures included
export const STATS_MIN_SAMPLES = 10; // fewer samples are not shown or used
const STATS_TIMEOUT_MS = 5000;
const CODE_RE = /^[\w.-]{1,16}$/;

const hashOf = (s) => { let n = 0; for (const c of String(s)) n = (n * 31 + c.charCodeAt(0)) % 9973; return n; };
// Demo: roughly 3 of 4 routes have history, with a few typical delays (deterministic).
function demoStats(route, stop) {
  const n = hashOf(route + '/' + stop);
  if (n % 4 === 0) return null;
  const med = [0, 0, 60, 180, 240, 420][n % 6];
  return { samples: 12 + (n % 40), medianDelaySec: med, p80DelaySec: med + 120 };
}

async function statsRequest(route, stop) {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = env.setTimeout(() => ctl && ctl.abort(), STATS_TIMEOUT_MS);
  try {
    const res = await env.fetch(statsUrl(route, stop), { signal: ctl && ctl.signal, cache: 'no-store' });
    if (!res.ok) return null;
    const b = await res.json();
    const samples = Number(b && b.samples), med = Number(b && b.medianDelaySec);
    if (!b || !Number.isFinite(samples) || !Number.isFinite(med)) return null;
    const p80 = Number(b.p80DelaySec);
    return { samples, medianDelaySec: med, p80DelaySec: Number.isFinite(p80) ? p80 : med };
  } catch {
    return null;
  } finally {
    env.clearTimeout(timer);
  }
}

// Memoised 10 min per (route, stop), null results too. Never throws, never blocks long.
export function fetchStats(routeCode, stopCode) {
  const route = String(routeCode ?? ''), stop = String(stopCode ?? '');
  if (!CODE_RE.test(route) || !CODE_RE.test(stop)) return Promise.resolve(null);
  const key = `${cityId()}/${route}/${stop}`;
  const now = env.now();
  const hit = statsMemo.get(key);
  if (hit && now - hit.at < STATS_TTL_MS) return hit.p;
  const p = env.demo ? Promise.resolve(demoStats(route, stop)) : statsRequest(route, stop).catch(() => null);
  statsMemo.set(key, { at: now, p });
  if (statsMemo.size > 500) for (const [k, v] of statsMemo) if (now - v.at >= STATS_TTL_MS) statsMemo.delete(k);
  return p;
}

// Quiet secondary line for a scheduled arrival, or '' without enough history.
export function usualDelayText(stat) {
  if (!stat || !(stat.samples >= STATS_MIN_SAMPLES) || !Number.isFinite(stat.medianDelaySec)) return '';
  const m = Math.round(stat.medianDelaySec / 60);
  if (m === 0) return t('συνήθως στην ώρα του');
  return m > 0 ? t('συνήθως +{n}′', { n: m }) : t('συνήθως −{n}′', { n: -m });
}
