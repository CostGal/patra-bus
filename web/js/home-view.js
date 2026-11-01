// Home parts for the sheet (TEL-232, owner: shell): the Places row (mid), the favourites with their next arrival live
// and the routines (up). The recents and the layout live in app.js mountHome. Style: DESIGN.md §4 and §10, css/home.css.
import { h, icon } from './ui.js';
import { t } from './i18n.js';
import { cityHash } from './route.js';
import { createLivePoller, isStale } from './api.js';
import { getFavorites, onChange } from './store.js';
import { getPlaces, onPlacesChange, placeLabel, placeHash, MAX_CUSTOM } from './places.js';
import { getRoutines, onRoutinesChange, routineLabel } from './routines.js';

export const LIVE_FAVS = 4; // favourites that fetch their arrival; the rest load on demand ("Δες αφίξεις")
// Where places and routines are set (settings-view.js opens this section for ?section=home)
const SETTINGS_PLACES = () => cityHash('#/settings?section=home');
const PLACE_ICON = { home: 'home', work: 'briefcase' };

// ---------------------------------------------------------------- Places: round buttons
// Σπίτι and Δουλειά are always there (dimmed until set: a tap sets them in the settings), then your own places, then "+".
// Each is the card's round glass button (.g-circle, DESIGN §10) at 48 px, its label under it; js/glass.js presses the circle.
export function mountPlacesRow(container) {
  const paint = () => {
    const saved = getPlaces().filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng));
    const byId = new Map(saved.map((p) => [p.id, p]));
    const circle = (cls, ico, label, href, aria) => h('a', { class: `hm-place press ${cls}`, href, 'aria-label': aria || label },
      h('span', { class: 'btn round g-circle', 'aria-hidden': 'true' }, icon(ico)), h('span', { class: 'hm-label' }, label));
    const slots = ['home', 'work'].map((id) => {
      const p = byId.get(id);
      const label = id === 'home' ? t('Σπίτι') : t('Δουλειά');
      return p ? circle('', PLACE_ICON[id], label, placeHash(p), t('Διαδρομή: {name}', { name: label }))
        : circle('is-empty', PLACE_ICON[id], label, SETTINGS_PLACES(), t('Όρισε: {name}', { name: label }));
    });
    const custom = saved.filter((p) => !PLACE_ICON[p.id]);
    const own = custom.map((p) => circle('', 'pin', placeLabel(p), placeHash(p), t('Διαδρομή: {name}', { name: placeLabel(p) })));
    const add = custom.length < MAX_CUSTOM ? [circle('is-add', 'plus', t('Νέο'), SETTINGS_PLACES(), t('Προσθήκη μέρους'))] : [];
    container.replaceChildren(h('h2', {}, t('Μέρη')), h('div', { class: 'hm-places' }, ...slots, ...own, ...add));
  };
  paint();
  const off = onPlacesChange(paint);
  return { destroy() { off?.(); container.replaceChildren(); } };
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

// ---------------------------------------------------------------- my routines (read only: they are edited in the settings)
export function mountRoutinesHome(container) {
  const paint = () => {
    const rs = getRoutines();
    if (!rs.length) { container.replaceChildren(); return; }
    container.replaceChildren(h('section', { class: 'home-section' }, h('h2', {}, t('Οι ρουτίνες μου')),
      h('div', { class: 'list' }, rs.map((r) => h('a', { class: 'stop-row', href: SETTINGS_PLACES() },
        h('span', { class: 'stop-ico' }, icon('clock')),
        h('span', { class: 'stop-main' }, h('div', { class: 'stop-name' }, routineLabel(r, t(r.placeName || 'Τόπος')))),
        h('span', { class: 'chev' }, icon('chevron')))))));
  };
  paint();
  const off = onRoutinesChange(paint);
  return { destroy() { off?.(); container.replaceChildren(); } };
}
