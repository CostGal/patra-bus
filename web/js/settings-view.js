// Settings + about (owner: extras / i18n). Collapsible sections, short labels, explanations behind (i). Styles in css/extras.css.
import { h, icon, fmtClock } from './ui.js';
import { getSettings, setSetting, getFavorites, removeFavorite, moveFavorite, clearRecents, clearAll, onChange, applyTheme } from './store.js';
import { ensurePermission, permissionState, listReminders, cancelReminder, cancelAll as cancelAllReminders, scheduleReminder, onRemindersChange } from './notify.js';
import { t, tn, N_, setLang, onLangChange, locale } from './i18n.js';

export const VERSION = '2.0.0';

// Chrome/Edge fire this once, early. Kept so the "install" button below can use it (best effort:
// when this module loads after the event, the browser's own install UI is used instead).
let installPrompt = null;
try {
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; });
  window.addEventListener('appinstalled', () => { installPrompt = null; });
} catch { /* not in a browser */ }

const isStandalone = () => { try { return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; } catch { return false; } };
let uid = 0;

const LINKS = [
  ['© OpenStreetMap contributors', 'https://www.openstreetmap.org/copyright', N_('δεδομένα χάρτη')],
  ['OpenFreeMap', 'https://openfreemap.org', N_('πλακίδια χάρτη')],
  ['MapLibre GL JS', 'https://maplibre.org', N_('απεικόνιση χάρτη')],
  ['OSRM / FOSSGIS routing', 'https://routing.openstreetmap.de', N_('διαδρομές περπατήματος')],
  ['Photon by komoot', 'https://photon.komoot.io', N_('αναζήτηση τόπων')],
  ['patra.citybus.gr', 'https://patra.citybus.gr', N_('στάσεις, γραμμές και αφίξεις')],
];

// Open sections survive a re-mount that follows within 1.5 s (the app re-routes on a language change), nothing longer.
let openKeys = new Set();
let leftAt = 0;

// The whole view is rebuilt on a language change (open sections and the focused language button are kept).
export function mountSettings(container, ctx) {
  let view = null;
  let gone = false;
  if (Date.now() - leftAt > 1500) openKeys = new Set();
  const render = () => {
    if (gone) return; // the app may already have re-mounted this view
    const keep = { lang: null };
    const a = document.activeElement;
    if (a && container.contains(a) && a.closest('[data-lang-seg]')) keep.lang = a.dataset.v;
    view?.teardown();
    view = build(container, ctx, keep);
    if (keep.lang) container.querySelector(`[data-lang-seg] [data-v="${keep.lang}"]`)?.focus();
  };
  render();
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
      h('summary', { class: 'set-sum' }, h('span', { class: 'set-sum-title' }, title), icon('chevron-down')),
      h('div', { class: 'set-body' }, ...kids));
    d.open = openKeys.has(key);
    return d;
  };
  // (i) button + the explanation it reveals.
  const info = (text) => {
    const p = h('p', { class: 'ex-sub set-hint', hidden: true }, text);
    const b = h('button', { type: 'button', class: 'ex-info', 'aria-label': t('Περισσότερα'), 'aria-expanded': 'false', onclick: () => {
      const on = p.hidden; p.hidden = !on; b.setAttribute('aria-expanded', String(on));
    } }, icon('info'));
    return [b, p];
  };
  // Cards owned by other modules (push, offline map, places, routines): loaded lazily and guarded, so a failing one never breaks settings.
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
  function segmented(key, labelId, options, apply) {
    const btns = options.map(([value, text]) => h('button', { type: 'button', class: 'ex-seg-btn', 'data-v': String(value), onclick: () => {
      if (apply) apply(value); else setSetting(key, value);
      if (key === 'theme') applyTheme(value);
    } }, text));
    const sync = () => { const cur = String(getSettings()[key]); for (const b of btns) b.setAttribute('aria-pressed', String(b.dataset.v === cur)); };
    syncs.push(sync); sync();
    return h('div', { class: 'ex-seg', role: 'group', 'aria-labelledby': labelId }, ...btns);
  }
  function select(key, labelId, options) {
    const el = h('select', { class: 'ex-select', 'aria-labelledby': labelId, onchange: () => setSetting(key, Number(el.value)) },
      ...options.map(([value, text]) => h('option', { value: String(value) }, text)));
    const sync = () => { el.value = String(getSettings()[key]); };
    syncs.push(sync); sync();
    return el;
  }
  const id = (n) => `set-${n}-${++uid}`;
  const [idLang, idTheme, idWalk, idBuf, idRem] = [id('lang'), id('theme'), id('walk'), id('buffer'), id('reminder')];

  // ---------- language (always visible, first) ----------
  const langSeg = segmented('lang', idLang, [['auto', t('Αυτόματα')], ['el', 'Ελληνικά'], ['en', 'English']], setLang);
  langSeg.dataset.langSeg = '';
  const language = h('section', { class: 'set-lang' }, row(idLang, t('Γλώσσα'), null, langSeg));

  // ---------- display & walking ----------
  const mins = (n) => (n === 0 ? t('Καθόλου') : tn(n, '{n} λεπτό', '{n} λεπτά'));
  const display = sec('display', t('Εμφάνιση και περπάτημα'),
    row(idTheme, t('Θέμα'), null, segmented('theme', idTheme, [['auto', t('Αυτόματο')], ['light', t('Φωτεινό')], ['dark', t('Σκοτεινό')]])),
    row(idWalk, t('Ταχύτητα περπατήματος'), t('Για να υπολογίζω πότε πρέπει να φύγεις.'), segmented('walkSpeed', idWalk, [['slow', t('Αργά')], ['normal', t('Κανονικά')], ['fast', t('Γρήγορα')]])),
    row(idBuf, t('Περιθώριο στη στάση'), t('Πόσο νωρίτερα θέλεις να φτάνεις στη στάση.'), select('bufferMin', idBuf, [0, 1, 2, 3, 5, 7, 10].map((n) => [n, mins(n)]))),
    row(idRem, t('Υπενθύμιση πριν φύγεις'), t('Πόσο νωρίτερα να σε ειδοποιώ πριν χρειαστεί να φύγεις.'), select('reminderMin', idRem, [1, 2, 3, 5, 10].map((n) => [n, mins(n)]))));

  // ---------- home, work & routines (modules from places.js / routines.js) ----------
  const places = extSlot(() => import('./places.js'), 'mountPlacesSettings');
  const routines = extSlot(() => import('./routines.js'), 'mountRoutinesSettings');
  const homeSec = sec('home', t('Σπίτι, δουλειά & ρουτίνες'), places, routines);
  // Hidden while both modules render nothing (they may render asynchronously).
  const paintHome = () => { // assign only on change: a no-op write would re-trigger the observer
    const hide = !slots.slice(0, 2).some((el) => !el.hidden && el.childElementCount > 0);
    if (homeSec.hidden !== hide) homeSec.hidden = hide;
  };
  const mo = typeof MutationObserver === 'function' ? new MutationObserver(paintHome) : null;
  mo?.observe(homeSec, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
  paintHome();

  // ---------- notifications ----------
  const permText = h('p', { class: 'ex-sub' });
  const permBtn = h('button', { type: 'button', class: 'ex-btn', onclick: async () => {
    const ok = await ensurePermission();
    if (dead) return;
    paintPerm();
    say(ok ? t('Οι ειδοποιήσεις ενεργοποιήθηκαν') : t('Οι ειδοποιήσεις δεν ενεργοποιήθηκαν'));
  } }, icon('bell'), t('Ενεργοποίηση ειδοποιήσεων'));
  const testBtn = h('button', { type: 'button', class: 'ex-btn ex-btn-sm', onclick: () => {
    scheduleReminder({ at: Date.now() + 5000, title: t('Δοκιμαστική υπενθύμιση'), body: t('Έτσι θα σε ειδοποιώ πριν χρειαστεί να φύγεις.'), tag: 'settings-test' });
    say(t('Η δοκιμή θα εμφανιστεί σε 5 δευτερόλεπτα'));
  } }, t('Δοκιμή υπενθύμισης'));
  const remList = h('ul', { class: 'set-list' });
  const PERM = {
    granted: N_('Οι ειδοποιήσεις είναι ενεργές.'),
    denied: N_('Οι ειδοποιήσεις είναι αποκλεισμένες από τον περιηγητή· επίτρεψέ τες από τα δικαιώματα του ιστότοπου.'),
    default: N_('Οι ειδοποιήσεις δεν έχουν ενεργοποιηθεί.'),
    unsupported: N_('Αυτή η συσκευή δεν υποστηρίζει ειδοποιήσεις.'),
  };
  function paintPerm() {
    const p = permissionState();
    permText.textContent = t(PERM[p] || PERM.unsupported);
    permBtn.hidden = p !== 'default';
  }
  function paintReminders() {
    const items = listReminders();
    remList.hidden = !items.length;
    remList.replaceChildren(...items.map((r) => h('li', { class: 'set-item' },
      h('div', { class: 'set-item-main' }, h('div', { class: 'set-label' }, r.title || t('Υπενθύμιση')), h('div', { class: 'ex-sub' }, `${t('στις {time}', { time: fmtClock(r.at) })}${r.body ? ` · ${r.body}` : ''}`)),
      h('button', { type: 'button', class: 'ex-icon-btn', 'aria-label': t('Ακύρωση υπενθύμισης: {name}', { name: r.title || r.tag }), onclick: () => cancelReminder(r.tag) }, icon('close')))));
  }
  const push = extSlot(() => import('./push.js'), 'mountPushCard');
  const notifications = sec('notifications', t('Ειδοποιήσεις'),
    h('div', { class: 'set-line' }, permText, ...info(t('Χωρίς ειδοποιήσεις με κλειστή εφαρμογή, οι υπενθυμίσεις λειτουργούν μόνο όσο η εφαρμογή είναι ανοιχτή (ακόμη και στο παρασκήνιο). Αν την κλείσεις εντελώς ή το τηλέφωνο την σταματήσει, δεν θα χτυπήσουν.'))),
    h('div', { class: 'set-actions' }, permBtn, testBtn), remList, push);

  // ---------- favourites (hidden while empty) ----------
  const favList = h('ul', { class: 'set-list' });
  const favorites = sec('favorites', t('Αγαπημένες στάσεις'), favList);
  function paintFavs(focus) {
    const favs = getFavorites();
    favorites.hidden = !favs.length;
    const btn = (code, act, label, ic, disabled) => h('button', { type: 'button', class: 'ex-icon-btn', 'data-code': code, 'data-act': act, 'aria-label': label, disabled,
      onclick: () => {
        if (act === 'remove') { removeFavorite(code); paintFavs({ code, act: 'next' }); }
        else { moveFavorite(code, act === 'up' ? -1 : 1); paintFavs({ code, act }); }
      } }, icon(ic));
    favList.replaceChildren(...favs.map((code, i) => {
      const s = ctx.data.stopByCode.get(code);
      const name = s?.displayName || t('Στάση {code}', { code });
      return h('li', { class: 'set-item' },
        h('a', { class: 'set-item-main set-fav-link', href: `#/stop/${encodeURIComponent(code)}` }, h('div', { class: 'set-label' }, name), s ? null : h('div', { class: 'ex-sub' }, t('δεν βρέθηκε στα τρέχοντα δεδομένα'))),
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
    fetch('./data/routes.json').then((r) => (r.ok ? r.json() : null)).then((j) => { if (!dead && j?.generatedAt) fillFreshness(j.generatedAt); }).catch(() => {});
  }
  const clearRecentsBtn = h('button', { type: 'button', class: 'ex-btn ex-btn-sm', onclick: () => { clearRecents(); say(t('Τα πρόσφατα καθαρίστηκαν')); } }, t('Καθαρισμός πρόσφατων αναζητήσεων'));
  let armed = null;
  const wipeBtn = h('button', { type: 'button', class: 'ex-btn ex-btn-sm ex-btn-danger', onclick: () => {
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
  const data = sec('data', t('Δεδομένα'), freshness,
    h('div', { class: 'set-line' }, h('div', { class: 'set-actions' }, clearRecentsBtn, wipeBtn),
      ...info(t('Η διαγραφή αφορά αγαπημένα, πρόσφατα, ρυθμίσεις και υπενθυμίσεις αυτής της συσκευής.'))));

  const offline = sec('offline', t('Χάρτης χωρίς σύνδεση'), extSlot(() => import('./offline.js'), 'mountOfflineCard'));

  // ---------- install (hidden once installed) ----------
  const installNote = h('p', { class: 'ex-sub' });
  const installBtn = h('button', { type: 'button', class: 'ex-btn', onclick: async () => {
    const p = installPrompt; if (!p) return;
    installPrompt = null; paintInstall();
    try { await p.prompt(); await p.userChoice; } catch { /* dismissed */ }
  } }, t('Εγκατάσταση στη συσκευή'));
  const install = sec('install', t('Εγκατάσταση'), installNote, h('div', { class: 'set-actions' }, installBtn));
  function paintInstall() {
    install.hidden = isStandalone();
    installBtn.hidden = !installPrompt;
    installNote.hidden = !!installPrompt;
    installNote.textContent = t('Πρόσθεσέ την στην αρχική οθόνη από το μενού του περιηγητή.');
  }
  paintInstall();

  // ---------- about (full LIVE / ΠΡΟΓΡ. legend lives here) ----------
  const about = sec('about', t('Σχετικά'),
    h('p', { class: 'set-p' }, h('strong', {}, t('Λεωφορεία Πάτρας')), ` · ${t('έκδοση {v}', { v: VERSION })}`),
    h('div', { class: 'set-def' },
      h('span', { class: 'ex-chip ex-chip-live' }, h('span', { class: 'ex-chip-dot', 'aria-hidden': 'true' }), t('LIVE')),
      h('p', { class: 'set-p' }, t('Το λεωφορείο στέλνει τη θέση του και τη βλέπεις στον χάρτη. Ο χρόνος άφιξης είναι εκτίμηση με βάση τη θέση του.'))),
    h('div', { class: 'set-def' },
      h('span', { class: 'ex-chip ex-chip-sched' }, t('ΠΡΟΓΡ.')),
      h('p', { class: 'set-p' }, t('Δεν υπάρχει θέση οχήματος. Πρόκειται για την προγραμματισμένη ώρα, και το λεωφορείο μπορεί να καθυστερήσει ή να μην έρθει.'))),
    h('p', { class: 'ex-note', role: 'note' }, t('Ανεπίσημη εφαρμογή· δεν σχετίζεται με τον φορέα που εκτελεί τα δρομολόγια. Τα δεδομένα προέρχονται από το patra.citybus.gr και μπορεί να έχουν λάθη ή καθυστερήσεις. Μην βασίζεσαι σε αυτά για κρίσιμες μετακινήσεις.')),
    h('p', { class: 'set-p' }, t('Η τοποθεσία σου μένει στη συσκευή. Όταν ζητάς διαδρομή ή ψάχνεις τόπο, στέλνονται στις υπηρεσίες χαρτών (OSRM, Photon) μόνο οι συντεταγμένες και το κείμενο που χρειάζονται. Δεν υπάρχουν λογαριασμοί ούτε αναλυτικά στοιχεία χρήσης.')),
    h('h3', { class: 'set-sub' }, t('Πηγές και άδειες')),
    h('ul', { class: 'set-list' }, LINKS.map(([name, href, what]) => h('li', { class: 'set-item' },
      h('a', { class: 'set-link', href, target: '_blank', rel: 'noopener noreferrer' }, name), h('span', { class: 'ex-sub' }, t(what))))));

  container.replaceChildren(h('div', { class: 'ex-view' },
    h('header', { class: 'ex-head' },
      h('button', { type: 'button', class: 'ex-icon-btn', 'aria-label': t('Πίσω'), onclick: () => ctx.navigate('#/') }, icon('back')),
      h('h1', {}, t('Ρυθμίσεις'))),
    language, display, homeSec, notifications, favorites, data, offline, install, about));

  paintPerm(); paintReminders(); paintFavs();
  offs.push(onChange(() => { if (dead) return; for (const s of syncs) s(); paintFavs(); }));
  offs.push(onRemindersChange(paintReminders));
  const onVis = () => { if (!document.hidden) { paintPerm(); paintInstall(); } }; // permission may change in browser settings
  document.addEventListener('visibilitychange', onVis);

  return {
    teardown() {
      dead = true;
      for (const off of offs) off();
      mo?.disconnect();
      for (const v of ext) { try { v.destroy && v.destroy(); } catch (err) { console.warn('[settings] card destroy failed', err); } }
      for (const id of timers) clearTimeout(id);
      document.removeEventListener('visibilitychange', onVis);
    },
  };
}
