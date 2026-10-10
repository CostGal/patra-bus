// Builds web/data/routes.json (ordered stops + bus leg seconds) and web/data/shapes.json (road geometry).
//
// Upstream only gives each route's stops as an UNORDERED set. We recover the order with open data only:
//   1. natural endpoints  = ends of the best open path (NN + 2-opt + or-opt on straight-line distance);
//   2. orientation guess  = route name tokens located on the map (e.g. "ΕΓΛΥΚΑΔΑ ΤΕΡΨΙΘΕΑ" = Eglykada first);
//   3. order              = one OSRM *trip* call (car, fixed first/last);
//   4. orientation check  = "right side of the road" test on that trip: in right-hand traffic bus stops sit on the
//                           right of the travel direction, so a route whose stops are mostly on its left is reversed
//                           (re-trip with swapped ends);
//   5. legs + geometry    = one OSRM *route* call over the ordered stops.
// No citybus call happens here. OSRM = public FOSSGIS server (fallback: router.project-osrm.org), >= 1.1 s between
// requests, responses cached in scripts/.cache/osrm/ (needs a `scripts/.cache/` line in .gitignore).
//
// Usage: node scripts/build-routes.mjs [--city=corfu] [--offline] [--dry] [--only=1014,2015] [--write] [--quiet]
//   --city     which city's data dir to read and write (default: Patras, web/data/)
//   --offline  never touch the network (cache only, else heuristic fallback)
//   --dry      compute and print, write nothing (diagnostics still go to scripts/.cache/)
//   --only     process just these routes; implies --dry unless --write is given
import { readFile, writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { searchKey } from '../web/js/text.js';
import { city, dataDir, setActiveCity, DEFAULT_CITY } from '../web/js/cities.js';

const dataUrl = () => new URL(`../web/${dataDir().slice(2)}`, import.meta.url);
let DATA = dataUrl();
const CACHE = new URL('./.cache/osrm/', import.meta.url);

// Tunable constants (documented in docs/ARCHITECTURE.md terms: bus legSec = car seconds x BUS_FACTOR + DWELL_SEC).
export const K = {
  BUS_FACTOR: 1.4,   // OSRM car profile is optimistic for a city bus (traffic, acceleration, size)
  DWELL_SEC: 15,     // average stop time per leg
  MIN_LEG_SEC: 20,
  OFFLINE_SPEED: 5,  // m/s on (straight line x ROAD_FACTOR) for the offline fallback
  ROAD_FACTOR: 1.3,
  DP_TOL_M: 8,       // Douglas-Peucker tolerance for shapes
  JUMP_M: 1500,      // consecutive stops further apart than this are flagged
  SIDE_MIN_OFF_M: 2, // stops closer than this to the road centre line say nothing about the side
  CENTER: city().center, // the "ΚΕΝΤΡΟ" of the route names
  UA: 'patra-bus/2 (github.com/CostGal/patra-bus)',
  MIN_GAP_MS: 1100,
  SERVERS: ['https://routing.openstreetmap.de/routed-car', 'https://router.project-osrm.org'],
};

// ---------------------------------------------------------------- geometry
const RAD = Math.PI / 180;
export function haversine(a, b) {
  const dLat = (b.lat - a.lat) * RAD, dLng = (b.lng - a.lng) * RAD;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(x));
}
export function pathLength(pts, order) {
  let s = 0;
  for (let i = 1; i < order.length; i++) s += haversine(pts[order[i - 1]], pts[order[i]]);
  return s;
}
// Kendall tau-a in [-1, 1] between two equally long numeric arrays (0 when undefined).
export function kendallTau(xs, ys) {
  let c = 0, d = 0;
  for (let i = 0; i < xs.length; i++) for (let j = i + 1; j < xs.length; j++) {
    const p = (xs[i] - xs[j]) * (ys[i] - ys[j]);
    if (p > 0) c++; else if (p < 0) d++;
  }
  return c + d ? (c - d) / (c + d) : 0;
}
const clamp = (x, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));

// Local metric projection around a point: [lng, lat] -> [x, y] metres.
function projector(lat0) {
  const kx = 111320 * Math.cos(lat0 * RAD), ky = 110540;
  return ([lng, lat]) => [lng * kx, lat * ky];
}

// Douglas-Peucker on [lng, lat][]; tolerance in metres. Keeps first and last point.
export function douglasPeucker(coords, tolM = K.DP_TOL_M) {
  const n = coords.length;
  if (n <= 2) return coords.slice();
  const proj = projector(coords[0][1]);
  const P = coords.map(proj);
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxD = -1, idx = -1;
    const [ax, ay] = P[a], [bx, by] = P[b];
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      let d;
      if (!L2) d = Math.hypot(P[i][0] - ax, P[i][1] - ay);
      else {
        const t = clamp(((P[i][0] - ax) * dx + (P[i][1] - ay) * dy) / L2);
        d = Math.hypot(P[i][0] - (ax + t * dx), P[i][1] - (ay + t * dy));
      }
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tolM) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return coords.filter((_, i) => keep[i]);
}
// Simplify + round to 5 decimals (~1 m) + drop consecutive duplicates.
export function simplifyShape(coords, tolM = K.DP_TOL_M) {
  const out = [];
  for (const [x, y] of douglasPeucker(coords, tolM)) {
    const p = [Math.round(x * 1e5) / 1e5, Math.round(y * 1e5) / 1e5];
    const q = out[out.length - 1];
    if (!q || q[0] !== p[0] || q[1] !== p[1]) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------- open-path heuristic (NN + 2-opt + or-opt)
function distMatrix(pts) {
  const n = pts.length, D = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) D[i][j] = D[j][i] = haversine(pts[i], pts[j]);
  return D;
}
const openLen = (o, D) => { let s = 0; for (let i = 1; i < o.length; i++) s += D[o[i - 1]][o[i]]; return s; };

function nearestNeighbour(D, start, last = -1) {
  const n = D.length, used = new Uint8Array(n), o = [start];
  used[start] = 1;
  if (last >= 0) used[last] = 1;
  const want = last >= 0 ? n - 1 : n;
  while (o.length < want) {
    const cur = o[o.length - 1];
    let best = -1;
    for (let j = 0; j < n; j++) if (!used[j] && (best < 0 || D[cur][j] < D[cur][best])) best = j;
    used[best] = 1; o.push(best);
  }
  if (last >= 0) o.push(last);
  return o;
}

// In-place local search on an open path; fixFirst / fixLast pin the end points.
function improve(o, D, fixFirst, fixLast) {
  const n = o.length;
  for (let pass = 0; pass < 100; pass++) {
    let changed = false;
    // 2-opt: reverse o[i..j]
    for (let i = fixFirst ? 1 : 0; i < n - 1; i++) {
      for (let j = i + 1; j <= (fixLast ? n - 2 : n - 1); j++) {
        const a = i > 0 ? o[i - 1] : -1, b = o[i], c = o[j], d = j < n - 1 ? o[j + 1] : -1;
        const delta = (a >= 0 ? D[a][c] - D[a][b] : 0) + (d >= 0 ? D[b][d] - D[c][d] : 0);
        if (delta < -1e-6) {
          for (let x = i, y = j; x < y; x++, y--) [o[x], o[y]] = [o[y], o[x]];
          changed = true;
        }
      }
    }
    // or-opt: move a segment of 1..3 stops (optionally reversed) elsewhere
    for (let len = 1; len <= 3 && len < n - 1; len++) {
      for (let i = fixFirst ? 1 : 0; i + len - 1 <= (fixLast ? n - 2 : n - 1); i++) {
        const j = i + len - 1, s0 = o[i], s1 = o[j];
        const p = i > 0 ? o[i - 1] : -1, q = j < n - 1 ? o[j + 1] : -1;
        const gain = (p >= 0 ? D[p][s0] : 0) + (q >= 0 ? D[s1][q] : 0) - (p >= 0 && q >= 0 ? D[p][q] : 0);
        const rest = o.slice(0, i).concat(o.slice(j + 1));
        let best = null;
        for (let g = fixFirst ? 1 : 0; g <= rest.length - (fixLast ? 1 : 0); g++) {
          if (g === i) continue;
          const a = g > 0 ? rest[g - 1] : -1, b = g < rest.length ? rest[g] : -1;
          const base = a >= 0 && b >= 0 ? D[a][b] : 0;
          for (const rev of [false, true]) {
            const u = rev ? s1 : s0, v = rev ? s0 : s1;
            const cost = (a >= 0 ? D[a][u] : 0) + (b >= 0 ? D[v][b] : 0) - base;
            if (gain - cost > 1e-6 && (!best || gain - cost > best.net)) best = { g, rev, net: gain - cost };
          }
        }
        if (best) {
          const seg = o.slice(i, j + 1);
          if (best.rev) seg.reverse();
          o.splice(0, o.length, ...rest.slice(0, best.g), ...seg, ...rest.slice(best.g));
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return o;
}

// Best open path through pts (indices). Pin ends with {first, last}; otherwise multi-start from the extreme stops.
export function bestOpenPath(pts, { first = -1, last = -1 } = {}) {
  const n = pts.length;
  if (n <= 2) return pts.map((_, i) => i);
  const D = distMatrix(pts);
  let starts;
  if (first >= 0) starts = [first];
  else if (n <= 10) starts = pts.map((_, i) => i);
  else {
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    starts = [...new Set(dirs.map(([dx, dy]) => {
      let bi = 0, bv = -Infinity;
      pts.forEach((p, i) => { const v = dx * p.lng + dy * p.lat; if (v > bv) { bv = v; bi = i; } });
      return bi;
    }))];
  }
  let best = null, bestLen = Infinity;
  for (const s of starts) {
    if (s === last) continue;
    const o = improve(nearestNeighbour(D, s, last), D, first >= 0, last >= 0);
    const len = openLen(o, D);
    if (len < bestLen - 1e-6) { best = o; bestLen = len; }
  }
  return best;
}
// Pure helper used by the fixed-end offline fallback and the tests.
export const nnTwoOpt = (pts, first, last) => bestOpenPath(pts, { first, last });

// ---------------------------------------------------------------- names: tokens, locations, orientation evidence
const LAT2GR = { a: 'α', b: 'β', e: 'ε', h: 'η', i: 'ι', k: 'κ', m: 'μ', n: 'ν', o: 'ο', p: 'ρ', t: 'τ', x: 'χ', y: 'υ', z: 'ζ' };
// Some upstream names mix Latin look-alikes into Greek words ("ΖΑΡΟΥΧΛEIKA"); fix those tokens.
const fixLookalike = (t) => (/\p{Script=Greek}/u.test(t) && /[a-z]/.test(t) ? t.replace(/[a-z]/g, (c) => LAT2GR[c] || c) : t);
export function nameTokens(s) {
  return searchKey(s).replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((t) => t.length > 1).map(fixLookalike);
}
// Same word modulo Greek inflection: common prefix >= 4 chars and >= 70 % of the longer token.
export function tokenMatch(a, b) {
  if (a === b) return true;
  const m = Math.min(a.length, b.length);
  if (m < 4) return false;
  let k = 0;
  while (k < m && a[k] === b[k]) k++;
  return k >= 4 && k >= Math.ceil(0.7 * Math.max(a.length, b.length));
}
const NOISE = new Set(['σχολικο', 'express', 'επιστροφη', 'μεταβαση', 'ανω', 'κατω', 'νεο']);

// stops: [{ code, name, lat, lng }] (all of them). find(token) -> stops whose name has a matching token.
export function buildNameIndex(stops) {
  const tok = stops.map((s) => ({ s, t: nameTokens(s.name) }));
  const memo = new Map();
  return {
    find(token) {
      if (!memo.has(token)) memo.set(token, tok.filter((x) => x.t.some((u) => tokenMatch(token, u))).map((x) => x.s));
      return memo.get(token);
    },
  };
}

// "ΕΓΛΥΚΑΔΑ ΤΕΡΨΙΘΕΑ" -> items [{tokens:'εγλυκαδα', p:0}, {'τερψιθεα', p:1}]. p = expected position along the trip
// (0 = start, 1 = end); hyphen chunks share a p. A lone place name means "centre -> place" (implicit centre item).
export function parseRouteName(name) {
  const raw = String(name ?? '');
  const key = searchKey(raw);
  const flags = { ret: /επιστροφ/.test(key), go: /μεταβασ/.test(key), school: /σχολικ/.test(key) };
  const s = raw.replace(/\([^)]*\)/g, ' ').replace(/-\s*[ΝN]\d+\s*$/u, ' ');
  const chunks = s.split(/\s*-\s*/).map((c) => nameTokens(c).filter((t) => !NOISE.has(t))).filter((c) => c.length);
  let items = [];
  const mk = (t, p) => (t === 'κεντρο' ? { center: true, p } : { token: t, p });
  if (chunks.length >= 2) chunks.forEach((c, k) => c.forEach((t) => items.push(mk(t, k / (chunks.length - 1)))));
  else {
    const toks = chunks[0] || [];
    toks.forEach((t, i) => items.push(mk(t, toks.length > 1 ? i / (toks.length - 1) : 1)));
    if (toks.length === 1 && !toks.includes('κεντρο') && !flags.school) items.push({ center: true, p: 0, implicit: true });
  }
  if (flags.ret) items = items.map((it) => ({ ...it, p: 1 - it.p }));
  return { items, flags };
}

// Locations (stops) of a name item and a 0..1 weight (rare + geographically compact words count more).
export function itemLocations(item, index, center = K.CENTER) {
  if (item.center) return { members: [center], weight: item.implicit ? 0.4 : 0.8 };
  const members = index.find(item.token);
  if (!members.length) return { members, weight: 0 };
  const rarity = clamp(1 - Math.log(1 + members.length) / Math.log(40));
  let spread = 0;
  if (members.length > 1) {
    const c = { lat: members.reduce((a, m) => a + m.lat, 0) / members.length, lng: members.reduce((a, m) => a + m.lng, 0) / members.length };
    spread = members.reduce((a, m) => a + haversine(c, m), 0) / members.length;
  }
  return { members, weight: rarity * clamp(1.5 - spread / 2000) };
}
const nearestDist = (p, members) => Math.min(...members.map((m) => haversine(p, m)));

// Evidence in [-1, 1] that the trip runs f -> l (negative = reversed); w in [0, 1] = how much name evidence there was.
export function orientationEvidence(items, index, f, l) {
  let e = 0, den = 0;
  for (const it of items) {
    const dir = it.p < 0.5 ? -1 : it.p > 0.5 ? 1 : 0;
    if (!dir) continue;
    const { members, weight } = itemLocations(it, index);
    if (!members.length || weight <= 0) continue;
    e += weight * dir * clamp((nearestDist(f, members) - nearestDist(l, members)) / 1000, -1, 1);
    den += weight;
  }
  return { e: den ? e / den : 0, w: Math.min(1, den) };
}
// Does `pt` sit next to a place the name puts at the given end of the trip?
export function terminalMatches(items, index, pt, end /* 'start' | 'end' */, radius = 400) {
  return items.some((it) => {
    if (it.implicit || (end === 'start' ? it.p >= 0.5 : it.p <= 0.5)) return false;
    const { members, weight } = itemLocations(it, index);
    return weight > 0 && nearestDist(pt, members) <= (it.center ? 1500 : radius);
  });
}

// ---------------------------------------------------------------- side-of-road orientation test
// geom: [lng,lat][] (OSRM full overview), legDist: metres per leg (n-1), snapped / stops: per waypoint in TRIP order.
// Returns { right, left, score }: score = (right-left)/(right+left); stops on the right of the travel direction
// support the assumed orientation (right-hand traffic).
export function sideTest(geom, legDist, snapped, stops, minOff = K.SIDE_MIN_OFF_M) {
  const empty = { right: 0, left: 0, score: 0 };
  if (geom.length < 2 || snapped.length < 2) return empty;
  const proj = projector(geom[0][1]);
  const G = geom.map(proj);
  const cum = [0];
  for (let i = 1; i < G.length; i++) cum.push(cum[i - 1] + Math.hypot(G[i][0] - G[i - 1][0], G[i][1] - G[i - 1][1]));
  const total = legDist.reduce((a, b) => a + b, 0) || cum[cum.length - 1];
  const scale = cum[cum.length - 1] / (total || 1);
  let at = 0, right = 0, left = 0, seg = 0;
  for (let k = 0; k < snapped.length; k++) {
    if (k > 0) at += legDist[k - 1] || 0;
    const target = Math.min(cum[cum.length - 1], at * scale);
    while (seg < G.length - 2 && cum[seg + 1] < target) seg++;
    // at a leg boundary use the segment that carries on, except for the final stop
    const j = k === snapped.length - 1 ? G.length - 2 : seg;
    const dx = G[j + 1][0] - G[j][0], dy = G[j + 1][1] - G[j][1];
    const [ox, oy] = proj(snapped[k]), [qx, qy] = proj([stops[k].lng, stops[k].lat]);
    const vx = qx - ox, vy = qy - oy;
    if (Math.hypot(vx, vy) < minOff || !(dx || dy)) continue;
    if (dx * vy - dy * vx < 0) right++; else left++;
  }
  return { right, left, score: right + left ? (right - left) / (right + left) : 0 };
}

// ---------------------------------------------------------------- bus times
export const legSecFromCar = (carSec) => Math.max(K.MIN_LEG_SEC, Math.round(carSec * K.BUS_FACTOR + K.DWELL_SEC));
export const legSecFromDistance = (m) => Math.max(K.MIN_LEG_SEC, Math.round((m * K.ROAD_FACTOR) / K.OFFLINE_SPEED + K.DWELL_SEC));

// ---------------------------------------------------------------- confidence
// All inputs 0..1 except flags. method: 'osrm' | 'offline'.
export function computeConfidence({ terminal = 0.3, orient = 0, consistency = null, pathRatio = 1, carRatio = 1.3, jumps = 0, osrm = true }) {
  const orderQ = clamp(1 - (pathRatio - 1.15) / 0.65);       // OSRM order vs straight-line best path
  const detourQ = clamp(1 - (carRatio - 1.8) / 1.2);          // road length vs straight-line length of the order
  const pathQ = Math.min(orderQ, detourQ);
  let c = 0.30 * terminal + 0.25 * orient + 0.25 * (consistency == null ? 0.6 : consistency) + 0.20 * pathQ;
  if (jumps > 0) c *= 0.85;
  if (!osrm) c = Math.min(c * 0.6, 0.4);
  return Math.round(clamp(c) * 100) / 100;
}

// ---------------------------------------------------------------- OSRM client (cached, rate limited, retries)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function createOsrm({ cacheDir = CACHE, servers = K.SERVERS, offline = false, fetchImpl = fetch, minGapMs = K.MIN_GAP_MS, log = () => {} } = {}) {
  let lastAt = 0;
  const stats = { cached: 0, network: 0 };
  async function call(kind, coords, query) {
    const key = createHash('sha1').update(`${kind}|${coords}|${query}`).digest('hex').slice(0, 24);
    const file = new URL(`${kind}-${key}.json`, cacheDir);
    try { const j = JSON.parse(await readFile(file, 'utf8')); stats.cached++; return j; } catch { /* miss */ }
    if (offline) throw new Error('offline: not cached');
    let lastErr = new Error('no server');
    for (const base of servers) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const wait = lastAt + minGapMs - Date.now();
        if (wait > 0) await sleep(wait);
        try {
          const res = await fetchImpl(`${base}/${kind}/v1/driving/${coords}?${query}`, { headers: { 'User-Agent': K.UA }, signal: AbortSignal.timeout(60000) });
          lastAt = Date.now(); stats.network++;
          if (res.status === 429 || res.status >= 500) { lastErr = new Error(`${base}: HTTP ${res.status}`); await sleep(2000 * 2 ** attempt); continue; }
          const j = await res.json().catch(() => null);
          if (res.ok && j && j.code === 'Ok') {
            await mkdir(cacheDir, { recursive: true });
            await writeFile(file, JSON.stringify({ server: base, ...j }));
            return j;
          }
          lastErr = new Error(`${base}: ${j?.code || res.status} ${j?.message || ''}`.trim());
          break; // definitive answer (NoTrips, NoRoute...): try the next server
        } catch (e) {
          lastAt = Date.now();
          lastErr = e; log(`  retry (${e.message})`);
          await sleep(2000 * 2 ** attempt);
        }
      }
    }
    throw lastErr;
  }
  const ll = (p) => `${p.lng.toFixed(5)},${p.lat.toFixed(5)}`;
  return {
    stats,
    // pts in the desired input order (first = start, last = end). -> { order: idx into pts, geometry, legs, waypoints, ... }
    async trip(pts) {
      const j = await call('trip', pts.map(ll).join(';'), 'roundtrip=false&source=first&destination=last&overview=full&geometries=geojson&steps=false');
      const t = j.trips && j.trips[0];
      if (!t || !j.waypoints || j.waypoints.length !== pts.length) throw new Error('trip: malformed response');
      const order = j.waypoints.map((w, i) => [w.waypoint_index, i]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
      if (new Set(order).size !== pts.length || order[0] !== 0 || order[order.length - 1] !== pts.length - 1) throw new Error('trip: bad permutation');
      return { order, geometry: t.geometry.coordinates, legs: t.legs, waypoints: order.map((i) => j.waypoints[i]), duration: t.duration, distance: t.distance };
    },
    async route(pts) {
      const j = await call('route', pts.map(ll).join(';'), 'overview=full&geometries=geojson&steps=false&continue_straight=false');
      const r = j.routes && j.routes[0];
      if (!r || r.legs.length !== pts.length - 1) throw new Error('route: malformed response');
      return { geometry: r.geometry.coordinates, legs: r.legs, waypoints: j.waypoints, duration: r.duration, distance: r.distance };
    },
  };
}

// ---------------------------------------------------------------- one route
const sortByCode = (a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
const tag = /ΤΕΡΜΑ|ΑΦΕΤΗΡΙΑ/;

export async function processRoute(rt, pts, ctx) {
  const { index, osrm, log } = ctx;
  const n = pts.length;
  const diag = { flags: [] };
  const out = { code: rt.code, lineCode: rt.lineCode, name: rt.name, direction: rt.direction };
  if (n < 2) return { ...out, stops: pts.map((p) => p.code), legSec: [], confidence: 0, method: 'single', diag, shape: [] };

  // 1-2. natural end points + orientation guess from the name
  const heur = bestOpenPath(pts);
  const heurLen = pathLength(pts, heur);
  const { items, flags } = parseRouteName(rt.name);
  let f = heur[0], l = heur[n - 1];
  const ev0 = orientationEvidence(items, index, pts[f], pts[l]);
  let nameE = ev0.e; // name evidence for f -> l as currently chosen
  if (ev0.e < 0) { [f, l] = [l, f]; nameE = -ev0.e; }
  diag.nameEvidence = { e: +ev0.e.toFixed(2), w: +ev0.w.toFixed(2) };

  let order = null, method = 'osrm-trip', side = { right: 0, left: 0, score: 0 }, flipped = false, res = null;
  try {
    const runTrip = async (a, b) => {
      const mid = pts.map((_, i) => i).filter((i) => i !== a && i !== b).sort((i, j) => sortByCode(pts[i], pts[j]));
      const idx = n === 2 ? [a, b] : [a, ...mid, b];
      if (n === 2) {
        const r = await osrm.route(idx.map((i) => pts[i]));
        return { order: idx, geometry: r.geometry, legs: r.legs, waypoints: r.waypoints };
      }
      const t = await osrm.trip(idx.map((i) => pts[i]));
      return { ...t, order: t.order.map((k) => idx[k]) };
    };
    // 4. combine evidence: side-of-road (strong), name, stop-code monotonicity (weak)
    const judge = (t, nameEv) => {
      const sd = sideTest(t.geometry, t.legs.map((x) => x.distance), t.waypoints.map((w) => w.location), t.order.map((i) => pts[i]));
      const codes = t.order.map((i) => +pts[i].code), tau = kendallTau(codes, codes.map((_, k) => k));
      const rel = Math.min(1, (sd.right + sd.left) / 10);
      return { sd, tau, rel, total: 1.6 * sd.score * rel + nameEv * ev0.w + 0.3 * tau };
    };
    res = await runTrip(f, l);
    let j = judge(res, nameE);
    const first = j;
    // wrong-looking or inconclusive: also try the reverse direction and keep the better-supported one
    if (n > 2 && (j.total < 0 || (Math.abs(j.total) < 0.35 && j.sd.right + j.sd.left >= 4))) {
      const alt = await runTrip(l, f);
      const j2 = judge(alt, -nameE);
      if (j2.total > j.total) { res = alt; j = j2; [f, l] = [l, f]; nameE = -nameE; flipped = true; method = 'osrm-trip-flipped'; }
    } else if (n === 2 && j.total < 0) { [f, l] = [l, f]; nameE = -nameE; flipped = true; method = 'osrm-trip-flipped'; res = await runTrip(f, l); j = judge(res, nameE); }
    side = j.sd;
    diag.side = { right: side.right, left: side.left, tau: +j.tau.toFixed(2), total: +j.total.toFixed(2) };
    if (flipped) diag.sideFirst = { right: first.sd.right, left: first.sd.left };
    diag.orientTotal = +j.total.toFixed(2);
    order = res.order;
    const r = j.rel;
    if (ev0.w > 0.2 && Math.sign(nameE) !== Math.sign(side.score) && Math.abs(side.score) > 0.4 && r > 0.5) diag.flags.push('name-vs-side');

    // 5. legs + geometry over the final order
    let legCar, geometry, dist;
    try {
      const rr = await osrm.route(order.map((i) => pts[i]));
      legCar = rr.legs.map((x) => x.duration); geometry = rr.geometry; dist = rr.distance;
      diag.snapMax = Math.round(Math.max(...rr.waypoints.map((w) => w.distance)));
    } catch (e) {
      log(`  route call failed (${e.message}); using trip legs`);
      legCar = res.legs.map((x) => x.duration); geometry = res.geometry; dist = res.distance; method += '-tripleg';
    }
    const legSec = legCar.map(legSecFromCar);
    const orderPts = order.map((i) => pts[i]);
    const pathRatio = n > 2 ? pathLength(pts, order) / Math.max(1, heurLen) : 1;
    const carRatio = dist / Math.max(1, pathLength(pts, order));
    const jumps = orderPts.slice(1).filter((p, i) => haversine(orderPts[i], p) > K.JUMP_M).length;
    const startM = terminalMatches(items, index, orderPts[0], 'start'), endM = terminalMatches(items, index, orderPts[n - 1], 'end');
    let terminal = 0.25 + 0.35 * startM + 0.35 * endM + (tag.test(orderPts[0].name) ? 0.05 : 0) + (tag.test(orderPts[n - 1].name) ? 0.05 : 0);
    terminal = clamp(terminal);
    const rel = Math.min(1, (side.right + side.left) / 10);
    const orient = clamp(Math.abs(diag.orientTotal) / 1.5) * (diag.orientTotal >= 0 ? 1 : 0.3);
    Object.assign(diag, { pathRatio: +pathRatio.toFixed(2), carRatio: +carRatio.toFixed(2), jumps, terminal: +terminal.toFixed(2), sideRel: +rel.toFixed(2), startMatch: startM, endMatch: endM, km: +(dist / 1000).toFixed(1) });
    return { ...out, stops: orderPts.map((p) => p.code), legSec, method, shape: simplifyShape(geometry), diag,
      parts: { terminal, orient, pathRatio, carRatio, jumps, osrm: true } };
  } catch (e) {
    log(`  OSRM failed for ${rt.code}: ${e.message}; offline fallback`);
    diag.flags.push('osrm-failed');
    // Offline: NN + 2-opt with fixed ends (orientation from the name guess)
    const o = nnTwoOpt(pts, f, l);
    const legSec = o.slice(1).map((i, k) => legSecFromDistance(haversine(pts[o[k]], pts[i])));
    const orderPts = o.map((i) => pts[i]);
    const startM = terminalMatches(items, index, orderPts[0], 'start'), endM = terminalMatches(items, index, orderPts[n - 1], 'end');
    const terminal = clamp(0.25 + 0.35 * startM + 0.35 * endM);
    Object.assign(diag, { terminal, jumps: orderPts.slice(1).filter((p, i) => haversine(orderPts[i], p) > K.JUMP_M).length, km: +(pathLength(pts, o) * K.ROAD_FACTOR / 1000).toFixed(1) });
    return { ...out, stops: orderPts.map((p) => p.code), legSec, method: 'offline-2opt', shape: simplifyShape(orderPts.map((p) => [p.lng, p.lat])), diag,
      parts: { terminal, orient: clamp(Math.abs(ev0.e) * ev0.w), pathRatio: 1, carRatio: 1.3, jumps: diag.jumps, osrm: false } };
  }
}

// ---------------------------------------------------------------- consistency between routes
// For every route: agreement of its stop order with (a) routes sharing >= 5 stop codes (same direction expected),
// (b) the opposite-direction route found by proximity (reversed order expected). Returns Map(code -> {value, notes}).
export function consistency(routes, stopByCode, near = 120) {
  const pos = new Map(routes.map((r) => [r.code, new Map(r.stops.map((c, i) => [c, i]))]));
  const res = new Map();
  const school = (r) => /σχολικ/.test(searchKey(r.name));
  const mirrored = (a, b) => school(a) && school(b) && /μεταβασ/.test(searchKey(a.name)) !== /μεταβασ/.test(searchKey(b.name));
  for (const r of routes) {
    const notes = [];
    let num = 0, den = 0, best = null;
    for (const p of routes) {
      if (p === r) continue;
      const shared = r.stops.filter((c) => pos.get(p.code).has(c));
      if (shared.length >= 5) {
        const tau = kendallTau(shared.map((c) => pos.get(r.code).get(c)), shared.map((c) => pos.get(p.code).get(c)));
        const a = mirrored(r, p) ? (1 - tau) / 2 : (1 + tau) / 2;
        const w = Math.min(shared.length, 20);
        num += a * w; den += w;
        if (a < 0.3) notes.push(`vs ${p.code} (shared ${shared.length}, tau ${tau.toFixed(2)})`);
      } else if (shared.length < 3) {
        // opposite-direction candidate: nearest stop of p within `near` metres for as many stops of r as possible
        const pairs = [];
        r.stops.forEach((c, i) => {
          const a = stopByCode.get(c);
          let bj = -1, bd = near;
          p.stops.forEach((d, j) => { const dd = haversine(a, stopByCode.get(d)); if (dd < bd) { bd = dd; bj = j; } });
          if (bj >= 0) pairs.push([i, bj]);
        });
        if (pairs.length >= 6 && (!best || pairs.length > best.pairs.length)) best = { p, pairs };
      }
    }
    if (best && best.pairs.length >= Math.min(8, 0.3 * r.stops.length)) {
      const tau = kendallTau(best.pairs.map((x) => x[0]), best.pairs.map((x) => x[1]));
      const a = (1 - tau) / 2, w = Math.min(best.pairs.length, 20);
      num += a * w; den += w;
      if (a < 0.3) notes.push(`opposite ${best.p.code} not reversed (tau ${tau.toFixed(2)}, ${best.pairs.length} pairs)`);
      else notes.push(`opposite ${best.p.code} ok (${best.pairs.length} pairs)`);
    }
    res.set(r.code, { value: den ? num / den : null, notes });
  }
  return res;
}

// ---------------------------------------------------------------- main
export async function loadInputs() {
  const rawStops = JSON.parse(await readFile(new URL('stops.json', DATA), 'utf8'));
  const rawLines = JSON.parse(await readFile(new URL('lines.json', DATA), 'utf8'));
  const stops = rawStops.map((s) => ({ code: String(s.code), name: s.name, lat: s.latitude, lng: s.longitude, routeCodes: s.routeCodes.map(String) }));
  const routes = rawLines.flatMap((l) => l.routes.map((r) => ({ code: String(r.code), lineCode: String(l.code), name: r.name, direction: r.direction })));
  return { stops, routes };
}

async function atomicWrite(url, text) {
  const tmp = new URL(url.href + '.tmp');
  await writeFile(tmp, text);
  for (let i = 0; ; i++) {
    try { await rename(tmp, url); return; } catch (e) { if (i >= 5) { await unlink(tmp).catch(() => {}); throw e; } await sleep(200); }
  }
}

export async function main(argv = process.argv.slice(2)) {
  const cityArg = (argv.find((a) => a.startsWith('--city=')) || '').slice(7) || DEFAULT_CITY;
  if (!setActiveCity(cityArg)) throw new Error(`unknown city: ${cityArg}`);
  DATA = dataUrl();
  K.CENTER = city().center;
  const opt = { offline: argv.includes('--offline'), write: argv.includes('--write'), dry: argv.includes('--dry'), quiet: argv.includes('--quiet'),
    only: (argv.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean) };
  const log = opt.quiet ? () => {} : (m) => console.log(m);
  const { stops, routes } = await loadInputs();
  const stopsOf = new Map();
  for (const s of stops) for (const rc of s.routeCodes) (stopsOf.get(rc) || stopsOf.set(rc, []).get(rc)).push(s);
  const stopByCode = new Map(stops.map((s) => [s.code, s]));
  const index = buildNameIndex(stops);
  const osrm = createOsrm({ offline: opt.offline, log });
  const todo = routes.filter((r) => !opt.only.length || opt.only.includes(r.code));

  const results = [];
  for (const rt of todo) {
    const pts = (stopsOf.get(rt.code) || []).slice().sort(sortByCode);
    log(`[${results.length + 1}/${todo.length}] ${rt.code} ${rt.name} (${pts.length} stops)`);
    results.push(await processRoute(rt, pts, { index, osrm, log }));
  }

  const cons = consistency(results, stopByCode);
  for (const r of results) {
    const c = cons.get(r.code);
    r.diag.consistency = c.value == null ? null : +c.value.toFixed(2);
    r.diag.consNotes = c.notes;
    r.confidence = r.stops.length < 2 ? 0 : computeConfidence({ ...r.parts, consistency: c.value });
    const min = r.legSec.reduce((a, b) => a + b, 0) / 60;
    r.diag.minutes = Math.round(min);
    const kmh = r.diag.km && min ? (r.diag.km / (min / 60)) : null;
    if (kmh && (kmh < 6 || kmh > 40)) r.diag.flags.push(`speed ${kmh.toFixed(0)} km/h`);
    if (r.diag.jumps) r.diag.flags.push(`${r.diag.jumps} jump(s) >${K.JUMP_M} m`);
    if (min > 90 || (min < 2 && r.stops.length > 4)) r.diag.flags.push(`total ${Math.round(min)} min`);
    if (r.diag.pathRatio > 1.5) r.diag.flags.push(`order ratio ${r.diag.pathRatio}`);
    if (r.diag.carRatio > 2.5) r.diag.flags.push(`detour ${r.diag.carRatio}`);
    if (c.value != null && c.value < 0.35) r.diag.flags.push('inconsistent with siblings');
    if (r.diag.snapMax > 80) r.diag.flags.push(`snap ${r.diag.snapMax} m`);
  }

  // summary
  log('\nroute  line n   method              conf  min   km  side(R/L)  flags');
  for (const r of results.slice().sort((a, b) => (a.lineCode + a.code).localeCompare(b.lineCode + b.code))) {
    const d = r.diag;
    log(`${r.code.padEnd(6)} ${r.lineCode} ${String(r.stops.length).padStart(3)} ${r.method.padEnd(19)} ${r.confidence.toFixed(2)} ${String(d.minutes).padStart(4)} ${String(d.km ?? '').padStart(5)}  ${d.side ? `${d.side.right}/${d.side.left}` : '-'}`.padEnd(75) + ` ${d.flags.join('; ')}`);
  }
  log(`\nOSRM requests: ${osrm.stats.network} network, ${osrm.stats.cached} cached`);

  const write = !opt.dry && (!opt.only.length || opt.write) && results.length > 0;
  const generatedAt = new Date().toISOString();
  const routesJson = { version: 1, generatedAt, routes: {} };
  const shapes = {};
  for (const r of results) {
    routesJson.routes[r.code] = { code: r.code, lineCode: r.lineCode, name: r.name, direction: r.direction, stops: r.stops, legSec: r.legSec, confidence: r.confidence, method: r.method };
    if (r.shape.length) shapes[r.code] = r.shape;
  }
  await mkdir(new URL('./.cache/', import.meta.url), { recursive: true });
  await writeFile(new URL(`./.cache/route-diag${city().id === DEFAULT_CITY ? '' : `-${city().id}`}.json`, import.meta.url), JSON.stringify(Object.fromEntries(results.map((r) => [r.code, { ...r.diag, confidence: r.confidence, method: r.method }])), null, 1));
  if (write) {
    await atomicWrite(new URL('shapes.json', DATA), JSON.stringify(shapes));
    await atomicWrite(new URL('routes.json', DATA), JSON.stringify(routesJson));
    log(`wrote routes.json (${Object.keys(routesJson.routes).length} routes) and shapes.json`);
  } else log('dry run: nothing written (--only needs --write)');
  return { results, osrm: osrm.stats };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
