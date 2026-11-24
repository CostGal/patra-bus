// Report a problem (owner: extras). A full-height sheet like the settings: the kind is picked first (in the ☰ menu, or
// here for a link without one, TEL-358) and is the form's title; then text, optional email, and the diagnostics that go
// with it, shown before sending. Pure logic (validation, payload, transport) is in report.js.
import { h, icon, cardHead } from './ui.js';
import { t, N_, lang, APP_VERSION } from './i18n.js';
import { cityId } from './cities.js';
import { getSettings } from './store.js';
import { currentPlatform } from './platform.js';
import { API_BASE, DEMO } from './api.js';
import { LIMITS, collectDiagnostics, buildPayload, validateReport, sendReport } from './report.js';

const ERR = {
  network: N_('Δεν στάλθηκε. Έλεγξε τη σύνδεσή σου και δοκίμασε ξανά.'),
  timeout: N_('Δεν στάλθηκε: η σύνδεση άργησε. Δοκίμασε ξανά.'),
  rate: N_('Έχεις στείλει αρκετές αναφορές. Δοκίμασε ξανά σε λίγα λεπτά.'),
  unavailable: N_('Η αποστολή αναφορών δεν είναι διαθέσιμη αυτή τη στιγμή.'),
  invalid: N_('Η αναφορά δεν έγινε δεκτή. Έλεγξε το κείμενο και δοκίμασε ξανά.'),
  server: N_('Κάτι πήγε στραβά. Δοκίμασε ξανά σε λίγο.'),
};

let uid = 0;

// A link with no kind (or an unknown one): the same four kinds as the menu, as a list in the sheet.
function mountKinds(container, ctx, kinds) {
  const head = cardHead({ title: t('Αναφορά προβλήματος'), closeLabel: t('Κλείσιμο'), onClose: () => ctx.navigate('#/') });
  const list = h('div', { class: 'rp-kinds' }, kinds.map(([value, ico, label]) => h('button', {
    type: 'button', class: 'rp-kind press', onclick: () => ctx.navigate(`#/report?kind=${value}`),
  }, icon(ico), h('span', {}, t(label)), icon('chevron'))));
  container.replaceChildren(h('div', { class: 'ex-view rp sheet-inset' }, head.el,
    h('div', { class: 'rp-panel rp-form' }, h('p', { class: 'ex-sub rp-intro' }, t('Βρήκες λάθος ή κάτι δεν δουλεύει; Πες μας.')), list)));
  return { destroy() { head.destroy(); } };
}

export function mountReport(container, ctx, params = {}) {
  const kinds = params.kinds || [];
  const kind = kinds.find(([value]) => value === params.kind);
  if (!kind) return mountKinds(container, ctx, kinds);
  const cat = kind[0];
  const n = ++uid;
  const ids = { msg: `rp-msg-${n}`, msgErr: `rp-msg-err-${n}`, mail: `rp-mail-${n}`, mailHint: `rp-mail-hint-${n}`, mailErr: `rp-mail-err-${n}` };
  let busy = false;
  let dead = false;
  let timer = 0;

  // What is sent besides the text. Collected once when the sheet opens, shown as is, cleaned again by the server.
  const diag = collectDiagnostics({
    version: APP_VERSION, city: cityId(), lang: lang(), context: params.context, platform: currentPlatform(),
    viewport: { w: innerWidth, h: innerHeight }, online: navigator.onLine !== false, theme: getSettings().theme || 'auto',
    sw: !!navigator.serviceWorker?.controller, demo: DEMO,
  });

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
    h('div', { class: 'rp-field' }, h('label', { class: 'rp-label', for: ids.msg }, t('Τι συνέβη;')), message, msgErr),
    h('div', { class: 'rp-field' },
      h('label', { class: 'rp-label', for: ids.mail }, t('Email'), ' ', h('span', { class: 'rp-opt' }, `(${t('προαιρετικό')})`)),
      email,
      h('p', { id: ids.mailHint, class: 'ex-sub' }, t('Μόνο αν θέλεις να σου απαντήσουμε.')),
      mailErr),
    h('div', { class: 'rp-hp', 'aria-hidden': 'true' }, trap),
    // CLAUDE.md rule 4: the form names every kind of diagnostic in `diag`, before the send button (TEL-358).
    h('p', { class: 'ex-sub rp-note' }, t('Στέλνονται μόνο όσα γράφεις εδώ και αυτά τα τεχνικά στοιχεία: έκδοση, πόλη, γλώσσα, η οθόνη και η στάση ή γραμμή που έβλεπες, σύστημα, browser, μέγεθος οθόνης, σύνδεση, θέμα και τρόπος λειτουργίας της εφαρμογής. Η IP σου δεν αποθηκεύεται. Μην γράψεις προσωπικά στοιχεία που δεν χρειάζονται.')),
    sendErr,
    submit);
  const panel = h('div', { class: 'rp-panel' }, form);

  // header: the shared card header (TEL-350, js/ui.js cardHead)
  const head = cardHead({ title: t(kind[2]), closeLabel: t('Κλείσιμο'), onClose: () => ctx.navigate('#/') });
  container.replaceChildren(h('div', { class: 'ex-view rp sheet-inset' }, head.el, panel));

  return {
    destroy() {
      dead = true;
      clearTimeout(timer);
      head.destroy();
    },
  };
}
