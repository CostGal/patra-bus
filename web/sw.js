// Service worker: offline app shell + OpenFreeMap assets. Bump CACHE on any shell change.
// Never touches /api/ or any other origin except tiles.openfreemap.org (routing, geocoding etc. stay on the network).
// Push handlers live in sw-push.js (owned separately).
importScripts('sw-push.js');

const CACHE = 'patra-bus-v8';
const MAP_CACHE = 'patra-bus-map-v1'; // runtime OpenFreeMap cache, bounded (oldest tiles trimmed first)
const MAP_OFFLINE = 'patra-bus-map-offline-v1'; // filled by js/offline.js (opt-in download), never trimmed
const MAP_MAX = 4000;
const KEEP_CACHES = [CACHE, MAP_CACHE, MAP_OFFLINE];

// <pure> (loaded verbatim by tests/offline.test.mjs: no outer references)
// 'static' = immutable per versioned URL (cache-first); 'dynamic' = style + TileJSON (network-first); null = not ours.
function mapKind(href) {
  let u;
  try { u = new URL(href); } catch { return null; }
  if (u.hostname !== 'tiles.openfreemap.org') return null;
  const p = u.pathname;
  if (p.startsWith('/styles/') || p === '/planet' || p === '/planet/') return 'dynamic';
  if (/^\/(planet|fonts|sprites)\/./.test(p)) return 'static';
  return null;
}
// Which cached URLs (oldest first) to delete so at most `max` remain; 10% slack avoids trimming on every put.
// Style/TileJSON entries are never picked: they are few and needed to boot offline.
function trimSelect(urls, max) {
  if (urls.length <= max) return [];
  const drop = urls.length - Math.floor(max * 0.9);
  const out = [];
  for (const u of urls) {
    if (out.length >= drop) break;
    if (mapKind(u) === 'static') out.push(u);
  }
  return out;
}
// </pure>
const NET_TIMEOUT_MS = 4000; // slow connection at a bus stop: fall back to the cached copy instead of hanging

// Must all exist: if one is missing the install fails and the previous version keeps running.
const SHELL = [
  './',
  'vendor/maplibre-gl/maplibre-gl.js',
  'vendor/maplibre-gl/maplibre-gl.css',
  'index.html',
  'app.css',
  'manifest.webmanifest',
  'sw-push.js',
  'icon.svg',
  'css/tokens.css',
  'css/arrivals.css',
  'css/nearby.css',
  'css/planner.css',
  'css/extras.css',
  'js/app.js',
  'js/ui.js',
  'js/map.js',
  'js/sheet.js',
  'js/text.js',
  'js/data.js',
  'js/api.js',
  'js/arrivals.js',
  'js/arrivals-view.js',
  'js/demo.js',
  'js/location.js',
  'js/geo.js',
  'js/walk.js',
  'js/nearby.js',
  'js/geocode.js',
  'js/planner.js',
  'js/planner-view.js',
  'js/store.js',
  'js/notify.js',
  'js/share.js',
  'js/lines-view.js',
  'js/bus-view.js',
  'js/settings-view.js',
  'js/accents.js',
  'js/push.js',
  'js/offline.js',
  'data/stops.json',
  'data/lines.json',
];

// Cached when present; a 404 here must not break the install.
const OPTIONAL = [
  'data/routes.json',
  'data/shapes.json',
  'fixtures/live-1011.json',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // cache: 'reload' bypasses the HTTP cache (Pages serves max-age=600) so a new version never precaches stale files
    const fresh = (u) => new Request(u, { cache: 'reload' });
    await cache.addAll(SHELL.map(fresh));
    await Promise.allSettled(OPTIONAL.map((u) => cache.add(fresh(u))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !KEEP_CACHES.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Extend the worker's lifetime for background work; never let it throw or reject.
function keep(event, promise) {
  try { event.waitUntil(Promise.resolve(promise).catch(() => {})); } catch { /* event already finished */ }
}

async function networkFirst(event) {
  const { request } = event;
  const cache = await caches.open(CACHE);
  // ignoreSearch: the app is opened with ?demo, assets may carry a query
  const cached = () => cache.match(request, { ignoreSearch: true });
  // no-cache = always revalidate (cheap 304), so a stale HTTP-cached file can never overwrite a fresh precache entry.
  // (A navigate request cannot be re-initialised, so the page itself goes through as is.)
  const net = fetch(request, request.mode === 'navigate' ? undefined : { cache: 'no-cache' }).then((res) => {
    if (res.status === 200 && res.type === 'basic') keep(event, cache.put(request, res.clone()));
    return res;
  });
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), NET_TIMEOUT_MS); });
  try {
    const res = await Promise.race([net, timeout]);
    clearTimeout(timer);
    if (res) return res;
    const hit = await cached();
    if (hit) { keep(event, net); return hit; } // keep refreshing the cache in the background
    return await net;
  } catch {
    clearTimeout(timer);
    return (await cached())
      || (request.mode === 'navigate' && (await cache.match('index.html')))
      || Response.error();
  }
}

// ---- OpenFreeMap (the only foreign origin we cache) ----
const mapFirst = async (request) => { // downloaded copy wins over the runtime one
  for (const name of [MAP_OFFLINE, MAP_CACHE]) {
    const hit = await (await caches.open(name)).match(request, { ignoreVary: true });
    if (hit) return hit;
  }
  return null;
};
let mapPuts = 0;
async function mapPut(request, res) {
  const cache = await caches.open(MAP_CACHE);
  await cache.put(request, res);
  if (++mapPuts % 50) return;
  const urls = (await cache.keys()).map((r) => r.url);
  await Promise.all(trimSelect(urls, MAP_MAX).map((u) => cache.delete(u)));
}
const cacheable = (res) => res.ok && (res.type === 'cors' || res.type === 'basic');

async function mapStatic(event) {
  const { request } = event;
  const hit = await mapFirst(request);
  if (hit) return hit;
  try {
    const res = await fetch(request);
    if (cacheable(res)) keep(event, mapPut(request, res.clone()));
    return res;
  } catch {
    return Response.error(); // uncached area while offline: MapLibre just leaves it blank
  }
}

async function mapDynamic(event) {
  const { request } = event;
  const net = fetch(request).then((res) => {
    if (cacheable(res)) keep(event, mapPut(request, res.clone()));
    return res;
  });
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), NET_TIMEOUT_MS); });
  try {
    const res = await Promise.race([net, timeout]);
    clearTimeout(timer);
    if (res && res.ok) return res;
    const hit = await mapFirst(request);
    if (hit) { keep(event, net); return hit; }
    return res || await net;
  } catch {
    clearTimeout(timer);
    return (await mapFirst(request)) || Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.hostname === 'tiles.openfreemap.org') {
    // cache: 'reload' marks js/offline.js downloads: straight to the network, js/offline.js stores them itself
    const kind = request.cache === 'reload' ? null : mapKind(url.href);
    if (kind) event.respondWith(kind === 'static' ? mapStatic(event) : mapDynamic(event));
    return;
  }
  if (url.origin !== self.location.origin || url.pathname.includes('/api/')) return;
  event.respondWith(networkFirst(event));
});

// Tap on a reminder notification: focus the open app (jumping to the target hash) or open it.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const scope = self.registration.scope;
    let target = new URL('./', scope);
    try {
      const u = new URL(event.notification.data?.url || './', scope);
      if (u.origin === self.location.origin) target = u;
    } catch { /* keep scope */ }
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = wins.find((w) => w.url.startsWith(scope));
    if (!open) return self.clients.openWindow(target.href);
    const same = (a, b) => a.split('#')[0] === b.split('#')[0];
    try {
      await open.focus();
      // Only a fragment change when the page is the same document (no reload, keeps ?demo etc.).
      if (target.hash && same(open.url, target.href) && 'navigate' in open) await open.navigate(target.href);
    } catch { /* focus can be refused; nothing else to do */ }
  })());
});
