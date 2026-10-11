import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createPush, buildReminderBody, urlBase64ToBytes, FLAG_KEY, CANCEL_KEY } from '../web/js/push.js';
import { createReminders } from '../web/js/notify.js';
import { createLinks, LINKS_KEY, LINK_TTL_MS } from '../web/js/notif-link.js';

// ---- fakes ----
function fakeStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
}
const KEY64 = 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';
const NOW = 1_700_000_000_000;

function sub(endpoint = 'https://push.example/abc') {
  return { endpoint, options: { applicationServerKey: urlBase64ToBytes(KEY64).buffer }, toJSON() { return { endpoint, keys: { p256dh: 'P', auth: 'A' } }; }, unsubscribed: false, async unsubscribe() { this.unsubscribed = true; return true; } };
}

// A browser: iOS/standalone/permission configurable; one service worker registration.
function browser({ ua = 'Mozilla/5.0 (Linux; Android 14) Chrome/130', platform = 'Linux armv8l', standalone, display = false, perm = 'default', grant = 'granted', pm = true, sw = true, existing = null, maxTouchPoints = 0 } = {}) {
  const log = { subscribeCalls: [], requestPermission: 0 };
  const state = { sub: existing };
  const reg = { pushManager: {
    getSubscription: async () => state.sub,
    subscribe: async (o) => { log.subscribeCalls.push(o); state.sub = sub(); return state.sub; },
  } };
  class N { static permission = perm; static requestPermission(cb) { log.requestPermission++; N.permission = grant; cb?.(grant); return Promise.resolve(grant); } }
  const nav = { userAgent: ua, platform, maxTouchPoints, standalone };
  if (sw) nav.serviceWorker = { ready: Promise.resolve(reg) };
  const win = { Notification: N, matchMedia: (q) => ({ matches: display && q === '(display-mode: standalone)' }) };
  if (pm) win.PushManager = function PushManager() {};
  return { nav, win, reg, state, log, N };
}

function server({ keyStatus = 200, postStatus = 201, id = 'srv-1', fail = false } = {}) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined });
    if (fail) throw new TypeError('offline');
    const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
    if (url.endsWith('/api/push/key')) return res(keyStatus, { publicKey: KEY64 });
    if ((init.method || 'GET') === 'POST') return res(postStatus, { id });
    return res(204);
  };
  f.calls = calls;
  return f;
}

const make = (b, over = {}) => {
  const storage = over.storage ?? fakeStorage();
  const fetch = over.fetch ?? server();
  const p = createPush({ nav: b.nav, win: b.win, storage, fetch, apiBase: 'http://api.test', now: () => NOW, baseURI: 'http://localhost:8080/', ...over.extra });
  return { p, storage, fetch };
};

// ---- pushState ----
test('pushState: supported/unsupported/needs-install', () => {
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile/15E148 Safari/604.1';
  assert.equal(make(browser()).p.pushState(), 'off');
  assert.equal(make(browser()).p.isPushSupported(), true);
  assert.equal(make(browser({ pm: false })).p.pushState(), 'unsupported'); // desktop-like, no PushManager
  assert.equal(make(browser({ sw: false })).p.pushState(), 'unsupported');
  // iPhone Safari tab: no PushManager, not standalone → install first
  assert.equal(make(browser({ ua: IPHONE, platform: 'iPhone', pm: false, standalone: false })).p.pushState(), 'needs-install');
  // iPadOS reports a Mac platform but has touch points
  assert.equal(make(browser({ ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15', platform: 'MacIntel', maxTouchPoints: 5, pm: false })).p.pushState(), 'needs-install');
  // a real Mac Safari is not iOS
  assert.equal(make(browser({ ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15', platform: 'MacIntel', maxTouchPoints: 0, pm: false })).p.pushState(), 'unsupported');
  // installed via navigator.standalone or display-mode but still without PushManager (old iOS) → unsupported, not install
  assert.equal(make(browser({ ua: IPHONE, platform: 'iPhone', pm: false, standalone: true })).p.pushState(), 'unsupported');
  assert.equal(make(browser({ ua: IPHONE, platform: 'iPhone', pm: false, display: true })).p.pushState(), 'unsupported');
  // installed iOS with push available
  assert.equal(make(browser({ ua: IPHONE, platform: 'iPhone', standalone: true })).p.pushState(), 'off');
});

test('pushState: denied / off / on follow permission + flag', () => {
  assert.equal(make(browser({ perm: 'denied' })).p.pushState(), 'denied');
  const b = browser({ perm: 'granted' });
  assert.equal(make(b).p.pushState(), 'off'); // permission alone is not "on"
  const { p } = make(b, { storage: fakeStorage({ [FLAG_KEY]: '1' }) });
  assert.equal(p.pushState(), 'on');
  const revoked = browser({ perm: 'default' });
  assert.equal(make(revoked, { storage: fakeStorage({ [FLAG_KEY]: '1' }) }).p.pushState(), 'off'); // flag without permission
});

// ---- enable / disable ----
test('enablePush: permission → key → subscribe → flag; state on', async () => {
  const b = browser();
  const { p, storage, fetch } = make(b);
  const seen = []; p.onPushChange((s) => seen.push(s));
  assert.equal(await p.enablePush(), true);
  assert.equal(b.log.requestPermission, 1);
  assert.equal(fetch.calls[0].url, 'http://api.test/api/push/key');
  assert.equal(b.log.subscribeCalls.length, 1);
  assert.equal(b.log.subscribeCalls[0].userVisibleOnly, true);
  assert.equal(b.log.subscribeCalls[0].applicationServerKey.length, 65); // uncompressed P-256 point
  assert.equal(storage.getItem(FLAG_KEY), '1');
  assert.equal(p.pushState(), 'on');
  assert.deepEqual(seen, ['on']);
});

test('enablePush: dismissed / denied / key failure / subscribe failure leave it off', async () => {
  let b = browser({ grant: 'default' });
  let m = make(b);
  assert.equal(await m.p.enablePush(), false);
  assert.equal(m.p.pushError(), 'dismissed');
  assert.equal(m.p.pushState(), 'off');

  b = browser({ grant: 'denied' });
  m = make(b);
  assert.equal(await m.p.enablePush(), false);
  assert.equal(m.p.pushError(), 'denied');
  assert.equal(m.p.pushState(), 'denied');

  b = browser();
  m = make(b, { fetch: server({ keyStatus: 503 }) });
  assert.equal(await m.p.enablePush(), false);
  assert.equal(m.p.pushError(), 'key');
  assert.equal(b.log.subscribeCalls.length, 0);
  assert.equal(m.storage.getItem(FLAG_KEY), null);

  b = browser();
  b.reg.pushManager.subscribe = async () => { throw new Error('AbortError'); };
  m = make(b);
  assert.equal(await m.p.enablePush(), false);
  assert.equal(m.p.pushError(), 'subscribe');

  m = make(browser({ pm: false }));
  assert.equal(await m.p.enablePush(), false);
  assert.equal(m.p.pushError(), 'unsupported');
});

test('enablePush: a subscription made with another key is replaced', async () => {
  const stale = sub(); stale.options = { applicationServerKey: new Uint8Array(65).buffer };
  const b = browser({ existing: stale });
  const m = make(b);
  assert.equal(await m.p.enablePush(), true);
  assert.equal(stale.unsubscribed, true);
  assert.equal(b.log.subscribeCalls.length, 1);
});

test('enablePush asks for permission before awaiting anything else (user gesture)', async () => {
  const b = browser();
  const { p } = make(b);
  const pr = p.enablePush();
  assert.equal(b.log.requestPermission, 1); // synchronous part of the call already prompted
  await pr;
});

test('disablePush: unsubscribes and clears the flag', async () => {
  const s = sub();
  const b = browser({ perm: 'granted', existing: s });
  const m = make(b, { storage: fakeStorage({ [FLAG_KEY]: '1' }) });
  assert.equal(m.p.pushState(), 'on');
  await m.p.disablePush();
  assert.equal(s.unsubscribed, true);
  assert.equal(m.p.pushState(), 'off');
  assert.equal(m.storage.getItem(FLAG_KEY), null);
});

test('syncPushState: flag without a real subscription turns off', async () => {
  const b = browser({ perm: 'granted', existing: null });
  const m = make(b, { storage: fakeStorage({ [FLAG_KEY]: '1' }) });
  assert.equal(await m.p.syncPushState(), 'off');
  assert.equal(m.storage.getItem(FLAG_KEY), null);
  const ok = make(browser({ perm: 'granted', existing: sub() }), { storage: fakeStorage({ [FLAG_KEY]: '1' }) });
  assert.equal(await ok.p.syncPushState(), 'on');
});

test('works with storage that throws', async () => {
  const bad = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('Quota'); }, removeItem() { throw new Error('x'); } };
  const m = make(browser(), { storage: bad });
  assert.equal(await m.p.enablePush(), true);
  assert.equal(m.p.pushState(), 'on'); // held in memory for this page
  assert.equal(await m.p.cancelPushReminder('x'), true);
});

// ---- payload + server calls ----
test('buildReminderBody: caps, defaults and trip shape', () => {
  const b = buildReminderBody({ endpoint: 'e' }, { at: NOW + 1000.4, title: 'T'.repeat(500), body: 'b', tag: 'plan:1', url: '#/plan', trip: { stopCode: 1011, routeCode: 55, lineCode: 201, vehicleCode: '', offsetSec: 299.6 } });
  assert.equal(b.at, NOW + 1000);
  assert.equal(b.title.length, 100);
  assert.deepEqual(b.trip, { stopCode: '1011', routeCode: '55', lineCode: '201', vehicleCode: null, offsetSec: 300 });
  assert.equal('trip' in buildReminderBody({}, { at: 1 }), false);
  assert.equal(buildReminderBody({}, { at: 1 }).body, '');
  assert.equal(buildReminderBody({}, { at: 1, url: 'http://x/#/plan?to=1,2&name=a' }).url, ''); // never a place
});

test('schedulePushReminder: posts subscription + payload, returns id', async () => {
  const b = browser({ perm: 'granted', existing: sub() });
  const m = make(b, { storage: fakeStorage({ [FLAG_KEY]: '1' }) });
  const id = await m.p.schedulePushReminder({ at: NOW + 60_000, title: 'Ώρα να φύγεις', body: '201 σε 5′', tag: 'plan:x', url: '#/plan?to=1,2', trip: { stopCode: '1011', routeCode: '9', lineCode: '201', vehicleCode: 'V1', offsetSec: 240 } });
  assert.equal(id, 'srv-1');
  const c = m.fetch.calls.at(-1);
  assert.equal(c.method, 'POST');
  assert.equal(c.url, 'http://api.test/api/push/reminders');
  assert.deepEqual(c.body.subscription, { endpoint: 'https://push.example/abc', keys: { p256dh: 'P', auth: 'A' } });
  assert.equal(c.body.tag, 'plan:x');
  assert.equal(c.body.trip.vehicleCode, 'V1');
  // the plan link (destination coordinates) stays on the device; the server gets an opaque reference + the stop
  const ref = c.body.url.match(/^http:\/\/localhost:8080\/#\/patra\/notif\?ref=([0-9a-f]{16})&stop=1011$/)?.[1];
  assert.ok(ref, c.body.url);
  assert.ok(!JSON.stringify(c.body).includes('to='));
  const links = createLinks({ storage: () => m.storage, now: () => NOW });
  assert.equal(links.get(ref), '#/plan?to=1,2');
  assert.equal(JSON.parse(m.storage.getItem(LINKS_KEY))[0].exp, NOW + 60_000 + LINK_TTL_MS);
});

test('schedulePushReminder: links without a place go as they are; the city prefix follows the reminder', async () => {
  const mk = () => make(browser({ perm: 'granted', existing: sub() }), { storage: fakeStorage({ [FLAG_KEY]: '1' }) });
  const base = { at: NOW + 60_000, title: 't', tag: 'a', trip: { stopCode: '0015', routeCode: '9', lineCode: '04', offsetSec: 0 } };
  const a = mk();
  await a.p.schedulePushReminder({ ...base, url: '#/patra/' });
  assert.equal(a.fetch.calls.at(-1).body.url, 'http://localhost:8080/#/patra/');
  assert.equal(a.storage.getItem(LINKS_KEY), null);
  const b = mk();
  await b.p.schedulePushReminder({ ...base, url: '#/corfu/plan?to=39.6,19.9&name=Home&from=39.62,19.91', city: 'corfu' });
  assert.match(b.fetch.calls.at(-1).body.url, /^http:\/\/localhost:8080\/#\/corfu\/notif\?ref=[0-9a-f]{16}&stop=0015$/);
  const c = mk();
  await c.p.schedulePushReminder({ ...base, url: undefined });
  assert.equal(c.fetch.calls.at(-1).body.url, '');
});

test('schedulePushReminder returns null (never throws) when off, out of range, offline or rejected', async () => {
  const on = { storage: fakeStorage({ [FLAG_KEY]: '1' }) };
  const good = { at: NOW + 60_000, title: 't', tag: 'a' };
  assert.equal(await make(browser()).p.schedulePushReminder(good), null); // push off
  const mk = (over) => make(browser({ perm: 'granted', existing: sub() }), { storage: fakeStorage({ [FLAG_KEY]: '1' }), ...over });
  assert.equal(await mk().p.schedulePushReminder({ ...good, at: NOW - 1 }), null);
  assert.equal(await mk().p.schedulePushReminder({ ...good, at: NOW + 4 * 3600_000 }), null); // beyond server's 3 h
  assert.equal(await mk().p.schedulePushReminder({ ...good, at: 'soon' }), null);
  assert.equal(await mk({ fetch: server({ fail: true }) }).p.schedulePushReminder(good), null); // offline
  assert.equal(await mk({ fetch: server({ postStatus: 400 }) }).p.schedulePushReminder(good), null);
  assert.equal(await mk({ fetch: server({ postStatus: 500 }) }).p.schedulePushReminder(good), null);
  const noSub = make(browser({ perm: 'granted', existing: null }), on);
  assert.equal(await noSub.p.schedulePushReminder(good), null);
  assert.equal(noSub.storage.getItem(FLAG_KEY), null); // learned the subscription is gone
  assert.equal(await mk().p.schedulePushReminder(undefined), null);
});

test('cancelPushReminder: DELETE; failure is queued and flushed later', async () => {
  const storage = fakeStorage();
  const down = server({ fail: true });
  let live = false;
  const fetch = (u, i) => (live ? up(u, i) : down(u, i));
  const up = server();
  const m = make(browser(), { storage, fetch });
  assert.equal(await m.p.cancelPushReminder('a/b'), false);
  assert.deepEqual(JSON.parse(storage.getItem(CANCEL_KEY)), ['a/b']);
  assert.equal(down.calls[0].url, 'http://api.test/api/push/reminders/a%2Fb');
  assert.equal(down.calls[0].method, 'DELETE');
  live = true;
  await m.p.flushPushCancels();
  assert.equal(storage.getItem(CANCEL_KEY), null);
  assert.equal(up.calls.length, 1);
  assert.equal(await m.p.cancelPushReminder('x'), true);
  assert.equal(await m.p.cancelPushReminder(null), false);
  assert.equal(await make(browser(), { fetch: server({ postStatus: 201 }) }).p.cancelPushReminder('404-ok'), true);
});

// ---- notify ↔ push ----
function rig({ state = 'on', ids = ['S1', 'S2', 'S3'], fail = false } = {}) {
  let t = NOW; let timers = [];
  const calls = { schedule: [], cancel: [] }; let n = 0;
  const fired = [];
  const push = {
    state: () => state,
    schedule: async (p) => { calls.schedule.push(p); if (fail) throw new Error('boom'); return ids[n++] ?? null; },
    cancel: async (id) => { calls.cancel.push(id); if (fail) throw new Error('boom'); },
  };
  const ls = fakeStorage();
  const r = createReminders({ storage: () => ls, now: () => t, setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {}, onFire: (x) => fired.push(x), push });
  return { r, calls, fired, set: (s) => { state = s; }, advance: (ms) => { t += ms; }, flush: () => new Promise((res) => setImmediate(res)) };
}

test('notify: push on → server booked with same tag + trip, id stored', async () => {
  const x = rig();
  const trip = { stopCode: '1011', routeCode: '9', lineCode: '201', vehicleCode: 'V1', offsetSec: 120 };
  x.r.scheduleReminder({ at: NOW + 60_000, title: 'T', body: 'B', tag: 'plan:1', url: '#/plan', trip });
  await x.flush();
  assert.equal(x.calls.schedule.length, 1);
  assert.deepEqual(x.calls.schedule[0], { at: NOW + 60_000, title: 'T', body: 'B', tag: 'plan:1', url: '#/plan', city: 'patra', trip });
  // local behaviour untouched
  assert.equal(x.r.hasReminder('plan:1'), true);
  assert.deepEqual(x.r.listReminders().map((q) => q.tag), ['plan:1']);
  assert.equal('sid' in x.r.listReminders()[0], false); // server id is internal
  x.r.cancelReminder('plan:1');
  await x.flush();
  assert.deepEqual(x.calls.cancel, ['S1']);
});

test('notify: handle.cancel() cancels the server copy; same tag replaces both', async () => {
  const x = rig();
  const h1 = x.r.scheduleReminder({ at: NOW + 60_000, title: 'a', tag: 't' });
  await x.flush();
  x.r.scheduleReminder({ at: NOW + 90_000, title: 'b', tag: 't' }); // replaces: S1 dropped, S2 booked
  await x.flush();
  assert.deepEqual(x.calls.cancel, ['S1']);
  h1.cancel(); // stale handle of the replaced reminder must not cancel the new one
  await x.flush();
  assert.equal(x.r.hasReminder('t'), true);
  assert.deepEqual(x.calls.cancel, ['S1']);
  const h2 = x.r.scheduleReminder({ at: NOW + 99_000, title: 'c', tag: 't' });
  await x.flush();
  h2.cancel();
  await x.flush();
  assert.deepEqual(x.calls.cancel, ['S1', 'S2', 'S3']);
  assert.equal(x.r.hasReminder('t'), false);
});

test('notify: cancelled before the server answers → the late id is cancelled too', async () => {
  const x = rig();
  x.r.scheduleReminder({ at: NOW + 60_000, title: 'a', tag: 'q' });
  x.r.cancelReminder('q'); // nothing known yet
  await x.flush();
  assert.deepEqual(x.calls.cancel, ['S1']);
});

test('notify: cancelAll cancels every server copy', async () => {
  const x = rig();
  x.r.scheduleReminder({ at: NOW + 60_000, title: 'a', tag: 'a' });
  x.r.scheduleReminder({ at: NOW + 70_000, title: 'b', tag: 'b' });
  await x.flush();
  x.r.cancelAll();
  await x.flush();
  assert.deepEqual(x.calls.cancel.sort(), ['S1', 'S2']);
});

test('notify: push off → local only, no server calls', async () => {
  const x = rig({ state: 'off' });
  x.r.scheduleReminder({ at: NOW + 60_000, title: 'a', tag: 'a' });
  x.r.cancelReminder('a');
  await x.flush();
  assert.equal(x.calls.schedule.length, 0);
  assert.equal(x.calls.cancel.length, 0);
});

test('notify: server failures are silent and local reminders still fire', async () => {
  const x = rig({ fail: true });
  x.r.scheduleReminder({ at: NOW + 60_000, title: 'a', tag: 'a' });
  await x.flush();
  assert.equal(x.r.hasReminder('a'), true);
  x.advance(61_000);
  x.r.tick();
  assert.equal(x.fired.length, 1);
  assert.equal(x.fired[0].sid, undefined);
  // null id (server said no) behaves the same, cancel never calls the server
  const y = rig({ ids: [] });
  y.r.scheduleReminder({ at: NOW + 60_000, title: 'a', tag: 'a' });
  await y.flush();
  y.r.cancelReminder('a');
  await y.flush();
  assert.equal(y.calls.cancel.length, 0);
});

test('notify: onFire gets the server id (so delivery can skip the local system notification); server copy not cancelled on fire', async () => {
  const x = rig();
  x.r.scheduleReminder({ at: NOW + 60_000, title: 'a', tag: 'a' });
  await x.flush();
  x.advance(60_000);
  x.r.tick();
  assert.equal(x.fired[0].sid, 'S1');
  assert.deepEqual(x.calls.cancel, []);
  assert.equal(x.r.hasReminder('a'), false);
});

test('notify: serverGone (push switched off) cancels server ids but keeps local reminders', async () => {
  const x = rig();
  x.r.scheduleReminder({ at: NOW + 60_000, title: 'a', tag: 'a' });
  await x.flush();
  x.r.serverGone();
  await x.flush();
  assert.deepEqual(x.calls.cancel, ['S1']);
  assert.equal(x.r.hasReminder('a'), true);
});

// ---- service worker push handlers (run the real file in a sandbox) ----
function swRun() {
  const handlers = {};
  const shown = [];
  const self = {
    addEventListener: (t, fn) => { handlers[t] = fn; },
    registration: { showNotification: async (title, opts) => { shown.push({ title, opts }); }, pushManager: { subscribed: [], async subscribe(o) { this.subscribed.push(o); } } },
  };
  vm.runInNewContext(readFileSync(new URL('../web/sw-push.js', import.meta.url), 'utf8'), { self, String, JSON });
  const fire = async (type, ev) => { let p; handlers[type]({ ...ev, waitUntil: (x) => { p = x; } }); await p; };
  return { self, shown, fire, handlers };
}
const data = (s) => ({ data: { text: () => s } });

test('sw-push: JSON payload → notification with tag, url and icons', async () => {
  const sw = swRun();
  await sw.fire('push', data(JSON.stringify({ title: 'Ώρα να φύγεις', body: '201 σε 4′', tag: 'plan:1', url: 'http://localhost/#/plan' })));
  assert.equal(sw.shown.length, 1);
  const { title, opts } = sw.shown[0];
  assert.equal(title, 'Ώρα να φύγεις');
  assert.equal(opts.body, '201 σε 4′');
  assert.equal(opts.tag, 'plan:1');
  assert.equal(opts.renotify, true);
  assert.equal(opts.data.url, 'http://localhost/#/plan');
  assert.equal(opts.icon, 'icons/icon-192.png');
  assert.equal(opts.badge, 'icons/icon-192.png');
});

test('sw-push: empty, plain-text and broken payloads still show something', async () => {
  let sw = swRun();
  await sw.fire('push', {});
  assert.equal(sw.shown[0].title, 'Telematica');
  assert.equal(sw.shown[0].opts.data.url, './');
  assert.ok(sw.shown[0].opts.tag);
  sw = swRun();
  await sw.fire('push', data('Φύγε τώρα'));
  assert.equal(sw.shown[0].opts.body, 'Φύγε τώρα');
  sw = swRun();
  await sw.fire('push', { data: { text() { throw new Error('x'); } } });
  assert.equal(sw.shown.length, 1);
  sw = swRun();
  await sw.fire('push', data('{"title":'));
  assert.equal(sw.shown[0].title, 'Telematica');
});

test('sw-push: pushsubscriptionchange resubscribes with the old key; never throws', async () => {
  const sw = swRun();
  const key = new Uint8Array(65).buffer;
  await sw.fire('pushsubscriptionchange', { oldSubscription: { options: { applicationServerKey: key } } });
  const got = sw.self.registration.pushManager.subscribed;
  assert.equal(got.length, 1);
  assert.equal(got[0].userVisibleOnly, true);
  assert.equal(got[0].applicationServerKey, key);
  const bad = swRun();
  bad.self.registration.pushManager.subscribe = async () => { throw new Error('x'); };
  await bad.fire('pushsubscriptionchange', {});
  const done = swRun();
  await done.fire('pushsubscriptionchange', { newSubscription: {} });
  assert.equal(done.self.registration.pushManager.subscribed.length, 0);
});

test('urlBase64ToBytes decodes an uncompressed P-256 key', () => {
  const b = urlBase64ToBytes(KEY64);
  assert.equal(b.length, 65);
  assert.equal(b[0], 4);
});
