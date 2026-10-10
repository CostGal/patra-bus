// Persistent app state (owner: extras): favourites, recents, settings.
// One versioned JSON blob in localStorage; every storage access is guarded and falls back to memory
// (private mode, storage disabled, quota). Other tabs are picked up via the `storage` event.

export const KEY = 'patra-bus:v2';
const LEGACY_FAVS = 'favs'; // v1 (array of stop codes)
const SCHEMA = 2;
const MAX_RECENTS = 10;
const MAX_FAVS = 100;

export const DEFAULT_SETTINGS = Object.freeze({ theme: 'auto', walkSpeed: 'normal', bufferMin: 2, reminderMin: 2, lang: 'auto' });
const intIn = (lo, hi) => (v) => Number.isInteger(v) && v >= lo && v <= hi;
const VALID = {
  theme: (v) => ['auto', 'light', 'dark'].includes(v),
  lang: (v) => ['auto', 'el', 'en'].includes(v),
  walkSpeed: (v) => ['slow', 'normal', 'fast'].includes(v),
  bufferMin: intIn(0, 30),
  reminderMin: intIn(0, 30),
};
const NUMERIC = new Set(['bufferMin', 'reminderMin']);

const defaultStorage = () => { try { return globalThis.localStorage ?? null; } catch { return null; } };
const defaultEvents = () => (typeof globalThis.addEventListener === 'function' ? globalThis : null);

const clone = (x) => JSON.parse(JSON.stringify(x));
const code = (c) => (c == null ? '' : String(c).trim());

// Identity of a recent item: stops by code, places by rounded coordinates (~11 m), else by name.
function recentKey(item) {
  if (item == null) return null;
  if (typeof item !== 'object') return `s:${item}`;
  if (item.stopCode != null) return `s:${item.stopCode}`;
  if (item.code != null) return `s:${item.code}`;
  if (Number.isFinite(item.lat) && Number.isFinite(item.lng)) return `p:${item.lat.toFixed(4)},${item.lng.toFixed(4)}`;
  if (item.name) return `n:${String(item.name).toLowerCase()}`;
  return `j:${JSON.stringify(item)}`;
}

function cleanRecents(list) {
  const out = []; const seen = new Set();
  for (const it of Array.isArray(list) ? list : []) {
    let k; try { k = recentKey(it); } catch { k = null; }
    if (k == null || seen.has(k)) continue;
    seen.add(k); out.push(it);
    if (out.length >= MAX_RECENTS) break;
  }
  return out;
}

function cleanSettings(s) {
  const out = {};
  if (s && typeof s === 'object') for (const [k, v] of Object.entries(s)) if (VALID[k]?.(v)) out[k] = v;
  return out;
}

function sanitize(o) {
  o = o && typeof o === 'object' ? o : {};
  const favs = [...new Set((Array.isArray(o.favorites) ? o.favorites : []).map(code).filter(Boolean))].slice(0, MAX_FAVS);
  return { v: SCHEMA, favorites: favs, recents: { stop: cleanRecents(o.recents?.stop), place: cleanRecents(o.recents?.place) }, settings: cleanSettings(o.settings) };
}

export function createStore({ storage = defaultStorage, events = defaultEvents() } = {}) {
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
      try { state = sanitize(JSON.parse(r.raw)); } catch { state = sanitize(null); }
    }
    return true;
  }

  function emit(kind) {
    for (const fn of [...subs]) { try { fn(kind); } catch { /* one bad listener must not break others */ } }
  }

  const onStorage = (e) => { if ((e.key == null || e.key === KEY) && sync()) emit('all'); };
  events?.addEventListener?.('storage', onStorage);

  // --- favourites ---
  const getFavorites = () => { sync(); return [...state.favorites]; };
  const isFavorite = (c) => { sync(); return state.favorites.includes(code(c)); };
  function addFavorite(c) {
    c = code(c); sync();
    if (!c || state.favorites.includes(c) || state.favorites.length >= MAX_FAVS) return false;
    state.favorites.push(c); save(); emit('favorites'); return true;
  }
  function removeFavorite(c) {
    c = code(c); sync();
    const i = state.favorites.indexOf(c); if (i < 0) return false;
    state.favorites.splice(i, 1); save(); emit('favorites'); return true;
  }
  // Returns the new state (true = now a favourite).
  function toggleFavorite(c) { return isFavorite(c) ? (removeFavorite(c), false) : (addFavorite(c), isFavorite(c)); }
  // delta -1 = up, +1 = down. Returns the new index or -1.
  function moveFavorite(c, delta) {
    c = code(c); sync();
    const from = state.favorites.indexOf(c); if (from < 0) return -1;
    const to = Math.max(0, Math.min(state.favorites.length - 1, from + Math.sign(delta) * Math.max(1, Math.abs(delta | 0))));
    if (to === from) return from;
    state.favorites.splice(from, 1); state.favorites.splice(to, 0, c);
    save(); emit('favorites'); return to;
  }

  // --- recents (newest first, deduped, max 10 per kind) ---
  const kindOf = (k) => (k === 'place' ? 'place' : 'stop');
  const getRecents = (kind) => { sync(); return clone(state.recents[kindOf(kind)]); };
  function addRecent(kind, item) {
    kind = kindOf(kind); sync();
    let copy; try { copy = clone(item); } catch { return; }
    const k = recentKey(copy); if (k == null) return;
    state.recents[kind] = cleanRecents([copy, ...state.recents[kind].filter((x) => recentKey(x) !== k)]);
    save(); emit('recents');
  }
  function removeRecent(kind, item) {
    kind = kindOf(kind); sync();
    const k = recentKey(item), before = state.recents[kind].length;
    state.recents[kind] = state.recents[kind].filter((x) => recentKey(x) !== k);
    if (state.recents[kind].length === before) return false;
    save(); emit('recents'); return true;
  }
  function clearRecents(kind) {
    sync();
    for (const k of kind ? [kindOf(kind)] : ['stop', 'place']) state.recents[k] = [];
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
  function resetSettings() { sync(); state.settings = {}; save(); emit('settings'); }

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
