// Stop sheet: header + arrival tiles that say how long, and whether it is live or just the timetable.
// Contract in docs/ARCHITECTURE.md. Styles: css/arrivals.css (prefixes .atile-, .stopv-).
// Minimal UI: a tile is badge + destination + big countdown + a small LIVE / ΠΡΟΓΡ. flag; explanations live in Settings → Σχετικά.
import { h, icon, lineBadge, fmtClock } from './ui.js';
import { titleCase } from './text.js';
import { createLivePoller, remainingSec, fetchStats, usualDelayText, DEMO, STALE_MS } from './api.js';
import { ageText } from './arrivals.js';
import { isFavorite, toggleFavorite, addRecent, onChange } from './store.js';
import { shareLink } from './share.js';
import { t, etaTxt, etaSay } from './i18n.js';
import { cityHash, shareHash } from './route.js';

export { etaTxt as etaText };

const GONE_SEC = 30; // a vehicle this far past its ETA has left: drop its tile
const MAX_TILES = 10; // beyond this, behind a "show all" button
const NOW_SEC = 15; // under this a tile reads "τώρα"

const whenSpoken = (rem) => (rem < NOW_SEC ? t('τώρα') : t('σε {when}', { when: etaSay(rem) }));

// ---- one arrival tile ----
// v: normalised Vehicle. opts: { compact, now, line, stop, lineLinks, stat }. The element has .tick(now) to refresh the countdown in
// place (the stop view calls it every second; other modules may do the same or just re-render) and .setStat(stat) to show the
// quiet "συνήθως +3′" under a scheduled tile (reliability stats from api.fetchStats; ignored for live ones).
// With opts.stop (the stop code the tile belongs to) the tile is a link: a live bus opens its route (#/bus/…), a scheduled
// departure (no vehicle position) opens its line (#/line/…; lineLinks: false turns that off, e.g. inside the line view).
export const busHash = (v, stop) => cityHash(`#/bus/${encodeURIComponent(v.vehicleCode)}?route=${encodeURIComponent(v.routeCode)}&stop=${encodeURIComponent(stop)}`);
const lineHash = (v) => cityHash(`#/line/${encodeURIComponent(v.lineCode)}?route=${encodeURIComponent(v.routeCode)}`);

export function arrivalTile(v, fetchedAt, { compact = false, now = Date.now(), line, stop, lineLinks = true, stat = null } = {}) {
  const live = !!v.live;
  const href = stop && live && v.vehicleCode && v.routeCode ? busHash(v, stop)
    : stop && !live && lineLinks && v.lineCode && v.routeCode ? lineHash(v) : null;
  const at = fetchedAt + v.etaSec * 1000; // ETA as a wall-clock instant; constant between fetches
  const clock = fmtClock(at);
  const dest = titleCase(v.routeName);
  const badge = lineBadge({ code: v.lineCode, color: line?.color || v.color, textColor: line?.textColor || v.textColor });

  const num = h('span', { class: 'atile-num tabular' });
  const flag = live
    ? h('span', { class: 'atile-flag' }, h('span', { class: 'atile-dot', 'aria-hidden': 'true' }), t('LIVE'))
    : h('span', { class: 'atile-flag' }, icon('clock'), t('ΠΡΟΓΡ.'), h('span', { class: 'atile-clock' }, clock));
  const usual = h('span', { class: 'atile-usual', hidden: true });
  const status = h('div', { class: 'atile-status' }, flag, live ? null : usual);

  const el = h(href ? 'a' : 'div', { class: `atile ${live ? 'atile-live' : 'atile-sched'}${compact ? ' atile-compact' : ''}${href ? ' atile-link press' : ''}`, role: href ? null : 'img', href },
    h('div', { class: 'atile-badge' }, badge),
    h('div', { class: 'atile-body' }, h('div', { class: 'atile-dest' }, dest), status),
    h('div', { class: 'atile-eta' }, num),
    href ? icon('chevron') : null);
  const hint = href ? (live ? t(' Πάτα για τη διαδρομή του οχήματος.') : t(' Πάτα για τη γραμμή.')) : '';

  let lastText = null, usualTxt = '';
  const label = (rem) => {
    const a = { line: v.lineCode, dest, clock, when: whenSpoken(rem), hint };
    return live ? t('Γραμμή {line}, {dest}. Ζωντανή θέση: φτάνει {when}, περίπου στις {clock}.{hint}', a)
      : t('Γραμμή {line}, {dest}. Προγραμματισμένη άφιξη στις {clock}, {when}. Δεν υπάρχει ζωντανή θέση και μπορεί να μην τηρηθεί.', a) + (usualTxt ? ` ${usualTxt}.` : '') + hint;
  };
  el.tick = (t0 = Date.now()) => {
    const rem = remainingSec(v, fetchedAt, t0);
    const text = etaTxt(rem);
    el.classList.toggle('atile-now', rem < NOW_SEC);
    if (text === lastText) return;
    lastText = text;
    num.textContent = text;
    el.setAttribute('aria-label', label(rem));
  };
  el.setStat = (s) => {
    usualTxt = live ? '' : usualDelayText(s);
    if (usual.textContent !== usualTxt) usual.textContent = usualTxt;
    usual.hidden = !usualTxt;
    if (lastText != null) { lastText = null; el.tick(Date.now()); }
  };
  el.tick(now);
  if (stat) el.setStat(stat);
  return el;
}

const skeleton = () => h('li', { class: 'atile atile-skel', 'aria-hidden': 'true' },
  h('div', { class: 'atile-badge' }, h('span', { class: 'skel skel-badge' })),
  h('div', { class: 'atile-body' }, h('span', { class: 'skel skel-line' }), h('span', { class: 'skel skel-line short' })),
  h('div', { class: 'atile-eta' }, h('span', { class: 'skel skel-num' })));

const ERR_TEXT = () => ({
  network: t('Δεν υπάρχει σύνδεση με το διαδίκτυο.'),
  timeout: t('Η απάντηση άργησε πολύ.'),
  upstream: t('Η υπηρεσία πληροφόρησης δεν ανταποκρίνεται αυτή τη στιγμή.'),
  bad: t('Η απάντηση του διακομιστή δεν ήταν έγκυρη.'),
});
const errText = (e) => ERR_TEXT()[e && e.kind] || ERR_TEXT().upstream;
const secsUntil = (at, now) => Math.max(0, Math.ceil((at - now) / 1000));

// ---- the stop view ----
export function mountStop(container, ctx, { code }) {
  code = String(code);
  const stop = ctx.data && ctx.data.stopByCode.get(code);
  const root = h('div', { class: 'stopv' });
  container.replaceChildren(root);
  if (!stop) {
    root.append(
      h('p', { class: 'stopv-msg' }, t('Η στάση δεν βρέθηκε.')),
      h('button', { type: 'button', class: 'stopv-btn stopv-primary', onclick: () => ctx.navigate('#/') }, t('Πίσω στην αρχική')));
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
  const stats = new Map(); // routeCode -> stat | null (asked once per mount; api.js memoises across mounts)

  // Map calls go through one queue so they wait for map.ready and run in order, even after destroy.
  let mapQ = Promise.resolve(ctx.map && ctx.map.ready).catch(() => {});
  const onMap = (fn) => { mapQ = mapQ.then(() => { try { if (ctx.map) fn(ctx.map); } catch (e) { console.warn('map', e); } }); };

  addRecent('stop', { code, name: stop.displayName });

  // ---- header: name · ★ · ⋯ (share, directions) · close ----
  const iconBtn = (name, label, onclick) => h('button', { type: 'button', class: 'stopv-btn', 'aria-label': label, title: label, onclick }, icon(name));
  const star = h('button', { type: 'button', class: 'stopv-btn stopv-star', onclick: () => { toggleFavorite(code); paintStar(); } });
  function paintStar() {
    const on = isFavorite(code);
    const label = on ? t('Αφαίρεση από τα αγαπημένα') : t('Προσθήκη στα αγαπημένα');
    star.replaceChildren(icon(on ? 'star-on' : 'star'));
    star.classList.toggle('on', on);
    star.setAttribute('aria-pressed', String(on));
    star.setAttribute('aria-label', label);
    star.title = label;
  }
  paintStar();
  const unsubStore = onChange(paintStar);

  async function share() {
    const url = `${location.origin}${location.pathname}${shareHash(`#/stop/${encodeURIComponent(code)}`)}`;
    const r = await shareLink({ title: t('Στάση {name}', { name: stop.displayName }), text: t('Αφίξεις λεωφορείων στη στάση {name} ({code})', { name: stop.displayName, code }), url });
    if (r === 'copied') ctx.toast(t('Ο σύνδεσμος αντιγράφηκε'));
    else if (r === 'failed') ctx.toast(t('Δεν ήταν δυνατή η κοινοποίηση'));
  }
  const directions = () => ctx.navigate(`#/plan?to=${stop.lat.toFixed(6)},${stop.lng.toFixed(6)}&name=${encodeURIComponent(stop.displayName)}`);

  const menu = h('div', { class: 'stopv-menu', role: 'menu', hidden: true },
    h('button', { type: 'button', role: 'menuitem', class: 'stopv-item', onclick: () => { setMenu(false); directions(); } }, icon('walk'), t('Οδηγίες ως εδώ')),
    h('button', { type: 'button', role: 'menuitem', class: 'stopv-item', onclick: () => { setMenu(false); share(); } }, icon('share'), t('Κοινοποίηση')));
  const moreBtn = h('button', { type: 'button', class: 'stopv-btn stopv-more-btn', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': t('Περισσότερα'), title: t('Περισσότερα'), onclick: () => setMenu(menu.hidden) }, '⋯');
  function setMenu(open) {
    menu.hidden = !open;
    moreBtn.setAttribute('aria-expanded', String(open));
    if (open) menu.querySelector('button')?.focus();
  }
  const onDocClick = (e) => { if (!menu.hidden && !menu.contains(e.target) && !moreBtn.contains(e.target)) setMenu(false); };
  const onKey = (e) => { if (e.key === 'Escape' && !menu.hidden) { setMenu(false); moreBtn.focus(); } };
  document.addEventListener('click', onDocClick);
  document.addEventListener('keydown', onKey);

  const head = h('header', { class: 'stopv-head' },
    h('div', { class: 'stopv-top' },
      h('div', { class: 'stopv-titles' },
        h('h1', { class: 'stopv-name' }, stop.displayName),
        h('p', { class: 'stopv-sub' }, t('Στάση {code}', { code }))),
      h('div', { class: 'stopv-actions' }, star, moreBtn, iconBtn('close', t('Κλείσιμο'), () => ctx.navigate('#/')), menu)));

  // ---- dynamic parts ----
  const bannerText = h('span', { class: 'stopv-banner-text' });
  const bannerBtn = h('button', { type: 'button', class: 'stopv-btn stopv-small', onclick: () => doRefresh() }, t('Δοκίμασε ξανά'));
  const banner = h('div', { class: 'stopv-banner', role: 'status', hidden: true }, icon('alert'), bannerText, bannerBtn);
  const chips = h('div', { class: 'stopv-chips fade-edge-bottom', role: 'group', 'aria-label': t('Φίλτρο γραμμής'), hidden: true });
  const body = h('div', { class: 'stopv-body' });
  const foot = h('p', { class: 'stopv-foot-text' });
  const refreshBtn = h('button', { type: 'button', class: 'stopv-btn stopv-refresh', 'aria-label': t('Ανανέωση'), title: t('Ανανέωση'), onclick: () => doRefresh() }, icon('refresh'));
  root.append(head, banner, chips, body, h('footer', { class: 'stopv-foot' }, foot, refreshBtn));

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

  // Reliability stats, lazily and only for routes with a scheduled tile on screen (api.js: memo 10 min, never throws).
  function wantStats() {
    for (const { v, el } of tiles) {
      if (v.live || !v.routeCode) continue;
      if (stats.has(v.routeCode)) { if (stats.get(v.routeCode)) el.setStat(stats.get(v.routeCode)); continue; }
      stats.set(v.routeCode, null);
      fetchStats(v.routeCode, code).then((s) => {
        if (dead || !s) return;
        stats.set(v.routeCode, s);
        for (const x of tiles) if (!x.v.live && x.v.routeCode === v.routeCode) x.el.setStat(s);
      });
    }
  }

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
        chip(t('Όλες'), !filter, () => { filter = null; showAll = false; render(); pushMap(); }),
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
        icon('alert'), h('p', { class: 'stopv-state-title' }, t('Δεν φορτώθηκαν οι αφίξεις')),
        h('p', { class: 'stopv-state-sub' }, errText(st.error)), retryButton()));
    } else if (!all.length) {
      body.replaceChildren(h('div', { class: 'stopv-state' },
        icon('clock'), h('p', { class: 'stopv-state-title' }, t('Καμία προγραμματισμένη άφιξη αυτή τη στιγμή')),
        h('p', { class: 'stopv-state-sub' }, t('Η λίστα ανανεώνεται αυτόματα.'))));
    } else {
      const shown = filter ? all.filter((v) => v.lineCode === filter) : all;
      if (!shown.length) {
        body.replaceChildren(h('div', { class: 'stopv-state' },
          icon('clock'), h('p', { class: 'stopv-state-title' }, t('Καμία άφιξη για τη γραμμή {line}', { line: filter })),
          h('button', { type: 'button', class: 'stopv-btn stopv-small', onclick: () => { filter = null; render(); pushMap(); } }, t('Εμφάνιση όλων των γραμμών'))));
      } else {
        const cut = showAll ? shown : shown.slice(0, MAX_TILES);
        const items = cut.map((v) => {
          const tl = arrivalTile(v, data.fetchedAt, { now, line: ctx.data.lineByCode.get(v.lineCode), stop: code, stat: v.live ? null : stats.get(v.routeCode) });
          tl.dataset.key = v.vehicleCode || `${v.routeCode}:${v.etaSec}`;
          tiles.push({ v, el: tl });
          return h('li', {}, tl);
        });
        // Tiles are links: a refresh must not drop keyboard focus.
        const focused = document.activeElement && body.contains(document.activeElement) ? document.activeElement.dataset?.key : null;
        // replaceChildren would stringify a null child as "null", so only pass real nodes.
        body.replaceChildren(h('ul', { class: `stopv-list${stale ? ' is-stale' : ''}` }, items));
        if (focused) tiles.find((x) => x.el.dataset.key === focused)?.el.focus({ preventScroll: true });
        if (cut.length < shown.length) {
          body.append(h('button', { type: 'button', class: 'stopv-btn stopv-more', onclick: () => { showAll = true; render(); } }, t('Εμφάνιση όλων ({n})', { n: shown.length })));
        }
        wantStats();
      }
    }
    paintDynamic(now);
  }

  const retryButton = () => h('button', { type: 'button', class: 'stopv-btn stopv-primary stopv-retry', onclick: () => doRefresh() }, t('Δοκίμασε ξανά'));

  // Banner, retry labels and footer: cheap, repainted every second.
  function paintDynamic(now) {
    const data = st.data;
    const age = data ? (now - data.fetchedAt) / 1000 : 0;
    banner.hidden = !(data && stale);
    if (!banner.hidden) bannerText.textContent = t('Παλιά δεδομένα: ενημερώθηκαν πριν {age}.', { age: ageText(age) }) + (st.error ? ` ${errText(st.error)}` : '');
    const wait = st.nextAt ? secsUntil(st.nextAt, now) : 0;
    const label = st.loading ? t('Ανανέωση…') : retryPending && wait > 0 ? t('Νέα προσπάθεια σε {n}″', { n: wait }) : t('Δοκίμασε ξανά');
    for (const b of [bannerBtn, ...body.querySelectorAll('.stopv-retry')]) {
      b.textContent = label;
      b.disabled = st.loading || (retryPending && wait > 0);
    }
    refreshBtn.disabled = st.loading;
    // one quiet line: age · next refresh (· demo)
    const bits = [];
    if (DEMO) bits.push(t('δεδομένα προσομοίωσης'));
    if (data) bits.push(t('ενημερώθηκε πριν {age}', { age: ageText(age) }));
    if (st.loading) bits.push(t('ανανέωση…'));
    else if (st.nextAt) bits.push(t('ανανέωση σε {n}″', { n: wait }));
    if (st.error && data) bits.push(t('η τελευταία ανανέωση απέτυχε'));
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
    // vehicleCode / routeCode / stopCode make the marker tappable (map.js onVehicleClick -> #/bus/…)
    const pts = buses.map((v) => ({ lat: v.lat, lng: v.lng, lineCode: v.lineCode, color: v.color || '#757575', textColor: v.textColor || '#ffffff', label: v.lineCode, vehicleCode: v.vehicleCode, routeCode: v.routeCode, stopCode: code }));
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
    if (data && ((now - data.fetchedAt > STALE_MS) !== stale || tiles.some((x) => leftSec(x.v, data.fetchedAt, now) <= -GONE_SEC))) {
      render();
      pushMap();
      return;
    }
    for (const x of tiles) x.el.tick(now);
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
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onKey);
      unsubStore();
      poller.destroy();
      mapQ = mapQ.then(() => { try { if (ctx.map) { ctx.map.clearVehicles('stop'); ctx.map.highlightStop(null); } } catch (e) { console.warn('map', e); } });
      root.remove();
    },
  };
}
