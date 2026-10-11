// Static data loader and indexes (owner: data). Contracts: docs/ARCHITECTURE.md, section D.
// buildIndex() is pure (tests); loadData() / loadShapes() fetch once and memoize.
import { titleCase, searchKey } from './text.js';
import { dataDir } from './cities.js';
import { readableLine } from './color.js';

const getJSON = async (u) => {
  const r = await fetch(u);
  if (!r.ok) throw new Error(`HTTP ${r.status} ${u}`);
  return r.json();
};

const DEFAULT_LEG_SEC = 60;

// Keeps a route usable when routes.json is a bit stale: unknown stop codes are dropped (their legs merged into the
// neighbouring leg) and a missing / malformed legSec is rebuilt from a flat default.
function cleanRoute(r, stopByCode) {
  const codes = (r.stops || []).map(String);
  const leg = Array.isArray(r.legSec) && r.legSec.length === codes.length - 1 ? r.legSec.map(Number) : codes.slice(1).map(() => DEFAULT_LEG_SEC);
  const stops = [], legSec = [];
  let carry = 0;
  codes.forEach((c, i) => {
    const gap = i > 0 ? leg[i - 1] : 0;
    if (!stopByCode.has(c)) { carry += gap; return; }
    if (stops.length) legSec.push(gap + carry);
    carry = 0;
    stops.push(c);
  });
  return stops.length >= 2 ? { stops, legSec } : null;
}

// Pure: raw JSON (as in web/data/*.json) -> Data. `rawRoutes` may be null / {} (routes.json not built yet).
export function buildIndex(rawStops, rawLines, rawRoutes) {
  const stops = rawStops.map((s) => ({
    code: String(s.code), name: s.name, displayName: titleCase(s.name), lat: s.latitude, lng: s.longitude,
    lineCodes: (s.lineCodes || []).map(String), routeCodes: (s.routeCodes || []).map(String), key: searchKey(s.name),
  }));
  const lines = rawLines.map((l) => ({
    code: String(l.code), name: l.name, displayName: titleCase(l.name), ...readableLine(l.color, l.textColor),
    routes: (l.routes || []).map((r) => ({ code: String(r.code), name: r.name, direction: r.direction })),
  }));
  const stopByCode = new Map(stops.map((s) => [s.code, s]));
  const lineByCode = new Map(lines.map((l) => [l.code, l]));
  const routes = [];
  for (const r of Object.values((rawRoutes && rawRoutes.routes) || {})) {
    const c = cleanRoute(r, stopByCode);
    if (!c) continue;
    routes.push({
      code: String(r.code), lineCode: String(r.lineCode), name: r.name, displayName: titleCase(r.name), direction: r.direction,
      stops: c.stops, legSec: c.legSec, confidence: Number(r.confidence) || 0,
      pos: new Map(c.stops.map((code, i) => [code, i])),
    });
  }
  const routeByCode = new Map(routes.map((r) => [r.code, r]));
  const routesByStop = new Map();
  for (const r of routes) for (const c of r.stops) (routesByStop.get(c) || routesByStop.set(c, []).get(c)).push(r);
  const meta = { routesGeneratedAt: (rawRoutes && rawRoutes.generatedAt) || null };
  return { stops, lines, routes, stopByCode, lineByCode, routeByCode, routesByStop, meta };
}

let dataPromise = null;
export function loadData() {
  if (!dataPromise) {
    const dir = dataDir(); // the active city's folder (Patras ./data/, others ./data/{city}/)
    dataPromise = Promise.all([
      getJSON(dir + 'stops.json'), getJSON(dir + 'lines.json'), getJSON(dir + 'routes.json').catch(() => null), // routes: optional
    ]).then(([s, l, r]) => buildIndex(s, l, r)).catch((e) => { dataPromise = null; throw e; });
  }
  return dataPromise;
}

let shapesPromise = null;
export function loadShapes() {
  // A city without shapes.json (404) just has no drawn geometry; any other failure may be transient, so retry later.
  if (!shapesPromise) shapesPromise = getJSON(dataDir() + 'shapes.json').catch((e) => { if (!/HTTP 404/.test(e?.message)) shapesPromise = null; return {}; });
  return shapesPromise;
}

// Ordered Stop objects of a route ([] for an unknown route).
export function stopsOfRoute(data, routeCode) {
  const r = data.routeByCode.get(String(routeCode));
  return r ? r.stops.map((c) => data.stopByCode.get(c)) : [];
}

// Scheduled bus seconds from stop `from` to stop `to` along the route (null if not in this order).
export function rideSec(route, from, to) {
  const a = route.pos.get(from), b = route.pos.get(to);
  if (a == null || b == null || b < a) return null;
  let s = 0;
  for (let i = a; i < b; i++) s += route.legSec[i];
  return s;
}

// Search ranking (lower tier = better): 0 exact code, 1 name starts with the query, 2 every query word starts a name
// word, 3 code prefix (digits only), 4 substring. Accent-, case- and ς/σ-insensitive. Ties: shorter name, name, code.
export function searchStops(data, q, limit = 20) {
  const raw = String(q ?? '').trim();
  const k = searchKey(raw);
  if (!k) return [];
  const words = k.split(' ');
  const digits = /^\d+$/.test(raw);
  const hits = [];
  for (const s of data.stops) {
    let tier;
    if (s.code === raw) tier = 0;
    else if (s.key.startsWith(k)) tier = 1;
    else if (words.every((w) => s.key.split(' ').some((x) => x.startsWith(w)))) tier = 2;
    else if (digits && s.code.startsWith(raw)) tier = 3;
    else if (s.key.includes(k)) tier = 4;
    else continue;
    hits.push({ s, tier });
  }
  hits.sort((a, b) => a.tier - b.tier || a.s.key.length - b.s.key.length || (a.s.key < b.s.key ? -1 : a.s.key > b.s.key ? 1 : 0) || (a.s.code < b.s.code ? -1 : 1));
  return hits.slice(0, limit).map((h) => h.s);
}
