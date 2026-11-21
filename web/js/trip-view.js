// Trip sheet (TEL-293): when to leave, the options, and the steps in order, for the itineraries of js/trip.js
// (shape on card TEL-290). Styles: css/trip.css (prefix .tripv-). The stop card (js/arrivals-view.js) is the model.
// It finds no trips itself and sends nothing: the wiring card hands in plan(), which calls trip.planTrips().
// A bus says where its time comes from: LIVE, ΠΡΟΓΡ. (timetable) or ΕΚΤΙΜ. (we computed it). Every time in the model
// carries its source; on screen only the option chips mark an estimate (grey, orange (*)); tiles and steps show plain
// numbers, as Google Maps does (TEL-294, Kostas). No ~ anywhere.
// Imports: ui, i18n, geo, arrivals-view (arrivalTile) and trip (retime, leaveState) only (guard: tests/trip-view.test.mjs).
import { h, icon, lineBadge, fmtClock } from './ui.js';
import { t, tn, etaTxt } from './i18n.js';
import { fmtDist } from './geo.js';
import { arrivalTile } from './arrivals-view.js';
import { retime, leaveState } from './trip.js';
import { drawTrip, clearTrip } from './trip-map.js';

const MAX_OPTS = 3; // option chips
const PLAN_MS = 20000; // plan() again every 20 s while the page is visible, never faster (CLAUDE.md: live ≥ 15 s)
const MIN_LAST_WALK_M = 25; // a last walk shorter than this is not a step

// ---------------------------------------------------------------- the model (no page elements: unit-tested)

const EST = new Set(['estimated', 'estimate']); // times use 'estimated'; walk legs and rideSource use 'estimate'
const srcOf = (s) => (EST.has(s) ? 'estimated' : s || null);

// Minutes rounded up: "7′"; from 60 minutes on "1 ώ 05′".
export function dur(sec) {
  const m = Math.max(0, Math.ceil((Number(sec) || 0) / 60));
  if (m < 60) return `${m}′`;
  return `${Math.floor(m / 60)} ${t('ώ')} ${String(m % 60).padStart(2, '0')}′`;
}
const timeOf = (ms, source) => (ms == null ? null : { text: fmtClock(ms), source: srcOf(source) });
const durOf = (sec, source) => (sec == null ? null : { text: dur(sec), source: srcOf(source) });
// The chip: in how many minutes you arrive, from `now` (the view ticks it every second).
export const etaOf = (it, now = Date.now()) => (it?.arriveAt == null ? null : durOf(Math.max(0, (it.arriveAt - now) / 1000), it.arriveSource));

const busLegs = (it) => it.legs.filter((l) => l.kind === 'bus');
const walkSec = (it) => it.legs.reduce((s, l) => s + (l.kind === 'walk' ? l.seconds || 0 : 0), 0);
const anyEst = (legs) => (legs.some((l) => EST.has(l.source)) ? 'estimated' : 'osrm');

// The option's total: arrival − leave (a walk: the walk itself). Its source is the arrival's.
function totalOf(it) {
  if (it.kind === 'walk') return durOf(walkSec(it), anyEst(it.legs));
  if (it.arriveAt == null || it.leaveAt == null) return null;
  return durOf((it.arriveAt - it.leaveAt) / 1000, it.arriveSource);
}

// The leave line, the card's title. Never with ~: a countdown only for 'later', which trip.js gives only from a live
// or scheduled bus.
function titleOf(it, now) {
  const s = leaveState(it, now);
  if (s.kind === 'later') return { kind: s.kind, text: t('Φύγε σε {when}', { when: etaTxt(s.leaveInSec) }) };
  if (s.kind === 'now' || s.kind === 'run') return { kind: s.kind, text: t('Φύγε τώρα') };
  if (s.kind === 'walk') return { kind: s.kind, text: t('Με τα πόδια {dur}', { dur: dur(walkSec(it)) }) };
  return { kind: s.kind, text: t('Χωρίς δρομολόγιο τώρα') }; // none, missed
}

// The flag of a bus departure: 'live' | 'scheduled' | 'estimated' | null (no bus now).
const flagOf = (leg) => (leg.departAt == null ? null : srcOf(leg.departSource));

// it: one itinerary of js/trip.js. Returns plain data; every time is { text, source }.
export function tripModel(it, now = Date.now(), dest = '') {
  const buses = busLegs(it);
  const title = titleOf(it, now);
  const total = totalOf(it);
  // the chip shows the arrival clock (it differs between options more than the total does; TEL-294, Kostas)
  const arrive = timeOf(it.arriveAt, it.arriveSource);
  const chip = { kind: it.kind, lines: buses.map((b) => String(b.lineCode)), total, arrive, eta: etaOf(it, now) };
  const first = buses[0] || null;
  const peek = { lines: chip.lines, flag: first ? flagOf(first) : null, text: t('προς {dest}', { dest }) };

  // summary: «25′ συνολικά · 6′ περπάτημα · άφιξη 14:32 · 1 αλλαγή» (spoken); on screen the same parts as small tiles
  // (stats: a number over a short word); a part with no value is left out
  const parts = [];
  const stats = [];
  if (total) {
    parts.push(t('{dur} συνολικά', { dur: total.text }));
    stats.push({ key: 'total', icon: 'clock', value: total, label: t('σύνολο') });
  }
  const ws = walkSec(it);
  if (ws > 0 && it.kind !== 'walk') {
    const wsrc = anyEst(it.legs.filter((l) => l.kind === 'walk'));
    parts.push(t('{dur} περπάτημα', { dur: dur(ws) }));
    stats.push({ key: 'walk', icon: 'walk', value: { text: dur(ws), source: srcOf(wsrc) }, label: t('περπάτημα') });
  }
  if (arrive) {
    parts.push(srcOf(it.arriveSource) === 'estimated' ? t('άφιξη περίπου {clock}', { clock: fmtClock(it.arriveAt) }) : t('άφιξη {clock}', { clock: fmtClock(it.arriveAt) }));
    stats.push({ key: 'arrive', icon: 'pin', value: arrive, label: t('άφιξη') });
  }
  if (it.transfers === 1) {
    parts.push(t('1 αλλαγή'));
    stats.push({ key: 'change', icon: 'swap', value: { text: '1', source: null }, label: t('αλλαγή') });
  }
  const summary = { text: parts.join(' · '), estimated: !!it.estimated, stats };

  const steps = [];
  const notes = [];
  const note = (s) => { if (!notes.includes(s)) notes.push(s); };
  it.legs.forEach((leg, i) => {
    const prev = it.legs[i - 1], last = i === it.legs.length - 1;
    if (leg.kind === 'walk') {
      const time = timeOf(leg.startAt, 'estimated'); // walk times are always estimates
      const d = dur(leg.seconds);
      if (leg.from?.stopCode && leg.to?.stopCode) {
        steps.push({ kind: 'change', icon: 'swap', text: t('Αλλαγή: περπάτα {dur} ως τη στάση «{stop}»', { dur: d, stop: leg.to.name }), sub: fmtDist(leg.meters), time });
      } else if (leg.to?.stopCode) {
        steps.push({ kind: 'walk', icon: 'walk', text: t('Περπάτα {dur} ως τη στάση «{stop}»', { dur: d, stop: leg.to.name }), sub: fmtDist(leg.meters), time });
      } else if (!(last && it.kind !== 'walk' && (leg.meters ?? 0) < MIN_LAST_WALK_M)) {
        steps.push({ kind: 'walk', icon: 'walk', text: t('Περπάτα {dur} ως «{dest}»', { dur: d, dest }), sub: fmtDist(leg.meters), time });
      }
      return;
    }
    // bus leg; two bus legs in a row: the change is at the same stop
    if (prev?.kind === 'bus') {
      const wait = it.transfer?.waitSec;
      steps.push({ kind: 'change', icon: 'swap', text: t('Αλλαγή στη στάση «{stop}»', { stop: leg.board.displayName }),
        sub: wait != null ? t('Περίμενε περίπου {dur}', { dur: dur(wait) }) : null, time: null });
    }
    const flag = flagOf(leg);
    const text = t('Γραμμή {line} προς {dest}', { line: leg.lineCode, dest: leg.routeName });
    if (flag === 'live' || flag === 'scheduled') {
      steps.push({ kind: 'bus', icon: 'bus', text, sub: null, time: timeOf(leg.departAt, leg.departSource), flag, tile: true, leg });
    } else if (flag === 'estimated') {
      steps.push({ kind: 'bus', icon: 'bus', text, sub: null, time: timeOf(leg.departAt, 'estimated'), flag, leg });
      note(t('Η ώρα του δεύτερου λεωφορείου είναι εκτίμηση.'));
    } else {
      steps.push({ kind: 'bus', icon: 'bus', text, sub: t('Χωρίς δρομολόγιο τώρα'), time: null, flag: null, leg });
    }
    if (leg.orderEstimated) note(t('Η σειρά των στάσεων σε αυτή τη γραμμή δεν είναι βέβαιη. Οι ώρες είναι εκτίμηση.'));
    steps.push({ kind: 'ride', icon: 'route', text: tn(leg.nStops, '{n} στάση', '{n} στάσεις'),
      sub: t('Κατέβα στη στάση «{stop}»', { stop: leg.alight.displayName }), time: timeOf(leg.arriveAt, leg.arriveSource) });
  });
  steps.push({ kind: 'arrive', icon: 'pin', text: t('Άφιξη'), sub: null, time: timeOf(it.arriveAt, it.arriveSource) });
  if (it.liveError) note(t('Δεν φορτώθηκαν οι ώρες για αυτή τη στάση.'));
  return { id: it.id, title, chip, peek, summary, steps, notes };
}

// The model of the whole result: the chips (≤ 3) and the walking note, which depends on the order.
export function optionsModel(itineraries, now = Date.now(), dest = '') {
  const its = (itineraries || []).slice(0, MAX_OPTS);
  const models = its.map((it) => tripModel(it, now, dest));
  if (its.length > 1 && its[0].kind === 'walk') models[0].notes.push(t('Με τα πόδια φτάνεις πιο γρήγορα.'));
  return models;
}

// ---------------------------------------------------------------- the view

const skeleton = () => h('li', { class: 'atile atile-skel', 'aria-hidden': 'true' },
  h('div', { class: 'atile-badge' }, h('span', { class: 'skel skel-badge' })),
  h('div', { class: 'atile-body' }, h('span', { class: 'skel skel-line' }), h('span', { class: 'skel skel-line short' })),
  h('div', { class: 'atile-eta' }, h('span', { class: 'skel skel-num' })));

const SAY_SRC = () => ({ live: t('Ζωντανή ώρα'), scheduled: t('Ώρα από το πρόγραμμα'), estimated: t('Εκτίμηση') });
const estFlag = () => h('span', { class: 'tripv-est' }, t('ΕΚΤΙΜ.'));

// opts: { dest, plan({ onUpdate }) → Promise<planTrips result>, lineFor(code) → line | null, onBack(), onOtherDest() }
export function mountTrip(container, ctx, { dest = '', plan, lineFor = () => null, onBack, onOtherDest } = {}) {
  const root = h('div', { class: 'tripv sheet-inset' });
  container.replaceChildren(root);

  let dead = false;
  let result = null; // the last good result of plan()
  let failed = false; // the last plan() failed and there is no good result
  let chosenId = null;
  let its = []; // the itineraries on screen (≤ 3)
  let tiles = []; // arrival tiles in the steps, ticked every second
  let retimed = ''; // the bus we already re-timed after it was missed (once per bus)
  let lastPlanAt = 0, seq = 0;
  let tickTimer = null, planTimer = null;

  const lf = (code) => lineFor(String(code)) || { code: String(code) };
  const badge = (code) => lineBadge({ ...lf(code), code: String(code) });
  const round = (name, label, onclick) => h('button', { type: 'button', class: 'btn round g-circle', 'aria-label': label, title: label, onclick }, icon(name));

  // ---- header: back · leave line (the destination's row under it at low) · ✕ ----
  const title = h('h1', { class: 'tripv-title card-title tabular' }, t('Διαδρομή'));
  const peek = h('div', { class: 'tripv-peek', 'aria-hidden': 'true' });
  const head = h('header', { class: 'tripv-head' },
    h('div', { class: 'tripv-top card-head' },
      round('back', t('Πίσω'), () => onBack?.()),
      h('div', { class: 'tripv-titles' }, title, peek, h('span', { class: 'tripv-peek-end', 'aria-hidden': 'true', 'data-peek-end': '' })), // low ends under it (js/sheet.js)
      round('close', t('Κλείσιμο'), () => ctx.navigate('#/'))));
  // the option chips; the bar holds the glass lens that slides to the chosen one (js/glass.js)
  // TEL-348 (U25): coded as the ☰ menu's theme row: bar[data-lens] > row[role=radiogroup] > button[role=radio], the
  // chosen one aria-checked, the row rebuilt on every choice (that moves the lens, js/glass.js)
  const opts = h('div', { class: 'tripv-opts', role: 'radiogroup', 'aria-label': t('Επιλογές διαδρομής') });
  const optBar = h('div', { class: 'tripv-optbar', 'data-lens': true, hidden: true }, opts);
  // radios: the arrow keys move between the options and choose them, as native radios do
  opts.addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key] || 0;
    if (!step) return;
    const list = [...opts.children], i = list.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    const next = list[(i + step + list.length) % list.length];
    root.dispatchEvent(new CustomEvent('sheet:hold', { bubbles: true })); // only the lens moves (TEL-348)
    choose(next.dataset.key);
    [...opts.children].find((c) => c.dataset.key === next.dataset.key)?.focus({ preventScroll: true });
  });
  const sum = h('div', { class: 'tripv-sum tabular', hidden: true });
  const body = h('div', { class: 'tripv-main' });
  const status = h('p', { class: 'visually-hidden', role: 'status' });
  root.append(head, optBar, sum, body, status);

  let said = '', sayTimer = 0, lastSayKey = '', lastTitle = '';
  const say = (text) => {
    if (text === said) return;
    said = text;
    clearTimeout(sayTimer);
    sayTimer = setTimeout(() => { if (!dead) status.textContent = text; }, 150); // after the region is in the tree
  };

  // ---- the title grows towards up and, halfway, moves to its own row in a short blur (as the stop's name) ----
  const sheetEl = document.getElementById('sheet');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const setUp = (on) => {
    if (head.classList.contains('is-up') === on) return;
    head.classList.toggle('is-up', on);
    if (!reduceMotion.matches) title.animate([{ filter: 'blur(3px)' }, { filter: 'blur(0)' }], { duration: 180, easing: 'ease-out' });
  };
  const upRow = () => !!sheetEl && (sheetEl.dataset.state === 'full' || sheetEl.classList.contains('dragging'))
    && (parseFloat(sheetEl.style.getPropertyValue('--sheet-t')) || 0) > 1.5;
  // the observer only watches the state and the drag starting or ending; sheet.js says when --sheet-t crosses 1.5
  // (sheet:upper), so nothing runs on every frame of a drag (TEL-305)
  const tMO = new MutationObserver(() => setUp(upRow()));
  if (sheetEl) tMO.observe(sheetEl, { attributes: true, attributeFilter: ['class', 'data-state'] });
  const onUpper = () => setUp(upRow());
  sheetEl?.addEventListener('sheet:upper', onUpper);
  const onLeaveUp = () => setUp(false);
  sheetEl?.addEventListener('sheet:leave-full', onLeaveUp);
  // the sheet comes to rest at low or mid after it moved there: the trip fits the part of the map above it (U13).
  // Not when only its content changed height (same state), and never while it is up.
  let settledAt = sheetEl?.dataset.state || '';
  const onSettleMap = () => {
    const st = sheetEl.dataset.state;
    if (st === settledAt) return;
    settledAt = st;
    if ((st === 'peek' || st === 'half') && ctx.map) try { fit(); } catch (err) { console.warn('[trip map]', err); }
  };
  sheetEl?.addEventListener('sheet:settle', onSettleMap);

  // ---- drawing ----
  // an estimate shows only on the option chips: grey, with the orange (*) mark (TEL-294). Tiles and steps look like any
  // other time, as in Google Maps (Kostas); a screen reader still hears where each step's time comes from.
  const isEst = (v) => v?.source === 'estimated';
  const mark = () => h('span', { class: 'tripv-mark', 'aria-hidden': 'true' }, '*');
  const timeEl = (tm, extra = '') => (tm ? h('span', { class: `tripv-time tabular${extra}` },
    h('span', { 'aria-hidden': 'true' }, tm.text), h('span', { class: 'visually-hidden' }, ` ${SAY_SRC()[tm.source] || ''}`)) : h('span', { class: 'tripv-time' }));
  // the option chip: the line pill points into the time pill, in the line's colour (Kostas, TEL-294: design «M»)
  const chipLabel = (n, eta, total) => (eta
    ? (isEst(eta) ? t('Επιλογή {n}: φτάνεις σε περίπου {dur}', { n, dur: eta.text }) : t('Επιλογή {n}: φτάνεις σε {dur}', { n, dur: eta.text }))
    : t('Επιλογή {n}: {dur} συνολικά', { n, dur: total ? total.text : '–' }));
  let chipPills = []; // [{ pill, btn, it, n, total }]: their minutes tick every second

  function stepEl(s, now) {
    if (s.tile) {
      const leg = s.leg;
      const v = { live: leg.departSource === 'live', etaSec: (leg.departAt - leg.fetchedAt) / 1000, lineCode: leg.lineCode,
        routeCode: leg.routeCode, routeName: leg.routeName, vehicleCode: leg.vehicleCode };
      const el = arrivalTile(v, leg.fetchedAt, { compact: true, now, line: lf(leg.lineCode), stop: leg.board.code });
      tiles.push(el);
      return h('li', { class: 'tripv-step tripv-step-tile' }, h('span', { class: 'tripv-ico' }, icon('bus')), h('div', { class: 'tripv-body' }, el));
    }
    const text = h('span', { class: 'tripv-text' }, s.text); // a bus row says «Γραμμή 609 …» in words: no badge too
    return h('li', { class: `tripv-step tripv-step-${s.kind}` },
      h('span', { class: 'tripv-ico' }, icon(s.icon)),
      h('div', { class: 'tripv-body' }, text, s.sub ? h('span', { class: 'tripv-sub' }, s.sub) : null),
      h('span', { class: 'tripv-right' }, timeEl(s.time), s.flag === 'estimated' ? estFlag() : null));
  }

  function peekFlag(f) {
    if (f === 'live') return h('span', { class: 'tripv-flag is-live' }, h('span', { class: 'atile-dot' }), t('LIVE'));
    if (f === 'scheduled') return h('span', { class: 'tripv-flag' }, t('ΠΡΟΓΡ.'));
    if (f === 'estimated') return estFlag();
    return null;
  }

  // The chosen itinerary changed: the first result, a tap on a chip, a new result (or the same bus re-timed).
  // The one place where the chosen trip is set and drawn, on the sheet and on the map (TEL-295).
  // tap: the user picked a chip, so the map fits the trip again.
  function choose(id, tap = false) {
    if (dead) return;
    if (tap) root.dispatchEvent(new CustomEvent('sheet:hold', { bubbles: true })); // only the lens moves (TEL-348, js/sheet.js)
    const it = its.find((x) => x.id === id) || its[0] || null;
    chosenId = it ? it.id : null;
    draw();
    mapTrip(it, tap);
  }

  // ---- map: the chosen trip drawn (js/trip-map.js); the map moves only on the first draw, a chip tap and a sheet
  // that comes to rest at another height. Never on the 20 s refresh (Kostas, TEL-222). ----
  let mapKey = ''; // what is drawn: redrawn only when the trip or its walking geometry changes, not the times
  let fitPts = null, fitted = false;
  const tripKey = (it) => `${it.id}|` + it.legs.map((l) => (l.kind === 'bus'
    ? `b${l.routeCode}:${l.boardIndex}-${l.alightIndex}${l.orderEstimated ? '~' : ''}`
    : `w${l.geometry?.length || 0}`)).join(',');
  const fit = () => { if (fitPts?.length) ctx.map.fitTo(fitPts, { maxZoom: 16 }); };
  function mapTrip(it, tap) {
    if (!ctx.map) return; // #app.no-map: the list works on its own
    try {
      if (!it) { if (mapKey) { clearTrip(ctx.map); mapKey = ''; fitPts = null; } return; }
      const key = tripKey(it);
      if (key !== mapKey) { mapKey = key; fitPts = drawTrip(ctx.map, it, ctx.data).points; }
      if (tap || !fitted) { fitted = true; fit(); }
    } catch (err) { console.warn('[trip map]', err); }
  }

  function stateBlock(ico, titleText, sub, btnText, onclick) {
    return h('div', { class: 'tripv-state', 'data-mid-end': '1' },
      icon(ico), h('p', { class: 'tripv-state-title' }, titleText),
      sub ? h('p', { class: 'tripv-state-sub' }, sub) : null,
      btnText ? h('button', { type: 'button', class: 'btn primary', onclick }, btnText) : null);
  }

  function draw() {
    if (dead) return;
    const now = Date.now();
    tiles = [];
    if (!result && !failed) { // loading: the header is there from the start, so low and mid do not jump
      title.textContent = t('Διαδρομή');
      peek.replaceChildren();
      optBar.hidden = true; sum.hidden = true;
      const list = h('ul', { class: 'tripv-skel' }, skeleton(), skeleton());
      list.children[1].dataset.midEnd = '0.33';
      body.replaceChildren(h('p', { class: 'tripv-wait' }, t('Ψάχνω διαδρομή…')), list);
      say(t('Ψάχνω διαδρομή…'));
      return;
    }
    if (!result || result.reason === 'no-data') { // offline or failed: no times at all
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
      const msg = offline ? t('Δεν υπάρχει σύνδεση με το διαδίκτυο.') : t('Η υπηρεσία πληροφόρησης δεν ανταποκρίνεται αυτή τη στιγμή.');
      title.textContent = t('Διαδρομή');
      peek.replaceChildren();
      optBar.hidden = true; sum.hidden = true;
      body.replaceChildren(stateBlock('alert', msg, offline ? t('Χωρίς σύνδεση δεν μπορώ να δω πότε περνάει το λεωφορείο.') : null, t('Δοκίμασε ξανά'), () => runPlan(true)));
      say(msg);
      return;
    }
    if (!its.length) {
      title.textContent = t('Διαδρομή');
      peek.replaceChildren();
      optBar.hidden = true; sum.hidden = true;
      body.replaceChildren(stateBlock('route', t('Δεν βρέθηκε διαδρομή με λεωφορείο'),
        t('Δεν υπάρχει γραμμή, ούτε με μία αλλαγή, που να σε πάει εκεί.'), t('Άλλος προορισμός'), () => onOtherDest?.()));
      say(t('Δεν βρέθηκε διαδρομή με λεωφορείο'));
      return;
    }
    const models = optionsModel(its, now, dest);
    const m = models.find((x) => x.id === chosenId) || models[0];

    title.textContent = m.title.text;
    peek.replaceChildren(...[...(m.chip.kind === 'walk' ? [icon('walk')] : m.peek.lines.map(badge)), peekFlag(m.peek.flag), h('span', { class: 'tripv-peek-to' }, m.peek.text)].filter(Boolean));

    // chips: one per option, the chosen one under the lens; focus stays on the same chip after a rebuild
    const focused = opts.contains(document.activeElement) ? document.activeElement.dataset.key : null;
    chipPills = [];
    opts.replaceChildren(...models.map((x, i) => {
      const on = x.id === m.id;
      const shown = x.chip.eta || x.chip.total; // in how many minutes you arrive; the total only when there is no arrival
      const pill = shown ? h('span', { class: `tripv-tp tabular${isEst(shown) ? ' is-est' : ''}${x.chip.kind === 'walk' ? ' solo' : ''}` }, shown.text) : null;
      let kids;
      if (x.chip.kind === 'walk') {
        kids = [icon('walk'), pill];
      } else {
        const lines = x.chip.lines;
        const last = lines[lines.length - 1];
        const lastBadge = badge(last);
        const duo = h('span', { class: 'tripv-duo' }, lastBadge, pill);
        duo.style.setProperty('--lc', lastBadge.style.background || 'var(--border)');
        kids = [...lines.slice(0, -1).flatMap((c) => [badge(c), h('span', { class: 'tripv-sep', 'aria-hidden': 'true' }, '›')]), duo];
      }
      const btn = h('button', { type: 'button', role: 'radio', class: 'tripv-opt', 'aria-checked': String(on), 'data-key': x.id, tabindex: on ? '0' : '-1',
        'aria-label': chipLabel(i + 1, x.chip.eta, x.chip.total), onclick: () => choose(x.id, true) }, ...kids.filter(Boolean));
      if (pill && x.chip.eta) chipPills.push({ pill, btn, it: its[i], n: i + 1, total: x.chip.total });
      return btn;
    }));
    if (focused) [...opts.children].find((c) => c.dataset.key === focused)?.focus({ preventScroll: true });
    optBar.hidden = false;

    sum.hidden = !m.summary.text;
    // the tiles are for the eye; a screen reader hears the one sentence instead
    sum.replaceChildren(...[
      h('p', { class: 'visually-hidden' }, m.summary.text),
      h('div', { class: 'tripv-stats', 'aria-hidden': 'true' }, m.summary.stats.map((s) => h('div', { class: `tripv-stat tripv-stat-${s.key}` },
        icon(s.icon),
        h('span', { class: 'tripv-stat-n' }, s.value.text),
        h('span', { class: 'tripv-stat-l' }, s.label)))),
      m.summary.estimated ? estFlag() : null].filter((x) => x != null)); // (replaceChildren would print a null as "null")

    const steps = h('ol', { class: 'tripv-steps' }, m.steps.map((s) => stepEl(s, now)));
    // where mid ends (js/sheet.js): a third into the second step, so it is clear the list goes on (as the stop card)
    const rows = steps.children;
    const midEnd = rows[1] || rows[0];
    if (midEnd) midEnd.dataset.midEnd = rows[1] ? '0.33' : '1';
    body.replaceChildren(...[steps,
      m.notes.length ? h('ul', { class: 'tripv-notes' }, m.notes.map((n) => h('li', {}, icon('info'), h('span', {}, n)))) : null,
      h('p', { class: 'tripv-legend' }, t('LIVE = το λεωφορείο φαίνεται τώρα · ΠΡΟΓΡ. = ώρα από το πρόγραμμα'), ' · ',
        h('span', { class: 'tripv-legend-mark' }, mark()), t('= εκτίμηση, μπορεί να διαφέρει'))].filter(Boolean));
    lastTitle = m.title.text;
    // spoken when the option or the kind of leave line changes, not on every minute of the countdown
    const sayKey = `${m.title.kind}|${m.id}`;
    if (sayKey !== lastSayKey) { lastSayKey = sayKey; say(m.title.text); }
  }

  // ---- data ----
  function apply(res, mySeq) {
    if (dead || mySeq !== seq || !res) return;
    if (res.reason === 'no-data' && result && result.itineraries?.length) return; // keep the good result on screen
    result = res;
    failed = false;
    its = (res.itineraries || []).slice(0, MAX_OPTS);
    retimed = '';
    choose(chosenId); // keeps the chosen option by its id; the first when it is gone
  }
  async function runPlan(force = false) {
    if (dead || typeof plan !== 'function') return;
    if (!force && Date.now() - lastPlanAt < PLAN_MS) { schedule(); return; }
    lastPlanAt = Date.now();
    schedule();
    const mySeq = ++seq;
    if (force && !result) { failed = false; draw(); }
    try {
      const res = await plan({ onUpdate: (r) => apply(r, mySeq) });
      apply(res, mySeq);
    } catch (err) {
      if (dead || mySeq !== seq) return;
      if (err?.name !== 'AbortError') console.warn('[trip]', err);
      if (!result) { failed = true; draw(); } // a later failure keeps the good result
    }
  }

  // ---- clock: the countdown every second, from the times we already have ----
  function tick() {
    if (dead || !its.length) return;
    const now = Date.now();
    const it = its.find((x) => x.id === chosenId);
    if (!it) return;
    const s = leaveState(it, now);
    const bus = it.legs.find((l) => l.kind === 'bus');
    const key = `${it.id}|${bus?.departAt}`;
    if (s.kind === 'missed' && retimed !== key) {
      retimed = key;
      const i = its.indexOf(it);
      its[i] = retime(it, now) || it;
      choose(its[i].id);
      return;
    }
    const text = titleOf(it, now).text;
    if (text !== lastTitle) { lastTitle = text; title.textContent = text; }
    for (const el of tiles) el.tick(now);
    for (const c of chipPills) { // the chips' minutes count down with the clock
      const eta = etaOf(c.it, now);
      if (eta && c.pill.textContent !== eta.text) { c.pill.textContent = eta.text; c.btn.setAttribute('aria-label', chipLabel(c.n, eta, c.total)); }
    }
  }
  // the next plan() 20 s after the last one, only while the page is visible
  function schedule() {
    clearTimeout(planTimer);
    planTimer = null;
    if (dead || document.visibilityState !== 'visible') return;
    planTimer = setTimeout(() => runPlan(), Math.max(0, lastPlanAt + PLAN_MS - Date.now()));
  }
  function onVisibility() {
    clearInterval(tickTimer); clearTimeout(planTimer);
    tickTimer = planTimer = null;
    if (document.visibilityState !== 'visible') return;
    tick();
    runPlan(); // at once only when 20 s have passed since the last call; else at that moment
    tickTimer = setInterval(tick, 1000);
  }

  draw();
  runPlan(true);
  document.addEventListener('visibilitychange', onVisibility);
  onVisibility();

  return {
    destroy() {
      dead = true;
      clearInterval(tickTimer); clearTimeout(planTimer);
      clearTimeout(sayTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      tMO.disconnect();
      sheetEl?.removeEventListener('sheet:upper', onUpper);
      sheetEl?.removeEventListener('sheet:leave-full', onLeaveUp);
      sheetEl?.removeEventListener('sheet:settle', onSettleMap);
      try { if (ctx.map) clearTrip(ctx.map); } catch (err) { console.warn('[trip map]', err); }
      root.remove();
    },
  };
}
