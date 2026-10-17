// "Install as app" tutorial (owner: guide). One <section class="install"> that shows the steps for the detected
// platform (platform.js), or a one-line confirmation when the app already runs installed. Styles in css/install.css.
// Own inline SVG glyphs (they imitate the real browser controls) so ui.js stays untouched.
import { h, toast } from './ui.js';
import { t, APP_NAME, onLangChange } from './i18n.js';
import { currentPlatform, installHintFor } from './platform.js';

// ---- the browser's deferred install prompt (Chromium only), kept for the "Εγκατάσταση" button ----
let deferred = null; // BeforeInstallPromptEvent, single use
let installedNow = false; // appinstalled / accepted prompt in this page's lifetime
let armed = false;
let langHooked = false;
const sections = new Set(); // { el, opts, born }: repainted when the prompt, the install state or the language changes

// Idempotent. Call once, early (the event fires once, soon after load).
export function captureInstallPrompt() {
  if (armed || typeof window === 'undefined') return;
  armed = true;
  try {
    window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; notify(); });
    window.addEventListener('appinstalled', () => { deferred = null; installedNow = true; notify(); });
  } catch { /* not in a browser */ }
}

function notify() {
  const now = Date.now();
  for (const s of [...sections]) {
    if (!s.el.isConnected && now - s.born > 5000) sections.delete(s); // gone (a section is built before it is attached)
    else paint(s);
  }
}

// Suggestion hint for the shell: { os, browser } on a phone/tablet in a browser tab, else null.
export function installHint(platform) {
  return installedNow ? null : installHintFor(platform || currentPlatform());
}

// ---- glyphs: 24x24, imitate the controls the user has to find ----
const GLYPHS = {
  // iOS Share: open box with an arrow up
  share: '<path d="M8.5 10H7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2h-1.5"/><path d="M12 15V3.5"/><path d="m8.2 7 3.8-3.8L15.8 7"/>',
  // "Add to Home Screen" / "Install": plus in a rounded square
  add: '<rect x="3.5" y="3.5" width="17" height="17" rx="4.5"/><path d="M12 8v8M8 12h8"/>',
  // Android overflow menu (vertical dots), iOS "more" and Edge menu (horizontal dots), Samsung Internet (three lines)
  dotsV: '<g fill="currentColor" stroke="none"><circle cx="12" cy="5" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="12" cy="19" r="1.9"/></g>',
  dotsH: '<g fill="currentColor" stroke="none"><circle cx="5" cy="12" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="19" cy="12" r="1.9"/></g>',
  menu: '<path d="M4 6.5h16M4 12h16M4 17.5h16"/>',
  install: '<path d="M12 3.5v11"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M5 20h14"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6.5A2.5 2.5 0 0 1 7.5 4H15"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
};
const SVG_NS = 'http://www.w3.org/2000/svg';
function svg(name) {
  const s = document.createElementNS(SVG_NS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('focusable', 'false');
  s.classList.add('install-svg', `install-svg-${name}`);
  s.innerHTML = GLYPHS[name] || '';
  return s;
}
const glyph = (name) => h('span', { class: `install-glyph is-${name}`, 'aria-hidden': 'true' }, svg(name));

// ---- building blocks ----
// steps: [text, glyphName?, note?]
const stepList = (steps) => h('ol', { class: 'install-steps', role: 'list' }, ...steps.map(([text, g, note], i) =>
  h('li', { class: 'install-step' },
    h('span', { class: 'install-n', 'aria-hidden': 'true' }, String(i + 1)),
    h('span', { class: 'install-text' }, text, note && h('span', { class: 'install-note' }, note)),
    g && glyph(g))));
const head = (title) => h('h3', { class: 'install-title' }, title);
const lead = (text) => h('p', { class: 'install-lead' }, text);
const note = (text) => h('p', { class: 'install-foot' }, text);

// Row with a round badge and a line of text: the installed confirmation and the desktop one-liner.
const statusRow = (g, text, tone) => h('p', { class: `install-state${tone ?` is-${tone}` : ''}` },
  h('span', { class: 'install-badge', 'aria-hidden': 'true' }, svg(g)), h('span', { class: 'install-state-text' }, text));

async function copyLink(host, btn) {
  const url = String(globalThis.location?.href || '');
  try {
    await navigator.clipboard.writeText(url);
    toast(t('Ο σύνδεσμος αντιγράφηκε'));
    return;
  } catch { /* no clipboard API or denied: select the text instead */ }
  let inp = host.querySelector('.install-url');
  if (!inp) {
    inp = h('input', { class: 'install-url', type: 'text', readonly: true, value: url, 'aria-label': t('Σύνδεσμος της σελίδας') });
    btn.after(inp);
  }
  inp.focus();
  inp.select();
  try { inp.setSelectionRange(0, url.length); } catch { /* ignore */ }
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { /* ignore */ }
  toast(ok ? t('Ο σύνδεσμος αντιγράφηκε') : t('Επίλεξε και αντίγραψε τον σύνδεσμο'));
}

const copyButton = (host) => {
  const b = h('button', { type: 'button', class: 'btn press install-copy', onclick: () => copyLink(host, b) }, svg('copy'), t('Αντιγραφή συνδέσμου'));
  return b;
};

async function runInstall(btn) {
  const ev = deferred;
  deferred = null; // the event can be prompted only once
  if (!ev) { notify(); return; }
  btn.disabled = true;
  try {
    ev.prompt();
    const choice = await ev.userChoice;
    if (choice?.outcome === 'accepted') installedNow = true;
  } catch { /* prompt refused or already used */ }
  notify(); // accepted -> installed state; dismissed -> manual steps
}

// ---- which tutorial ----
function caseOf(p) {
  if (p.mode === 'app') return 'installed';
  if (p.browser === 'inapp' && p.os !== 'other') return p.os === 'ios' ? 'inapp-ios' : 'inapp-android';
  if (p.canPrompt) return 'prompt';
  if (p.os === 'ios') return p.browser === 'safari' ? 'ios-safari' : 'ios-other';
  if (p.os === 'android') return `android-${['chrome', 'edge', 'samsung', 'firefox'].includes(p.browser) ? p.browser : 'other'}`;
  return 'desktop';
}

const addToHomeSteps = () => [
  [t('Πάτησε «Κοινοποίηση»'), 'share', t('Στο iPhone είναι κάτω ή μέσα στο μενού «⋯», στο iPad πάνω.')],
  [t('Διάλεξε «Προσθήκη στην οθόνη Αφετηρίας»'), 'add', t('Αν δεν φαίνεται, σύρε τη λίστα προς τα πάνω.')],
  [t('Πάτησε «Προσθήκη»')],
];

function build(kind, host) {
  const app = { app: APP_NAME };
  const addTitle = () => head(t('Πρόσθεσε το {app} στην αρχική οθόνη', app));
  switch (kind) {
    case 'installed':
      return [statusRow('check', t('Η εφαρμογή είναι εγκατεστημένη. Δεν χρειάζεται κάτι άλλο.'), 'ok')];
    case 'installed-now':
      return [statusRow('check', t('Εγκαταστάθηκε! Βρες την στην αρχική οθόνη ή στη λίστα εφαρμογών.'), 'ok')];
    case 'prompt': {
      const b = h('button', { type: 'button', class: 'btn primary press install-go', onclick: () => runInstall(b) }, svg('install'), t('Εγκατάσταση'));
      return [head(t('Εγκατάστησε το {app}', app)), lead(t('Ανοίγει σε πλήρη οθόνη, με ένα πάτημα από την αρχική οθόνη.')), h('div', { class: 'install-actions' }, b)];
    }
    case 'ios-safari':
      return [addTitle(), lead(t('Ανοίγει σε πλήρη οθόνη, με ένα πάτημα. Στο iPhone, οι υπενθυμίσεις με ειδοποίηση δουλεύουν μόνο στην εγκατεστημένη εφαρμογή.')), stepList(addToHomeSteps())];
    case 'ios-other': {
      const steps = addToHomeSteps();
      steps[0] = [t('Πάτησε «Κοινοποίηση» ή το μενού του προγράμματος περιήγησης'), 'share'];
      return [addTitle(), lead(t('Ανοίγει σε πλήρη οθόνη, με ένα πάτημα. Στο iPhone, οι υπενθυμίσεις με ειδοποίηση δουλεύουν μόνο στην εγκατεστημένη εφαρμογή.')), stepList(steps),
        note(t('Δεν βλέπεις «Προσθήκη στην οθόνη Αφετηρίας»; Άνοιξε τη σελίδα στο Safari και ακολούθησε τα ίδια βήματα.')),
        h('div', { class: 'install-actions' }, copyButton(host))];
    }
    case 'inapp-ios':
      return [head(t('Άνοιξε τη σελίδα στο Safari')), lead(t('Αυτή η σελίδα άνοιξε μέσα σε άλλη εφαρμογή, που δεν επιτρέπει εγκατάσταση.')),
        stepList([[t('Άνοιξε το μενού της εφαρμογής και διάλεξε «Άνοιγμα στο Safari»'), 'dotsH'], [t('Ή αντίγραψε τον σύνδεσμο και επικόλλησέ τον στο Safari')]]),
        h('div', { class: 'install-actions' }, copyButton(host)), note(t('Εκεί θα δεις τα βήματα εγκατάστασης.'))];
    case 'inapp-android':
      return [head(t('Άνοιξε τη σελίδα στο Chrome')), lead(t('Αυτή η σελίδα άνοιξε μέσα σε άλλη εφαρμογή, που δεν επιτρέπει εγκατάσταση.')),
        stepList([[t('Άνοιξε το μενού της εφαρμογής και διάλεξε «Άνοιγμα στο Chrome»'), 'dotsV'], [t('Ή αντίγραψε τον σύνδεσμο και επικόλλησέ τον στο Chrome')]]),
        h('div', { class: 'install-actions' }, copyButton(host)), note(t('Εκεί θα δεις τα βήματα εγκατάστασης.'))];
    case 'android-chrome':
    case 'android-other':
      return [addTitle(), lead(t('Ανοίγει σε πλήρη οθόνη, με ένα πάτημα από την αρχική οθόνη.')), stepList([
        [t('Πάτησε το μενού'), 'dotsV'],
        [t('Διάλεξε «Εγκατάσταση εφαρμογής» ή «Προσθήκη στην αρχική οθόνη»'), 'add'],
        [t('Επιβεβαίωσε την εγκατάσταση')],
      ])];
    case 'android-edge':
      return [addTitle(), lead(t('Ανοίγει σε πλήρη οθόνη, με ένα πάτημα από την αρχική οθόνη.')), stepList([
        [t('Πάτησε το μενού'), 'dotsH'],
        [t('Διάλεξε «Προσθήκη στο τηλέφωνο» ή «Εγκατάσταση»'), 'add'],
        [t('Επιβεβαίωσε την εγκατάσταση')],
      ])];
    case 'android-samsung':
      return [addTitle(), lead(t('Ανοίγει σε πλήρη οθόνη, με ένα πάτημα από την αρχική οθόνη.')), stepList([
        [t('Πάτησε το μενού (κάτω δεξιά)'), 'menu'],
        [t('Διάλεξε «Προσθήκη σελίδας σε» και μετά «Αρχική οθόνη»'), 'add'],
        [t('Πάτησε «Προσθήκη»')],
      ])];
    case 'android-firefox':
      return [addTitle(), lead(t('Ανοίγει σε πλήρη οθόνη, με ένα πάτημα από την αρχική οθόνη.')), stepList([
        [t('Πάτησε το μενού'), 'dotsV'],
        [t('Διάλεξε «Εγκατάσταση»'), 'add'],
      ])];
    default: // desktop / unknown
      return [statusRow('install', t('Στον υπολογιστή: ψάξε το εικονίδιο εγκατάστασης στη γραμμή διευθύνσεων ή απλώς κράτα τη σελίδα στους σελιδοδείκτες.'))];
  }
}

function paint(s) {
  const forced = s.opts.platform;
  const p = forced ? { ...currentPlatform({ hasInstallPrompt: !!deferred }), ...forced } : currentPlatform({ hasInstallPrompt: !!deferred });
  const kind = installedNow && !forced && p.mode === 'browser' ? 'installed-now' : caseOf(p);
  const keepFocus = s.el.contains(document.activeElement) && document.activeElement.classList.contains('install-copy');
  s.el.dataset.case = kind;
  s.el.dataset.os = p.os;
  s.el.dataset.browser = p.browser;
  s.el.replaceChildren(...build(kind, s.el));
  if (keepFocus) s.el.querySelector('.install-copy')?.focus();
}

// opts.platform (testing/harness only): a partial { os, mode, browser, canPrompt } merged over the detected platform,
// which forces a case without a matching device; a forced section ignores the real install-prompt/installed state.
export function renderInstallSection(opts = {}) {
  const el = h('section', { class: 'install', 'aria-label': t('Εγκατάσταση ως εφαρμογή') });
  const s = { el, opts, born: Date.now() };
  sections.add(s);
  if (!langHooked) { langHooked = true; onLangChange(notify); }
  paint(s);
  return el;
}
