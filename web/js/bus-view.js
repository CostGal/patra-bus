// Bus view (#/bus/{vehicleCode}?route={routeCode}&stop={stopCode}): the route of ONE bus as a stop timeline.
// Live data exists only per stop, so the bus is followed through the stop it was opened from (the "anchor"): its live
// ETA there is the only measured time; everything else is that ETA plus/minus the route's typical leg times (an
// ESTIMATE, labelled so). Route order itself is inferred (routes.json), see route.confidence. Styles: css/extras.css (bv-).
import { h, icon, lineBadge, fmtClock, toast } from './ui.js';
import { createLivePoller, DEMO, STALE_MS } from './api.js';
import { etaText, ageText } from './arrivals.js';
import { loadShapes } from './data.js';
import { closestOnPath } from './geo.js';
import { t } from './i18n.js';
import { activeTrip, onTripChange, startOnboard, stopOnboard } from './onboard.js';

export const MAX_SNAP_M = 250; // a GPS fix farther than this from the stop polyline is not trusted for placement
const TICK_MS = 5000;
const NOW_SEC = 15;
const LOW_CONF = 0.5;

// ---------------------------------------------------------------- pure maths

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// Where a GPS point sits along the stop polyline: { seg, t, meters } = between stop `seg` and `seg + 1`, fraction t.
// null when there is no route, no usable point, or the point is farther than MAX_SNAP_M from the route.
export function locateOnRoute(pts, p) {
  if (!Array.isArray(pts) || pts.length < 2 || !p || !Number.isFinite(p.lat) || !Number.isFinite(p.lng)) return null;
  const c = closestOnPath(pts.map((s) => [s.lng, s.lat]), p);
  if (!c || c.meters > MAX_SNAP_M) return null;
  return { seg: c.index, t: c.t, meters: c.meters };
}

// Pure timeline of one bus along `route` ({ stops: string[], legSec: number[], confidence? }).
// anchorStop/anchorEtaSec/fetchedAt: its live ETA at that stop as of fetchedAt. vehiclePos: locateOnRoute() result or null.
// Returns null if the anchor is not on the route. Otherwise:
//   rows[i] = { index, code, state: 'passed'|'upcoming', kind: 'past'|'anchor'|'estimate', at: epoch ms|null, etaSec: number|null }
//   seg = the bus is between stop `seg` and `seg + 1` (-1 = before the first stop); next = seg + 1 (first upcoming stop)
// Only the anchor row is measured (kind 'anchor'); stops before it use the leg times backwards (or, with a consistent
// GPS placement, the remaining time scaled over the legs ahead of the bus), stops after it the legs forwards.
export function busTimeline(route, anchorStop, anchorEtaSec, fetchedAt, vehiclePos, now = Date.now()) {
  const stops = route && Array.isArray(route.stops) ? route.stops.map(String) : [];
  const n = stops.length;
  if (n < 1) return null;
  const leg = (i) => { const v = Number(route.legSec && route.legSec[i]); return Number.isFinite(v) && v > 0 ? v : 60; };
  const cum = (from, to) => { let s = 0; for (let i = from; i < to; i++) s += leg(i); return s; }; // typical bus seconds, stop `from` -> `to`

  const code = String(anchorStop);
  const cands = [];
  stops.forEach((c, i) => { if (c === code) cands.push(i); });
  if (!cands.length) return null;
  const hasPos = !!vehiclePos && Number.isFinite(vehiclePos.seg) && vehiclePos.seg >= 0;
  // a stop that appears twice (loop): the first occurrence ahead of the bus, else the last one
  const a = hasPos ? (cands.find((i) => i > vehiclePos.seg) ?? cands[cands.length - 1]) : cands[cands.length - 1];

  const etaIn = Number.isFinite(Number(anchorEtaSec)) ? Number(anchorEtaSec) : 0;
  const anchorAt = Math.max(now, fetchedAt + etaIn * 1000);
  const R = (anchorAt - now) / 1000; // seconds until the bus reaches the anchor

  let seg = -1;
  let t = 0;
  let usedPosition = false;
  let k = 1; // remaining-time scale over the legs between the bus and the anchor
  if (hasPos && vehiclePos.seg < a) {
    const tt = clamp(Number(vehiclePos.t) || 0, 0, 1);
    const T = (1 - tt) * leg(vehiclePos.seg) + cum(vehiclePos.seg + 1, a);
    // GPS says the bus is far behind while the ETA says it is about to arrive: the placement is wrong (loop / hairpin), ignore it
    if (!(T > 2.5 * R + 180) && T > 0) { seg = vehiclePos.seg; t = tt; usedPosition = true; k = clamp(R / T, 0.4, 3); }
  }
  if (!usedPosition) {
    for (let j = a - 1; j >= 0; j--) {
      if (anchorAt - cum(j, a) * 1000 <= now) {
        seg = j;
        const at0 = anchorAt - cum(j, a) * 1000, at1 = anchorAt - cum(j + 1, a) * 1000;
        t = at1 > at0 ? clamp((now - at0) / (at1 - at0), 0, 1) : 0;
        break;
      }
    }
  }

  const rows = [];
  for (let i = 0; i < n; i++) {
    let state = 'upcoming', kind = 'estimate', at = null;
    if (i <= seg) { state = 'passed'; kind = 'past'; }
    else if (i === a) { kind = 'anchor'; at = anchorAt; }
    else if (i < a) at = usedPosition ? Math.min(anchorAt, now + 1000 * k * ((1 - t) * leg(seg) + cum(seg + 1, i))) : anchorAt - cum(i, a) * 1000;
    else at = anchorAt + cum(a, i) * 1000;
    rows.push({ index: i, code: stops[i], state, kind, at, etaSec: at == null ? null : Math.max(0, Math.round((at - now) / 1000)) });
  }
  return {
    anchor: a, seg, t, usedPosition, rows, next: seg + 1, remainingSec: Math.round(R),
    endAt: rows[n - 1].at, lowConfidence: Number(route.confidence) < LOW_CONF,
  };
}

// "τώρα" / "σε 9′" / "σε 1 ώ 05′"
export const inText = (sec) => (sec < NOW_SEC ? 'τώρα' : `σε ${etaText(sec)}`);

// ---------------------------------------------------------------- view

let shapesP = null;
const shapes = () => (shapesP ||= loadShapes().catch(() => ({})));
const validShape = (c) => (Array.isArray(c) && c.length > 1 ? c : null);
const routeFc = (coordinates, routeCode) => ({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { routeCode }, geometry: { type: 'LineString', coordinates } }] });
const LIVE_FLAG = () => h('span', { class: 'ex-chip ex-chip-live' }, h('span', { class: 'ex-chip-dot', 'aria-hidden': 'true' }), 'LIVE');

const ERR_TEXT = {
  network: 'Δεν υπάρχει σύνδεση με το διαδίκτυο.',
  timeout: 'Η απάντηση άργησε πολύ.',
  upstream: 'Η υπηρεσία πληροφόρησης δεν ανταποκρίνεται αυτή τη στιγμή.',
  bad: 'Η απάντηση του διακομιστή δεν ήταν έγκυρη.',
};

export function mountBus(container, ctx, { vehicleCode, route: routeParam, stop: stopParam } = {}) {
  vehicleCode = String(vehicleCode ?? '');
  const data = ctx.data;
  let dead = false;
  let route = routeParam ? data.routeByCode.get(String(routeParam)) || null : null;
  let anchorCode = stopParam && data.stopByCode.has(String(stopParam)) ? String(stopParam) : null;
  const origin = anchorCode; // where "close" goes back to

  let found = null; // last sighting: { v, fetchedAt, stop, pos }
  let gone = false;
  let misses = 0; // consecutive "advance the anchor" steps without seeing the bus
  let st = { data: null, error: null, loading: true, nextAt: 0 };
  let lastFetched = 0;
  let poller = null;
  let rowEls = []; // { li, name, sub, clock, inn, tag, i }
  let passedOpen = false;
  let moreOpen = false;
  let pickerOpen = false;
  let fitted = false;
  let markersKey = '';
  let tl = null;
  let timer = null;

  const line = () => (route && data.lineByCode.get(route.lineCode)) || (found && data.lineByCode.get(found.v.lineCode)) || null;

  // Map calls go through one queue so they wait for map.ready and run in order, even after destroy.
  let mapQ = Promise.resolve(ctx.map && ctx.map.ready).catch(() => {});
  const onMap = (fn) => { mapQ = mapQ.then(() => { try { if (ctx.map) fn(ctx.map); } catch (e) { console.warn('map', e); } }); };

  // ---- skeleton ----
  const root = h('div', { class: 'ex-view bv' });
  const badgeBox = h('span', { class: 'bv-badge' });
  const title = h('h1', {}, 'Διαδρομή οχήματος');
  const sub = h('p', { class: 'ex-sub', hidden: true });
  const flagBox = h('span', { class: 'bv-flag' });
  const closeBtn = h('button', {
    type: 'button', class: 'ex-icon-btn', 'aria-label': 'Κλείσιμο', title: 'Κλείσιμο',
    onclick: () => ctx.navigate(origin ? `#/stop/${encodeURIComponent(origin)}` : '#/'),
  }, icon('close'));
  const moreBtn = h('button', {
    type: 'button', class: 'ex-icon-btn', 'aria-label': t('Περισσότερα'), title: t('Περισσότερα'), 'aria-expanded': 'false',
    onclick: () => { moreOpen = !moreOpen; moreBtn.setAttribute('aria-expanded', String(moreOpen)); more.hidden = !moreOpen; },
  }, '⋯');
  const head = h('header', { class: 'ex-head bv-head' }, badgeBox, h('div', { class: 'ex-grow' }, title, sub), flagBox, moreBtn, closeBtn);
  const banner = h('div', { class: 'bv-banner', role: 'status', hidden: true });
  const summary = h('div', { class: 'bv-summary', 'aria-live': 'polite', hidden: true });
  const caveat = h('p', { class: 'ex-note', role: 'note', hidden: true });
  const toggle = h('button', { type: 'button', class: 'ex-btn ex-btn-sm bv-toggle', 'aria-expanded': 'false', hidden: true, onclick: () => { passedOpen = !passedOpen; paint(Date.now()); } });
  const list = h('ol', { class: 'bv-list' });
  const foot = h('p', { class: 'ex-sub bv-foot' });
  const legend = h('p', { class: 'ex-sub bv-legend' });
  const alightBox = h('div', { class: 'ob-box', hidden: true });
  // secondary text lives behind the "⋯" button
  const more = h('div', { class: 'ob-more', hidden: true }, caveat, foot, legend,
    DEMO ? h('p', { class: 'ex-note' }, 'Δεδομένα προσομοίωσης (demo): δεν είναι πραγματικά λεωφορεία.') : null);
  root.append(head, banner, summary, alightBox, toggle, list, more);
  container.replaceChildren(root);

  // The bus sits between two rows: a pseudo-row the list moves around.
  const busName = h('span', { class: 'bv-bus-name' });
  const busRow = h('li', { class: 'bv-row bv-busrow', hidden: true },
    h('span', { class: 'bv-bus-ico', 'aria-hidden': 'true' }, icon('bus')), h('div', { class: 'bv-bus-text' }, busName));

  // ---- rows (rebuilt only when the route changes) ----
  function buildRows() {
    list.replaceChildren();
    rowEls = [];
    if (!route) return;
    const n = route.stops.length;
    route.stops.forEach((c, i) => {
      const s = data.stopByCode.get(c);
      const end = i === 0 ? 'Αφετηρία' : i === n - 1 ? 'Τέρμα' : '';
      const clock = h('span', { class: 'bv-clock' });
      const inn = h('span', { class: 'bv-in' });
      const tag = h('span', { class: 'bv-tag' });
      const name = h('span', { class: 'bv-name' }, s ? s.displayName : `Στάση ${c}`);
      const li = h('li', { class: `bv-row${end ? ' is-end' : ''}`, 'data-i': String(i) },
        h('span', { class: 'bv-dot', 'aria-hidden': 'true' }),
        h('a', { class: 'bv-link', href: `#/stop/${encodeURIComponent(c)}` }, name, h('span', { class: 'ex-sub' }, end ? `${end} · #${c}` : `#${c}`)),
        h('span', { class: 'bv-when' }, clock, inn, tag));
      rowEls.push({ li, clock, inn, tag, i });
      list.append(li);
    });
    list.append(busRow);
  }

  // ---- header + header-ish bits ----
  function paintHead() {
    const l = line();
    root.style.setProperty('--lc', (l && l.color) || (found && found.v.color) || 'var(--accent)');
    root.style.setProperty('--lc-text', (l && l.textColor) || '#fff');
    badgeBox.replaceChildren(lineBadge(l || { code: found ? found.v.lineCode : route ? route.lineCode : '' }));
    title.textContent = route ? route.displayName : found ? found.v.routeName : 'Διαδρομή οχήματος';
    sub.textContent = l ? `Γραμμή ${l.code} · διαδρομή οχήματος` : 'Διαδρομή οχήματος';
    document.title = `${title.textContent} · Λεωφορεία Πάτρας`;
    flagBox.replaceChildren();
    if (found && !gone) flagBox.append(found.v.live ? LIVE_FLAG() : h('span', { class: 'ex-chip ex-chip-sched' }, icon('clock'), 'ΠΡΟΓΡ.'));
    else if (gone) flagBox.append(h('span', { class: 'ex-chip ex-chip-sched' }, 'Εκτός live'));
  }

  const nameOf = (c) => (data.stopByCode.get(c) || {}).displayName || `Στάση ${c}`;

  // ---- one paint: cheap, called after every poll and every TICK_MS ----
  function paint(now) {
    if (dead) return;
    paintHead();
    const n = route ? route.stops.length : 0;

    // banner: errors, stale data, vanished vehicle
    const age = st.data ? (now - st.data.fetchedAt) / 1000 : 0;
    const stale = !!st.data && now - st.data.fetchedAt > STALE_MS;
    const msgs = [];
    if (!anchorCode) msgs.push('Άνοιξε το όχημα από μια στάση (ή από τον χάρτη) για να δεις τη ζωντανή του θέση.');
    else if (st.error && !st.data) msgs.push(`Δεν φορτώθηκαν τα δεδομένα. ${ERR_TEXT[st.error.kind] || ERR_TEXT.upstream}`);
    else if (gone) msgs.push('Το όχημα δεν εμφανίζεται πλέον στα live δεδομένα. Η διαδρομή παραμένει στον χάρτη.');
    else if (stale) msgs.push(`Παλιά δεδομένα: ενημερώθηκαν πριν ${ageText(age)}.${st.error ? ` ${ERR_TEXT[st.error.kind] || ''}` : ''}`);
    else if (found && !found.v.live) msgs.push('Δεν υπάρχει ζωντανή θέση για αυτό το δρομολόγιο: οι ώρες βασίζονται στο πρόγραμμα της στάσης και μπορεί να μην τηρηθούν.');
    banner.hidden = !msgs.length;
    banner.textContent = msgs.join(' ');
    banner.classList.toggle('is-bad', gone || !!(st.error && !st.data));

    // timeline
    let terminus = '';
    tl = null;
    if (route && found && !gone) {
      tl = busTimeline(route, found.stop, found.v.etaSec, found.fetchedAt, found.pos, now);
    }
    caveat.hidden = !(route && Number(route.confidence) < LOW_CONF);
    caveat.textContent = 'Η σειρά των στάσεων αυτής της διαδρομής συμπεραίνεται και ίσως έχει λάθη (κυκλική ή με φουρκέτες)· οι ώρες είναι ενδεικτικές.';

    if (!route) {
      list.replaceChildren(h('li', { class: 'ex-empty' }, 'Δεν υπάρχει γνωστή σειρά στάσεων για αυτή τη διαδρομή.'));
      summary.hidden = true; toggle.hidden = true;
    } else {
      const seg = tl ? tl.seg : -1;
      for (const r of rowEls) {
        const row = tl ? tl.rows[r.i] : null;
        const passed = !!row && row.state === 'passed';
        const isNext = !!row && row.index === tl.next && row.state === 'upcoming';
        const isAnchor = !!row && row.kind === 'anchor';
        r.li.className = `bv-row${r.i === 0 || r.i === n - 1 ? ' is-end' : ''}${r.i === 0 ? ' is-first' : ''}${r.i === n - 1 ? ' is-last' : ''}${passed ? ' is-passed' : ''}${isNext ? ' is-next' : ''}${isAnchor ? ' is-anchor' : ''}${!row ? ' is-plain' : ''}`;
        // old passed stops are folded away, the last one stays as context
        r.li.hidden = !!row && passed && r.i < seg && !passedOpen;
        r.li.removeAttribute('aria-current');
        if (!row) { r.clock.textContent = ''; r.inn.textContent = ''; r.tag.textContent = ''; continue; }
        if (passed) { r.clock.textContent = ''; r.inn.textContent = 'πέρασε'; r.tag.textContent = ''; continue; }
        const exact = row.kind === 'anchor';
        r.clock.textContent = `${exact ? '' : '≈ '}${fmtClock(row.at)}`;
        r.inn.textContent = inText(row.etaSec);
        r.tag.textContent = exact ? 'live' : ''; // the "≈" already says estimate; the rest is in "⋯"
        r.tag.className = `bv-tag${exact ? ' bv-tag-live' : ''}`;
        if (isNext) r.li.setAttribute('aria-current', 'step');
      }
      // bus pseudo-row between seg and seg + 1
      busRow.hidden = !tl;
      if (tl) {
        const before = rowEls[seg + 1] ? rowEls[seg + 1].li : busRow; // seg + 1 === n cannot happen (anchor is ahead)
        if (before !== busRow && busRow.nextSibling !== before) list.insertBefore(busRow, before);
        const prevName = seg >= 0 ? nameOf(route.stops[seg]) : null;
        const nextName = tl.next < n ? nameOf(route.stops[tl.next]) : null;
        busName.textContent = !found.v.live ? t('Χωρίς live θέση')
          : prevName && nextName ? t('Ανάμεσα σε «{a}» και «{b}»', { a: prevName, b: nextName })
            : nextName ? t('Στην αφετηρία «{a}»', { a: nextName }) : t('Στο τέρμα');
      }
      // toggle for the folded stops
      const folded = tl ? Math.max(0, seg) : 0; // stops 0 .. seg - 1
      toggle.hidden = folded < 1;
      toggle.setAttribute('aria-expanded', String(passedOpen));
      toggle.textContent = passedOpen ? t('Απόκρυψη προηγούμενων') : t('Προηγούμενες στάσεις ({n})', { n: folded });

      // summary
      if (tl) {
        const nx = tl.rows[tl.next];
        const last = tl.rows[n - 1];
        const parts = [];
        if (nx && tl.next < n) parts.push(h('div', { class: 'bv-sum-main' }, t('Επόμενη: '), h('b', {}, nameOf(nx.code)), ` · ${inText(nx.etaSec)}`));
        summary.replaceChildren(...parts);
        summary.hidden = !parts.length;
        terminus = last && last.state === 'upcoming' && last !== nx ? `Τέρμα «${nameOf(last.code)}»: ≈ ${fmtClock(last.at)} · ${inText(last.etaSec)} (εκτίμηση)` : '';
      } else { summary.hidden = true; terminus = ''; }
    }
    paintAlight();

    // footer + legend (behind "⋯")
    const bits = [];
    if (terminus) bits.push(terminus);
    if (st.data) bits.push(`ενημερώθηκε πριν ${ageText(age)}`);
    if (st.loading) bits.push('ανανέωση…');
    foot.textContent = bits.join(' · ');
    foot.hidden = !bits.length;
    legend.textContent = tl
      ? `Μόνο η ώρα στη στάση «${nameOf(found.stop)}» προέρχεται από live δεδομένα. Οι υπόλοιπες ώρες είναι εκτίμηση από τυπικούς χρόνους διαδρομής, όχι πρόγραμμα.`
      : 'Οι ώρες υπολογίζονται από live δεδομένα στάσης και τυπικούς χρόνους διαδρομής (εκτίμηση), όχι από πρόγραμμα.';
    pushMap();
  }

  // ---- "Θα κατέβω σε…": one button, a compact picker of the upcoming stops, then a one-line status with "Τέλος" ----
  let alightKey = '';
  function paintAlight() {
    const tr = activeTrip();
    const mine = !!tr && !!vehicleCode && tr.vehicleCode === vehicleCode;
    const can = !!route && !!tl && !gone && !!vehicleCode;
    alightBox.hidden = !(can || mine);
    if (alightBox.hidden) { alightKey = ''; return; }
    const key = `${mine ? tr.alightStop : ''}|${pickerOpen}|${tl ? tl.next : ''}|${route ? route.code : ''}`;
    if (key === alightKey) return;
    alightKey = key;
    if (mine) {
      pickerOpen = false;
      alightBox.replaceChildren(h('div', { class: 'ob-row' },
        h('span', { class: 'ob-on' }, icon('bell'), t('Κατεβαίνεις: «{name}»', { name: tr.stopName || nameOf(tr.alightStop) })),
        h('button', { type: 'button', class: 'ex-btn ex-btn-sm', onclick: () => stopOnboard() }, t('Τέλος'))));
      return;
    }
    const btn = h('button', { type: 'button', class: 'ex-btn ob-open', 'aria-expanded': String(pickerOpen), onclick: () => { pickerOpen = !pickerOpen; paint(Date.now()); } }, icon('bell'), t('Θα κατέβω σε…'));
    const kids = [btn];
    if (pickerOpen && tl) {
      const items = [];
      for (let i = Math.max(0, tl.next); i < route.stops.length; i++) {
        const row = tl.rows[i];
        items.push(h('li', {}, h('button', { type: 'button', class: 'ob-pick', onclick: () => pickStop(i) },
          h('span', { class: 'ob-pick-name' }, nameOf(route.stops[i])), h('span', { class: 'ob-pick-in' }, row ? inText(row.etaSec) : ''))));
      }
      kids.push(h('ul', { class: 'ob-picker', role: 'list' }, items));
    }
    alightBox.replaceChildren(...kids);
  }
  async function pickStop(i) {
    const code = route.stops[i];
    pickerOpen = false;
    const ok = await startOnboard({ vehicleCode, routeCode: route.code, lineCode: route.lineCode, alightStop: code, stopName: nameOf(code) });
    if (ok) toast(t('Θα σε ειδοποιήσω πριν τη «{name}»', { name: nameOf(code) }));
    if (!dead) paint(Date.now());
  }

  // ---- map ----
  function drawRoute() {
    if (!route) return;
    const pts = route.stops.map((c) => data.stopByCode.get(c)).filter(Boolean);
    const stopLine = pts.map((s) => [s.lng, s.lat]);
    const color = (line() || {}).color;
    onMap((m) => m.setOverlay('bus', routeFc(stopLine, route.code), { kind: 'route', color }));
    const code = route.code;
    shapes().then((sh) => {
      const coords = validShape(sh && sh[code]);
      if (dead || !coords || !route || route.code !== code) return;
      onMap((m) => m.setOverlay('bus', routeFc(coords, code), { kind: 'route', color: (line() || {}).color }));
    });
  }

  function pushMap() {
    const l = line();
    const showBus = !!found && !gone && found.v.live && Number.isFinite(found.v.lat);
    // `key` (not vehicleCode) so the marker glides between polls but is not clickable here
    onMap((m) => m.setVehicles('bus', showBus
      ? [{ key: 'bus', lat: found.v.lat, lng: found.v.lng, lineCode: found.v.lineCode, color: found.v.color || (l && l.color) || '#757575', textColor: found.v.textColor || (l && l.textColor) || '#fff' }]
      : []));
    if (!route || !tl) { if (markersKey) { markersKey = ''; onMap((m) => m.clearMarkers('bus-stops')); } return; }
    const key = `${route.code}|${tl.next}|${tl.anchor}`;
    if (key !== markersKey) {
      markersKey = key;
      const n = route.stops.length;
      const ms = [];
      for (let i = tl.next; i < n; i++) {
        const s = data.stopByCode.get(route.stops[i]);
        if (!s) continue;
        const last = i === n - 1;
        ms.push({ lat: s.lat, lng: s.lng, kind: last ? 'dest' : 'origin', label: last || i === tl.anchor ? s.displayName : undefined });
      }
      onMap((m) => m.setMarkers('bus-stops', ms));
    }
    if (!fitted) {
      fitted = true;
      const pts = route.stops.slice(Math.max(0, tl.next)).map((c) => data.stopByCode.get(c)).filter(Boolean).map((s) => ({ lat: s.lat, lng: s.lng }));
      if (showBus) pts.push({ lat: found.v.lat, lng: found.v.lng });
      if (pts.length) onMap((m) => m.fitTo(pts, { maxZoom: 16 }));
    }
  }

  // ---- data ----
  function startPoller(code) {
    if (poller) poller.destroy();
    anchorCode = code;
    lastFetched = 0;
    st = { data: null, error: null, loading: true, nextAt: 0 };
    poller = createLivePoller(code, (s) => {
      if (dead) return;
      st = s;
      if (s.data && s.data.fetchedAt !== lastFetched) { lastFetched = s.data.fetchedAt; handle(s.data); }
      paint(Date.now());
    });
    onMap((m) => m.highlightStop(code));
  }

  function handle(d) {
    const v = d.vehicles.find((x) => x.vehicleCode === vehicleCode);
    if (v) {
      misses = 0;
      gone = false;
      if (!route) {
        route = data.routeByCode.get(v.routeCode) || null;
        if (route) { buildRows(); drawRoute(); }
      }
      const pts = route ? route.stops.map((c) => data.stopByCode.get(c)).filter(Boolean) : null;
      found = { v, fetchedAt: d.fetchedAt, stop: anchorCode, pos: v.live && pts ? locateOnRoute(pts, v) : null };
      return;
    }
    // Not in this stop's list. If it was due here about now it has passed: follow it to the next stop on the route.
    if (found && route && misses < 3) {
      const due = found.fetchedAt + found.v.etaSec * 1000;
      const idx = route.stops.lastIndexOf(anchorCode);
      if (idx >= 0 && idx < route.stops.length - 1 && Date.now() >= due - 45000) {
        misses++;
        // keep the last sighting (now anchored at the old stop) until the next stop's data arrives
        startPoller(route.stops[idx + 1]);
        return;
      }
    }
    gone = true;
  }

  // ---- clock ----
  function onVisibility() {
    clearInterval(timer);
    timer = null;
    if (document.visibilityState !== 'visible') return;
    paint(Date.now());
    timer = setInterval(() => paint(Date.now()), TICK_MS);
  }
  document.addEventListener('visibilitychange', onVisibility);
  const offTrip = onTripChange(() => paint(Date.now()));

  // ---- go ----
  buildRows();
  paintHead();
  drawRoute();
  if (anchorCode) startPoller(anchorCode);
  onVisibility();
  try { ctx.sheet && ctx.sheet.snap('half'); } catch { /* ignore */ }

  return {
    destroy() {
      dead = true;
      offTrip();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      if (poller) poller.destroy();
      mapQ = mapQ.then(() => {
        try { if (ctx.map) { ctx.map.clearVehicles('bus'); ctx.map.clearOverlay('bus'); ctx.map.clearMarkers('bus-stops'); ctx.map.highlightStop(null); } } catch (e) { console.warn('map', e); }
      });
      root.remove();
    },
  };
}
