// Home parts for the sheet (TEL-232, owner: shell): the Places row (mid) and the favourites with their next arrival
// live (up). The recents and the layout live in app.js mountHome. Style: DESIGN.md §4 and §10, css/home.css.
import { h, icon, toast } from './ui.js';
import { t } from './i18n.js';
import { cityHash } from './route.js';
import { createLivePoller, isStale } from './api.js';
import { getFavorites, onChange } from './store.js';
import { getPlaces, onPlacesChange, placeLabel, removePlace, MAX_CUSTOM } from './places.js';

export const LIVE_FAVS = 4; // favourites that fetch their arrival; the rest load on demand ("Δες αφίξεις")
// Where a place is set: its own panel in the sheet (TEL-239, js/place-view.js), no longer the settings
const SET_PLACE = (id) => cityHash(`#/place?id=${encodeURIComponent(id)}`);
const PLACE_ICON = { home: 'home', work: 'briefcase' };
// A set place opens the stops around it (the pin view), as a recent place does in app.js (the planner is gone, TEL-217).
const placeHash = (p) => cityHash(`#/pin?lat=${p.lat.toFixed(5)}&lng=${p.lng.toFixed(5)}`);
const tripHash = (p) => cityHash(`#/trip?lat=${p.lat.toFixed(5)}&lng=${p.lng.toFixed(5)}&name=${encodeURIComponent(placeLabel(p).slice(0, 80))}`);
const HOLD_MS = 500; // touch & hold on a set place opens its menu (TEL-239)

// ---------------------------------------------------------------- Places: round buttons
// Σπίτι and Δουλειά are always there, then your own places, then "+". As in Apple Maps (TEL-246): a set place is a filled
// circle in the app's blue (.is-set); one not set yet keeps the glass circle and says «Προσθήκη» under its name (a tap
// sets it in its own panel, TEL-239). Each is the card's round button (.g-circle, DESIGN §10) at 48 px; js/glass.js presses
// the circle. Touch & hold (or right-click) on a set place: a small menu «Διαδρομή / Αλλαγή / Διαγραφή».
export function mountPlacesRow(container) {
  const menu = placeMenu();
  const paint = () => {
    menu.close();
    const saved = getPlaces().filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng));
    const byId = new Map(saved.map((p) => [p.id, p]));
    const circle = (cls, ico, label, href, aria) => h('a', { class: `hm-place press ${cls}`, href, 'aria-label': aria || label },
      h('span', { class: 'btn round g-circle', 'aria-hidden': 'true' }, icon(ico)), h('span', { class: 'hm-label' }, label),
      cls === 'is-empty' ? h('span', { class: 'hm-add', 'aria-hidden': 'true' }, t('Προσθήκη')) : null);
    const slots = ['home', 'work'].map((id) => {
      const p = byId.get(id);
      const label = id === 'home' ? t('Σπίτι') : t('Δουλειά');
      return p ? menu.hold(circle('is-set', PLACE_ICON[id], label, placeHash(p), t('Στάσεις κοντά: {name}', { name: label })), p)
        : circle('is-empty', PLACE_ICON[id], label, SET_PLACE(id), t('Όρισε: {name}', { name: label }));
    });
    const custom = saved.filter((p) => !PLACE_ICON[p.id]);
    const own = custom.map((p) => menu.hold(circle('is-set', 'pin', placeLabel(p), placeHash(p), t('Στάσεις κοντά: {name}', { name: placeLabel(p) })), p));
    const add = custom.length < MAX_CUSTOM ? [circle('is-add', 'plus', t('Νέο'), SET_PLACE('new'), t('Προσθήκη μέρους'))] : [];
    container.replaceChildren(h('h2', {}, t('Μέρη')), h('div', { class: 'hm-places' }, ...slots, ...own, ...add));
  };
  paint();
  const off = onPlacesChange(paint);
  return { destroy() { off?.(); menu.destroy(); container.replaceChildren(); } };
}

// The touch & hold menu of a set place: a popover (app.css .pop) under its circle. A hold opens it and the tap that
// ends the hold does not follow the link; a move of more than 10 px cancels the hold (the row scrolls sideways).
function placeMenu() {
  let pop = null, timer = 0;
  const onDown = (e) => { if (pop && !pop.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  function close() {
    if (!pop) return;
    pop.remove(); pop = null;
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('hashchange', close);
  }
  function open(link, p) {
    close();
    const item = (ico, label, attrs) => h(attrs.href ? 'a' : 'button', { class: 'pop-item', role: 'menuitem', ...(attrs.href ? {} : { type: 'button' }), ...attrs }, icon(ico), label);
    const label = placeLabel(p);
    pop = h('div', { class: 'pop hm-menu', role: 'menu', 'aria-label': label },
      item('route', t('Διαδρομή'), { href: tripHash(p), onclick: close }),
      item('pin', t('Αλλαγή'), { href: SET_PLACE(p.id), onclick: close }),
      item('trash', t('Διαγραφή'), { class: 'pop-item is-danger', onclick: () => { close(); if (removePlace(p.id)) toast(t('Διαγράφηκε: {name}', { name: label })); } }));
    document.body.append(pop);
    const r = link.getBoundingClientRect(), w = pop.offsetWidth, ph = pop.offsetHeight;
    const left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 8));
    const top = r.bottom + 6 + ph <= innerHeight - 8 ? r.bottom + 6 : Math.max(8, r.top - ph - 6);
    Object.assign(pop.style, { left: `${left}px`, top: `${top}px` });
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('hashchange', close);
    pop.querySelector('.pop-item')?.focus({ preventScroll: true });
  }
  function hold(link, p) {
    let held = false, start = null;
    const cancel = () => { clearTimeout(timer); start = null; };
    link.addEventListener('pointerdown', (e) => {
      if (e.button) return;
      held = false; start = { x: e.clientX, y: e.clientY };
      clearTimeout(timer);
      timer = setTimeout(() => { held = true; start = null; open(link, p); }, HOLD_MS);
    });
    link.addEventListener('pointermove', (e) => { if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) cancel(); });
    link.addEventListener('pointerup', cancel);
    link.addEventListener('pointercancel', cancel);
    link.addEventListener('click', (e) => { if (held) { e.preventDefault(); held = false; } });
    link.addEventListener('contextmenu', (e) => { e.preventDefault(); cancel(); open(link, p); });
    return link;
  }
  return { hold, close, destroy() { clearTimeout(timer); close(); } };
}

// ---------------------------------------------------------------- favourites with the next arrival
// Polls (the 15 s floor and 20 s poll of api.js) only while the sheet is up: that is the only place they can be seen.
export function mountFavoritesLive(container, ctx, stopRow) {
  const list = h('div', { class: 'list hm-favs' });
  const sec = h('section', { class: 'home-section', hidden: true }, h('h2', {}, t('Αγαπημένες στάσεις')), list);
  container.replaceChildren(sec);
  const rows = new Map(); // stop code → { arr, poller, tile }
  const demand = new Set();
  const up = () => document.body.dataset.sheet === 'full' || matchMedia('(min-width: 900px)').matches;
  const lineOf = (code) => ctx.data?.lineByCode?.get(String(code));
  let ticker = null;

  const note = (arr, text, cls = '') => { arr.replaceChildren(h('span', { class: `hm-note ${cls}` }, text)); };
  async function showTile(code, res) {
    const r = rows.get(code);
    if (!r) return;
    const { arrivalTile } = await import('./arrivals-view.js');
    if (!rows.has(code) || rows.get(code) !== r) return;
    const { data, error } = res;
    if (data?.vehicles?.length) {
      const v = data.vehicles[0];
      r.tile = arrivalTile(v, data.fetchedAt, { compact: true, line: lineOf(v.lineCode), stop: code, stale: isStale(data.fetchedAt, Date.now()) });
      r.arr.replaceChildren(r.tile);
    } else if (data) { r.tile = null; note(r.arr, t('Καμία άφιξη αυτή την ώρα')); }
    else if (error) { r.tile = null; note(r.arr, t('Δεν φορτώθηκαν οι αφίξεις'), 'is-err'); }
  }
  function sync() {
    const active = up();
    for (const [code, r] of rows) {
      const want = active && (r.index < LIVE_FAVS || demand.has(code));
      if (want && !r.poller) r.poller = createLivePoller(code, (res) => { showTile(code, res); });
      else if (!want && r.poller) { r.poller.destroy(); r.poller = null; }
    }
    if (active && !ticker) ticker = setInterval(() => { for (const r of rows.values()) r.tile?.tick?.(Date.now()); }, 1000);
    else if (!active && ticker) { clearInterval(ticker); ticker = null; }
  }
  const paint = () => {
    for (const r of rows.values()) r.poller?.destroy();
    rows.clear();
    const stops = getFavorites().map((c) => ctx.data.stopByCode.get(String(c))).filter(Boolean);
    list.replaceChildren(...stops.map((s, index) => {
      const arr = h('div', { class: 'hm-arr' });
      const r = { arr, index, poller: null, tile: null };
      rows.set(String(s.code), r);
      if (index >= LIVE_FAVS) {
        arr.replaceChildren(h('button', { type: 'button', class: 'btn rect sm', onclick: () => { demand.add(String(s.code)); note(arr, t('Φορτώνει…')); sync(); } }, t('Δες αφίξεις')));
      } else note(arr, t('Φορτώνει…'));
      return h('div', { class: 'hm-fav' }, stopRow(s), arr);
    }));
    sec.hidden = !stops.length;
    sync();
  };
  paint();
  const offs = [onChange(paint)];
  const mo = new MutationObserver(sync);
  mo.observe(document.body, { attributes: true, attributeFilter: ['data-sheet'] });
  return {
    destroy() {
      mo.disconnect(); offs.forEach((f) => f?.());
      if (ticker) clearInterval(ticker);
      for (const r of rows.values()) r.poller?.destroy();
      rows.clear(); container.replaceChildren();
    },
  };
}
