// One-time thank-you for the founding testers (owner: extras). Opens the first time the app runs as an installed web app
// (standalone); `?welcome` previews it any time without touching the flag. Motion follows docs/DESIGN.md: the card rises and
// sinks on the shared spring (interruptible, same path both ways), decorative bits are CSS keyframes, reduced motion = a short fade.
// Styles: css/welcome.css (prefix wl-).
import { h, icon } from './ui.js';
import { t, APP_NAME } from './i18n.js';
import { getSettings, setSetting } from './store.js';
import { currentPlatform } from './platform.js';
import { createSpringLoop } from './motion.js';
import { cityHash } from './route.js';

// Pure: shown in the installed app until seen; a preview always shows.
export const shouldWelcome = ({ standalone, seen, preview }) => !!preview || (!!standalone && !seen);

const SETTLE = { damping: 1, response: 0.4 };

export function maybeWelcome() {
  const preview = /[?&]welcome\b/.test(globalThis.location?.search || '');
  const go = shouldWelcome({ standalone: currentPlatform().mode === 'app', seen: getSettings().welcomeSeen === true, preview });
  if (!go) return null;
  if (!preview) setSetting('welcomeSeen', true); // set on show, not on dismiss: a reload mid-animation must not bring it back
  return openWelcome();
}

export function openWelcome() {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const app = document.getElementById('app');
  const before = document.activeElement;
  let v = 0; // 0 hidden .. 1 shown
  let closed = false;
  let refocus = true;

  const stagger = (i) => ({ class: 'wl-in', style: `--i:${i}` });
  const start = h('button', { type: 'button', class: 'btn primary press wl-start', onclick: () => close() }, t('Ας ξεκινήσουμε'));
  const feedback = h('a', { class: 'wl-link press', href: cityHash('#/report'), onclick: () => close(false) }, t('Στείλε σχόλια'));
  const scrim = h('div', { class: 'wl-scrim' });
  const card = h('div', { class: 'wl-card' },
    h('div', { class: 'wl-emblem', 'aria-hidden': 'true' },
      h('span', { class: 'wl-ring', style: '--i:0' }), h('span', { class: 'wl-ring', style: '--i:1' }), h('span', { class: 'wl-ring', style: '--i:2' }),
      h('span', { class: 'wl-disc' }, icon('bus')),
      h('span', { class: 'wl-heart' }, icon('heart'))),
    h('p', { ...stagger(0), class: 'wl-in wl-kicker' }, t('Πρώτοι δοκιμαστές')),
    h('h2', { ...stagger(1), class: 'wl-in wl-title', id: 'wl-title' }, t('Ευχαριστούμε που είσαι εδώ')),
    h('p', { ...stagger(2), class: 'wl-in wl-text', id: 'wl-text' }, t('Είσαι από τους λίγους που δοκιμάζουν το {app} πριν από όλους. Οι παρατηρήσεις σου το κάνουν καλύτερο. Αν δεις κάτι που δεν δουλεύει, στο μενού θα βρεις την «Αναφορά προβλήματος».', { app: APP_NAME })),
    h('div', { ...stagger(3), class: 'wl-in wl-actions' }, start, feedback));
  const root = h('div', { class: 'wl', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'wl-title', 'aria-describedby': 'wl-text' }, scrim, card);

  const paint = (val) => {
    scrim.style.opacity = String(val);
    card.style.opacity = String(val);
    card.style.transform = `translateY(${(1 - val) * 28}px) scale(${0.95 + 0.05 * val})`;
  };
  const loop = createSpringLoop({ get: () => v, set: (val) => { v = val; paint(val); }, onSettle: () => { if (v < 0.5) remove(); } });

  function remove() {
    root.remove();
    document.removeEventListener('keydown', onKey, true);
    app?.removeAttribute('inert');
    if (refocus && before?.isConnected) before.focus?.({ preventScroll: true });
  }
  function close(giveFocusBack = true) {
    if (closed) return;
    closed = true;
    refocus = giveFocusBack; // navigating away (feedback link): leave focus to the new view
    if (reduce) { root.classList.add('wl-out'); setTimeout(remove, 180); return; }
    loop.to(0, SETTLE); // sinks back the way it came
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
    if (e.key !== 'Tab') return;
    const order = [start, feedback];
    const i = order.indexOf(document.activeElement);
    const next = order[(i + (e.shiftKey ? -1 : 1) + order.length) % order.length];
    e.preventDefault();
    next.focus();
  }

  app?.setAttribute('inert', ''); // the page behind is not reachable while the dialog is open
  document.addEventListener('keydown', onKey, true);
  document.body.append(root);
  start.focus({ preventScroll: true });
  if (reduce) { v = 1; paint(1); } else { paint(0); loop.to(1, SETTLE); }
  return { close };
}
