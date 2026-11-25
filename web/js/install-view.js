// Install the app (TEL-409, owner: extras). A full-height sheet like the settings, opened from the ☰ menu while the app
// runs in a browser tab. It shows only the steps for this phone and browser (platform.js installCase); where the browser
// has its own install prompt (Android Chrome, Edge, desktop) it is one button. Styles: css/extras.css (prefix in-).
// UI-PROTOCOL: the kit's .card-head with ✕ (U2–U5, U19), 16 px inset (.sheet-inset), the primary button is a kit .btn.
import { h, icon, cardHead } from './ui.js';
import { t, N_, APP_NAME } from './i18n.js';
import { getSettings, setSetting } from './store.js';
import { currentPlatform, installCase } from './platform.js';

// ---- the browser's install prompt (Chromium only). Caught early by app.js; it can be shown once. ----
let deferred = null;
let installedNow = false;
const listeners = new Set();
const notify = () => listeners.forEach((fn) => fn());
export function captureInstallPrompt() {
  try {
    addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; notify(); });
    addEventListener('appinstalled', () => { deferred = null; installedNow = true; notify(); });
  } catch { /* not in a browser */ }
}
// The menu row shows only while the app is not installed (and not just installed in this tab).
export const canInstall = () => !installedNow && currentPlatform().mode !== 'app';

// Shows the browser's own install window. true = the user accepted. false = no prompt, or they said no.
export async function promptInstall() {
  const ev = deferred;
  deferred = null; // single use
  if (!ev) { notify(); return false; }
  let ok = false;
  try {
    ev.prompt();
    ok = (await ev.userChoice)?.outcome === 'accepted';
  } catch { /* refused or already used */ }
  if (ok) installedNow = true;
  notify();
  return ok;
}

// ---- the floating card on home (TEL-409): a glass card just above the sheet, on a phone in a browser tab ----
// Pure: should the card show? Only on a phone (iPhone, Android) in a browser, not installed, not closed with ✕.
export const shouldHint = ({ os, mode }, { dismissed, installed }) => (os === 'ios' || os === 'android') && mode === 'browser' && !dismissed && !installed;

// Returns { el, update(onHome) }. app.js places el over the map and moves it with the sheet (like the map buttons).
// opts.onHow(): open the steps (#/install).
export function createInstallHint({ onHow }) {
  const el = h('div', { class: 'ih', role: 'region', 'aria-label': t('Εγκατάσταση εφαρμογής'), hidden: true });
  let home = false;
  const close = () => { setSetting('installHintDismissed', true); update(home); };
  function paint() {
    const p = currentPlatform({ hasInstallPrompt: !!deferred });
    const kind = installCase(p);
    const go = kind === 'prompt'
      ? h('button', { type: 'button', class: 'g-pill primary press ih-go', onclick: async () => { if (!(await promptInstall())) onHow(); } }, icon('install'), h('span', {}, t('Εγκατάσταση')))
      : h('button', { type: 'button', class: 'g-pill primary press ih-go', onclick: onHow }, icon(kind.startsWith('ios') ? 'share' : 'install'), h('span', {}, t('Δείξε μου πώς')));
    el.replaceChildren(
      h('div', { class: 'ih-row' },
        h('img', { class: 'ih-logo', src: 'icon.svg', alt: '', width: '40', height: '40' }),
        h('div', { class: 'ih-text' },
          h('strong', {}, t('Βάλε το {app} στην οθόνη σου', { app: APP_NAME })),
          h('span', { class: 'ex-sub' }, t('Ανοίγει με ένα πάτημα, σαν εφαρμογή.'))),
        h('button', { type: 'button', class: 'btn round g-circle', 'aria-label': t('Όχι τώρα'), title: t('Όχι τώρα'), onclick: close }, icon('close'))),
      go);
  }
  function update(onHome) {
    home = onHome;
    const show = onHome && shouldHint(currentPlatform(), { dismissed: getSettings().installHintDismissed === true, installed: installedNow });
    if (show && el.hidden) paint();
    el.hidden = !show;
  }
  listeners.add(() => { if (!el.hidden) { paint(); update(home); } });
  return { el, update };
}

// steps: [text, iconName?]
const SHARE_STEPS = [
  [N_('Πάτα «Κοινοποίηση»'), 'share'],
  [N_('Διάλεξε «Προσθήκη στην οθόνη Αφετηρίας»'), 'add-square'],
  [N_('Πάτα «Προσθήκη»'), null],
];
const STEPS = {
  'ios-safari': SHARE_STEPS,
  'ios-other': SHARE_STEPS,
  'android-chrome': [[N_('Πάτα το μενού ⋮ πάνω δεξιά'), 'dots-v'], [N_('Διάλεξε «Εγκατάσταση εφαρμογής» ή «Προσθήκη στην αρχική οθόνη»'), 'install'], [N_('Πάτα «Εγκατάσταση»'), null]],
  'android-samsung': [[N_('Πάτα το μενού ☰ κάτω δεξιά'), 'menu'], [N_('Διάλεξε «Προσθήκη σελίδας σε» και μετά «Αρχική οθόνη»'), 'add-square'], [N_('Πάτα «Προσθήκη»'), null]],
  'android-firefox': [[N_('Πάτα το μενού ⋮'), 'dots-v'], [N_('Διάλεξε «Προσθήκη στην αρχική οθόνη»'), 'add-square'], [N_('Πάτα «Προσθήκη»'), null]],
  'android-other': [[N_('Άνοιξε το μενού του browser'), 'dots-v'], [N_('Διάλεξε «Προσθήκη στην αρχική οθόνη»'), 'add-square']],
};
const NOTES = {
  'ios-safari': N_('Στο iPhone η «Κοινοποίηση» είναι κάτω, ή μέσα στο μενού «⋯». Αν δεν βλέπεις την «Προσθήκη», σύρε τη λίστα προς τα πάνω.'),
  'ios-other': N_('Η «Κοινοποίηση» είναι συνήθως δίπλα στη διεύθυνση. Αν δεν τη βρίσκεις, άνοιξε τη σελίδα στο Safari.'),
};

function stepList(steps) {
  return h('ol', { class: 'in-steps' }, steps.map(([text, ico], i) => h('li', { class: 'in-step' },
    h('span', { class: 'in-n', 'aria-hidden': 'true' }, String(i + 1)),
    h('span', { class: 'in-text' }, t(text)),
    ico ? h('span', { class: 'in-glyph', 'aria-hidden': 'true' }, icon(ico)) : null)));
}

export function mountInstall(container, ctx) {
  const head = cardHead({ title: t('Εγκατάσταση εφαρμογής'), closeLabel: t('Κλείσιμο'), onClose: () => ctx.navigate('#/') });
  const body = h('div', { class: 'in-body' });
  const lead = (text) => h('p', { class: 'set-p in-lead' }, text);
  const done = (text) => h('p', { class: 'in-done' }, h('span', { class: 'in-glyph is-ok', 'aria-hidden': 'true' }, icon('check')), h('span', {}, text));

  async function runPrompt(btn) {
    btn.disabled = true;
    await promptInstall(); // repaints: accepted = done; dismissed = the manual steps
  }

  function paint() {
    const p = currentPlatform({ hasInstallPrompt: !!deferred });
    const kind = installedNow ? 'installed-now' : installCase(p);
    const app = { app: APP_NAME };
    const why = lead(t('Ανοίγει με ένα πάτημα από την αρχική οθόνη, σε πλήρη οθόνη, σαν κανονική εφαρμογή.'));
    let kids;
    if (kind === 'installed') kids = [done(t('Η εφαρμογή είναι ήδη εγκατεστημένη.'))];
    else if (kind === 'installed-now') kids = [done(t('Έτοιμο! Θα βρεις το {app} στην αρχική οθόνη.', app))];
    else if (kind === 'prompt') {
      const btn = h('button', { type: 'button', class: 'btn primary press in-go', onclick: () => runPrompt(btn) }, icon('install'), t('Εγκατάσταση'));
      kids = [why, h('div', { class: 'set-actions' }, btn)];
    } else if (kind === 'inapp') {
      kids = [lead(t('Αυτή η σελίδα άνοιξε μέσα σε άλλη εφαρμογή. Για εγκατάσταση, άνοιξέ τη στο Safari (iPhone) ή στο Chrome (Android).')),
        stepList([[N_('Πάτα το μενού «⋯» αυτής της εφαρμογής'), 'dots'], [N_('Διάλεξε «Άνοιγμα στο πρόγραμμα περιήγησης»'), null]])];
    } else if (kind === 'desktop') {
      kids = [lead(t('Στον υπολογιστή, στο Chrome ή στο Edge, πάτα το εικονίδιο εγκατάστασης στη γραμμή διεύθυνσης. Στο κινητό, άνοιξε αυτή τη σελίδα και έλα ξανά εδώ.'))];
    } else {
      kids = [why, stepList(STEPS[kind]), NOTES[kind] ? h('p', { class: 'ex-sub in-note' }, t(NOTES[kind])) : null];
    }
    body.replaceChildren(...kids.filter(Boolean));
  }

  listeners.add(paint);
  paint();
  container.replaceChildren(h('div', { class: 'ex-view in sheet-inset' }, head.el, body));
  return { destroy() { listeners.delete(paint); head.destroy(); } };
}
