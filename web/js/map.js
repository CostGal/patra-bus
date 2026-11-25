// Map (owner: shell). MapLibre GL JS 4.7.1 (global `maplibregl`) + OpenFreeMap vector styles.
// Implements the MapApi of the old contract (docs/archive/ARCHITECTURE-rounds-1-4.md) plus a few shell-only extras:
//   available, setFollow(mode), resetNorth(), opts.onUserMove / opts.onBearing / opts.theme.
// Everything custom (sources, layers) is re-added on every `style.load` so theme swaps keep state.
import { icon } from './ui.js';
import { t, onLangChange, lang } from './i18n.js';
import { city } from './cities.js';
import { BASE_STYLE, MAP_FONT, styleFor, addPlaces, setMapLanguage } from './map-style.js';
import { STOP_LAYERS, FULL_ZOOM, addStopLayers, drawStopPin, setSelectedStopFilter, createSelectedStop, stopBearings } from './map-stops.js';
import { loadData, loadShapes } from './data.js';

const noop = () => {};
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const ll = (p) => [p.lng, p.lat];
const okPoint = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && !(p.lat === 0 && p.lng === 0);
const lerp = (a, b, k) => a + (b - a) * k;
const easeOut = (k) => 1 - (1 - k) ** 3;
const metersBetween = (a, b) => {
  const r = Math.PI / 180;
  const x = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lng - a.lng) * r) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(x));
};

function webglOk() {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return !!gl;
  } catch { return false; }
}

// Same shape as the real API, so every caller keeps working (list-only UI) when there is no map.
function fallbackApi(reason) {
  return {
    available: false, reason, ready: Promise.resolve(),
    setStops: noop, setCity: noop, highlightStop: noop, setUserFix: noop, setVehicles: noop, clearVehicles: noop,
    setOverlay: noop, clearOverlay: noop, setMarkers: noop, clearMarkers: noop, flyTo: noop, fitTo: noop,
    setPadding: noop, recenter: noop, setTheme: noop, setFollow: noop, resetNorth: noop, getCenter: () => ({ ...city().center }),
  };
}

// A circle of `r` metres around p as a closed polygon ring.
function circlePolygon(p, r, steps = 64) {
  const ring = [];
  const dLat = r / 111320;
  const dLng = r / (111320 * Math.cos((p.lat * Math.PI) / 180));
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * 2 * Math.PI;
    ring.push([p.lng + dLng * Math.cos(a), p.lat + dLat * Math.sin(a)]);
  }
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } };
}

const el = (cls, html) => {
  const d = document.createElement('div');
  d.className = cls;
  if (html) d.innerHTML = html;
  return d;
};

export function createMap(container, opts = {}) {
  const { onStopClick = noop, onVehicleClick = noop, onMapClick = noop, onLongPress = noop, onStopHold = noop, onUserMove = noop, onBearing = noop } = opts;
  // Floating UI that fitTo / flyTo keep clear of: { top: [selector], right: [selector] }, measured on every call.
  const avoid = { top: opts.avoid?.top || [], right: opts.avoid?.right || [] };
  if (typeof maplibregl === 'undefined') return fallbackApi('script');
  if (!webglOk()) return fallbackApi('webgl');

  let theme = opts.theme === 'dark' ? 'dark' : 'light';
  let map;
  try {
    map = new maplibregl.Map({
      container,
      center: ll(city().center),
      zoom: 14,
      minZoom: 8,
      maxZoom: 19.5,
      attributionControl: false,
      pitchWithRotate: false,
      touchPitch: false,
      dragRotate: true,
      fadeDuration: 120,
    });
  } catch (err) {
    console.warn('[map] init failed', err);
    return fallbackApi('init');
  }
  // Attribution as one line of text that is always there (Kostas, TEL-226; like Apple's "Legal" and Google's logo in
  // the apps that use their maps): no (i) to open. opts.attribInto: the shell's place for it, just above the sheet.
  map.addControl(new maplibregl.AttributionControl({ compact: false }), 'bottom-left');
  const attribEl = container.querySelector('.maplibregl-ctrl-attrib');
  if (attribEl && opts.attribInto) opts.attribInto.append(attribEl);
  const labelCanvas = () => map.getCanvas().setAttribute('aria-label', t('Χάρτης'));
  labelCanvas();
  onLangChange(labelCanvas); // the map outlives a language switch (only the views re-render)
  map.getCanvas().setAttribute('role', 'application');

  let styleReady = false;
  let pad = { top: 0, bottom: 0, left: 0, right: 0 };
  let stopsFc = { type: 'FeatureCollection', features: [] };
  let selected = null;
  let follow = 'off';
  const tracking = () => follow === 'follow' || follow === 'compass';
  const overlays = new Map(); // id -> { fc, style }
  const markerSets = new Map(); // id -> Marker[]
  const vehicleSets = new Map(); // id -> Map(key -> item)

  let resolveReady;
  const ready = new Promise((res) => { resolveReady = res; });
  setTimeout(resolveReady, 10000); // never hang a caller if the style cannot load (offline)

  // ---------- animation ----------
  const anims = new Set();
  let raf = 0;
  function step(now) {
    raf = 0;
    for (const it of anims) {
      const k = Math.min(1, (now - it.t0) / it.dur);
      const e = easeOut(k);
      it.cur = { lat: lerp(it.from.lat, it.to.lat, e), lng: lerp(it.from.lng, it.to.lng, e) };
      it.apply(it.cur);
      if (k >= 1) anims.delete(it);
    }
    if (anims.size) raf = requestAnimationFrame(step);
  }
  function moveItem(it, to, dur) {
    if (!it.cur || reduced() || dur <= 0 || document.hidden) {
      it.cur = it.to = to;
      it.apply(to);
      anims.delete(it);
      return;
    }
    if (it.to && it.to.lat === to.lat && it.to.lng === to.lng) return;
    it.from = it.cur;
    it.to = to;
    it.t0 = performance.now();
    it.dur = dur;
    anims.add(it);
    if (!raf) raf = requestAnimationFrame(step);
  }

  // ---------- (re)build custom sources & layers ----------
  let symbolBefore; // first label layer of the base style: routes and the accuracy ring go underneath it
  const palette = () => (theme === 'dark'
    ? { fill: '#1e2227', stroke: '#8ab4f8', text: '#e8eaed', halo: '#0f1216', accent: '#8ab4f8', casing: '#1e2227', walk: '#8ab4f8' }
    : { fill: '#ffffff', stroke: '#1a73e8', text: '#202124', halo: '#ffffff', accent: '#1a73e8', casing: '#ffffff', walk: '#4a78b8' });

  function addStops() {
    const c = palette();
    addStopLayers(map, stopsFc, theme, selected, { font: MAP_FONT, color: c.text, halo: c.halo });
    showSelected();
  }

  // The tapped stop is drawn on its own (map-stops.js), so it can bounce; its normal icon is hidden meanwhile.
  const selectedStop = createSelectedStop(map, reduced);
  function showSelected(still = false) {
    const f = selected == null ? null : stopsFc.features.find((x) => x.properties.code === selected);
    if (!f) { selectedStop.hide(); return; }
    const [lng, lat] = f.geometry.coordinates;
    selectedStop.show({ code: selected, lng, lat, bearing: f.properties.bearing ?? null }, theme, still);
  }

  // Arrows are worked out once per city, the first time the map is close enough to show them.
  let bearings = null;
  let bearingsFor = null;
  function applyBearings() {
    for (const f of stopsFc.features) {
      const b = bearings?.get(f.properties.code);
      if (b == null) delete f.properties.bearing;
      else f.properties.bearing = b;
    }
  }
  async function loadBearings() {
    const id = city().id;
    if (bearingsFor === id || map.getZoom() < FULL_ZOOM - 0.5) return;
    bearingsFor = id;
    try {
      const [data, shapes] = await Promise.all([loadData(), loadShapes()]);
      if (city().id !== id) return;
      bearings = stopBearings(data, shapes);
      applyBearings();
      if (styleReady) map.getSource('stops')?.setData(stopsFc);
      showSelected();
    } catch (err) {
      bearingsFor = null; // no arrows for now; the plain icon still works
      console.warn('[map] stop directions', err);
    }
  }
  map.on('zoomend', loadBearings);

  // The stop under a tap: the nearest drawn icon within a finger's reach, or the tapped stop itself.
  function stopAt(point) {
    if (!styleReady || !map.getLayer(STOP_LAYERS[0])) return null;
    if (selectedStop.hit(point)) return selectedStop.code();
    const R = 20;
    const hits = map.queryRenderedFeatures([[point.x - R, point.y - R], [point.x + R, point.y + R]], { layers: STOP_LAYERS });
    let code = null;
    let bd = R * R * 2;
    for (const f of hits) {
      const p = map.project(f.geometry.coordinates);
      const d = (p.x - point.x) ** 2 + (p.y - point.y) ** 2;
      if (d < bd) { bd = d; code = String(f.properties.code); }
    }
    return code;
  }

  // Press and hold: is the finger on a stop or on empty map? A finger is wider than a tap target, so the reach is larger.
  // Up close every stop is drawn, so it is measured on the stops themselves; further out only the icons on screen count.
  function stopUnderHold(point) {
    if (selectedStop.hit(point)) return selectedStop.code();
    if (!styleReady || !map.getLayer(STOP_LAYERS[0])) return null;
    const R = 30;
    let code = null;
    let bd = R * R;
    const consider = (c, coords) => {
      const p = map.project(coords);
      const d = (p.x - point.x) ** 2 + (p.y - point.y) ** 2;
      if (d < bd) { bd = d; code = String(c); }
    };
    if (map.getZoom() >= FULL_ZOOM) for (const f of stopsFc.features) consider(f.properties.code, f.geometry.coordinates);
    else for (const f of map.queryRenderedFeatures([[point.x - R, point.y - R], [point.x + R, point.y + R]], { layers: STOP_LAYERS })) consider(f.properties.code, f.geometry.coordinates);
    return code;
  }

  // Tapping a stop (TEL-360): the 1st goes close enough to see its direction, each next one closer up to the map's limit.
  // A double tap goes back to the zoom you started from.
  let tapFocus = null; // { code, start, zoom, back }
  let lastTap = { code: null, at: 0 };
  const TAP_ZOOM = FULL_ZOOM + 0.5;
  const TAP_MORE = 1.5;
  const TAP_MAX = 19.5;
  const DOUBLE_TAP_MS = 420;
  const DOUBLE_TAP_PX = 48;
  const recentTapCode = () => (performance.now() - lastTap.at < DOUBLE_TAP_MS + 400 ? lastTap.code : null);
  const stopPoint = (code) => {
    const f = stopsFc.features.find((x) => x.properties.code === code);
    return f ? { lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] } : null;
  };
  function tapStop(code) {
    const now = map.getZoom();
    lastTap = { code, at: performance.now() };
    if (tapFocus?.code !== code || tapFocus.back) {
      const open = code === selected; // already open (from a list or a link): the route will not run again
      tapFocus = { code, start: now, zoom: Math.max(now, TAP_ZOOM) };
      if (open) api.flyTo(stopPoint(code));
      else onStopClick(code);
      return;
    }
    tapFocus.zoom = Math.min((map.isMoving() ? tapFocus.zoom : now) + TAP_MORE, TAP_MAX);
    api.flyTo(stopPoint(code));
  }
  // Kept (with back: true) so the stop view that is still opening aims at this zoom too.
  function tapBack(code) {
    lastTap = { code: null, at: 0 };
    if (tapFocus?.code !== code) return;
    tapFocus = { code, start: tapFocus.start, zoom: tapFocus.start, back: true };
    api.flyTo(stopPoint(code));
  }

  const userAcc = { type: 'FeatureCollection', features: [] };
  function addUserAccuracy() {
    const c = palette();
    map.addSource('user-acc', { type: 'geojson', data: userAcc });
    const before = symbolBefore;
    map.addLayer({ id: 'user-acc-fill', type: 'fill', source: 'user-acc', paint: { 'fill-color': c.accent, 'fill-opacity': 0.14 } }, before);
    map.addLayer({ id: 'user-acc-line', type: 'line', source: 'user-acc', paint: { 'line-color': c.accent, 'line-opacity': 0.35, 'line-width': 1 } }, before);
  }

  const widthExpr = (w) => ['interpolate', ['exponential', 1.5], ['zoom'], 10, w * 0.35, 15, w, 19, w * 2.2];
  function addOverlay(id) {
    const o = overlays.get(id);
    if (!o) return;
    const c = palette();
    const src = `ov-${id}`;
    const before = symbolBefore;
    const lineFilter = ['in', ['geometry-type'], ['literal', ['LineString', 'MultiLineString']]];
    map.addSource(src, { type: 'geojson', data: o.fc });
    const color = o.style.color || c.accent;
    if (o.style.kind === 'walk') {
      const walk = o.style.color || c.walk;
      map.addLayer({
        id: `${src}-casing`, type: 'line', source: src, filter: lineFilter,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': c.casing, 'line-width': widthExpr(7.5), 'line-dasharray': [0.01, 1.7] },
      }, before);
      map.addLayer({
        id: `${src}-line`, type: 'line', source: src, filter: lineFilter,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': walk, 'line-width': widthExpr(4.5), 'line-dasharray': [0.01, 1.7] },
      }, before);
    } else {
      const w = o.style.kind === 'ride' ? 7 : 5;
      map.addLayer({
        id: `${src}-casing`, type: 'line', source: src, filter: lineFilter,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': c.casing, 'line-width': widthExpr(w + 4), 'line-opacity': 0.95 },
      }, before);
      map.addLayer({
        id: `${src}-line`, type: 'line', source: src, filter: lineFilter,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': color, 'line-width': widthExpr(w), ...(o.style.estimated ? { 'line-opacity': 0.55 } : {}) }, // a guessed stop order (TEL-295)
      }, before);
    }
  }
  function removeOverlayFromMap(id) {
    const src = `ov-${id}`;
    for (const l of [`${src}-line`, `${src}-casing`]) if (map.getLayer(l)) map.removeLayer(l);
    if (map.getSource(src)) map.removeSource(src);
  }

  function rebuild() {
    styleReady = true;
    addPlaces(map, theme, lang());
    symbolBefore = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
    addUserAccuracy();
    for (const id of overlays.keys()) addOverlay(id);
    addStops();
    resolveReady();
  }
  map.on('style.load', rebuild);
  // Our look (map-style.js) is applied to the provider's style each time it loads. diff: false, a theme swap starts clean.
  const loadStyle = () => map.setStyle(BASE_STYLE, { diff: false, transformStyle: (_, next) => styleFor(next, theme, lang()) });
  loadStyle();
  onLangChange(() => { if (styleReady) setMapLanguage(map, lang()); });

  // ---------- events ----------
  let lastLong = 0;
  let suppressClickUntil = 0;
  function triggerLong(lngLat, held = stopUnderHold(map.project(lngLat))) {
    if (Date.now() - lastLong < 900) return;
    lastLong = Date.now();
    navigator.vibrate?.(12);
    if (held != null) { onStopHold(held); return; }
    onLongPress({ lat: lngLat.lat, lng: lngLat.lng });
  }

  let touches = []; // fingers that went down and may still become a click, oldest first
  let lastDown = null;
  map.on('click', (e) => {
    const down = touches.shift(); // the finger that made this click
    if (Date.now() < suppressClickUntil) return;
    if (down?.double && down.code != null) { tapBack(down.code); return; } // the stop may have moved from under the finger
    const code = stopAt(e.point);
    if (code != null) { tapStop(code); return; }
    onMapClick({ lat: e.lngLat.lat, lng: e.lngLat.lng });
  });
  map.on('mousemove', (e) => {
    if (!styleReady) return;
    map.getCanvas().style.cursor = stopAt(e.point) != null ? 'pointer' : '';
  });
  map.on('contextmenu', (e) => triggerLong(e.lngLat));

  // Touch long press (~500 ms, cancelled by movement or a second finger).
  // Immediate visual feedback on pointerdown (DESIGN.md §1): a dot that grows for the whole 500 ms wait,
  // so the press itself is visible, not only the result once it fires.
  const cc = map.getCanvasContainer();
  let lp = null;
  let lpDot = null;
  let fired = false; // a long press just fired: swallow the click that follows the release
  function lpShow(x, y, rect) {
    lpDot = el('lp-dot');
    Object.assign(lpDot.style, {
      position: 'absolute', left: `${x - rect.left}px`, top: `${y - rect.top}px`, width: '14px', height: '14px',
      margin: '-7px 0 0 -7px', borderRadius: '50%', background: palette().accent, opacity: '.45', pointerEvents: 'none', zIndex: '5',
    });
    cc.appendChild(lpDot);
    if (!reduced()) lpDot.animate([{ transform: 'scale(.6)', opacity: .5 }, { transform: 'scale(2.2)', opacity: 0 }], { duration: 500, easing: 'linear', fill: 'forwards' });
  }
  function lpHide() { lpDot?.remove(); lpDot = null; }
  const lpCancel = () => { if (lp) { clearTimeout(lp.timer); lp = null; } lpHide(); };
  // On a stop a double tap is ours (back to the starting zoom); anywhere else it is the map's usual zoom in.
  cc.addEventListener('pointerdown', (e) => {
    if (!e.isPrimary) return;
    const box = cc.getBoundingClientRect();
    const near = lastDown && e.timeStamp - lastDown.t < DOUBLE_TAP_MS && Math.hypot(e.clientX - lastDown.x, e.clientY - lastDown.y) < DOUBLE_TAP_PX;
    const code = near ? recentTapCode() : null;
    const double = code != null;
    lastDown = near ? null : { t: e.timeStamp, x: e.clientX, y: e.clientY };
    touches = touches.filter((x) => e.timeStamp - x.t < 1000);
    touches.push({ t: e.timeStamp, x: e.clientX, y: e.clientY, double, code });
    if (double || stopAt({ x: e.clientX - box.left, y: e.clientY - box.top }) != null) map.doubleClickZoom.disable();
    else map.doubleClickZoom.enable();
  }, { passive: true, capture: true });
  // The finger slid: a drag, so it will not be a click.
  cc.addEventListener('pointermove', (e) => {
    const last = touches[touches.length - 1];
    if (last && Math.hypot(e.clientX - last.x, e.clientY - last.y) > 10) touches.pop();
  }, { passive: true });
  // Decided when the finger lands, on what was on screen then, with the same point the map gives a tap.
  map.on('touchstart', (e) => { if (lp && e.points?.length === 1) lp.stop = stopUnderHold(e.point); });
  cc.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    if (!e.isPrimary) { lpCancel(); return; }
    const rect = cc.getBoundingClientRect();
    lpShow(e.clientX, e.clientY, rect);
    lp = {
      x: e.clientX, y: e.clientY,
      timer: setTimeout(() => {
        const pt = lp;
        lp = null;
        if (!pt) return;
        fired = true;
        const at = map.unproject([pt.x - rect.left, pt.y - rect.top]);
        if (pt.stop !== undefined) triggerLong(at, pt.stop);
        else triggerLong(at);
      }, 500),
    };
  }, { passive: true });
  cc.addEventListener('pointermove', (e) => {
    if (lp && Math.hypot(e.clientX - lp.x, e.clientY - lp.y) > 10) lpCancel();
  }, { passive: true });
  const lpEnd = () => {
    lpCancel();
    if (fired) { fired = false; suppressClickUntil = Date.now() + 500; }
  };
  cc.addEventListener('pointerup', lpEnd, { passive: true });
  cc.addEventListener('pointercancel', lpEnd, { passive: true });
  map.on('movestart', lpCancel);

  // Panning by hand ends any follow mode.
  map.on('dragstart', (e) => {
    if (e.originalEvent && follow !== 'off') { follow = 'off'; onUserMove(); }
  });
  map.on('movestart', (e) => { if (e.originalEvent) lastFit = null; });
  map.on('rotate', () => onBearing(map.getBearing()));
  // Window / phone rotation: the floating UI moved, so fit again (debounced; any gesture has already forgotten the fit).
  let refitTimer = 0;
  map.on('resize', () => {
    if (!lastFit) return;
    clearTimeout(refitTimer);
    refitTimer = setTimeout(() => { if (lastFit) doFit(); }, 150);
  });
  map.on('moveend', () => { if (tracking()) snapToUser(false); });

  // ---------- user fix ----------
  const userEl = el('user-mk');
  userEl.innerHTML = '<div class="user-cone"><svg viewBox="0 0 80 80" aria-hidden="true"><defs><radialGradient id="ucg" cx="50%" cy="50%" r="50%"><stop offset="12%" stop-color="currentColor" stop-opacity=".55"/><stop offset="100%" stop-color="currentColor" stop-opacity="0"/></radialGradient></defs><path d="M40 40 L20 5.4 A40 40 0 0 1 60 5.4 Z" fill="url(#ucg)"/></svg></div><div class="user-dot"></div>';
  const coneEl = userEl.querySelector('.user-cone');
  userEl.setAttribute('role', 'img');
  userEl.setAttribute('aria-label', t('Η θέση σου'));
  const userMarker = new maplibregl.Marker({ element: userEl, rotationAlignment: 'map', pitchAlignment: 'map' });
  let userOn = false;
  let userAccuracy = 0;
  let userHeadingAcc = null;
  let userHeading = null;
  const userItem = {
    cur: null, to: null,
    apply(p) {
      userMarker.setLngLat(ll(p));
      if (userAccuracy > 0) {
        userAcc.features = [circlePolygon(p, Math.min(userAccuracy, 3000))];
        if (styleReady) map.getSource('user-acc')?.setData(userAcc);
      }
      if (tracking()) snapToUser(true);
    },
  };
  // jumpTo fires moveend synchronously, hence the re-entrancy guard.
  let snapping = false;
  function snapToUser(unlessMoving) {
    if (snapping || !userItem.cur || (unlessMoving && map.isMoving())) return;
    snapping = true;
    try { map.jumpTo({ center: ll(userItem.cur), padding: pad }); } finally { snapping = false; }
  }
  function setHeading(h) {
    if (h == null || !Number.isFinite(h)) { coneEl.classList.remove('on'); userHeading = null; return; }
    if (userHeadingAcc == null) userHeadingAcc = h;
    else userHeadingAcc += ((h - userHeadingAcc + 540) % 360) - 180; // shortest way round
    userHeading = h;
    coneEl.style.transform = `rotate(${userHeadingAcc}deg)`;
    coneEl.classList.add('on');
  }

  // ---------- vehicles ----------
  // A vehicle that carries vehicleCode + routeCode is a button (opens its route); others are plain pictures.
  const tappable = (v) => !!(v.vehicleCode && v.routeCode);
  function paintVehA11y(d, v) {
    const on = tappable(v);
    d.classList.toggle('veh-click', on);
    if (on) {
      d.setAttribute('role', 'button');
      d.setAttribute('tabindex', '0');
      d.setAttribute('aria-label', t('Γραμμή {code}: δες τη διαδρομή του οχήματος', { code: v.lineCode }));
    } else {
      d.setAttribute('role', 'img');
      d.removeAttribute('tabindex');
      d.setAttribute('aria-label', v.label ? t('Γραμμή {code}, {label}', { code: v.lineCode, label: v.label }) : t('Γραμμή {code}', { code: v.lineCode }));
    }
  }
  function vehEl(v) {
    const d = el('veh');
    d.style.setProperty('--c', v.color || '#757575');
    d.style.setProperty('--t', v.textColor || '#fff');
    paintVehA11y(d, v);
    const b = el('veh-badge');
    b.textContent = String(v.lineCode ?? '');
    d.append(el('veh-ring'), b);
    return d;
  }
  // The ring pulses a couple of beats and rests (app.css, TEL-304); a new position plays it again.
  function pingVeh(node) {
    for (const a of node.querySelector('.veh-ring')?.getAnimations?.() ?? []) { a.currentTime = 0; a.play(); }
  }
  const pickKey = (v) => v.key ?? v.vehicleCode ?? v.id ?? null;
  function updateVehEl(it, v) {
    it.node.style.setProperty('--c', v.color || '#757575');
    it.node.style.setProperty('--t', v.textColor || '#fff');
    it.lineCode = String(v.lineCode);
    it.data = v;
    paintVehA11y(it.node, v);
  }

  // ---------- markers ----------
  const PIN_SVG = (fill) => `<svg viewBox="0 0 32 40" width="32" height="40" aria-hidden="true"><path d="M16 1C8 1 2 7.2 2 15c0 10 14 24 14 24s14-14 14-24C30 7.2 24 1 16 1z" fill="${fill}" stroke="#fff" stroke-width="2"/><circle cx="16" cy="15" r="5" fill="#fff"/></svg>`;
  function markerEl(m) {
    const d = el(`mk mk-${m.kind}`);
    if (m.kind === 'dest' || m.kind === 'pin') {
      d.innerHTML = PIN_SVG(m.kind === 'dest' ? '#d93025' : '#ea4335');
    } else if (m.kind === 'board' || m.kind === 'alight') {
      d.append(icon('bus'));
    } else {
      d.append(el('mk-origin-dot'));
    }
    if (m.label) {
      const t = el('mk-label');
      t.textContent = m.label;
      d.append(t);
      d.setAttribute('role', 'img');
      d.setAttribute('aria-label', m.label);
    } else {
      d.setAttribute('aria-hidden', 'true');
    }
    return d;
  }

  // ---------- camera helpers ----------
  // How far the visible floating elements (the ☰ and the offline note on top, the FAB column on the right) reach into the map.
  const GAP = 8;
  function floatingInsets() {
    const mr = container.getBoundingClientRect();
    const out = { top: 0, right: 0 };
    const shown = (sel) => [...document.querySelectorAll(sel)].map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
    for (const r of avoid.top.flatMap(shown)) out.top = Math.max(out.top, r.bottom - mr.top + GAP);
    for (const r of avoid.right.flatMap(shown)) if (r.left > mr.left + mr.width / 2) out.right = Math.max(out.right, mr.right - r.left + GAP);
    return out;
  }
  const safePadding = () => {
    const w = container.clientWidth;
    const hgt = container.clientHeight;
    const f = floatingInsets();
    const cl = (a, b, max) => { const s = a + b; const k = s > max ? max / s : 1; return [a * k, b * k]; };
    const [top, bottom] = cl(Math.max(pad.top, f.top), pad.bottom, hgt * 0.7);
    const [left, right] = cl(pad.left, Math.max(pad.right, f.right), w * 0.7);
    return { top, bottom, left, right };
  };

  // Last fitTo(), replayed when the padding changes; any camera call or user gesture forgets it.
  let lastFit = null;
  function doFit() {
    const { pts, o } = lastFit;
    const maxZoom = o.maxZoom ?? 17;
    if (pts.length === 1) { const keep = lastFit; api.flyTo(pts[0], maxZoom); lastFit = keep; return; }
    const b = new maplibregl.LngLatBounds(ll(pts[0]), ll(pts[0]));
    for (const p of pts) b.extend(ll(p));
    const sp = safePadding();
    const m = 28; // breathing room around the points
    // Nothing visible left once the padding is taken off (hidden / collapsing layout): the next resize or snap refits.
    if (container.clientWidth - sp.left - sp.right - 2 * m < 40 || container.clientHeight - sp.top - sp.bottom - 2 * m - 24 < 40) return;
    // Zoom from cameraForBounds (with a margin), but centre with the real padding ourselves: letting fitBounds apply
    // the padding itself double-counts it and pushes points under the sheet.
    try {
      const cam = map.cameraForBounds(b, {
        padding: { top: sp.top + m + 24, bottom: sp.bottom + m, left: sp.left + m, right: sp.right + m }, maxZoom, // +24 on top: pins grow upwards from their tip
      });
      if (!cam) throw new Error('no fit');
      map.easeTo({ center: b.getCenter(), zoom: cam.zoom, bearing: map.getBearing(), padding: sp, duration: 700, essential: false });
    } catch { map.fitBounds(b, { maxZoom, duration: 0 }); }
  }

  // ---------- public API ----------
  const api = {
    available: true,
    ready,
    _map: map, // debugging only

    setStops(stops) {
      stopsFc = {
        type: 'FeatureCollection',
        features: (stops || []).filter(okPoint).map((s) => ({
          type: 'Feature', geometry: { type: 'Point', coordinates: ll(s) },
          properties: { code: String(s.code), name: s.displayName || s.name || '', lines: s.lineCodes?.length || 0 },
        })),
      };
      applyBearings();
      if (styleReady) map.getSource('stops')?.setData(stopsFc);
      showSelected();
      loadBearings();
    },

    // Live city switch (TEL-347): drop everything of the old city, show the new stops, move to the new centre.
    setCity(stops) {
      for (const id of [...overlays.keys()]) api.clearOverlay(id);
      for (const id of [...markerSets.keys()]) api.clearMarkers(id);
      for (const id of [...vehicleSets.keys()]) api.clearVehicles(id);
      api.highlightStop(null);
      tapFocus = null;
      bearings = null;
      bearingsFor = null;
      api.setStops(stops);
      lastFit = null;
      map.flyTo({ center: ll(city().center), zoom: 14, speed: 1.6, essential: false });
    },

    highlightStop(code, { still = false } = {}) {
      const next = code == null ? null : String(code);
      if (tapFocus && (next != null ? next !== tapFocus.code : selected === tapFocus.code)) tapFocus = null;
      selected = next;
      if (styleReady) setSelectedStopFilter(map, selected);
      showSelected(still);
    },
    // Where the boot logo lands (TEL-365): the open stop's big icon. It is placed even while the map's tiles still load.
    selectedPin: () => selectedStop.rect(),

    setUserFix(fix) {
      if (!fix || !okPoint(fix)) {
        if (userOn) { userMarker.remove(); userOn = false; }
        userItem.cur = userItem.to = null;
        userAcc.features = [];
        if (styleReady) map.getSource('user-acc')?.setData(userAcc);
        return;
      }
      const manual = fix.source === 'manual';
      userEl.classList.toggle('manual', manual);
      userAccuracy = manual ? 0 : (fix.accuracy || 0);
      if (!userAccuracy) { userAcc.features = []; if (styleReady) map.getSource('user-acc')?.setData(userAcc); }
      setHeading(manual ? null : fix.heading);
      if (!userOn) { userMarker.setLngLat(ll(fix)).addTo(map); userOn = true; }
      const p = { lat: fix.lat, lng: fix.lng };
      // big jumps (first fix, manual placement) are instant; small ones glide
      const far = !userItem.cur || metersBetween(userItem.cur, p) > 300;
      moveItem(userItem, p, far ? 0 : 700);
      if (follow === 'compass' && userHeading != null && !map.isMoving()) map.easeTo({ bearing: userHeading, duration: 400, essential: false });
    },

    // Vehicles are matched between updates by `key` (or `vehicleCode` / `id`) when given, otherwise by the nearest
    // unclaimed marker of the same line (<= 800 m), so a bus glides instead of teleporting.
    setVehicles(id, list) {
      const set = vehicleSets.get(id) || new Map();
      const next = new Map();
      const claimed = new Set();
      for (const v of (list || []).filter(okPoint)) {
        const p = { lat: v.lat, lng: v.lng };
        const given = pickKey(v);
        let key = given != null ? String(given) : null;
        let it = key != null ? set.get(key) : null;
        if (!it && key == null) {
          let bd = 800;
          for (const [k, cand] of set) {
            if (claimed.has(k) || cand.explicit || cand.lineCode !== String(v.lineCode)) continue;
            const d = metersBetween(cand.cur, p);
            if (d < bd) { bd = d; key = k; it = cand; }
          }
        }
        if (it) {
          if (metersBetween(it.to, p) > 1) pingVeh(it.node);
          updateVehEl(it, v);
          moveItem(it, p, 4000);
        } else {
          const node = vehEl(v);
          const marker = new maplibregl.Marker({ element: node, anchor: 'center' }).setLngLat(ll(p)).addTo(map);
          it = { node, marker, data: v, lineCode: String(v.lineCode), explicit: given != null, cur: p, to: p, apply(q) { marker.setLngLat(ll(q)); } };
          paintVehA11y(node, v); // Marker.addTo() stamps its own generic aria-label
          const open = (e) => { if (!tappable(it.data)) return; e.stopPropagation(); onVehicleClick(it.data); };
          node.addEventListener('click', open);
          node.addEventListener('pointerdown', (e) => { if (tappable(it.data)) e.stopPropagation(); }); // not a map drag / long press
          node.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(e); } });
          key ??= `auto-${Math.random().toString(36).slice(2)}`;
        }
        claimed.add(key);
        next.set(key, it);
      }
      for (const [k, it] of set) if (!next.has(k)) { it.marker.remove(); anims.delete(it); }
      vehicleSets.set(id, next);
    },
    clearVehicles(id) {
      const set = vehicleSets.get(id);
      if (!set) return;
      for (const it of set.values()) { it.marker.remove(); anims.delete(it); }
      vehicleSets.delete(id);
    },

    setOverlay(id, fc, style = {}) {
      if (styleReady) removeOverlayFromMap(id);
      overlays.set(id, { fc, style: { kind: style.kind || 'route', color: style.color, estimated: !!style.estimated } });
      if (styleReady) addOverlay(id);
    },
    clearOverlay(id) {
      if (styleReady) removeOverlayFromMap(id);
      overlays.delete(id);
    },

    setMarkers(id, list) {
      api.clearMarkers(id);
      const ms = (list || []).filter(okPoint).map((m) =>
        new maplibregl.Marker({ element: markerEl(m), anchor: m.kind === 'dest' || m.kind === 'pin' ? 'bottom' : 'center' }).setLngLat(ll(m)).addTo(map));
      markerSets.set(id, ms);
    },
    clearMarkers(id) {
      for (const m of markerSets.get(id) || []) m.remove();
      markerSets.delete(id);
    },

    // A picture of the map around a stop with the stop drawn on it, for the hold menu: { canvas, screen }, or null.
    stopPicture(code, w, h) {
      const p = stopPoint(code);
      if (!p) return Promise.resolve(null);
      const f = stopsFc.features.find((x) => x.properties.code === code);
      const arrow = f?.properties.bearing != null && map.getZoom() >= FULL_ZOOM ? f.properties.bearing - map.getBearing() : null;
      const shot = () => new Promise((done) => {
        function finish(withMap) {
          const src = map.getCanvas();
          const k = src.width / src.clientWidth;
          const pt = map.project([p.lng, p.lat]);
          const left = Math.max(0, Math.min(src.clientWidth - w, pt.x - w / 2));
          const top = Math.max(0, Math.min(src.clientHeight - h, pt.y - h / 2 - 26)); // the icon stands above the spot
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(w * k);
          canvas.height = Math.round(h * k);
          const x = canvas.getContext('2d');
          if (withMap) x.drawImage(src, left * k, top * k, w * k, h * k, 0, 0, canvas.width, canvas.height);
          x.scale(k, k);
          drawStopPin(x, Math.max(30, Math.min(w - 30, pt.x - left)), Math.max(72, Math.min(h - 12, pt.y - top)), theme, arrow);
          const r = container.getBoundingClientRect();
          done({ canvas, screen: { x: r.left + pt.x, y: r.top + pt.y } });
        }
        const timer = setTimeout(() => { map.off('render', draw); finish(false); }, 400);
        function draw() {
          clearTimeout(timer);
          map.off('render', draw);
          finish(true);
        }
        map.on('render', draw);
        map.triggerRepaint();
      });
      // The stop's small icon leaves the map for the picture, so only the big one shows; then it comes back.
      setSelectedStopFilter(map, code);
      const hidden = new Promise((go) => { map.once('idle', go); setTimeout(go, 320); });
      map.triggerRepaint();
      return hidden.then(shot).then((picture) => {
        setSelectedStopFilter(map, selected);
        return picture;
      });
    },

    flyTo(p, zoom, { instant = false } = {}) {
      if (!okPoint(p)) return;
      lastFit = null;
      const tapped = tapFocus && stopPoint(tapFocus.code);
      const onTapped = tapped && tapped.lat === p.lat && tapped.lng === p.lng;
      const z = onTapped ? tapFocus.zoom : zoom ?? Math.max(map.getZoom(), 16);
      const far = metersBetween(api.getCenter(), p) > 4000;
      const o = { center: ll(p), zoom: z, padding: safePadding(), essential: false };
      if (instant) map.jumpTo({ center: o.center, zoom: z, padding: o.padding }); // under the boot screen (TEL-365)
      else if (far) map.flyTo({ ...o, speed: 1.4 });
      else map.easeTo({ ...o, duration: 600 });
    },
    fitTo(points, o = {}) {
      const pts = (points || []).filter(okPoint);
      if (!pts.length) return;
      lastFit = { pts, o };
      doFit();
    },
    // Glides the point (default: the user's location, if known) to the centre of the part of the map left clear, at the
    // same zoom: the sheet moving between low and mid (app.js)
    recenter(p) {
      const to = p || userItem.cur;
      if (!okPoint(to)) return;
      lastFit = null;
      map.easeTo({ center: ll(to), padding: safePadding(), duration: 450, essential: false });
    },
    setPadding(p) {
      pad = { top: 0, bottom: 0, left: 0, right: 0, ...p };
      // Kept for the next fit or fly only: the map stays still when the sheet moves (Kostas, TEL-222: only a touch on
      // the map moves the map)
    },

    setTheme(t) {
      const next = t === 'dark' ? 'dark' : 'light';
      if (next === theme) return;
      theme = next;
      styleReady = false;
      loadStyle();
    },
    getCenter() {
      // centre of the part of the map that is not under the sheet / top bar
      const w = container.clientWidth;
      const hgt = container.clientHeight;
      const c = map.unproject([pad.left + (w - pad.left - pad.right) / 2, pad.top + (hgt - pad.top - pad.bottom) / 2]);
      return { lat: c.lat, lng: c.lng };
    },

    // ---- shell extras ----
    // 'off' | 'centre' (one-shot) | 'follow' (keep the user centred, north up) | 'compass' (also rotate to heading)
    setFollow(mode) {
      const prev = follow;
      follow = mode;
      lastFit = null;
      if (mode === 'off') {
        if (prev === 'compass' && Math.abs(map.getBearing()) > 1) map.easeTo({ bearing: 0, duration: 400, essential: false });
        return;
      }
      if (!userItem.cur) return;
      const o = { center: ll(userItem.cur), padding: pad, duration: 600, essential: false };
      if (map.getZoom() < 15.5) o.zoom = 16.5;
      if (mode === 'compass' && userHeading != null) o.bearing = userHeading;
      else if (prev === 'compass' || mode === 'follow') o.bearing = 0;
      map.easeTo(o);
    },
    resetNorth() { map.easeTo({ bearing: 0, duration: 400, essential: false }); },
  };

  map.on('error', (e) => { if (e?.error?.status || e?.error?.message) console.warn('[map]', e.error.message || e.error); });
  return api;
}
