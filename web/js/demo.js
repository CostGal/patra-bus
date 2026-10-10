// Synthetic live data for ?demo. Deterministic from the clock: every route runs trips at a fixed headway
// (10–25 min, from a hash of the route code); a trip is one vehicle (stable vehicleCode) passing the
// stops in route order, so the same vehicle shows up at successive stops with increasing ETAs.
// Trips already underway and within LIVE_HORIZON_SEC are live (position interpolated between stops);
// the rest are scheduled (no coordinates). Output goes through normalizeLive, i.e. the real shape.
import { normalizeLive, noServiceResult } from './arrivals.js';

const LIVE_HORIZON_SEC = 20 * 60; // live only when the bus is on its way and this close
const LOOKAHEAD_SEC = 60 * 60;
const MAX_PER_ROUTE = 3;
const MAX_VEHICLES = 16;
const DEFAULT_SPEED = 5.5; // m/s incl. dwell, only for legs without data

let model = null; // { routes: Route[], byStop: Map<stopCode, {r, i}[]> }
let loading = null;

const hash = (s) => {
  let x = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 0x01000193); }
  return x >>> 0;
};

const meters = (a, b) => {
  const dy = (b.lat - a.lat) * 110540;
  const dx = (b.lng - a.lng) * 111320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dx, dy);
};

// Fallback when routes.json has no order: nearest-neighbour chain from the stop farthest from the centroid.
function chain(pts) {
  if (pts.length < 2) return pts;
  const c = { lat: pts.reduce((s, p) => s + p.lat, 0) / pts.length, lng: pts.reduce((s, p) => s + p.lng, 0) / pts.length };
  let cur = pts.reduce((best, p) => (meters(c, p) > meters(c, best) ? p : best), pts[0]);
  const left = new Set(pts);
  const out = [];
  while (cur) {
    out.push(cur);
    left.delete(cur);
    let next = null;
    let nd = Infinity;
    for (const p of left) { const d = meters(cur, p); if (d < nd) { nd = d; next = p; } }
    cur = next;
  }
  return out;
}

// raw: { stops: stops.json array, lines: lines.json array, routes?: routes.json (whole file or its `routes` map) }
function build({ stops, lines, routes }) {
  const stopByCode = new Map();
  for (const s of stops || []) stopByCode.set(String(s.code), { code: String(s.code), lat: Number(s.latitude), lng: Number(s.longitude) });
  const ordered = (routes && routes.routes) || routes || {};
  const onRoute = new Map(); // routeCode -> stops serving it (unordered)
  for (const s of stops || []) for (const rc of s.routeCodes || []) (onRoute.get(String(rc)) || onRoute.set(String(rc), []).get(String(rc))).push(stopByCode.get(String(s.code)));
  const names = new Map(); // routeCode -> { lineCode, name }
  const lineByCode = new Map();
  for (const l of lines || []) {
    lineByCode.set(String(l.code), l);
    for (const r of l.routes || []) names.set(String(r.code), { lineCode: String(l.code), name: r.name });
  }
  for (const r of Object.values(ordered)) if (!names.has(String(r.code))) names.set(String(r.code), { lineCode: String(r.lineCode ?? ''), name: r.name });

  const out = [];
  for (const [code, meta] of names) {
    const o = ordered[code];
    let pts = [];
    let off = [];
    if (o && Array.isArray(o.stops) && o.stops.length >= 2) {
      // Offsets first, then drop unknown stops, so legs stay right when a stop is missing.
      let t = 0;
      o.stops.forEach((sc, i) => {
        if (i > 0) { const leg = Number(o.legSec && o.legSec[i - 1]); t += Number.isFinite(leg) && leg > 0 ? leg : 45; }
        const s = stopByCode.get(String(sc));
        if (s) { pts.push(s); off.push(t); }
      });
    }
    if (pts.length < 2) {
      pts = chain(onRoute.get(code) || []);
      off = [];
      let t = 0;
      pts.forEach((p, i) => { if (i > 0) t += Math.max(20, meters(pts[i - 1], p) / DEFAULT_SPEED + 15); off.push(t); });
    }
    if (pts.length < 2) continue;
    const line = lineByCode.get(meta.lineCode) || {};
    const headwaySec = (10 + (hash(code) % 16)) * 60;
    out.push({
      code, lineCode: meta.lineCode, lineName: line.name ?? '', routeName: meta.name ?? '',
      color: line.color ?? null, textColor: line.textColor ?? null, borderColor: line.borderColor ?? null,
      pts, off, headwaySec, phaseSec: (hash(`${code}:phase`) % (headwaySec / 60)) * 60,
    });
  }
  const byStop = new Map();
  for (const r of out) r.pts.forEach((p, i) => (byStop.get(p.code) || byStop.set(p.code, []).get(p.code)).push({ r, i }));
  return { routes: out, byStop };
}

// For tests, and to inject data without fetch.
export function _setDemoData(raw) { model = raw ? build(raw) : null; loading = null; return model; }
export const demoRoutes = () => (model ? model.routes : []);

// Browser: load stops/lines/routes (routes.json is optional). Resolves true when demoLive can answer.
export function demoReady() {
  if (model) return Promise.resolve(true);
  if (!loading) {
    const get = async (u, optional) => {
      try { const r = await fetch(u); if (!r.ok) throw new Error(r.status); return await r.json(); } catch (e) { if (optional) return null; throw e; }
    };
    loading = Promise.all([get('./data/stops.json'), get('./data/lines.json'), get('./data/routes.json', true)])
      .then(([stops, lines, routes]) => { model = build({ stops, lines, routes }); return true; })
      .catch(() => { loading = null; return false; });
  }
  return loading;
}

const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Athens', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function tripId(routeCode, depMs) {
  const p = Object.fromEntries(ymd.formatToParts(new Date(depMs)).map((x) => [x.type, x.value]));
  return `${p.year}${p.month}${p.day}_${routeCode}_0000100_${p.hour}_${p.minute}`;
}

function position(r, elapsedSec) {
  let j = 0;
  while (j + 2 < r.off.length && r.off[j + 1] <= elapsedSec) j++;
  const span = r.off[j + 1] - r.off[j];
  const f = span > 0 ? Math.min(1, Math.max(0, (elapsedSec - r.off[j]) / span)) : 0;
  const a = r.pts[j];
  const b = r.pts[j + 1];
  return { lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f };
}

// Same shape as fetchLive's LiveResult. Returns null until demoReady() has resolved true.
export function demoLive(code, now = Date.now()) {
  if (!model) return null;
  const occ = model.byStop.get(String(code));
  if (!occ) return noServiceResult(now);
  const raw = [];
  for (const { r, i } of occ) {
    const H = r.headwaySec * 1000;
    const arrOff = r.off[i] * 1000;
    let k = Math.ceil((now - r.phaseSec * 1000 - arrOff) / H);
    for (let n = 0; n < MAX_PER_ROUTE; n++, k++) {
      const dep = r.phaseSec * 1000 + k * H;
      const eta = Math.max(0, Math.round((dep + arrOff - now) / 1000));
      if (eta > LOOKAHEAD_SEC) break;
      const live = dep <= now && eta <= LIVE_HORIZON_SEC;
      const pos = live ? position(r, (now - dep) / 1000) : null;
      raw.push({
        lineCode: r.lineCode, lineName: r.lineName, routeCode: r.code, routeName: r.routeName,
        latitude: pos ? pos.lat.toFixed(6) : '0', longitude: pos ? pos.lng.toFixed(6) : '0',
        departureMins: Math.floor(eta / 60), departureSeconds: eta % 60,
        vehicleCode: tripId(r.code, dep), lineColor: r.color, lineTextColor: r.textColor, borderColor: r.borderColor,
      });
    }
  }
  const res = normalizeLive({ vehicles: raw }, now);
  res.vehicles = res.vehicles.slice(0, MAX_VEHICLES);
  return res.vehicles.length ? res : noServiceResult(now);
}
