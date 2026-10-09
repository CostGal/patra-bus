// Geometry helpers (owner: location). Basic versions; see docs/ARCHITECTURE.md.
export const PATRAS_BBOX = { minLat: 38.13, maxLat: 38.33, minLng: 21.60, maxLng: 21.90 };
export const inArea = (p) => p && p.lat >= PATRAS_BBOX.minLat && p.lat <= PATRAS_BBOX.maxLat && p.lng >= PATRAS_BBOX.minLng && p.lng <= PATRAS_BBOX.maxLng;
export function haversine(a, b) {
  const rad = Math.PI / 180, dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(x));
}
export function bearing(a, b) {
  const rad = Math.PI / 180, y = Math.sin((b.lng - a.lng) * rad) * Math.cos(b.lat * rad);
  const x = Math.cos(a.lat * rad) * Math.sin(b.lat * rad) - Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((b.lng - a.lng) * rad);
  return (Math.atan2(y, x) / rad + 360) % 360;
}
export const fmtDist = (m) => (m < 1000 ? `${Math.round(m / 10) * 10} μ` : `${(m / 1000).toFixed(1).replace('.', ',')} χλμ`);
export function nearestStops(stops, p, { limit = 10, maxMeters = Infinity } = {}) {
  return stops.map((stop) => ({ stop, meters: haversine(p, stop) })).filter((x) => x.meters <= maxMeters)
    .sort((a, b) => a.meters - b.meters).slice(0, limit);
}
