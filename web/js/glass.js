// Glass prototype (TEL-83): the light effects behind css/glass.css. Loaded only with ?glass (index.html), never by app.js.
// - refraction: on Chromium (the only engine with SVG filters in backdrop-filter) it adds two displacement filters,
//   #g-lens (chips, buttons, search bar) and #g-lens-lg (sheet, menu, dialogs), and sets html.glass-lens;
// - touch, like Apple's glass: the control under the finger gets .g-press with --gx/--gy (CSS: more opaque, light at
//   the finger), grows a little, leans towards the finger and springs back with a wobble (Web Animations on the
//   `scale`/`translate` properties, so the elements' own transforms are untouched); .g-hover for a mouse.
// - sticky headers in the sheet: .g-scrolled on the sheet once the list has scrolled (their blur layer shows then);
// - menu: morphs out of the ☰ button, following app.js's popover spring (clip-path + translate); ☰ turns into ✕;
// - the stop's ⋯ menu and the map's i morph the same way (⋯ → ˄), with their own timing;
// - line filter chips: a glass lens slides from the selected chip to the next.
// Nothing is stored or sent. Reduced transparency / more contrast: no lens and no effects (CSS is solid then);
// reduced motion: light only, no growing or moving.
const root = document.documentElement;
const mq = (q) => matchMedia(q).matches;
const solid = mq('(prefers-reduced-transparency: reduce)') || mq('(prefers-contrast: more)');
const still = mq('(prefers-reduced-motion: reduce)');
import { icon } from './ui.js';

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
  const round = e.target.closest('.sb-btn'); // the bar's round buttons (☰, back) press on their own, as glass circles
  if (round) return round;
  const bar = e.target.closest('.searchbar'); // the rest of the bar (its input) presses the whole bar
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

// sticky headers: .g-scrolled on the sheet once its list has scrolled, so their blur layer only shows when needed
function watchScroll() {
  const sheet = document.querySelector('.sheet');
  if (!sheet) return;
  document.addEventListener('scroll', (e) => {
    if (e.target instanceof Element && e.target.id === 'sheet-body') sheet.classList.toggle('g-scrolled', e.target.scrollTop > 4);
  }, { capture: true, passive: true });
}

// menu: morphs out of the ☰ button. app.js drives the popover with its spring and paints opacity = progress (0..1);
// this follows that progress and turns it into a shape: the ☰ lines blur out, and a glass circle over the button grows
// into the panel (clip-path inset + round, and `translate`); in reverse on close. app.js's scale is switched off in CSS.
function watchMenu() {
  const pop = document.getElementById('menu-pop');
  const btn = document.getElementById('menu-btn');
  if (!pop || !btn) return;
  const ease = (t) => t * t * (3 - 2 * t); // ease-in-out over the spring's progress, so the shape grows the whole way
  const opts = { attributes: true, attributeFilter: ['style', 'hidden'] };
  let obs = null;
  // our own style writes would wake the observer again: stop listening while writing
  const write = (fn) => { obs.disconnect(); fn(); obs.observe(pop, opts); };
  const reset = () => write(() => { pop.style.removeProperty('clip-path'); pop.style.removeProperty('translate'); pop.style.removeProperty('--g-morph'); btn.style.removeProperty('--g-morph'); });
  const paint = () => {
    // only a hidden menu goes back to plain: near 0 it stays the small circle over ☰ until app.js hides it, or the
    // full menu would flash (its opacity is held by CSS)
    if (pop.hidden) { reset(); return; }
    const v = parseFloat(pop.style.opacity);
    const t = Number.isNaN(v) ? 0 : Math.max(0, Math.min(1, v));
    const cs = getComputedStyle(pop);
    const left = parseFloat(cs.left);
    const top = parseFloat(cs.top);
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    const b = btn.getBoundingClientRect();
    const r = parseFloat(cs.borderTopLeftRadius) || 16;
    const clamp01 = (x) => Math.max(0, Math.min(1, x));
    // phase 1 (first ~30%): the circle swells around the button's centre while the ☰ lines blur out
    const d = b.width * (1 + 0.5 * ease(clamp01(t / 0.3)));
    const cx = b.left + b.width / 2;
    const cy = b.top + b.height / 2;
    // phase 2 (from ~20%): that circle opens into the panel
    const u = ease(clamp01((t - 0.2) / 0.8));
    const lerp = (a, z) => a + (z - a) * u;
    const x = lerp(cx - d / 2, left);
    const y = lerp(cy - d / 2, top);
    const bw = lerp(d, w);
    const bh = lerp(d, h);
    const rad = lerp(d / 2, r);
    write(() => {
      // the visible box is the pop's own top-left corner, moved onto the shape; the clip cuts it to the shape's size
      pop.style.translate = `${(x - left).toFixed(1)}px ${(y - top).toFixed(1)}px`;
      pop.style.clipPath = `inset(0 ${Math.max(0, w - bw).toFixed(1)}px ${Math.max(0, h - bh).toFixed(1)}px 0 round ${rad.toFixed(1)}px)`;
      pop.style.setProperty('--g-morph', t.toFixed(3));
      btn.style.setProperty('--g-morph', t.toFixed(3)); // the ☰ lines blur out as the circle becomes the menu
    });
  };
  obs = new MutationObserver(paint);
  obs.observe(pop, opts);
  root.classList.add('glass-morph');
}

// ☰ → ✕: a ✕ lives in the menu button next to its icon (CSS stacks them and crossfades them with the morph, or swaps
// them with reduced motion). app.js redraws the button (☰ ↔ back arrow for search), so the ✕ is put back when it does.
function addCloseIcon() {
  const btn = document.getElementById('menu-btn');
  if (!btn) return;
  const ensure = () => { if (!btn.querySelector('.g-x')) { const x = icon('close'); x.classList.add('g-x'); btn.append(x); } };
  ensure();
  new MutationObserver(ensure).observe(btn, { childList: true });
}

// ---- more morphs: the stop's ⋯ menu and the map's i, with the same logic as ☰ (a circle over the button that swells,
// then opens into the panel; the same path back). These popovers are shown and hidden by other code in one step
// (the `hidden` attribute, a class), so the opening plays after it shows, and the closing is held back: the popover is
// kept visible, shrinks into its button, and is hidden again when the animation ends.
const OPEN_MS = 460;
const CLOSE_MS = 380;
const OUT = 'cubic-bezier(.3, .7, .2, 1)';
const busy = new WeakSet(); // popovers we are hiding ourselves (their own mutation is not a request)
const relBox = (pr, x, y, w, h, bw, bh, rad) => ({
  translate: `${(x - pr.left).toFixed(1)}px ${(y - pr.top).toFixed(1)}px`,
  clipPath: `inset(0px ${Math.max(0, w - bw).toFixed(1)}px ${Math.max(0, h - bh).toFixed(1)}px 0px round ${rad.toFixed(1)}px)`,
});
// circle over `from` (a rect) → a 1.5× circle around its centre → the popover's own box
function shapeFrames(pop, from) {
  pop.getAnimations().forEach((a) => a.cancel());
  const pr = pop.getBoundingClientRect();
  const r = parseFloat(getComputedStyle(pop).borderTopLeftRadius) || 12;
  const d = Math.min(from.width, from.height);
  const D = d * 1.5;
  const cx = from.left + from.width / 2;
  const cy = from.top + from.height / 2;
  return [
    { ...relBox(pr, cx - d / 2, cy - d / 2, pr.width, pr.height, d, d, d / 2), opacity: 0 },
    { ...relBox(pr, cx - D / 2, cy - D / 2, pr.width, pr.height, D, D, D / 2), opacity: 1, offset: 0.3 },
    { ...relBox(pr, pr.left, pr.top, pr.width, pr.height, pr.width, pr.height, r), opacity: 1 },
  ];
}
function morphOpen(pop, from, items) {
  const frames = shapeFrames(pop, from);
  pop.animate(frames, { duration: OPEN_MS, easing: OUT });
  for (const it of items) it.animate([{ opacity: 0 }, { opacity: 0, offset: 0.45 }, { opacity: 1 }], { duration: OPEN_MS, easing: 'ease-out' });
}
function morphClose(pop, from, items, hide) {
  busy.add(pop);
  const frames = shapeFrames(pop, from).reverse().map((f, i) => ({ ...f, offset: [0, 0.7, 1][i] }));
  for (const it of items) it.animate([{ opacity: 1 }, { opacity: 0, offset: 0.4 }, { opacity: 0 }], { duration: CLOSE_MS, easing: 'ease-in' });
  const a = pop.animate(frames, { duration: CLOSE_MS, easing: 'cubic-bezier(.5, 0, .7, .4)', fill: 'forwards' });
  a.onfinish = () => { hide(); a.cancel(); pop.getAnimations().forEach((x) => x.cancel()); requestAnimationFrame(() => busy.delete(pop)); };
}
// the button that opens a popover turns its icon into another while it is open (⋯ → ˄: a ✕ there would sit next to
// the stop's own close ✕ and read as the same thing)
function morphButton(btn, to = 'chevron-up') {
  if (btn.classList.contains('g-morph-btn')) return;
  for (const n of [...btn.childNodes]) {
    if (n.nodeType === Node.TEXT_NODE && n.textContent.trim()) { const s = document.createElement('span'); s.setAttribute('aria-hidden', 'true'); s.textContent = n.textContent; n.replaceWith(s); }
  }
  const x = icon(to);
  x.classList.add('g-x');
  btn.append(x);
  btn.classList.add('g-morph-btn');
}

const attribFrom = new WeakMap(); // the i circle's box, taken when it is tapped (it is gone once the pill is open)
function watchPopovers() {
  document.addEventListener('pointerdown', (e) => {
    const b = e.target instanceof Element && e.target.closest('.maplibregl-ctrl-attrib-button');
    const box = b?.closest('.maplibregl-ctrl-attrib');
    if (box && !box.classList.contains('maplibregl-compact-show')) attribFrom.set(box, b.getBoundingClientRect());
  }, { capture: true, passive: true });

  new MutationObserver((recs) => {
    for (const r of recs) {
      const el = r.target;
      if (!(el instanceof Element) || busy.has(el)) continue;
      // the stop's ⋯ menu (hidden attribute)
      if (r.attributeName === 'hidden' && el.classList.contains('stopv-menu')) {
        const btn = el.parentElement?.querySelector('.stopv-more-btn');
        if (!btn) continue;
        morphButton(btn);
        const items = [...el.children];
        if (!el.hidden) { btn.classList.add('g-open'); morphOpen(el, btn.getBoundingClientRect(), items); }
        else {
          btn.classList.remove('g-open');
          el.hidden = false; // keep it on screen while it shrinks back into ⋯
          busy.add(el);
          morphClose(el, btn.getBoundingClientRect(), items, () => { el.hidden = true; });
        }
      }
      // the map's i (MapLibre toggles maplibregl-compact-show)
      if (r.attributeName === 'class' && el.classList.contains('maplibregl-ctrl-attrib')) {
        const open = el.classList.contains('maplibregl-compact-show');
        const was = (r.oldValue || '').includes('maplibregl-compact-show');
        if (open === was) continue;
        const items = [...el.querySelectorAll('.maplibregl-ctrl-attrib-inner')];
        const from = attribFrom.get(el);
        if (!from) continue;
        if (open) morphOpen(el, from, items);
        else {
          busy.add(el);
          el.classList.add('maplibregl-compact-show'); // keep the pill while it shrinks back into the i
          morphClose(el, from, items, () => { el.classList.remove('maplibregl-compact-show'); });
        }
      }
    }
  }).observe(document.body, { attributes: true, attributeFilter: ['hidden', 'class'], attributeOldValue: true, subtree: true });
}

// ---- line filter chips: one glass lens marks the selected chip and slides to the next one, stretching over both
// on the way (the chips are rebuilt on every change, so the lens lives in their bar, outside the rebuilt row)
function watchChips() {
  let from = null;
  const rel = (el, bar) => { const a = el.getBoundingClientRect(); const b = bar.getBoundingClientRect(); return { x: a.left - b.left, y: a.top - b.top, w: a.width, h: a.height }; };
  const place = (bar, animate) => {
    let lens = bar.querySelector(':scope > .g-lens');
    if (!lens) { lens = document.createElement('div'); lens.className = 'g-lens'; lens.setAttribute('aria-hidden', 'true'); bar.prepend(lens); }
    const on = bar.querySelector('.stopv-chip.on');
    if (!on) { lens.hidden = true; return; }
    lens.hidden = false;
    const to = rel(on, bar);
    lens.style.width = `${to.w}px`;
    lens.style.height = `${to.h}px`;
    lens.style.transform = `translate(${to.x}px, ${to.y}px)`;
    if (animate && from && !still && Math.abs(from.x - to.x) > 1) {
      const left = Math.min(from.x, to.x);
      const right = Math.max(from.x + from.w, to.x + to.w);
      lens.animate([
        { width: `${from.w}px`, transform: `translate(${from.x}px, ${from.y}px)` },
        { width: `${right - left}px`, transform: `translate(${left}px, ${to.y}px) scaleY(.86)`, offset: 0.45 },
        { width: `${to.w}px`, transform: `translate(${to.x}px, ${to.y}px)` },
      ], { duration: 480, easing: OUT });
    }
    from = null;
  };
  document.addEventListener('pointerdown', (e) => {
    const chip = e.target instanceof Element && e.target.closest('.stopv-chip');
    const bar = chip?.closest('.stopv-chipbar');
    const on = bar?.querySelector('.stopv-chip.on');
    from = on ? rel(on, bar) : null;
  }, { capture: true, passive: true });
  new MutationObserver((recs) => {
    const bars = new Set(recs.map((r) => r.target).filter((t) => t instanceof Element && t.classList.contains('stopv-chips')).map((t) => t.closest('.stopv-chipbar')));
    for (const bar of bars) if (bar) place(bar, true);
  }).observe(document.body, { childList: true, subtree: true });
  document.addEventListener('scroll', (e) => {
    const bar = e.target instanceof Element && e.target.classList.contains('stopv-chips') && e.target.closest('.stopv-chipbar');
    if (bar) place(bar, false);
  }, { capture: true, passive: true });
}

function start() {
  if (solid) return;
  if (navigator.userAgentData) addLens(); // Chromium only (Chrome, Edge, Samsung Internet)
  document.addEventListener('pointerdown', onDown, { passive: true });
  document.addEventListener('pointermove', onMove, { passive: true });
  document.addEventListener('pointerup', release, { passive: true });
  document.addEventListener('pointercancel', release, { passive: true });
  watchScroll();
  addCloseIcon();
  watchChips();
  root.classList.add('glass-fx');
  if (!still) { watchMenu(); watchPopovers(); }
}

if (root.classList.contains('glass')) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}
