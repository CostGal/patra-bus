// Destination search (owner: planner): local stops first, then Photon (OSM geocoder, no key).
// Place = { kind: 'stop'|'place', name, subtitle, lat, lng, stopCode? }
import { loadData, searchStops } from './data.js';
import { t } from './i18n.js';
import { searchKey } from './text.js';
import { haversine, inArea } from './geo.js';

const PHOTON = 'https://photon.komoot.io/api/';
const BBOX = '21.60,38.13,21.90,38.33'; // minLon,minLat,maxLon,maxLat (Patras)
const CENTER = { lat: 38.2466, lng: 21.7346 };
const TTL_MS = 10 * 60 * 1000;
const MAX_CACHE = 40;
const TIMEOUT_MS = 6000;

const cache = new Map(); // key → { at, places }
let dataP = null;
const getData = () => (dataP ||= loadData().catch((e) => { dataP = null; throw e; }));
const isAbort = (e) => e?.name === 'AbortError';
const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });

// "Δημοτική Ενότητα Πατρέων" → "Πατρέων"; "4η Κοινότητα Πατρών - Κεντρικός Τομέας" → "Πατρών - Κεντρικός Τομέας"
const cleanArea = (s) => String(s || '').replace(/^Δημοτική Ενότητα\s+/u, '').replace(/^\d+\S*\s+Κοινότητα\s+/u, '').trim();

// Stops grouped by name (both sides of a road are one place), nearest side wins. Synchronous, so the UI can
// show them instantly while Photon is still loading.
export function stopPlaces(data, q, { near, limit = 4 } = {}) {
  const k = searchKey(q);
  const groups = new Map();
  for (const s of searchStops(data, q, 40)) {
    const g = groups.get(s.key) || groups.set(s.key, { stops: [], lines: new Set() }).get(s.key);
    g.stops.push(s);
    s.lineCodes.forEach((c) => g.lines.add(c));
  }
  const ref = near || CENTER;
  const places = [...groups.entries()].map(([key, g]) => {
    const stop = g.stops.reduce((a, b) => (haversine(ref, b) < haversine(ref, a) ? b : a));
    const lines = [...g.lines].sort((a, b) => a.localeCompare(b, 'el', { numeric: true }));
    const shown = lines.slice(0, 5).join(' · ') + (lines.length > 5 ? ' …' : '');
    return {
      place: { kind: 'stop', name: stop.displayName, subtitle: t('Στάση {code}', { code: stop.code }) + (shown ? ` · ${shown}` : ''), lat: stop.lat, lng: stop.lng, stopCode: stop.code },
      prefix: key.startsWith(k) || stop.code === q.trim() ? 0 : 1, dist: haversine(ref, stop),
    };
  });
  places.sort((a, b) => a.prefix - b.prefix || a.dist - b.dist);
  return places.slice(0, limit).map((x) => x.place);
}

// A housenumber-looking token in the user's own query ("Κορίνθου 121" -> "121"), to tell an exact
// address match from a street/nearby-POI fallback (Greek housenumber coverage in OSM is patchy).
const queryNumber = (q) => (String(q || '').match(/\d+/) || [])[0] || null;

// Photon GeoJSON feature → Place (null when unusable or outside the Patras area).
// `queryNumber`: when given and the feature's housenumber does not match it, the place is flagged
// `approx: true` — a street-level or nearby-POI result standing in for an exact address (never silent).
export function mapPhoton(f, { queryNumber: qNum = null } = {}) {
  const p = f?.properties || {};
  const [lng, lat] = f?.geometry?.coordinates || [];
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !inArea({ lat, lng })) return null;
  const street = [p.street, p.housenumber].filter(Boolean).join(' ');
  const name = p.name || street;
  if (!name) return null;
  const area = p.locality || cleanArea(p.city) || cleanArea(p.district);
  const parts = [p.name ? street : '', area].filter((x) => x && x !== name);
  const approx = !!qNum && p.housenumber !== qNum;
  return { kind: 'place', name, subtitle: [...new Set(parts)].join(' · '), lat, lng, ...(approx ? { approx: true } : {}) };
}

// Drop remote places that duplicate a local one (same name nearby, or practically the same spot).
export function mergePlaces(local, remote) {
  const out = [...local];
  for (const r of remote) {
    const rk = searchKey(r.name);
    const dup = out.some((p) => {
      const d = haversine(p, r);
      return d < 15 || (d < 400 && searchKey(p.name) === rk);
    });
    if (!dup) out.push(r);
  }
  return out;
}

async function photon(q, near, signal) {
  const ref = near || CENTER;
  const key = `${searchKey(q)}|${ref.lat.toFixed(2)},${ref.lng.toFixed(2)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.places;
  const url = new URL(PHOTON);
  url.searchParams.set('q', q);
  url.searchParams.set('lat', ref.lat.toFixed(2)); // coarse bias only: ~1 km is enough, keeps the position vague
  url.searchParams.set('lon', ref.lng.toFixed(2));
  url.searchParams.set('limit', '8');
  url.searchParams.set('bbox', BBOX);
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  if (signal?.aborted) throw abortError();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const qNum = queryNumber(q);
    const places = (j.features || []).map((f) => mapPhoton(f, { queryNumber: qNum })).filter(Boolean);
    cache.set(key, { at: Date.now(), places });
    if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
    return places;
  } catch (e) {
    if (signal?.aborted) throw abortError();
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

// Abortable. Rejects with AbortError only when `signal` aborts; network trouble just yields local results
// (the returned array has `.offline = true` so the UI can say so).
export async function searchPlaces(q, { near, signal, data, limit = 8 } = {}) {
  q = String(q || '').trim();
  if (q.length < 2) return [];
  const d = data || (await getData().catch(() => null));
  if (signal?.aborted) throw abortError();
  const local = d ? stopPlaces(d, q, { near, limit: 4 }) : [];
  let remote = [], offline = false;
  if (q.length >= 3) {
    try { remote = await photon(q, near, signal); } catch (e) { if (isAbort(e)) throw e; offline = true; }
  }
  const places = mergePlaces(local, remote).slice(0, limit);
  places.offline = offline;
  return places;
}
