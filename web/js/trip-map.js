// The chosen trip on the map (TEL-295): walking dotted, the bus ride in the line's colour, where you board and get off.
// tripFeatures() is pure (tests); drawTrip() / clearTrip() hand its result to the map API of js/map.js.
// Sends nothing: walk geometry comes with the itinerary (OSRM already answered, js/walk.js), shapes.json is our own file.
import { loadShapes } from './data.js';

const MIN_WALK_M = 25; // a shorter walk is not drawn

// ---------------------------------------------------------------- ride geometry (from js/planner.js, before 584c7e2)

const KM_LNG = (lat) => Math.cos((lat * Math.PI) / 180);

// Snap an ordered stop list onto a route polyline so that vertex indexes never decrease
// (dynamic programming; robust for routes that run out and back along the same road).
export function snapStopsToShape(stopsLL, shape) {
  const S = stopsLL.length, V = shape.length;
  if (!S || V < 2) return null;
  const k = KM_LNG(shape[0][1]);
  const d = (s, v) => Math.hypot((s.lng - shape[v][0]) * k, s.lat - shape[v][1]);
  const back = Array.from({ length: S }, () => new Int32Array(V));
  let prev = new Float64Array(V);
  for (let v = 0; v < V; v++) prev[v] = d(stopsLL[0], v);
  for (let s = 1; s < S; s++) {
    const cur = new Float64Array(V);
    let bestU = 0, bestVal = Infinity;
    for (let v = 0; v < V; v++) {
      if (prev[v] < bestVal) { bestVal = prev[v]; bestU = v; }
      back[s][v] = bestU;
      cur[v] = bestVal + d(stopsLL[s], v);
    }
    prev = cur;
  }
  let v = 0;
  for (let i = 1; i < V; i++) if (prev[i] < prev[v]) v = i;
  const idx = new Array(S);
  for (let s = S - 1; s >= 0; s--) { idx[s] = v; if (s) v = back[s][v]; }
  return idx;
}

// [lng,lat][] for the ride between route positions bi..ai; stop coordinates cap both ends.
// Falls back to straight lines through the ordered stops when no shape (or snapping) is available.
export function rideGeometry(route, stopByCode, shape, bi, ai, snapped = null) {
  const pts = route.stops.slice(bi, ai + 1).map((c) => stopByCode.get(c)).filter(Boolean).map((s) => [s.lng, s.lat]);
  if (!shape || shape.length < 2 || pts.length < 2) return pts;
  const all = snapped || snapStopsToShape(route.stops.map((c) => stopByCode.get(c)).map((s) => s || { lat: shape[0][1], lng: shape[0][0] }), shape);
  if (!all || all[ai] <= all[bi]) return pts;
  const line = shape.slice(all[bi], all[ai] + 1);
  return [pts[0], ...line, pts[pts.length - 1]];
}

// ---------------------------------------------------------------- features of one itinerary

const okLL = (c) => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]) && !(c[0] === 0 && c[1] === 0);
const okPt = (p) => !!p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && !(p.lat === 0 && p.lng === 0);
const toLL = (p) => [p.lng, p.lat];
const lineFC = (coords) => ({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } }] });
const metersApprox = (a, b) => Math.hypot((a.lng - b.lng) * 111320 * KM_LNG(a.lat), (a.lat - b.lat) * 110540);

// data: { routeByCode, stopByCode, lineByCode, shapes? } → { overlays: [{ id, fc, style }], markers, points }
export function tripFeatures(it, { routeByCode, stopByCode, lineByCode, shapes } = {}) {
  const overlays = [], markers = [], points = [];
  const legs = it?.legs || [];
  const add = (coords, style) => {
    const c = (coords || []).filter(okLL);
    if (c.length < 2) return;
    overlays.push({ id: `trip-${overlays.length}`, fc: lineFC(c), style });
    for (const [lng, lat] of c) points.push({ lat, lng });
  };
  for (const leg of legs) {
    const a = leg.kind === 'bus' ? leg.board : leg.from;
    const b = leg.kind === 'bus' ? leg.alight : leg.to;
    for (const p of [a, b]) if (okPt(p)) points.push({ lat: p.lat, lng: p.lng });
    if (leg.kind === 'walk') {
      if (!okPt(a) || !okPt(b)) continue;
      const m = Number.isFinite(leg.meters) ? leg.meters : metersApprox(a, b);
      if (m < MIN_WALK_M) continue;
      add(leg.geometry?.length >= 2 ? leg.geometry : [toLL(a), toLL(b)], { kind: 'walk' });
    } else if (leg.kind === 'bus') {
      const color = lineByCode?.get(String(leg.lineCode))?.color;
      const style = { kind: 'ride', ...(color ? { color } : {}) };
      const route = routeByCode?.get(String(leg.routeCode));
      if (leg.orderEstimated || !route || !stopByCode) { // a stop order we are not sure of: one straight segment
        if (okPt(a) && okPt(b)) add([toLL(a), toLL(b)], leg.orderEstimated ? { ...style, estimated: true } : style);
      } else {
        add(rideGeometry(route, stopByCode, shapes?.[String(leg.routeCode)], leg.boardIndex, leg.alightIndex), style);
      }
      if (okPt(leg.board)) markers.push({ ...leg.board, kind: 'board', label: leg.board.displayName });
      if (okPt(leg.alight)) markers.push({ ...leg.alight, kind: 'alight', label: leg.alight.displayName });
    }
  }
  // a transfer at the same stop: one marker there, the board one
  const same = (m, n) => (m.code != null && m.code === n.code) || (m.lat === n.lat && m.lng === n.lng);
  const kept = markers.filter((m) => m.kind !== 'alight' || !markers.some((n) => n.kind === 'board' && same(m, n)));
  return { overlays, markers: kept, points };
}

// ---------------------------------------------------------------- drawing

let shapesP = null, shapesNow = null;
const shapes = () => (shapesP ||= loadShapes().catch(() => ({})).then((s) => (shapesNow = s || {})));
let drawn = []; // overlay ids on the map now
let gen = 0; // bumped by every draw and clear: a late shapes.json redraws only the trip it was asked for

function paint(map, it, data) {
  const f = tripFeatures(it, { ...data, shapes: shapesNow });
  const ids = f.overlays.map((o) => o.id);
  for (const id of drawn) if (!ids.includes(id)) map.clearOverlay(id);
  for (const o of f.overlays) map.setOverlay(o.id, o.fc, o.style);
  drawn = ids;
  map.setMarkers('trip', f.markers);
  return f;
}

// Draws the trip at once (stop to stop until shapes.json is in), then again with the shapes. Returns the points to fit.
export function drawTrip(map, it, data) {
  const mine = ++gen;
  const f = paint(map, it, data);
  if (!shapesNow) shapes().then(() => { if (gen === mine) paint(map, it, data); }).catch(() => {});
  return { points: f.points };
}

export function clearTrip(map) {
  gen++;
  for (const id of drawn) map.clearOverlay(id);
  drawn = [];
  map.clearMarkers('trip');
}
