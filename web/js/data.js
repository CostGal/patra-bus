// Static data loader (owner: data). Basic version; see docs/ARCHITECTURE.md.
import { titleCase, searchKey } from './text.js';
const getJSON = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); };
export async function loadData() {
  const [rawStops, rawLines, rawRoutes] = await Promise.all([
    getJSON('./data/stops.json'), getJSON('./data/lines.json'), getJSON('./data/routes.json').catch(() => ({ routes: {} })),
  ]);
  const stops = rawStops.map((s) => ({ code: String(s.code), name: s.name, displayName: titleCase(s.name), lat: s.latitude, lng: s.longitude,
    lineCodes: s.lineCodes.map(String), routeCodes: s.routeCodes.map(String), key: searchKey(s.name) }));
  const lines = rawLines.map((l) => ({ code: String(l.code), name: l.name, displayName: titleCase(l.name), color: l.color, textColor: l.textColor,
    routes: l.routes.map((r) => ({ code: String(r.code), name: r.name, direction: r.direction })) }));
  const routes = Object.values(rawRoutes.routes || {}).map((r) => ({ ...r, displayName: titleCase(r.name), pos: new Map(r.stops.map((c, i) => [c, i])) }));
  const stopByCode = new Map(stops.map((s) => [s.code, s]));
  const lineByCode = new Map(lines.map((l) => [l.code, l]));
  const routeByCode = new Map(routes.map((r) => [r.code, r]));
  const routesByStop = new Map();
  for (const r of routes) for (const c of r.stops) (routesByStop.get(c) || routesByStop.set(c, []).get(c)).push(r);
  return { stops, lines, routes, stopByCode, lineByCode, routeByCode, routesByStop };
}
export async function loadShapes() { try { return await getJSON('./data/shapes.json'); } catch { return {}; } }
export function searchStops(data, q, limit = 20) {
  const k = searchKey(q); if (!k) return [];
  return data.stops.filter((s) => s.key.includes(k) || s.code.startsWith(q.trim())).slice(0, limit);
}
