// Weekly "leave now" routines: validation + Europe/Athens scheduling (pure) and the Durable Object base class.
// One DO per routine (name = random 128-bit id). index.js subclasses RoutineBase to supply getLive().
// Per matching day: at time - 20' read live, pick the first bus of the route we can still catch,
// alarm at leave - leadMin, push, then arm the next matching day. Expires after 120 days.
import { cleanSubscription, isObj, str, LATE_TOLERANCE_MS, MAX_AHEAD_MS, MAX_REARMS } from './reminders.js';
import { sendPush } from './push.js';

export const TZ = 'Europe/Athens';
export const CHECK_LEAD_MS = 20 * 60 * 1000;
export const EXPIRE_MS = 120 * 24 * 3600 * 1000;
const CHECK_RETRY_MS = 90 * 1000;
const RETRY_MIN_MS = 30 * 1000;
const RETRY_MAX_MS = 5 * 60 * 1000;

// Strict validation of the POST body. Returns { ok: true, value } with a cleaned copy, or { ok: false, error }.
export function validateRoutine(raw, { allowLocal = false } = {}) {
  const bad = (error) => ({ ok: false, error });
  if (!isObj(raw)) return bad('body');
  const { subscription: s, days, time, tz, title, url, trip: t, leadMin } = raw;

  const sub = cleanSubscription(s, { allowLocal });
  if (sub.error) return bad(sub.error);

  if (!Array.isArray(days) || days.length < 1 || days.length > 7 || !days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) {
    return bad('days');
  }
  if (typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return bad('time');
  if (tz !== TZ) return bad('tz');
  if (!str(title, 120, { min: 1 })) return bad('title');
  if (url !== undefined && !str(url, 300)) return bad('url');
  if (typeof leadMin !== 'number' || !Number.isInteger(leadMin) || leadMin < 0 || leadMin > 15) return bad('leadMin');

  if (!isObj(t)) return bad('trip');
  if (!str(t.stopCode, 6, { min: 1 }) || !/^\d+$/.test(t.stopCode)) return bad('trip.stopCode');
  if (!str(t.routeCode, 16, { min: 1 })) return bad('trip.routeCode');
  if (!str(t.lineCode, 16, { min: 1 })) return bad('trip.lineCode');
  if (typeof t.offsetSec !== 'number' || !Number.isFinite(t.offsetSec) || t.offsetSec < 0 || t.offsetSec > 3600) {
    return bad('trip.offsetSec');
  }

  return {
    ok: true,
    value: {
      subscription: sub.value,
      days: [...new Set(days)].sort((a, b) => a - b),
      time,
      tz: TZ,
      title,
      ...(url !== undefined ? { url } : {}),
      trip: { stopCode: t.stopCode, routeCode: t.routeCode, lineCode: t.lineCode, offsetSec: t.offsetSec },
      leadMin,
    },
  };
}

// --- Europe/Athens wall-clock <-> epoch (Intl only, so DST comes from the runtime's tz database) ---
const fmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
});

// -> { y, mo (1-12), d, h, mi, s, dow (0=Sun) } as seen on an Athens wall clock.
export function athensParts(ms) {
  const p = {};
  for (const { type, value } of fmt.formatToParts(new Date(ms))) p[type] = Number(value);
  return {
    y: p.year, mo: p.month, d: p.day, h: p.hour, mi: p.minute, s: p.second,
    dow: new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay(),
  };
}

// Athens UTC offset in ms at instant ms.
export function athensOffset(ms) {
  const p = athensParts(ms);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

// Epoch of a wall-clock time in Athens. Ambiguous (autumn overlap) -> the earlier instant;
// nonexistent (spring gap) -> shifted forward by the gap (03:30 becomes 04:30).
export function athensEpoch(y, mo, d, h, mi) {
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const before = athensOffset(wall - 12 * 3600e3);
  const after = athensOffset(wall + 12 * 3600e3);
  const cands = [[wall - before, before], [wall - after, after]].filter(([t, o]) => athensOffset(t) === o).map(([t]) => t);
  return cands.length ? Math.min(...cands) : wall - before;
}

// First planned leave time (epoch) strictly after afterMs on one of `days`, or null.
export function nextOccurrence({ days, time }, afterMs) {
  const [h, mi] = time.split(':').map(Number);
  const a = athensParts(afterMs);
  for (let i = 0; i <= 8; i++) {
    const day = new Date(Date.UTC(a.y, a.mo - 1, a.d + i));
    if (!days.includes(day.getUTCDay())) continue;
    const t = athensEpoch(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), h, mi);
    if (t > afterMs) return t;
  }
  return null;
}

// --- bus choice ---
// First bus of the route (smallest arrival) we can still catch: leave = arrival - offset >= now.
// Arrival = fetchedAt + etaSec, which is also stable for scheduled entries between fetches.
export function pickBus(live, trip, now) {
  const base = (live && live.fetchedAt) || now;
  let best = null;
  for (const v of live && Array.isArray(live.vehicles) ? live.vehicles : []) {
    if (v.routeCode !== trip.routeCode || !Number.isFinite(v.etaSec)) continue;
    const arrivalAt = base + v.etaSec * 1000;
    const leaveAt = arrivalAt - trip.offsetSec * 1000;
    if (leaveAt < now) continue;
    if (!best || arrivalAt < best.arrivalAt) best = { arrivalAt, leaveAt, vehicleCode: v.vehicleCode || null, live: !!v.live };
  }
  return best;
}

// Finds the previously picked bus again: by vehicleCode, else the route's bus closest to the old arrival (<= 10').
export function relocateBus(live, trip, pick, now) {
  const base = (live && live.fetchedAt) || now;
  let best = null;
  for (const v of live && Array.isArray(live.vehicles) ? live.vehicles : []) {
    if (v.routeCode !== trip.routeCode || !Number.isFinite(v.etaSec)) continue;
    const arrivalAt = base + v.etaSec * 1000;
    const dist = Math.abs(arrivalAt - pick.arrivalAt);
    const ok = pick.vehicleCode ? v.vehicleCode === pick.vehicleCode : dist <= 10 * 60 * 1000;
    if (ok && (!best || dist < best.dist)) best = { arrivalAt, leaveAt: arrivalAt - trip.offsetSec * 1000, dist };
  }
  return best;
}

export function routineText(lineCode, msUntilLeave) {
  const n = Math.round(msUntilLeave / 60000);
  return n <= 0 ? `Φύγε τώρα για το ${lineCode}` : `Φύγε σε ${n}′ για το ${lineCode}`;
}

// r: { trip, leadMin, pick, rearms }, alarmAt: when this alarm was due. live may be null.
// -> { action: 'send', body } | { action: 'rearm', at }
export function decideRoutine({ r, live, now, alarmAt }) {
  const lead = r.leadMin * 60000;
  const bus = live ? relocateBus(live, r.trip, r.pick, now) : null;
  const leaveAt = bus ? bus.leaveAt : r.pick.leaveAt;
  if (bus && leaveAt - lead - alarmAt > LATE_TOLERANCE_MS && (r.rearms || 0) < MAX_REARMS && leaveAt - now <= MAX_AHEAD_MS) {
    return { action: 'rearm', at: Math.max(Math.round(leaveAt - lead), now + 1000) };
  }
  return { action: 'send', body: routineText(r.trip.lineCode, leaveAt - now) };
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

// Phases: 'check' (read live, pick a bus) -> 'send' (alarm at leave - lead) -> 'retry' (one more push attempt).
export class RoutineBase {
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
    const { id, ...routine } = await request.json();
    const now = Date.now();
    const leave = nextOccurrence(routine, now);
    if (leave === null) return json({ error: 'schedule' }, 400);
    const r = { ...routine, tag: `routine-${id}`, createdAt: now, phase: 'check', leave, rearms: 0 };
    await st.put('r', r);
    await st.setAlarm(Math.max(leave - CHECK_LEAD_MS, now + 1000));
    return json({ ok: true }, 201);
  }

  // Next matching day (after this occurrence and now); drops the routine once it would pass expiry.
  async advance(r, now) {
    const st = this.state.storage;
    const leave = nextOccurrence(r, Math.max(r.leave, now));
    if (leave === null || leave - CHECK_LEAD_MS > r.createdAt + EXPIRE_MS) {
      await st.deleteAlarm();
      await st.deleteAll();
      return;
    }
    await st.put('r', { ...r, phase: 'check', leave, rearms: 0, pick: null, pending: null });
    await st.setAlarm(leave - CHECK_LEAD_MS);
  }

  async alarm() {
    const st = this.state.storage;
    let r;
    const now = Date.now();
    try {
      r = await st.get('r');
      if (!r) return;
      if (now > r.createdAt + EXPIRE_MS) {
        await st.deleteAll();
        return;
      }
      if (r.phase === 'check') return await this.check(r, now);
      if (r.phase === 'send') return await this.send(r, now);
      if (r.phase === 'retry') return await this.deliver(r, now, r.pending);
      await this.advance(r, now);
    } catch (err) {
      // Never throw from alarm(): the runtime would retry and could double-send.
      console.error(`routine alarm: ${err.message}`);
      try {
        if (r) await this.advance(r, now);
      } catch {
        await st.deleteAll().catch(() => {});
      }
    }
  }

  async live(r) {
    try {
      return await this.getLive(r.trip.stopCode);
    } catch (err) {
      console.error(`routine live: ${err.message}`);
      return null;
    }
  }

  async check(r, now) {
    const st = this.state.storage;
    const pick = pickBus(await this.live(r), r.trip, now);
    if (!pick) {
      // Nothing catchable (or upstream down): look again until the planned time, then skip today.
      if (now + CHECK_RETRY_MS <= r.leave) await st.setAlarm(now + CHECK_RETRY_MS);
      else await this.advance(r, now);
      return;
    }
    const at = Math.max(pick.leaveAt - r.leadMin * 60000, now + 1000);
    await st.put('r', { ...r, phase: 'send', pick, alarmAt: at, rearms: 0 });
    await st.setAlarm(at);
  }

  async send(r, now) {
    const st = this.state.storage;
    const d = decideRoutine({ r, live: await this.live(r), now, alarmAt: r.alarmAt });
    if (d.action === 'rearm') {
      await st.put('r', { ...r, alarmAt: d.at, rearms: (r.rearms || 0) + 1 });
      await st.setAlarm(d.at);
      return;
    }
    await this.deliver(r, now, { title: r.title, body: d.body, tag: r.tag, ...(r.url ? { url: r.url } : {}) });
  }

  async deliver(r, now, payload) {
    const st = this.state.storage;
    const res = await sendPush(this.env, r.subscription, payload);
    if (res.result === 'gone') {
      await st.deleteAlarm();
      await st.deleteAll();
      return;
    }
    if (res.result === 'retry' && r.phase !== 'retry') {
      const wait = Math.min(RETRY_MAX_MS, Math.max(RETRY_MIN_MS, (res.retryAfterSec || 0) * 1000));
      await st.put('r', { ...r, phase: 'retry', pending: payload });
      await st.setAlarm(now + wait);
      return;
    }
    if (res.result !== 'ok') console.error(`routine push: ${res.result} ${res.status}`);
    await this.advance(r, now);
  }
}
