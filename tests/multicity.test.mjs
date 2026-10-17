// Multi-city frontend (docs/MULTI-CITY.md): hash prefix, boot city, per-city stored items, city-prefixed API calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CITIES, DEFAULT_CITY, setActiveCity, cityId, cityName, dataDir } from '../web/js/cities.js';
import { parseHash, relHash, formatHash, cityHash, shareHash, resolveBootCity } from '../web/js/route.js';
import { createStore, KEY } from '../web/js/store.js';
import { fetchLive, fetchStats, liveUrl, statsUrl, lastAttemptAt, _setTransport, API_BASE, MIN_GAP_MS } from '../web/js/api.js';
import { createPlaces, placeHash } from '../web/js/places.js';
import { createRoutines, buildRoutinePayload, cleanRoutine } from '../web/js/routines.js';
import { createReminders } from '../web/js/notify.js';
import { buildReminderBody } from '../web/js/push.js';
import { loadTrip, KEY as TRIP_KEY } from '../web/js/onboard.js';
import { buildIndex } from '../web/js/data.js';

function fakeStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
}
const withCity = async (id, fn) => {
  setActiveCity(id);
  try { return await fn(); } finally { setActiveCity(DEFAULT_CITY); }
};

// ---------------------------------------------------------------- cities
test('cities: localized names and data folders', () => {
  assert.equal(cityName(CITIES.patra, 'el'), 'Πάτρα');
  assert.equal(cityName(CITIES.patra, 'en'), 'Patras');
  assert.equal(cityName(CITIES.corfu, 'el'), 'Κέρκυρα');
  assert.equal(cityName(CITIES.corfu, 'en'), 'Corfu');
  assert.equal(cityName(CITIES.corfu, 'fr'), 'Κέρκυρα'); // unknown language: Greek
  assert.equal(dataDir(CITIES.patra), './data/');
  assert.equal(dataDir(CITIES.corfu), './data/corfu/');
});

// ---------------------------------------------------------------- hash
test('parseHash: optional city prefix, decoded parts, params', () => {
  const a = parseHash('#/corfu/stop/123');
  assert.deepEqual([a.city, a.path, a.parts, a.rel], ['corfu', '/stop/123', ['stop', '123'], '#/stop/123']);
  const b = parseHash('#/stop/123');
  assert.deepEqual([b.city, b.path], [null, '/stop/123']);
  const c = parseHash('#/patra/stop/123'); // explicit Patras parses too
  assert.deepEqual([c.city, c.rel], ['patra', '#/stop/123']);
  const d = parseHash('#/corfu/plan?to=39.6,19.9&name=%CE%A3%CF%80%CE%AF%CF%84%CE%B9');
  assert.equal(d.city, 'corfu');
  assert.equal(d.params.to, '39.6,19.9');
  assert.equal(d.params.name, 'Σπίτι');
  assert.equal(d.rel, '#/plan?to=39.6,19.9&name=%CE%A3%CF%80%CE%AF%CF%84%CE%B9');
  for (const root of ['', '#', '#/', '/']) assert.deepEqual([parseHash(root).city, parseHash(root).path, parseHash(root).rel], [null, '/', '#/']);
  assert.deepEqual([parseHash('#/corfu').city, parseHash('#/corfu').path], ['corfu', '/']);
  assert.equal(parseHash('#/corfu/').rel, '#/');
  assert.equal(parseHash('#/lines').city, null); // a view name is never a city
  assert.equal(parseHash('#/athens/stop/1').city, null); // unknown prefix is just a (bad) view
  assert.deepEqual(parseHash('#/stop/%E0%A4%A').parts, ['stop', '%E0%A4%A']); // undecodable stays as is
});

test('formatHash: default city is unprefixed, others and `always` carry the prefix; idempotent', () => {
  assert.equal(formatHash('#/stop/1', 'patra'), '#/stop/1');
  assert.equal(formatHash('#/stop/1', 'corfu'), '#/corfu/stop/1');
  assert.equal(formatHash('#/', 'corfu'), '#/corfu/');
  assert.equal(formatHash('', 'corfu'), '#/corfu/');
  assert.equal(formatHash('#/', 'patra'), '#/');
  assert.equal(formatHash('#/stop/1', 'patra', { always: true }), '#/patra/stop/1');
  assert.equal(formatHash('#/', 'patra', { always: true }), '#/patra/');
  assert.equal(formatHash('#/plan?to=1,2&name=x', 'corfu'), '#/corfu/plan?to=1,2&name=x');
  // an already prefixed hash is re-prefixed, not doubled; switching city replaces the prefix
  assert.equal(formatHash('#/corfu/stop/1', 'corfu'), '#/corfu/stop/1');
  assert.equal(formatHash('#/corfu/stop/1', 'patra'), '#/stop/1');
  assert.equal(formatHash('#/patra/stop/1', 'corfu'), '#/corfu/stop/1');
  assert.equal(formatHash('#/stop/1', 'nope'), '#/stop/1'); // unknown city: left relative
  assert.equal(relHash('#/corfu/line/04?dir=1'), '#/line/04?dir=1');
});

test('cityHash / shareHash follow the active city', async () => {
  assert.equal(cityHash('#/stop/1'), '#/stop/1');
  assert.equal(shareHash('#/stop/1'), '#/patra/stop/1');
  await withCity('corfu', () => {
    assert.equal(cityHash('#/stop/1'), '#/corfu/stop/1');
    assert.equal(cityHash('#/corfu/stop/1'), '#/corfu/stop/1');
    assert.equal(shareHash('#/lines'), '#/corfu/lines');
    assert.equal(placeHash({ lat: 39.62, lng: 19.92, name: 'A' }), '#/corfu/plan?to=39.62000,19.92000&name=A');
  });
  assert.equal(cityId(), 'patra');
});

test('resolveBootCity: prefix > unprefixed link (Patras) > saved setting > default', () => {
  assert.equal(resolveBootCity('#/corfu/stop/1', 'patra'), 'corfu');
  assert.equal(resolveBootCity('#/patra/stop/1', 'corfu'), 'patra');
  assert.equal(resolveBootCity('#/corfu/', undefined), 'corfu');
  // old links: a stop/line/coordinates without prefix always means Patras
  assert.equal(resolveBootCity('#/stop/1011', 'corfu'), 'patra');
  assert.equal(resolveBootCity('#/line/601', 'corfu'), 'patra');
  assert.equal(resolveBootCity('#/plan?to=38.2,21.7', 'corfu'), 'patra');
  // bare views open in the saved city (PWA shortcuts, bookmarks of the home screen)
  for (const h of ['', '#', '#/', '#/lines', '#/plan', '#/settings', '#/favorites']) assert.equal(resolveBootCity(h, 'corfu'), 'corfu', h);
  assert.equal(resolveBootCity('#/', undefined), 'patra');
  assert.equal(resolveBootCity('#/', 'atlantis'), 'patra');
});

// ---------------------------------------------------------------- store
const mk = (storage, city) => createStore({ storage: () => storage, events: null, city: () => city.v });

test('store: schema <= 2 blobs are tagged Patras on first read and rewritten as schema 3', () => {
  const old = { v: 2, favorites: ['1011', '2022'], recents: { stop: [{ code: '5', name: 'X' }, '6'], place: [{ name: 'P', lat: 38.2, lng: 21.7 }] }, settings: { theme: 'dark' } };
  const ls = fakeStorage({ [KEY]: JSON.stringify(old) });
  const city = { v: 'patra' };
  const s = mk(ls, city);
  assert.deepEqual(s.getFavorites(), ['1011', '2022']);
  assert.deepEqual(s.getRecents('stop').map((x) => [x.code, x.city]), [['5', 'patra'], ['6', 'patra']]);
  assert.equal(s.getRecents('place')[0].city, 'patra');
  assert.equal(s.getSettings().theme, 'dark');
  const raw = JSON.parse(ls.getItem(KEY));
  assert.equal(raw.v, 3);
  assert.deepEqual(raw.favorites, [{ code: '1011', city: 'patra' }, { code: '2022', city: 'patra' }]);
  assert.ok(raw.recents.stop.every((x) => x.city === 'patra'));
  // the other city sees none of it
  city.v = 'corfu';
  assert.deepEqual(s.getFavorites(), []);
  assert.deepEqual(s.getRecents('stop'), []);
  assert.deepEqual(s.getRecents('place'), []);
});

test('store: favourites are per city; the same stop code in two cities is two favourites', () => {
  const ls = fakeStorage();
  const city = { v: 'patra' };
  const s = mk(ls, city);
  s.addFavorite('801');
  s.addFavorite('1011');
  city.v = 'corfu';
  assert.equal(s.isFavorite('801'), false);
  assert.equal(s.addFavorite('801'), true);
  s.addFavorite('900');
  assert.deepEqual(s.getFavorites(), ['801', '900']);
  assert.equal(s.moveFavorite('900', -1), 0);
  assert.deepEqual(s.getFavorites(), ['900', '801']);
  assert.equal(s.removeFavorite('1011'), false); // Patras's favourite is not Corfu's to remove
  city.v = 'patra';
  assert.deepEqual(s.getFavorites(), ['801', '1011']); // untouched by the moves in Corfu
  assert.equal(s.toggleFavorite('801'), false);
  city.v = 'corfu';
  assert.deepEqual(s.getFavorites(), ['900', '801']);
});

test('store: recents are per city, capped per city, cleared per city', () => {
  const city = { v: 'patra' };
  const s = mk(fakeStorage(), city);
  for (let i = 0; i < 12; i++) s.addRecent('stop', { code: String(i), name: 'p' + i });
  city.v = 'corfu';
  assert.deepEqual(s.getRecents('stop'), []);
  s.addRecent('stop', { code: '3', name: 'c3' }); // same code as a Patras recent: separate item
  s.addRecent('place', { name: 'Old Town', lat: 39.62, lng: 19.92 });
  assert.deepEqual(s.getRecents('stop').map((x) => [x.code, x.name]), [['3', 'c3']]);
  city.v = 'patra';
  assert.equal(s.getRecents('stop').length, 10); // Corfu's did not push Patras's out
  assert.equal(s.getRecents('stop').find((x) => x.code === '3').name, 'p3');
  assert.deepEqual(s.getRecents('place'), []);
  assert.equal(s.removeRecent('stop', '3'), true);
  assert.equal(s.getRecents('stop').some((x) => x.code === '3'), false);
  city.v = 'corfu';
  assert.equal(s.getRecents('stop').length, 1, 'removing in Patras left Corfu alone');
  s.clearRecents();
  assert.deepEqual(s.getRecents('stop'), []);
  assert.deepEqual(s.getRecents('place'), []);
  city.v = 'patra';
  assert.equal(s.getRecents('stop').length, 9, 'clearing in Corfu left Patras alone');
});

test('store: the city setting is validated and survives a settings reset', () => {
  const s = mk(fakeStorage(), { v: 'patra' });
  assert.equal(s.getSettings().city, undefined);
  assert.equal(s.setSetting('city', 'atlantis'), false);
  assert.equal(s.setSetting('city', 'corfu'), true);
  assert.equal(s.getSettings().city, 'corfu');
  s.setSetting('theme', 'dark');
  s.resetSettings();
  assert.deepEqual(s.getSettings(), { theme: 'auto', walkSpeed: 'normal', bufferMin: 2, reminderMin: 2, lang: 'el', city: 'corfu' });
  s.clearAll();
  assert.equal(s.getSettings().city, undefined);
});

test('store: junk city values in a stored blob fall back to Patras', () => {
  const dirty = { v: 3, favorites: [{ code: '1', city: 'atlantis' }, { code: '2', city: 'corfu' }, { code: '', city: 'corfu' }], recents: { stop: [{ code: '7', city: 42 }] }, settings: { city: 'mars' } };
  const city = { v: 'patra' };
  const s = mk(fakeStorage({ [KEY]: JSON.stringify(dirty) }), city);
  assert.deepEqual(s.getFavorites(), ['1']);
  assert.equal(s.getRecents('stop')[0].code, '7');
  assert.equal(s.getSettings().city, undefined);
  city.v = 'corfu';
  assert.deepEqual(s.getFavorites(), ['2']);
});

// ---------------------------------------------------------------- api
function transport() {
  const calls = [];
  let now = Date.UTC(2026, 9, 10, 10, 0, 0);
  const t = {
    calls,
    advance: (ms) => { now += ms; },
    install: () => _setTransport({
      now: () => now,
      fetch: async (url) => { calls.push(url); return { ok: true, status: 200, json: async () => ({ fetchedAt: now, vehicles: [], samples: 20, medianDelaySec: 60 }) }; },
    }),
  };
  t.install();
  return t;
}

test('api: URLs are city-prefixed for every city, Patras included', () => {
  assert.equal(liveUrl('1011'), `${API_BASE}/api/patra/live/1011`);
  assert.equal(liveUrl('801', 'corfu'), `${API_BASE}/api/corfu/live/801`);
  assert.equal(statsUrl('6091', '1011'), `${API_BASE}/api/patra/stats/6091/1011`);
  assert.equal(statsUrl('1', '2', 'corfu'), `${API_BASE}/api/corfu/stats/1/2`);
});

test('api: fetchLive / fetchStats call the active city; the 15 s memo is keyed by city + code', async () => {
  const w = transport();
  try {
    await fetchLive('801');
    assert.deepEqual(w.calls, [`${API_BASE}/api/patra/live/801`]);
    await withCity('corfu', async () => {
      assert.equal(lastAttemptAt('801'), 0, 'Patras attempt does not count for Corfu');
      await fetchLive('801'); // same code, other city: its own request inside the 15 s window
      assert.equal(w.calls.length, 2);
      assert.equal(w.calls[1], `${API_BASE}/api/corfu/live/801`);
      await fetchLive('801');
      assert.equal(w.calls.length, 2, 'memo holds inside Corfu');
      assert.ok(lastAttemptAt('801') > 0);
      await fetchStats('6', '801');
      assert.equal(w.calls[2], `${API_BASE}/api/corfu/stats/6/801`);
    });
    await fetchLive('801');
    assert.equal(w.calls.length, 3, 'back in Patras the memo still holds (3 = the stats call above)');
    w.advance(MIN_GAP_MS);
    await fetchLive('801');
    assert.equal(w.calls.length, 4);
    assert.equal(w.calls[3], `${API_BASE}/api/patra/live/801`);
    await fetchStats('6', '801'); // Patras stats: not served from Corfu's memo
    assert.equal(w.calls[4], `${API_BASE}/api/patra/stats/6/801`);
  } finally { _setTransport(); }
});

// ---------------------------------------------------------------- places / routines / reminders / trip / push
test('places: per city; the other city keeps its own Σπίτι', () => {
  const ls = fakeStorage();
  const city = { v: 'patra' };
  const p = createPlaces({ storage: ls, city: () => city.v });
  p.setPlace({ id: 'home', name: 'Σπίτι', lat: 38.2466, lng: 21.7346 });
  city.v = 'corfu';
  assert.deepEqual(p.getPlaces(), []);
  p.setPlace({ id: 'home', name: 'Σπίτι', lat: 39.62, lng: 19.92 });
  p.setPlace({ name: 'Cafe', lat: 39.63, lng: 19.91 });
  assert.deepEqual(p.getPlaces().map((x) => [x.id === 'home' ? 'home' : 'custom', x.city, x.lat]), [['home', 'corfu', 39.62], ['custom', 'corfu', 39.63]]);
  city.v = 'patra';
  assert.deepEqual(p.getPlaces().map((x) => [x.id, x.city, x.lat]), [['home', 'patra', 38.2466]]);
  assert.equal(p.removePlace('home'), true);
  city.v = 'corfu';
  assert.equal(p.getPlaces().length, 2, 'removing in Patras left Corfu alone');
  assert.equal(JSON.parse(ls.getItem('patra-bus:places')).length, 2);
});

test('places: items saved before multi-city (no `city`) are Patras', () => {
  const old = [{ id: 'home', name: 'Σπίτι', lat: 38.2466, lng: 21.7346 }];
  const city = { v: 'corfu' };
  const p = createPlaces({ storage: fakeStorage({ 'patra-bus:places': JSON.stringify(old) }), city: () => city.v });
  assert.deepEqual(p.getPlaces(), []);
  city.v = 'patra';
  assert.deepEqual(p.getPlaces().map((x) => x.city), ['patra']);
});

const SUB = { endpoint: 'https://push.example/abc', keys: { p256dh: 'P', auth: 'A' } };
const TRIP = { stopCode: '801', routeCode: '1', lineCode: '1', offsetSec: 120 };
const PAYLOAD = (city) => buildRoutinePayload({ subscription: SUB, days: [1], time: '07:45', trip: TRIP, city });

test('routines: payload carries the city; stored routines are per city', async () => {
  assert.equal(PAYLOAD('corfu').city, 'corfu');
  assert.equal(PAYLOAD(undefined).city, 'patra');
  assert.equal(PAYLOAD('atlantis').city, 'patra');
  let n = 0;
  const fetchFn = async () => ({ ok: true, status: 201, json: async () => ({ id: `r${n++}` }) });
  const city = { v: 'patra' };
  const r = createRoutines({ storage: fakeStorage(), fetchFn, apiBase: 'http://api', city: () => city.v });
  assert.equal((await r.bookRoutine(PAYLOAD('patra'))).ok, true);
  city.v = 'corfu';
  assert.deepEqual(r.getRoutines(), []);
  assert.equal((await r.bookRoutine(PAYLOAD('corfu'))).routine.city, 'corfu');
  assert.deepEqual(r.getRoutines().map((x) => x.id), ['r1']);
  city.v = 'patra';
  assert.deepEqual(r.getRoutines().map((x) => x.id), ['r0']);
  await r.removeRoutine('r0');
  city.v = 'corfu';
  assert.deepEqual(r.getRoutines().map((x) => x.id), ['r1'], 'removing in Patras left Corfu alone');
  assert.equal(cleanRoutine({ id: 'x', days: [1], time: '07:00', trip: TRIP }).city, 'patra'); // legacy
});

test('reminders: tagged with the city; lists and lookups show the active city only; due ones fire anywhere', () => {
  let t = 1_700_000_000_000;
  const timers = [];
  const fired = [];
  const ls = fakeStorage();
  const city = { v: 'patra' };
  const booked = [];
  const push = { state: () => 'on', schedule: async (p) => { booked.push(p); return null; }, cancel: async () => {} };
  const r = createReminders({ storage: () => ls, now: () => t, setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {}, onFire: (x) => fired.push(x), push, city: () => city.v });
  r.scheduleReminder({ at: t + 60_000, title: 'P', tag: 'a', url: '#/patra/plan' });
  city.v = 'corfu';
  r.scheduleReminder({ at: t + 90_000, title: 'C', tag: 'b', url: '#/corfu/plan' });
  assert.deepEqual(r.listReminders().map((x) => [x.tag, x.city]), [['b', 'corfu']]);
  assert.equal(r.hasReminder('a'), false);
  assert.equal(r.hasReminder('b'), true);
  assert.deepEqual(booked.map((b) => b.city), ['patra', 'corfu'], 'the server is told which city');
  city.v = 'patra';
  assert.deepEqual(r.listReminders().map((x) => x.tag), ['a']);
  t += 100_000;
  r.tick();
  assert.deepEqual(fired.map((x) => [x.tag, x.city]), [['a', 'patra'], ['b', 'corfu']]);
  assert.deepEqual(r.listReminders(), []);
});

test('reminders: stored ones without `city` (older app) are Patras', () => {
  const t = 1_700_000_000_000;
  const stored = { v: 1, items: [{ id: '1', tag: 'old', at: t + 60_000, title: 'Old' }] };
  const city = { v: 'corfu' };
  const r = createReminders({ storage: () => fakeStorage({ 'patra-bus:reminders': JSON.stringify(stored) }), now: () => t, setTimer: () => 1, clearTimer: () => {}, city: () => city.v });
  assert.deepEqual(r.listReminders(), []);
  city.v = 'patra';
  assert.deepEqual(r.listReminders().map((x) => [x.tag, x.city]), [['old', 'patra']]);
});

test('push: the reminder body names the city (default: the active one)', async () => {
  const base = { at: Date.now() + 60_000, title: 'T', tag: 'x' };
  assert.equal(buildReminderBody(SUB, { ...base, city: 'corfu' }).city, 'corfu');
  assert.equal(buildReminderBody(SUB, base).city, 'patra');
  assert.equal(buildReminderBody(SUB, { ...base, city: 'atlantis' }).city, 'patra');
  await withCity('corfu', () => assert.equal(buildReminderBody(SUB, base).city, 'corfu'));
});

test('onboard: a trip started in another city is not this city\'s trip (and is not deleted)', () => {
  const NOW = 1_700_000_000_000;
  const trip = { alightStop: '801', routeCode: '1', startedAt: NOW, city: 'corfu' };
  const ls = fakeStorage({ [TRIP_KEY]: JSON.stringify(trip) });
  assert.equal(loadTrip(() => ls, NOW, 'patra'), null);
  assert.ok(ls.getItem(TRIP_KEY), 'kept for Corfu');
  assert.equal(loadTrip(() => ls, NOW, 'corfu').alightStop, '801');
  const legacy = fakeStorage({ [TRIP_KEY]: JSON.stringify({ alightStop: '1', routeCode: '2', startedAt: NOW }) });
  assert.equal(loadTrip(() => legacy, NOW, 'patra').alightStop, '1');
  assert.equal(loadTrip(() => legacy, NOW, 'corfu'), null);
});

// ---------------------------------------------------------------- data
test('data: a city without routes.json still builds an index (no route order, no crash)', () => {
  const stops = [{ code: 801, name: 'ΠΛ. ΣΑΡΟΚΟΥ', latitude: 39.62, longitude: 19.92, lineCodes: ['2A'], routeCodes: ['9'] }];
  const lines = [{ code: '2A', name: 'Test', color: '#000', textColor: '#fff', routes: [{ code: 9, name: 'R', direction: 1 }] }];
  for (const routes of [null, undefined, {}]) {
    const d = buildIndex(stops, lines, routes);
    assert.equal(d.stops.length, 1);
    assert.equal(d.routes.length, 0);
    assert.equal(d.stopByCode.get('801').displayName.length > 0, true);
    assert.equal(d.meta.routesGeneratedAt, null);
  }
});
