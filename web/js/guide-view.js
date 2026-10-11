// In-app guide (owner: guide). What the app is, how to install it, how to use it and what each control does.
// Contract in docs/GUIDE.md (Part B). Styles: css/guide.css (prefix gd-). Every sentence describes something the app really has;
// when a feature or a label changes, change it here too. The content tables are exported so tests can check them without a DOM.
import { h, icon, lineBadge, fmtClock } from './ui.js';
import { t, N_, onLangChange, lang, APP_NAME } from './i18n.js';
import { city, cityName } from './cities.js';
import { cityHash, parseHash } from './route.js';

// ---- content (Greek is the source and the i18n key; English pairs live in i18n-en-guide.js) ----

// "How to use": short, task-oriented entries. [id, icon, title, text]
export const HOW = [
  ['find', 'search', N_('Βρες μια στάση'),
    N_('Γράψε στάση, κωδικό ή τόπο στο «Πού πάμε;», ή πάτα μια στάση στον χάρτη (κάνε ζουμ για να φανούν). Με παρατεταμένο πάτημα στον χάρτη διαλέγεις ένα σημείο και βλέπεις τις στάσεις γύρω του.')],
  ['nearby', 'locate', N_('Το επόμενο λεωφορείο κοντά σου'),
    N_('Η αρχική οθόνη έχει την κάρτα «Επόμενο λεωφορείο κοντά σου». Με τη θέση σου, ή με ένα σημείο που ορίζεις στον χάρτη, δείχνει πότε να φύγεις για να το προλάβεις.')],
  ['arrivals', 'clock', N_('Διάβασε τις αφίξεις'),
    N_('Κάθε κάρτα έχει γραμμή, προορισμό και τα λεπτά που απομένουν, και ανανεώνεται μόνη της. Πάτα μια LIVE κάρτα για να δεις πού είναι το λεωφορείο, ή μια ΠΡΟΓΡ. για να δεις τη γραμμή.')],
  ['plan', 'route', N_('Σχεδίασε μια διαδρομή'),
    N_('Διάλεξε «Διαδρομή» από το μενού ή την αναζήτηση και βάλε προορισμό. Βρίσκει λεωφορείο, απευθείας ή με μία αλλαγή, και γράφει «Φύγε σε 5′»: πότε να ξεκινήσεις, με το περπάτημα ως τη στάση και το περιθώριο που έχεις ορίσει.')],
  ['lines', 'bus', N_('Γραμμές και διαδρομές'),
    N_('Στο μενού → Γραμμές βρίσκεις όλες τις γραμμές. Άνοιξε μία για να δεις τη διαδρομή και τις στάσεις της. Η σειρά των στάσεων συμπεραίνεται και μπορεί να έχει λάθη.')],
  ['favorites', 'star', N_('Αγαπημένες στάσεις'),
    N_('Πάτα το αστέρι σε μια στάση. Θα τη βρίσκεις στην αρχική οθόνη και στο μενού, και με το ⋯ → Κοινοποίηση στέλνεις τον σύνδεσμό της.')],
  ['places', 'home', N_('Σπίτι, δουλειά και ρουτίνες'),
    N_('Στις Ρυθμίσεις → «Σπίτι, δουλειά & ρουτίνες» ορίζεις τα μέρη σου. Εμφανίζονται ως συντομεύσεις κάτω από την αναζήτηση, και μπορείς να βάλεις υπενθύμιση για τις μέρες και την ώρα που φεύγεις.')],
  ['reminders', 'bell', N_('Υπενθυμίσεις'),
    N_('Σε μια διαδρομή πάτα «Υπενθύμισέ μου» και θα σε ειδοποιήσει πριν χρειαστεί να φύγεις. Με κλειστή εφαρμογή δουλεύει αν ενεργοποιήσεις τις ειδοποιήσεις στις Ρυθμίσεις· στο iPhone χρειάζεται εγκατεστημένη εφαρμογή.')],
  ['onboard', 'bell', N_('Ειδοποίηση πριν κατέβεις'),
    N_('Όταν μπεις στο λεωφορείο, πάτα «Είμαι στο λεωφορείο» ή «Θα κατέβω σε…» και διάλεξε στάση. Θα σε ειδοποιήσει λίγο πριν φτάσεις.')],
  ['offline', 'pin', N_('Χάρτης χωρίς σύνδεση'),
    N_('Στις Ρυθμίσεις μπορείς να κατεβάσεις τον χάρτη της πόλης, καλύτερα με Wi-Fi, για να τον βλέπεις χωρίς ίντερνετ. Οι ζωντανές αφίξεις χρειάζονται πάντα σύνδεση.')],
  ['city', 'settings', N_('Πόλη και γλώσσα'),
    N_('Η εφαρμογή δείχνει στάσεις, γραμμές και αγαπημένα της πόλης που έχεις επιλέξει. Την πόλη (Πάτρα ή Κέρκυρα), τη γλώσσα και το θέμα τα αλλάζεις από τις Ρυθμίσεις.')],
];

// "Where to tap for what": [icon name | text glyph, label, what it does]. `glyph` rows draw the character instead of an icon.
export const TAPS = [
  [{ icon: 'menu' }, N_('Μενού'), N_('Αρχική, αγαπημένες στάσεις, γραμμές, διαδρομή, θέμα και ρυθμίσεις. Στην κορυφή είναι η πόλη σου, με πάτημα για αλλαγή.')],
  [{ icon: 'search' }, N_('Πού πάμε;'), N_('Αναζήτηση στάσης, κωδικού στάσης ή τόπου.')],
  [{ icon: 'locate' }, N_('Εντοπισμός τοποθεσίας'), N_('Δείχνει τη θέση σου. Ξαναπάτα για να σε ακολουθεί ο χάρτης, και ακόμα μία φορά για να γυρίζει με την πυξίδα.')],
  [{ icon: 'compass' }, N_('Επαναφορά βορρά'), N_('Εμφανίζεται όταν ο χάρτης είναι γυρισμένος και τον ξαναβάζει με το βορρά πάνω.')],
  [{ icon: 'star' }, N_('Αστέρι'), N_('Προσθέτει ή αφαιρεί τη στάση από τα αγαπημένα.')],
  [{ glyph: '⋯' }, N_('Περισσότερα'), N_('Στη στάση ανοίγει τις επιλογές «Οδηγίες ως εδώ» και «Κοινοποίηση».')],
  [{ icon: 'walk' }, N_('Οδηγίες ως εδώ'), N_('Σχεδιάζει διαδρομή προς τη στάση.')],
  [{ icon: 'share' }, N_('Κοινοποίηση'), N_('Στέλνει σύνδεσμο προς τη στάση ή τη γραμμή.')],
  [{ icon: 'refresh' }, N_('Ανανέωση'), N_('Φέρνει τώρα νέες αφίξεις. Αλλιώς ανανεώνονται μόνες τους.')],
  [{ icon: 'bell' }, N_('Υπενθύμισέ μου'), N_('Ειδοποίηση πριν φύγεις, ή πριν κατέβεις με το «Θα κατέβω σε…».')],
  [{ icon: 'bus' }, N_('Είμαι στο λεωφορείο'), N_('Ξεκινά την ειδοποίηση πριν από τη στάση που θα κατέβεις.')],
  [{ icon: 'close' }, N_('Κλείσιμο'), N_('Κλείνει τη στάση και γυρίζει στην αρχική οθόνη.')],
  [{ icon: 'settings' }, N_('Ρυθμίσεις και σχετικά'), N_('Πόλη, γλώσσα, θέμα, ειδοποιήσεις, χάρτης χωρίς σύνδεση, πηγές δεδομένων.')],
  [{ icon: 'bug' }, N_('Αναφορά προβλήματος'), N_('Στέλνεις ένα λάθος ή μια πρόταση. Πριν την αποστολή βλέπεις τι θα σταλεί, και δεν περιλαμβάνεται η τοποθεσία σου.')],
];

// Every icon name the view draws (the test checks them against ui.js).
export const GUIDE_ICONS = [...new Set([
  'back', 'settings', 'clock',
  ...HOW.map((r) => r[1]),
  ...TAPS.map((r) => r[0].icon).filter(Boolean),
])];

// '?section=install' (hash query) asks to open on the install tutorial. `source` is a params object or a hash string.
export function wantedSection(source) {
  const params = typeof source === 'string' ? parseHash(source).params : (source || {});
  return params.section === 'install' ? 'install' : null;
}

// ---- view ----

const isEl = (x) => !!x && typeof x === 'object' && x.nodeType === 1;
let uid = 0;

// Real-looking tile for the explanation (same markup and classes as arrivals-view.js, without the live countdown).
function exampleTile({ live, line, dest, mins }) {
  const clock = fmtClock(Date.now() + mins * 60000);
  const flag = live
    ? h('span', { class: 'atile-flag' }, h('span', { class: 'atile-dot', 'aria-hidden': 'true' }), t('LIVE'))
    : h('span', { class: 'atile-flag' }, icon('clock'), t('ΠΡΟΓΡ.'), h('span', { class: 'atile-clock' }, clock));
  const label = live
    ? t('Παράδειγμα: γραμμή {line}, ζωντανή άφιξη σε {n} λεπτά.', { line: line.code, n: mins })
    : t('Παράδειγμα: γραμμή {line}, προγραμματισμένη άφιξη στις {clock}.', { line: line.code, clock });
  return h('div', { class: `atile ${live ? 'atile-live' : 'atile-sched'}`, role: 'img', 'aria-label': label },
    h('div', { class: 'atile-badge' }, lineBadge(line)),
    h('div', { class: 'atile-body' }, h('div', { class: 'atile-dest' }, dest), h('div', { class: 'atile-status' }, flag)),
    h('div', { class: 'atile-eta' }, h('span', { class: 'atile-num tabular' }, `${mins}′`)));
}

// Two sample lines: the first two of the active city when available (their real colours), else neutral ones.
function sampleLines(ctx) {
  const real = (ctx?.data?.lines || []).filter((l) => l && l.code && l.color).slice(0, 2);
  const fallback = [{ code: '1', color: '#1a73e8', textColor: '#ffffff' }, { code: '2', color: '#e8710a', textColor: '#ffffff' }];
  return [real[0] || fallback[0], real[1] || fallback[1]];
}

export function mountGuide(el, ctx = {}, params) {
  let dead = false;
  const timers = new Set();
  const after = (fn, ms) => { const id = setTimeout(() => { timers.delete(id); fn(); }, ms); timers.add(id); };
  const section = wantedSection(params ?? ctx.params ?? (globalThis.location?.hash || ''));
  let touched = false; // the reader scrolled on their own: stop re-aligning the install section
  const onTouch = () => { touched = true; };
  el.addEventListener('wheel', onTouch, { passive: true });
  el.addEventListener('touchstart', onTouch, { passive: true });

  const sec = (key, title, ...kids) => {
    const id = `gd-h-${key}-${++uid}`;
    return h('section', { class: `gd-sec gd-sec-${key}`, 'aria-labelledby': id }, h('h2', { class: 'gd-h', id }, title), ...kids);
  };

  function build() {
    const [liveLine, schedLine] = sampleLines(ctx);

    // 1. what it is
    const what = sec('what', t('Τι είναι'),
      h('p', { class: 'gd-p' }, t('{app} δείχνει πότε φτάνει το επόμενο λεωφορείο σε κάθε στάση, στην Πάτρα και στην Κέρκυρα.', { app: APP_NAME })),
      h('p', { class: 'gd-p' }, t('Κάθε άφιξη είναι ένα από δύο είδη:')),
      h('div', { class: 'gd-eg' },
        exampleTile({ live: true, line: liveLine, dest: t('Κέντρο'), mins: 4 }),
        h('p', { class: 'gd-cap' }, h('strong', {}, t('LIVE')), ' ', t('Το λεωφορείο στέλνει τη θέση του. Το βλέπεις στον χάρτη και ο χρόνος είναι εκτίμηση με βάση αυτή.'))),
      h('div', { class: 'gd-eg' },
        exampleTile({ live: false, line: schedLine, dest: t('Κέντρο'), mins: 12 }),
        h('p', { class: 'gd-cap' }, h('strong', {}, t('ΠΡΟΓΡ.')), ' ', t('Είναι μόνο η ώρα του προγράμματος, χωρίς θέση οχήματος. Το λεωφορείο μπορεί να καθυστερήσει ή να μην έρθει.'))),
      h('p', { class: 'gd-p gd-city' }, t('Βλέπεις τα δεδομένα της πόλης: {city}. Την πόλη και τη γλώσσα τις αλλάζεις από τις Ρυθμίσεις.', { city: cityName(city(), lang()) })),
      h('a', { class: 'btn press gd-btn', href: cityHash('#/settings') }, icon('settings'), t('Άνοιγμα Ρυθμίσεων')));

    // 2. install: filled by Part A (install-guide.js) through ctx.renderInstall; hidden when there is nothing to show.
    const installBody = h('div', { class: 'gd-install-body' });
    const install = sec('install', t('Εγκατάσταση ως εφαρμογή'), installBody);
    install.id = 'gd-install';
    install.hidden = true;

    // 3. how to use
    const how = sec('how', t('Πώς το χρησιμοποιώ'),
      h('ul', { class: 'gd-list' }, HOW.map(([key, ico, title, text]) => h('li', { class: `gd-item gd-how-${key}` },
        h('span', { class: 'gd-ico', 'aria-hidden': 'true' }, icon(ico)),
        h('div', { class: 'gd-item-main' }, h('h3', { class: 'gd-item-title' }, t(title)), h('p', { class: 'gd-item-text' }, t(text)))))));

    // 4. where to tap for what
    const taps = sec('taps', t('Τι κάνει κάθε κουμπί'),
      h('ul', { class: 'gd-list gd-taps' }, TAPS.map(([key, label, text]) => h('li', { class: 'gd-item gd-tap' },
        h('span', { class: 'gd-key', 'aria-hidden': 'true' }, key.icon ? icon(key.icon) : key.glyph),
        h('div', { class: 'gd-item-main' }, h('h3', { class: 'gd-item-title' }, t(label)), h('p', { class: 'gd-item-text' }, t(text)))))));

    return { nodes: [what, install, how, taps], install, installBody };
  }

  // The tutorial may come back directly or as a promise (the app loads install-guide.js on demand).
  function fillInstall(parts) {
    let got = null;
    try { got = ctx.renderInstall?.(); } catch (err) { console.warn('[guide] renderInstall failed', err); }
    Promise.resolve(got).then((node) => {
      if (dead || !isEl(node) || !parts.install.isConnected) return;
      parts.installBody.replaceChildren(node);
      parts.install.hidden = false;
      if (section === 'install') reveal(parts.install);
    }).catch((err) => console.warn('[guide] install section failed', err));
  }
  function reveal(node) {
    const go = () => { if (!dead && !touched && node.isConnected) node.scrollIntoView({ block: 'start', behavior: 'auto' }); };
    requestAnimationFrame(go);
    after(go, 350); // the sheet may still be settling on its snap point
  }

  function render() {
    if (dead) return;
    const parts = build();
    el.replaceChildren(h('div', { class: 'gd' },
      h('div', { class: 'view-head' },
        h('button', { type: 'button', class: 'btn round press', 'aria-label': t('Πίσω'), onclick: () => ctx.navigate?.('#/') }, icon('back')),
        h('h1', {}, t('Οδηγός'))),
      ...parts.nodes));
    fillInstall(parts);
  }
  render();
  const off = onLangChange(render);

  return {
    destroy() {
      dead = true;
      off();
      for (const id of timers) clearTimeout(id);
      el.removeEventListener('wheel', onTouch);
      el.removeEventListener('touchstart', onTouch);
      el.replaceChildren();
    },
  };
}
