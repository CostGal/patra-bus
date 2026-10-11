// "Leave now" push reminders: validation + decision logic (pure) and the Durable Object base class.
// One DO per reminder (name = random 128-bit id). index.js subclasses ReminderBase to supply getLive().
import { etaText } from '../../web/js/arrivals.js';
import { DEFAULT_CITY, isCity } from '../../web/js/cities.js';
import { isPrivateUrl } from '../../web/js/notif-link.js';
import { b64uDecode, isAllowedEndpoint, sendPush } from './push.js';

export const MAX_BODY_BYTES = 4096;
export const MAX_AHEAD_MS = 3 * 3600 * 1000;
export const LATE_TOLERANCE_MS = 60 * 1000;
export const MAX_REARMS = 3;
const RETRY_MIN_MS = 30 * 1000;
const RETRY_MAX_MS = 5 * 60 * 1000;

export const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const str = (v, max, { min = 0 } = {}) => typeof v === 'string' && v.length >= min && v.length <= max;

// Shared with routines. -> { value } cleaned copy or { error: field }.
export function cleanSubscription(s, { allowLocal = false } = {}) {
  if (!isObj(s) || !isAllowedEndpoint(s.endpoint, { allowLocal })) return { error: 'subscription.endpoint' };
  if (!isObj(s.keys)) return { error: 'subscription.keys' };
  try {
    const p = b64uDecode(s.keys.p256dh);
    const a = b64uDecode(s.keys.auth);
    if (p.length !== 65 || p[0] !== 4 || a.length !== 16) return { error: 'subscription.keys' };
  } catch {
    return { error: 'subscription.keys' };
  }
  return { value: { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } } };
}

// Optional notification link (shared with routines). A link with coordinates or a place name (`#/plan?to=…&name=…`,
// sent by clients older than notif-link.js) is accepted but dropped, whatever its length: never stored.
// -> { value } (undefined = no link) or { error: 'url' }.
export function cleanUrl(url) {
  if (url === undefined || isPrivateUrl(url)) return { value: undefined };
  return str(url, 300) ? { value: url } : { error: 'url' };
}

// Optional `city` of a push request (shared with routines): absent -> Patras, otherwise it must be in the table.
// -> { value } or { error: 'city' }.
export function cleanCity(c) {
  if (c === undefined) return { value: DEFAULT_CITY };
  return isCity(c) ? { value: c } : { error: 'city' };
}

// Strict validation of the POST body. Returns { ok: true, value } with a cleaned copy, or { ok: false, error }.
export function validateReminder(raw, now, { allowLocal = false } = {}) {
  const bad = (error) => ({ ok: false, error });
  if (!isObj(raw)) return bad('body');
  const { subscription: s, at, title, body, tag, url, trip: t, kind = 'leave' } = raw;

  const sub = cleanSubscription(s, { allowLocal });
  if (sub.error) return bad(sub.error);
  const city = cleanCity(raw.city);
  if (city.error) return bad(city.error);
  if (kind !== 'leave' && kind !== 'alight') return bad('kind');

  if (typeof at !== 'number' || !Number.isFinite(at) || at <= now || at > now + MAX_AHEAD_MS) return bad('at');
  if (!str(title, 120, { min: 1 })) return bad('title');
  if (body !== undefined && !str(body, 300)) return bad('body');
  if (!str(tag, 64, { min: 1 })) return bad('tag');
  const link = cleanUrl(url);
  if (link.error) return bad(link.error);

  let trip;
  if (t !== undefined && t !== null) {
    if (!isObj(t)) return bad('trip');
    if (!str(t.stopCode, 6, { min: 1 }) || !/^\d+$/.test(t.stopCode)) return bad('trip.stopCode');
    if (!str(t.routeCode, 16, { min: 1 })) return bad('trip.routeCode');
    if (!str(t.lineCode, 16, { min: 1 })) return bad('trip.lineCode');
    const vc = t.vehicleCode ?? null;
    if (vc !== null && !str(vc, 64, { min: 1 })) return bad('trip.vehicleCode');
    if (typeof t.offsetSec !== 'number' || !Number.isFinite(t.offsetSec) || t.offsetSec < 0 || t.offsetSec > 7200) {
      return bad('trip.offsetSec');
    }
    if (t.stopName !== undefined && !str(t.stopName, 80)) return bad('trip.stopName');
    trip = { stopCode: t.stopCode, routeCode: t.routeCode, lineCode: t.lineCode, vehicleCode: vc, offsetSec: t.offsetSec };
    if (t.stopName) trip.stopName = t.stopName;
  }

  return {
    ok: true,
    value: {
      subscription: sub.value,
      city: city.value,
      kind,
      at,
      title,
      body: body ?? '',
      tag,
      ...(link.value !== undefined ? { url: link.value } : {}),
      ...(trip ? { trip } : {}),
    },
  };
}

// A given vehicleCode must match exactly (if it is gone, the bus is gone); without one, the first of the route.
export function findBus(live, trip) {
  const list = live && Array.isArray(live.vehicles) ? live.vehicles : [];
  if (trip.vehicleCode) return list.find((v) => v.vehicleCode === trip.vehicleCode) || null;
  return list.find((v) => v.routeCode === trip.routeCode) || null;
}

const phrase = (sec) => (sec < 15 ? 'έρχεται τώρα' : `έρχεται σε ${etaText(sec)}`);

export const alightText = (name) => `Ετοιμάσου: η στάση ${name ? `«${name}»` : 'σου'} σε ~1′`;

// reminder: { at, kind?, trip?, rearms?, title, body }, live: normalized LiveResult | null, now: epoch ms.
// -> { action: 'send', title, body } | { action: 'rearm', at } | { action: 'send-original' }
export function decideReminder({ reminder, live, now, rearms = 0 }) {
  const trip = reminder.trip;
  if (!trip) return { action: 'send-original' };
  const bus = findBus(live, trip);
  if (!bus || !Number.isFinite(bus.etaSec)) return { action: 'send-original' };

  const age = Math.max(0, (now - (live.fetchedAt || now)) / 1000);
  const remaining = Math.max(0, bus.etaSec - age);
  const leaveAt = now + remaining * 1000 - trip.offsetSec * 1000;
  if (leaveAt - reminder.at > LATE_TOLERANCE_MS && rearms < MAX_REARMS && leaveAt - now <= MAX_AHEAD_MS) {
    return { action: 'rearm', at: Math.round(leaveAt) };
  }
  return {
    action: 'send',
    title: reminder.title,
    body: reminder.kind === 'alight' ? alightText(trip.stopName) : `Φύγε τώρα για το ${trip.lineCode} · ${phrase(remaining)}`,
  };
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export class ReminderBase {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  // Overridden in index.js: normalized LiveResult for a stop via the shared 15 s cache.
  async getLive(city, code) {
    throw new Error('getLive not implemented');
  }

  async fetch(request) {
    const st = this.state.storage;
    if (request.method === 'DELETE') {
      await st.deleteAlarm();
      await st.deleteAll();
      return new Response(null, { status: 204 });
    }
    if (request.method !== 'POST') return json({ error: 'method' }, 405);
    const r = await request.json();
    await st.put('r', { ...r, rearms: 0, pending: null });
    await st.setAlarm(r.at);
    return json({ ok: true }, 201);
  }

  async alarm() {
    const st = this.state.storage;
    try {
      const r = await st.get('r');
      if (!r) return;

      // Second (and last) attempt after a 429/5xx from the push service.
      if (r.pending) {
        await sendPush(this.env, r.subscription, r.pending);
        await st.deleteAll();
        return;
      }

      const now = Date.now();
      let live = null;
      if (r.trip) {
        try {
          live = await this.getLive(r.city || DEFAULT_CITY, r.trip.stopCode); // stored before multi-city -> Patras
        } catch (err) {
          console.error(`reminder live: ${err.message}`);
        }
      }
      const d = decideReminder({ reminder: r, live, now, rearms: r.rearms });
      if (d.action === 'rearm') {
        await st.put('r', { ...r, at: d.at, rearms: r.rearms + 1 });
        await st.setAlarm(d.at);
        return;
      }

      const payload = {
        title: d.action === 'send' ? d.title : r.title,
        body: d.action === 'send' ? d.body : r.body,
        tag: r.tag,
        ...(r.url ? { url: r.url } : {}),
      };
      const res = await sendPush(this.env, r.subscription, payload);
      if (res.result === 'retry') {
        const wait = Math.min(RETRY_MAX_MS, Math.max(RETRY_MIN_MS, (res.retryAfterSec || 0) * 1000));
        await st.put('r', { ...r, pending: payload });
        await st.setAlarm(now + wait);
        return;
      }
      if (res.result !== 'ok') console.error(`reminder push: ${res.result} ${res.status}`);
      await st.deleteAll();
    } catch (err) {
      // Never throw from alarm(): the runtime would retry and could double-send.
      console.error(`reminder alarm: ${err.message}`);
      await st.deleteAll().catch(() => {});
    }
  }
}
