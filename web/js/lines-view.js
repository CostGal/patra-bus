// Line browser (owner: extras): searchable list of lines (#/lines) and one line on the map with its
// ordered stops (#/line/{code}?dir=1&route=…). Styles in css/extras.css.
import { h, icon, lineBadge } from './ui.js';
import { searchKey, titleCase } from './text.js';
import { loadShapes } from './data.js';
import { createLivePoller, remainingSec } from './api.js';
import { arrivalTile } from './arrivals-view.js';
import { shareLink } from './share.js';

let shapesP = null; // shapes.json is big and optional: load once, only when a line is opened
const shapes = () => (shapesP ||= loadShapes().catch(() => ({})));

const routeName = (ctx, r) => ctx.data.routeByCode.get(r.code)?.displayName || titleCase(r.name);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const backBtn = (label, onclick) => h('button', { type: 'button', class: 'ex-icon-btn', 'aria-label': label, onclick }, icon('back'));

// ---------------------------------------------------------------- list of lines

export function mountLines(container, ctx) {
  const rows = ctx.data.lines.map((line) => ({
    line,
    key: searchKey([line.code, line.name, ...line.routes.map((r) => r.name)].join(' ')),
  }));

  const input = h('input', {
    class: 'ex-search', type: 'search', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'search',
    placeholder: 'Αναζήτηση γραμμής ή προορισμού', 'aria-label': 'Αναζήτηση γραμμής ή προορισμού',
  });
  const count = h('p', { class: 'ex-sub', 'aria-live': 'polite' });
  const list = h('ul', { class: 'lines-list' });

  function summary(line) {
    const names = [...new Set(line.routes.map((r) => routeName(ctx, r)))];
    if (!names.length) return '';
    return names.slice(0, 2).join(' · ') + (names.length > 2 ? ` · +${names.length - 2}` : '');
  }
  function render() {
    const terms = searchKey(input.value).split(' ').filter(Boolean);
    const hits = rows.filter((r) => terms.every((t) => r.key.includes(t)));
    if (terms.length) hits.sort((a, b) => Number(b.line.code.startsWith(terms[0])) - Number(a.line.code.startsWith(terms[0])));
    count.textContent = hits.length ? plural(hits.length, 'γραμμή', 'γραμμές') : 'Καμία γραμμή δεν ταιριάζει';
    list.replaceChildren(...hits.map(({ line }) => h('li', {},
      h('a', { class: 'lines-row', href: `#/line/${encodeURIComponent(line.code)}` },
        h('span', { class: 'lines-badge' }, lineBadge(line)),
        h('span', { class: 'lines-main' },
          h('span', { class: 'lines-name' }, line.displayName),
          h('span', { class: 'ex-sub' }, summary(line))),
        icon('chevron')))));
  }
  input.addEventListener('input', render);

  container.replaceChildren(h('div', { class: 'ex-view' },
    h('header', { class: 'ex-head' }, backBtn('Πίσω', () => ctx.navigate('#/')), h('h1', {}, 'Γραμμές')),
    input, count, list));
  render();
  return { destroy() { input.removeEventListener('input', render); } };
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

const validShape = (c) => (Array.isArray(c) && c.length > 1 ? c : null);
const routeFc = (coordinates, routeCode) => ({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { routeCode }, geometry: { type: 'LineString', coordinates } }] });

export function mountLine(container, ctx, params = {}) {
  const { map } = ctx;
  const line = ctx.data.lineByCode.get(String(params.code));
  if (!line) {
    container.replaceChildren(h('div', { class: 'ex-view' },
      h('header', { class: 'ex-head' }, backBtn('Πίσω στις γραμμές', () => ctx.navigate('#/lines')), h('h1', {}, 'Γραμμή')),
      h('p', { class: 'ex-empty' }, 'Η γραμμή δεν βρέθηκε.'),
      h('a', { class: 'ex-btn', href: '#/lines' }, 'Όλες οι γραμμές')));
    return { destroy() {} };
  }

  let dead = false;
  let drawToken = 0;
  let routeCode = pickRoute(line, params);
  let current = stopsFor(ctx, routeCode);
  let open = null; // { code, poller, state, ticker, panel, btn } — one expanded stop at a time (one poller)

  const root = h('div', { class: 'ex-view lines-line' });
  root.style.setProperty('--lc', line.color || 'var(--accent)');
  root.style.setProperty('--lc-text', line.textColor || '#fff');
  const chips = h('div', { class: 'lines-routes', role: 'group', 'aria-label': 'Διαδρομές της γραμμής' });
  const sub = h('p', { class: 'ex-sub' });
  const note = h('p', { class: 'ex-note', role: 'note' });
  const list = h('ol', { class: 'lines-stops' });
  const status = h('p', { class: 'ex-sub', 'aria-live': 'polite' });

  const share = h('button', { type: 'button', class: 'ex-icon-btn', 'aria-label': 'Κοινοποίηση γραμμής', onclick: async () => {
    const r = await shareLink({ title: `Γραμμή ${line.code} · ${line.displayName}`, text: `Γραμμή ${line.code} ${line.displayName} — Λεωφορεία Πάτρας`, url: `${location.origin}${location.pathname}${location.hash}` });
    if (r === 'copied') ctx.toast('Ο σύνδεσμος αντιγράφηκε');
    else if (r === 'failed') ctx.toast('Δεν ήταν δυνατή η κοινοποίηση');
  } }, icon('share'));

  root.append(
    h('header', { class: 'ex-head' },
      backBtn('Πίσω στις γραμμές', () => ctx.navigate('#/lines')),
      h('span', { class: 'lines-badge lines-badge-lg' }, lineBadge(line)),
      h('div', { class: 'ex-grow' }, h('h1', {}, line.displayName), sub),
      share),
    chips, note, status, list);
  container.replaceChildren(root);

  // --- route chips ---
  function paintChips() {
    chips.hidden = line.routes.length < 2;
    chips.replaceChildren(...line.routes.map((r) => {
      const name = routeName(ctx, r);
      return h('button', { type: 'button', class: 'lines-chip', 'aria-pressed': String(r.code === routeCode), title: name, onclick: () => setRoute(r.code) }, name);
    }));
    const on = chips.querySelector('[aria-pressed="true"]'); // bring the active chip into view (horizontal only)
    if (on) chips.scrollLeft = Math.max(0, on.offsetLeft - (chips.clientWidth - on.offsetWidth) / 2);
  }
  function setRoute(code) {
    if (code === routeCode) return;
    closeNext();
    routeCode = code;
    current = stopsFor(ctx, routeCode);
    const r = line.routes.find((x) => x.code === code);
    try { history.replaceState(history.state, '', `#/line/${encodeURIComponent(line.code)}?dir=${r?.direction ?? ''}&route=${encodeURIComponent(code)}`); } catch { /* ignore */ }
    paint();
    draw();
  }

  // --- stop list ---
  function paintStops() {
    const { stops, ordered } = current;
    list.classList.toggle('is-unordered', !ordered);
    note.hidden = ordered || !stops.length;
    note.textContent = 'Δεν υπάρχει γνωστή σειρά στάσεων για αυτή τη διαδρομή· οι στάσεις εμφανίζονται αλφαβητικά.';
    status.textContent = stops.length ? plural(stops.length, 'στάση', 'στάσεις') : '';
    if (!stops.length) { list.replaceChildren(h('li', { class: 'ex-empty' }, 'Δεν βρέθηκαν στάσεις για αυτή τη διαδρομή.')); return; }
    list.replaceChildren(...stops.map((s, i) => {
      const term = ordered && (i === 0 ? 'Αφετηρία' : i === stops.length - 1 ? 'Τέρμα' : '');
      const panel = h('div', { class: 'lines-next', hidden: true });
      const btn = h('button', { type: 'button', class: 'lines-next-btn', 'aria-expanded': 'false', 'aria-label': `Επόμενα λεωφορεία στη στάση ${s.displayName}`, onclick: () => toggleNext(s, btn, panel) },
        icon('clock'), 'Επόμενα');
      return h('li', { class: `lines-stop${term ? ' is-end' : ''}`, 'data-code': s.code },
        h('span', { class: 'lines-dot', 'aria-hidden': 'true' }),
        h('div', { class: 'lines-stop-row' },
          h('a', { class: 'lines-stop-link', href: `#/stop/${encodeURIComponent(s.code)}` },
            h('span', { class: 'lines-stop-name' }, s.displayName),
            h('span', { class: 'ex-sub' }, term ? `${term} · #${s.code}` : `#${s.code}`)),
          btn),
        panel);
    }));
  }
  function paint() {
    const r = line.routes.find((x) => x.code === routeCode);
    sub.textContent = r ? routeName(ctx, r) : 'Δεν υπάρχουν διαδρομές';
    paintChips();
    paintStops();
  }

  // --- "next bus" for ONE expanded stop (live poller, 20 s, visible only) ---
  function paintNext() {
    if (!open) return;
    const { state, panel } = open;
    const nodes = [];
    if (!state || state.loading && !state.data) nodes.push(h('p', { class: 'ex-sub' }, 'Φόρτωση…'));
    else if (state.error && !state.data) nodes.push(h('p', { class: 'ex-sub' }, 'Δεν φορτώθηκαν οι αφίξεις.'),
      h('button', { type: 'button', class: 'ex-btn ex-btn-sm', onclick: () => open?.poller.refresh() }, 'Δοκίμασε ξανά'));
    else if (state.data) {
      const now = Date.now();
      const mine = state.data.vehicles.filter((v) => v.lineCode === line.code)
        .sort((a, b) => remainingSec(a, state.data.fetchedAt, now) - remainingSec(b, state.data.fetchedAt, now)).slice(0, 3);
      if (!mine.length) nodes.push(h('p', { class: 'ex-sub' }, `Καμία άφιξη της γραμμής ${line.code} αυτή τη στιγμή.`));
      for (const v of mine) {
        try { nodes.push(arrivalTile(v, state.data.fetchedAt, { compact: true, now, line })); } catch { /* tile failed: skip */ }
      }
      const age = Math.max(0, Math.round((now - state.data.fetchedAt) / 1000));
      nodes.push(h('p', { class: 'ex-sub lines-age' }, age < 5 ? 'Ενημερώθηκε μόλις τώρα' : `Ενημερώθηκε πριν ${age < 120 ? `${age}″` : `${Math.round(age / 60)}′`}`,
        state.error ? ' · αποτυχία ανανέωσης' : ''));
    }
    panel.replaceChildren(...nodes);
  }
  function showLiveOnMap(data) {
    const vs = (data?.vehicles || []).filter((v) => v.lineCode === line.code && v.live && Number.isFinite(v.lat) && Number.isFinite(v.lng));
    try { map.setVehicles('line-live', vs.map((v) => ({ lat: v.lat, lng: v.lng, lineCode: v.lineCode, color: v.color || line.color, textColor: v.textColor || line.textColor, label: v.vehicleCode || undefined }))); } catch { /* ignore */ }
  }
  function closeNext() {
    if (!open) return;
    const o = open; open = null;
    o.poller.destroy(); clearInterval(o.ticker);
    o.panel.hidden = true; o.panel.replaceChildren();
    o.btn.setAttribute('aria-expanded', 'false');
    try { map.clearVehicles('line-live'); map.highlightStop(null); } catch { /* ignore */ }
  }
  function toggleNext(stop, btn, panel) {
    const same = open?.code === stop.code;
    closeNext();
    if (same) return;
    panel.hidden = false; btn.setAttribute('aria-expanded', 'true');
    const o = { code: stop.code, panel, btn, state: null, poller: null, ticker: null };
    open = o;
    o.poller = createLivePoller(stop.code, (s) => { if (open !== o) return; o.state = s; showLiveOnMap(s.data); paintNext(); });
    o.ticker = setInterval(() => { if (!document.hidden) paintNext(); }, 1000);
    paintNext();
    try { map.highlightStop(stop.code); } catch { /* ignore */ }
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
  try { ctx.sheet?.snap('half'); } catch { /* ignore */ }

  return {
    destroy() {
      dead = true; drawToken++;
      closeNext();
      try { map.clearOverlay('line'); map.clearMarkers('line-stops'); map.clearVehicles('line-live'); map.highlightStop(null); } catch { /* ignore */ }
    },
  };
}
