// Stops on the map (TEL-360): a rounded bus icon at every zoom, a direction arrow up close, and a bounce when tapped.
// Zoom: below 15 small and thinned out (the stops with the most lines stay), 15 to 16.4 bigger, 16.5 and up every stop
// with its arrow and name. The arrow comes from data we already ship (routes + shapes): no request to citybus.

export const STOP_LAYERS = ['stops-icon', 'stops-icon-all'];
const ARROW_LAYER = 'stops-arrow';
const LABEL_LAYER = 'stops-label';
export const FULL_ZOOM = 16.5;

const COLORS = {
  light: { fill: '#17566a', bus: '#fff6e3', edge: null },
  dark: { fill: '#2b73cc', bus: '#fff6e3', edge: '#f2e4c4' },
};
const colorsFor = (theme) => COLORS[theme === 'dark' ? 'dark' : 'light'];

// ---------- direction (pure) ----------
const DEG = Math.PI / 180;
const NEAR_M = 35; // a stop further than this from its route's road is not on it
const CHORD_M = 18; // the road's direction is measured this far before and after the stop
const AGREE_DEG = 30;
const AGREE_SHARE = 0.7; // near a junction the routes disagree: no arrow, the plain icon

const angleBetween = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
const bearingOf = (dx, dy) => (Math.atan2(dx, dy) / DEG + 360) % 360;
const toXY = (p, o) => [(p[0] - o.lng) * 111320 * Math.cos(o.lat * DEG), (p[1] - o.lat) * 110540];

function pointAlong(shape, cum, m) {
  const at = Math.max(0, Math.min(cum[cum.length - 1], m));
  let i = 0;
  while (i < cum.length - 2 && cum[i + 1] < at) i++;
  const k = (at - cum[i]) / (cum[i + 1] - cum[i] || 1);
  return [shape[i][0] + (shape[i + 1][0] - shape[i][0]) * k, shape[i][1] + (shape[i + 1][1] - shape[i][1]) * k];
}

// Walks the route's stops in order along its road, so a road that passes a stop twice is read the right way.
function routeBearings(route, shape, stopByCode, add) {
  const first = stopByCode.get(route.stops[0]);
  if (!first || shape.length < 2) return;
  const cum = [0];
  for (let i = 1; i < shape.length; i++) {
    const a = toXY(shape[i - 1], first);
    const b = toXY(shape[i], first);
    cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  let from = 0;
  for (const code of route.stops) {
    const s = stopByCode.get(code);
    if (!s) continue;
    let best = null;
    for (let i = from; i < shape.length - 1; i++) {
      const a = toXY(shape[i], s);
      const b = toXY(shape[i + 1], s);
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const len2 = dx * dx + dy * dy;
      if (!len2) continue;
      const k = Math.max(0, Math.min(1, -(a[0] * dx + a[1] * dy) / len2));
      const d = Math.hypot(a[0] + k * dx, a[1] + k * dy);
      if (d <= NEAR_M && (!best || d < best.d - 0.5)) best = { d, i, m: cum[i] + k * Math.sqrt(len2) };
      else if (best && cum[i] - best.m > 150) break;
    }
    if (!best) continue;
    from = best.i;
    const p = toXY(pointAlong(shape, cum, best.m - CHORD_M), s);
    const q = toXY(pointAlong(shape, cum, best.m + CHORD_M), s);
    if (Math.hypot(q[0] - p[0], q[1] - p[1]) >= 8) add(code, bearingOf(q[0] - p[0], q[1] - p[1]));
  }
}

// Map(stop code -> degrees from north). A stop is left out when its direction is unclear.
export function stopBearings(data, shapes) {
  const seen = new Map();
  const add = (code, b) => (seen.get(code) || seen.set(code, []).get(code)).push(b);
  for (const r of data.routes) {
    if (r.confidence >= 0.5 && shapes?.[r.code]) routeBearings(r, shapes[r.code], data.stopByCode, add);
  }
  const out = new Map();
  for (const [code, list] of seen) {
    let group = [];
    for (const b of list) {
      const g = list.filter((v) => angleBetween(v, b) <= AGREE_DEG);
      if (g.length > group.length) group = g;
    }
    if (group.length / list.length < AGREE_SHARE) continue;
    const x = group.reduce((v, b) => v + Math.sin(b * DEG), 0);
    const y = group.reduce((v, b) => v + Math.cos(b * DEG), 0);
    out.set(code, Math.round(bearingOf(x, y)) % 360);
  }
  return out;
}

// ---------- drawing ----------
function drawStop(x, size, c, simple) {
  const u = size / 32;
  x.save();
  x.scale(u, u);
  x.beginPath();
  x.roundRect(2, 2, 28, 28, 8);
  x.fillStyle = c.fill;
  x.fill();
  if (c.edge) { x.lineWidth = 1.6; x.strokeStyle = c.edge; x.stroke(); }
  x.fillStyle = c.bus;
  x.beginPath();
  x.roundRect(8.5, 7.5, 15, 15.5, 3);
  x.fill();
  x.fillRect(10, 23, 3, 2);
  x.fillRect(19, 23, 3, 2);
  x.fillStyle = c.fill;
  x.fillRect(10.5, 10, 11, simple ? 6 : 5.5);
  if (!simple) {
    x.beginPath();
    x.arc(12.5, 19.5, 1.3, 0, Math.PI * 2);
    x.arc(19.5, 19.5, 1.3, 0, Math.PI * 2);
    x.fill();
  }
  x.restore();
}

function stopCanvas(theme, simple, px = 64) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = px;
  drawStop(canvas.getContext('2d'), px, colorsFor(theme), simple);
  return canvas;
}

function arrowCanvas(theme) {
  const c = colorsFor(theme);
  const canvas = document.createElement('canvas');
  canvas.width = 28;
  canvas.height = 20;
  const x = canvas.getContext('2d');
  x.beginPath();
  x.moveTo(14, 2);
  x.lineTo(26, 18);
  x.lineTo(2, 18);
  x.closePath();
  x.lineJoin = 'round';
  x.lineWidth = 3;
  x.strokeStyle = c.bus;
  x.stroke();
  x.fillStyle = c.fill;
  x.fill();
  return canvas;
}

function putImage(map, name, canvas) {
  if (map.hasImage(name)) map.removeImage(name);
  map.addImage(name, canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height), { pixelRatio: 2 });
}

const SIZE_STOPS = [11, 0.42, 14.9, 0.54, 15, 0.68, 16.4, 0.78, FULL_ZOOM, 0.94, 19, 1.08];
const ICON_SIZE = ['interpolate', ['linear'], ['zoom'], ...SIZE_STOPS];

// The icon's size in CSS px at a zoom, the same curve as the map layers (for the tapped stop).
export function stopIconPx(zoom) {
  const s = SIZE_STOPS;
  if (zoom <= s[0]) return s[1] * 32;
  for (let i = 2; i < s.length; i += 2) {
    if (zoom <= s[i]) return (s[i - 1] + ((zoom - s[i - 2]) / (s[i] - s[i - 2])) * (s[i + 1] - s[i - 1])) * 32;
  }
  return s[s.length - 1] * 32;
}

const notSelected = (code) => ['!=', ['get', 'code'], code ?? ''];

// Call on every style load: a new style starts with no images. Added last, so stops sit above place names.
export function addStopLayers(map, fc, theme, selected, text) {
  putImage(map, 'tel-stop', stopCanvas(theme, false));
  putImage(map, 'tel-stop-small', stopCanvas(theme, true));
  putImage(map, 'tel-stop-arrow', arrowCanvas(theme));
  map.addSource('stops', { type: 'geojson', data: fc });
  const filter = notSelected(selected);
  const image = ['step', ['zoom'], 'tel-stop-small', 15, 'tel-stop'];
  map.addLayer({
    id: 'stops-icon', type: 'symbol', source: 'stops', minzoom: 11, maxzoom: FULL_ZOOM, filter,
    layout: { 'icon-image': image, 'icon-size': ICON_SIZE, 'icon-padding': 1, 'symbol-sort-key': ['-', 0, ['get', 'lines']] },
  });
  map.addLayer({
    id: 'stops-icon-all', type: 'symbol', source: 'stops', minzoom: FULL_ZOOM, filter,
    layout: { 'icon-image': 'tel-stop', 'icon-size': ICON_SIZE, 'icon-allow-overlap': true },
  });
  map.addLayer({
    id: LABEL_LAYER, type: 'symbol', source: 'stops', minzoom: FULL_ZOOM, filter, // the tapped stop's name is on the sheet
    layout: {
      'text-field': ['get', 'name'], 'text-font': text.font, 'text-size': 12, 'text-anchor': 'top',
      'text-offset': [0, 1.5], 'text-max-width': 9, 'text-optional': true,
    },
    paint: { 'text-color': text.color, 'text-halo-color': text.halo, 'text-halo-width': 1.6 },
  });
  map.addLayer({
    id: ARROW_LAYER, type: 'symbol', source: 'stops', minzoom: FULL_ZOOM,
    filter: ['all', ['has', 'bearing'], filter],
    layout: {
      'icon-image': 'tel-stop-arrow', 'icon-size': ICON_SIZE, 'icon-offset': [0, -24], 'icon-rotate': ['get', 'bearing'],
      'icon-rotation-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true,
    },
  });
}

export function setSelectedStopFilter(map, code) {
  const filter = notSelected(code);
  for (const id of [...STOP_LAYERS, LABEL_LAYER]) if (map.getLayer(id)) map.setFilter(id, filter);
  if (map.getLayer(ARROW_LAYER)) map.setFilter(ARROW_LAYER, ['all', ['has', 'bearing'], filter]);
}

// ---------- the tapped stop: the icon grows with a bounce, and shrinks back when it closes ----------
const GROW = 1.38;

export function createSelectedStop(map, reduced) {
  const root = document.createElement('div');
  root.style.pointerEvents = 'none';
  const body = document.createElement('div');
  body.style.position = 'relative';
  const arrow = document.createElement('canvas');
  Object.assign(arrow.style, { position: 'absolute', left: '50%', top: '50%', width: '14px', height: '10px', margin: '-5px 0 0 -7px' });
  root.append(body);
  const marker = new maplibregl.Marker({ element: root, anchor: 'center' });
  let current = null;
  let on = false;
  let closing = null;

  function sync() {
    if (!current) return;
    const px = Math.round(stopIconPx(map.getZoom()) * GROW);
    body.style.width = body.style.height = `${px}px`;
    const showArrow = current.bearing != null && map.getZoom() >= FULL_ZOOM;
    arrow.style.display = showArrow ? '' : 'none';
    if (showArrow) arrow.style.transform = `rotate(${current.bearing - map.getBearing()}deg) translateY(${-(px / 2 + 8)}px)`;
  }
  map.on('zoom', sync);
  map.on('rotate', sync);

  return {
    show(stop, theme) {
      const same = on && current?.code === stop.code;
      closing?.cancel();
      closing = null;
      current = stop;
      const icon = stopCanvas(theme, false, 96);
      Object.assign(icon.style, { position: 'absolute', inset: '0', width: '100%', height: '100%' });
      const a = arrowCanvas(theme);
      arrow.width = a.width;
      arrow.height = a.height;
      arrow.getContext('2d').drawImage(a, 0, 0);
      body.replaceChildren(icon, arrow);
      marker.setLngLat([stop.lng, stop.lat]);
      if (!on) { marker.addTo(map); on = true; }
      sync();
      if (!same && !reduced()) {
        body.animate([
          { transform: 'scale(.72)' }, { transform: 'scale(1.14)', offset: 0.5 }, { transform: 'scale(.97)', offset: 0.78 }, { transform: 'scale(1)' },
        ], { duration: 400, easing: 'ease-out' });
      }
    },
    hide() {
      if (!on) return;
      current = null;
      on = false;
      if (reduced()) { marker.remove(); return; }
      closing = body.animate([{ transform: 'scale(1)' }, { transform: 'scale(.72)', opacity: 0 }], { duration: 170, easing: 'ease-in', fill: 'forwards' });
      closing.onfinish = () => { closing?.cancel(); closing = null; if (!on) marker.remove(); };
    },
    position: () => (on && current ? [current.lng, current.lat] : null),
    code: () => (on ? current?.code ?? null : null),
  };
}
