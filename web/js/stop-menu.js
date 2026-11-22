// Press and hold a stop on the map (TEL-360): the map dims and a small card with the actions rises from the stop, as the
// place menu of Apple Maps. The little map is a picture of what is already on screen: no request to anyone.
import { h, icon, toast, lineBadge } from './ui.js';
import { t } from './i18n.js';
import { shareHash } from './route.js';
import { shareLink } from './share.js';

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const EDGE = 16;
const MAX_LINES = 6;
const IGNORE_RELEASE_MS = 350; // the finger that opened the menu is still lifting: that is not a tap outside it

async function shareStop(stop) {
  const hash = shareHash(`#/stop/${encodeURIComponent(stop.code)}`);
  const r = await shareLink({
    title: t('Στάση {name}', { name: stop.displayName }),
    text: t('Αφίξεις λεωφορείων στη στάση {name} ({code})', { name: stop.displayName, code: stop.code }),
    url: `${location.origin}${location.pathname}${hash}`,
  });
  if (r === 'copied') toast(t('Ο σύνδεσμος αντιγράφηκε'));
  else if (r === 'failed') toast(t('Δεν ήταν δυνατή η κοινοποίηση'));
}

let closeOpen = null;

// `at`: the stop on screen ({ x, y }). `picture`: { canvas } from the map, with the stop drawn on it, or null.
export function openStopMenu({ stop, lines = [], at, picture, navigate }) {
  closeOpen?.();
  const before = document.activeElement;
  const openedAt = performance.now();
  let closed = false;

  const action = (name, label, run) => h('button', {
    type: 'button', class: 'stop-menu-act', role: 'menuitem',
    onclick: () => { close(); run(); },
  }, h('span', { class: 'stop-menu-ico' }, icon(name)), h('span', {}, label));

  const mapBox = h('div', { class: 'stop-menu-map' });
  if (picture) {
    picture.canvas.setAttribute('aria-hidden', 'true');
    mapBox.append(picture.canvas);
  }
  const pills = lines.slice(0, MAX_LINES).map(lineBadge);
  if (lines.length > MAX_LINES) pills.push(h('span', { class: 'stop-menu-more' }, `+${lines.length - MAX_LINES}`));
  const card = h('div', { class: 'stop-menu-card' }, mapBox,
    h('div', { class: 'stop-menu-name' }, h('strong', {}, stop.displayName), h('span', {}, t('Στάση {code}', { code: stop.code })),
      pills.length ? h('div', { class: 'stop-menu-lines' }, ...pills) : null));
  const list = h('div', { class: 'stop-menu-list', role: 'menu' },
    action('walk', t('Οδηγίες ως εδώ'), () => navigate(`#/trip?stop=${encodeURIComponent(stop.code)}`)),
    action('share', t('Κοινοποίηση'), () => shareStop(stop)));
  const panel = h('div', { class: 'stop-menu-panel' }, card, list);
  const root = h('div', {
    class: 'stop-menu', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('Στάση {name}', { name: stop.displayName }),
    onclick: (e) => { if (e.target === root && performance.now() - openedAt > IGNORE_RELEASE_MS) close(); },
  }, panel);

  function onKey(e) { if (e.key === 'Escape') close(); }
  function close() {
    if (closed) return;
    closed = true;
    closeOpen = null;
    document.removeEventListener('keydown', onKey);
    before?.focus?.({ preventScroll: true });
    if (reduced()) { root.remove(); return; }
    root.classList.add('closing');
    const out = panel.animate([{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(.6)', opacity: 0 }], { duration: 170, easing: 'ease-in', fill: 'forwards' });
    out.onfinish = () => root.remove();
  }
  closeOpen = close;
  document.addEventListener('keydown', onKey);
  document.body.append(root);

  // Centred across, at the stop's height, always whole on the screen.
  const r = panel.getBoundingClientRect();
  const left = Math.max(EDGE, (innerWidth - r.width) / 2);
  const top = Math.max(EDGE, Math.min(innerHeight - r.height - EDGE, at.y - r.height * 0.3));
  Object.assign(panel.style, { left: `${left}px`, top: `${top}px`, transformOrigin: `${at.x - left}px ${at.y - top}px` });
  list.querySelector('button')?.focus({ preventScroll: true });
  if (!reduced()) {
    panel.animate([
      { transform: 'scale(.35)', opacity: 0 },
      { transform: 'scale(1.04)', opacity: 1, offset: 0.55 },
      { transform: 'scale(.99)', offset: 0.8 },
      { transform: 'scale(1)' },
    ], { duration: 380, easing: 'ease-out' });
  }
  return close;
}
