// Boot screen (TEL-255): ends the logo intro that index.html shows on a cold start at home (css/boot.css).
// The inline head script owns its state (window.__boot), so a tap skips it even before the modules have loaded;
// this module only decides when it leaves. With no boot screen, `leaving` is already resolved and finish() is a no-op.
const B = globalThis.__boot;

// The exit never starts before the intro has played (1500 ms; 500 ms of the still logo with reduced motion).
const MIN_MS = 1500;
const MIN_REDUCED_MS = 500;

export const bootScreen = {
  // Resolves when the exit starts (by finish() or a tap): the setup dialog rises while the boot screen fades.
  leaving: B ? new Promise((resolve) => B.on(resolve)) : Promise.resolve(),
  // Called by app.js when the first view is in, and on the error paths (errors must be visible).
  finish() {
    if (!B) { globalThis.document?.getElementById('boot')?.remove(); return; }
    if (B.out || B.hold || B.finished) return;
    B.finished = true;
    const reduce = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const wait = Math.max(0, B.t0 + (reduce ? MIN_REDUCED_MS : MIN_MS) - performance.now());
    setTimeout(() => B.leave(), wait);
  },
};
