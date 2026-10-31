// Stop sheet: header + arrival tiles that say how long, and whether it is live or just the timetable.
// Contract in docs/ARCHITECTURE.md. Styles: css/arrivals.css (prefixes .atile-, .stopv-).
// Minimal UI: a tile is badge + destination + big countdown + a small LIVE / ΠΡΟΓΡ. flag; explanations live in Settings → Σχετικά.
import { h, icon, lineBadge, fmtClock } from './ui.js';
import { titleCase } from './text.js';
import { createLivePoller, remainingSec, fetchStats, usualDelayText, DEMO, isStale } from './api.js';
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
// v: normalised Vehicle. opts: { compact, now, line, stop, lineLinks, stat, stale }. The element has .tick(now) to refresh the countdown in
// place (the stop view calls it every second; other modules may do the same or just re-render) and .setStat(stat) to show the
// quiet "συνήθως +3′" under a scheduled tile (reliability stats from api.fetchStats; ignored for live ones).
// With opts.stop (the stop code the tile belongs to) the tile is a link: a live bus opens its route (#/bus/…), a scheduled
// departure (no vehicle position) opens its line (#/line/…; lineLinks: false turns that off, e.g. inside the line view).
export const busHash = (v, stop) => cityHash(`#/bus/${encodeURIComponent(v.vehicleCode)}?route=${encodeURIComponent(v.routeCode)}&stop=${encodeURIComponent(stop)}`);
const lineHash = (v) => cityHash(`#/line/${encodeURIComponent(v.lineCode)}?route=${encodeURIComponent(v.routeCode)}`);

export function arrivalTile(v, fetchedAt, { compact = false, now = Date.now(), line, stop, lineLinks = true, stat = null, stale = false } = {}) {
  const live = !!v.live;
  const aged = live && stale; // TEL-52: its position is older than STALE_MS, so it must not read as LIVE any more
  const href = stop && live && v.vehicleCode && v.routeCode ? busHash(v, stop)
    : stop && !live && lineLinks && v.lineCode && v.routeCode ? lineHash(v) : null;
  const at = fetchedAt + v.etaSec * 1000; // ETA as a wall-clock instant; constant between fetches
  const clock = fmtClock(at);
  const dest = titleCase(v.routeName);
  const badge = lineBadge({ code: v.lineCode, color: line?.color || v.color, textColor: line?.textColor || v.textColor });

  const num = h('span', { class: 'atile-num tabular' });
  const age = aged ? h('span', { class: 'atile-age' }) : null;
  const flag = live
    ? h('span', { class: 'atile-flag' }, h('span', { class: 'atile-dot', 'aria-hidden': 'true' }), t('LIVE'), age)
    : h('span', { class: 'atile-flag' }, icon('clock'), t('ΠΡΟΓΡ.'), h('span', { class: 'atile-clock' }, clock));
  const usual = h('span', { class: 'atile-usual', hidden: true });
  const status = h('div', { class: 'atile-status' }, flag, live ? null : usual);

  const el = h(href ? 'a' : 'div', { class: `atile ${live ? 'atile-live' : 'atile-sched'}${aged ? ' atile-aged' : ''}${compact ? ' atile-compact' : ''}${href ? ' atile-link press' : ''}`, role: href ? null : 'img', href },
    h('div', { class: 'atile-badge' }, badge),
    h('div', { class: 'atile-body' }, h('div', { class: 'atile-dest' }, dest), status),
    h('div', { class: 'atile-eta' }, num),
    href ? icon('chevron') : null);
  const hint = (stale ? t(' Τα δεδομένα δεν έχουν ενημερωθεί πρόσφατα.') : '') + (href ? (live ? t(' Πάτα για τη διαδρομή του οχήματος.') : t(' Πάτα για τη γραμμή.')) : '');

  let lastText = null, usualTxt = '';
  const label = (rem) => {
    const a = { line: v.lineCode, dest, clock, when: whenSpoken(rem), hint };
    return live ? t('Γραμμή {line}, {dest}. Ζωντανή θέση: φτάνει {when}, περίπου στις {clock}.{hint}', a)
      : t('Γραμμή {line}, {dest}. Προγραμματισμένη άφιξη στις {clock}, {when}. Δεν υπάρχει ζωντανή θέση και μπορεί να μην τηρηθεί.', a) + (usualTxt ? ` ${usualTxt}.` : '') + hint;
  };
  el.tick = (t0 = Date.now()) => {
    if (age) age.textContent = t('πριν {age}', { age: ageText((t0 - fetchedAt) / 1000) });
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
      h('button', { type: 'button', class: 'btn primary', onclick: () => ctx.navigate('#/') }, t('Πίσω στην αρχική')));
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

  // ---- header (TEL-227, an Apple Maps place card): share · centred name and "Stop 1011 · <line badges>" · close;
  // under it the pill row: directions and ☆. The ⋯ menu is gone: its two items are on screen now ----
  const iconBtn = (name, label, onclick) => h('button', { type: 'button', class: 'btn round', 'aria-label': label, title: label, onclick }, icon(name));
  const star = h('button', { type: 'button', class: 'stopv-pill stopv-star', onclick: () => { toggleFavorite(code); paintStar(); } });
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

  // the line badges sit in the slot at low (the filter chips below, carried up: css/glass.css, placed by placeChips())
  const codeText = h('span', { class: 'stopv-code' }, t('Στάση {code}', { code }));
  const dot = h('span', { class: 'stopv-dot' }, '·');
  const slot = h('span', { class: 'stopv-slot', 'aria-hidden': 'true' }, dot);
  const name = h('h1', { class: 'stopv-name', title: stop.displayName }, stop.displayName);
  const head = h('header', { class: 'stopv-head' },
    h('div', { class: 'stopv-top' },
      iconBtn('share', t('Κοινοποίηση'), share),
      h('div', { class: 'stopv-titles' }, name, h('p', { class: 'stopv-sub' }, codeText, slot)),
      iconBtn('close', t('Κλείσιμο'), () => ctx.navigate('#/'))),
    // the row keeps its mid height at every state (the pills grow inside it), so nothing below moves while they grow;
    // low ends at the bottom of the small pills (the marker, js/sheet.js)
    h('div', { class: 'stopv-acts' },
      h('span', { class: 'stopv-peek', 'aria-hidden': 'true', 'data-peek-end': '' }),
      h('button', { type: 'button', class: 'stopv-pill primary', onclick: directions }, icon('walk'), h('span', {}, t('Οδηγίες ως εδώ'))),
      star));

  // ---- dynamic parts ----
  const bannerText = h('span', { class: 'stopv-banner-text' });
  const bannerBtn = h('button', { type: 'button', class: 'btn ghost sm stopv-small', onclick: () => doRefresh() }, t('Δοκίμασε ξανά'));
  // Not a live region: its age is rewritten every second. State changes are spoken once through `status` instead.
  const banner = h('div', { class: 'stopv-banner', hidden: true }, icon('alert'), bannerText, bannerBtn);
  const chips = h('div', { class: 'stopv-chips', role: 'group', 'aria-label': t('Φίλτρο γραμμής') });
  // at low the chips are flat line badges inside the subtitle (TEL-224/227, css/glass.css); towards mid they come down
  // into their own row and grow into the filter chips
  const chipBar = h('div', { class: 'stopv-chipbar', hidden: true }, chips);
  const body = h('div', { class: 'stopv-body' });
  const foot = h('p', { class: 'stopv-foot-text' });
  const refreshBtn = h('button', { type: 'button', class: 'btn round stopv-refresh', 'aria-label': t('Ανανέωση'), title: t('Ανανέωση'), onclick: () => doRefresh() }, icon('refresh'));
  // Loading / error / empty / loaded / stale, spoken once per change of kind, never on a routine 20 s poll (WCAG 4.1.3).
  const status = h('p', { class: 'visually-hidden', role: 'status' });
  root.append(head, banner, chipBar, body, h('footer', { class: 'stopv-foot' }, foot, refreshBtn), status);
  // where the chips go at low (TEL-227): the slot gets the badges' width (as much of it as fits beside "Stop 1011", so
  // the line stays centred) and the first badge lands just after the dot. Measured with the slot at its low width and
  // the bar without its transform; css/glass.css moves the bar by (1 - --l) of it, so it travels with the sheet.
  function placeChips() {
    if (dead || chipBar.hidden || getComputedStyle(slot).display === 'none') return;
    const badges = [...chips.querySelectorAll('.stopv-chip:not([data-key="*"]) .badge')];
    const GAP = 4; // the chips' gap at low (css/glass.css)
    const titles = slot.parentElement.parentElement.getBoundingClientRect();
    const dotW = dot.getBoundingClientRect().width + 12; // the dot and its 6 px margins
    const room = Math.max(0, titles.width - codeText.getBoundingClientRect().width - dotW);
    const want = badges.reduce((w, b) => w + b.getBoundingClientRect().width, 0) + GAP * Math.max(0, badges.length - 1);
    const shown = Math.min(want, room);
    chipBar.style.transform = 'none';
    slot.style.width = `${dotW + shown}px`;
    const bar = chipBar.getBoundingClientRect(), row = chips.getBoundingClientRect(), s = slot.getBoundingClientRect();
    const pad = parseFloat(getComputedStyle(chips).paddingLeft) || 0;
    slot.style.width = '';
    chipBar.style.transform = '';
    const start = row.left - bar.left + pad + 1; // the first badge at low: the chips lose their padding there, not their 1 px border
    head.style.setProperty('--pk-w', `${Math.round(dotW + shown)}px`);
    chipBar.style.setProperty('--pk-dx', `${Math.round(s.left + dotW - bar.left - start)}px`);
    chipBar.style.setProperty('--pk-dy', `${Math.round(s.top + s.height / 2 - (row.top + row.height / 2))}px`);
    // all fit: the scroller keeps its right padding too, so it has nothing to scroll and draws no edge fade
    const end = start + shown + (want <= room ? pad + 8 : 0);
    chipBar.style.setProperty('--pk-cut', `${Math.max(0, Math.round(row.right - bar.left - end))}px`);
  }
  const chipRO = new ResizeObserver(() => placeChips());
  chipRO.observe(head);
  chipRO.observe(chipBar);
  let saidKind = '', sayTimer = 0;
  function say(kind, text) {
    if (kind === saidKind) return;
    saidKind = kind;
    clearTimeout(sayTimer);
    sayTimer = setTimeout(() => { if (!dead) status.textContent = text; }, 150); // after the region is in the tree
  }

  const poller = createLivePoller(code, (s) => {
    if (dead) return;
    if (s.loading) retryPending = false;
    st = s;
    render();
    pushMap();
  });

  // Retry buttons use aria-disabled instead of disabled, so they keep keyboard focus while they wait.
  const waiting = () => st.loading || (retryPending && st.nextAt && secsUntil(st.nextAt, Date.now()) > 0);
  function doRefresh() {
    if (waiting()) return;
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
    stale = !!data && isStale(data.fetchedAt, now);
    const all = data ? data.vehicles.filter((v) => leftSec(v, data.fetchedAt, now) > -GONE_SEC) : [];

    // chips (only worth showing when 2+ lines have arrivals)
    const lines = [];
    for (const v of all) if (!lines.some((l) => l.code === v.lineCode)) lines.push({ code: v.lineCode, color: v.color, textColor: v.textColor });
    if (filter && !lines.some((l) => l.code === filter)) lines.push({ code: filter, color: ctx.data.lineByCode.get(filter)?.color, textColor: ctx.data.lineByCode.get(filter)?.textColor });
    const hadChips = !chipBar.hidden;
    chipBar.hidden = lines.length < 2;
    head.classList.toggle('has-lines', !chipBar.hidden);
    // Rebuilt only when the lines or the filter change (not on every poll), and focus stays on the same chip.
    const chipSig = `${filter}|${lines.map((l) => l.code).join(',')}`;
    if (!chipBar.hidden && chipSig !== chips.dataset.sig) {
      chips.dataset.sig = chipSig;
      const focusedChip = chips.contains(document.activeElement) ? document.activeElement.dataset.key : null;
      const chip = (label, on, onclick, kids, key) => h('button', { type: 'button', class: `stopv-chip${on ? ' on' : ''}`, 'aria-pressed': String(on), 'data-key': key, onclick }, kids || label);
      chips.replaceChildren(
        chip(t('Όλες'), !filter, () => { filter = null; showAll = false; render(); pushMap(); }, null, '*'),
        ...lines.map((l) => chip(null, filter === l.code, () => { filter = filter === l.code ? null : l.code; showAll = false; render(); pushMap(); },
          [lineBadge(ctx.data.lineByCode.get(l.code) || l)], l.code)));
      if (focusedChip) [...chips.children].find((c) => c.dataset.key === focusedChip)?.focus({ preventScroll: true });
      placeChips();
    } else if (!hadChips && !chipBar.hidden) placeChips();

    // body. Whatever had keyboard focus in it (a tile, "show all", "try again") gets it back after the rebuild.
    body.setAttribute('aria-busy', String(!data && !st.error));
    const hadFocus = body.contains(document.activeElement);
    const focusKey = hadFocus ? document.activeElement.dataset?.key : null;
    tiles = [];
    if (!data && !st.error) {
      body.replaceChildren(h('ul', { class: 'stopv-list' }, skeleton(), skeleton(), skeleton()));
      say('loading', t('Φόρτωση αφίξεων…'));
    } else if (!data) {
      const title = t('Δεν φορτώθηκαν οι αφίξεις'), sub = errText(st.error);
      // The same error again (a retry that failed): keep the block, and the focused retry button, in place.
      if (body.dataset.err !== sub || !body.querySelector('.stopv-retry')) {
        body.replaceChildren(h('div', { class: 'stopv-state' },
          icon('alert'), h('p', { class: 'stopv-state-title' }, title),
          h('p', { class: 'stopv-state-sub' }, sub), retryButton()));
      }
      say(`error:${sub}`, `${title}. ${sub}`);
    } else if (!all.length) {
      body.replaceChildren(h('div', { class: 'stopv-state' },
        icon('clock'), h('p', { class: 'stopv-state-title' }, t('Καμία προγραμματισμένη άφιξη αυτή τη στιγμή')),
        h('p', { class: 'stopv-state-sub' }, t('Η λίστα ανανεώνεται αυτόματα.'))));
      say('empty', t('Καμία προγραμματισμένη άφιξη αυτή τη στιγμή'));
    } else {
      const shown = filter ? all.filter((v) => v.lineCode === filter) : all;
      if (!shown.length) {
        body.replaceChildren(h('div', { class: 'stopv-state' },
          icon('clock'), h('p', { class: 'stopv-state-title' }, t('Καμία άφιξη για τη γραμμή {line}', { line: filter })),
          h('button', { type: 'button', class: 'btn ghost sm stopv-small', onclick: () => { filter = null; render(); pushMap(); } }, t('Εμφάνιση όλων των γραμμών'))));
      } else {
        const cut = showAll ? shown : shown.slice(0, MAX_TILES);
        const items = cut.map((v) => {
          const tl = arrivalTile(v, data.fetchedAt, { now, line: ctx.data.lineByCode.get(v.lineCode), stop: code, stat: v.live ? null : stats.get(v.routeCode), stale });
          tl.dataset.key = v.vehicleCode || `${v.routeCode}:${v.etaSec}`;
          tiles.push({ v, el: tl });
          return h('li', {}, tl);
        });
        // replaceChildren would stringify a null child as "null", so only pass real nodes.
        body.replaceChildren(h('ul', { class: 'stopv-list' }, items));
        if (cut.length < shown.length) {
          body.append(h('button', { type: 'button', class: 'btn ghost stopv-more', 'data-key': 'more', onclick: () => {
            showAll = true;
            render();
            tiles[MAX_TILES]?.el.focus({ preventScroll: true }); // the first tile that just appeared
          } }, t('Εμφάνιση όλων ({n})', { n: shown.length })));
        }
        wantStats();
      }
      const nLive = all.filter((v) => v.live).length;
      say(stale ? 'stale' : 'ok', stale ? t('Παλιά δεδομένα: οι χρόνοι μπορεί να μην ισχύουν.')
        : all.length === 1 ? t('{n} άφιξη, {live} με ζωντανή θέση', { n: 1, live: nLive })
        : t('{n} αφίξεις, {live} με ζωντανή θέση', { n: all.length, live: nLive }));
    }
    body.dataset.err = !data && st.error ? errText(st.error) : '';
    // where mid ends (TEL-224, js/sheet.js): a third into the second arrival (TEL-227, as Apple Maps shows the next
    // card), so it is clear the list goes on; with one arrival (or a message) right under it. The loading skeleton is
    // marked the same way, so mid does not jump on load.
    const rows = body.querySelectorAll('.stopv-list > li');
    const midEnd = rows[1] || rows[0] || body.querySelector('.stopv-state');
    if (midEnd) midEnd.dataset.midEnd = rows[1] ? '0.33' : '1';
    if (hadFocus && !body.contains(document.activeElement)) {
      const back = (focusKey && body.querySelector(`[data-key="${CSS.escape(focusKey)}"]`)) || body.querySelector('a, button');
      back?.focus({ preventScroll: true });
    }
    paintDynamic(now);
  }

  const retryButton = () => h('button', { type: 'button', class: 'btn primary stopv-retry', 'data-key': 'retry', onclick: () => doRefresh() }, t('Δοκίμασε ξανά'));

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
      b.setAttribute('aria-disabled', String(st.loading || (retryPending && wait > 0)));
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
    if (data && (isStale(data.fetchedAt, now) !== stale || tiles.some((x) => leftSec(x.v, data.fetchedAt, now) <= -GONE_SEC))) {
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
      clearTimeout(sayTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      unsubStore();
      chipRO.disconnect();
      poller.destroy();
      mapQ = mapQ.then(() => { try { if (ctx.map) { ctx.map.clearVehicles('stop'); ctx.map.highlightStop(null); } } catch (e) { console.warn('map', e); } });
      root.remove();
    },
  };
}
