// Offline map (owner: offline map). Contract in docs/ARCHITECTURE.md (Round 2).
// Opt-in download of the OpenFreeMap tiles around the active city into the cache `patra-bus-map-offline-v1`, which sw.js
// serves from first and never trims. The cache holds ONE city's map at a time (meta.city; older downloads are Patras):
// downloading another city replaces it. Only tiles.openfreemap.org is fetched; live arrivals still need the internet.
import { h, icon } from './ui.js';
import { t, lang, locale } from './i18n.js';
import { CITIES, DEFAULT_CITY, city, cityId, cityName } from './cities.js';

export const OFFLINE_CACHE = 'patra-bus-map-offline-v1';
const HOST = 'https://tiles.openfreemap.org';
export const STYLE_URLS = [`${HOST}/styles/liberty`, `${HOST}/styles/fiord`]; // keep in sync with STYLES in map.js
// The map's minZoom is 8. OpenFreeMap vector tiles end at z14 (z15+ is overzoom of z14), so there is nothing to fetch above.
export const ZOOMS = { min: 8, max: 14 };
// 0-255 Latin, 256-511 Latin Ext-A, 768-1023 Greek (U+0300-03FF), 7936-8191 Greek Extended, 8192-8447 punctuation (– ’ “)
export const GLYPH_RANGES = [[0, 255], [256, 511], [768, 1023], [7936, 8191], [8192, 8447]];
const CONCURRENCY = 4;
const META_URL = () => `${location.origin}/__patra-offline-meta`;
// Rough numbers for the size shown before downloading (measured 2026-10-10: 276 tiles = 6,3 MB, 15 glyph files = 1,4 MB, sprites = 0,2 MB)
const EST = { tile: 23e3, glyph: 90e3, sprite: 224e3, fontStacks: 3 };

// ---------- pure helpers (tested in tests/offline.test.mjs) ----------
export const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
export const lat2y = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};

export function tileRange(bbox, z) {
  const max = 2 ** z - 1;
  const c = (v) => Math.min(max, Math.max(0, v));
  return { x0: c(lon2x(bbox.west, z)), x1: c(lon2x(bbox.east, z)), y0: c(lat2y(bbox.north, z)), y1: c(lat2y(bbox.south, z)) };
}

export function tileCount(bbox, zmin, zmax) {
  let n = 0;
  for (let z = zmin; z <= zmax; z++) {
    const r = tileRange(bbox, z);
    n += (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1);
  }
  return n;
}

export function tileList(bbox, zmin, zmax) {
  const out = [];
  for (let z = zmin; z <= zmax; z++) {
    const r = tileRange(bbox, z);
    for (let x = r.x0; x <= r.x1; x++) for (let y = r.y0; y <= r.y1; y++) out.push({ z, x, y });
  }
  return out;
}

export const tileUrl = (template, { z, x, y }) => template.replace('{z}', z).replace('{x}', x).replace('{y}', y);

// Font stacks a style asks glyphs for, as the joined `{fontstack}` value ("A,B"), sorted.
export function fontStacks(style) {
  const out = new Set();
  const add = (v) => {
    if (Array.isArray(v) && v[0] === 'literal') v = v[1];
    if (Array.isArray(v) && v.length && v.every((s) => typeof s === 'string')) out.add(v.join(','));
    else if (v && Array.isArray(v.stops)) for (const s of v.stops) add(s[1]);
  };
  for (const l of style?.layers || []) add(l.layout?.['text-font']);
  return [...out].sort();
}

export const glyphUrls = (template, stacks, ranges = GLYPH_RANGES) =>
  stacks.flatMap((s) => ranges.map(([a, b]) => template.replace('{fontstack}', s).replace('{range}', `${a}-${b}`)));

export const spriteUrls = (base) => (base ? ['.json', '.png', '@2x.json', '@2x.png'].map((s) => base + s) : []);

// Everything to store besides the style JSONs and the TileJSON themselves. All URLs unique.
export function buildPlan(styles, tilejson, bbox = city().bbox, zooms = ZOOMS) {
  const sprites = new Set();
  const glyphs = new Set();
  for (const st of styles) {
    for (const u of spriteUrls(typeof st.sprite === 'string' ? st.sprite : '')) sprites.add(u);
    if (typeof st.glyphs === 'string') for (const u of glyphUrls(st.glyphs, fontStacks(st))) glyphs.add(u);
  }
  const tpl = tilejson?.tiles?.[0];
  const tiles = tpl ? tileList(bbox, Math.max(zooms.min, tilejson.minzoom ?? 0), Math.min(zooms.max, tilejson.maxzoom ?? 22)).map((t) => tileUrl(tpl, t)) : [];
  return { sprites: [...sprites], glyphs: [...glyphs], tiles, all: [...sprites, ...glyphs, ...tiles] };
}

// Size shown before the first download (no network): tile count is exact, the rest is a fixed guess.
export function estimateDownload(bbox = city().bbox, zooms = ZOOMS) {
  const tiles = tileCount(bbox, zooms.min, zooms.max);
  const glyphs = EST.fontStacks * GLYPH_RANGES.length;
  return { tiles, files: tiles + glyphs + 4, bytes: tiles * EST.tile + glyphs * EST.glyph + EST.sprite };
}

export function fmtBytes(b) {
  if (!(b > 0)) return '0 MB';
  const mb = b / 1048576;
  if (mb < 0.95) return `${Math.max(1, Math.round(b / 1024))} KB`;
  const n = mb.toFixed(mb < 10 ? 1 : 0);
  return `${lang() === 'en' ? n : n.replace('.', ',')} MB`;
}

// ---------- cache access ----------
const hasCaches = () => typeof caches !== 'undefined';

async function readMeta(cache) {
  try {
    const res = await cache.match(META_URL());
    return res ? await res.json() : null;
  } catch { return null; }
}
const writeMeta = (cache, meta) =>
  cache.put(META_URL(), new Response(JSON.stringify(meta), { headers: { 'content-type': 'application/json' } }));

export async function storageInfo() {
  const out = { usage: 0, quota: 0, persisted: false };
  try {
    const e = await navigator.storage.estimate();
    out.usage = e.usage || 0; out.quota = e.quota || 0;
  } catch { /* unsupported */ }
  try { out.persisted = await navigator.storage.persisted(); } catch { /* unsupported */ }
  return out;
}

// → { supported, downloaded, partial, tiles, files, bytes, at } (at = epoch ms of the last finished or interrupted run)
export async function offlineMapStatus() {
  const none = { supported: hasCaches(), downloaded: false, partial: false, tiles: 0, files: 0, bytes: 0, at: 0 };
  if (!hasCaches()) return none;
  try {
    if (!(await caches.has(OFFLINE_CACHE))) return none;
    const cache = await caches.open(OFFLINE_CACHE);
    const meta = await readMeta(cache);
    const keys = (await cache.keys()).map((r) => r.url).filter((u) => u !== META_URL());
    if (!keys.length) return none;
    const tiles = keys.filter((u) => /\/planet\/[^/]+\/\d+\/\d+\/\d+\.pbf$/.test(u)).length;
    return { supported: true, downloaded: !!meta?.complete, partial: !meta?.complete, tiles, files: keys.length, bytes: meta?.bytes || 0, at: meta?.at || 0, city: meta?.city ?? DEFAULT_CITY };
  } catch { return none; }
}

export async function clearOfflineMap() {
  if (!hasCaches()) return false;
  return caches.delete(OFFLINE_CACHE);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// null = 404 (nothing there, e.g. an empty tile); throws on other failures after one retry.
// cache: 'reload' tells sw.js to leave the request alone, so the file is stored once (here), not twice.
async function getFile(url, signal) {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url, { cache: 'reload', signal });
      if (res.ok) return res;
      if (res.status === 404) return null;
      if (res.status < 500 || i >= 1) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      if (signal?.aborted || i >= 1) throw e;
    }
    await sleep(600);
  }
}

// Downloads the active city's area (both map styles). Resolves { ok, cancelled, failed, skipped, ...status }; never rejects
// on network trouble (ok = false, error = message). onProgress({ phase, done, total, bytes }).
export async function downloadCityMap({ onProgress, signal } = {}) {
  const fail = (error) => ({ ok: false, cancelled: false, failed: 0, skipped: 0, error, ...emptyStatus() });
  if (!hasCaches()) return fail(t('Ο browser δεν υποστηρίζει αποθήκευση για χρήση χωρίς σύνδεση.'));
  try { navigator.storage?.persist?.(); } catch { /* best effort: keeps the browser from evicting the map */ }
  const report = (p) => { try { onProgress?.(p); } catch { /* UI callback must not break the download */ } };
  const cache = await caches.open(OFFLINE_CACHE);
  const prev = await readMeta(cache);
  const wasComplete = !!prev?.complete && (prev.city ?? DEFAULT_CITY) === cityId(); // an interrupted update keeps the old (still intact) map marked complete
  let bytes = 0;
  let done = 0;
  let failed = 0;
  let skipped = 0;
  let total = 0;
  try {
    report({ phase: 'prepare', done: 0, total: 0, bytes: 0 });
    const store = async (url, res) => {
      const blob = await res.blob();
      await cache.put(url, new Response(blob, { status: res.status, headers: res.headers }));
      return blob.size;
    };
    // 1) styles, 2) the TileJSON they point at (both styles share one)
    const styles = [];
    for (const url of STYLE_URLS) {
      const res = await getFile(url, signal);
      if (!res) throw new Error('Δεν βρέθηκε το στυλ του χάρτη.');
      const copy = res.clone();
      styles.push(await res.json());
      { const n = await store(url, copy); bytes += n; }
    }
    const tjUrl = styles.map((s) => s.sources?.openmaptiles?.url).find(Boolean);
    if (!tjUrl) throw new Error('Άγνωστη μορφή στυλ χάρτη.');
    const tjRes = await getFile(tjUrl, signal);
    if (!tjRes) throw new Error('Δεν βρέθηκε το TileJSON του χάρτη.');
    const tjCopy = tjRes.clone();
    const tilejson = await tjRes.json();
    { const n = await store(tjUrl, tjCopy); bytes += n; }

    const plan = buildPlan(styles, tilejson);
    const wanted = new Set([...STYLE_URLS, tjUrl, ...plan.all].map((u) => new URL(u).href));
    total = plan.all.length;
    await writeMeta(cache, { city: cityId(), complete: wasComplete, at: Date.now(), bytes, tiles: plan.tiles.length, total });
    report({ phase: 'download', done, total, bytes });

    // 3) the files, a few at a time; already stored ones (same URL = same immutable content) are kept
    const queue = plan.all.slice();
    const worker = async () => {
      while (queue.length && !signal?.aborted) {
        const url = queue.shift();
        try {
          const have = await cache.match(url, { ignoreVary: true });
          if (have) { skipped++; const n = (await have.blob()).size; bytes += n; } else {
            const res = await getFile(url, signal);
            if (res) { const n = await store(url, res); bytes += n; } else skipped++; // n first: += across an await would lose concurrent updates
          }
        } catch (e) {
          if (signal?.aborted) return;
          failed++;
        }
        done++;
        report({ phase: 'download', done, total, bytes });
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    if (signal?.aborted) {
      await writeMeta(cache, { city: cityId(), complete: wasComplete, at: Date.now(), bytes, tiles: plan.tiles.length, total });
      return { ok: false, cancelled: true, failed, skipped, ...(await offlineMapStatus()) };
    }
    // 4) drop files of an older map version, then mark the download complete
    for (const req of await cache.keys()) {
      if (req.url !== META_URL() && !wanted.has(req.url)) await cache.delete(req);
    }
    const complete = failed === 0;
    await writeMeta(cache, { city: cityId(), complete, at: Date.now(), bytes, tiles: plan.tiles.length, total });
    report({ phase: 'done', done, total, bytes });
    return { ok: complete, cancelled: false, failed, skipped, error: complete ? '' : t('Κάποια αρχεία δεν κατέβηκαν.'), ...(await offlineMapStatus()) };
  } catch (e) {
    if (signal?.aborted) return { ok: false, cancelled: true, failed, skipped, ...(await offlineMapStatus()) };
    try { await writeMeta(cache, { city: cityId(), complete: wasComplete, at: Date.now(), bytes, tiles: prev?.tiles || 0, total }); } catch { /* ignore */ }
    return { ...fail(navigator.onLine === false ? t('Δεν υπάρχει σύνδεση στο ίντερνετ.') : t('Η λήψη απέτυχε. Δοκίμασε ξανά.')), ...(await offlineMapStatus()) };
  }
}
const emptyStatus = () => ({ supported: true, downloaded: false, partial: false, tiles: 0, files: 0, bytes: 0, at: 0 });

// ---------- settings card ----------
// One download at a time, kept at module level so it survives leaving and re-entering Settings.
let job = null; // { ctl, last, listeners: Set<fn>, result }

function startJob() {
  const ctl = new AbortController();
  const j = { ctl, last: { phase: 'prepare', done: 0, total: 0, bytes: 0 }, listeners: new Set(), result: null };
  job = j;
  downloadCityMap({ signal: ctl.signal, onProgress: (p) => { j.last = p; for (const f of j.listeners) f(); } })
    .then((r) => { j.result = r; }, (e) => { j.result = { ok: false, error: String(e?.message || e) }; })
    .finally(() => { job = null; for (const f of j.listeners) f(j.result); });
  return j;
}

const fmtDate = (ms) => { try { return ms ? new Intl.DateTimeFormat(locale(), { dateStyle: 'medium' }).format(new Date(ms)) : ''; } catch { return ''; } };

export function mountOfflineCard(container, ctx = {}) {
  let dead = false;
  let status = null;
  let error = '';
  let myJob = null;
  const est = estimateDownload();
  const say = (t) => { try { ctx.toast?.(t); } catch { /* ignore */ } };
  const supported = hasCaches() && typeof navigator !== 'undefined' && 'serviceWorker' in navigator;

  const statusP = h('p', { class: 'set-p', 'aria-live': 'polite' });
  const bar = h('progress', { max: '1', value: '0', 'aria-label': t('Πρόοδος λήψης χάρτη'), hidden: true });
  const barP = h('p', { class: 'ex-sub', 'aria-live': 'off', hidden: true });
  const storageP = h('p', { class: 'ex-sub' });
  const errP = h('p', { class: 'ex-note', role: 'alert', hidden: true });
  const dlBtn = h('button', { type: 'button', class: 'ex-btn', onclick: () => start() });
  const cancelBtn = h('button', { type: 'button', class: 'ex-btn ex-btn-sm', onclick: () => myJob?.ctl.abort() }, icon('close'), t('Ακύρωση'));
  const delBtn = h('button', { type: 'button', class: 'ex-btn ex-btn-sm ex-btn-danger', onclick: () => remove() }, icon('trash'), t('Διαγραφή'));
  const actions = h('div', { class: 'set-actions' }, dlBtn, cancelBtn, delBtn);
  const note = h('p', { class: 'ex-note' },
    t('Οι ζωντανές αφίξεις λεωφορείων χρειάζονται πάντα ίντερνετ. Χωρίς σύνδεση θα βλέπεις μόνο τον χάρτη, τις στάσεις και τα αγαπημένα σου.'));
  const card = h('section', { class: 'set-card' },
    h('h2', { class: 'set-title' }, t('Χάρτης χωρίς σύνδεση')), statusP, bar, barP, errP, actions, storageP, note);
  container.replaceChildren(card);

  function paint() {
    if (dead) return;
    const busy = !!myJob;
    const s = status;
    if (!supported) {
      statusP.textContent = t('Αυτός ο browser δεν υποστηρίζει χάρτη χωρίς σύνδεση.');
      actions.hidden = true; storageP.hidden = true; return;
    }
    if (busy) {
      const p = myJob.last;
      statusP.textContent = t('Λήψη του χάρτη ({city})…', { city: cityName(city(), lang()) });
      bar.hidden = false; barP.hidden = false;
      if (p.total) { bar.max = p.total; bar.value = p.done; } else bar.removeAttribute('value');
      barP.textContent = p.total ? t('{done} από {total} αρχεία · {size}', { done: p.done, total: p.total, size: fmtBytes(p.bytes) }) : t('Προετοιμασία…');
    } else {
      bar.hidden = true; barP.hidden = true;
      if (!s) statusP.textContent = '';
      else if (s.city !== cityId() && (s.downloaded || s.partial)) statusP.textContent = t('Είναι αποθηκευμένος ο χάρτης της πόλης: {city}. Η λήψη εδώ θα τον αντικαταστήσει.', { city: cityName(CITIES[s.city] || CITIES[DEFAULT_CITY], lang()) });
      else if (s.downloaded) statusP.textContent = t('Αποθηκευμένος: {tiles} πλακίδια, {size}', { tiles: s.tiles, size: fmtBytes(s.bytes) }) + (s.at ? t(', ενημερώθηκε {date}', { date: fmtDate(s.at) }) : '') + '.';
      else if (s.partial) statusP.textContent = t('Η λήψη δεν ολοκληρώθηκε ({n} αρχεία αποθηκεύτηκαν). Συνέχισέ την όταν έχεις σύνδεση.', { n: s.files });
      else statusP.textContent = t('Κατέβασε τον χάρτη ({city}) για να τον βλέπεις και χωρίς ίντερνετ. Μέγεθος περίπου {size}, καλύτερα με Wi-Fi.', { city: cityName(city(), lang()), size: fmtBytes(est.bytes) });
    }
    errP.hidden = !error; errP.textContent = error;
    const has = !!s && (s.downloaded || s.partial);
    const mine = !!s && s.city === cityId(); // a map of another city is replaced by a download here
    dlBtn.hidden = busy;
    dlBtn.replaceChildren(icon(has && mine ? 'refresh' : 'pin'), mine && s.downloaded ? t('Ενημέρωση χάρτη') : mine && s.partial ? t('Συνέχιση λήψης') : t('Λήψη χάρτη (~{size})', { size: fmtBytes(est.bytes) }));
    cancelBtn.hidden = !busy;
    delBtn.hidden = busy || !has;
  }

  async function refresh() {
    status = await offlineMapStatus();
    const si = await storageInfo();
    if (dead) return;
    storageP.hidden = !si.quota;
    storageP.textContent = si.quota
      ? t('Χώρος συσκευής: {used} από {quota}', { used: fmtBytes(si.usage), quota: fmtBytes(si.quota) }) + (si.persisted ? ` · ${t('προστατευμένος από αυτόματο καθαρισμό')}` : '') + '.'
      : '';
    paint();
  }

  function attach(j) {
    myJob = j;
    const f = (res) => {
      if (res) { // finished
        myJob = null;
        error = res.cancelled ? '' : res.ok ? '' : res.error || t('Η λήψη απέτυχε.');
        if (res.ok) say(t('Ο χάρτης αποθηκεύτηκε για χρήση χωρίς σύνδεση.'));
        j.listeners.delete(f);
        refresh();
      } else paint();
    };
    j.listeners.add(f);
    j.detach = () => j.listeners.delete(f);
    paint();
  }

  function start() {
    error = '';
    if (typeof navigator !== 'undefined' && navigator.onLine === false) { error = t('Χρειάζεται σύνδεση στο ίντερνετ για τη λήψη.'); paint(); return; }
    attach(job || startJob());
  }

  async function remove() {
    await clearOfflineMap();
    error = '';
    say(t('Ο χάρτης χωρίς σύνδεση διαγράφηκε.'));
    refresh();
  }

  if (job) attach(job);
  paint();
  refresh();
  return {
    destroy() {
      dead = true;
      myJob?.detach?.(); // the download itself keeps running
      myJob = null;
      container.replaceChildren();
    },
  };
}
