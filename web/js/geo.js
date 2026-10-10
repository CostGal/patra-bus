// Geometry helpers (owner: location). Pure functions, no DOM; also imported by node tests.
const RAD = Math.PI / 180;
const EARTH_R = 6371000;
const M_PER_DEG = 111320; // metres per degree of latitude (good enough at city scale)

export const PATRAS_BBOX = { minLat: 38.13, maxLat: 38.33, minLng: 21.60, maxLng: 21.90 };
export const inArea = (p) => !!p && p.lat >= PATRAS_BBOX.minLat && p.lat <= PATRAS_BBOX.maxLat && p.lng >= PATRAS_BBOX.minLng && p.lng <= PATRAS_BBOX.maxLng;

export function haversine(a, b) {
  const dLat = (b.lat - a.lat) * RAD, dLng = (b.lng - a.lng) * RAD;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(x)));
}

// Initial bearing a → b in degrees clockwise from north, [0, 360).
export function bearing(a, b) {
  const y = Math.sin((b.lng - a.lng) * RAD) * Math.cos(b.lat * RAD);
  const x = Math.cos(a.lat * RAD) * Math.sin(b.lat * RAD) - Math.sin(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.cos((b.lng - a.lng) * RAD);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

export function fmtDist(m) {
  if (!Number.isFinite(m)) return '—';
  return m < 1000 ? `${Math.round(m / 10) * 10} μ` : `${(m / 1000).toFixed(1).replace('.', ',')} χλμ`;
}

// ---- angles ----
export const normDeg = (d) => ((d % 360) + 360) % 360;
// Signed shortest rotation from a to b in (-180, 180].
export function angleDiff(a, b) {
  const d = normDeg(b - a);
  return d > 180 ? d - 360 : d;
}
// Move angle a towards b by fraction k, going the short way round (359 → 1 passes through 0).
export const lerpAngle = (a, b, k) => normDeg(a + angleDiff(a, b) * k);

// ---- small-scale projections ----
// Degree deltas for a metric offset at p (east/north in metres). dLng grows with latitude.
export function metersToLatLngDelta(p, eastM, northM) {
  return { dLat: northM / M_PER_DEG, dLng: eastM / (M_PER_DEG * Math.max(0.01, Math.cos(p.lat * RAD))) };
}
export function offsetPoint(p, eastM, northM) {
  const { dLat, dLng } = metersToLatLngDelta(p, eastM, northM);
  return { lat: p.lat + dLat, lng: p.lng + dLng };
}
// Point `meters` away from p on the given bearing (flat approximation, fine below a few km).
export function destinationPoint(p, bearingDeg, meters) {
  const t = bearingDeg * RAD;
  return offsetPoint(p, Math.sin(t) * meters, Math.cos(t) * meters);
}
// Linear interpolation between two nearby points, t in [0, 1].
export const pointAlong = (a, b, t) => ({ lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t });

// ---- polylines: coordinates as GeoJSON [lng, lat] pairs ----
export function pathLength(coords) {
  let m = 0;
  for (let i = 1; i < coords.length; i++) m += haversine({ lat: coords[i - 1][1], lng: coords[i - 1][0] }, { lat: coords[i][1], lng: coords[i][0] });
  return m;
}
// Closest point of the path to p: { meters, index (segment start), t (0..1 within segment), point }.
export function closestOnPath(coords, p) {
  if (!coords?.length) return null;
  const kx = M_PER_DEG * Math.cos(p.lat * RAD), ky = M_PER_DEG;
  let best = null;
  for (let i = 0; i < Math.max(1, coords.length - 1); i++) {
    const a = coords[i], b = coords[Math.min(i + 1, coords.length - 1)];
    const ax = (a[0] - p.lng) * kx, ay = (a[1] - p.lat) * ky, bx = (b[0] - p.lng) * kx, by = (b[1] - p.lat) * ky;
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    const d = Math.hypot(ax + dx * t, ay + dy * t);
    if (!best || d < best.meters) best = { meters: d, index: i, t, point: { lat: a[1] + (b[1] - a[1]) * t, lng: a[0] + (b[0] - a[0]) * t } };
  }
  return best;
}

// ---- nearest stops: uniform grid index, cached per stops array ----
const CELL_M = 250;
const MAX_RING = 40; // 10 km; beyond that fall back to a linear scan
const indexes = new WeakMap();
const cellKey = (i, j) => (i + 1048576) * 2097152 + (j + 1048576);

function buildIndex(stops) {
  let latSum = 0, n = 0, maxAbsLat = 0;
  for (const s of stops) if (Number.isFinite(s.lat) && Number.isFinite(s.lng)) { latSum += s.lat; n++; maxAbsLat = Math.max(maxAbsLat, Math.abs(s.lat)); }
  const lat0 = n ? latSum / n : 0;
  const dLat = CELL_M / M_PER_DEG, dLng = CELL_M / (M_PER_DEG * Math.max(0.01, Math.cos(lat0 * RAD)));
  const cells = new Map();
  for (const s of stops) {
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lng)) continue;
    const k = cellKey(Math.floor(s.lat / dLat), Math.floor(s.lng / dLng));
    const c = cells.get(k);
    if (c) c.push(s); else cells.set(k, [s]);
  }
  return { size: stops.length, cells, dLat, dLng, maxAbsLat };
}
function getIndex(stops) {
  let idx = indexes.get(stops);
  if (!idx || idx.size !== stops.length) { idx = buildIndex(stops); indexes.set(stops, idx); }
  return idx;
}

// stops: [{lat, lng, ...}]. Returns [{stop, meters}] sorted by distance, at most `limit`, within `maxMeters`.
export function nearestStops(stops, p, { limit = 10, maxMeters = Infinity } = {}) {
  if (!stops?.length || !p || !Number.isFinite(p.lat) || !Number.isFinite(p.lng) || limit <= 0) return [];
  const idx = getIndex(stops);
  // Unseen stops after ring r are at least r cells away; cellMin is the narrowest cell edge in metres.
  const cellMin = Math.min(CELL_M, idx.dLng * M_PER_DEG * Math.cos(Math.max(idx.maxAbsLat, Math.abs(p.lat)) * RAD));
  const ci = Math.floor(p.lat / idx.dLat), cj = Math.floor(p.lng / idx.dLng);
  const maxR = Number.isFinite(maxMeters) ? Math.min(MAX_RING, Math.ceil(maxMeters / cellMin) + 1) : MAX_RING;
  const out = [];
  const visit = (i, j) => {
    const c = idx.cells.get(cellKey(i, j));
    if (!c) return;
    for (const stop of c) { const meters = haversine(p, stop); if (meters <= maxMeters) out.push({ stop, meters }); }
  };
  let r = 0, done = false;
  for (; r <= maxR; r++) {
    if (r === 0) visit(ci, cj);
    else {
      for (let d = -r; d <= r; d++) { visit(ci + d, cj - r); visit(ci + d, cj + r); }
      for (let d = -r + 1; d <= r - 1; d++) { visit(ci - r, cj + d); visit(ci + r, cj + d); }
    }
    const safe = r * cellMin;
    if (safe >= maxMeters) { done = true; break; }
    if (out.length >= limit) {
      out.sort((a, b) => a.meters - b.meters);
      if (out[limit - 1].meters <= safe) { done = true; break; }
    }
  }
  if (!done) {
    // Ring cap reached without a proof of completeness (p far from the stops): linear scan.
    out.length = 0;
    for (const s of stops) if (Number.isFinite(s.lat) && Number.isFinite(s.lng)) { const meters = haversine(p, s); if (meters <= maxMeters) out.push({ stop: s, meters }); }
  }
  out.sort((a, b) => a.meters - b.meters);
  return out.slice(0, limit);
}
