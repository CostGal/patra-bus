// Weekly "when to leave" routines (owner: places). Booked on the push server (POST /api/push/routines), mirrored locally.
// Contract: docs/ARCHITECTURE.md Round 3 (P + W). The server only gets the push address, days/time and the boarding trip;
// the notification link is an opaque `#/notif?routine=<ref>` (notif-link.js), never the place's coordinates or name.
import { h, icon } from './ui.js';
import { t, N_ } from './i18n.js';
import { API_BASE } from './api.js';
import { jsonStore, getPlaces, onPlacesChange, placeLabel } from './places.js';
import { planTrips, reminderTrip } from './planner.js';
import { pushState, onPushChange, enablePush, syncPushState } from './push.js';
import { titleCase } from './text.js';
import { DEFAULT_CITY, cityId, isCity } from './cities.js';
import { isPrivateUrl, newRef, notifHash } from './notif-link.js';

export const KEY = 'patra-bus:routines';
export const CANCEL_KEY = 'patra-bus:routines-cancel'; // server ids whose DELETE failed (retried later)
export const MAX_ROUTINES = 6;
export const TZ = 'Europe/Athens';
export const LEADS = [2, 5, 10, 15];
const DEFAULT_LEAD = 5;
const HTTP_MS = 8000;
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]; // Monday first; 0 = Κυριακή
const DAY_NAMES = { 0: N_('Κυρ'), 1: N_('Δευ'), 2: N_('Τρί'), 3: N_('Τετ'), 4: N_('Πέμ'), 5: N_('Παρ'), 6: N_('Σάβ') };

// ---------------------------------------------------------------- pure helpers

export function normDays(days) {
  const set = new Set((Array.isArray(days) ? days : []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6));
  return DAY_ORDER.filter((d) => set.has(d));
}
export const validTime = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s));

// [1,2,3,4,5] → "Δευ–Παρ"; all → "Κάθε μέρα"; [1,3] → "Δευ, Τετ". Runs of 3+ are collapsed.
export function daysLabel(days) {
  const ds = normDays(days);
  if (!ds.length) return '';
  if (ds.length === 7) return t('Κάθε μέρα');
  const runs = [];
  for (const d of ds) {
    const i = DAY_ORDER.indexOf(d);
    const last = runs.at(-1);
    if (last && last.endI === i - 1) { last.endI = i; last.end = d; } else runs.push({ start: d, end: d, endI: i });
  }
  return runs.map((r) => (r.endI - DAY_ORDER.indexOf(r.start) >= 2 ? `${t(DAY_NAMES[r.start])}–${t(DAY_NAMES[r.end])}` : r.start === r.end ? t(DAY_NAMES[r.start]) : `${t(DAY_NAMES[r.start])}, ${t(DAY_NAMES[r.end])}`)).join(', ');
}
export const routineLabel = (r, placeName) => `${daysLabel(r.days)} ${r.time} → ${placeName}`;

// The boarding part of an itinerary, for the server to re-check. Null when there is no bus to board.
export function tripFromItinerary(it, stopName = '') {
  if (!it?.board || !it?.route) return null;
  const { stopCode, routeCode, lineCode, offsetSec } = reminderTrip(it);
  const trip = { stopCode: String(stopCode), routeCode: String(routeCode), lineCode: String(lineCode), offsetSec: Math.max(0, offsetSec | 0) };
  if (stopName) trip.stopName = String(stopName).slice(0, 80);
  return trip;
}

// Body of POST /api/push/routines. Returns null when anything required is missing or malformed.
export function buildRoutinePayload({ subscription, days, time, title = '', url = '', trip, leadMin = DEFAULT_LEAD, city = cityId() }) {
  const ds = normDays(days);
  if (!subscription?.endpoint || !ds.length || !validTime(time) || !trip?.stopCode || !trip?.routeCode) return null;
  const body = {
    subscription, days: ds, time, tz: TZ, title: String(title).slice(0, 100), url: isPrivateUrl(url) ? '' : String(url).slice(0, 500), city: isCity(city) ? city : DEFAULT_CITY,
    trip: { stopCode: String(trip.stopCode), routeCode: String(trip.routeCode), lineCode: String(trip.lineCode ?? ''), offsetSec: Math.max(0, Math.round(Number(trip.offsetSec) || 0)) },
    leadMin: Math.min(30, Math.max(0, Math.round(Number(leadMin)) || 0)),
  };
  if (trip.stopName) body.trip.stopName = String(trip.stopName).slice(0, 80);
  return body;
}

// Local mirror of a booked routine (`id` is the server id, `ref` the one in its notification link).
export function cleanRoutine(r) {
  if (!r || typeof r !== 'object' || !r.id || !r.trip?.stopCode || !validTime(r.time)) return null;
  const days = normDays(r.days);
  if (!days.length) return null;
  return {
    id: String(r.id), days, time: r.time, placeId: String(r.placeId ?? ''), placeName: String(r.placeName ?? '').slice(0, 40),
    trip: { ...r.trip }, leadMin: Math.min(30, Math.max(0, Math.round(Number(r.leadMin)) || 0)),
    city: isCity(r.city) ? r.city : DEFAULT_CITY, // older routines: Patras
    ...(r.ref ? { ref: String(r.ref).slice(0, 40) } : {}), // older routines: none (their link is the old plan URL)
  };
}

// ---------------------------------------------------------------- store + server

// Routines are per city: getRoutines() shows the active city's, writes keep the other cities' untouched.
export function createRoutines({ storage, fetchFn, apiBase = API_BASE, city = cityId } = {}) {
  const kv = jsonStore(KEY, { storage });
  const cancels = jsonStore(CANCEL_KEY, { storage });
  const subs = new Set();
  const doFetch = (...a) => (fetchFn || globalThis.fetch)(...a);
  const emit = () => { for (const fn of [...subs]) { try { fn(); } catch { /* ignore */ } } };
  const all = () => (Array.isArray(kv.read([])) ? kv.read([]) : []).map(cleanRoutine).filter(Boolean);
  const getRoutines = () => all().filter((r) => r.city === city());

  async function http(path, init = {}) {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(() => ctl?.abort(), HTTP_MS);
    try { return await doFetch(`${apiBase}${path}`, { ...init, signal: ctl?.signal, cache: 'no-store' }); } finally { clearTimeout(timer); }
  }
  const pending = () => { const a = cancels.read([]); return Array.isArray(a) ? a.map(String) : []; };
  const setPending = (a) => cancels.write(a.slice(-20));
  const del = async (id) => { try { return (await http(`/api/push/routines/${encodeURIComponent(id)}`, { method: 'DELETE' })).status < 500; } catch { return false; } };

  return {
    getRoutines,
    onRoutinesChange(fn) { subs.add(fn); return () => subs.delete(fn); },
    // POST; stores locally on success. → { ok: true, routine } | { ok: false, error: 'limit'|'server'|'network' }
    async bookRoutine(payload, meta = {}) {
      if (getRoutines().length >= MAX_ROUTINES) return { ok: false, error: 'limit' };
      let res;
      try {
        res = await http('/api/push/routines', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      } catch { return { ok: false, error: 'network' }; }
      if (!res.ok) return { ok: false, error: 'server' };
      let id = null;
      try { id = (await res.json())?.id; } catch { /* no body */ }
      if (id == null || id === '') return { ok: false, error: 'server' };
      const routine = cleanRoutine({ id, days: payload.days, time: payload.time, trip: payload.trip, leadMin: payload.leadMin, ...meta, city: city() });
      kv.write([...all(), routine]);
      emit();
      return { ok: true, routine };
    },
    // Local removal is immediate; the server DELETE is retried (flushCancels) if it fails.
    async removeRoutine(id) {
      id = String(id);
      kv.write(all().filter((r) => r.id !== id));
      emit();
      if (!(await del(id))) { const a = pending(); if (!a.includes(id)) setPending([...a, id]); return false; }
      return true;
    },
    async flushCancels() {
      for (const id of pending()) if (await del(id)) setPending(pending().filter((x) => x !== id));
    },
  };
}

const real = createRoutines();
export const { getRoutines, onRoutinesChange, bookRoutine, removeRoutine, flushCancels } = real;

try {
  globalThis.addEventListener('online', () => { flushCancels(); });
  flushCancels();
} catch { /* not in a browser */ }

// The browser's current push subscription as JSON (what the server needs), or null.
export async function currentSubscription(ms = 6000) {
  try {
    let timer;
    const timeout = new Promise((r) => { timer = setTimeout(() => r(null), ms); });
    try {
      const reg = await Promise.race([navigator.serviceWorker.ready, timeout]);
      const sub = await reg?.pushManager.getSubscription();
      return sub ? sub.toJSON() : null;
    } finally { clearTimeout(timer); }
  } catch { return null; }
}

// ---------------------------------------------------------------- settings UI

const ERR = {
  'no-place': N_('Όρισε πρώτα έναν τόπο (σπίτι ή δουλειά) στους αγαπημένους τόπους.'),
  'no-days': N_('Διάλεξε τουλάχιστον μία μέρα.'),
  'no-time': N_('Βάλε την ώρα που θέλεις να φύγεις.'),
  'no-start': N_('Δεν ξέρω από πού ξεκινάς. Άνοιξε τη θέση σου ή όρισε πρώτα σπίτι.'),
  'no-route': N_('Δεν βρέθηκε λεωφορείο για αυτή τη διαδρομή.'),
  'no-push': N_('Οι ειδοποιήσεις δεν είναι έτοιμες. Ξαναφόρτωσε τη σελίδα και δοκίμασε πάλι.'),
  limit: N_('Έχεις ήδη τον μέγιστο αριθμό υπενθυμίσεων. Διέγραψε μία πρώτα.'),
  server: N_('Ο server δεν δέχτηκε την υπενθύμιση. Ξαναδοκίμασε σε λίγο.'),
  network: N_('Δεν μπόρεσα να επικοινωνήσω με τον server. Έλεγξε τη σύνδεσή σου.'),
};

export function mountRoutinesSettings(container, ctx = {}) {
  let dead = false, busy = false, error = '';
  const form = { placeId: '', days: [1, 2, 3, 4, 5], time: '07:45', lead: DEFAULT_LEAD, from: 'auto' };
  const root = h('section', { class: 'plc-set plc-routines' });
  container.replaceChildren(root);

  const stopName = (code) => { const s = ctx.data?.stopByCode?.get(code); return s ? titleCase(s.name) : ''; };
  const here = () => { const c = ctx.location?.current; return c && Number.isFinite(c.lat) ? { lat: c.lat, lng: c.lng } : null; };
  // Default start: the other of Σπίτι/Δουλειά when saved (a routine to work starts at home), else where you are.
  function startPoint(places, dest) {
    if (form.from !== 'auto') return form.from === 'here' ? here() : places.find((p) => p.id === form.from) || null;
    const other = places.find((p) => (dest.id === 'work' ? p.id === 'home' : dest.id === 'home' ? p.id === 'work' : false));
    return other || here();
  }

  async function save() {
    if (busy) return;
    const places = getPlaces();
    const dest = places.find((p) => p.id === form.placeId) || places[0];
    const fail = (k) => { busy = false; error = k; render(); };
    if (!dest) return fail('no-place');
    if (!normDays(form.days).length) return fail('no-days');
    if (!validTime(form.time)) return fail('no-time');
    const from = startPoint(places, dest);
    if (!from) return fail('no-start');
    busy = true; error = ''; render();
    try {
      const subscription = await currentSubscription();
      if (!subscription) return fail('no-push');
      const its = await planTrips(ctx, { lat: from.lat, lng: from.lng }, { lat: dest.lat, lng: dest.lng });
      const it = its.find((x) => x.board && x.route);
      const trip = it && tripFromItinerary(it, stopName(it.board.code));
      if (!trip) return fail('no-route');
      // The place stays on the device: the tap resolves `ref` to this routine's place (app.js → notif-link.js).
      const ref = newRef();
      const url = new URL(notifHash({ routine: ref, stop: trip.stopCode }, cityId()), document.baseURI).href;
      const payload = buildRoutinePayload({ subscription, days: form.days, time: form.time, title: t('Ώρα να φύγεις'), url, trip, leadMin: form.lead });
      if (!payload) return fail('no-route');
      const res = await bookRoutine(payload, { placeId: dest.id, placeName: dest.name, ref });
      if (!res.ok) return fail(res.error);
      ctx.toast?.(t('Η υπενθύμιση αποθηκεύτηκε'));
    } catch { return fail('network'); } finally { busy = false; }
    render();
  }

  function pushBlock(state) {
    const msg = {
      off: N_('Οι υπενθυμίσεις χρειάζονται ειδοποιήσεις.'),
      denied: N_('Οι ειδοποιήσεις είναι μπλοκαρισμένες για αυτό το site. Επέτρεψέ τες από τις ρυθμίσεις του browser.'),
      'needs-install': N_('Στο iPhone και στο iPad χρειάζεται η εγκατεστημένη εφαρμογή (Κοινοποίηση → Προσθήκη στην οικ. οθόνη).'),
      unsupported: N_('Αυτός ο browser δεν υποστηρίζει ειδοποιήσεις με κλειστή εφαρμογή.'),
    }[state] || N_('Οι υπενθυμίσεις χρειάζονται ειδοποιήσεις.');
    return h('div', { class: 'plc-push' },
      h('p', { class: 'set-p' }, t(msg)),
      state === 'off' ? h('button', { type: 'button', class: 'btn rect', onclick: async () => { await enablePush(); render(); } }, icon('bell'), t('Ενεργοποίηση ειδοποιήσεων')) : null);
  }

  function formBlock() {
    const places = getPlaces();
    if (!places.length) return h('p', { class: 'ex-sub' }, t(ERR['no-place']));
    if (!places.some((p) => p.id === form.placeId)) form.placeId = (places.find((p) => p.id === 'work') || places[0]).id;
    const dest = places.find((p) => p.id === form.placeId);
    const startOpts = [['auto', t('Αυτόματα')], ...(here() ? [['here', t('Η τρέχουσα θέση')]] : []), ...places.filter((p) => p.id !== dest.id).map((p) => [p.id, placeLabel(p)])];
    const select = (value, opts, onChange, label) => {
      const el = h('select', { class: 'plc-input', 'aria-label': label }, ...opts.map(([v, text]) => h('option', { value: v, selected: String(v) === String(value) }, text)));
      el.addEventListener('change', () => onChange(el.value));
      return el;
    };
    const dayBtns = DAY_ORDER.map((d) => h('button', {
      type: 'button', class: 'plc-day', 'aria-pressed': String(form.days.includes(d)),
      onclick: () => { form.days = form.days.includes(d) ? form.days.filter((x) => x !== d) : [...form.days, d]; render(); },
    }, t(DAY_NAMES[d])));
    const time = h('input', { class: 'plc-input', type: 'time', value: form.time, 'aria-label': t('Ώρα αναχώρησης') });
    time.addEventListener('change', () => { form.time = time.value; });
    return h('div', { class: 'plc-form' },
      h('label', { class: 'plc-field' }, h('span', { class: 'ex-sub' }, t('Προορισμός')), select(form.placeId, places.map((p) => [p.id, placeLabel(p)]), (v) => { form.placeId = v; form.from = 'auto'; render(); }, t('Προορισμός'))),
      h('label', { class: 'plc-field' }, h('span', { class: 'ex-sub' }, t('Ξεκινάς από')), select(form.from, startOpts, (v) => { form.from = v; }, t('Ξεκινάς από'))),
      h('div', { class: 'plc-days', role: 'group', 'aria-label': t('Μέρες') }, ...dayBtns),
      h('div', { class: 'plc-pair' },
        h('label', { class: 'plc-field' }, h('span', { class: 'ex-sub' }, t('Ώρα που θέλεις να φύγεις')), time),
        h('label', { class: 'plc-field' }, h('span', { class: 'ex-sub' }, t('Ειδοποίησέ με')), select(form.lead, LEADS.map((n) => [n, t('{n}′ πριν', { n })]), (v) => { form.lead = Number(v); }, t('Ειδοποίησέ με')))),
      error ? h('p', { class: 'ex-sub plc-error', role: 'alert' }, t(ERR[error] || ERR.server)) : null,
      h('div', { class: 'set-actions' }, h('button', { type: 'button', class: 'btn rect', disabled: busy, onclick: save }, busy ? t('Μισό λεπτό…') : t('Αποθήκευση υπενθύμισης'))));
  }

  function list() {
    const rs = getRoutines();
    if (!rs.length) return null;
    const places = getPlaces();
    return h('div', { class: 'set-list' }, ...rs.map((r) => {
      const p = places.find((x) => x.id === r.placeId);
      const name = p ? placeLabel(p) : r.placeName === 'Σπίτι' || r.placeName === 'Δουλειά' ? t(r.placeName) : r.placeName;
      const meta = [r.trip.lineCode ? t('Λεωφορείο {line}', { line: r.trip.lineCode }) : '', r.trip.stopName || '', t('{n}′ πριν', { n: r.leadMin })].filter(Boolean).join(' · ');
      return h('div', { class: 'set-item plc-row' },
        h('div', { class: 'set-item-main' }, h('div', { class: 'set-label' }, routineLabel(r, name)), h('span', { class: 'ex-sub' }, meta)),
        h('button', { type: 'button', class: 'btn rect sm destructive', 'aria-label': t('Διαγραφή υπενθύμισης'), onclick: async () => { await removeRoutine(r.id); } }, icon('trash')));
    }));
  }

  function render() {
    if (dead) return;
    const state = pushState();
    root.replaceChildren(...[h('h3', { class: 'set-sub plc-title' }, t('Υπενθυμίσεις εβδομάδας')), list(), state === 'on' ? formBlock() : pushBlock(state)].filter(Boolean));
  }

  const offs = [onPushChange(() => render()), onRoutinesChange(() => render()), onPlacesChange(() => { if (!busy) render(); })];
  render();
  Promise.resolve(syncPushState()).then(render, () => {});
  return { destroy() { dead = true; for (const off of offs) off(); container.replaceChildren(); } };
}
