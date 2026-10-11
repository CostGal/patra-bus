// Notification links (owner: push client). A push notification's link is stored on our worker, so it must not carry
// a place: plan links have the destination's coordinates and name (`to=`, `name=`, maybe `from=`). The worker gets
// `#/{city}/notif?…` instead, with a reference that only this device can resolve:
//   ?routine=<ref>  a weekly routine (routines.js keeps `ref`): plan to its saved place as it is now
//   ?ref=<ref>      a one-off reminder: the plan hash kept here in localStorage (LINKS_KEY) for a day
// plus `stop=<code>` (the boarding stop, which the server already has in `trip`) as the fallback when the reference
// no longer resolves (place or routine deleted, other browser, cleared data). Shared with the worker (isPrivateUrl):
// no DOM at module level.
import { formatHash, relHash } from './route.js';

export const LINKS_KEY = 'patra-bus:push-links';
export const LINK_TTL_MS = 24 * 3600 * 1000; // reminders are at most 3 h ahead; the tap can come later
const MAX_LINKS = 20;

// Coordinates or a place name anywhere in the URL (absolute or a bare hash): `to`, `from`, `name`, `lat`, `lng`.
const PRIVATE = /[?&](?:to|from|name|lat|lng)=/;
export const isPrivateUrl = (url) => typeof url === 'string' && PRIVATE.test(url);

// 16 hex chars from crypto.getRandomValues (available outside secure contexts too, unlike randomUUID).
export function newRef(crypto = globalThis.crypto) {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

// The link the server gets. Always with the city prefix: it leaves the device.
export function notifHash({ routine, ref, stop } = {}, city) {
  const q = new URLSearchParams();
  if (routine) q.set('routine', routine);
  else if (ref) q.set('ref', ref);
  if (stop) q.set('stop', stop);
  return formatHash(`#/notif?${q}`, city, { always: true });
}

// ref -> hash of one-off reminders. Never throws; without storage nothing is kept and the tap falls back to the stop.
export function createLinks({ storage = () => globalThis.localStorage ?? null, now = Date.now } = {}) {
  const ls = () => { try { return storage(); } catch { return null; } };
  const read = () => {
    try {
      const a = JSON.parse(ls()?.getItem(LINKS_KEY) ?? '[]');
      return Array.isArray(a) ? a.filter((x) => x && typeof x.ref === 'string' && typeof x.hash === 'string' && x.exp > now()) : [];
    } catch { return []; }
  };
  const write = (a) => {
    try { if (a.length) ls()?.setItem(LINKS_KEY, JSON.stringify(a.slice(-MAX_LINKS))); else ls()?.removeItem(LINKS_KEY); } catch { /* ignore */ }
  };
  return {
    save(hash, exp = now() + LINK_TTL_MS) { const ref = newRef(); write([...read(), { ref, hash: String(hash), exp }]); return ref; },
    get(ref) { return read().find((x) => x.ref === ref)?.hash ?? null; },
  };
}

const planHash = (p) => `#/plan?to=${p.lat.toFixed(5)},${p.lng.toFixed(5)}&name=${encodeURIComponent(p.name)}`;

// City-relative hash that a `#/notif` link opens. The link's city prefix already picked the city, so `routines` and
// `places` are the active city's. `links` = createLinks(), `hasStop(code)` = the stop exists in this city's data.
export function resolveNotif(params = {}, { routines = [], places = [], links = null, hasStop = () => true } = {}) {
  const stop = (code) => (code && hasStop(String(code)) ? `#/stop/${encodeURIComponent(code)}` : null);
  if (params.routine) {
    const r = routines.find((x) => x.ref === params.routine);
    const p = r && places.find((x) => x.id === r.placeId);
    if (p) return planHash(p);
    return stop(r?.trip?.stopCode) || stop(params.stop) || '#/';
  }
  const hit = params.ref ? links?.get(params.ref) : null;
  if (hit) return relHash(hit);
  return stop(params.stop) || '#/';
}
