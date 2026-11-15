// Glass UI (TEL-83): the effects behind css/glass.css. Loaded by index.html for everyone, never by app.js.
// - refraction: on Chromium (the only engine with SVG filters in backdrop-filter) it adds two displacement filters,
//   #g-lens (chips, buttons, search bar) and #g-lens-lg (sheet, menu, dialogs), and sets html.glass-lens;
// - touch, like Apple's glass: the control under the finger gets .g-press (CSS: more opaque), grows, leans towards the
//   finger and springs back with a wobble (Web Animations on the `scale`/`translate` properties, so the elements' own
//   transforms are untouched). Round buttons grow most and pop out above their neighbours; full-width list rows do
//   not grow, a soft highlight fades in behind them instead. No light under the finger: it looked unauthentic;
// - the locate button: pressed it fills with the app's blue, and a tap sends out a ring;
// - the sheet handle (js/sheet.js: three states): a tick on the handle each time a drag passes a stop;
// - sticky headers in the sheet: .g-scrolled on the sheet once the list has scrolled (their blur layer shows then);
// - menu: morphs out of the ☰ button, following app.js's popover spring (clip-path + translate); ☰ turns into ✕;
// - the stop's ⋯ menu morphs the same way (⋯ → ˄), with its own timing;
// - line filter chips: a solid pill marks the selected chip and slides to the next; held, it turns into a glass bubble
//   that follows the finger and magnifies (TEL-315).
// Nothing is stored or sent. Reduced transparency / more contrast: no lens and no effects (CSS is solid then);
// reduced motion: no growing, moving or ticking (the press itself still turns the glass more opaque).
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

// touch: the control under the finger (or the glass surface, if the finger is not on a control) gets .g-press;
// controls also grow, lean towards the finger and spring back with a wobble.
const SURFACE = '.fab, .sheet, #menu-pop, .su-card, .wl-card';
const CONTROL = 'button, a[href], [role="button"], summary, label, .atile-link';
const ROW = '.stop-row, .lines-row, .su-choice'; // full-width list rows (and the setup's choices): a highlight, no growing
const ROUND = '.btn.round, .sb-btn, .fab'; // round buttons grow the most
const NO_GROW = `.sheet, #menu-pop, .su-card, .wl-card, .sheet-handle, ${ROW}`;
const SPRING = 'cubic-bezier(.34, 1.56, .64, 1)'; // overshoots a little: the "liquid" settle
const clamp = (v, m) => Math.max(-m, Math.min(m, v));
let pressed = null;
let origin = null;

function targetOf(e) {
  if (!(e.target instanceof Element)) return null;
  const round = e.target.closest('.sb-btn'); // ☰ (back while searching) and the search's ✕ press as glass circles
  if (round) return round;
  const place = e.target.closest('.hm-place'); // home's Places (TEL-232): the link is circle + label, the circle presses
  if (place) return place.querySelector('.g-circle') || place;
  const c = e.target.closest(CONTROL);
  if (c && !c.matches('.sheet-handle')) return c;
  return e.target.closest(SURFACE);
}
const canGrow = (el) => !still && !el.matches(NO_GROW);
const growth = (el) => {
  const w = Math.max(el.getBoundingClientRect().width, 1);
  return el.matches(ROUND) ? 1 + Math.min(0.28, 16 / w) : 1 + Math.min(0.08, 10 / w); // round: ~16 px wider; others ~10 px, at most 8%
};
const now = (el, prop, rest) => { const v = getComputedStyle(el)[prop]; return v && v !== 'none' ? v : rest; };

function onDown(e) {
  const el = targetOf(e);
  if (!el) return;
  release();
  pressed = el;
  origin = { x: e.clientX, y: e.clientY };
  el.classList.add('g-press');
  if (!canGrow(el)) return;
  el.glassAnim?.cancel();
  el.glassAnim = el.animate([{ scale: now(el, 'scale', '1') }, { scale: String(growth(el)) }], { duration: 380, easing: SPRING, fill: 'forwards' });
}
function onMove(e) {
  if (!pressed) return;
  // lean towards the finger, a few px at most, as if the glass were soft
  if (canGrow(pressed)) pressed.style.translate = `${clamp((e.clientX - origin.x) * 0.15, 5).toFixed(1)}px ${clamp((e.clientY - origin.y) * 0.15, 5).toFixed(1)}px`;
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

// ---- more morphs: the stop's ⋯ menu, with the same logic as ☰ (a circle over the button that swells,
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

function watchPopovers() {
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
    }
  }).observe(document.body, { attributes: true, attributeFilter: ['hidden'], subtree: true });
}

// ---- pick-one rows (UI protocol U25): one lens marks the chosen chip (the chips may be rebuilt on every change, so the
// lens lives in their bar, outside the rebuilt row). Any row gets it with one mark, TEL-333: bar[data-lens] > row >
// chip, the chosen chip .on or aria-pressed / -checked / -selected="true". Today: the stop's line chips and the trip's
// option chips (TEL-293). The bar must be positioned (css/glass.css gives a plain one position: relative).
// TEL-315 (UI protocol U24), like the iOS 26 tab bar in the GitHub app: at rest the lens is a solid pill. Out of the
// pill grows a clear bubble that magnifies the chips under it (a copy of the row inside the bubble, so no SVG filter
// and Safari too; the real chips under it are cut out of the row, so nothing shows twice):
// - held on the selected chip: the bubble follows the finger; released, it glides on to the nearest chip and picks it;
//   a swipe that starts on any other chip still scrolls the row (CSS: only the selected chip has touch-action: pan-y);
// - a tap on another chip: the bubble travels there on a spring (a little bounce).
// Every trip ends with the bubble morphing back into the pill on its chip: it shrinks and fills at once (CSS
// transitions), and the copy and the hole stay until it has (MORPH_MS), so nothing pops.
// One bubble at a time (`bub`); a rebuild of the row while it is out takes it over, so lens, copy and hole never
// disagree.
const CHIP_BAR = '[data-lens]';
const LENS_ROW = ':scope > :not(.g-lens)'; // the bar's row: its child that is not the lens
const CHIP = '[data-lens] > :not(.g-lens) > *'; // a chip of a real row (the bubble's copy sits inside the lens)
const ON = ':is(.on, [aria-pressed="true"], [aria-checked="true"], [aria-selected="true"])';
const CHIP_ON = `${CHIP}${ON}`;
const ROW_ON = `${LENS_ROW} > ${ON}`; // from the bar: not the bubble's copy
const isRow = (t) => t instanceof Element && !t.classList.contains('g-lens') && !!t.parentElement?.matches(CHIP_BAR);
const MORPH_MS = 280; // bubble -> pill: the lens's own transitions in css/glass.css
const LENS_PAD = 7; // the lens reaches this much above and below its chip: 54 px over 40 (css/glass.css: 4 px from the capsule)
const LENS_PADX = 0; // and this much past each side (0: the lens is as wide as its chip, tests/e2e/glass.spec.mjs)
const EDGE = 4; // the capsule's inner edge: the lens never shows past it at rest
function watchChips() {
  let from = null; // where the lens was when a chip was pressed: the next rebuild moves it from there
  let bub = null; // the bubble while it is out: { bar, row, lens, copy, x, y, w, h, r, scroll, raf }
  let closing = null; // the bubble that is morphing back into the pill (its copy and hole still there)
  let drag = null; // { id, x0, base, moved }: the finger that holds the bubble
  let eatClick = 0;
  // in the bar's own (unscaled) px: while the bubble is out the bar grows a little (CSS `scale`)
  const rel = (el, bar) => {
    const a = el.getBoundingClientRect(); const b = bar.getBoundingClientRect(); const s = b.width / (bar.offsetWidth || b.width) || 1;
    return { x: (a.left - b.left) / s, y: (a.top - b.top) / s, w: a.width / s, h: a.height / s };
  };
  // the lens over a chip: taller and a little wider than the chip (GitHub's pill, drawn only: the chip keeps its box)
  const pill = (el, bar) => { const b = rel(el, bar); return { x: b.x - LENS_PADX, y: b.y - LENS_PAD, w: b.w + 2 * LENS_PADX, h: b.h + 2 * LENS_PAD }; };
  const at = (d) => ({ x: d.x, y: d.y, w: d.w, h: d.h });
  // at rest the lens shows only inside the capsule (its chip half scrolled out of the row): how much it is cut each side
  const fit = (bar, lens, pos) => {
    const cutL = Math.max(0, EDGE - pos.x), cutR = Math.max(0, pos.x + pos.w - (bar.offsetWidth - EDGE));
    lens.style.clipPath = cutL > 0.5 || cutR > 0.5 ? `inset(-40px ${cutR.toFixed(1)}px -40px ${cutL.toFixed(1)}px)` : '';
    return [cutL, cutR];
  };
  const lensAt = (bar) => {
    if (bub && bub.bar === bar) return at(bub);
    const on = bar.querySelector(ROW_ON);
    return on ? pill(on, bar) : null;
  };

  // the bubble: out of the lens at `pos`
  function open(bar, pos) {
    finish();
    const lens = bar.querySelector(':scope > .g-lens');
    const row = bar.querySelector(LENS_ROW);
    if (!lens || lens.hidden || !row) return null;
    for (const a of lens.getAnimations()) a.cancel();
    const copy = row.cloneNode(true);
    for (const k of ['id', 'role', 'aria-label']) copy.removeAttribute(k);
    copy.classList.add('g-lens-copy');
    for (const c of copy.querySelectorAll('.on, [id]')) { c.classList.remove('on'); c.removeAttribute('id'); } // the real row stays the only selection
    copy.inert = true;
    copy.style.width = `${row.clientWidth}px`;
    copy.style.margin = '0'; // inline: the sheet's own rule for the row (negative margins) is stronger than glass.css's
    lens.append(copy);
    lens.style.width = `${pos.w}px`;
    lens.style.height = `${pos.h}px`;
    lens.style.clipPath = ''; // the bubble may spill past the capsule
    lens.classList.add('g-held');
    bar.classList.add('g-holding', 'g-grown'); // CSS: the row gets a hole where the bubble is, the bar grows a little
    bub = { bar, row, lens, copy, x: pos.x, y: pos.y, w: pos.w, h: pos.h, r: rel(row, bar), scroll: row.scrollLeft, raf: 0 };
    follow(pos.x);
    return bub;
  }
  function follow(x) {
    const d = bub;
    d.x = x;
    // the lens always moves with the `translate` property, never `transform`: the bubble's `scale` (CSS) then grows and
    // shrinks it in place (with `transform` it would scale the offset too, and jump while it morphs)
    d.lens.style.translate = `${x}px ${d.y}px`;
    const b = d.lens.clientLeft; // the copy sits inside the lens's border
    d.copy.style.transform = `translate(${d.r.x - x - d.scroll - b}px, ${d.r.y - d.y - b}px)`;
    // the hole in the row is as wide as the grown bubble (CSS scale 1.22: 11% more on each side)
    d.row.style.setProperty('--hole-a', `${(x - d.r.x - d.w * 0.11).toFixed(1)}px`);
    d.row.style.setProperty('--hole-b', `${(x - d.r.x + d.w * 1.11).toFixed(1)}px`);
  }
  // back into the pill where it is: with `morph`, it shrinks and fills first and the copy and hole go after (MORPH_MS);
  // without, at once (the row is about to be rebuilt, or a new bubble takes over in the same frame)
  function close(morph) {
    const d = bub;
    if (!d) return null;
    bub = null;
    drag = null;
    cancelAnimationFrame(d.raf);
    d.lens.classList.remove('g-held');
    d.bar.classList.remove('g-grown');
    d.done = () => {
      if (closing === d) closing = null;
      clearTimeout(d.timer);
      d.bar.classList.remove('g-holding', 'g-dragging'); // the chosen chip's own frame fades in (CSS) as the copy goes
      d.row.style.removeProperty('--hole-a');
      d.row.style.removeProperty('--hole-b');
      d.copy.remove();
      if (!bub && !d.lens.hidden) fit(d.bar, d.lens, at(d)); // back at rest: inside the capsule again
    };
    if (morph && !still) { closing = d; d.timer = setTimeout(d.done, MORPH_MS); } else d.done();
    return d;
  }
  const finish = () => closing?.done(); // a morph still running ends now
  // the row moved under the bubble (scrolled, or the sheet settled): measure it again, keep the bubble where it is
  const refresh = () => { bub.r = rel(bub.row, bub.bar); bub.scroll = bub.row.scrollLeft; follow(bub.x); };

  // the bubble (this one, or a new one at `pos`) travels to `to` on a damped spring (response 0.36 s, damping 0.58: quick,
  // with a soft overshoot of ~10%, like the GitHub app's tab bar). It starts to shrink back into the pill on the last
  // third of the way, while it still moves (one motion, not "arrive, then morph"), and the copy goes once it has
  // `el`: the chip it heads for, measured again every frame (the row may scroll it into view meanwhile)
  function travel(bar, pos, to, el) {
    const d = bub && bub.bar === bar ? bub : open(bar, { x: pos.x, y: to.y, w: to.w, h: to.h });
    if (!d) return;
    drag = null;
    bar.classList.add('g-dragging'); // the chip it heads for looks like the others until the bubble gets there
    const k = (2 * Math.PI / 0.36) ** 2, c = 2 * 0.58 * Math.sqrt(k);
    let x = d.x, v = 0, last = performance.now();
    const near = Math.max(6, Math.abs(to.x - d.x) / 3);
    let shrunk = false;
    cancelAnimationFrame(d.raf);
    const step = (now) => {
      if (bub !== d) return;
      const dt = Math.min(0.032, Math.max(0, now - last) / 1000);
      last = now;
      if (el?.isConnected) to = pill(el, bar);
      v += (-k * (x - to.x) - c * v) * dt;
      x += v * dt;
      if (!shrunk && Math.abs(x - to.x) < near) { shrunk = true; d.lens.classList.remove('g-held'); d.bar.classList.remove('g-grown'); }
      if (Math.abs(x - to.x) < 1.5 && Math.abs(v) < 40) { follow(to.x); close(true); return; } // there: the morph takes over
      follow(x);
      d.raf = requestAnimationFrame(step);
    };
    d.raf = requestAnimationFrame(step);
  }

  const place = (bar, animate) => {
    finish();
    let was = from;
    from = null;
    const wasOpen = !!(bub && bub.bar === bar);
    if (wasOpen) { was = at(bub); close(false); } // rebuilt under the bubble: a new one takes over, same place, same frame
    let lens = bar.querySelector(':scope > .g-lens');
    if (!lens) { lens = document.createElement('div'); lens.className = 'g-lens'; lens.setAttribute('aria-hidden', 'true'); bar.prepend(lens); }
    // «All» as wide as the widest line chip (CSS --chip-w): offsetWidth ignores transforms (U18)
    const lineChips = bar.querySelectorAll(':scope > .stopv-chips > .stopv-chip:not([data-key="*"])');
    if (lineChips.length) bar.style.setProperty('--chip-w', `${Math.max(...[...lineChips].map((c) => c.offsetWidth))}px`);
    const on = bar.querySelector(ROW_ON);
    if (!on) { lens.hidden = true; return; }
    lens.hidden = false;
    const to = pill(on, bar);
    lens.style.width = `${to.w}px`;
    lens.style.height = `${to.h}px`;
    lens.style.translate = `${to.x}px ${to.y}px`;
    // a chosen chip that is cut by the capsule's edge scrolls into view; the scroll brings the lens along
    const [cutL, cutR] = fit(bar, lens, to);
    if (animate && (cutL > 0.5 || cutR > 0.5)) on.parentElement.scrollBy({ left: cutR ? cutR + EDGE : -(cutL + EDGE), behavior: still ? 'auto' : 'smooth' });
    if (!animate || !was || still) return;
    if (wasOpen || Math.abs(was.x - to.x) > 1) travel(bar, was, to, on);
  };
  // the bubble goes back to the selected chip (a drag let go over it, or nothing was rebuilt after a pick)
  const home = (d) => {
    const on = d.bar.querySelector(ROW_ON);
    if (on && bub === d) travel(d.bar, at(d), pill(on, d.bar), on); else if (bub === d) close(true);
  };

  document.addEventListener('pointerdown', (e) => {
    const chip = e.target instanceof Element && e.target.closest(CHIP);
    const bar = chip?.closest(CHIP_BAR);
    if (!bar || chip.closest('.g-lens-copy')) return;
    from = lensAt(bar); // where the lens is right now (also halfway through a trip): the next rebuild moves it from there
    const on = bar.querySelector(ROW_ON);
    if (!on || chip !== on || !e.isPrimary || still) return;
    if (bub && bub.bar === bar) close(false); // a trip still running: the finger takes over the bubble
    if (open(bar, pill(on, bar))) drag = { id: e.pointerId, x0: e.clientX, base: bub.x, moved: false };
  }, { capture: true, passive: true });
  const rub = (over) => 14 * (1 - Math.exp(-over / 40)); // past the first or last chip: a few px more, harder and harder
  document.addEventListener('pointermove', (e) => {
    if (!drag || !bub || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x0;
    if (Math.abs(dx) > 4 && !drag.moved) {
      drag.moved = true;
      bub.bar.classList.add('g-dragging'); // the chip it left looks like the others
      release(); // and lets go of its own press look (.g-press, grown): the bubble has moved on
    }
    if (!drag.moved) return;
    const chips = [...bub.row.children].map((c) => pill(c, bub.bar));
    if (!chips.length) return;
    const min = Math.max(chips[0].x, EDGE);
    const max = Math.min(chips[chips.length - 1].x + chips[chips.length - 1].w, bub.bar.offsetWidth - EDGE) - bub.w;
    const v = drag.base + dx;
    follow(v > max ? max + rub(v - max) : v < min ? min - rub(min - v) : v);
  }, { passive: true });
  const letGo = (e, cancel) => {
    if (!drag || e.pointerId !== drag.id) return; // no finger holds it (or a rebuild took it over): nothing to pick
    const moved = drag.moved;
    drag = null;
    const d = bub;
    if (!d) return;
    if (!moved) { close(true); return; } // a plain tap on the selected chip: back into the pill; its own click decides
    eatClick = performance.now() + 400; // the finger lifts over another chip: the browser's click must not toggle the old one
    const mid = d.x + d.w / 2;
    let best = null, gap = Infinity;
    for (const c of d.row.children) { const b = rel(c, d.bar); const g = Math.abs(b.x + b.w / 2 - mid); if (g < gap) { gap = g; best = c; } }
    if (!cancel && best && !best.matches(CHIP_ON)) {
      best.click(); // chosen, the same as a tap: the rebuild takes the bubble on to the new chip
      queueMicrotask(() => home(d)); // after the rebuild's own place(); only if nothing was rebuilt
    } else home(d);
  };
  document.addEventListener('pointerup', (e) => letGo(e, false), { passive: true });
  document.addEventListener('pointercancel', (e) => letGo(e, true), { passive: true });
  document.addEventListener('click', (e) => {
    if (!e.isTrusted || performance.now() > eatClick) return;
    eatClick = 0;
    if (e.target instanceof Element && e.target.closest(CHIP)) { e.preventDefault(); e.stopPropagation(); }
  }, { capture: true });

  new MutationObserver((recs) => {
    const bars = new Set();
    for (const r of recs) {
      if (isRow(r.target)) bars.add(r.target.parentElement); // its chips were rebuilt
      // a bar put on the page with its chips already in it (no rebuild to wake us): place its lens now
      for (const n of r.addedNodes) {
        if (!(n instanceof Element) || n.closest('.g-lens')) continue;
        if (n.matches(CHIP_BAR)) bars.add(n);
        for (const b of n.querySelectorAll(CHIP_BAR)) bars.add(b);
      }
    }
    for (const bar of bars) place(bar, true);
  }).observe(document.body, { childList: true, subtree: true });
  document.addEventListener('scroll', (e) => {
    const bar = isRow(e.target) && e.target.parentElement;
    if (!bar) return;
    if (bub && bub.bar === bar) refresh(); else place(bar, false);
  }, { capture: true, passive: true });
  // the chips change shape with the sheet (flat pills at low, TEL-224): once it comes to rest, the lens follows them
  // (not at low: there the chips are the small badges in the stop's header, TEL-227, and the lens is hidden anyway;
  // measured there it would sit in the wrong place on the way up)
  document.getElementById('sheet')?.addEventListener('sheet:settle', (e) => {
    if (e.currentTarget.dataset.state === 'peek') return;
    for (const bar of document.querySelectorAll(`${CHIP_BAR}:not([hidden])`)) {
      if (bub && bub.bar === bar) refresh(); else place(bar, false);
    }
  });
}

// the locate button: a tap sends out a ring, so there is no doubt it was pressed (the fill shows while it is held)
function watchLocate() {
  const btn = document.getElementById('locate-btn');
  if (!btn || still) return;
  btn.addEventListener('click', () => {
    btn.classList.remove('g-ping');
    void btn.offsetWidth; // restart the animation on a quick second tap
    btn.classList.add('g-ping');
  });
  btn.addEventListener('animationend', (e) => { if (e.animationName === 'g-ping') btn.classList.remove('g-ping'); });
}

// the sheet handle: a drag passing one of the three states makes the pill tick (js/sheet.js sends sheet:stop)
function watchHandle() {
  const sheet = document.querySelector('.sheet');
  const pill = sheet?.querySelector('.sheet-pill');
  if (!pill || still) return;
  sheet.addEventListener('sheet:stop', () => {
    pill.animate([{ scale: '1 1' }, { scale: '1.35 1.9', offset: 0.35 }, { scale: '1 1' }], { duration: 220, easing: 'ease-out' });
  });
}

function start() {
  if (solid) return;
  if (navigator.userAgentData) addLens(); // Chromium only (Chrome, Edge, Samsung Internet)
  document.addEventListener('pointerdown', onDown, { passive: true });
  document.addEventListener('pointermove', onMove, { passive: true });
  document.addEventListener('pointerup', release, { passive: true });
  document.addEventListener('pointercancel', release, { passive: true });
  watchScroll();
  watchLocate();
  watchHandle();
  addCloseIcon();
  watchChips();
  root.classList.add('glass-fx');
  if (!still) { watchMenu(); watchPopovers(); }
}

if (root.classList.contains('glass')) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}
