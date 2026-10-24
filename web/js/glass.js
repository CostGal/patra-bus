// Glass prototype (TEL-83): the light effects behind css/glass.css. Loaded only with ?glass (index.html), never by app.js.
// - refraction: on Chromium (the only engine with SVG filters in backdrop-filter) it adds two displacement filters,
//   #g-lens (chips, buttons, search bar) and #g-lens-lg (sheet, menu, dialogs), and sets html.glass-lens;
// - finger highlight: --gx/--gy (%) on the glass surface under the pointer, .g-press while pressed, .g-hover for a mouse;
// - specular band: --g-shift (px) on <html>, from the sheet's scroll and the sheet's position (drag and spring).
// Nothing is stored or sent. Reduced transparency / more contrast: no lens and no light effects (CSS is solid then);
// reduced motion: the band stays put.
const root = document.documentElement;
const mq = (q) => matchMedia(q).matches;
const solid = mq('(prefers-reduced-transparency: reduce)') || mq('(prefers-contrast: more)');
const still = mq('(prefers-reduced-motion: reduce)');
const GLASS = '.searchbar, .fab, .chip, .sheet, #menu-pop, .su-card, .wl-card';
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

// finger / mouse highlight
let pressed = null;
let hovered = null;
function place(el, e) {
  const r = el.getBoundingClientRect();
  el.style.setProperty('--gx', `${(((e.clientX - r.left) / r.width) * 100).toFixed(1)}%`);
  el.style.setProperty('--gy', `${(((e.clientY - r.top) / r.height) * 100).toFixed(1)}%`);
}
const glassAt = (e) => (e.target instanceof Element ? e.target.closest(GLASS) : null);
function onDown(e) {
  const el = glassAt(e);
  if (!el) return;
  place(el, e);
  pressed = el;
  el.classList.add('g-press');
}
function onMove(e) {
  const el = pressed || glassAt(e);
  if (e.pointerType === 'mouse' && el !== hovered) {
    hovered?.classList.remove('g-hover');
    hovered = el;
    el?.classList.add('g-hover');
  }
  if (el) place(el, e);
}
function onUp() {
  pressed?.classList.remove('g-press');
  pressed = null;
}

// specular band: a triangle wave, so it sweeps back and forth as the sheet scrolls or moves
let scrollY = 0;
let sheetY = 0;
let frame = 0;
function shift() {
  frame = 0;
  const t = scrollY * 0.35 + sheetY * 0.25;
  root.style.setProperty('--g-shift', `${(Math.abs((t % 480) - 240) - 120).toFixed(1)}px`);
}
const queue = () => { if (!frame) frame = requestAnimationFrame(shift); };
function watchSheet() {
  const sheet = document.querySelector('.sheet');
  if (!sheet) return;
  new MutationObserver(() => {
    sheetY = parseFloat(sheet.style.getPropertyValue('--sheet-y')) || 0;
    queue();
  }).observe(sheet, { attributes: true, attributeFilter: ['style'] });
  document.addEventListener('scroll', (e) => {
    if (e.target instanceof Element && sheet.contains(e.target)) { scrollY = e.target.scrollTop; queue(); }
  }, { capture: true, passive: true });
}

function start() {
  if (solid) return;
  if (navigator.userAgentData) addLens(); // Chromium only (Chrome, Edge, Samsung Internet)
  document.addEventListener('pointerdown', onDown, { passive: true });
  document.addEventListener('pointermove', onMove, { passive: true });
  document.addEventListener('pointerup', onUp, { passive: true });
  document.addEventListener('pointercancel', onUp, { passive: true });
  if (!still) watchSheet();
}

if (root.classList.contains('glass')) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}
