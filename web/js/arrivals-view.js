// Stop sheet: header + arrival tiles that say how long, and whether it is live or just the timetable.
// Contract in docs/ARCHITECTURE.md. Styles: css/arrivals.css (prefixes .atile-, .stopv-).
import { h, icon, lineBadge, fmtClock } from './ui.js';
import { titleCase } from './text.js';
import { createLivePoller, remainingSec, DEMO, STALE_MS } from './api.js';
import { etaText, etaSpoken, ageText } from './arrivals.js';
import { isFavorite, toggleFavorite, addRecent, onChange } from './store.js';
import { shareLink } from './share.js';

export { etaText };

const GONE_SEC = 30; // a vehicle this far past its ETA has left: drop its tile
const MAX_TILES = 10; // beyond this, behind a "show all" button
const NOW_SEC = 15; // under this a tile reads "τώρα"

const whenSpoken = (rem) => (rem < NOW_SEC ? 'τώρα' : `σε ${etaSpoken(rem)}`);

// ---- one arrival tile ----
// v: normalised Vehicle. opts: { compact, now, line }. The element has .tick(now) to refresh the countdown in
// place (the stop view calls it every second; other modules may do the same or just re-render).
export function arrivalTile(v, fetchedAt, { compact = false, now = Date.now(), line } = {}) {
  const live = !!v.live;
  const at = fetchedAt + v.etaSec * 1000; // ETA as a wall-clock instant; constant between fetches
  const clock = fmtClock(at);
  const dest = titleCase(v.routeName);
  const badge = lineBadge({ code: v.lineCode, color: line?.color || v.color, textColor: line?.textColor || v.textColor });

  const num = h('span', { class: 'atile-num' });
  const flag = live
    ? h('span', { class: 'atile-flag' }, h('span', { class: 'atile-dot', 'aria-hidden': 'true' }), 'LIVE')
    : h('span', { class: 'atile-flag' }, icon('clock'), 'ΠΡΟΓΡ.');
  const status = h('div', { class: 'atile-status' }, flag, h('span', { class: 'atile-clock' }, live ? `≈ ${clock}` : clock));
  const note = compact ? null : h('div', { class: 'atile-note' },
    live ? 'Θέση σε πραγματικό χρόνο' : 'Ώρα προγράμματος, μπορεί να μην τηρηθεί');

  const el = h('div', { class: `atile ${live ? 'atile-live' : 'atile-sched'}${compact ? ' atile-compact' : ''}`, role: 'img' },
    h('div', { class: 'atile-badge' }, badge),
    h('div', { class: 'atile-body' }, h('div', { class: 'atile-dest' }, dest), status, note),
    h('div', { class: 'atile-eta' }, num));

  let lastText = null;
  el.tick = (t = Date.now()) => {
    const rem = remainingSec(v, fetchedAt, t);
    const text = etaText(rem);
    el.classList.toggle('atile-now', rem < NOW_SEC);
    if (text === lastText) return;
    lastText = text;
    num.textContent = text;
    el.setAttribute('aria-label', live
      ? `Γραμμή ${v.lineCode}, ${dest}. Ζωντανή θέση: φτάνει ${whenSpoken(rem)}, περίπου στις ${clock}.`
      : `Γραμμή ${v.lineCode}, ${dest}. Προγραμματισμένη άφιξη στις ${clock}, ${whenSpoken(rem)}. Δεν υπάρχει ζωντανή θέση και μπορεί να μην τηρηθεί.`);
  };
  el.tick(now);
  return el;
}

const skeleton = () => h('li', { class: 'atile atile-skel', 'aria-hidden': 'true' },
  h('div', { class: 'atile-badge' }, h('span', { class: 'skel skel-badge' })),
  h('div', { class: 'atile-body' }, h('span', { class: 'skel skel-line' }), h('span', { class: 'skel skel-line short' })),
  h('div', { class: 'atile-eta' }, h('span', { class: 'skel skel-num' })));

const ERR_TEXT = {
  network: 'Δεν υπάρχει σύνδεση με το διαδίκτυο.',
  timeout: 'Η απάντηση άργησε πολύ.',
  upstream: 'Η υπηρεσία πληροφόρησης δεν ανταποκρίνεται αυτή τη στιγμή.',
  bad: 'Η απάντηση του διακομιστή δεν ήταν έγκυρη.',
};
const errText = (e) => ERR_TEXT[e && e.kind] || ERR_TEXT.upstream;
const secsUntil = (at, now) => Math.max(0, Math.ceil((at - now) / 1000));

// ---- the stop view ----
export function mountStop(container, ctx, { code }) {
  code = String(code);
  const stop = ctx.data && ctx.data.stopByCode.get(code);
  const root = h('div', { class: 'stopv' });
  container.replaceChildren(root);
  if (!stop) {
    root.append(
      h('p', { class: 'stopv-msg' }, 'Η στάση δεν βρέθηκε.'),
      h('button', { type: 'button', class: 'stopv-btn stopv-primary', onclick: () => ctx.navigate('#/') }, 'Πίσω στην αρχική'));
    return { destroy() { root.remove(); } };
  }

  let dead = false;
  let st = { data: null, error: null, loading: true, nextAt: 0 };
  let filter = null; // lineCode or null
  let showAll = false;
  let stale = false;
  let retryPending = false;
  let fitted = false;
  let tiles = []; // { v, el } for the tiles currently shown
  let timer = null;

  // Map calls go through one queue so they wait for map.ready and run in order, even after destroy.
  let mapQ = Promise.resolve(ctx.map && ctx.map.ready).catch(() => {});
  const onMap = (fn) => { mapQ = mapQ.then(() => { try { if (ctx.map) fn(ctx.map); } catch (e) { console.warn('map', e); } }); };

  addRecent('stop', { code, name: stop.displayName });

  // ---- header ----
  const iconBtn = (name, label, onclick) => h('button', { type: 'button', class: 'stopv-btn', 'aria-label': label, title: label, onclick }, icon(name));
  const star = h('button', { type: 'button', class: 'stopv-btn stopv-star', onclick: () => { toggleFavorite(code); paintStar(); } });
  function paintStar() {
    const on = isFavorite(code);
    const label = on ? 'Αφαίρεση από τα αγαπημένα' : 'Προσθήκη στα αγαπημένα';
    star.replaceChildren(icon(on ? 'star-on' : 'star'));
    star.classList.toggle('on', on);
    star.setAttribute('aria-pressed', String(on));
    star.setAttribute('aria-label', label);
    star.title = label;
  }
  paintStar();
  const unsubStore = onChange(paintStar);

  async function share() {
    const url = `${location.origin}${location.pathname}#/stop/${encodeURIComponent(code)}`;
    const r = await shareLink({ title: `Στάση ${stop.displayName}`, text: `Αφίξεις λεωφορείων στη στάση ${stop.displayName} (${code})`, url });
    if (r === 'copied') ctx.toast('Ο σύνδεσμος αντιγράφηκε');
    else if (r === 'failed') ctx.toast('Δεν ήταν δυνατή η κοινοποίηση');
  }

  const go = h('button', {
    type: 'button',
    class: 'stopv-go',
    onclick: () => ctx.navigate(`#/plan?to=${stop.lat.toFixed(6)},${stop.lng.toFixed(6)}&name=${encodeURIComponent(stop.displayName)}`),
  }, icon('walk'), 'Οδηγίες ως εδώ');

  const lineBadges = [...(stop.lineCodes || [])].sort((a, b) => a.localeCompare(b, 'el', { numeric: true }))
    .map((c) => lineBadge(ctx.data.lineByCode.get(c) || { code: c }));

  const head = h('header', { class: 'stopv-head' },
    h('div', { class: 'stopv-top' },
      h('div', { class: 'stopv-titles' },
        h('h1', { class: 'stopv-name' }, stop.displayName),
        h('p', { class: 'stopv-sub' }, h('span', { class: 'stopv-code' }, `Στάση ${code}`), lineBadges.length ? h('span', { class: 'stopv-lines', 'aria-label': 'Γραμμές που περνούν' }, lineBadges) : null)),
      h('div', { class: 'stopv-actions' }, star, iconBtn('share', 'Κοινοποίηση', share), iconBtn('close', 'Κλείσιμο', () => ctx.navigate('#/')))),
    go);

  // ---- dynamic parts ----
  const bannerText = h('span', { class: 'stopv-banner-text' });
  const bannerBtn = h('button', { type: 'button', class: 'stopv-btn stopv-small', onclick: () => doRefresh() }, 'Δοκίμασε ξανά');
  const banner = h('div', { class: 'stopv-banner', role: 'status', hidden: true }, icon('alert'), bannerText, bannerBtn);
  const chips = h('div', { class: 'stopv-chips', role: 'group', 'aria-label': 'Φίλτρο γραμμής', hidden: true });
  const body = h('div', { class: 'stopv-body' });
  const foot = h('p', { class: 'stopv-foot-text' });
  const refreshBtn = h('button', { type: 'button', class: 'stopv-btn stopv-small', onclick: () => doRefresh() }, icon('refresh'), 'Ανανέωση');
  const legend = h('p', { class: 'stopv-legend' },
    h('span', { class: 'atile-dot', 'aria-hidden': 'true' }), h('b', {}, 'LIVE'), ' = θέση οχήματος σε πραγματικό χρόνο · ',
    icon('clock'), h('b', {}, 'ΠΡΟΓΡ.'), ' = ώρα από το πρόγραμμα, μπορεί να μην τηρηθεί');
  root.append(head, banner, chips, body,
    h('footer', { class: 'stopv-foot' }, h('div', { class: 'stopv-foot-row' }, foot, refreshBtn), legend,
      DEMO ? h('p', { class: 'stopv-demo' }, 'Δεδομένα προσομοίωσης (demo): δεν είναι πραγματικά λεωφορεία.') : null));

  const poller = createLivePoller(code, (s) => {
    if (dead) return;
    if (s.loading) retryPending = false;
    st = s;
    render();
    pushMap();
  });

  function doRefresh() {
    retryPending = true;
    poller.refresh();
    paintDynamic(Date.now());
  }

  const leftSec = (v, fetchedAt, now) => v.etaSec - (now - fetchedAt) / 1000; // unclamped

  function render() {
    if (dead) return;
    const now = Date.now();
    const data = st.data;
    stale = !!data && now - data.fetchedAt > STALE_MS;
    const all = data ? data.vehicles.filter((v) => leftSec(v, data.fetchedAt, now) > -GONE_SEC) : [];

    // chips (only worth showing when 2+ lines have arrivals)
    const lines = [];
    for (const v of all) if (!lines.some((l) => l.code === v.lineCode)) lines.push({ code: v.lineCode, color: v.color, textColor: v.textColor });
    if (filter && !lines.some((l) => l.code === filter)) lines.push({ code: filter, color: ctx.data.lineByCode.get(filter)?.color, textColor: ctx.data.lineByCode.get(filter)?.textColor });
    chips.hidden = lines.length < 2;
    if (!chips.hidden) {
      const chip = (label, on, onclick, kids) => h('button', { type: 'button', class: `stopv-chip${on ? ' on' : ''}`, 'aria-pressed': String(on), onclick }, kids || label);
      chips.replaceChildren(
        chip('Όλες', !filter, () => { filter = null; showAll = false; render(); pushMap(); }),
        ...lines.map((l) => chip(null, filter === l.code, () => { filter = filter === l.code ? null : l.code; showAll = false; render(); pushMap(); },
          [lineBadge(ctx.data.lineByCode.get(l.code) || l)])));
    }

    // body
    body.setAttribute('aria-busy', String(!data && !st.error));
    tiles = [];
    if (!data && !st.error) {
      body.replaceChildren(h('ul', { class: 'stopv-list' }, skeleton(), skeleton(), skeleton()));
    } else if (!data) {
      body.replaceChildren(h('div', { class: 'stopv-state' },
        icon('alert'), h('p', { class: 'stopv-state-title' }, 'Δεν φορτώθηκαν οι αφίξεις'),
        h('p', { class: 'stopv-state-sub' }, errText(st.error)), retryButton()));
    } else if (!all.length) {
      body.replaceChildren(h('div', { class: 'stopv-state' },
        icon('clock'), h('p', { class: 'stopv-state-title' }, 'Καμία προγραμματισμένη άφιξη αυτή τη στιγμή'),
        h('p', { class: 'stopv-state-sub' }, 'Η λίστα ανανεώνεται αυτόματα.')));
    } else {
      const shown = filter ? all.filter((v) => v.lineCode === filter) : all;
      if (!shown.length) {
        body.replaceChildren(h('div', { class: 'stopv-state' },
          icon('clock'), h('p', { class: 'stopv-state-title' }, `Καμία άφιξη για τη γραμμή ${filter}`),
          h('button', { type: 'button', class: 'stopv-btn stopv-small', onclick: () => { filter = null; render(); pushMap(); } }, 'Εμφάνιση όλων των γραμμών')));
      } else {
        const cut = showAll ? shown : shown.slice(0, MAX_TILES);
        const items = cut.map((v) => {
          const t = arrivalTile(v, data.fetchedAt, { now, line: ctx.data.lineByCode.get(v.lineCode) });
          tiles.push({ v, el: t });
          return h('li', {}, t);
        });
        // replaceChildren would stringify a null child as "null", so only pass real nodes.
        body.replaceChildren(h('ul', { class: `stopv-list${stale ? ' is-stale' : ''}` }, items));
        if (cut.length < shown.length) {
          body.append(h('button', { type: 'button', class: 'stopv-btn stopv-more', onclick: () => { showAll = true; render(); } }, `Εμφάνιση όλων (${shown.length})`));
        }
      }
    }
    paintDynamic(now);
  }

  const retryButton = () => h('button', { type: 'button', class: 'stopv-btn stopv-primary stopv-retry', onclick: () => doRefresh() }, 'Δοκίμασε ξανά');

  // Banner, retry labels and footer: cheap, repainted every second.
  function paintDynamic(now) {
    const data = st.data;
    const age = data ? (now - data.fetchedAt) / 1000 : 0;
    banner.hidden = !(data && stale);
    if (!banner.hidden) bannerText.textContent = `Παλιά δεδομένα: ενημερώθηκαν πριν ${ageText(age)}.${st.error ? ` ${errText(st.error)}` : ''}`;
    const wait = st.nextAt ? secsUntil(st.nextAt, now) : 0;
    const label = st.loading ? 'Ανανέωση…' : retryPending && wait > 0 ? `Νέα προσπάθεια σε ${wait}″` : 'Δοκίμασε ξανά';
    for (const b of [bannerBtn, ...body.querySelectorAll('.stopv-retry')]) {
      b.textContent = label;
      b.disabled = st.loading || (retryPending && wait > 0);
    }
    refreshBtn.disabled = st.loading;
    const bits = [];
    if (data) bits.push(`ενημερώθηκε πριν ${ageText(age)}`);
    if (st.loading) bits.push('ανανέωση…');
    else if (st.nextAt) bits.push(`ανανέωση σε ${wait}″`);
    if (st.error && data) bits.push('η τελευταία ανανέωση απέτυχε');
    foot.textContent = bits.join(' · ');
  }

  // ---- map ----
  onMap((m) => { m.highlightStop(code); m.flyTo({ lat: stop.lat, lng: stop.lng }, 16); });

  let pushed = '';
  function pushMap() {
    const data = st.data;
    const key = `${data ? data.fetchedAt : ''}|${stale}|${filter}`;
    if (key === pushed) return;
    pushed = key;
    const buses = data && !stale
      ? data.vehicles.filter((v) => v.live && Number.isFinite(v.lat) && Number.isFinite(v.lng) && (!filter || v.lineCode === filter))
      : [];
    const pts = buses.map((v) => ({ lat: v.lat, lng: v.lng, lineCode: v.lineCode, color: v.color || '#757575', textColor: v.textColor || '#ffffff', label: v.lineCode }));
    onMap((m) => { if (!dead) m.setVehicles('stop', pts); });
    if (!fitted && data) {
      fitted = true;
      // Bring the nearest live bus into view when it is not already around the stop.
      const near = pts.map((p) => ({ p, d: Math.hypot((p.lat - stop.lat) * 111000, (p.lng - stop.lng) * 87000) })).sort((a, b) => a.d - b.d)[0];
      if (near && near.d > 250 && near.d < 3000) onMap((m) => { if (!dead) m.fitTo([{ lat: stop.lat, lng: stop.lng }, near.p], { maxZoom: 16 }); });
    }
  }

  // ---- clock ----
  function tick() {
    if (dead) return;
    const now = Date.now();
    const data = st.data;
    // Rebuild when the data went stale or a shown vehicle has left; otherwise just move the numbers.
    if (data && ((now - data.fetchedAt > STALE_MS) !== stale || tiles.some((t) => leftSec(t.v, data.fetchedAt, now) <= -GONE_SEC))) {
      render();
      pushMap();
      return;
    }
    for (const t of tiles) t.el.tick(now);
    paintDynamic(now);
  }
  function onVisibility() {
    clearInterval(timer);
    timer = null;
    if (document.visibilityState !== 'visible') return;
    tick();
    timer = setInterval(tick, 1000);
  }
  document.addEventListener('visibilitychange', onVisibility);
  onVisibility();
  render();

  return {
    destroy() {
      dead = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      unsubStore();
      poller.destroy();
      mapQ = mapQ.then(() => { try { if (ctx.map) { ctx.map.clearVehicles('stop'); ctx.map.highlightStop(null); } } catch (e) { console.warn('map', e); } });
      root.remove();
    },
  };
}
