// Boot screen (TEL-255, TEL-365): ends the logo intro that index.html shows on a cold start at home (css/boot.css).
// The inline head script owns its state (window.__boot), so a tap skips it even before the modules have loaded;
// this module only decides when it leaves and where the logo lands. With no boot screen, `leaving` is already resolved
// and finish() is a no-op.
const B = globalThis.__boot;

// The landing never starts before the intro has played (1190 ms; 500 ms of the still logo with reduced motion).
const MIN_MS = 1190;
const MIN_REDUCED_MS = 500;
const BADGE_PX = (96 * 312) / 512; // the stop inside the 96 px logo, at scale 1 (icon.svg: 300 + its 12 px edge)

let target = null;

// Hands the logo the real stop's place on screen; with none it lands on the centre and fades (boot.css defaults).
function aim() {
  const el = globalThis.document?.querySelector('.boot-emblem');
  const to = target?.();
  if (!el || !to) return;
  const from = el.getBoundingClientRect();
  el.style.setProperty('--land-x', `${to.x - (from.left + from.width / 2)}px`);
  el.style.setProperty('--land-y', `${to.y - (from.top + from.height / 2)}px`);
  el.style.setProperty('--land-s', String(to.size / BADGE_PX));
}

export const bootScreen = {
  // Resolves when the exit starts (by finish() or a tap): the setup dialog rises while the boot screen fades.
  leaving: B ? new Promise((resolve) => B.on(resolve)) : Promise.resolve(),
  // fn() => { x, y, size } in screen px, or null when the stop is not on the map yet. Read when the landing starts.
  landOn(fn) { target = fn; },
  // Called by app.js when the first view is in, and on the error paths (errors must be visible).
  finish() {
    if (!B) { globalThis.document?.getElementById('boot')?.remove(); return; }
    if (B.out || B.hold || B.finished) return;
    B.finished = true;
    const reduce = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const wait = Math.max(0, B.t0 + (reduce ? MIN_REDUCED_MS : MIN_MS) - performance.now());
    setTimeout(() => {
      if (B.out) return;
      try { aim(); } catch { /* no landing spot: the logo fades at the centre */ }
      B.leave();
    }, wait);
  },
};
