// Glass prototype (TEL-83): the light effects behind css/glass.css. Loaded only with ?glass (index.html), never by app.js.
// - refraction: on Chromium (the only engine with SVG filters in backdrop-filter) it adds two displacement filters,
//   #g-lens (chips, buttons, search bar) and #g-lens-lg (sheet, menu, dialogs), and sets html.glass-lens;
// - touch, like Apple's glass: the control under the finger gets .g-press with --gx/--gy (CSS: more opaque, light at
//   the finger), grows a little, leans towards the finger and springs back with a wobble (Web Animations on the
//   `scale`/`translate` properties, so the elements' own transforms are untouched); .g-hover for a mouse.
// Nothing is stored or sent. Reduced transparency / more contrast: no lens and no effects (CSS is solid then);
// reduced motion: light only, no growing or moving.
const root = document.documentElement;
const mq = (q) => matchMedia(q).matches;
const solid = mq('(prefers-reduced-transparency: reduce)') || mq('(prefers-contrast: more)');
const still = mq('(prefers-reduced-motion: reduce)');
const SVG = 'http://www.w3.org/2000/svg';

// Displacement map: neutral grey in the middle, red/green ramps towards the edges, so the backdrop is pulled in from
// just outside each edge (a lens rim). Stretched to each element (objectBoundingBox), so the rim is a share of its size.
function lensMap(size = 128, edge = 0.16) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const ramp = (t) => (t < edge ? -((1 - t / edge) ** 2) : t > 1 - edge ? ((t - (1 - edge)) / edge) ** 2 : 0);
  for (let y = 0; y < size; y++) {
    const dy = ramp((y + 0.5) / size);
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      img.data[i] = 128 + ramp((x + 0.5) / size) * 127;
      img.data[i + 1] = 128 + dy * 127;
      img.data[i + 2] = 128;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL('image/png');
}

function addLens() {
  const href = lensMap();
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.style.position = 'absolute';
  // scale is a share of the element's box (primitiveUnits = objectBoundingBox): ~12 px on a 360 px wide bar
  for (const [id, scale] of [['g-lens', 0.035], ['g-lens-lg', 0.025]]) {
    const f = document.createElementNS(SVG, 'filter');
    for (const [k, v] of Object.entries({ id, x: 0, y: 0, width: 1, height: 1, filterUnits: 'objectBoundingBox', primitiveUnits: 'objectBoundingBox', 'color-interpolation-filters': 'sRGB' })) f.setAttribute(k, v);
    const im = document.createElementNS(SVG, 'feImage');
    for (const [k, v] of Object.entries({ href, x: 0, y: 0, width: 1, height: 1, preserveAspectRatio: 'none', result: 'map' })) im.setAttribute(k, v);
    const d = document.createElementNS(SVG, 'feDisplacementMap');
    for (const [k, v] of Object.entries({ in: 'SourceGraphic', in2: 'map', scale, xChannelSelector: 'R', yChannelSelector: 'G' })) d.setAttribute(k, v);
    f.append(im, d);
    svg.append(f);
  }
  document.body.append(svg);
  root.classList.add('glass-lens');
}

// touch: the control under the finger (or the glass surface, if the finger is not on a control) gets .g-press and
// --gx/--gy for the light; controls also grow a little, lean towards the finger and spring back with a wobble.
const SURFACE = '.searchbar, .fab, .chip, .sheet, #menu-pop, .su-card, .wl-card';
const CONTROL = 'button, a[href], [role="button"], summary, label, .atile-link';
const NO_GROW = '.sheet, #menu-pop, .su-card, .wl-card, .sheet-handle';
const SPRING = 'cubic-bezier(.34, 1.56, .64, 1)'; // overshoots a little: the "liquid" settle
const clamp = (v, m) => Math.max(-m, Math.min(m, v));
let pressed = null;
let hovered = null;
let origin = null;

function place(el, e) {
  const r = el.getBoundingClientRect();
  el.style.setProperty('--gx', `${(((e.clientX - r.left) / r.width) * 100).toFixed(1)}%`);
  el.style.setProperty('--gy', `${(((e.clientY - r.top) / r.height) * 100).toFixed(1)}%`);
}
function targetOf(e) {
  if (!(e.target instanceof Element)) return null;
  const bar = e.target.closest('.searchbar'); // its input and buttons press the whole bar
  if (bar) return bar;
  const c = e.target.closest(CONTROL);
  if (c && !c.matches('.sheet-handle')) return c;
  return e.target.closest(SURFACE);
}
const canGrow = (el) => !still && !el.matches(NO_GROW);
const growth = (el) => 1 + Math.min(0.08, 10 / Math.max(el.getBoundingClientRect().width, 1)); // ~10 px wider, at most 8%
const now = (el, prop, rest) => { const v = getComputedStyle(el)[prop]; return v && v !== 'none' ? v : rest; };

function onDown(e) {
  const el = targetOf(e);
  if (!el) return;
  release();
  place(el, e);
  pressed = el;
  origin = { x: e.clientX, y: e.clientY };
  el.classList.add('g-press');
  if (!canGrow(el)) return;
  el.glassAnim?.cancel();
  el.glassAnim = el.animate([{ scale: now(el, 'scale', '1') }, { scale: String(growth(el)) }], { duration: 380, easing: SPRING, fill: 'forwards' });
}
function onMove(e) {
  if (pressed) {
    place(pressed, e);
    // lean towards the finger, a few px at most, as if the glass were soft
    if (canGrow(pressed)) pressed.style.translate = `${clamp((e.clientX - origin.x) * 0.15, 5).toFixed(1)}px ${clamp((e.clientY - origin.y) * 0.15, 5).toFixed(1)}px`;
    return;
  }
  if (e.pointerType !== 'mouse') return;
  const el = e.target instanceof Element ? e.target.closest(SURFACE) : null;
  if (el !== hovered) {
    hovered?.classList.remove('g-hover');
    hovered = el;
    el?.classList.add('g-hover');
  }
  if (el) place(el, e);
}
function release() {
  const el = pressed;
  pressed = null;
  if (!el) return;
  el.classList.remove('g-press');
  if (!canGrow(el)) return;
  const from = { scale: now(el, 'scale', '1'), translate: now(el, 'translate', '0px 0px') };
  el.glassAnim?.cancel();
  el.style.translate = '';
  // spring back: a touch under 1, a touch over, then rest
  el.glassAnim = el.animate([from, { scale: '0.985', translate: '0px 0px', offset: 0.45 }, { scale: '1.006', offset: 0.75 }, { scale: '1', translate: '0px 0px' }], { duration: 520, easing: 'ease-out' });
}

function start() {
  if (solid) return;
  if (navigator.userAgentData) addLens(); // Chromium only (Chrome, Edge, Samsung Internet)
  document.addEventListener('pointerdown', onDown, { passive: true });
  document.addEventListener('pointermove', onMove, { passive: true });
  document.addEventListener('pointerup', release, { passive: true });
  document.addEventListener('pointercancel', release, { passive: true });
}

if (root.classList.contains('glass')) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}
