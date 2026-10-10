// Bottom sheet (phones) / left side panel (>= 900 px). Owner: shell.
// Markup lives in index.html: #sheet > .sheet-handle (button) + .sheet-body (scroller) > .sheet-content.
// Phones: snap points peek/half/full via transform on the sheet; the handle drags (pointer events) and the body drags
// too while the sheet is not full, or when it is full and scrolled to the top (touch events, non-passive).
// Desktop: static panel, snap() is remembered but has no visual effect.
// onSnap({state, visible, desktop}) fires when a target is chosen (padding for the map);
// onMove({visible, lift, opacity}) fires every frame while dragging (floating UI follows the sheet).
import { t } from './i18n.js';
const STATES = ['peek', 'half', 'full'];
const PEEK_PX = 152; // handle + a header row
const LABEL = { peek: 'κλειστός', half: 'μισός', full: 'πλήρης' };

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
  let raf = 0;
  let peekPx = PEEK_PX; // the home card sets this to its own height (setPeek)

  const isDesktop = () => desktopMQ.matches;
  const inert = () => isDesktop() || fixed;
  function measure() {
    H = root.offsetHeight;
    const peek = Math.min(peekPx + probe.offsetHeight, H);
    SZ = { peek, half: Math.max(peek + 40, Math.min(Math.round(innerHeight * 0.5), H - 100)), full: H };
  }
  const yFor = (s) => H - SZ[s];

  function setY(v) {
    y = v;
    root.style.setProperty('--sheet-y', `${v}px`);
    const vis = H - v;
    // floating UI (FABs, toast, attribution) rides on the sheet up to the half point, then fades out
    const lift = Math.min(vis, SZ.half);
    const opacity = vis <= SZ.half ? 1 : Math.max(0, 1 - (vis - SZ.half) / Math.max(1, (SZ.full - SZ.half) * 0.35));
    onMove?.({ visible: vis, lift, opacity });
  }

  function apply(animate) {
    measure();
    if (inert()) {
      root.style.removeProperty('--sheet-y');
      onMove?.({ visible: 0, lift: 0, opacity: 1 });
      onSnap?.({ state, visible: 0, desktop: isDesktop() });
      return;
    }
    root.classList.toggle('animating', animate && !reduceMQ.matches);
    setY(yFor(state));
    onSnap?.({ state, visible: SZ[state], desktop: false });
  }

  function snap(to, { animate = true } = {}) {
    if (!STATES.includes(to)) return;
    state = to;
    root.dataset.state = to;
    document.body.dataset.sheet = to;
    handle.setAttribute('aria-label', t('Αλλαγή μεγέθους πίνακα (τώρα: {state})', { state: t(LABEL[to]) }));
    apply(animate);
  }

  // ---- dragging ----
  let startY = 0;
  let pointerStart = 0;
  let samples = [];
  function dragBegin(clientY) {
    measure();
    dragging = true;
    startY = y;
    pointerStart = clientY;
    samples = [{ t: performance.now(), y: clientY }];
    root.classList.remove('animating');
    root.classList.add('dragging');
    docEl.classList.add('sheet-dragging');
  }
  function dragMove(clientY) {
    let ny = startY + (clientY - pointerStart);
    const maxY = H - SZ.peek;
    // light rubber band beyond the ends
    if (ny < 0) ny *= 0.25;
    if (ny > maxY) ny = maxY + (ny - maxY) * 0.25;
    samples.push({ t: performance.now(), y: clientY });
    if (samples.length > 6) samples.shift();
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => setY(ny));
    y = ny;
  }
  function dragEnd(moved) {
    cancelAnimationFrame(raf);
    dragging = false;
    root.classList.remove('dragging');
    docEl.classList.remove('sheet-dragging');
    // flick bias: project 120 ms ahead using the recent velocity (no inertia, just a nudge)
    let v = 0;
    if (samples.length > 1) {
      const a = samples[0];
      const b = samples[samples.length - 1];
      v = (b.y - a.y) / Math.max(16, b.t - a.t);
    }
    const proj = y + Math.max(-1, Math.min(1, v)) * 120;
    let best = state;
    let bd = Infinity;
    for (const s of STATES) {
      const d = Math.abs(yFor(s) - proj);
      if (d < bd) { bd = d; best = s; }
    }
    if (moved) { suppressClick = true; setTimeout(() => { suppressClick = false; }, 50); }
    snap(best);
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
  handle.addEventListener('click', () => {
    if (suppressClick || inert()) return;
    snap(state === 'half' ? 'full' : state === 'full' ? 'half' : 'half');
  });
  handle.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const i = STATES.indexOf(state) + (e.key === 'ArrowUp' ? 1 : -1);
    snap(STATES[Math.max(0, Math.min(2, i))]);
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

  // Keyboard focus landing inside a collapsed sheet: open it so the focused element is visible.
  root.addEventListener('focusin', (e) => {
    if (state === 'peek' && !inert() && !handle.contains(e.target)) snap('half');
  });

  // Re-measure on size changes (rotation, keyboard, breakpoint).
  new ResizeObserver(() => { if (!dragging) apply(false); }).observe(root);
  desktopMQ.addEventListener('change', () => apply(false));

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
      apply(false);
    },
    scrollToTop() { body.scrollTop = 0; },
    // Peek height = handle + the single home card; null restores the default.
    setPeek(px) {
      const next = px == null ? PEEK_PX : Math.max(96, Math.min(Math.round(px), Math.round(innerHeight * 0.45)));
      if (next === peekPx) return;
      peekPx = next;
      if (!dragging) apply(false);
    },
  };
}
