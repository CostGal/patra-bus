// Report a problem (owner: extras). A full-height sheet like the settings: category, text, optional email, and the
// diagnostics that go with it, shown before sending. Pure logic (validation, payload, transport) is in report.js.
import { h, icon } from './ui.js';
import { t, N_, lang, APP_VERSION } from './i18n.js';
import { cityId } from './cities.js';
import { getSettings } from './store.js';
import { currentPlatform } from './platform.js';
import { API_BASE, DEMO } from './api.js';
import { LIMITS, collectDiagnostics, buildPayload, validateReport, sendReport } from './report.js';

const CATS = [
  ['data', N_('Λάθος δεδομένα')],
  ['app', N_('Πρόβλημα εφαρμογής')],
  ['idea', N_('Πρόταση')],
  ['other', N_('Άλλο')],
];
const ERR = {
  network: N_('Δεν στάλθηκε. Έλεγξε τη σύνδεσή σου και δοκίμασε ξανά.'),
  timeout: N_('Δεν στάλθηκε: η σύνδεση άργησε. Δοκίμασε ξανά.'),
  rate: N_('Έχεις στείλει αρκετές αναφορές. Δοκίμασε ξανά σε λίγα λεπτά.'),
  unavailable: N_('Η αποστολή αναφορών δεν είναι διαθέσιμη αυτή τη στιγμή.'),
  invalid: N_('Η αναφορά δεν έγινε δεκτή. Έλεγξε το κείμενο και δοκίμασε ξανά.'),
  server: N_('Κάτι πήγε στραβά. Δοκίμασε ξανά σε λίγο.'),
};

let uid = 0;

export function mountReport(container, ctx, params = {}) {
  const n = ++uid;
  const ids = { cat: `rp-cat-${n}`, msg: `rp-msg-${n}`, msgErr: `rp-msg-err-${n}`, mail: `rp-mail-${n}`, mailHint: `rp-mail-hint-${n}`, mailErr: `rp-mail-err-${n}` };
  let busy = false;
  let dead = false;
  let timer = 0;

  // What is sent besides the text. Collected once when the sheet opens, shown as is, cleaned again by the server.
  const diag = collectDiagnostics({
    version: APP_VERSION, city: cityId(), lang: lang(), context: params.context, platform: currentPlatform(),
    viewport: { w: innerWidth, h: innerHeight }, online: navigator.onLine !== false, theme: getSettings().theme || 'auto',
    sw: !!navigator.serviceWorker?.controller, demo: DEMO,
  });

  // category (TEL-252, UI-PROTOCOL U25): one pick-one row, the chosen chip under the glass lens (js/glass.js: bar[data-lens]
  // > row > chip, the chosen one aria-checked). Buttons with role radio, not native radios: the lens copies the row into
  // its bubble, and a copied radio would join the form's group. The row is rebuilt on every pick (that moves the lens);
  // the arrow keys move between the chips and pick, as native radios do.
  let cat = ['stop', 'line'].includes(params.context?.view) ? 'data' : 'app';
  const cats = h('div', { class: 'rp-cats', role: 'radiogroup', 'aria-labelledby': ids.cat });
  const catBar = h('div', { class: 'rp-catbar', 'data-lens': true }, cats);
  const paintCats = (focus) => {
    cats.replaceChildren(...CATS.map(([value, label]) => {
      const on = value === cat;
      return h('button', {
        type: 'button', role: 'radio', class: `rp-cat${on ? ' on' : ''}`, 'aria-checked': String(on), tabindex: on ? '0' : '-1',
        'data-key': value, onclick: () => pickCat(value),
      }, t(label));
    }));
    if (focus) cats.querySelector('[aria-checked="true"]')?.focus({ preventScroll: true });
  };
  const pickCat = (value) => { if (value !== cat) { cat = value; paintCats(true); } };
  cats.addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    const i = CATS.findIndex(([value]) => value === cat);
    const j = step ? (i + step + CATS.length) % CATS.length : e.key === 'Home' ? 0 : e.key === 'End' ? CATS.length - 1 : -1;
    if (j < 0) return;
    e.preventDefault();
    pickCat(CATS[j][0]);
  });
  paintCats(false);

  const message = h('textarea', {
    id: ids.msg, class: 'rp-input rp-text', rows: 6, maxlength: LIMITS.messageMax, required: true, 'aria-describedby': ids.msgErr,
    placeholder: t('Περίγραψε τι έγινε και τι περίμενες να δεις. Αν αφορά στάση ή γραμμή, γράψε ποια.'),
  });
  const email = h('input', {
    id: ids.mail, class: 'rp-input', type: 'email', inputmode: 'email', autocomplete: 'email', autocapitalize: 'off', spellcheck: 'false',
    maxlength: LIMITS.emailMax, 'aria-describedby': `${ids.mailHint} ${ids.mailErr}`,
  });
  // Honeypot: off-screen, out of the tab order and the accessibility tree. A person never fills it; a script usually does.
  const trap = h('input', { type: 'text', name: 'contact_me_by_fax_only', tabindex: '-1', autocomplete: 'off' });
  const msgErr = h('p', { id: ids.msgErr, class: 'rp-err', role: 'alert', hidden: true });
  const mailErr = h('p', { id: ids.mailErr, class: 'rp-err', role: 'alert', hidden: true });
  const sendErr = h('p', { class: 'rp-err rp-err-send', role: 'alert', hidden: true });
  const submit = h('button', { type: 'submit', class: 'btn primary press rp-submit' }, t('Αποστολή'));

  const fail = (el, input, text) => { el.textContent = text; el.hidden = false; input?.setAttribute('aria-invalid', 'true'); };
  const clear = () => {
    for (const [el, input] of [[msgErr, message], [mailErr, email], [sendErr, null]]) { el.hidden = true; el.textContent = ''; input?.removeAttribute('aria-invalid'); }
  };
  const setBusy = (on) => {
    busy = on;
    submit.disabled = on;
    submit.textContent = on ? t('Αποστολή…') : t('Αποστολή');
  };

  function done() {
    const head = h('h2', { class: 'rp-done-title', tabindex: '-1' }, t('Στάλθηκε. Ευχαριστούμε!'));
    panel.replaceChildren(h('div', { class: 'rp-done' },
      h('span', { class: 'rp-done-ico' }, icon('check')),
      head,
      h('p', { class: 'ex-sub' }, t('Η αναφορά σου έφτασε. Μας βοηθά να διορθώνουμε λάθη και να βελτιώνουμε την εφαρμογή.')),
      h('button', { type: 'button', class: 'btn press', onclick: () => ctx.navigate('#/') }, t('Πίσω στην αρχική'))));
    head.focus({ preventScroll: true });
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (busy) return;
    clear();
    const payload = buildPayload({ category: cat, message: message.value, email: email.value, hp: trap.value, diag });
    const v = validateReport(payload);
    if (!v.ok) {
      if (v.error === 'email') { fail(mailErr, email, t('Το email δεν φαίνεται σωστό. Άφησέ το κενό αν δεν θέλεις απάντηση.')); email.focus(); }
      else { fail(msgErr, message, t('Γράψε λίγα λόγια ακόμα (τουλάχιστον {n} χαρακτήρες).', { n: LIMITS.messageMin })); message.focus(); }
      return;
    }
    setBusy(true);
    try {
      if (DEMO) await new Promise((r) => { timer = setTimeout(r, 600); }); // demo mode never talks to the server
      else await sendReport(payload, { apiBase: API_BASE });
      if (!dead) done();
    } catch (err) {
      if (dead) return;
      setBusy(false);
      fail(sendErr, null, t(ERR[err?.kind] || ERR.server));
    }
  }

  const form = h('form', { class: 'rp-form', novalidate: true, onsubmit: onSubmit },
    h('p', { class: 'ex-sub rp-intro' }, t('Βρήκες λάθος ή κάτι δεν δουλεύει; Πες μας.')),
    h('div', { class: 'rp-field' }, h('p', { id: ids.cat, class: 'rp-label' }, t('Τι αφορά;')), catBar),
    h('div', { class: 'rp-field' }, h('label', { class: 'rp-label', for: ids.msg }, t('Τι συνέβη;')), message, msgErr),
    h('div', { class: 'rp-field' },
      h('label', { class: 'rp-label', for: ids.mail }, t('Email'), ' ', h('span', { class: 'rp-opt' }, `(${t('προαιρετικό')})`)),
      email,
      h('p', { id: ids.mailHint, class: 'ex-sub' }, t('Μόνο αν θέλεις να σου απαντήσουμε.')),
      mailErr),
    h('div', { class: 'rp-hp', 'aria-hidden': 'true' }, trap),
    h('details', { class: 'set-sec' },
      h('summary', { class: 'set-sum press' }, h('span', { class: 'set-sum-title' }, t('Τι στέλνεται αυτόματα')), icon('chevron-down')),
      h('div', { class: 'set-body' },
        h('p', { class: 'ex-sub' }, t('Τεχνικά στοιχεία που βοηθούν να βρούμε το πρόβλημα. Δεν περιέχουν τοποθεσία ή στοιχεία που σε ταυτοποιούν.')),
        h('pre', { class: 'rp-diag' }, JSON.stringify(diag, null, 1)))),
    sendErr,
    submit,
    h('p', { class: 'ex-sub rp-note' }, t('Στέλνονται μόνο όσα γράφεις εδώ και τα τεχνικά στοιχεία πιο πάνω. Η IP σου δεν αποθηκεύεται. Μην γράψεις προσωπικά στοιχεία που δεν χρειάζονται.')));
  const panel = h('div', { class: 'rp-panel' }, form);

  // header (TEL-252, UI-PROTOCOL U2–U5): the kit's .card-head (css/ui-kit.css), placed in css/report.css (rp-head), as
  // the favourites' (js/app.js): an empty slot · the title, 17 px, centred · ✕. The title is short and fixed, so it is
  // not shrunk to fit. Halfway from mid to up it moves to its own row, 24 px, in a short blur (U4, U10); towards up it
  // grows as a transform (U8).
  const title = h('h1', { class: 'rp-title card-title' }, t('Αναφορά προβλήματος'));
  const label = t('Κλείσιμο');
  const closeBtn = h('button', { type: 'button', class: 'btn round g-circle', 'aria-label': label, title: label, onclick: () => ctx.navigate('#/') }, icon('close'));
  // low ends under this row (js/sheet.js)
  const head = h('header', { class: 'rp-head card-head', 'data-peek-end': '' }, h('span', { 'aria-hidden': 'true' }), title, closeBtn);
  container.replaceChildren(h('div', { class: 'ex-view rp sheet-inset' }, head, panel));

  const sheetEl = document.getElementById('sheet');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const setUp = (on) => {
    if (head.classList.contains('is-up') === on) return;
    head.classList.toggle('is-up', on);
    if (!reduceMotion.matches) title.animate([{ filter: 'blur(3px)' }, { filter: 'blur(0)' }], { duration: 180, easing: 'ease-out' });
  };
  // as js/bus-view.js: up while the sheet is full or dragged past halfway from mid to up; nothing runs per frame
  const upRow = () => !!sheetEl && (sheetEl.dataset.state === 'full' || sheetEl.classList.contains('dragging'))
    && (parseFloat(sheetEl.style.getPropertyValue('--sheet-t')) || 0) > 1.5;
  const onUpper = () => setUp(upRow());
  const onLeaveUp = () => setUp(false);
  const mo = new MutationObserver(onUpper);
  if (sheetEl) {
    mo.observe(sheetEl, { attributes: true, attributeFilter: ['class', 'data-state'] });
    sheetEl.addEventListener('sheet:upper', onUpper);
    sheetEl.addEventListener('sheet:leave-full', onLeaveUp);
  }
  setUp(upRow());

  return {
    destroy() {
      dead = true;
      clearTimeout(timer);
      mo.disconnect();
      sheetEl?.removeEventListener('sheet:upper', onUpper);
      sheetEl?.removeEventListener('sheet:leave-full', onLeaveUp);
    },
  };
}
