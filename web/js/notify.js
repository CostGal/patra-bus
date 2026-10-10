// Reminders (owner: extras). In-app toast + vibration at the due time, plus a system notification when
// permission was granted. Everything runs in the page: reminders only fire while the app is open
// (foreground or background tab). Pending ones are persisted so a reload re-arms them.
import { toast } from './ui.js';

const KEY = 'patra-bus:reminders';
const GRACE_MS = 2 * 60 * 1000; // a reminder this late is still useful; later than that it would mislead
const TICK_MAX_MS = 30 * 1000; // re-check at least this often (throttled timers, sleep, clock changes)

const defaultStorage = () => { try { return globalThis.localStorage ?? null; } catch { return null; } };

// Pure scheduling core; `onFire` and the timer/clock/storage are injectable (tests).
export function createReminders({ storage = defaultStorage, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, onFire = () => {}, events = null } = {}) {
  let map = new Map(); // tag -> { id, tag, at, title, body, url }
  let lastRaw; // undefined = never read
  let timer = null;
  let seq = 0;
  const subs = new Set();

  const readRaw = () => { try { const s = storage(); return s ? { ok: true, raw: s.getItem(KEY) } : { ok: false }; } catch { return { ok: false }; } };
  function parse(raw) {
    const m = new Map();
    try {
      for (const r of JSON.parse(raw)?.items ?? []) {
        if (r && typeof r.tag === 'string' && Number.isFinite(r.at)) m.set(r.tag, { id: String(r.id ?? r.at), tag: r.tag, at: r.at, title: String(r.title ?? ''), body: String(r.body ?? ''), url: r.url ? String(r.url) : undefined });
      }
    } catch { /* corrupt → empty */ }
    return m;
  }
  function write() {
    try {
      const s = storage(); if (!s) return;
      if (!map.size) { s.removeItem(KEY); lastRaw = null; return; }
      const raw = JSON.stringify({ v: 1, items: [...map.values()] });
      s.setItem(KEY, raw); lastRaw = raw;
    } catch { /* memory only */ }
  }
  // Storage is the source of truth when available (other tabs); returns true if our view changed.
  function sync() {
    const r = readRaw();
    if (!r.ok || r.raw === lastRaw) return false;
    lastRaw = r.raw;
    map = r.raw == null ? new Map() : parse(r.raw);
    return true;
  }
  const emit = () => { for (const fn of [...subs]) { try { fn(list()); } catch { /* ignore */ } } };
  const list = () => [...map.values()].sort((a, b) => a.at - b.at).map(({ id, ...r }) => ({ ...r }));

  function arm() {
    if (timer != null) { clearTimer(timer); timer = null; }
    if (!map.size) return;
    const next = Math.min(...[...map.values()].map((r) => r.at));
    timer = setTimer(tick, Math.max(0, Math.min(next - now(), TICK_MAX_MS)));
  }

  function tick() {
    timer = null;
    const changed = sync();
    const t = now();
    const due = [...map.values()].filter((r) => r.at <= t).sort((a, b) => a.at - b.at);
    for (const r of due) map.delete(r.tag);
    if (due.length) write();
    for (const r of due) if (t - r.at <= GRACE_MS) { try { onFire(r); } catch { /* ignore */ } }
    arm();
    if (due.length || changed) emit();
  }

  function scheduleReminder({ at, title, body = '', tag, url } = {}) {
    at = Number(at);
    if (!Number.isFinite(at)) throw new TypeError('scheduleReminder: `at` must be epoch milliseconds');
    tag = tag ? String(tag) : `r-${now()}-${seq}`;
    if (at < now() - GRACE_MS) return { tag, at, dropped: true, cancel() {} }; // too late to be useful: not scheduled
    sync();
    const id = `${now()}-${seq++}`;
    map.set(tag, { id, tag, at, title: String(title ?? ''), body: String(body ?? ''), url: url ? String(url) : undefined }); // same tag replaces
    write(); arm(); emit();
    return { tag, at, cancel() { sync(); if (map.get(tag)?.id === id) cancelReminder(tag); } };
  }
  function cancelReminder(tag) {
    sync();
    if (!map.delete(String(tag))) return false;
    write(); arm(); emit(); return true;
  }
  function cancelAll() { sync(); const had = map.size > 0; map.clear(); write(); arm(); if (had) emit(); }
  const listReminders = () => { sync(); return list(); };
  const hasReminder = (tag) => { sync(); return map.has(String(tag)); };
  function onRemindersChange(fn) { subs.add(fn); return () => subs.delete(fn); }
  // (Re)load persisted reminders and arm the timer. Call once at startup.
  function start() { lastRaw = undefined; sync(); tick(); }

  events?.addEventListener?.('storage', (e) => { if (e.key == null || e.key === KEY) { if (sync()) { arm(); emit(); } } });
  return { scheduleReminder, cancelReminder, cancelAll, listReminders, hasReminder, onRemindersChange, tick, start };
}

// ---- browser delivery ----

export function permissionState() {
  try { return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission; } catch { return 'unsupported'; }
}

// Must be called from a user gesture (button click). Resolves true when notifications are allowed.
export async function ensurePermission() {
  const p = permissionState();
  if (p === 'granted') return true;
  if (p !== 'default') return false;
  try {
    const res = await new Promise((resolve, reject) => { // old Safari uses a callback
      const r = Notification.requestPermission(resolve);
      if (r && typeof r.then === 'function') r.then(resolve, reject);
    });
    return res === 'granted';
  } catch { return false; }
}

const absUrl = (u) => { try { return u ? new URL(u, location.href).href : new URL('./', document.baseURI).href; } catch { return undefined; } };
const asset = (p) => { try { return new URL(p, document.baseURI).href; } catch { return undefined; } };

async function showSystem(r) {
  if (permissionState() !== 'granted') return;
  const opts = { body: r.body, tag: r.tag, renotify: true, icon: asset('icons/icon-192.png'), badge: asset('icons/icon-192.png'), vibrate: [200, 100, 200], data: { url: absUrl(r.url) } };
  try { // preferred: works on Android Chrome and keeps the click handler in sw.js
    const reg = await navigator.serviceWorker?.getRegistration?.();
    if (reg?.showNotification) { await reg.showNotification(r.title, opts); return; }
  } catch { /* fall through */ }
  try {
    const n = new Notification(r.title, { body: r.body, tag: r.tag, icon: opts.icon });
    n.onclick = () => { try { window.focus(); if (r.url) location.href = absUrl(r.url); n.close(); } catch { /* ignore */ } };
  } catch { /* unsupported */ }
}

function deliver(r) {
  const text = r.body ? `${r.title} · ${r.body}` : r.title;
  const href = r.url && String(r.url).startsWith('#') ? r.url : null;
  try { toast(text, { ms: 12000, action: href ? { label: 'Άνοιγμα', onClick: () => { location.hash = href; } } : undefined }); } catch { /* ignore */ }
  try { navigator.vibrate?.([200, 100, 200]); } catch { /* ignore */ }
  showSystem(r).catch(() => {});
}

const reminders = createReminders({ onFire: deliver, events: typeof globalThis.addEventListener === 'function' ? globalThis : null });
export const { scheduleReminder, cancelReminder, cancelAll, listReminders, hasReminder, onRemindersChange } = reminders;

// Re-arm persisted reminders on load, and re-check when the page comes back (timers are throttled in the background).
reminders.start();
try {
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reminders.tick(); });
  globalThis.addEventListener('pageshow', () => reminders.tick());
  globalThis.addEventListener('online', () => reminders.tick());
} catch { /* not in a browser */ }
