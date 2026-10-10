// Web Push handlers for the service worker (owner: push client). Loaded by sw.js via importScripts, so this is a
// classic script: no import/export, nothing leaks into the global scope. `notificationclick` lives in sw.js and reads
// `notification.data.url` (absolute, or relative to the SW scope), which is what is set here.
(() => {
  const FALLBACK_TITLE = 'Patra Bus';
  const clip = (v, n) => String(v ?? '').slice(0, n);

  // Payload from the server: JSON { title, body, tag, url }; a plain-text payload becomes the body.
  function parse(event) {
    const d = event.data;
    if (!d) return {};
    let text = '';
    try { text = d.text(); } catch { return {}; }
    try {
      const j = JSON.parse(text);
      if (j && typeof j === 'object') return j;
      return { body: String(j) };
    } catch { return text ? { body: text } : {}; }
  }

  self.addEventListener('push', (event) => {
    const p = parse(event);
    const title = clip(p.title, 120) || FALLBACK_TITLE;
    const opts = {
      body: clip(p.body, 400) || (p.title ? '' : 'Έχεις μια υπενθύμιση.'),
      renotify: true, // same tag replaces the earlier (e.g. local) notification and alerts again
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png',
      vibrate: [200, 100, 200],
      data: { url: typeof p.url === 'string' && p.url ? p.url : './' },
    };
    opts.tag = clip(p.tag, 100) || 'patra-bus-push'; // always tagged: the OS then replaces instead of stacking
    // userVisibleOnly: every push must show something, so even a broken payload ends in a notification.
    event.waitUntil(self.registration.showNotification(title, opts).catch(() => {}));
  });

  // The browser rotated or dropped the subscription: best-effort resubscribe with the same key. Server reminders
  // are tied to the old endpoint and are dropped there (410); the page re-checks its own subscription on open.
  self.addEventListener('pushsubscriptionchange', (event) => {
    event.waitUntil((async () => {
      try {
        if (event.newSubscription) return;
        const key = event.oldSubscription?.options?.applicationServerKey;
        await self.registration.pushManager.subscribe(key ? { userVisibleOnly: true, applicationServerKey: key } : { userVisibleOnly: true });
      } catch { /* nothing else to do without the page */ }
    })());
  });
})();
