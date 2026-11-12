// Destination search (owner: geocode): local stops first, then Photon (OSM geocoder, no key).
// Place = { kind: 'stop'|'place', name, subtitle, lat, lng, stopCode? }
import { loadData, searchStops } from './data.js';
import { t } from './i18n.js';
import { searchKey } from './text.js';
import { haversine, inArea } from './geo.js';
import { city } from './cities.js';

const PHOTON = 'https://photon.komoot.io/api/';
const photonBbox = ({ west, south, east, north }) => `${west},${south},${east},${north}`; // minLon,minLat,maxLon,maxLat
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
  const ref = near || city().center;
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

// House number in the user's own query, to tell an exact address match from a street/nearby-POI fallback
// (Greek housenumber coverage in OSM is patchy). A house-number token is 1–4 digits with at most one letter
// after ("10", "335Α", "12b"), or a range of them ("37-41" → 37). "25ης" (ordinal) and "26221" (postcode)
// are not. The last such token wins ("25ης Μαρτίου 10" → "10"); a query that is only a number (a stop code)
// has none.
const HOUSE_TOKEN = /^(\d{1,4})\p{L}?(?:-\d{1,4}\p{L}?)?$/u;
const tokens = (q) => String(q || '').split(/[\s,]+/).filter(Boolean);
function houseToken(q) {
  const toks = tokens(q);
  for (let i = toks.length - 1; i >= 0; i--) {
    const m = HOUSE_TOKEN.exec(toks[i]);
    if (m) return toks.some((t, j) => j !== i && /\p{L}/u.test(t)) ? { i, num: m[1] } : null;
  }
  return null;
}
export const queryNumber = (q) => houseToken(q)?.num ?? null;
// The query without its house-number token ("Κορίνθου 121" → "Κορίνθου").
export function stripNumber(q) {
  const h = houseToken(q);
  const toks = tokens(q);
  return (h ? toks.filter((_, j) => j !== h.i) : toks).join(' ');
}

// Does an OSM housenumber ("37", "37-41", "37Α", "35,37") cover the number the user typed? Compared as
// integers: these are house numbers, not stop/line codes.
export function numberMatches(housenumber, qNum) {
  const n = parseInt(qNum, 10);
  if (housenumber == null || !Number.isFinite(n)) return false;
  return String(housenumber).split(/[,;/]/).some((part) => {
    const s = part.trim();
    const range = /^(\d+)\s*-\s*(\d+)/.exec(s);
    if (range) return +range[1] <= n && n <= +range[2];
    const lead = /^\d+/.exec(s);
    return !!lead && parseInt(lead[0], 10) === n;
  });
}

// Latin → Greek letters for the Photon request only ("Korinthou" → "κορινθου"). Photon tolerates missing
// accents, so none are added. The result is never shown and never becomes a place's name or subtitle: those
// come from Photon's answer. Accents on screen come only from web/js/accents.js (CLAUDE.md, "Names").
// null when the text has a Greek letter or no Latin letter.
const LATIN_PAIRS = { th: 'θ', ch: 'χ', ps: 'ψ', ks: 'ξ', ou: 'ου', mp: 'μπ', nt: 'ντ', gk: 'γκ', ts: 'τσ', tz: 'τζ' };
const STRONG = new Set(['th', 'ch', 'ps', 'ks']);
const LATIN_ONE = {
  a: 'α', b: 'β', c: 'κ', d: 'δ', e: 'ε', f: 'φ', g: 'γ', h: 'η', i: 'ι', j: 'τζ', k: 'κ', l: 'λ', m: 'μ',
  n: 'ν', o: 'ο', p: 'π', q: 'κ', r: 'ρ', s: 'σ', t: 'τ', u: 'υ', v: 'β', w: 'ω', x: 'ξ', y: 'υ', z: 'ζ',
};
export function latinToGreek(s) {
  s = String(s || '');
  if (/[Ͱ-Ͽἀ-῿]/.test(s) || !/[a-z]/i.test(s)) return null;
  const low = s.toLowerCase();
  let out = '';
  for (let i = 0; i < low.length; ) {
    const pair = low.slice(i, i + 2);
    // th/ch/ps/ks win over an overlapping pair: "Korinthou" is κορι-ν-θου, not κορι-ντ-ηου.
    const yields = !STRONG.has(pair) && STRONG.has(low.slice(i + 1, i + 3));
    const two = !yields && LATIN_PAIRS[pair];
    if (two) { out += two; i += 2; continue; }
    out += LATIN_ONE[low[i]] ?? low[i];
    i += 1;
  }
  return out.replace(/σ(?![\p{L}])/gu, 'ς');
}

// Photon GeoJSON feature → Place (null when unusable or outside the active city's area).
// `queryNumber`: when given and the feature's housenumber does not match it, the place is flagged
// `approx: true` — a street-level or nearby-POI result standing in for an exact address (never silent).
// `approx: true` forces the flag (the street fallback of photon()).
export function mapPhoton(f, { queryNumber: qNum = null, approx: forceApprox = false } = {}) {
  const p = f?.properties || {};
  const [lng, lat] = f?.geometry?.coordinates || [];
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !inArea({ lat, lng })) return null;
  const street = [p.street, p.housenumber].filter(Boolean).join(' ');
  const name = p.name || street;
  if (!name) return null;
  const area = p.locality || cleanArea(p.city) || cleanArea(p.district);
  const parts = [p.name ? street : '', area].filter((x) => x && x !== name);
  const approx = forceApprox || (!!qNum && !numberMatches(p.housenumber, qNum));
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

// Street fallback: one place for a street whose house number OSM lacks. Photon returns a street as several
// segments with the same name; take the group of its best match and the segment nearest the group's average
// point (the middle of the street). No street among them → the first usable feature. Always `approx: true`.
export function streetPlace(features) {
  const ok = (features || []).filter((f) => mapPhoton(f));
  if (!ok.length) return [];
  const roads = ok.filter((f) => f.properties?.osm_key === 'highway' && f.properties?.name);
  let pick = ok[0];
  if (roads.length) {
    const k = searchKey(roads[0].properties.name);
    const group = roads.filter((f) => searchKey(f.properties.name) === k);
    const pt = (f) => ({ lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] });
    const mid = group.reduce((a, f) => ({ lat: a.lat + pt(f).lat / group.length, lng: a.lng + pt(f).lng / group.length }), { lat: 0, lng: 0 });
    pick = group.reduce((a, b) => (haversine(mid, pt(b)) < haversine(mid, pt(a)) ? b : a));
  }
  return [mapPhoton(pick, { approx: true })];
}

// One Photon request → its raw features (cached per text and coarse position, so "Κορίνθου 5" and
// "Κορίνθου 7" share the street request).
async function fetchFeatures(text, ref, signal) {
  const key = `${searchKey(text)}|${ref.lat.toFixed(2)},${ref.lng.toFixed(2)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.features;
  const url = new URL(PHOTON);
  url.searchParams.set('q', text);
  url.searchParams.set('lat', ref.lat.toFixed(2)); // coarse bias only: ~1 km is enough, keeps the position vague
  url.searchParams.set('lon', ref.lng.toFixed(2));
  url.searchParams.set('limit', '8');
  url.searchParams.set('bbox', photonBbox(city().bbox));
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  if (signal?.aborted) throw abortError();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const features = j.features || [];
    cache.set(key, { at: Date.now(), features });
    if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
    return features;
  } catch (e) {
    if (signal?.aborted) throw abortError();
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

// At most two requests per search. The second runs only when the first gave no usable place:
//   Greek + number  → as typed, then the street without the number (street mode)
//   Latin + number  → in Greek letters, then that without the number (street mode)
//   Latin, no number → as typed (keeps "Lidl", "Jumbo"), then in Greek letters
//   Greek, no number → as typed only
async function photon(q, near, signal) {
  const ref = near || city().center;
  const qNum = queryNumber(q);
  const greek = latinToGreek(q);
  const normal = (features) => features.map((f) => mapPhoton(f, { queryNumber: qNum })).filter(Boolean);
  const first = qNum && greek ? greek : q;
  const places = normal(await fetchFeatures(first, ref, signal));
  if (places.length) return places;
  if (qNum) return streetPlace(await fetchFeatures(stripNumber(first), ref, signal));
  if (greek) return normal(await fetchFeatures(greek, ref, signal));
  return places;
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
