// First-run setup (owner: extras, TEL-74, issue #35). Three short steps the first time the app opens on the home view:
// language (pre-selected from the system language), city, and what LIVE / ΠΡΟΓΡ. mean, instead of a list to read.
// `?setup` previews it any time without touching the flag. Look and motion follow the locked stop card (docs/DESIGN.md §10,
// docs/UI-PROTOCOL.md, TEL-247): kit header (back · progress · skip), a glass card that rises from the screen's bottom edge on
// the shared spring and never fades (U12), steps slide in from the side they come from, reduced motion = short fades.
// Styles: css/setup.css (prefix su-). English pairs: i18n-en-setup.js.
import { h, icon, lineBadge, fmtClock } from './ui.js';
import { t, setLang, langPref, resolveLang, onLangChange, lang, APP_NAME } from './i18n.js';
import { getSettings, setSetting } from './store.js';
import { CITIES, cityId, cityName, isCity } from './cities.js';
import { createSpringLoop } from './motion.js';
import { cityHash, formatHash } from './route.js';

// Pure: shown once, on a boot that lands on the home view (never over a shared link); a preview always shows.
export const shouldSetup = ({ seen, preview, bootHome }) => !!preview || (!!bootHome && !seen);

// Pure: the language to pre-select. An explicit English choice stays; otherwise the system language decides
// ('el' is also the store default, so it cannot tell a choice from no choice).
export const initialLang = (pref, navLang) => (pref === 'en' ? 'en' : resolveLang('auto', navLang));

// Real-looking tile for the explanation (same markup and classes as arrivals-view.js, without the live countdown).
export function exampleTile({ live, line, dest, mins }) {
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
export function sampleLines(ctx) {
  const real = (ctx?.data?.lines || []).filter((l) => l && l.code && l.color).slice(0, 2);
  const fallback = [{ code: '1', color: '#1a73e8', textColor: '#ffffff' }, { code: '2', color: '#e8710a', textColor: '#ffffff' }];
  return [real[0] || fallback[0], real[1] || fallback[1]];
}

export const STEPS = 3;
const SETTLE = { damping: 1, response: 0.4 };
const DOT = 20; // progress: an 8 px dot + 12 px gap (css/setup.css .su-dots)
const navLang = () => globalThis.navigator?.language || globalThis.navigator?.languages?.[0] || '';

// Resolves when the setup closes; null when it does not show. ctx: { data } for the sample tiles' line colours.
export function maybeSetup({ bootHome, ctx, after } = {}) {
  const preview = /[?&]setup\b/.test(globalThis.location?.search || '');
  if (!shouldSetup({ seen: getSettings().setupDone === true, preview, bootHome })) return null;
  if (!preview) { // set on show, not on close: a reload mid-way must not bring it back.
    setSetting('setupDone', true);
    // D1 (TEL-247): a phone that is not in Greek gets its own language before anything is drawn, so the setup (and the
    // app behind it) is never Greek with "English" pre-selected. Greek phones: no change.
    const sys = initialLang(langPref(), navLang());
    if (sys !== lang()) setLang(sys);
  }
  // `after` (the boot screen leaving, TEL-255): the flags above are set at once, the dialog opens when it resolves.
  return Promise.resolve(after).then(() => new Promise((resolve) => openSetup({ ctx, onClosed: resolve })));
}

export function openSetup({ ctx = {}, onClosed } = {}) {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const app = document.getElementById('app');
  const before = document.activeElement;
  let pickLang = initialLang(langPref(), navLang());
  let pickCity = cityId();
  let step = 0;
  let y = 0; // the card's offset below its place, px: `travel` hidden .. 0 shown
  let travel = 1;
  let closed = false;

  // Header (kit .card-head, U3/U4): back circle · progress · skip circle. Back keeps its place on step 1 (hidden, inert).
  const circle = (name, cls, onclick) => h('button', { type: 'button', class: `btn round g-circle ${cls}`, onclick }, icon(name));
  const back = circle('back', 'su-back', () => go(step - 1));
  const skip = circle('close', 'su-skip', () => close());
  const pill = h('span', { class: 'su-pill' });
  const dots = h('div', { class: 'su-dots', 'aria-hidden': 'true' }, ...Array.from({ length: STEPS }, () => h('span', { class: 'su-dot' })), pill);
  const count = h('p', { class: 'visually-hidden', 'aria-live': 'polite' }); // «Βήμα n από 3»: read, not shown
  const body = h('div', { class: 'su-body' });
  const nextText = h('span');
  const next = h('button', { type: 'button', class: 'g-pill primary su-next', onclick: () => (step < STEPS - 1 ? go(step + 1) : close()) }, nextText);
  const scrim = h('div', { class: 'su-scrim' });
  const card = h('div', { class: 'su-card' }, h('div', { class: 'card-head su-head' }, back, dots, skip), count, body, h('div', { class: 'su-foot' }, next));
  const root = h('div', { class: 'su', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'su-title' }, scrim, card);

  // A row of choices that behave like radio buttons (aria-pressed, like the settings' segmented controls).
  const choices = (label, items, cur, onPick) => h('div', { class: 'su-choices', role: 'group', 'aria-label': label },
    ...items.map(([val, text]) => h('button', { type: 'button', class: 'su-choice press', 'data-v': val, 'aria-pressed': String(val === cur), onclick: () => onPick(val) },
      h('span', { class: 'su-choice-text' }, text), h('span', { class: 'su-check', 'aria-hidden': 'true' }, icon('check')))));

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
      p(t('′ = λεπτά, ″ = δευτερόλεπτα'), 'su-units')];
  }

  function paintChoices() {
    for (const b of body.querySelectorAll('.su-choice')) b.setAttribute('aria-pressed', String(b.dataset.v === (step === 0 ? pickLang : pickCity)));
  }

  // dir: 1 = forward (slides in from the right), -1 = back (from the left), 0 = same step repainted (language change).
  function render(dir) {
    const focusV = document.activeElement?.closest?.('.su-choice')?.dataset.v;
    for (const [b, label] of [[skip, t('Παράλειψη')], [back, t('Πίσω')]]) { b.setAttribute('aria-label', label); b.title = label; }
    back.inert = step === 0;
    nextText.textContent = step < STEPS - 1 ? t('Επόμενο') : t('Ας ξεκινήσουμε');
    pill.style.transform = `translateX(${step * DOT}px)`;
    count.textContent = t('Βήμα {n} από {total}', { n: step + 1, total: STEPS });
    const pane = h('div', { class: `su-step${dir ? ' su-step-in' : ''}`, style: `--dir:${dir || 0}` }, ...content());
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

  // The card rises from just below the screen's bottom edge and sinks back the same way; it stays opaque the whole time
  // (a glass layer never fades, U12), only the scrim follows. The spring runs in px, so it settles without a jump.
  const paint = (val) => {
    scrim.style.opacity = String(Math.max(0, Math.min(1, 1 - val / travel)));
    card.style.transform = val > 0.5 ? `translateY(${val}px)` : '';
  };
  const measure = () => { // from the untransformed card (U18)
    const tf = card.style.transform;
    card.style.transform = '';
    travel = Math.max(1, innerHeight - card.getBoundingClientRect().top + 24);
    card.style.transform = tf;
  };
  const loop = createSpringLoop({ get: () => y, set: (val) => { y = val; paint(val); }, onSettle: () => { if (closed) remove(); } });

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
    if (reduce) { root.classList.add('su-out'); setTimeout(remove, 180); return; } // scrim fades, then the card goes
    loop.to(travel, SETTLE); // sinks back the way it came
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
    if (e.key !== 'Tab') return;
    const order = [...root.querySelectorAll('button:not([hidden], [inert]), a[href]')];
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
  if (!reduce) { measure(); y = travel; paint(y); loop.to(0, SETTLE); } // reduced: shown in place, the scrim fades in (css/setup.css)
  return { close };
}
