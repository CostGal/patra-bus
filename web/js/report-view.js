// Report a problem (owner: extras). A full-height sheet like the settings: category, text, optional email, and the
// diagnostics that go with it, shown before sending. Pure logic (validation, payload, transport) is in report.js.
import { h, icon } from './ui.js';
import { t, N_, lang } from './i18n.js';
import { cityId } from './cities.js';
import { getSettings } from './store.js';
import { currentPlatform } from './platform.js';
import { API_BASE, DEMO } from './api.js';
import { VERSION } from './settings-view.js';
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
    version: VERSION, city: cityId(), lang: lang(), context: params.context, platform: currentPlatform(),
    viewport: { w: innerWidth, h: innerHeight }, online: navigator.onLine !== false, theme: getSettings().theme || 'auto',
    sw: !!navigator.serviceWorker?.controller, demo: DEMO,
  });

  const first = ['stop', 'line'].includes(params.context?.view) ? 'data' : 'app';
  const radios = CATS.map(([value, label]) => h('label', { class: 'rp-cat' },
    h('input', { type: 'radio', name: ids.cat, value, checked: value === first }),
    h('span', { class: 'rp-cat-pill' }, t(label))));

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
    const payload = buildPayload({ category: form.elements[ids.cat].value, message: message.value, email: email.value, hp: trap.value, diag });
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
    h('fieldset', { class: 'rp-field' }, h('legend', { class: 'rp-label' }, t('Τι αφορά;')), h('div', { class: 'rp-cats' }, radios)),
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

  container.replaceChildren(h('div', { class: 'ex-view rp' },
    h('header', { class: 'ex-head' },
      h('button', { type: 'button', class: 'ex-icon-btn press', 'aria-label': t('Πίσω'), onclick: () => ctx.navigate('#/') }, icon('back')),
      h('h1', {}, t('Αναφορά προβλήματος'))),
    panel));

  return { destroy() { dead = true; clearTimeout(timer); } };
}
