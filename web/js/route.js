// Hash routing helpers (owner: shell). Pure and DOM-free (tests). Contract in docs/MULTI-CITY.md.
// A hash is `#/{view}/{arg}?{query}` with an optional city prefix: `#/corfu/stop/123`. Views and links work with
// city-relative hashes (`#/stop/123`); the prefix is added on the way out (cityHash/shareHash) and stripped on the way in.
// No prefix means Patras for hashes that point at something (a stop, a line, coordinates): old links keep working.
import { DEFAULT_CITY, cityId, isCity } from './cities.js';

const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

// '#/corfu/stop/12?x=1' -> { city: 'corfu', path: '/stop/12', query: 'x=1', parts: ['stop','12'], params: {x:'1'}, rel: '#/stop/12?x=1' }
// city is null when the hash has no (known) prefix. `#/patra/...` parses like any other prefix.
export function parseHash(hash) {
  const raw = String(hash ?? '').replace(/^#/, '');
  const q = raw.indexOf('?');
  const pathRaw = q < 0 ? raw : raw.slice(0, q);
  const query = q < 0 ? '' : raw.slice(q + 1);
  const segs = pathRaw.split('/').filter(Boolean);
  let city = null;
  if (segs.length && isCity(segs[0])) city = segs.shift();
  const path = `/${segs.join('/')}`;
  return {
    city, path, query,
    parts: segs.map(safeDecode),
    params: Object.fromEntries(new URLSearchParams(query)),
    rel: `#${path}${query ? `?${query}` : ''}`,
  };
}

// City-relative form of any hash (prefix stripped).
export const relHash = (hash) => parseHash(hash).rel;

// Hash for city `id`. The default city is written without prefix unless `always` (share links, reminders).
export function formatHash(hash, id = cityId(), { always = false } = {}) {
  const p = parseHash(hash);
  if (!isCity(id) || (id === DEFAULT_CITY && !always)) return p.rel;
  return `#/${id}${p.path === '/' ? '/' : p.path}${p.query ? `?${p.query}` : ''}`;
}

// For links, navigation and history.replaceState inside the active city.
export const cityHash = (hash) => formatHash(hash, cityId());
// For anything that leaves the page (share, notification, push): always carries the prefix.
export const shareHash = (hash) => formatHash(hash, cityId(), { always: true });

// Is the hash pointing at something city-specific (a code or coordinates)? Bare views (`#/`, `#/plan`, `#/lines`,
// `#/settings`, `#/favorites`) are not: they open in whatever city the user is in.
const cityBound = (p) => p.parts.length > 1 || p.query !== '';

// City to boot into: hash prefix, then an unprefixed link that points at something (= Patras), then the saved
// setting, then the default.
export function resolveBootCity(hash, savedCity) {
  const p = parseHash(hash);
  if (p.city) return p.city;
  if (cityBound(p)) return DEFAULT_CITY;
  return isCity(savedCity) ? savedCity : DEFAULT_CITY;
}
