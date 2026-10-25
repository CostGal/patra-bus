// First-run setup (owner: extras, TEL-74, issue #35). Three short steps the first time the app opens on the home view:
// language (pre-selected from the system language), city, and what LIVE / ΠΡΟΓΡ. mean, instead of a list to read.
// `?setup` previews it any time without touching the flag. Motion follows docs/DESIGN.md like welcome.js: the card rises and
// sinks on the shared spring, steps slide in from the side they come from, reduced motion = short fades.
// Styles: css/setup.css (prefix su-). English pairs: i18n-en-setup.js.
import { h } from './ui.js';
import { t, setLang, langPref, resolveLang, onLangChange, lang, APP_NAME } from './i18n.js';
import { getSettings, setSetting } from './store.js';
import { CITIES, cityId, cityName, isCity } from './cities.js';
import { createSpringLoop } from './motion.js';
import { cityHash, formatHash } from './route.js';
import { exampleTile, sampleLines } from './guide-view.js';

// Pure: shown once, on a boot that lands on the home view (never over a shared link); a preview always shows.
export const shouldSetup = ({ seen, preview, bootHome }) => !!preview || (!!bootHome && !seen);

// Pure: the language to pre-select. An explicit English choice stays; otherwise the system language decides
// ('el' is also the store default, so it cannot tell a choice from no choice).
export const initialLang = (pref, navLang) => (pref === 'en' ? 'en' : resolveLang('auto', navLang));

export const STEPS = 3;
const SETTLE = { damping: 1, response: 0.4 };

// Resolves when the setup closes; null when it does not show. ctx: { data } for the sample tiles' line colours.
export function maybeSetup({ bootHome, ctx } = {}) {
  const preview = /[?&]setup\b/.test(globalThis.location?.search || '');
  if (!shouldSetup({ seen: getSettings().setupDone === true, preview, bootHome })) return null;
  if (!preview) { // set on show, not on close: a reload mid-way must not bring it back. The home "first time here?" card goes too.
    setSetting('setupDone', true);
    setSetting('guideSeen', true);
  }
  return new Promise((resolve) => openSetup({ ctx, onClosed: resolve }));
}

export function openSetup({ ctx = {}, onClosed } = {}) {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const app = document.getElementById('app');
  const before = document.activeElement;
  const navLang = globalThis.navigator?.language || globalThis.navigator?.languages?.[0] || '';
  let pickLang = initialLang(langPref(), navLang);
  let pickCity = cityId();
  let step = 0;
  let v = 0; // 0 hidden .. 1 shown
  let closed = false;

  const dots = h('div', { class: 'su-dots', 'aria-hidden': 'true' });
  const skip = h('button', { type: 'button', class: 'btn ghost sm press su-skip', onclick: () => close() });
  const body = h('div', { class: 'su-body' });
  const back = h('button', { type: 'button', class: 'btn press su-back', onclick: () => go(step - 1) });
  const next = h('button', { type: 'button', class: 'btn primary press su-next', onclick: () => (step < STEPS - 1 ? go(step + 1) : close()) });
  const scrim = h('div', { class: 'su-scrim' });
  const card = h('div', { class: 'su-card' }, h('div', { class: 'su-top' }, dots, skip), body, h('div', { class: 'su-foot' }, back, next));
  const root = h('div', { class: 'su', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'su-title' }, scrim, card);

  // A row of choices that behave like radio buttons (aria-pressed, like the settings' segmented controls).
  const choices = (label, items, cur, onPick) => h('div', { class: 'su-choices', role: 'group', 'aria-label': label },
    ...items.map(([val, text]) => h('button', { type: 'button', class: 'su-choice press', 'data-v': val, 'aria-pressed': String(val === cur), onclick: () => onPick(val) },
      h('span', { class: 'su-choice-text' }, text), h('span', { class: 'su-check', 'aria-hidden': 'true' }))));

  function content() {
    const title = (text) => h('h2', { class: 'su-title', id: 'su-title', tabindex: '-1' }, text);
    const p = (text, cls = '') => h('p', { class: `su-p ${cls}`.trim() }, text);
    if (step === 0) {
      return [title(t('Καλώς ήρθες στο {app}', { app: APP_NAME })),
        p(t('Πότε έρχεται το λεωφορείο σου, ζωντανά. Πρώτα, διάλεξε γλώσσα.')),
        choices(t('Γλώσσα'), [['el', 'Ελληνικά'], ['en', 'English']], pickLang, (val) => {
          pickLang = val;
          setLang(val); // the setup itself switches language at once (re-rendered by onLangChange below)
          paintChoices();
        })];
    }
    if (step === 1) {
      return [title(t('Σε ποια πόλη;')),
        p(t('Αλλάζουν οι στάσεις, οι γραμμές και ο χάρτης. Την αλλάζεις όποτε θέλεις από τις Ρυθμίσεις.')),
        choices(t('Πόλη'), Object.values(CITIES).map((c) => [c.id, cityName(c, lang())]), pickCity, (val) => { pickCity = val; paintChoices(); })];
    }
    const [liveLine, schedLine] = sampleLines(ctx);
    return [title(t('LIVE ή ΠΡΟΓΡ.;')),
      p(t('Κάθε άφιξη είναι ένα από τα δύο:')),
      h('div', { class: 'su-eg' }, exampleTile({ live: true, line: liveLine, dest: t('Κέντρο'), mins: 4 }),
        p(t('Το λεωφορείο στέλνει τη θέση του. Το βλέπεις στον χάρτη και ο χρόνος είναι εκτίμηση με βάση αυτή.'), 'su-cap')),
      h('div', { class: 'su-eg' }, exampleTile({ live: false, line: schedLine, dest: t('Κέντρο'), mins: 12 }),
        p(t('Είναι μόνο η ώρα του προγράμματος, χωρίς θέση οχήματος. Το λεωφορείο μπορεί να καθυστερήσει ή να μην έρθει.'), 'su-cap')),
      p(t('′ = λεπτά, ″ = δευτερόλεπτα'), 'su-units'),
      h('a', { class: 'su-guide press', href: formatHash('#/guide', pickCity), onclick: (e) => { e.preventDefault(); close('#/guide'); } }, t('Δες όλο τον οδηγό'))];
  }

  function paintChoices() {
    for (const b of body.querySelectorAll('.su-choice')) b.setAttribute('aria-pressed', String(b.dataset.v === (step === 0 ? pickLang : pickCity)));
  }

  // dir: 1 = forward (slides in from the right), -1 = back (from the left), 0 = same step repainted (language change).
  function render(dir) {
    const focusV = document.activeElement?.closest?.('.su-choice')?.dataset.v;
    skip.textContent = t('Παράλειψη');
    back.textContent = t('Πίσω');
    back.hidden = step === 0;
    next.textContent = step < STEPS - 1 ? t('Επόμενο') : t('Ας ξεκινήσουμε');
    dots.replaceChildren(...Array.from({ length: STEPS }, (_, i) => h('span', { class: `su-dot${i === step ? ' on' : ''}` })));
    const pane = h('div', { class: `su-step${dir ? ' su-step-in' : ''}`, style: `--dir:${dir || 0}` },
      h('p', { class: 'su-count' }, t('Βήμα {n} από {total}', { n: step + 1, total: STEPS })), ...content());
    body.replaceChildren(pane);
    if (focusV) body.querySelector(`.su-choice[data-v="${focusV}"]`)?.focus({ preventScroll: true });
    else if (dir) body.querySelector('.su-title')?.focus({ preventScroll: true });
  }

  function go(to) {
    if (to < 0 || to >= STEPS || to === step) return;
    if (step === 0 && to > step && lang() !== pickLang) setLang(pickLang); // "Next" keeps the highlighted language
    const dir = to > step ? 1 : -1;
    step = to;
    render(dir);
  }

  const offLang = onLangChange(() => { if (!closed) render(0); });

  const paint = (val) => {
    scrim.style.opacity = String(val);
    card.style.opacity = String(val);
    card.style.transform = `translateY(${(1 - val) * 28}px) scale(${0.95 + 0.05 * val})`;
  };
  const loop = createSpringLoop({ get: () => v, set: (val) => { v = val; paint(val); }, onSettle: () => { if (v < 0.5) remove(); } });

  function remove() {
    root.remove();
    document.removeEventListener('keydown', onKey, true);
    app?.removeAttribute('inert');
    if (before?.isConnected) before.focus?.({ preventScroll: true });
    onClosed?.();
  }
  // Closing (done, skip or Esc) applies the city picked in step 2; a new city means a reload on that city, like Settings.
  function close(target) {
    if (closed) return;
    closed = true;
    offLang?.();
    if (isCity(pickCity) && pickCity !== cityId()) {
      setSetting('city', pickCity);
      try { history.replaceState(null, '', formatHash(target || '#/', pickCity)); } catch { /* ignore */ }
      location.reload();
      return;
    }
    if (target) location.hash = cityHash(target);
    if (reduce) { root.classList.add('su-out'); setTimeout(remove, 180); return; }
    loop.to(0, SETTLE); // sinks back the way it came
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
    if (e.key !== 'Tab') return;
    const order = [...root.querySelectorAll('button:not([hidden]), a[href]')];
    const i = order.indexOf(document.activeElement);
    const nextEl = order[(i + (e.shiftKey ? -1 : 1) + order.length) % order.length];
    e.preventDefault();
    nextEl?.focus();
  }

  app?.setAttribute('inert', ''); // the page behind is not reachable while the dialog is open
  document.addEventListener('keydown', onKey, true);
  render(0);
  document.body.append(root);
  body.querySelector('.su-choice[aria-pressed="true"]')?.focus({ preventScroll: true });
  if (reduce) { v = 1; paint(1); } else { paint(0); loop.to(1, SETTLE); }
  return { close };
}
