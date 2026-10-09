// Bump on any shell change.
const CACHE = 'patra-bus-v3';

const SHELL = [
  './',
  'index.html',
  'app.css',
  'js/app.js',
  'js/arrivals.js',
  'js/text.js',
  'manifest.webmanifest',
  'icon.svg',
  'data/stops.json',
  'data/lines.json',
  'fixtures/live-1011.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  // Never touch live API calls or other origins.
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.includes('/api/')) return;

  event.respondWith(
    fetch(request)
      .then((res) => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return res;
      })
      .catch(async () => {
        // ignoreSearch: the app is opened with ?demo
        const hit = await caches.match(request, { ignoreSearch: true });
        if (hit) return hit;
        if (request.mode === 'navigate') return caches.match('index.html');
        return Response.error();
      })
  );
});
