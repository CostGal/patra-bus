// Location service (owner: location). Contract in docs/ARCHITECTURE.md.
// The position never leaves this module except through subscribers; nothing here talks to the network.
import { haversine, bearing, angleDiff, lerpAngle, normDeg } from './geo.js';

const MAX_SPEED = 60; // m/s: faster implied jumps are rejected
const STALE_MS = 30000; // a fix older than this accepts any newcomer
const WORSE_K = 2, WORSE_PAD = 15; // "much worse" = accuracy > prev * 2 + 15 m
const JUMPS_TO_ACCEPT = 3; // consistent far-away fixes in a row that count as a real relocation
const SMOOTH_KEEP = 0.6; // weight kept for the previous position when stationary
const MOVING_SPEED = 1.0; // m/s: below this the GPS course is noise
const COMPASS_UNTIL_SPEED = 2.0; // m/s: above this the GPS course beats the compass
const HEADING_HOLD_MS = 8000; // keep the last course this long after stopping
const COMPASS_FRESH_MS = 2500;
const FLAG_KEY = 'patra-bus:loc-granted';

const validPoint = (p) => !!p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;

// iOS reports degrees clockwise from north directly; Android gives alpha/beta/gamma in the Earth frame.
// Heading of the direction the user faces: top edge when the phone is flat, rear camera axis when upright.
function headingFromEuler(alpha, beta, gamma) {
  const rad = Math.PI / 180;
  if (!Number.isFinite(alpha)) return null;
  const b = Number.isFinite(beta) ? beta : 0, g = Number.isFinite(gamma) ? gamma : 0;
  if (Math.abs(b) < 45 && Math.abs(g) < 45) return normDeg(360 - alpha);
  const x = b * rad, y = g * rad, z = alpha * rad;
  const cY = Math.cos(y), cZ = Math.cos(z), sX = Math.sin(x), sY = Math.sin(y), sZ = Math.sin(z);
  const vx = -cZ * sY - sZ * sX * cY, vy = -sZ * sY + cZ * sX * cY;
  return normDeg(Math.atan2(vx, vy) / rad);
}

// env (all optional, for tests): nav, doc, win, now, storage, secure, compassWaitMs
export function createLocationService(env = {}) {
  const nav = () => env.nav || globalThis.navigator;
  const doc = () => env.doc || globalThis.document;
  const win = () => env.win || globalThis;
  const now = env.now || (() => Date.now());
  const secure = () => (env.secure !== undefined ? env.secure : globalThis.isSecureContext !== false);
  const store = () => { try { return env.storage || globalThis.localStorage || null; } catch { return null; } };

  let status = 'idle';
  let gps = null; // last accepted GPS fix
  let manual = null; // user-chosen point, wins over gps while set
  let wanted = false; // start() called and stop() not yet
  let suspended = false; // page hidden: watch is off
  let watchId = null;
  let perm = 'unknown'; // Permissions API state
  let permStatus = null, permPromise = null;
  let jump = null; // candidate for a far-away relocation: { fix, n }
  let course = null; // last GPS course { v, ts }
  const compass = { on: false, raw: null, flat: true, heading: null, ts: 0, lastEmit: 0, lastEmitted: null }; // raw: device frame, heading: screen frame
  const subs = new Set();
  let lastEmit = { fix: undefined, status: undefined };

  const getCurrent = () => manual || gps;

  function emit() {
    const cur = getCurrent();
    if (lastEmit.fix === cur && lastEmit.status === status) return;
    lastEmit = { fix: cur, status };
    for (const fn of [...subs]) { try { fn(cur, status); } catch (e) { console.error('[location] subscriber failed', e); } }
  }
  function setStatus(s) { if (status !== s) { status = s; emit(); } }

  // ---- fix pipeline ----
  function onPosition(pos) {
    if (!wanted) return;
    const t = now();
    const c = pos && pos.coords;
    if (!c || !Number.isFinite(c.latitude) || !Number.isFinite(c.longitude) || !validPoint({ lat: c.latitude, lng: c.longitude })) return;
    if (c.latitude === 0 && c.longitude === 0) return;
    const accuracy = Number.isFinite(c.accuracy) ? Math.max(c.accuracy, 1) : 1000;
    const ts = Number.isFinite(pos.timestamp) && Math.abs(pos.timestamp - t) < 600000 ? Math.min(pos.timestamp, t) : t;
    let fix = { lat: c.latitude, lng: c.longitude, accuracy, heading: null, speed: Number.isFinite(c.speed) && c.speed >= 0 ? c.speed : null, ts, source: 'gps', headingSource: null };
    let prev = gps;
    let stale = false;

    if (prev) {
      const dt = (ts - prev.ts) / 1000;
      if (dt < 0) return; // out-of-order (e.g. a cached one-shot fix arriving after the watch's)
      const dist = haversine(prev, fix);
      stale = t - prev.ts > STALE_MS;
      if (!stale && accuracy > prev.accuracy * WORSE_K + WORSE_PAD) return;
      const slack = Math.max(0, dist - prev.accuracy - accuracy);
      if (slack / Math.max(dt, 1) > MAX_SPEED) {
        // Teleport. One-offs are dropped; three consistent ones in a row mean we really are somewhere else.
        if (jump && haversine(jump.fix, fix) <= 2 * Math.max(jump.fix.accuracy, accuracy, 30)) { jump.fix = fix; jump.n++; } else jump = { fix, n: 1 };
        if (jump.n < JUMPS_TO_ACCEPT) return;
        prev = null; course = null;
      }
    }
    jump = null;
    if (stale) prev = null; // nothing to blend with or derive a course from

    let moving = fix.speed != null ? fix.speed >= MOVING_SPEED : false;
    let speedNow = fix.speed;
    let newCourse = null;
    if (prev) {
      const dist = haversine(prev, fix), dt = Math.max((ts - prev.ts) / 1000, 1);
      if (fix.speed == null) { speedNow = dist / dt; moving = speedNow >= 1.5 && dist > Math.max(6, accuracy * 0.5); }
      if (moving) {
        if (Number.isFinite(c.heading) && c.heading >= 0) newCourse = c.heading;
        else if (dist > Math.max(8, accuracy / 2)) newCourse = bearing(prev, fix);
      }
      // Stationary: pull the position towards the previous one, weighted by accuracy, so the dot stops dancing.
      if (!moving && dist <= Math.max(prev.accuracy, accuracy)) {
        const wOld = SMOOTH_KEEP / (prev.accuracy * prev.accuracy), wNew = 1 / (accuracy * accuracy), k = wNew / (wOld + wNew);
        fix.lat = prev.lat + (fix.lat - prev.lat) * k;
        fix.lng = prev.lng + (fix.lng - prev.lng) * k;
        fix.accuracy = Math.min(accuracy, prev.accuracy * 1.15); // never claims better than the best recent raw fix
      }
    } else if (moving && Number.isFinite(c.heading) && c.heading >= 0) newCourse = c.heading;

    if (newCourse != null) course = { v: course && t - course.ts < HEADING_HOLD_MS ? lerpAngle(course.v, newCourse, 0.6) : newCourse, ts: t };
    const compassOk = compassFresh();
    const gpsHeadingOk = course && t - course.ts < HEADING_HOLD_MS && (moving ? (speedNow ?? 0) >= (compassOk ? COMPASS_UNTIL_SPEED : MOVING_SPEED) : !compassOk);
    if (gpsHeadingOk) { fix.heading = course.v; fix.headingSource = 'gps'; }
    else if (compassOk) { fix.heading = compass.heading; fix.headingSource = 'compass'; }
    if (fix.speed == null && speedNow != null && prev) fix.speed = speedNow; // derived, so consumers can tell walking from riding

    gps = fix;
    remember();
    if (status !== 'ok') status = 'ok';
    emit();
  }

  function remember() { try { store()?.setItem(FLAG_KEY, '1'); } catch { /* ignore */ } }
  const remembered = () => { try { return store()?.getItem(FLAG_KEY) === '1'; } catch { return false; } };

  function onError(err) {
    if (!wanted) return;
    const code = err && err.code;
    if (code === 1) { // PERMISSION_DENIED
      stopWatch();
      gps = null;
      setStatus('denied');
      return;
    }
    if (gps && now() - gps.ts < 5 * 60000) return; // we have something recent; the watch keeps trying
    setStatus(code === 3 ? 'timeout' : 'unavailable');
  }

  // ---- geolocation watch ----
  function stopWatch() {
    const g = nav() && nav().geolocation;
    if (watchId != null && g) { try { g.clearWatch(watchId); } catch { /* ignore */ } }
    watchId = null;
  }
  function begin({ quick = true } = {}) {
    const g = nav() && nav().geolocation;
    if (!g) { setStatus('unavailable'); return; }
    stopWatch();
    if (!gps) setStatus('locating');
    // Fast coarse fix (network / cached) while the real GPS warms up, then the accurate watch.
    if (quick) { try { g.getCurrentPosition(onPosition, (e) => { if (e && e.code === 1) onError(e); }, { enableHighAccuracy: false, maximumAge: 30000, timeout: 8000 }); } catch { /* ignore */ } }
    try { watchId = g.watchPosition(onPosition, onError, { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 }); } catch { setStatus('unavailable'); }
  }

  // ---- permissions ----
  function ensurePermission() {
    if (permPromise) return permPromise;
    permPromise = (async () => {
      try {
        const api = nav() && nav().permissions;
        if (!api || !api.query) return perm;
        let timer;
        const ps = await Promise.race([api.query({ name: 'geolocation' }), new Promise((r) => { timer = setTimeout(r, 1500); })]);
        clearTimeout(timer);
        if (!ps) return perm; // query never answered
        permStatus = ps;
        perm = ps.state;
        ps.onchange = () => onPermission(ps.state);
        onPermission(perm, true);
      } catch { /* Permissions API unsupported for geolocation (older Safari) */ }
      return perm;
    })();
    return permPromise;
  }
  function onPermission(state, initial = false) {
    perm = state;
    if (state === 'denied') {
      stopWatch();
      if (gps) gps = null; // access revoked: forget where we were
      if (status !== 'insecure') setStatus('denied');
      else emit();
    } else if (status === 'denied') {
      if (wanted && !suspended) begin(); // user re-enabled it in the browser settings
      else if (!wanted) setStatus('idle');
    } else if (!initial) emit();
  }

  // ---- visibility ----
  function onVisibility() {
    const hidden = !!doc() && doc().visibilityState === 'hidden';
    if (hidden) {
      if (wanted && !suspended) { suspended = true; stopWatch(); }
      detachCompass();
    } else {
      if (wanted && suspended) { suspended = false; if (status !== 'denied' && status !== 'insecure') begin(); }
      if (compass.on) attachCompass();
    }
  }
  let visBound = false;
  function bindVisibility(on) {
    const d = doc();
    if (!d || !d.addEventListener || on === visBound) return;
    visBound = on;
    if (on) d.addEventListener('visibilitychange', onVisibility); else d.removeEventListener('visibilitychange', onVisibility);
  }

  // ---- compass ----
  const compassFresh = () => compass.on && compass.heading != null && now() - compass.ts < COMPASS_FRESH_MS;
  // Rotation of the screen against the device (0/90/180/270). Sensors report the device's top edge; the user faces the
  // screen's top edge, so a landscape phone needs heading + angle (rotated left = 90: its right edge points ahead).
  function screenAngle() {
    const w = win();
    const a = w && w.screen && w.screen.orientation && w.screen.orientation.angle;
    const v = Number.isFinite(a) ? a : (w && Number.isFinite(w.orientation) ? w.orientation : 0); // window.orientation: -90 = 270
    return normDeg(v);
  }
  // Upright phones report the rear camera axis, which does not depend on how the screen is turned.
  const refreshHeading = () => { compass.heading = compass.raw == null ? null : (compass.flat ? normDeg(compass.raw + screenAngle()) : compass.raw); };
  function emitCompass(t, force) {
    // The compass only wins when we are not driving the heading from GPS; throttle to ~10 Hz and 2°.
    if (!gps || (gps.headingSource === 'gps' && course && t - course.ts < 1500 && (gps.speed ?? 0) >= COMPASS_UNTIL_SPEED)) return;
    if (!force && (t - compass.lastEmit < 100 || (compass.lastEmitted != null && Math.abs(angleDiff(compass.lastEmitted, compass.heading)) < 2))) return;
    compass.lastEmit = t; compass.lastEmitted = compass.heading;
    gps = { ...gps, heading: compass.heading, headingSource: 'compass' };
    emit();
  }
  let orientationEvents = [];
  let screenOrientation = null;
  function onOrientation(e) {
    let hd = null;
    if (Number.isFinite(e.webkitCompassHeading) && e.webkitCompassHeading >= 0) hd = e.webkitCompassHeading;
    else if (e.absolute === true) hd = headingFromEuler(e.alpha, e.beta, e.gamma);
    if (hd == null) return; // relative orientation says nothing about north
    const t = now();
    compass.raw = compass.raw != null && t - compass.ts < 5000 ? lerpAngle(compass.raw, hd, 0.25) : hd;
    compass.flat = !(Number.isFinite(e.beta) && Number.isFinite(e.gamma)) || (Math.abs(e.beta) < 45 && Math.abs(e.gamma) < 45);
    refreshHeading();
    compass.ts = t;
    emitCompass(t, false);
  }
  // The phone was turned: same sensor reading, new screen frame. Push it out at once.
  function onScreenTurn() {
    if (compass.raw == null) return;
    refreshHeading();
    emitCompass(now(), true);
  }
  function attachCompass() {
    const w = win();
    if (!w || !w.addEventListener || orientationEvents.length) return;
    orientationEvents = ['deviceorientationabsolute', 'deviceorientation', 'orientationchange'];
    for (const n of orientationEvents) w.addEventListener(n, n === 'orientationchange' ? onScreenTurn : onOrientation);
    screenOrientation = w.screen && w.screen.orientation && w.screen.orientation.addEventListener ? w.screen.orientation : null;
    if (screenOrientation) screenOrientation.addEventListener('change', onScreenTurn);
  }
  function detachCompass() {
    const w = win();
    for (const n of orientationEvents) w && w.removeEventListener && w.removeEventListener(n, n === 'orientationchange' ? onScreenTurn : onOrientation);
    orientationEvents = [];
    if (screenOrientation) { screenOrientation.removeEventListener('change', onScreenTurn); screenOrientation = null; }
  }

  // ---- public API ----
  const api = {
    get current() { return getCurrent(); },
    get status() { return status; },
    get permission() { return perm; },
    get compassActive() { return compass.on; },
    get compassHeading() { return compassFresh() ? compass.heading : null; },

    start() {
      wanted = true;
      bindVisibility(true);
      if (manual) { manual = null; emit(); } // asking for the real position drops the pinned one
      if (!nav() || !nav().geolocation) { setStatus('unavailable'); return; }
      if (!secure()) { setStatus('insecure'); return; }
      if (watchId != null && (status === 'locating' || status === 'ok')) return; // already running
      if (perm === 'denied') permPromise = null; // re-read it: the user may have changed it in the browser settings
      if (!gps && perm !== 'denied') setStatus('locating');
      if (doc() && doc().visibilityState === 'hidden') { suspended = true; return; }
      suspended = false;
      ensurePermission().then(() => {
        if (!wanted || suspended) return;
        if (perm === 'denied') { setStatus('denied'); return; }
        if (watchId == null) begin();
      });
    },
    stop() {
      wanted = false; suspended = false;
      stopWatch();
      if (!compass.on) bindVisibility(false);
      jump = null; course = null;
      gps = null;
      if (status !== 'insecure') status = perm === 'denied' ? 'denied' : 'idle';
      emit();
    },
    // Start only when no prompt will appear (permission already granted, or granted before on browsers without the Permissions API).
    async autoStart() {
      if (status !== 'idle' || wanted) return wanted;
      if (!secure()) { setStatus('insecure'); return false; }
      const p = await ensurePermission();
      if (status !== 'idle') return false;
      if (p === 'granted' || (p === 'unknown' && remembered())) { api.start(); return true; }
      return false;
    },
    subscribe(fn) {
      subs.add(fn);
      ensurePermission(); // so 'denied' is known up front
      return () => subs.delete(fn);
    },
    setManual(p) {
      if (p == null) manual = null;
      else if (validPoint(p)) manual = { lat: p.lat, lng: p.lng, accuracy: 0, heading: null, speed: null, ts: now(), source: 'manual', headingSource: null };
      else return;
      emit();
    },
    // Resolves with the current fix as soon as there is one (null after `ms`).
    waitForFix(ms = 10000) {
      const cur = getCurrent();
      if (cur) return Promise.resolve(cur);
      return new Promise((resolve) => {
        let off = null;
        const timer = setTimeout(() => { off && off(); resolve(null); }, ms);
        off = api.subscribe((fix) => { if (fix) { clearTimeout(timer); off(); resolve(fix); } });
      });
    },
    // Must be called from a user gesture on iOS (DeviceOrientationEvent.requestPermission).
    async enableCompass() {
      const w = win();
      const DOE = w && w.DeviceOrientationEvent;
      if (!DOE) return false;
      let asked = null;
      if (typeof DOE.requestPermission === 'function') {
        try { asked = DOE.requestPermission(); } catch { return false; } // synchronously, still inside the gesture
      }
      if (asked) { let r; try { r = await asked; } catch { r = 'denied'; } if (r !== 'granted') return false; }
      if (compass.on && compassFresh()) return true;
      compass.on = true;
      bindVisibility(true);
      if (!doc() || doc().visibilityState !== 'hidden') attachCompass();
      const wait = env.compassWaitMs ?? 2000, step = Math.min(50, wait);
      return new Promise((resolve) => {
        let waited = 0;
        const iv = setInterval(() => {
          waited += step;
          if (compassFresh()) { clearInterval(iv); resolve(true); }
          else if (waited >= wait) { clearInterval(iv); api.disableCompass(); resolve(false); }
        }, step);
      });
    },
    disableCompass() {
      compass.on = false; compass.raw = compass.heading = null; compass.lastEmitted = null;
      detachCompass();
      if (!wanted) bindVisibility(false);
      if (gps && gps.headingSource === 'compass') { gps = { ...gps, heading: null, headingSource: null }; emit(); }
    },
  };
  return api;
}

const location = createLocationService();
export default location;
