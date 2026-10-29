// Bottom sheet (phones) / left side panel (>= 900 px). Owner: shell.
// Markup lives in index.html: #sheet > .sheet-handle (button) + .sheet-body (scroller) > .sheet-content.
// Phones: snap points peek/half/full via transform on the sheet; the handle drags (pointer events) and the body drags
// too while the sheet is not full, or when it is full and scrolled to the top (touch events, non-passive).
// Desktop: static panel, snap() is remembered but has no visual effect.
// onSnap({state, visible, desktop}) fires when a target is chosen (padding for the map);
// onMove({visible, lift, opacity}) fires every frame while dragging (floating UI follows the sheet).
import { t, N_, onLangChange } from './i18n.js';
import { createSpringLoop, rubberband, project } from './motion.js';
// Three states, as in Apple Maps (TEL-222): peek = "low" (the view's first row only), half = "mid" (the default), full =
// "up" (whole screen). css/glass.css draws them from --sheet-t: 0 at peek, 1 at half, 2 at full.
const STATES = ['peek', 'half', 'full'];
const HEADROOM = 12; // room above the first row, so a pressed round button can grow without being clipped (css/glass.css)
const LABEL = { peek: N_('κλειστός'), half: N_('μισός'), full: N_('πλήρης') };
// the view's first row, which is all the peek state shows
const HEAD = '.stopv-head, .ex-head, .view-head, .pl-head';
const RUBBER_DIM = 120; // px, resistance "feel" past the first/last snap point (docs/DESIGN.md §2)
// One spring per move (Kostas, TEL-222): up from peek a hint of bounce, down to peek a little more, to and from full
// none (it darkens and fills the screen instead). After a flick the same spring takes the release velocity.
const SPRINGS = {
  'peek>half': { damping: 0.86, response: 0.42 },
  'half>peek': { damping: 0.72, response: 0.42 },
  'half>full': { damping: 1, response: 0.38 },
  'full>half': { damping: 1, response: 0.38 },
};
const SETTLE = { damping: 1, response: 0.35 };
const springFor = (from, to) => SPRINGS[`${from}>${to}`] || SETTLE;

export function createSheet(root, { onSnap, onMove } = {}) {
  const handle = root.querySelector('.sheet-handle');
  const body = root.querySelector('.sheet-body');
  const content = root.querySelector('.sheet-content');
  const desktopMQ = matchMedia('(min-width: 900px)');
  const reduceMQ = matchMedia('(prefers-reduced-motion: reduce)');
  const docEl = document.documentElement;
  const probe = document.createElement('div'); // measures safe-area-inset-bottom
  probe.style.cssText = 'position:absolute;visibility:hidden;height:env(safe-area-inset-bottom,0px);width:0';
  root.append(probe);

  let state = root.dataset.state || 'half';
  let fixed = false; // no map: behave as a plain page
  let H = 0; // sheet height in px
  let SZ = { peek: 0, half: 0, full: 0 };
  let y = 0; // current translateY in px
  let dragging = false;
  let suppressClick = false;
  let dragRaf = 0; // throttles setY() while dragging (1:1 follow, no physics)
  let peekPx = null; // null = handle + the view's first row; the home card sets its own height (setPeek)

  const isDesktop = () => desktopMQ.matches;
  const inert = () => isDesktop() || fixed;
  // peek: the handle and the view's first row (its header), tight; the home card sets its own height
  function firstRow() {
    const head = content.querySelector(HEAD);
    if (!head) return 96;
    return handle.offsetHeight + Math.round(head.getBoundingClientRect().bottom - content.getBoundingClientRect().top) + 10;
  }
  function measure() {
    H = root.offsetHeight;
    const peek = Math.min(Math.max(64, peekPx ?? firstRow()) + probe.offsetHeight, H);
    SZ = { peek, half: Math.max(peek + 40, Math.min(Math.round(innerHeight * 0.5), H - 100)), full: H };
  }
  const yFor = (s) => H - SZ[s];

  // glass: tell the handle when a drag passes a stop (it gives a small "tick", css/glass.css)
  let lastStop = 0;
  function tick(v) {
    if (!dragging) return;
    const near = STATES.findIndex((s) => Math.abs(yFor(s) - v) < 6);
    if (near >= 0 && near !== lastStop) { lastStop = near; root.dispatchEvent(new CustomEvent('sheet:stop')); }
    else if (near < 0) lastStop = -1;
  }

  function setY(v) {
    y = v;
    root.style.setProperty('--sheet-y', `${v}px`);
    const vis = H - v;
    tick(v);
    // 0 at peek, 1 at half, 2 at full (css/glass.css draws the sheet's shape and colour from it)
    const tt = vis <= SZ.half ? (vis - SZ.peek) / Math.max(1, SZ.half - SZ.peek) : 1 + (vis - SZ.half) / Math.max(1, SZ.full - SZ.half);
    root.style.setProperty('--sheet-t', Math.max(0, Math.min(2, tt)).toFixed(3));
    // floating UI (FABs, toast, attribution) rides on the sheet up to the half point, then fades out
    const lift = Math.min(vis, SZ.half);
    const opacity = vis <= SZ.half ? 1 : Math.max(0, 1 - (vis - SZ.half) / Math.max(1, (SZ.full - SZ.half) * 0.35));
    onMove?.({ visible: vis, lift, opacity });
  }

  // Drives --sheet-y with the spring while not dragging; the pointer sets it directly during a drag.
  const spring = createSpringLoop({ get: () => y, set: setY });

  // prefers-reduced-motion: bypass physics entirely, a short opacity cross-fade on the content instead
  // (docs/DESIGN.md §7). Position itself jumps straight to the target.
  function reducedMotionTo(targetY) {
    setY(targetY);
    content.style.transition = 'none';
    content.style.opacity = '0';
    requestAnimationFrame(() => {
      content.style.transition = 'opacity .15s linear';
      content.style.opacity = '1';
    });
    content.addEventListener('transitionend', () => { content.style.transition = ''; }, { once: true });
  }

  // Moves to a state's resting position: unanimated (resize/boot), settled (plain programmatic snap),
  // or with momentum (after a flick, via dragEnd). `spring` here is a {damping, response} pair, not the
  // module-level spring loop above.
  function moveTo(to, { animate = true, velocity = 0, spring: cfg = SETTLE } = {}) {
    measure();
    if (inert()) {
      root.style.removeProperty('--sheet-y');
      root.style.setProperty('--sheet-t', fixed ? '2' : '1'); // plain page = the full look; side panel = the half look
      onMove?.({ visible: 0, lift: 0, opacity: 1 });
      onSnap?.({ state, visible: 0, desktop: isDesktop() });
      return;
    }
    const targetY = yFor(to);
    if (!animate) {
      spring.stop();
      setY(targetY);
    } else if (reduceMQ.matches) {
      spring.stop();
      reducedMotionTo(targetY);
    } else {
      spring.to(targetY, { velocity, damping: cfg.damping, response: cfg.response });
    }
    onSnap?.({ state, visible: SZ[to], desktop: false });
  }

  // The handle's only accessible name (index.html has none): set by the first snap() below, and again per language.
  const paintLabel = () => handle.setAttribute('aria-label', t('Αλλαγή μεγέθους πίνακα (τώρα: {state})', { state: t(LABEL[state]) }));
  onLangChange(paintLabel);

  function snap(to, { animate = true, velocity = 0, spring: cfg } = {}) {
    if (!STATES.includes(to)) return;
    cfg ||= springFor(state, to);
    state = to;
    root.dataset.state = to;
    document.body.dataset.sheet = to;
    paintLabel();
    moveTo(to, { animate, velocity, spring: cfg });
  }

  // ---- dragging ----
  let startY = 0;
  let dragFrom = 'half';
  let pointerStart = 0;
  let samples = [];
  function dragBegin(clientY) {
    measure();
    dragging = true;
    spring.stop(); // interrupt any in-flight snap; the drag takes over the live y from here
    startY = y;
    lastStop = STATES.indexOf(state);
    dragFrom = state;
    pointerStart = clientY;
    samples = [{ t: performance.now(), y: clientY }];
    root.classList.add('dragging');
    docEl.classList.add('sheet-dragging');
  }
  function dragMove(clientY) {
    let ny = startY + (clientY - pointerStart);
    const maxY = H - SZ.peek;
    // rubber-band resistance past the first/last snap point, never a hard stop (docs/DESIGN.md §2)
    if (ny < 0) ny = -rubberband(-ny, RUBBER_DIM);
    else if (ny > maxY) ny = maxY + rubberband(ny - maxY, RUBBER_DIM);
    samples.push({ t: performance.now(), y: clientY });
    if (samples.length > 6) samples.shift();
    cancelAnimationFrame(dragRaf);
    dragRaf = requestAnimationFrame(() => setY(ny));
    y = ny;
  }
  function dragEnd(moved) {
    cancelAnimationFrame(dragRaf);
    dragging = false;
    root.classList.remove('dragging');
    docEl.classList.remove('sheet-dragging');
    // release velocity from the recent pointer history, in px/s
    let v = 0;
    if (samples.length > 1) {
      const a = samples[0];
      const b = samples[samples.length - 1];
      v = ((b.y - a.y) / Math.max(16, b.t - a.t)) * 1000;
    }
    const proj = y + project(v);
    let best = state;
    let bd = Infinity;
    for (const s of STATES) {
      const d = Math.abs(yFor(s) - proj);
      if (d < bd) { bd = d; best = s; }
    }
    if (moved) { suppressClick = true; setTimeout(() => { suppressClick = false; }, 50); }
    snap(best, { velocity: v, spring: springFor(dragFrom, best) });
  }

  let handleMoved = false;
  handle.addEventListener('pointerdown', (e) => {
    if (inert() || (e.pointerType === 'mouse' && e.button !== 0)) return;
    handle.setPointerCapture(e.pointerId);
    handleMoved = false;
    dragBegin(e.clientY);
  });
  handle.addEventListener('pointermove', (e) => {
    if (!dragging || !handle.hasPointerCapture(e.pointerId)) return;
    if (Math.abs(e.clientY - pointerStart) > 4) handleMoved = true;
    dragMove(e.clientY);
  });
  const handleUp = (e) => {
    if (!dragging || !handle.hasPointerCapture(e.pointerId)) return;
    handle.releasePointerCapture(e.pointerId);
    dragEnd(handleMoved);
  };
  handle.addEventListener('pointerup', handleUp);
  handle.addEventListener('pointercancel', handleUp);
  // A tap walks the detents up to full and back down to peek, so every detent is reachable without dragging (WCAG 2.5.7).
  let tapDir = 1;
  handle.addEventListener('click', () => {
    if (suppressClick || inert()) return;
    if (state === 'full') tapDir = -1;
    else if (state === 'peek') tapDir = 1;
    snap(STATES[STATES.indexOf(state) + tapDir]);
  });
  handle.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const i = STATES.indexOf(state) + (e.key === 'ArrowUp' ? 1 : -1);
    snap(STATES[Math.max(0, Math.min(STATES.length - 1, i))]);
  });

  // Body gestures (touch only): drag the sheet when it is not full, or when full and scrolled to the top.
  let t0 = null;
  body.addEventListener('touchstart', (e) => {
    if (inert() || e.touches.length !== 1) { t0 = null; return; }
    t0 = { x: e.touches[0].clientX, y: e.touches[0].clientY, mode: 'undecided' };
  }, { passive: true });
  body.addEventListener('touchmove', (e) => {
    if (!t0 || e.touches.length !== 1) return;
    const t = e.touches[0];
    const dx = t.clientX - t0.x;
    const dy = t.clientY - t0.y;
    if (t0.mode === 'undecided') {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      if (Math.abs(dx) > Math.abs(dy)) { t0.mode = 'native'; return; }
      const canDrag = state !== 'full' || (body.scrollTop <= 0 && dy > 0);
      if (!canDrag) { t0.mode = 'native'; return; }
      t0.mode = 'sheet';
      dragBegin(t.clientY);
    }
    if (t0.mode !== 'sheet') return;
    if (e.cancelable) e.preventDefault();
    dragMove(t.clientY);
  }, { passive: false });
  const touchDone = () => {
    if (t0?.mode === 'sheet') dragEnd(true);
    t0 = null;
  };
  body.addEventListener('touchend', touchDone);
  body.addEventListener('touchcancel', touchDone);

  // Keyboard focus landing inside a collapsed sheet: open it so the focused element is visible. In half the body
  // runs on below the screen edge (the sheet is translated, so the browser never scrolls it): a keyboard-focused
  // element down there opens the sheet further (WCAG 2.4.11). Pointer focus never moves the sheet.
  root.addEventListener('focusin', (e) => {
    if (inert() || handle.contains(e.target)) return;
    const kb = e.target.matches?.(':focus-visible');
    if (state === 'peek' && !kb) { snap('half'); return; }
    if (!kb || state === 'full') return;
    const bottom = e.target.getBoundingClientRect().bottom - y; // at translateY 0
    const fits = (s) => bottom + yFor(s) <= innerHeight - 8;
    const to = fits('half') ? 'half' : 'full';
    if (to !== state) snap(to);
  });

  // Re-measure on size changes (rotation, keyboard, breakpoint).
  new ResizeObserver(() => { if (!dragging) moveTo(state, { animate: false }); }).observe(root);
  desktopMQ.addEventListener('change', () => moveTo(state, { animate: false }));

  snap(state, { animate: false });

  return {
    el: root,
    content,
    body,
    get state() { return state; },
    snap,
    // Plain page mode (no map): the sheet fills the screen below the top bar, no dragging.
    setFixed(v) {
      fixed = !!v;
      root.classList.toggle('fixed', fixed);
      moveTo(state, { animate: false });
    },
    scrollToTop() { body.scrollTop = 0; },
    // Peek height = handle + the single home card; null restores the default.
    setPeek(px) {
      const next = px == null ? null : Math.max(96, Math.min(Math.round(px) + HEADROOM, Math.round(innerHeight * 0.45)));
      if (next === peekPx) return;
      peekPx = next;
      if (!dragging) moveTo(state, { animate: false });
    },
  };
}
