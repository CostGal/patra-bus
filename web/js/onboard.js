// "Wake me before my stop" (owner: onboard). One active trip: the bus the user is on and the stop to get off at.
// Foreground: GPS (snapped to the route) + the vehicle's live ETA at the alight stop + Screen Wake Lock; alert about
// one stop / 90 s before. Background: a server reminder (kind 'alight') booked through notify.js is the safety net.
// The trip survives reloads (own localStorage key) and ends past the stop, on "Τέλος", or after 2 h.
import { fetchLive, POLL_MS } from './api.js';
import { loadData } from './data.js';
import { closestOnPath } from './geo.js';
import locationService from './location.js';
import { scheduleReminder, cancelReminder, hasReminder, onRemindersChange, ensurePermission } from './notify.js';
import { h, lineBadge } from './ui.js';
import { t } from './i18n.js';
import { DEFAULT_CITY, cityId } from './cities.js';
import { shareHash } from './route.js';

export const KEY = 'patra-bus:onboard';
export const MAX_AGE_MS = 2 * 60 * 60 * 1000;
export const ALERT_SEC = 90; // alert when the bus is this close to the alight stop...
export const ALERT_STOPS = 1; // ...or this many stops before it
export const SNAP_M = 250; // a GPS fix farther than this from the route is not trusted
const PASSED_SLACK_MS = 45000; // gone from the stop's list this close to its due time = it passed
const TAG = 'alight';
const REBOOK_MS = 60000; // move the server reminder only when the predicted time drifts more than this

// ---------------------------------------------------------------- pure core

// Stops left until `alightStop` for a rider between stop `seg` and `seg + 1` (1 = the next stop is the one).
// 0 = already past; null = unknown (no position, or the stop is not on this route).
export function stopsToGo(stops, alightStop, seg) {
  if (!Array.isArray(stops) || !Number.isInteger(seg)) return null;
  const code = String(alightStop);
  const a = stops.findIndex((c, i) => i > seg && String(c) === code); // first occurrence ahead (loop routes)
  if (a >= 0) return a - seg;
  return stops.some((c) => String(c) === code) ? 0 : null;
}

export const shouldAlert = ({ stopsToGo: n, etaSec } = {}) =>
  (Number.isFinite(n) && n <= ALERT_STOPS) || (Number.isFinite(etaSec) && etaSec <= ALERT_SEC);

// last = { sec, at } (live ETA at the alight stop, as of epoch ms `at`): the bus vanished from the stop's list
// about when it was due, so it has gone by.
export const passedByEta = (last, now) => !!last && now >= last.at + last.sec * 1000 - PASSED_SLACK_MS;

const defaultStorage = () => { try { return globalThis.localStorage ?? null; } catch { return null; } };

// A trip started in another city stays in storage untouched but is not this city's trip (stop codes collide).
export function loadTrip(storage, now = Date.now(), city = cityId()) {
  try {
    const s = storage();
    if (!s) return null;
    const raw = s.getItem(KEY);
    if (raw == null) return null;
    const tr = JSON.parse(raw);
    if (tr && tr.alightStop && tr.routeCode && Number.isFinite(tr.startedAt) && now - tr.startedAt <= MAX_AGE_MS && tr.startedAt <= now + 60000) {
      return (tr.city || DEFAULT_CITY) === city ? tr : null;
    }
    s.removeItem(KEY);
  } catch { /* corrupt or no storage */ }
  return null;
}

// ---------------------------------------------------------------- controller

// env (all optional, for tests): storage, now, setTimer, clearTimer, doc, wake, loc, getData, fetchLive, notify, alertUser, pollMs
export function createOnboard(env = {}) {
  const now = env.now || (() => Date.now());
  const storage = env.storage || defaultStorage;
  const setTimer = env.setTimer || ((f, ms) => setInterval(f, ms));
  const clearTimer = env.clearTimer || ((id) => clearInterval(id));
  const doc = () => ('doc' in env ? env.doc : globalThis.document);
  const loc = env.loc || locationService;
  const getData = env.getData || loadData;
  const live = env.fetchLive || fetchLive;
  const pollMs = env.pollMs || POLL_MS;
  const nt = env.notify || { schedule: scheduleReminder, cancel: cancelReminder, has: hasReminder, onChange: onRemindersChange, ensure: ensurePermission };
  const visible = () => doc()?.visibilityState !== 'hidden';

  let trip = null;
  let info = { stopsToGo: null, etaSec: null };
  let route = null; // { stops: string[], pts: [lng, lat][] } or null
  let lastSeg = null;
  let lastEta = null; // { sec, at }
  let timer = null, unLoc = null, unRem = null, lock = null, ownLoc = false, busy = false, token = 0;
  const subs = new Set();

  const snapshot = () => (trip ? { ...trip, ...info } : null);
  const emit = () => { const s = snapshot(); for (const fn of [...subs]) { try { fn(s); } catch { /* ignore */ } } };
  const save = () => { try { storage()?.setItem(KEY, JSON.stringify(trip)); } catch { /* memory only */ } };

  function teardown() {
    token++;
    if (timer != null) { clearTimer(timer); timer = null; }
    if (unLoc) { unLoc(); unLoc = null; }
    if (unRem) { unRem(); unRem = null; }
    try { doc()?.removeEventListener?.('visibilitychange', onVis); } catch { /* ignore */ }
    if (lock) { try { lock.release(); } catch { /* ignore */ } lock = null; }
    if (ownLoc) { try { loc.stop(); } catch { /* ignore */ } ownLoc = false; }
    if (trip) { try { nt.cancel(TAG); } catch { /* ignore */ } }
    try { storage()?.removeItem(KEY); } catch { /* ignore */ }
    trip = null; route = null; lastSeg = null; lastEta = null; busy = false;
    info = { stopsToGo: null, etaSec: null };
  }
  function finish() { if (!trip) return; teardown(); emit(); }

  async function acquireWake() {
    if (!trip || lock || !visible()) return;
    try {
      const wl = env.wake ? env.wake() : globalThis.navigator?.wakeLock;
      const l = await wl?.request?.('screen');
      if (!l) return;
      if (!trip || lock) { l.release?.(); return; }
      lock = l;
      l.addEventListener?.('release', () => { if (lock === l) lock = null; });
    } catch { /* not supported / refused */ }
  }

  function startTimer() { if (timer == null) timer = setTimer(poll, pollMs); }
  function stopTimer() { if (timer != null) { clearTimer(timer); timer = null; } }
  function onVis() {
    if (!trip) return;
    if (visible()) { acquireWake(); startTimer(); poll(); } else stopTimer(); // never poll in the background
  }

  function alertNow() {
    trip.alerted = true; save();
    try { nt.cancel(TAG); } catch { /* ignore */ }
    try { (env.alertUser || defaultAlert)(snapshot()); } catch { /* ignore */ }
  }

  function evaluate() {
    if (!trip) return;
    if (now() - trip.startedAt > MAX_AGE_MS) return finish();
    const etaSec = lastEta ? Math.max(0, lastEta.sec - (now() - lastEta.at) / 1000) : null;
    const n = route && lastSeg != null ? stopsToGo(route.stops, trip.alightStop, lastSeg) : null;
    info = { stopsToGo: n, etaSec };
    if (!trip.alerted && shouldAlert(info)) alertNow();
    if (n === 0) return finish();
    emit();
  }

  // Keep the server copy at (predicted arrival - 90 s). Replacing by tag also replaces the server copy.
  function rebook() {
    if (!trip || trip.alerted || !lastEta) return;
    const at = lastEta.at + lastEta.sec * 1000 - ALERT_SEC * 1000;
    if (at <= now() + 5000) return;
    if (trip.bookedAt != null && Math.abs(at - trip.bookedAt) <= REBOOK_MS && nt.has(TAG)) return;
    try {
      nt.schedule({
        at, title: t('Ετοιμάσου να κατέβεις'), body: t('Η στάση «{name}» σε ~1′', { name: trip.stopName }), tag: TAG, url: shareHash('#/'), kind: 'alight',
        trip: { stopCode: trip.alightStop, vehicleCode: trip.vehicleCode, routeCode: trip.routeCode, lineCode: trip.lineCode, offsetSec: ALERT_SEC, stopName: trip.stopName },
      });
      trip.bookedAt = at; save();
    } catch { /* ignore */ }
  }

  async function poll() {
    if (!trip || busy || !visible()) return;
    if (now() - trip.startedAt > MAX_AGE_MS) return finish();
    busy = true;
    const my = token;
    try {
      const d = await live(trip.alightStop);
      if (my !== token || !trip) return;
      const v = trip.vehicleCode ? d.vehicles.find((x) => x.vehicleCode === trip.vehicleCode) : null;
      if (v) { if (v.live) lastEta = { sec: v.etaSec, at: d.fetchedAt }; }
      else if (passedByEta(lastEta, now())) return finish();
      rebook();
      evaluate();
    } catch { /* offline / upstream error: keep going on GPS */ } finally { if (my === token) busy = false; }
  }

  function onFix(fix) {
    if (!trip || !route || !fix || fix.source === 'manual' || !visible()) return;
    if (Number.isFinite(fix.accuracy) && fix.accuracy > 150) return;
    const c = closestOnPath(route.pts, { lat: fix.lat, lng: fix.lng });
    if (!c || c.meters > SNAP_M) return;
    const seg = c.index + (c.t >= 0.97 ? 1 : 0); // at the next stop already (also the only way to reach the last stop)
    if (lastSeg != null && seg < lastSeg - 1) return; // far backwards: another stretch of a loop, or noise
    if (seg === lastSeg) return;
    lastSeg = seg;
    evaluate();
  }

  // Wire up everything for the current `trip`. `fromGesture` = location may prompt.
  async function run(fromGesture) {
    const my = token;
    const st = loc.status;
    ownLoc = st !== 'ok' && st !== 'locating';
    try { if (fromGesture) loc.start(); else await loc.autoStart?.(); } catch { /* ignore */ }
    unLoc = loc.subscribe?.(onFix) || null;
    try { doc()?.addEventListener?.('visibilitychange', onVis); } catch { /* ignore */ }
    unRem = nt.onChange?.(() => { // the local reminder fired first: don't alert twice
      if (trip && !trip.alerted && trip.bookedAt != null && now() >= trip.bookedAt - 2000 && !nt.has(TAG)) { trip.alerted = true; save(); emit(); }
    }) || null;
    acquireWake();
    if (visible()) startTimer();
    emit();
    let data = null;
    try { data = await getData(); } catch { /* ETA-only */ }
    if (my !== token || !trip) return;
    const r = data?.routeByCode?.get(trip.routeCode);
    if (r) {
      route = { stops: r.stops.map(String), pts: r.stops.map((c) => data.stopByCode.get(c)).map((s) => (s ? [s.lng, s.lat] : null)) };
      if (route.pts.some((p) => !p)) route = null; // unknown stop in the middle: cannot snap
    }
    if (!trip.stopName) { trip.stopName = data?.stopByCode?.get(trip.alightStop)?.displayName || ''; save(); }
    const fix = loc.current;
    if (fix) onFix(fix);
    poll();
  }

  // Must be called from a user gesture. Resolves false for an unusable request.
  async function startOnboard({ vehicleCode, routeCode, lineCode, alightStop, stopName } = {}) {
    if (!routeCode || !alightStop) return false;
    if (trip) teardown();
    trip = {
      v: 1, vehicleCode: vehicleCode ? String(vehicleCode) : null, routeCode: String(routeCode), lineCode: lineCode == null ? '' : String(lineCode),
      alightStop: String(alightStop), stopName: stopName ? String(stopName) : '', startedAt: now(), alerted: false, bookedAt: null, city: cityId(),
    };
    save();
    try { Promise.resolve(nt.ensure?.()).catch(() => {}); } catch { /* ignore */ } // notification permission, inside the gesture
    await run(true);
    return true;
  }

  function stopOnboard() { finish(); }

  function activeTrip() {
    if (trip && now() - trip.startedAt > MAX_AGE_MS) finish();
    return snapshot();
  }

  function onTripChange(fn) { subs.add(fn); return () => subs.delete(fn); }

  // After a reload: pick the persisted trip up again (no prompts; location only if already allowed).
  function resume() {
    if (trip) return false;
    const tr = loadTrip(storage, now());
    if (!tr) return false;
    trip = tr;
    run(false).catch(() => {});
    return true;
  }

  return { startOnboard, stopOnboard, activeTrip, onTripChange, resume, poll, onVis, _evaluate: evaluate };
}

// Alert: vibration + in-app toast + system notification (notify.js does the last two for a reminder due now).
function defaultAlert(tr) {
  const name = tr.stopName;
  try {
    scheduleReminder({ at: Date.now(), title: t('Ετοιμάσου να κατέβεις'), body: t('Η στάση «{name}» σε ~1′', { name }), tag: 'alight-now', url: shareHash('#/') });
  } catch { /* ignore */ }
  setTimeout(() => { try { navigator.vibrate?.([400, 150, 400, 150, 800]); } catch { /* ignore */ } }, 300); // after notify's own short buzz
}

// ---------------------------------------------------------------- card

const stopsText = (n) => (n <= 0 ? t('τώρα') : n === 1 ? t('στην επόμενη στάση') : t('σε {n} στάσεις', { n }));

// ONE compact card while a trip is active, nothing otherwise. The only action is "Τέλος".
export function mountOnboardCard(container, ctx = {}) {
  let lastSig = null;
  const draw = (tr) => {
    if (!tr) { lastSig = null; container.replaceChildren(); return; } // next trip is a fresh appearance, not a refresh
    const line = ctx.data?.lineByCode?.get(tr.lineCode);
    const stop = tr.stopName || ctx.data?.stopByCode?.get(tr.alightStop)?.displayName || '';
    let meta = '';
    if (tr.alerted) meta = t('Η επόμενη στάση!');
    else if (tr.stopsToGo != null) meta = stopsText(tr.stopsToGo);
    else if (tr.etaSec != null) meta = t('σε ~{n}′', { n: Math.max(1, Math.round(tr.etaSec / 60)) });
    // Only replay the entrance on a genuinely new moment (new trip, or the alert kicking in), not every poll.
    const sig = `${tr.vehicleCode || ''}|${tr.alightStop}|${tr.alerted}`;
    const changed = sig !== lastSig;
    lastSig = sig;
    // NOTE for planner.css's owner: .ob-card sets its own opaque background/border-left there, so this
    // .material class is currently a no-op (its blur has nothing to show through) — remove .ob-card's
    // background/box-shadow in planner.css to let .material's translucent surface render, same as
    // .nb-hero/.plc-card already do in css/nearby.css and css/places.css.
    container.replaceChildren(h('div', { class: `ob-card material${tr.alerted ? ' is-alert' : ''}${changed ? ' card-in' : ''}`, role: 'status' },
      line || tr.lineCode ? lineBadge(line || { code: tr.lineCode }) : null,
      h('div', { class: 'ob-main' },
        h('div', { class: 'ob-title' }, t('Κατεβαίνεις: «{name}»', { name: stop })),
        meta ? h('div', { class: 'ob-meta' }, meta) : null),
      h('button', { type: 'button', class: 'ob-end press', onclick: () => stopOnboard() }, t('Τέλος'))));
  };
  draw(activeTrip());
  const off = onTripChange(draw);
  return { destroy() { off(); container.replaceChildren(); } };
}

// ---------------------------------------------------------------- default instance

const real = createOnboard();
export const { startOnboard, stopOnboard, activeTrip, onTripChange } = real;
try { if (typeof document !== 'undefined') real.resume(); } catch { /* ignore */ }
