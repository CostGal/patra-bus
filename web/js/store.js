// Persistent app state (owner: extras): favourites, recents, settings.
// One versioned JSON blob in localStorage; every storage access is guarded and falls back to memory
// (private mode, storage disabled, quota). Other tabs are picked up via the `storage` event.
// Favourites and recents reference stop codes, which collide across cities, so each item carries a `city`
// (schema 3; older blobs are read as Patras). The public getters only ever show the active city's items.
import { DEFAULT_CITY, cityId, isCity } from './cities.js';

export const KEY = 'patra-bus:v2';
const LEGACY_FAVS = 'favs'; // v1 (array of stop codes)
const SCHEMA = 3;
const MAX_RECENTS = 10;
const MAX_FAVS = 100;

// lang defaults to 'el' (TEL-58, #33): the first-run setup (TEL-74, js/setup.js) stores the language the user picks,
// pre-selected from the system language; 'el' only applies to whoever skips that step.
// usageStats: anonymous daily counts are on unless the user switches them off (CLAUDE.md rule 4, js/usage.js).
export const DEFAULT_SETTINGS = Object.freeze({ theme: 'auto', walkSpeed: 'normal', bufferMin: 2, reminderMin: 2, lang: 'el', usageStats: true });
const intIn = (lo, hi) => (v) => Number.isInteger(v) && v >= lo && v <= hi;
const VALID = {
  theme: (v) => ['auto', 'light', 'dark'].includes(v),
  lang: (v) => ['auto', 'el', 'en'].includes(v),
  walkSpeed: (v) => ['slow', 'normal', 'fast'].includes(v),
  bufferMin: intIn(0, 30),
  reminderMin: intIn(0, 30),
  city: isCity, // absent until the user picks one: the default city applies
  guideSeen: (v) => typeof v === 'boolean', // absent = not seen yet
  installHintDismissed: (v) => typeof v === 'boolean', // absent = not dismissed
  welcomeSeen: (v) => typeof v === 'boolean', // absent = the testers' welcome was not shown yet
  legendSeen: (v) => typeof v === 'boolean', // unused since TEL-65 removed the stop-view legend (the first-run setup explains LIVE / ΠΡΟΓΡ. now); kept so stored flags still validate
  setupDone: (v) => typeof v === 'boolean', // absent = the first-run setup (language, city, LIVE / ΠΡΟΓΡ.) was not shown yet
  usageStats: (v) => typeof v === 'boolean',
  usageDay: (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v), // Athens day of the last "open" sent; stays on the device
  usageInstall: (v) => typeof v === 'boolean', // true once the "install" count was sent from this device
};
// Settings that survive "reset settings": the city is a place, the flags only record first-run hints already shown.
// The usage choice and markers survive too: a reset must not switch counting back on or count this device again.
const KEEP_ON_RESET = ['city', 'guideSeen', 'installHintDismissed', 'welcomeSeen', 'legendSeen', 'setupDone', 'usageStats', 'usageDay', 'usageInstall'];
const NUMERIC = new Set(['bufferMin', 'reminderMin']);

const defaultStorage = () => { try { return globalThis.localStorage ?? null; } catch { return null; } };
const defaultEvents = () => (typeof globalThis.addEventListener === 'function' ? globalThis : null);

const clone = (x) => JSON.parse(JSON.stringify(x));
const code = (c) => (c == null ? '' : String(c).trim());

// Items saved before multi-city (no `city`) belong to Patras.
const cityOf = (x) => (x && typeof x === 'object' && isCity(x.city) ? x.city : DEFAULT_CITY);

// Identity of a recent item: stops by code, places by rounded coordinates (~11 m), else by name; always per city.
function recentKey(item) {
  if (item == null) return null;
  if (typeof item !== 'object') return `${DEFAULT_CITY}|s:${item}`;
  const c = cityOf(item);
  if (item.stopCode != null) return `${c}|s:${item.stopCode}`;
  if (item.code != null) return `${c}|s:${item.code}`;
  if (Number.isFinite(item.lat) && Number.isFinite(item.lng)) return `${c}|p:${item.lat.toFixed(4)},${item.lng.toFixed(4)}`;
  if (item.name) return `${c}|n:${String(item.name).toLowerCase()}`;
  return `${c}|j:${JSON.stringify(item)}`;
}

// Newest first, deduped, at most MAX_RECENTS per city. Bare codes become `{ code }`; every item ends up with a `city`.
function cleanRecents(list) {
  const out = []; const seen = new Set(); const per = {};
  for (let it of Array.isArray(list) ? list : []) {
    if (it != null && typeof it !== 'object') it = { code: String(it) };
    let k; try { k = recentKey(it); } catch { k = null; }
    if (k == null || seen.has(k)) continue;
    const c = cityOf(it);
    if ((per[c] ?? 0) >= MAX_RECENTS) continue;
    seen.add(k); per[c] = (per[c] ?? 0) + 1;
    out.push({ ...it, city: c });
  }
  return out;
}

function cleanSettings(s) {
  const out = {};
  if (s && typeof s === 'object') for (const [k, v] of Object.entries(s)) if (VALID[k]?.(v)) out[k] = v;
  return out;
}

// Favourites: [{ code, city }], deduped, at most MAX_FAVS per city. Schema <= 2 stored bare code strings (Patras).
function cleanFavorites(list) {
  const out = []; const seen = new Set(); const per = {};
  for (const f of Array.isArray(list) ? list : []) {
    const c = cityOf(f), cd = code(f && typeof f === 'object' ? f.code : f);
    const k = `${c}|${cd}`;
    if (!cd || seen.has(k) || (per[c] ?? 0) >= MAX_FAVS) continue;
    seen.add(k); per[c] = (per[c] ?? 0) + 1;
    out.push({ code: cd, city: c });
  }
  return out;
}

export function sanitize(o) {
  o = o && typeof o === 'object' ? o : {};
  return { v: SCHEMA, favorites: cleanFavorites(o.favorites), recents: { stop: cleanRecents(o.recents?.stop), place: cleanRecents(o.recents?.place) }, settings: cleanSettings(o.settings) };
}

// `city` = which city the getters show (injectable for tests).
export function createStore({ storage = defaultStorage, events = defaultEvents(), city = cityId } = {}) {
  let state = sanitize(null);
  let lastRaw; // undefined = never read; null = key absent; string = last blob we saw/wrote
  const subs = new Set();

  const readRaw = () => { try { const s = storage(); return s ? { ok: true, raw: s.getItem(KEY) } : { ok: false }; } catch { return { ok: false }; } };

  function legacyFavorites() {
    try {
      const s = storage(); if (!s) return [];
      const a = JSON.parse(s.getItem(LEGACY_FAVS));
      return Array.isArray(a) ? a : [];
    } catch { return []; }
  }

  function save() {
    const raw = JSON.stringify(state);
    try { const s = storage(); if (s) { s.setItem(KEY, raw); lastRaw = raw; } } catch { /* memory only */ }
  }

  // Pull fresh state from storage if it changed (other tab). Returns true when state was replaced.
  function sync() {
    const r = readRaw();
    if (!r.ok || r.raw === lastRaw) return false;
    const first = lastRaw === undefined;
    lastRaw = r.raw;
    if (r.raw == null) {
      const legacy = first ? legacyFavorites() : [];
      state = sanitize({ favorites: legacy });
      if (legacy.length) { // one-time migration of the v1 `favs` key; drop it only once the new blob is readable
        save();
        const back = readRaw();
        if (back.ok && back.raw === lastRaw) { try { storage().removeItem(LEGACY_FAVS); } catch { /* ignore */ } }
      }
    } else {
      let o = null;
      try { o = JSON.parse(r.raw); } catch { /* corrupt: start empty */ }
      state = sanitize(o);
      // One-time migration to schema 3: persist the city tags now, so other readers of the blob see them too.
      if (o && typeof o === 'object' && o.v !== SCHEMA) save();
    }
    return true;
  }

  function emit(kind) {
    for (const fn of [...subs]) { try { fn(kind); } catch { /* one bad listener must not break others */ } }
  }

  const onStorage = (e) => { if ((e.key == null || e.key === KEY) && sync()) emit('all'); };
  events?.addEventListener?.('storage', onStorage);

  // --- favourites (active city only; other cities' items are kept untouched) ---
  const mine = () => state.favorites.filter((f) => f.city === city());
  const getFavorites = () => { sync(); return mine().map((f) => f.code); };
  const isFavorite = (c) => { sync(); return mine().some((f) => f.code === code(c)); };
  function addFavorite(c) {
    c = code(c); sync();
    const m = mine();
    if (!c || m.some((f) => f.code === c) || m.length >= MAX_FAVS) return false;
    state.favorites.push({ code: c, city: city() }); save(); emit('favorites'); return true;
  }
  function removeFavorite(c) {
    c = code(c); sync();
    const i = state.favorites.findIndex((f) => f.city === city() && f.code === c); if (i < 0) return false;
    state.favorites.splice(i, 1); save(); emit('favorites'); return true;
  }
  // Returns the new state (true = now a favourite).
  function toggleFavorite(c) { return isFavorite(c) ? (removeFavorite(c), false) : (addFavorite(c), isFavorite(c)); }
  // delta -1 = up, +1 = down. Returns the new index or -1.
  function moveFavorite(c, delta) {
    c = code(c); sync();
    const m = mine();
    const from = m.findIndex((f) => f.code === c); if (from < 0) return -1;
    const to = Math.max(0, Math.min(m.length - 1, from + Math.sign(delta) * Math.max(1, Math.abs(delta | 0))));
    if (to === from) return from;
    const [it] = m.splice(from, 1); m.splice(to, 0, it);
    state.favorites = [...state.favorites.filter((f) => f.city !== city()), ...m];
    save(); emit('favorites'); return to;
  }

  // --- recents (newest first, deduped, max 10 per kind and city; the getters show the active city) ---
  const kindOf = (k) => (k === 'place' ? 'place' : 'stop');
  const getRecents = (kind) => { sync(); return clone(state.recents[kindOf(kind)].filter((x) => x.city === city())); };
  const asItem = (x) => (x != null && typeof x !== 'object' ? { code: String(x) } : x);
  function addRecent(kind, item) {
    kind = kindOf(kind); sync();
    let copy; try { copy = asItem(clone(item)); } catch { return; }
    if (copy == null) return;
    copy.city = city();
    const k = recentKey(copy); if (k == null) return;
    state.recents[kind] = cleanRecents([copy, ...state.recents[kind].filter((x) => recentKey(x) !== k)]);
    save(); emit('recents');
  }
  function removeRecent(kind, item) {
    kind = kindOf(kind); sync();
    const probe = asItem(item);
    if (probe == null) return false;
    const k = recentKey({ ...probe, city: city() }), before = state.recents[kind].length;
    state.recents[kind] = state.recents[kind].filter((x) => recentKey(x) !== k);
    if (state.recents[kind].length === before) return false;
    save(); emit('recents'); return true;
  }
  // Clears the active city's recents only.
  function clearRecents(kind) {
    sync();
    for (const k of kind ? [kindOf(kind)] : ['stop', 'place']) state.recents[k] = state.recents[k].filter((x) => x.city !== city());
    save(); emit('recents');
  }

  // --- settings ---
  const getSettings = () => { sync(); return { ...DEFAULT_SETTINGS, ...state.settings }; };
  // Returns true when the value is valid (numeric strings from <select> are coerced); unknown keys are rejected.
  function setSetting(key, value) {
    if (!VALID[key]) return false;
    if (NUMERIC.has(key) && typeof value === 'string' && value.trim() !== '') value = Number(value);
    if (!VALID[key](value)) return false;
    sync();
    if (getSettings()[key] !== value) { state.settings[key] = value; save(); emit('settings'); }
    return true;
  }
  // The city and the first-run hint flags are not preferences: they survive "reset settings".
  function resetSettings() {
    sync();
    const kept = {};
    for (const k of KEEP_ON_RESET) if (k in state.settings) kept[k] = state.settings[k];
    state.settings = kept; save(); emit('settings');
  }

  function clearAll() {
    state = sanitize(null);
    try { const s = storage(); if (s) { s.removeItem(KEY); s.removeItem(LEGACY_FAVS); lastRaw = null; } } catch { /* ignore */ }
    emit('all');
  }

  function onChange(fn) { subs.add(fn); return () => subs.delete(fn); }
  function dispose() { events?.removeEventListener?.('storage', onStorage); subs.clear(); }

  return { getFavorites, isFavorite, addFavorite, removeFavorite, toggleFavorite, moveFavorite,
    getRecents, addRecent, removeRecent, clearRecents, getSettings, setSetting, resetSettings, clearAll, onChange, dispose };
}

const store = createStore();
export const { getFavorites, isFavorite, addFavorite, removeFavorite, toggleFavorite, moveFavorite,
  getRecents, addRecent, removeRecent, clearRecents, getSettings, setSetting, resetSettings, clearAll, onChange } = store;

// 'auto' → follows the OS. Returns 'light' | 'dark'.
export function resolveTheme(theme = getSettings().theme) {
  if (theme === 'light' || theme === 'dark') return theme;
  try { return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; } catch { return 'light'; }
}
// Sets <html data-theme> (tokens.css); 'auto' removes it so the media query decides. Returns the resolved theme.
export function applyTheme(theme = getSettings().theme) {
  try {
    const root = globalThis.document?.documentElement;
    if (root) { if (theme === 'light' || theme === 'dark') root.dataset.theme = theme; else delete root.dataset.theme; }
  } catch { /* ignore */ }
  return resolveTheme(theme);
}
