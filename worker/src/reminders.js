// "Leave now" push reminders: validation + decision logic (pure) and the Durable Object base class.
// One DO per reminder (name = random 128-bit id). index.js subclasses ReminderBase to supply getLive().
import { etaText } from '../../web/js/arrivals.js';
import { b64uDecode, isAllowedEndpoint, sendPush } from './push.js';

export const MAX_BODY_BYTES = 4096;
export const MAX_AHEAD_MS = 3 * 3600 * 1000;
export const LATE_TOLERANCE_MS = 60 * 1000;
export const MAX_REARMS = 3;
const RETRY_MIN_MS = 30 * 1000;
const RETRY_MAX_MS = 5 * 60 * 1000;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, max, { min = 0 } = {}) => typeof v === 'string' && v.length >= min && v.length <= max;

// Strict validation of the POST body. Returns { ok: true, value } with a cleaned copy, or { ok: false, error }.
export function validateReminder(raw, now, { allowLocal = false } = {}) {
  const bad = (error) => ({ ok: false, error });
  if (!isObj(raw)) return bad('body');
  const { subscription: s, at, title, body, tag, url, trip: t } = raw;

  if (!isObj(s) || !isAllowedEndpoint(s.endpoint, { allowLocal })) return bad('subscription.endpoint');
  if (!isObj(s.keys)) return bad('subscription.keys');
  try {
    const p = b64uDecode(s.keys.p256dh);
    const a = b64uDecode(s.keys.auth);
    if (p.length !== 65 || p[0] !== 4 || a.length !== 16) return bad('subscription.keys');
  } catch {
    return bad('subscription.keys');
  }

  if (typeof at !== 'number' || !Number.isFinite(at) || at <= now || at > now + MAX_AHEAD_MS) return bad('at');
  if (!str(title, 120, { min: 1 })) return bad('title');
  if (body !== undefined && !str(body, 300)) return bad('body');
  if (!str(tag, 64, { min: 1 })) return bad('tag');
  if (url !== undefined && !str(url, 300)) return bad('url');

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
    trip = { stopCode: t.stopCode, routeCode: t.routeCode, lineCode: t.lineCode, vehicleCode: vc, offsetSec: t.offsetSec };
  }

  return {
    ok: true,
    value: {
      subscription: { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } },
      at,
      title,
      body: body ?? '',
      tag,
      ...(url !== undefined ? { url } : {}),
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

// reminder: { at, trip?, rearms?, title, body }, live: normalized LiveResult | null, now: epoch ms.
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
    body: `Φύγε τώρα για το ${trip.lineCode} · ${phrase(remaining)}`,
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
  async getLive() {
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
          live = await this.getLive(r.trip.stopCode);
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
