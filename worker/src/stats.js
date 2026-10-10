// Reliability stats: how late buses really are vs the schedule, per routeCode+stopCode.
// Fed only by live responses the worker already fetched (cache MISS), never by extra upstream calls.
// A vehicle seen as scheduled at stop S (time T) that later shows live at S with eta <= 5' yields
// delay = liveArrival - T, recorded once. One Durable Object per city+routeCode+stopCode.
import { DEFAULT_CITY } from '../../web/js/cities.js';

export const MAX_SAMPLES = 200;
export const PENDING_TTL_MS = 3 * 3600 * 1000;
export const NEAR_SEC = 5 * 60;
const MAX_ABS_DELAY_SEC = 45 * 60; // beyond this it is a different lap, not a delay
const SAME_T_MS = 120 * 1000; // scheduled times are stable; this absorbs rounding
const STALE_T_MS = 20 * 60 * 1000;
const RESEEN_MS = 10 * 60 * 1000; // refresh a pending's "seen" at most this often (saves writes)

// DO name. Patras keeps the original `{route}/{stop}` (its history predates multi-city); other cities are prefixed.
export const statsName = (city, routeCode, stopCode) =>
  city === DEFAULT_CITY ? `${routeCode}/${stopCode}` : `${city}/${routeCode}/${stopCode}`;

export const validCode = (c) => typeof c === 'string' && /^\d{1,8}$/.test(c);

// Nearest-rank percentile of an ascending array.
export const percentile = (sorted, p) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];

export function summarize(state) {
  const d = (state?.samples || []).map((s) => s.d).sort((a, b) => a - b);
  const n = d.length;
  if (!n) return { samples: 0, medianDelaySec: null, p80DelaySec: null, updatedAt: state?.updatedAt ?? null };
  const mid = n >> 1;
  const median = n % 2 ? d[mid] : (d[mid - 1] + d[mid]) / 2;
  return { samples: n, medianDelaySec: Math.round(median), p80DelaySec: percentile(d, 0.8), updatedAt: state.updatedAt ?? null };
}

// Normalized LiveResult -> Map<routeCode, [{ vehicleCode, live, etaSec }]> (only vehicles we can track).
export function sightingsByRoute(result) {
  const out = new Map();
  for (const v of result && Array.isArray(result.vehicles) ? result.vehicles : []) {
    if (!v.vehicleCode || !validCode(v.routeCode) || !Number.isFinite(v.etaSec)) continue;
    if (!out.has(v.routeCode)) out.set(v.routeCode, []);
    out.get(v.routeCode).push({ vehicleCode: v.vehicleCode, live: !!v.live, etaSec: v.etaSec });
  }
  return out;
}

// state: { samples: [{ d, t }], pending: { [vehicleCode]: { T, seen } }, done: { [vehicleCode]: T }, updatedAt }.
// batch: { fetchedAt, vehicles: [{ vehicleCode, live, etaSec }] } for one route at one stop.
// Pure: returns { state, changed, recorded }.
export function applySightings(state, batch, now) {
  const st = {
    samples: [...(state?.samples || [])],
    pending: { ...(state?.pending || {}) },
    done: { ...(state?.done || {}) },
    updatedAt: state?.updatedAt ?? null,
  };
  let changed = false;
  let recorded = 0;
  for (const [vc, p] of Object.entries(st.pending)) {
    if (now - p.seen > PENDING_TTL_MS) { delete st.pending[vc]; changed = true; }
  }
  for (const [vc, T] of Object.entries(st.done)) {
    if (now - T > PENDING_TTL_MS) { delete st.done[vc]; changed = true; }
  }

  for (const v of batch.vehicles) {
    const at = batch.fetchedAt + v.etaSec * 1000;
    const p = st.pending[v.vehicleCode];
    if (!v.live) {
      const d = st.done[v.vehicleCode];
      if (d !== undefined && Math.abs(d - at) <= SAME_T_MS) continue; // already measured this pass
      if (!p || p.T < batch.fetchedAt - STALE_T_MS) {
        st.pending[v.vehicleCode] = { T: at, seen: now };
        changed = true;
      } else if (Math.abs(p.T - at) <= SAME_T_MS && now - p.seen > RESEEN_MS) {
        st.pending[v.vehicleCode] = { ...p, seen: now };
        changed = true;
      }
    } else if (p && v.etaSec <= NEAR_SEC) {
      const delay = Math.round((at - p.T) / 1000);
      delete st.pending[v.vehicleCode];
      st.done[v.vehicleCode] = p.T;
      if (Math.abs(delay) <= MAX_ABS_DELAY_SEC) {
        st.samples.push({ d: delay, t: now });
        recorded++;
      }
      changed = true;
    }
  }
  if (st.samples.length > MAX_SAMPLES) st.samples = st.samples.slice(-MAX_SAMPLES);
  if (recorded) st.updatedAt = now;
  return { state: st, changed, recorded };
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export class StatsBase {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const st = this.state.storage;
    if (request.method === 'GET') return json(summarize(await st.get('s')));
    if (request.method !== 'POST') return json({ error: 'method' }, 405);
    const batch = await request.json();
    const r = applySightings(await st.get('s'), batch, Date.now());
    if (r.changed) await st.put('s', r.state);
    return json({ ok: true, recorded: r.recorded });
  }
}

// Called from the live path after a real upstream fetch. Best effort, never throws.
export async function recordStats(env, city, stopCode, result) {
  if (!env.STATS) return;
  try {
    const calls = [];
    for (const [routeCode, vehicles] of sightingsByRoute(result)) {
      const stub = env.STATS.get(env.STATS.idFromName(statsName(city, routeCode, stopCode)));
      calls.push(stub.fetch('https://stats/', { method: 'POST', body: JSON.stringify({ fetchedAt: result.fetchedAt, vehicles }) }));
    }
    await Promise.allSettled(calls);
  } catch (err) {
    console.error(`stats: ${err.message}`);
  }
}

export async function readStats(env, city, routeCode, stopCode) {
  const stub = env.STATS.get(env.STATS.idFromName(statsName(city, routeCode, stopCode)));
  const res = await stub.fetch('https://stats/');
  return res.text();
}
