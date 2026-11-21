// Line browser (owner: extras): searchable list of lines (#/lines) and one line on the map with its
// ordered stops (#/line/{code}?dir=1&route=…). Styles in css/extras.css.
import { h, icon, lineBadge } from './ui.js';
import { searchKey, titleCase } from './text.js';
import { loadShapes } from './data.js';
import { createLivePoller } from './api.js';
import { arrivalTile } from './arrivals-view.js';
import { shareLink } from './share.js';
import { t, tn, onLangChange, lang, APP_NAME } from './i18n.js';
import { cityHash, shareHash } from './route.js';
import { city, cityName } from './cities.js';

let shapesP = null; // shapes.json is big and optional: load once, only when a line is opened
const shapes = () => (shapesP ||= loadShapes().catch(() => ({})));

const routeName = (ctx, r) => ctx.data.routeByCode.get(r.code)?.displayName || titleCase(r.name);
// "Updated just now" / "Updated 14″ ago".
const updated = (age) => (age < 5 ? t('Ενημερώθηκε μόλις τώρα') : t('Ενημερώθηκε πριν {t}', { t: age < 120 ? `${age}″` : `${Math.round(age / 60)}′` }));
// A round glass button of the card's header (the kit's .g-circle, UI-PROTOCOL U3).
const circle = (name, label, onclick) => h('button', { type: 'button', class: 'btn round g-circle', 'aria-label': label, title: label, onclick }, icon(name));

// The header's title at up (TEL-248, as js/report-view.js and js/bus-view.js): halfway from mid to up it moves to its own
// row, 24 px, in a short blur (U4, U10); towards up it grows as a transform (css/extras.css, by --u: U8). Nothing runs on
// every frame of a drag: sheet.js says when --sheet-t crosses 1.5 (sheet:upper). onDown: measure again at low/mid.
function titleUp(head, title, onDown = () => {}) {
  const sheetEl = document.getElementById('sheet');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const setUp = (on) => {
    if (head.classList.contains('is-up') === on) return;
    head.classList.toggle('is-up', on);
    if (!on) onDown();
    if (!reduceMotion.matches) title.animate([{ filter: 'blur(3px)' }, { filter: 'blur(0)' }], { duration: 180, easing: 'ease-out' });
  };
  const upRow = () => !!sheetEl && (sheetEl.dataset.state === 'full' || sheetEl.classList.contains('dragging'))
    && (parseFloat(sheetEl.style.getPropertyValue('--sheet-t')) || 0) > 1.5;
  const onUpper = () => setUp(upRow());
  const onLeaveUp = () => setUp(false);
  const mo = new MutationObserver(onUpper);
  if (sheetEl) {
    mo.observe(sheetEl, { attributes: true, attributeFilter: ['class', 'data-state'] });
    sheetEl.addEventListener('sheet:upper', onUpper);
    sheetEl.addEventListener('sheet:leave-full', onLeaveUp);
  }
  setUp(upRow());
  return () => { mo.disconnect(); sheetEl?.removeEventListener('sheet:upper', onUpper); sheetEl?.removeEventListener('sheet:leave-full', onLeaveUp); };
}

// The name as the vehicle's (js/bus-view.js, U4): one line at low and mid, 17 px, shrunk down to 14 px before it is cut
// with "…"; at up 24 px (less if its longest word would not fit), up to two lines. Measured only at low and mid, with
// transitions off (U16).
const NAME_PX = 17, NAME_MIN = 14, NAME_UP = 24;
let measureCtx = null;
function fitName(head, title) {
  if (!title.isConnected || head.classList.contains('is-up')) return;
  title.style.transition = 'none';
  for (const k of ['--name-px', '--name-n', '--name-up-n']) title.style.removeProperty(k);
  const room = title.clientWidth - 2; // 2 px to spare: a fraction of a pixel over would still draw the "…"
  if (room > 0) {
    const r = document.createRange();
    r.selectNodeContents(title);
    const scale = title.getBoundingClientRect().width / title.offsetWidth || 1; // the growth towards up, if any (U18)
    const w = r.getBoundingClientRect().width / scale;
    let n = NAME_PX;
    if (w > room) {
      n = Math.max(NAME_MIN, Math.floor(NAME_PX * room / w));
      title.style.setProperty('--name-px', `${n}px`);
      title.style.setProperty('--name-n', String(n));
    }
    measureCtx ||= document.createElement('canvas').getContext('2d');
    const cs = getComputedStyle(title);
    measureCtx.font = `${cs.fontWeight} ${NAME_PX}px ${cs.fontFamily}`;
    const longest = Math.max(...title.textContent.split(/\s+/).map((wd) => measureCtx.measureText(wd).width));
    const upN = Math.max(n, Math.min(NAME_UP, Math.floor(NAME_PX * (head.clientWidth - 2) / (longest * 1.04 || 1)))); // 4%: rounding
    if (upN !== NAME_UP) title.style.setProperty('--name-up-n', String(upN));
  }
  title.style.transition = '';
}

// A short fixed title (lines list, «line not found»): an empty slot · the title, 17 px, centred · ✕, as the report's.
function plainHead(titleText, closeLabel, onClose) {
  const title = h('h1', { class: 'lh-title card-title' }, titleText);
  // low ends under this row (js/sheet.js)
  const head = h('header', { class: 'lh-head card-head', 'data-peek-end': '' }, h('span', { 'aria-hidden': 'true' }), title, circle('close', closeLabel, onClose));
  return { head, title };
}

// ---------------------------------------------------------------- list of lines

// Both views re-render when the language changes (names stay as they are).
export function mountLines(container, ctx) {
  const st = { q: '' };
  let v = buildLines(container, ctx, st);
  let gone = false;
  const off = onLangChange(() => { if (gone) return; v.destroy(); v = buildLines(container, ctx, st); });
  return { destroy() { gone = true; off(); v.destroy(); } };
}

function buildLines(container, ctx, st) {
  const rows = ctx.data.lines.map((line) => ({
    line,
    key: searchKey([line.code, line.name, ...line.routes.map((r) => r.name)].join(' ')),
  }));

  const input = h('input', {
    class: 'ex-search', type: 'search', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'search',
    placeholder: t('Αναζήτηση γραμμής ή προορισμού'), 'aria-label': t('Αναζήτηση γραμμής ή προορισμού'),
  });
  input.value = st.q;
  const count = h('p', { class: 'ex-sub', 'aria-live': 'polite' });
  const list = h('ul', { class: 'lines-list' });

  function render() {
    const terms = searchKey(input.value).split(' ').filter(Boolean);
    const hits = rows.filter((r) => terms.every((w) => r.key.includes(w)));
    if (terms.length) hits.sort((a, b) => Number(b.line.code.startsWith(terms[0])) - Number(a.line.code.startsWith(terms[0])));
    count.textContent = hits.length ? tn(hits.length, '{n} γραμμή', '{n} γραμμές') : t('Καμία γραμμή δεν ταιριάζει');
    list.replaceChildren(...hits.map(({ line }) => h('li', {},
      h('a', { class: 'lines-row press', href: cityHash(`#/line/${encodeURIComponent(line.code)}`) },
        h('span', { class: 'lines-badge' }, lineBadge(line)),
        h('span', { class: 'lines-main' }, h('span', { class: 'lines-name' }, line.displayName)),
        icon('chevron')))));
  }
  const onInput = () => { st.q = input.value; render(); };
  input.addEventListener('input', onInput);

  const { head, title } = plainHead(t('Γραμμές'), t('Κλείσιμο'), () => ctx.navigate('#/'));
  container.replaceChildren(h('div', { class: 'ex-view sheet-inset' }, head, input, count, list));
  const offUp = titleUp(head, title);
  render();
  return { destroy() { offUp(); input.removeEventListener('input', onInput); } };
}

// ---------------------------------------------------------------- one line

function pickRoute(line, { route, dir } = {}) {
  const rs = line.routes;
  return (route != null && rs.find((r) => r.code === String(route)))?.code
    || (dir != null && rs.find((r) => String(r.direction) === String(dir)))?.code
    || rs[0]?.code || null;
}

// Ordered stops from routes.json; otherwise every stop that lists the route (unordered, alphabetical).
function stopsFor(ctx, routeCode) {
  const route = routeCode && ctx.data.routeByCode.get(routeCode);
  if (route?.stops?.length) {
    const stops = route.stops.map((c) => ctx.data.stopByCode.get(c)).filter(Boolean);
    if (stops.length) return { ordered: true, stops };
  }
  const stops = routeCode ? ctx.data.stops.filter((s) => s.routeCodes.includes(routeCode)) : [];
  stops.sort((a, b) => a.displayName.localeCompare(b.displayName, 'el'));
  return { ordered: false, stops };
}

// Estimated end-to-end bus time of an ordered route, in whole minutes (null if unknown): the sum of the typical leg times.
export function routeDurationMin(route) {
  if (!route || !Array.isArray(route.legSec) || !route.legSec.length) return null;
  const s = route.legSec.reduce((a, b) => a + (Number(b) > 0 ? Number(b) : 0), 0);
  return s > 0 ? Math.max(1, Math.round(s / 60)) : null;
}

const validShape = (c) => (Array.isArray(c) && c.length > 1 ? c : null);
const routeFc = (coordinates, routeCode) => ({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { routeCode }, geometry: { type: 'LineString', coordinates } }] });

export function mountLine(container, ctx, params = {}) {
  let v = buildLine(container, ctx, params);
  let gone = false;
  const off = onLangChange(() => { if (gone) return; v.destroy(); v = buildLine(container, ctx, params); });
  return { destroy() { gone = true; off(); v.destroy(); } };
}

function buildLine(container, ctx, params) {
  const { map } = ctx;
  const line = ctx.data.lineByCode.get(String(params.code));
  if (!line) {
    const { head, title } = plainHead(t('Γραμμή'), t('Πίσω στις γραμμές'), () => ctx.navigate('#/lines'));
    container.replaceChildren(h('div', { class: 'ex-view sheet-inset' }, head,
      h('p', { class: 'ex-empty' }, t('Η γραμμή δεν βρέθηκε.')),
      h('a', { class: 'btn rect', href: cityHash('#/lines') }, t('Όλες οι γραμμές'))));
    return { destroy: titleUp(head, title) };
  }

  let dead = false;
  let drawToken = 0;
  let routeCode = pickRoute(line, params);
  let current = stopsFor(ctx, routeCode);

  const root = h('div', { class: 'ex-view lines-line sheet-inset' });
  root.style.setProperty('--lc', line.color || 'var(--primary)');
  root.style.setProperty('--lc-text', line.textColor || '#fff');
  // directions (TEL-248, UI-PROTOCOL U25): one pick-one row, the chosen chip under the glass lens (js/glass.js:
  // bar[data-lens] > row > chip, aria-pressed); a long name scrolls inside the capsule, as the stop's chips
  const chips = h('div', { class: 'lines-routes', role: 'group', 'aria-label': t('Διαδρομές της γραμμής') });
  const chipBar = h('div', { class: 'lines-routebar', 'data-lens': true }, chips);
  const sub = h('p', { class: 'ex-sub' });
  const note = h('p', { class: 'ex-note', role: 'note' });
  const list = h('ol', { class: 'lines-stops' });
  const status = h('p', { class: 'ex-sub', 'aria-live': 'polite' });

  // "Πρόγραμμα": live/scheduled departures from the first stop of the route + estimated end-to-end time. NOT a timetable.
  const timesId = `lt${Math.random().toString(36).slice(2, 7)}`;
  const timesStop = h('p', { class: 'ex-sub' });
  const timesList = h('ul', { class: 'lines-deps tabular' });
  const timesMsg = h('p', { class: 'ex-sub', 'aria-live': 'polite' });
  const timesHint = h('p', { class: 'ex-sub lines-times-note', hidden: true }, t('Πλήρες ημερήσιο πρόγραμμα: όχι ακόμη διαθέσιμο — χρειάζεται τα επίσημα δεδομένα δρομολογίων.'));
  // the stop's arrival tiles under a plain heading, no box of its own (TEL-248)
  const times = h('section', { class: 'lines-times', 'aria-labelledby': timesId },
    h('h2', { id: timesId, class: 'lines-times-title' }, icon('clock'), h('span', { class: 'ex-grow' }, t('Αναχωρήσεις από την αφετηρία')),
      h('button', { type: 'button', class: 'ex-info press', 'aria-label': t('Περισσότερα'), 'aria-expanded': 'false', onclick: (e) => {
        const on = timesHint.hidden; timesHint.hidden = !on; e.currentTarget.setAttribute('aria-expanded', String(on));
      } }, icon('info'))),
    timesHint, timesStop, timesList, timesMsg);
  let term = null; // { code, poller, ticker, state, tiles } — the terminal stop's poller (one at a time)

  const share = circle('share', t('Κοινοποίηση γραμμής'), async () => {
    const r = await shareLink({ title: t('Γραμμή {code} · {name}', { code: line.code, name: line.displayName }), text: t('Γραμμή {code} {name} — {app} · {city}', { code: line.code, name: line.displayName, app: APP_NAME, city: cityName(city(), lang()) }), url: `${location.origin}${location.pathname}${shareHash(location.hash)}` });
    if (r === 'copied') ctx.toast(t('Ο σύνδεσμος αντιγράφηκε'));
    else if (r === 'failed') ctx.toast(t('Δεν ήταν δυνατή η κοινοποίηση'));
  });

  // header (TEL-248, the vehicle's: UI-PROTOCOL U2–U5, css/extras.css .bv-head): share · the line's name, its badge
  // under it · ✕ back to the lines. The kit's .card-head and .g-circle (css/ui-kit.css).
  const title = h('h1', { class: 'bv-title card-title', title: line.displayName }, line.displayName);
  const head = h('header', { class: 'bv-head' },
    h('div', { class: 'bv-top card-head' },
      share,
      h('div', { class: 'bv-titles' }, title, h('div', { class: 'bv-peek' }, lineBadge(line)),
        h('span', { class: 'bv-peek-end', 'aria-hidden': 'true', 'data-peek-end': '' })), // low ends under it (js/sheet.js)
      circle('close', t('Πίσω στις γραμμές'), () => ctx.navigate('#/lines'))));
  root.append(head, sub, chipBar, note, status, times, list);
  container.replaceChildren(root);
  const fit = () => { if (!dead) fitName(head, title); };
  const offUp = titleUp(head, title, fit);
  document.fonts?.ready.then(fit);
  document.fonts?.addEventListener('loadingdone', fit);

  // --- route chips ---
  function paintChips() {
    chipBar.hidden = line.routes.length < 2;
    chips.replaceChildren(...line.routes.map((r) => {
      const name = routeName(ctx, r);
      return h('button', { type: 'button', class: 'lines-chip press', 'aria-pressed': String(r.code === routeCode), title: name, onclick: () => setRoute(r.code) }, name);
    }));
    const on = chips.querySelector('[aria-pressed="true"]'); // bring the active chip into view (horizontal only)
    if (on) chips.scrollLeft = Math.max(0, on.offsetLeft - (chips.clientWidth - on.offsetWidth) / 2);
  }
  function setRoute(code) {
    if (code === routeCode) return;
    routeCode = code;
    current = stopsFor(ctx, routeCode);
    const r = line.routes.find((x) => x.code === code);
    try { history.replaceState(history.state, '', cityHash(`#/line/${encodeURIComponent(line.code)}?dir=${r?.direction ?? ''}&route=${encodeURIComponent(code)}`)); } catch { /* ignore */ }
    paint();
    draw();
    startTimes();
  }

  // --- departures from the terminal (first stop): poller 20 s, visible only; at most one stop polled for this block ---
  function stopTimes() {
    if (!term) return;
    const cur = term; term = null;
    cur.poller.destroy(); clearInterval(cur.ticker);
  }
  function paintTimes() {
    const mins = routeDurationMin(routeCode && ctx.data.routeByCode.get(routeCode));
    if (!term) {
      timesStop.textContent = '';
      timesList.replaceChildren();
      timesMsg.textContent = t('Δεν υπάρχει γνωστή αφετηρία για αυτή τη διαδρομή.');
      return;
    }
    const first = ctx.data.stopByCode.get(term.code);
    timesStop.replaceChildren(`${t('Αφετηρία')}: `, h('a', { href: cityHash(`#/stop/${encodeURIComponent(term.code)}`) }, first ? first.displayName : term.code), mins ? ` · ~${mins}′` : '');
    const s = term.state;
    const now = Date.now();
    term.tiles = [];
    if (!s || (s.loading && !s.data)) { timesList.replaceChildren(); timesMsg.textContent = t('Φόρτωση…'); return; }
    if (s.error && !s.data) { timesList.replaceChildren(); timesMsg.textContent = t('Δεν φορτώθηκαν οι αναχωρήσεις.'); return; }
    const mine = s.data.vehicles.filter((v) => v.routeCode === routeCode && v.etaSec - (now - s.data.fetchedAt) / 1000 > -30)
      .sort((a, b) => a.etaSec - b.etaSec).slice(0, 3);
    timesList.replaceChildren(...mine.map((v) => {
      const tile = arrivalTile(v, s.data.fetchedAt, { compact: true, now, line, stop: term.code, lineLinks: false });
      term.tiles.push(tile);
      return h('li', {}, tile);
    }));
    const age = Math.max(0, Math.round((now - s.data.fetchedAt) / 1000));
    timesMsg.textContent = [mine.length ? '' : t('Καμία προσεχής αναχώρηση αυτής της διαδρομής'), updated(age), s.error ? t('αποτυχία ανανέωσης') : ''].filter(Boolean).join(' · ');
  }
  function startTimes() {
    stopTimes();
    const code = current.ordered ? current.stops[0]?.code : null;
    if (code) {
      const cur = { code, state: null, poller: null, ticker: null, tiles: [] };
      term = cur;
      cur.poller = createLivePoller(code, (s) => { if (term !== cur) return; cur.state = s; paintTimes(); });
      cur.ticker = setInterval(() => { if (!document.hidden && term === cur) for (const x of cur.tiles) x.tick(); }, 1000);
    }
    paintTimes();
  }

  // --- stop list ---
  function paintStops() {
    const { stops, ordered } = current;
    list.classList.toggle('is-unordered', !ordered);
    note.hidden = ordered || !stops.length;
    note.textContent = t('Οι στάσεις είναι αλφαβητικά (άγνωστη σειρά).');
    status.textContent = stops.length ? tn(stops.length, '{n} στάση', '{n} στάσεις') : '';
    if (!stops.length) { list.replaceChildren(h('li', { class: 'ex-empty' }, t('Δεν βρέθηκαν στάσεις για αυτή τη διαδρομή.'))); return; }
    list.replaceChildren(...stops.map((s, i) => {
      const end = ordered && (i === 0 ? t('Αφετηρία') : i === stops.length - 1 ? t('Τέρμα') : '');
      // a stop opens its card, with its arrivals (TEL-248: no "next buses" button of its own any more)
      return h('li', { class: `lines-stop${end ? ' is-end' : ''}`, 'data-code': s.code },
        h('span', { class: 'lines-dot', 'aria-hidden': 'true' }),
        h('div', { class: 'lines-stop-row' },
          h('a', { class: 'lines-stop-link press', href: cityHash(`#/stop/${encodeURIComponent(s.code)}`) },
            h('span', { class: 'lines-stop-name' }, s.displayName),
            end ? h('span', { class: 'ex-sub' }, end) : null)));
    }));
  }
  function paint() {
    const r = line.routes.find((x) => x.code === routeCode);
    sub.textContent = r ? routeName(ctx, r) : t('Δεν υπάρχουν διαδρομές');
    paintChips();
    sub.hidden = line.routes.length > 1; // the chips already name the route
    paintStops();
  }

  // --- map ---
  async function draw() {
    const token = ++drawToken;
    const { stops, ordered } = current;
    try { await map.ready; } catch { return; }
    if (dead || token !== drawToken) return;
    try {
      map.clearOverlay('line');
      map.setMarkers('line-stops', stops.map((s, i) => {
        const end = ordered && (i === 0 || i === stops.length - 1);
        return { lat: s.lat, lng: s.lng, kind: end ? (i === 0 ? 'origin' : 'dest') : 'pin', label: end ? s.displayName : undefined };
      }));
      if (stops.length) map.fitTo(stops.map((s) => ({ lat: s.lat, lng: s.lng })), { maxZoom: 16 });
    } catch { /* map unavailable: the list still works */ }
    const sh = await shapes();
    if (dead || token !== drawToken) return;
    const coords = validShape(sh?.[routeCode]) || (ordered && stops.length > 1 ? stops.map((s) => [s.lng, s.lat]) : null);
    try { if (coords) map.setOverlay('line', routeFc(coords, routeCode), { kind: 'route', color: line.color }); } catch { /* ignore */ }
  }

  paint();
  draw();
  startTimes();
  try { ctx.sheet?.snap('half'); } catch { /* ignore */ }

  return {
    destroy() {
      dead = true; drawToken++;
      offUp(); document.fonts?.removeEventListener('loadingdone', fit);
      stopTimes();
      try { map.clearOverlay('line'); map.clearMarkers('line-stops'); } catch { /* ignore */ }
    },
  };
}
