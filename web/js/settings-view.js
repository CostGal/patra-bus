// Settings + about (owner: extras / i18n). Collapsible sections, short labels, explanations behind (i). Styles in css/extras.css.
// TEL-251 (UI-PROTOCOL): the kit's .card-head with ✕ (U2–U5), 16 px inset (.sheet-inset), and every pick-one row is one
// glass capsule with the lens (U25, js/glass.js: bar[data-lens] > row > chip), coded as the ☰ menu's theme row. The
// notifications section, the «reminder before you leave» row and the walking speed are gone (Kostas, 2026-11-21).
import { h, icon } from './ui.js';
import { getSettings, setSetting, getFavorites, removeFavorite, moveFavorite, clearRecents, clearAll, onChange, applyTheme } from './store.js';
import { cancelAll as cancelAllReminders } from './notify.js'; // the wipe still clears any reminder an older version left
import { t, tn, N_, setLang, onLangChange, locale, lang, APP_NAME, APP_VERSION } from './i18n.js';
import { CITIES, city, cityId, cityName, dataDir } from './cities.js';
import { cityHash } from './route.js';

let uid = 0;

const LINKS = [
  ['© OpenStreetMap contributors', 'https://www.openstreetmap.org/copyright', N_('δεδομένα χάρτη')],
  ['OpenFreeMap', 'https://openfreemap.org', N_('πλακίδια χάρτη')],
  ['MapLibre GL JS', 'https://maplibre.org', N_('απεικόνιση χάρτη')],
  ['OSRM / FOSSGIS routing', 'https://routing.openstreetmap.de', N_('διαδρομές περπατήματος')],
  ['Photon by komoot', 'https://photon.komoot.io', N_('αναζήτηση τόπων')],
];
// The transit data comes from the active city's citybus.gr site.
const dataSource = () => { const u = new URL(city().page); return [u.host, u.origin, N_('στάσεις, γραμμές και αφίξεις')]; };

// Open sections survive a re-mount that follows within 1.5 s (the app re-routes on a language change), nothing longer.
let openKeys = new Set();
let leftAt = 0;

// The whole view is rebuilt on a language change (open sections and the focused language button are kept).
// opts.section ('home' = Σπίτι & δουλειά, from the home's Places) opens that section and scrolls to it.
export function mountSettings(container, ctx, opts = {}) {
  let view = null;
  let gone = false;
  if (Date.now() - leftAt > 1500) openKeys = new Set();
  if (opts?.section === 'home') openKeys.add('home');
  const render = () => {
    if (gone) return; // the app may already have re-mounted this view
    const keep = { lang: null };
    const a = document.activeElement;
    if (a && container.contains(a) && a.closest('[data-lang-seg]')) keep.lang = a.dataset.v;
    view?.teardown();
    view = build(container, ctx, keep);
    // `> .theme-row >`: the real row, not the lens's copy of it (js/glass.js)
    if (keep.lang) container.querySelector(`[data-lang-seg] > .theme-row > [data-v="${keep.lang}"]`)?.focus({ preventScroll: true });
  };
  render();
  if (opts?.section === 'home') container.querySelector('[data-k="home"]')?.scrollIntoView({ block: 'start' });
  const off = onLangChange(render);
  return { destroy() { gone = true; leftAt = Date.now(); off(); view.teardown(); } };
}

function build(container, ctx, keep) {
  const offs = [];
  const timers = new Set();
  let dead = false;
  const after = (fn, ms) => { const id = setTimeout(() => { timers.delete(id); fn(); }, ms); timers.add(id); return id; };
  const say = (text) => { try { ctx.toast(text); } catch { /* ignore */ } };
  const dateFmt = new Intl.DateTimeFormat(locale(), { dateStyle: 'medium', timeZone: 'Europe/Athens' });

  // Collapsible section: <details> keeps its open state across re-renders via openKeys.
  const sec = (key, title, ...kids) => {
    const d = h('details', { class: 'set-sec', 'data-k': key, ontoggle: () => { if (d.open) openKeys.add(key); else openKeys.delete(key); } },
      h('summary', { class: 'set-sum press' }, h('span', { class: 'set-sum-title' }, title), icon('chevron-down')),
      h('div', { class: 'set-body' }, ...kids));
    d.open = openKeys.has(key);
    return d;
  };
  // (i) button + the explanation it reveals.
  const info = (text) => {
    const p = h('p', { class: 'ex-sub set-hint', hidden: true }, text);
    const b = h('button', { type: 'button', class: 'ex-info press', 'aria-label': t('Περισσότερα'), 'aria-expanded': 'false', onclick: () => {
      const on = p.hidden; p.hidden = !on; b.setAttribute('aria-expanded', String(on));
    } }, icon('info'));
    return [b, p];
  };
  // Cards owned by other modules (places): loaded lazily and guarded, so a failing one never breaks settings.
  const ext = [];
  const slots = [];
  function extSlot(load, mountName) {
    const el = h('div', { class: 'set-ext' });
    slots.push(el);
    load().then((m) => {
      if (dead) return;
      const v = m[mountName](el, ctx);
      if (dead) { try { v && v.destroy && v.destroy(); } catch { /* ignore */ } return; }
      if (v) ext.push(v);
    }).catch((err) => { console.warn(`[settings] ${mountName} failed`, err); el.hidden = true; });
    return el;
  }
  const row = (id, label, hint, control) => {
    const [b, p] = hint ? info(hint) : [];
    return h('div', { class: 'set-row' },
      h('div', { class: 'set-row-text' }, h('div', { class: 'set-label' }, h('span', { id }, label), b), p), control);
  };

  // ---------- controls bound to a setting ----------
  const syncs = [];
  // A pick-one row (UI-PROTOCOL U25), coded as the ☰ menu's theme row (js/app.js paintThemeRow, Kostas: "the best by
  // far"): bar[data-lens].theme-bar > .theme-row[role=radiogroup] > button.theme-opt[role=radio], equal widths, the
  // chosen one aria-checked. The row is rebuilt whenever the value changes (a rebuilt row is what moves the lens,
  // js/glass.js), not only re-marked; focus that was in the row goes to the chosen button. options: [value, content,
  // label]; content is text or an icon, label names an icon. Returns { bar, paint }.
  function pickRow(labelId, options, onPick) {
    const row = h('div', { class: 'theme-row', role: 'radiogroup', 'aria-labelledby': labelId });
    let shown = null;
    const paint = (value) => {
      const cur = String(value);
      if (cur === shown) return;
      shown = cur;
      const hadFocus = row.contains(document.activeElement);
      row.replaceChildren(...options.map(([v, content, label]) => h('button', {
        type: 'button', class: 'theme-opt', role: 'radio', 'data-v': String(v), 'aria-checked': String(String(v) === cur),
        'aria-label': label, title: label, onclick: () => onPick(v),
      }, content)));
      if (hadFocus) row.querySelector('[aria-checked="true"]')?.focus({ preventScroll: true });
    };
    return { bar: h('div', { class: 'theme-bar', 'data-lens': true }, row), paint };
  }
  // A pick-one row bound to a setting: repainted from the store.
  function segmented(key, labelId, options) {
    const { bar, paint } = pickRow(labelId, options, (value) => {
      setSetting(key, value);
      if (key === 'theme') applyTheme(value);
    });
    const sync = () => paint(getSettings()[key]);
    syncs.push(sync); sync();
    return bar;
  }
  // Language and city rebuild or reload the app: the lens first glides to the new pick, then the change happens.
  const GLIDE_MS = 450;
  function select(key, labelId, options) {
    const el = h('select', { class: 'ex-select', 'aria-labelledby': labelId, onchange: () => setSetting(key, Number(el.value)) },
      ...options.map(([value, text]) => h('option', { value: String(value) }, text)));
    const sync = () => { el.value = String(getSettings()[key]); };
    syncs.push(sync); sync();
    return el;
  }
  const id = (n) => `set-${n}-${++uid}`;
  const [idLang, idTheme, idBuf, idCity] = [id('lang'), id('theme'), id('buffer'), id('city')];

  // ---------- language (always visible, first) ----------
  // Each language in its own name, so the labels never change when the language does (as iOS, Google Maps); "auto" is
  // the same icon as the menu's auto theme. The view is rebuilt on a language change, after the lens has landed.
  const langRow = pickRow(idLang, [['auto', icon('layers'), t('Αυτόματα')], ['el', 'Ελληνικά'], ['en', 'English']], (v) => {
    langRow.paint(v);
    setTimeout(() => setLang(v), GLIDE_MS);
  });
  langRow.paint(getSettings().lang || 'auto');
  const langSeg = langRow.bar;
  langSeg.dataset.langSeg = '';
  // City: once the lens has landed, the app switches to that city live (TEL-347: data, map and the saved items are per
  // city) and this screen is mounted again on it.
  const cityRow = pickRow(idCity, Object.values(CITIES).map((c) => [c.id, cityName(c, lang())]), (v) => {
    if (v === cityId()) return;
    cityRow.paint(v);
    setTimeout(() => ctx.switchCity?.(v, '#/settings'), GLIDE_MS);
  });
  cityRow.paint(cityId());
  const citySeg = cityRow.bar;
  const language = h('section', { class: 'set-lang' },
    row(idCity, t('Πόλη'), t('Αλλάζουν οι στάσεις, οι γραμμές και τα δεδομένα. Κάθε πόλη έχει τα δικά της αγαπημένα, μέρη και υπενθυμίσεις.'), citySeg),
    row(idLang, t('Γλώσσα'), null, langSeg));

  // ---------- display & walking ----------
  const mins = (n) => (n === 0 ? t('Καθόλου') : tn(n, '{n} λεπτό', '{n} λεπτά'));
  const display = sec('display', t('Εμφάνιση και περπάτημα'),
    // the ☰ menu's theme row, the same icons (js/app.js THEMES)
    row(idTheme, t('Θέμα'), null, segmented('theme', idTheme, [['auto', icon('layers'), t('Αυτόματο')], ['light', icon('sun'), t('Φωτεινό')], ['dark', icon('moon'), t('Σκοτεινό')]])),
    row(idBuf, t('Περιθώριο στη στάση'), t('Πόσο νωρίτερα θέλεις να φτάνεις στη στάση.'), select('bufferMin', idBuf, [0, 1, 2, 3, 5, 7, 10].map((n) => [n, mins(n)]))));

  // ---------- home & work (module from places.js) ----------
  const places = extSlot(() => import('./places.js'), 'mountPlacesSettings');
  const homeSec = sec('home', t('Σπίτι & δουλειά'), places);
  // Hidden while both modules render nothing (they may render asynchronously).
  const paintHome = () => { // assign only on change: a no-op write would re-trigger the observer
    const hide = !slots.slice(0, 1).some((el) => !el.hidden && el.childElementCount > 0);
    if (homeSec.hidden !== hide) homeSec.hidden = hide;
  };
  const mo = typeof MutationObserver === 'function' ? new MutationObserver(paintHome) : null;
  mo?.observe(homeSec, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
  paintHome();

  // ---------- favourites (hidden while empty) ----------
  const favList = h('ul', { class: 'set-list' });
  const favorites = sec('favorites', t('Αγαπημένες στάσεις'), favList);
  function paintFavs(focus) {
    const favs = getFavorites();
    favorites.hidden = !favs.length;
    const btn = (code, act, label, ic, disabled) => h('button', { type: 'button', class: 'btn round strong', 'data-code': code, 'data-act': act, 'aria-label': label, disabled,
      onclick: () => {
        if (act === 'remove') { removeFavorite(code); paintFavs({ code, act: 'next' }); }
        else { moveFavorite(code, act === 'up' ? -1 : 1); paintFavs({ code, act }); }
      } }, icon(ic));
    favList.replaceChildren(...favs.map((code, i) => {
      const s = ctx.data.stopByCode.get(code);
      const name = s?.displayName || t('Στάση {code}', { code });
      return h('li', { class: 'set-item' },
        h('a', { class: 'set-item-main set-fav-link', href: cityHash(`#/stop/${encodeURIComponent(code)}`) }, h('div', { class: 'set-label' }, name), s ? null : h('div', { class: 'ex-sub' }, t('δεν βρέθηκε στα τρέχοντα δεδομένα'))),
        btn(code, 'up', t('Μετακίνηση πάνω: {name}', { name }), 'chevron-up', i === 0),
        btn(code, 'down', t('Μετακίνηση κάτω: {name}', { name }), 'chevron-down', i === favs.length - 1),
        btn(code, 'remove', t('Αφαίρεση από τα αγαπημένα: {name}', { name }), 'trash'));
    }));
    if (focus) { // keep keyboard focus where the user was
      const q = (c, a) => favList.querySelector(`[data-code="${CSS.escape(c)}"][data-act="${a}"]:not([disabled])`);
      const next = focus.act === 'next' ? favList.querySelector('button:not([disabled])') : null;
      (q(focus.code, focus.act) || q(focus.code, focus.act === 'up' ? 'down' : 'up') || next)?.focus();
    }
  }

  // ---------- data ----------
  const freshness = h('p', { class: 'ex-sub' });
  const d = ctx.data;
  const fillFreshness = (generatedAt) => {
    freshness.textContent = t('{stops} στάσεις · {lines} γραμμές', { stops: d.stops.length, lines: d.lines.length })
      + (generatedAt ? ` · ${t('ενημερώθηκε {date}', { date: dateFmt.format(new Date(generatedAt)) })}` : '');
  };
  const known = d.generatedAt ?? d.routesGeneratedAt ?? d.meta?.generatedAt;
  fillFreshness(known);
  if (!known && d.routes.length) { // routes.json carries its own build date; read it once, only here
    fetch(dataDir() + 'routes.json').then((r) => (r.ok ? r.json() : null)).then((j) => { if (!dead && j?.generatedAt) fillFreshness(j.generatedAt); }).catch(() => {});
  }
  const clearRecentsBtn = h('button', { type: 'button', class: 'btn rect sm', onclick: () => { clearRecents(); say(t('Τα πρόσφατα καθαρίστηκαν')); } }, t('Καθαρισμός πρόσφατων αναζητήσεων'));
  let armed = null;
  const wipeBtn = h('button', { type: 'button', class: 'btn rect sm destructive', onclick: () => {
    if (!armed) {
      wipeBtn.textContent = t('Σίγουρα; Πάτα ξανά για διαγραφή');
      armed = after(() => { armed = null; wipeBtn.textContent = t('Διαγραφή όλων των δεδομένων'); }, 5000);
      return;
    }
    clearTimeout(armed); timers.delete(armed); armed = null;
    clearAll(); cancelAllReminders(); applyTheme('auto');
    wipeBtn.textContent = t('Διαγραφή όλων των δεδομένων');
    say(t('Τα δεδομένα της εφαρμογής διαγράφηκαν από αυτή τη συσκευή'));
  } }, t('Διαγραφή όλων των δεδομένων'));
  // Anonymous daily counts (CLAUDE.md rule 4, js/usage.js): the switch the rule promises.
  const idUsage = id('usage');
  const usageRow = row(idUsage, t('Ανώνυμα στατιστικά χρήσης'),
    t('Μία φορά την ημέρα στέλνεται μόνο ότι άνοιξε η εφαρμογή και σε ποια πόλη. Χωρίς id, τοποθεσία ή στοιχεία σου.'),
    segmented('usageStats', idUsage, [[true, t('Ναι')], [false, t('Όχι')]]));
  const data = sec('data', t('Δεδομένα'), freshness, usageRow,
    h('div', { class: 'set-line' }, h('div', { class: 'set-actions' }, clearRecentsBtn, wipeBtn),
      ...info(t('Η διαγραφή αφορά αγαπημένα, πρόσφατα, ρυθμίσεις και υπενθυμίσεις αυτής της συσκευής.'))));

  // ---------- about (full LIVE / ΠΡΟΓΡ. legend lives here) ----------
  const about = sec('about', t('Σχετικά'),
    h('p', { class: 'set-p' }, h('strong', {}, APP_NAME), ` · ${cityName(city(), lang())} · ${t('έκδοση {v}', { v: APP_VERSION })}`),
    h('div', { class: 'set-def' },
      h('span', { class: 'ex-chip ex-chip-live' }, h('span', { class: 'ex-chip-dot', 'aria-hidden': 'true' }), t('LIVE')),
      h('p', { class: 'set-p' }, t('Το λεωφορείο στέλνει τη θέση του και τη βλέπεις στον χάρτη. Ο χρόνος άφιξης είναι εκτίμηση με βάση τη θέση του.'))),
    h('div', { class: 'set-def' },
      h('span', { class: 'ex-chip ex-chip-sched' }, t('ΠΡΟΓΡ.')),
      h('p', { class: 'set-p' }, t('Δεν υπάρχει θέση οχήματος. Πρόκειται για την προγραμματισμένη ώρα, και το λεωφορείο μπορεί να καθυστερήσει ή να μην έρθει.'))),
    h('p', { class: 'ex-note', role: 'note' }, t('Ανεπίσημη εφαρμογή· δεν σχετίζεται με τον φορέα που εκτελεί τα δρομολόγια. Τα δεδομένα προέρχονται από το {host} και μπορεί να έχουν λάθη ή καθυστερήσεις. Μην βασίζεσαι σε αυτά για κρίσιμες μετακινήσεις.', { host: dataSource()[0] })),
    h('p', { class: 'set-p' }, t('Η τοποθεσία σου μένει στη συσκευή. Όταν ζητάς διαδρομή ή ψάχνεις τόπο, στέλνονται στις υπηρεσίες χαρτών (OSRM, Photon) μόνο οι συντεταγμένες και το κείμενο που χρειάζονται. Δεν υπάρχουν λογαριασμοί. Μετράμε μόνο ανώνυμα πόσες συσκευές ανοίγουν την εφαρμογή κάθε μέρα (κλείνει από τα Δεδομένα).')),
    h('h3', { class: 'set-sub' }, t('Πηγές και άδειες')),
    h('ul', { class: 'set-list' }, [...LINKS, dataSource()].map(([name, href, what]) => h('li', { class: 'set-item' },
      h('a', { class: 'set-link', href, target: '_blank', rel: 'noopener noreferrer' }, name), h('span', { class: 'ex-sub' }, t(what))))));

  // header (TEL-251, UI-PROTOCOL U2–U5): the kit's .card-head (css/ui-kit.css), placed in css/extras.css (set-head), as
  // the report's (js/report-view.js): an empty slot · the title, 17 px, centred · ✕. Halfway from mid to up it moves to
  // its own row, 24 px, in a short blur (U4, U10); towards up it grows as a transform (U8).
  const title = h('h1', { class: 'set-title card-title' }, t('Ρυθμίσεις'));
  const closeLabel = t('Κλείσιμο');
  const closeBtn = h('button', { type: 'button', class: 'btn round g-circle', 'aria-label': closeLabel, title: closeLabel, onclick: () => ctx.navigate('#/') }, icon('close'));
  // low ends under this row (js/sheet.js)
  const head = h('header', { class: 'set-head card-head', 'data-peek-end': '' }, h('span', { 'aria-hidden': 'true' }), title, closeBtn);
  container.replaceChildren(h('div', { class: 'ex-view sheet-inset' }, head, language, display, homeSec, favorites, data, about));

  const sheetEl = document.getElementById('sheet');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const setUp = (on) => {
    if (head.classList.contains('is-up') === on) return;
    head.classList.toggle('is-up', on);
    if (!reduceMotion.matches) title.animate([{ filter: 'blur(3px)' }, { filter: 'blur(0)' }], { duration: 180, easing: 'ease-out' });
  };
  // as js/report-view.js: up while the sheet is full or dragged past halfway from mid to up; nothing runs per frame
  const upRow = () => !!sheetEl && (sheetEl.dataset.state === 'full' || sheetEl.classList.contains('dragging'))
    && (parseFloat(sheetEl.style.getPropertyValue('--sheet-t')) || 0) > 1.5;
  const onUpper = () => setUp(upRow());
  const onLeaveUp = () => setUp(false);
  const sheetMo = new MutationObserver(onUpper);
  if (sheetEl) {
    sheetMo.observe(sheetEl, { attributes: true, attributeFilter: ['class', 'data-state'] });
    sheetEl.addEventListener('sheet:upper', onUpper);
    sheetEl.addEventListener('sheet:leave-full', onLeaveUp);
  }
  setUp(upRow());

  paintFavs();
  offs.push(onChange(() => { if (dead) return; for (const s of syncs) s(); paintFavs(); }));

  return {
    teardown() {
      dead = true;
      for (const off of offs) off();
      mo?.disconnect();
      for (const v of ext) { try { v.destroy && v.destroy(); } catch (err) { console.warn('[settings] card destroy failed', err); } }
      for (const id of timers) clearTimeout(id);
      sheetMo.disconnect();
      sheetEl?.removeEventListener('sheet:upper', onUpper);
      sheetEl?.removeEventListener('sheet:leave-full', onLeaveUp);
    },
  };
}
