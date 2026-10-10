// Web Push client (owner: push client). Lets reminders reach the phone with the app closed.
// Contract in docs/ARCHITECTURE.md (Round 2 → PC / PW). The server only ever receives the push address
// (the PushSubscription) plus each reminder's time/text; nothing is stored beyond the reminder itself.
// Everything is best-effort: no function here throws to its caller.
import { h } from './ui.js';
import { API_BASE } from './api.js';

export const FLAG_KEY = 'patra-bus:push'; // '1' once the user enabled push on this device
export const CANCEL_KEY = 'patra-bus:push-cancel'; // server ids whose DELETE failed (retried later)
const HTTP_MS = 8000;
const SW_READY_MS = 6000;
const MAX_AHEAD_MS = 3 * 60 * 60 * 1000; // server accepts reminders at most 3 h ahead
const MAX_PENDING_CANCELS = 20;
const CAP = { title: 100, body: 300, tag: 100, url: 500 };

const clip = (v, n) => String(v ?? '').slice(0, n);

// base64url (VAPID public key) → bytes for applicationServerKey
export function urlBase64ToBytes(s) {
  const b64 = String(s).replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(String(s).length / 4) * 4, '=');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const sameBytes = (a, b) => {
  if (!a || !b) return false;
  const x = new Uint8Array(a); const y = new Uint8Array(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

// Body of POST /api/push/reminders (pure; exported for tests).
export function buildReminderBody(subscription, p) {
  const body = { subscription, at: Math.round(Number(p.at)), title: clip(p.title, CAP.title), body: clip(p.body, CAP.body), tag: clip(p.tag, CAP.tag), url: clip(p.url, CAP.url) };
  const t = p.trip;
  if (t && typeof t === 'object') {
    body.trip = {
      stopCode: String(t.stopCode ?? ''), routeCode: String(t.routeCode ?? ''), lineCode: String(t.lineCode ?? ''),
      vehicleCode: t.vehicleCode ? String(t.vehicleCode) : null, offsetSec: Math.round(Number(t.offsetSec) || 0),
    };
    if (t.stopName) body.trip.stopName = clip(t.stopName, 80);
  }
  if (p.kind === 'alight') body.kind = 'alight'; // server defaults to 'leave'
  return body;
}

// `o` overrides the browser environment (tests): nav, win, storage, fetch, apiBase, now, baseURI.
export function createPush(o = {}) {
  const env = () => {
    const g = globalThis;
    let storage = null;
    try { storage = o.storage !== undefined ? o.storage : g.localStorage ?? null; } catch { storage = null; }
    return {
      nav: o.nav ?? g.navigator, win: o.win ?? g, storage,
      fetch: o.fetch ?? ((...a) => g.fetch(...a)),
      apiBase: o.apiBase ?? API_BASE, now: o.now ?? Date.now,
      baseURI: o.baseURI ?? (typeof document !== 'undefined' ? document.baseURI : 'http://localhost/'),
    };
  };
  const store = {
    get(k) { try { return env().storage?.getItem(k) ?? null; } catch { return null; } },
    set(k, v) { try { env().storage?.setItem(k, v); } catch { /* memory only */ } },
    del(k) { try { env().storage?.removeItem(k); } catch { /* ignore */ } },
  };
  let memFlag = false; // when storage is unavailable the flag still holds for this page's lifetime
  let lastError = null;
  const subs = new Set();

  function isPushSupported() {
    const { nav, win } = env();
    return !!nav && 'serviceWorker' in nav && 'PushManager' in win && 'Notification' in win;
  }
  const isIos = (nav) => /iPad|iPhone|iPod/.test(nav?.userAgent || '') || (nav?.platform === 'MacIntel' && (nav?.maxTouchPoints ?? 0) > 1);
  const isStandalone = ({ nav, win }) => {
    if (nav?.standalone === true) return true;
    try { return !!win.matchMedia?.('(display-mode: standalone)')?.matches; } catch { return false; }
  };
  const flagged = () => memFlag || store.get(FLAG_KEY) === '1';

  // 'unsupported' | 'needs-install' (iOS/iPadOS Safari outside the installed app) | 'denied' | 'off' | 'on'
  function pushState() {
    const e = env();
    if (!isPushSupported()) return isIos(e.nav) && !isStandalone(e) ? 'needs-install' : 'unsupported';
    const perm = e.win.Notification.permission;
    if (perm === 'denied') return 'denied';
    return perm === 'granted' && flagged() ? 'on' : 'off';
  }
  const emit = () => { const s = pushState(); for (const fn of [...subs]) { try { fn(s); } catch { /* ignore */ } } };
  function onPushChange(fn) { subs.add(fn); return () => subs.delete(fn); }
  function setFlag(on) {
    memFlag = on;
    if (on) store.set(FLAG_KEY, '1'); else store.del(FLAG_KEY);
  }

  async function http(path, init = {}) {
    const e = env();
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(() => ctl?.abort(), HTTP_MS);
    try { return await e.fetch(`${e.apiBase}${path}`, { ...init, signal: ctl?.signal, cache: 'no-store' }); } finally { clearTimeout(timer); }
  }

  // The service worker registration, or null when there is none (never rejects, never hangs).
  async function registration(ms = SW_READY_MS) {
    try {
      const sw = env().nav.serviceWorker;
      let t;
      const timeout = new Promise((r) => { t = setTimeout(() => r(null), ms); });
      try { return await Promise.race([sw.ready, timeout]); } finally { clearTimeout(t); }
    } catch { return null; }
  }
  const currentSub = async (ms) => { try { return (await (await registration(ms))?.pushManager.getSubscription()) ?? null; } catch { return null; } };

  function requestPermission() {
    const N = env().win.Notification;
    return new Promise((resolve) => {
      try {
        const r = N.requestPermission(resolve); // old Safari: callback form
        if (r && typeof r.then === 'function') r.then(resolve, () => resolve('default'));
      } catch { resolve('default'); }
    });
  }

  // Must run inside a user gesture (button click): nothing is awaited before the permission prompt.
  // Resolves true when push is on; otherwise false and pushError() says why.
  async function enablePush() {
    lastError = null;
    const st = pushState();
    if (st === 'on') return true;
    if (st !== 'off') { lastError = st; emit(); return false; }
    const e = env();
    let perm = e.win.Notification.permission;
    if (perm !== 'granted') perm = await requestPermission();
    if (perm !== 'granted') { lastError = perm === 'denied' ? 'denied' : 'dismissed'; emit(); return false; }
    try {
      const reg = await registration();
      if (!reg) { lastError = 'no-sw'; emit(); return false; }
      let key;
      try {
        const res = await http('/api/push/key');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        key = urlBase64ToBytes((await res.json()).publicKey);
      } catch { lastError = 'key'; emit(); return false; }
      const old = await reg.pushManager.getSubscription();
      if (old && !sameBytes(old.options?.applicationServerKey, key)) { try { await old.unsubscribe(); } catch { /* ignore */ } } // other key (server rotated)
      await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      setFlag(true);
      emit();
      return true;
    } catch {
      lastError = 'subscribe';
      emit();
      return false;
    }
  }

  async function disablePush() {
    lastError = null;
    setFlag(false);
    emit();
    try { await (await currentSub(2000))?.unsubscribe(); } catch { /* ignore */ }
    return true;
  }

  // Re-checks the real subscription against our flag (the browser can drop it: cleared site data, permission revoked).
  async function syncPushState() {
    if (!isPushSupported() || !flagged()) return pushState();
    if (env().win.Notification.permission !== 'granted') { setFlag(false); emit(); return pushState(); }
    const reg = await registration(2500);
    if (reg && !(await reg.pushManager.getSubscription().catch(() => null))) { setFlag(false); emit(); }
    return pushState();
  }

  // Absolute URL on this origin for the notification click (sw.js resolves relative ones against its scope too).
  const absUrl = (u) => { try { return u ? new URL(u, env().baseURI).href : undefined; } catch { return undefined; } };

  // POST a server reminder for the current subscription. Resolves the server id, or null on ANY failure.
  async function schedulePushReminder(p = {}) {
    try {
      if (pushState() !== 'on') return null;
      const at = Number(p.at); const now = env().now();
      if (!Number.isFinite(at) || at <= now || at - now > MAX_AHEAD_MS) return null;
      const sub = await currentSub();
      if (!sub) { setFlag(false); emit(); return null; }
      const res = await http('/api/push/reminders', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildReminderBody(sub.toJSON(), { ...p, url: absUrl(p.url) })),
      });
      if (!res.ok) return null;
      const id = (await res.json())?.id;
      return id == null || id === '' ? null : String(id);
    } catch { return null; }
  }

  const pendingCancels = () => { try { const a = JSON.parse(store.get(CANCEL_KEY)); return Array.isArray(a) ? a.map(String) : []; } catch { return []; } };
  const savePending = (a) => { if (a.length) store.set(CANCEL_KEY, JSON.stringify(a.slice(-MAX_PENDING_CANCELS))); else store.del(CANCEL_KEY); };

  // DELETE once; true when the server no longer has it (a 4xx other than a transient one counts as gone).
  async function del(id) {
    try { return (await http(`/api/push/reminders/${encodeURIComponent(id)}`, { method: 'DELETE' })).status < 500; } catch { return false; }
  }
  async function cancelPushReminder(id) {
    if (id == null || id === '') return false;
    id = String(id);
    const ok = await del(id);
    if (!ok) { const a = pendingCancels(); if (!a.includes(id)) savePending([...a, id]); }
    return ok;
  }
  let flushing = false;
  // Retry cancellations that failed offline: a cancelled reminder must not fire.
  async function flushPushCancels() {
    if (flushing) return;
    flushing = true;
    try {
      for (const id of pendingCancels()) if (await del(id)) savePending(pendingCancels().filter((x) => x !== id));
    } finally { flushing = false; }
  }

  const pushError = () => lastError;

  return { isPushSupported, pushState, onPushChange, enablePush, disablePush, syncPushState, schedulePushReminder, cancelPushReminder, flushPushCancels, pushError };
}

const real = createPush();
export const { isPushSupported, pushState, onPushChange, enablePush, disablePush, syncPushState, schedulePushReminder, cancelPushReminder, flushPushCancels, pushError } = real;

try {
  globalThis.addEventListener('online', () => { flushPushCancels(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { flushPushCancels(); } });
  flushPushCancels();
} catch { /* not in a browser */ }

// ---- settings card ----

const COPY = {
  unsupported: 'Αυτός ο browser δεν υποστηρίζει ειδοποιήσεις με κλειστή εφαρμογή. Οι υπενθυμίσεις θα εμφανίζονται μόνο όσο η εφαρμογή είναι ανοιχτή.',
  'needs-install': 'Στο iPhone και στο iPad οι ειδοποιήσεις λειτουργούν μόνο από την εγκατεστημένη εφαρμογή. Πάτα «Κοινοποίηση» και μετά «Προσθήκη στην οικ. οθόνη», άνοιξε την εφαρμογή από την οθόνη σου και γύρνα εδώ για να τις ενεργοποιήσεις.',
  denied: 'Οι ειδοποιήσεις είναι μπλοκαρισμένες για αυτό το site. Επέτρεψέ τις από τις ρυθμίσεις του browser (ή της συσκευής) και ξαναδοκίμασε.',
  off: 'Ανενεργές. Ενεργοποίησέ τες για να σε ειδοποιούμε «Ώρα να φύγεις» ακόμα και με κλειστή εφαρμογή ή κλειδωμένη οθόνη.',
  on: 'Ενεργές. Οι υπενθυμίσεις «Ώρα να φύγεις» θα φτάνουν και με κλειστή εφαρμογή.',
};
const ERRORS = {
  dismissed: 'Δεν δόθηκε άδεια. Πάτα ξανά «Ενεργοποίηση» όταν θέλεις.',
  denied: COPY.denied,
  key: 'Δεν μπόρεσα να επικοινωνήσω με τον server. Έλεγξε τη σύνδεσή σου και ξαναδοκίμασε.',
  'no-sw': 'Η εφαρμογή δεν είναι έτοιμη για ειδοποιήσεις ακόμα. Ξαναφόρτωσε τη σελίδα και δοκίμασε πάλι.',
  subscribe: 'Ο browser δεν επέτρεψε την εγγραφή. Ξαναδοκίμασε σε λίγο.',
};

export function mountPushCard(container, ctx = {}, api = real) {
  let dead = false;
  let busy = false;
  const state = h('p', { class: 'set-p push-state', 'aria-live': 'polite' });
  const err = h('p', { class: 'ex-sub push-error', role: 'alert', hidden: true });
  const btn = h('button', { type: 'button', class: 'ex-btn push-btn' });
  // No border of its own: settings wraps every module in its own titled card.
  const card = h('section', { class: 'push-card' },
    h('h3', { class: 'set-sub push-title' }, 'Ειδοποιήσεις με κλειστή εφαρμογή'),
    state, err,
    h('div', { class: 'set-actions' }, btn),
    h('p', { class: 'ex-sub push-fine' },
      'Πώς δουλεύει: η ειδοποίηση περνά από την υπηρεσία push του browser σου (Google, Apple ή Mozilla). ',
      'Στον server μας στέλνεται μόνο η διεύθυνση push αυτής της συσκευής και, για κάθε υπενθύμιση, η ώρα και η γραμμή. ',
      'Διαγράφονται μόλις σταλεί η ειδοποίηση ή την ακυρώσεις. Δεν αποθηκεύουμε τη θέση σου ούτε προφίλ.'));

  function render() {
    if (dead) return;
    const s = api.pushState();
    state.textContent = COPY[s];
    const e = busy ? null : api.pushError();
    err.hidden = !(e && ERRORS[e] && s !== 'denied');
    err.textContent = err.hidden ? '' : ERRORS[e];
    btn.hidden = s !== 'off' && s !== 'on';
    btn.textContent = busy ? 'Μισό λεπτό…' : s === 'on' ? 'Απενεργοποίηση' : 'Ενεργοποίηση';
    btn.disabled = busy;
    btn.classList.toggle('ex-btn-danger', s === 'on');
  }

  btn.addEventListener('click', async () => {
    if (busy) return;
    const turningOn = api.pushState() !== 'on';
    busy = true; render();
    let ok = false;
    try { ok = turningOn ? await api.enablePush() : await api.disablePush(); } catch { ok = false; }
    busy = false; render();
    if (ok) { try { ctx.toast?.(turningOn ? 'Οι ειδοποιήσεις ενεργοποιήθηκαν' : 'Οι ειδοποιήσεις απενεργοποιήθηκαν'); } catch { /* ignore */ } }
  });

  const off = api.onPushChange?.(() => render());
  container.replaceChildren(card);
  render();
  Promise.resolve(api.syncPushState?.()).then(render, () => {});
  return { destroy() { dead = true; off?.(); card.remove(); } };
}
