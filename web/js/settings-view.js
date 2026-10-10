// Settings + about (owner: extras). Styles in css/extras.css.
import { h, icon, fmtClock } from './ui.js';
import { getSettings, setSetting, getFavorites, removeFavorite, moveFavorite, clearRecents, clearAll, onChange, applyTheme } from './store.js';
import { ensurePermission, permissionState, listReminders, cancelReminder, cancelAll as cancelAllReminders, scheduleReminder, onRemindersChange } from './notify.js';

export const VERSION = '2.0.0';

// Chrome/Edge fire this once, early. Kept so the "install" button below can use it (best effort:
// when this module loads after the event, the browser's own install UI is used instead).
let installPrompt = null;
try {
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; });
  window.addEventListener('appinstalled', () => { installPrompt = null; });
} catch { /* not in a browser */ }

const dateFmt = new Intl.DateTimeFormat('el-GR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Athens' });
const isStandalone = () => { try { return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; } catch { return false; } };
let uid = 0;

const LINKS = [
  ['© OpenStreetMap contributors', 'https://www.openstreetmap.org/copyright', 'δεδομένα χάρτη'],
  ['OpenFreeMap', 'https://openfreemap.org', 'πλακίδια χάρτη'],
  ['MapLibre GL JS', 'https://maplibre.org', 'απεικόνιση χάρτη'],
  ['OSRM / FOSSGIS routing', 'https://routing.openstreetmap.de', 'διαδρομές περπατήματος'],
  ['Photon by komoot', 'https://photon.komoot.io', 'αναζήτηση τόπων'],
  ['patra.citybus.gr', 'https://patra.citybus.gr', 'στάσεις, γραμμές και αφίξεις'],
];

export function mountSettings(container, ctx) {
  const offs = [];
  const timers = new Set();
  let dead = false;
  const after = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); return t; };
  const say = (text) => { try { ctx.toast(text); } catch { /* ignore */ } };
  const card = (title, ...kids) => h('section', { class: 'set-card' }, h('h2', { class: 'set-title' }, title), ...kids);
  const row = (id, label, hint, control) => h('div', { class: 'set-row' },
    h('div', { class: 'set-row-text' }, h('div', { class: 'set-label', id }, label), hint ? h('div', { class: 'ex-sub' }, hint) : null), control);

  // ---------- controls bound to a setting ----------
  const syncs = [];
  function segmented(key, labelId, options) {
    const btns = options.map(([value, text]) => h('button', { type: 'button', class: 'ex-seg-btn', 'data-v': String(value), onclick: () => {
      setSetting(key, value);
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
  const [idTheme, idWalk, idBuf, idRem] = [id('theme'), id('walk'), id('buffer'), id('reminder')];

  const mins = (n) => (n === 0 ? 'Καθόλου' : `${n} λεπτ${n === 1 ? 'ό' : 'ά'}`);
  const display = card('Εμφάνιση',
    row(idTheme, 'Θέμα', null, segmented('theme', idTheme, [['auto', 'Αυτόματο'], ['light', 'Φωτεινό'], ['dark', 'Σκοτεινό']])));

  const timing = card('Περπάτημα και χρόνοι',
    row(idWalk, 'Ταχύτητα περπατήματος', 'Για να υπολογίζω πότε πρέπει να φύγεις.', segmented('walkSpeed', idWalk, [['slow', 'Αργά'], ['normal', 'Κανονικά'], ['fast', 'Γρήγορα']])),
    row(idBuf, 'Περιθώριο στη στάση', 'Πόσο νωρίτερα θέλεις να φτάνεις στη στάση.', select('bufferMin', idBuf, [0, 1, 2, 3, 5, 7, 10].map((n) => [n, mins(n)]))),
    row(idRem, 'Υπενθύμιση πριν την αναχώρηση', 'Πόσο νωρίτερα να σε ειδοποιώ πριν χρειαστεί να φύγεις.', select('reminderMin', idRem, [1, 2, 3, 5, 10].map((n) => [n, mins(n)]))));

  // ---------- notifications ----------
  const permText = h('p', { class: 'set-p' });
  const permBtn = h('button', { type: 'button', class: 'ex-btn', onclick: async () => {
    const ok = await ensurePermission();
    if (dead) return;
    paintPerm();
    say(ok ? 'Οι ειδοποιήσεις ενεργοποιήθηκαν' : 'Οι ειδοποιήσεις δεν ενεργοποιήθηκαν');
  } }, icon('bell'), 'Ενεργοποίηση ειδοποιήσεων');
  const testBtn = h('button', { type: 'button', class: 'ex-btn', onclick: () => {
    scheduleReminder({ at: Date.now() + 5000, title: 'Δοκιμαστική υπενθύμιση', body: 'Έτσι θα σε ειδοποιώ πριν χρειαστεί να φύγεις.', tag: 'settings-test' });
    say('Η δοκιμή θα εμφανιστεί σε 5 δευτερόλεπτα');
  } }, 'Δοκιμή υπενθύμισης');
  const remList = h('ul', { class: 'set-list' });
  const PERM = {
    granted: 'Οι ειδοποιήσεις συστήματος είναι ενεργές.',
    denied: 'Οι ειδοποιήσεις είναι αποκλεισμένες από τον περιηγητή. Μπορείς να τις επιτρέψεις από τα δικαιώματα του ιστότοπου. Οι υπενθυμίσεις θα εμφανίζονται πάντως μέσα στην εφαρμογή.',
    default: 'Οι ειδοποιήσεις συστήματος δεν έχουν ενεργοποιηθεί. Οι υπενθυμίσεις θα εμφανίζονται μέσα στην εφαρμογή.',
    unsupported: 'Αυτή η συσκευή ή ο περιηγητής δεν υποστηρίζει ειδοποιήσεις συστήματος. Οι υπενθυμίσεις θα εμφανίζονται μέσα στην εφαρμογή.',
  };
  function paintPerm() {
    const p = permissionState();
    permText.textContent = PERM[p] || PERM.unsupported;
    permBtn.hidden = p !== 'default';
  }
  function paintReminders() {
    const items = listReminders();
    remList.hidden = !items.length;
    remList.replaceChildren(...items.map((r) => h('li', { class: 'set-item' },
      h('div', { class: 'set-item-main' }, h('div', { class: 'set-label' }, r.title || 'Υπενθύμιση'), h('div', { class: 'ex-sub' }, `στις ${fmtClock(r.at)}${r.body ? ` · ${r.body}` : ''}`)),
      h('button', { type: 'button', class: 'ex-icon-btn', 'aria-label': `Ακύρωση υπενθύμισης: ${r.title || r.tag}`, onclick: () => cancelReminder(r.tag) }, icon('close')))));
  }
  const notifications = card('Ειδοποιήσεις και υπενθυμίσεις', permText,
    h('div', { class: 'set-actions' }, permBtn, testBtn), remList,
    h('p', { class: 'ex-note', role: 'note' }, 'Οι υπενθυμίσεις λειτουργούν μόνο όσο η εφαρμογή είναι ανοιχτή (ακόμη και στο παρασκήνιο). Αν την κλείσεις εντελώς ή το τηλέφωνο την σταματήσει, δεν θα χτυπήσουν.'));

  // ---------- favourites ----------
  const favList = h('ul', { class: 'set-list' });
  const favEmpty = h('p', { class: 'ex-sub' }, 'Δεν έχεις αγαπημένες στάσεις. Πάτα το αστέρι σε μια στάση για να τη βρεις γρήγορα στην αρχική.');
  function paintFavs(focus) {
    const favs = getFavorites();
    favEmpty.hidden = favs.length > 0;
    favList.hidden = !favs.length;
    const btn = (code, act, label, ic, disabled) => h('button', { type: 'button', class: 'ex-icon-btn', 'data-code': code, 'data-act': act, 'aria-label': label, disabled,
      onclick: () => {
        if (act === 'remove') { removeFavorite(code); paintFavs({ code, act: 'next' }); }
        else { moveFavorite(code, act === 'up' ? -1 : 1); paintFavs({ code, act }); }
      } }, icon(ic));
    favList.replaceChildren(...favs.map((code, i) => {
      const s = ctx.data.stopByCode.get(code);
      const name = s?.displayName || `Στάση ${code}`;
      return h('li', { class: 'set-item' },
        h('a', { class: 'set-item-main set-fav-link', href: `#/stop/${encodeURIComponent(code)}` }, h('div', { class: 'set-label' }, name), h('div', { class: 'ex-sub' }, s ? `#${code}` : `#${code} · δεν βρέθηκε στα τρέχοντα δεδομένα`)),
        btn(code, 'up', `Μετακίνηση πάνω: ${name}`, 'chevron-up', i === 0),
        btn(code, 'down', `Μετακίνηση κάτω: ${name}`, 'chevron-down', i === favs.length - 1),
        btn(code, 'remove', `Αφαίρεση από τα αγαπημένα: ${name}`, 'trash'));
    }));
    if (focus) { // keep keyboard focus where the user was
      const q = (c, a) => favList.querySelector(`[data-code="${CSS.escape(c)}"][data-act="${a}"]:not([disabled])`);
      const next = focus.act === 'next' ? favList.querySelector('button:not([disabled])') : null;
      (q(focus.code, focus.act) || q(focus.code, focus.act === 'up' ? 'down' : 'up') || next)?.focus();
    }
  }
  const favorites = card('Αγαπημένες στάσεις', favEmpty, favList);

  // ---------- data ----------
  const freshness = h('p', { class: 'ex-sub' });
  const d = ctx.data;
  const nOrdered = d.routes.length;
  const fillFreshness = (generatedAt) => {
    freshness.textContent = `${d.stops.length} στάσεις · ${d.lines.length} γραμμές · `
      + (nOrdered ? `${nOrdered} διαδρομές με σειρά στάσεων` : 'δεν υπάρχουν δεδομένα σειράς στάσεων')
      + (generatedAt ? ` · διαδρομές ενημερώθηκαν ${dateFmt.format(new Date(generatedAt))}` : '');
  };
  const known = d.generatedAt ?? d.routesGeneratedAt ?? d.meta?.generatedAt;
  fillFreshness(known);
  if (!known && nOrdered) { // routes.json carries its own build date; read it once, only here
    fetch('./data/routes.json').then((r) => (r.ok ? r.json() : null)).then((j) => { if (!dead && j?.generatedAt) fillFreshness(j.generatedAt); }).catch(() => {});
  }
  const clearRecentsBtn = h('button', { type: 'button', class: 'ex-btn', onclick: () => { clearRecents(); say('Τα πρόσφατα καθαρίστηκαν'); } }, 'Καθαρισμός πρόσφατων αναζητήσεων');
  let armed = null;
  const wipeBtn = h('button', { type: 'button', class: 'ex-btn ex-btn-danger', onclick: () => {
    if (!armed) {
      wipeBtn.textContent = 'Σίγουρα; Πάτα ξανά για διαγραφή';
      armed = after(() => { armed = null; wipeBtn.textContent = 'Διαγραφή όλων των δεδομένων'; }, 5000);
      return;
    }
    clearTimeout(armed); timers.delete(armed); armed = null;
    clearAll(); cancelAllReminders(); applyTheme('auto');
    wipeBtn.textContent = 'Διαγραφή όλων των δεδομένων';
    say('Τα δεδομένα της εφαρμογής διαγράφηκαν από αυτή τη συσκευή');
  } }, 'Διαγραφή όλων των δεδομένων');
  const data = card('Δεδομένα', freshness,
    h('div', { class: 'set-actions' }, clearRecentsBtn, wipeBtn),
    h('p', { class: 'ex-sub' }, 'Η διαγραφή αφορά αγαπημένα, πρόσφατα, ρυθμίσεις και υπενθυμίσεις αυτής της συσκευής.'));

  // ---------- install ----------
  const installNote = h('p', { class: 'set-p' });
  const installBtn = h('button', { type: 'button', class: 'ex-btn', onclick: async () => {
    const p = installPrompt; if (!p) return;
    installPrompt = null; paintInstall();
    try { await p.prompt(); await p.userChoice; } catch { /* dismissed */ }
  } }, 'Εγκατάσταση στη συσκευή');
  function paintInstall() {
    installBtn.hidden = !installPrompt;
    installNote.textContent = isStandalone() ? 'Η εφαρμογή είναι εγκατεστημένη σε αυτή τη συσκευή.'
      : installPrompt ? 'Βάλε την εφαρμογή στην αρχική οθόνη για πιο γρήγορη πρόσβαση και λειτουργία χωρίς σύνδεση.'
        : 'Για πιο γρήγορη πρόσβαση, πρόσθεσέ την στην αρχική οθόνη από το μενού του περιηγητή («Προσθήκη στην αρχική οθόνη» ή «Εγκατάσταση»).';
  }
  paintInstall();
  const install = card('Εγκατάσταση', installNote, h('div', { class: 'set-actions' }, installBtn));

  // ---------- about ----------
  const about = card('Σχετικά',
    h('p', { class: 'set-p' }, h('strong', {}, 'Λεωφορεία Πάτρας'), ` · έκδοση ${VERSION}`),
    h('div', { class: 'set-def' },
      h('span', { class: 'ex-chip ex-chip-live' }, h('span', { class: 'ex-chip-dot', 'aria-hidden': 'true' }), 'LIVE'),
      h('p', { class: 'set-p' }, 'Το λεωφορείο στέλνει τη θέση του και τη βλέπεις στον χάρτη. Ο χρόνος άφιξης είναι εκτίμηση με βάση τη θέση του.')),
    h('div', { class: 'set-def' },
      h('span', { class: 'ex-chip ex-chip-sched' }, 'ΠΡΟΓΡ.'),
      h('p', { class: 'set-p' }, 'Δεν υπάρχει θέση οχήματος. Πρόκειται για την προγραμματισμένη ώρα, και το λεωφορείο μπορεί να καθυστερήσει ή να μην έρθει.')),
    h('p', { class: 'ex-note', role: 'note' }, 'Ανεπίσημη εφαρμογή· δεν σχετίζεται με τον φορέα που εκτελεί τα δρομολόγια. Τα δεδομένα προέρχονται από το patra.citybus.gr και μπορεί να έχουν λάθη ή καθυστερήσεις. Μην βασίζεσαι σε αυτά για κρίσιμες μετακινήσεις.'),
    h('p', { class: 'set-p' }, 'Η τοποθεσία σου μένει στη συσκευή. Όταν ζητάς διαδρομή ή ψάχνεις τόπο, στέλνονται στις υπηρεσίες χαρτών (OSRM, Photon) μόνο οι συντεταγμένες και το κείμενο που χρειάζονται. Δεν υπάρχουν λογαριασμοί ούτε αναλυτικά στοιχεία χρήσης.'),
    h('h3', { class: 'set-sub' }, 'Πηγές και άδειες'),
    h('ul', { class: 'set-list' }, LINKS.map(([name, href, what]) => h('li', { class: 'set-item' },
      h('a', { class: 'set-link', href, target: '_blank', rel: 'noopener noreferrer' }, name), h('span', { class: 'ex-sub' }, what)))));

  container.replaceChildren(h('div', { class: 'ex-view' },
    h('header', { class: 'ex-head' },
      h('button', { type: 'button', class: 'ex-icon-btn', 'aria-label': 'Πίσω', onclick: () => ctx.navigate('#/') }, icon('back')),
      h('h1', {}, 'Ρυθμίσεις')),
    display, timing, notifications, favorites, data, install, about));

  paintPerm(); paintReminders(); paintFavs();
  offs.push(onChange(() => { for (const s of syncs) s(); paintFavs(); }));
  offs.push(onRemindersChange(paintReminders));
  const onVis = () => { if (!document.hidden) { paintPerm(); paintInstall(); } }; // permission may change in browser settings
  document.addEventListener('visibilitychange', onVis);

  return {
    destroy() {
      dead = true;
      for (const off of offs) off();
      for (const t of timers) clearTimeout(t);
      document.removeEventListener('visibilitychange', onVis);
    },
  };
}
