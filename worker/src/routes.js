// URL routing for the read-only API (docs/MULTI-CITY.md, Contract). Pure: no env, no I/O.
// /api/{city}/live/:code | stops | lines | stats/:route/:stop, plus the un-prefixed Patras aliases
// (/api/live/:code, /api/stops, /api/lines, /api/stats/:route/:stop), kept indefinitely.
import { DEFAULT_CITY, isCity } from '../../web/js/cities.js';

const KINDS = { live: 1, stops: 0, lines: 0, stats: 2 }; // kind -> number of path arguments
const LIVE_CODE = /^\d{1,6}$/;

// -> { city, kind: 'live'|'stops'|'lines'|'stats', args: string[] } or null (404).
// The city comes from the table in cities.js only; anything else is null. Stats args are validated by the caller
// (a bad code is a 400, not a 404).
export function parseRoute(pathname) {
  const parts = pathname.split('/');
  if (parts[0] !== '' || parts[1] !== 'api') return null;
  let rest = parts.slice(2);
  let city = DEFAULT_CITY;
  if (!Object.hasOwn(KINDS, rest[0])) {
    if (!isCity(rest[0])) return null;
    city = rest[0];
    rest = rest.slice(1);
  }
  const [kind, ...args] = rest;
  if (!Object.hasOwn(KINDS, kind) || args.length !== KINDS[kind] || args.some((a) => a === '')) return null;
  if (kind === 'live' && !LIVE_CODE.test(args[0])) return null;
  return { city, kind, args };
}
