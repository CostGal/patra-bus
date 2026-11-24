// Set a place in the sheet (TEL-239, owner: places), as Apple Maps' «Set up Work» / «Add Pin»: ✕ · title · ✓ on the card's
// header row (DESIGN.md §10), the grey search capsule, «Προτάσεις» while it is empty, the results while typing.
// `#/place?id=home|work|new|<a custom place's id>`. ✓ saves and goes back home. Style: css/places.css.
// CLAUDE.md rule 6: the search bias goes to Photon at 2 decimals (geocode.js); «Η θέση μου» shows only when the location
// is already on (no prompt from here), and only the point the user picks is stored, as the place.
import { h, icon } from './ui.js';
import { t, N_ } from './i18n.js';
import { searchPlaces } from './geocode.js';
import { getRecents } from './store.js';
import { getPlaces, setPlace, placeLabel, MAX_CUSTOM } from './places.js';

const SLOT_TITLE = { home: N_('Όρισε το Σπίτι'), work: N_('Όρισε τη Δουλειά') };
const SLOT_NAME = { home: N_('Σπίτι'), work: N_('Δουλειά') };

export function mountPlace(container, ctx, { id = 'new' } = {}) {
  const cur = getPlaces().find((p) => p.id === id) || null;
  const slot = SLOT_NAME[id] ? id : cur ? id : 'new';
  const custom = !SLOT_NAME[slot];
  const customCount = getPlaces().filter((p) => !SLOT_NAME[p.id]).length;
  let dead = false, timer = 0, abort = null, chosen = null, q = '';

  const titleText = slot === 'new' ? t('Νέο μέρος') : SLOT_NAME[slot] ? t(SLOT_TITLE[slot]) : t('Αλλαγή: {name}', { name: placeLabel(cur) });
  const close = () => ctx.navigate('#/');
  const ok = h('button', { type: 'button', class: 'btn round g-circle plc-ok', 'aria-label': t('Αποθήκευση'), title: t('Αποθήκευση'), disabled: true, onclick: save }, icon('check'));
  const head = h('header', { class: 'plc-head' },
    h('div', { class: 'card-head' },
      h('button', { type: 'button', class: 'btn round g-circle', 'aria-label': t('Κλείσιμο'), title: t('Κλείσιμο'), onclick: close }, icon('close')),
      h('h1', { class: 'plc-title card-title' }, titleText),
      ok));

  const nameEl = custom ? h('input', {
    id: 'plc-name', class: 'sb-input plc-name', type: 'text', maxlength: '40', autocomplete: 'off',
    value: cur ? placeLabel(cur) : '', placeholder: t('Όνομα (π.χ. Γυμναστήριο)'), 'aria-label': t('Όνομα'),
  }) : null;
  nameEl?.addEventListener('input', paintOk);

  const input = h('input', {
    id: 'plc-q', class: 'sb-input', type: 'search', enterkeyhint: 'search', autocomplete: 'off', autocapitalize: 'off',
    autocorrect: 'off', spellcheck: 'false', placeholder: t('Αναζήτηση διεύθυνσης ή στάσης'), 'aria-label': t('Αναζήτηση'),
  });
  const list = h('div', { class: 'plc-list', 'aria-live': 'polite' });
  container.replaceChildren(h('section', { class: 'plc-view' }, head,
    nameEl ? h('div', { class: 'sb-field plc-field' }, nameEl) : null,
    h('div', { class: 'sb-field plc-field' }, input), list));

  // A full set of custom places: nothing to add (the home hides its «Νέο» then; a typed link still lands here).
  if (slot === 'new' && customCount >= MAX_CUSTOM) {
    input.disabled = true;
    list.replaceChildren(h('p', { class: 'sr-msg' }, t('Έχεις ήδη 3 δικούς σου τόπους')));
    return { destroy() { dead = true; } };
  }

  function paintOk() {
    ok.disabled = !chosen || (custom && !nameEl.value.trim() && !chosen.name);
  }
  function pick(p, row) {
    chosen = { name: p.name, lat: p.lat, lng: p.lng };
    list.querySelectorAll('.sr[aria-selected="true"]').forEach((r) => r.setAttribute('aria-selected', 'false'));
    row.setAttribute('aria-selected', 'true');
    if (nameEl && !nameEl.value.trim() && p.name) nameEl.value = p.name;
    try { ctx.map?.setMarkers('pin', [{ lat: p.lat, lng: p.lng, kind: 'pin' }]); ctx.map?.flyTo({ lat: p.lat, lng: p.lng }, 16); } catch { /* no map */ }
    paintOk();
    ok.focus({ preventScroll: true });
  }
  function save() {
    if (!chosen) return;
    const name = SLOT_NAME[slot] ? (cur?.name || SLOT_NAME[slot]) : (nameEl.value.trim() || chosen.name || t('Τόπος'));
    const saved = setPlace({ id: slot === 'new' ? undefined : slot, name, lat: chosen.lat, lng: chosen.lng });
    if (!saved) { ctx.toast?.(t('Έχεις ήδη 3 δικούς σου τόπους')); return; }
    ctx.toast?.(t('Αποθηκεύτηκε: {name}', { name: placeLabel(saved) }));
    close();
  }

  const row = (ico, name, sub, p) => {
    const r = h('button', { type: 'button', class: 'sr plc-sr', 'aria-selected': 'false' },
      h('span', { class: 'sr-ico' }, icon(ico)),
      h('span', { class: 'sr-main' }, h('span', { class: 'sr-name' }, name), sub ? h('span', { class: 'sr-sub' }, sub) : null));
    r.addEventListener('click', () => pick(p, r));
    return r;
  };
  const headRow = (text) => h('div', { class: 'sr-head', role: 'presentation' }, text);
  const msg = (text) => h('p', { class: 'sr-msg' }, text);

  // «Προτάσεις»: your location (only when it is already on), then recent places and recent stops.
  function suggestions() {
    const out = [];
    const here = ctx.location?.current;
    if (here && Number.isFinite(here.lat) && Number.isFinite(here.lng)) out.push(row('locate', t('Η θέση μου'), '', { name: t('Η θέση μου'), lat: here.lat, lng: here.lng }));
    for (const p of getRecents('place')) {
      if (out.length >= 6) break;
      if (p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && p.name) out.push(row('history', p.name, p.subtitle || '', p));
    }
    for (const r of getRecents('stop')) {
      if (out.length >= 8) break;
      const s = ctx.data?.stopByCode?.get(String(r?.code ?? r?.id ?? r));
      if (s && Number.isFinite(s.lat) && Number.isFinite(s.lng) && (s.lat || s.lng)) out.push(row('bus', s.displayName, `#${s.code}`, { name: s.displayName, lat: s.lat, lng: s.lng }));
    }
    list.replaceChildren(...(out.length ? [headRow(t('Προτάσεις')), ...out] : []));
  }

  function search() {
    clearTimeout(timer); abort?.abort();
    q = input.value.trim();
    if (q.length < 2) { suggestions(); return; }
    list.replaceChildren(msg(t('Αναζήτηση τόπων…')));
    timer = setTimeout(async () => {
      const my = (abort = new AbortController());
      const text = q;
      try {
        const here = ctx.location?.current;
        let near = here && Number.isFinite(here.lat) ? { lat: here.lat, lng: here.lng } : undefined;
        if (!near) { try { const c = ctx.map?.getCenter?.(); if (c && Number.isFinite(c.lat)) near = { lat: c.lat, lng: c.lng }; } catch { /* no map */ } }
        const found = await searchPlaces(text, { near, signal: my.signal, data: ctx.data });
        if (dead || my.signal.aborted || text !== q) return;
        list.replaceChildren(...(found.length
          ? found.map((p) => row(p.kind === 'stop' ? 'bus' : 'pin', p.name, p.subtitle || '', p))
          : [msg(found.offline ? t('Δεν ήταν δυνατή η αναζήτηση τόπων.') : t('Κανένα αποτέλεσμα'))]));
      } catch (e) { if (!dead && e?.name !== 'AbortError') list.replaceChildren(msg(t('Δεν ήταν δυνατή η αναζήτηση τόπων.'))); }
    }, 300);
  }
  input.addEventListener('input', search);
  suggestions();

  return {
    destroy() { dead = true; clearTimeout(timer); abort?.abort(); container.replaceChildren(); },
  };
}
