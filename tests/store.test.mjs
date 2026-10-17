import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, KEY, DEFAULT_SETTINGS, resolveTheme } from '../web/js/store.js';

// Minimal Storage fake (+ switches to simulate a disabled / full / read-only storage).
function fakeStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    m, failSet: false, failGet: false,
    getItem(k) { if (this.failGet) throw new Error('SecurityError'); return m.has(k) ? m.get(k) : null; },
    setItem(k, v) { if (this.failSet) throw new Error('QuotaExceededError'); m.set(k, String(v)); },
    removeItem(k) { m.delete(k); },
  };
}
const make = (ls = fakeStorage(), events = new EventTarget()) => ({ ls, events, s: createStore({ storage: () => ls, events }) });
const codes = (list) => list.map((x) => x.code);
const storageEvent = (key) => Object.assign(new Event('storage'), { key });

test('defaults', () => {
  const { s } = make();
  assert.deepEqual(s.getFavorites(), []);
  assert.deepEqual(s.getRecents('stop'), []);
  assert.deepEqual(s.getRecents('place'), []);
  assert.deepEqual(s.getSettings(), { theme: 'auto', walkSpeed: 'normal', bufferMin: 2, reminderMin: 2, lang: 'el' });
  assert.deepEqual(s.getSettings(), { ...DEFAULT_SETTINGS });
  assert.equal(s.isFavorite('1011'), false);
});

test('favourites: toggle, order, strings, persistence', () => {
  const { s, ls } = make();
  assert.equal(s.toggleFavorite('1011'), true);
  assert.equal(s.toggleFavorite(2022), true); // numbers become strings
  assert.equal(s.toggleFavorite('3033'), true);
  assert.deepEqual(s.getFavorites(), ['1011', '2022', '3033']);
  assert.equal(s.isFavorite(1011), true);
  assert.equal(s.toggleFavorite('2022'), false);
  assert.deepEqual(s.getFavorites(), ['1011', '3033']);
  assert.equal(s.addFavorite('1011'), false); // no duplicates
  assert.equal(s.addFavorite(''), false);
  // a fresh instance over the same storage sees it
  const s2 = createStore({ storage: () => ls, events: null });
  assert.deepEqual(s2.getFavorites(), ['1011', '3033']);
});

test('favourites: getFavorites returns a copy', () => {
  const { s } = make();
  s.addFavorite('1');
  s.getFavorites().push('x');
  assert.deepEqual(s.getFavorites(), ['1']);
});

test('favourites: move up/down and remove', () => {
  const { s } = make();
  ['a', 'b', 'c', 'd'].forEach((c) => s.addFavorite(c));
  assert.equal(s.moveFavorite('c', -1), 1);
  assert.deepEqual(s.getFavorites(), ['a', 'c', 'b', 'd']);
  assert.equal(s.moveFavorite('a', -1), 0); // already first
  assert.equal(s.moveFavorite('d', 1), 3); // already last
  assert.equal(s.moveFavorite('a', 1), 1);
  assert.deepEqual(s.getFavorites(), ['c', 'a', 'b', 'd']);
  assert.equal(s.moveFavorite('zzz', 1), -1);
  assert.equal(s.removeFavorite('a'), true);
  assert.equal(s.removeFavorite('a'), false);
  assert.deepEqual(s.getFavorites(), ['c', 'b', 'd']);
});

test('migrates the old `favs` key once, then removes it', () => {
  const ls = fakeStorage({ favs: JSON.stringify(['1011', 2022, '1011', '']) });
  const { s } = make(ls);
  assert.deepEqual(s.getFavorites(), ['1011', '2022']);
  assert.equal(ls.getItem('favs'), null);
  assert.deepEqual(JSON.parse(ls.getItem(KEY)).favorites, [{ code: '1011', city: 'patra' }, { code: '2022', city: 'patra' }]);
});

test('migration ignores garbage in the old key and does not override v2 data', () => {
  assert.deepEqual(make(fakeStorage({ favs: '{not json' })).s.getFavorites(), []);
  assert.deepEqual(make(fakeStorage({ favs: '"str"' })).s.getFavorites(), []);
  const ls = fakeStorage({ favs: JSON.stringify(['old']), [KEY]: JSON.stringify({ v: 2, favorites: ['new'] }) });
  assert.deepEqual(make(ls).s.getFavorites(), ['new']);
});

test('recents: newest first, dedupe, max 10 per kind, kinds independent', () => {
  const { s } = make();
  for (let i = 1; i <= 12; i++) s.addRecent('stop', String(i)); // bare codes are stored as { code, city }
  assert.deepEqual(codes(s.getRecents('stop')), ['12', '11', '10', '9', '8', '7', '6', '5', '4', '3']);
  s.addRecent('stop', '5'); // moves to front, no duplicate
  assert.deepEqual(codes(s.getRecents('stop')).slice(0, 3), ['5', '12', '11']);
  assert.equal(s.getRecents('stop').length, 10);
  assert.deepEqual(s.getRecents('place'), []);
});

test('recents: objects dedupe by stop code or rounded coordinates', () => {
  const { s } = make();
  s.addRecent('place', { kind: 'place', name: 'Πλατεία Γεωργίου', lat: 38.24661, lng: 21.73461 });
  s.addRecent('place', { kind: 'stop', name: 'Στάση', stopCode: '1011', lat: 38.1, lng: 21.7 });
  s.addRecent('place', { kind: 'place', name: 'Πλατεία (ξανά)', lat: 38.246612, lng: 21.734608 }); // same ~11 m cell
  const r = s.getRecents('place');
  assert.equal(r.length, 2);
  assert.equal(r[0].name, 'Πλατεία (ξανά)');
  assert.equal(r[1].stopCode, '1011');
  // stored items are copies
  r[0].name = 'mutated';
  assert.equal(s.getRecents('place')[0].name, 'Πλατεία (ξανά)');
  s.addRecent('stop', { code: '7' }); s.addRecent('stop', '7');
  assert.equal(s.getRecents('stop').length, 1);
});

test('recents: remove and clear; null items ignored', () => {
  const { s } = make();
  s.addRecent('stop', '1'); s.addRecent('stop', '2'); s.addRecent('place', { name: 'x', lat: 1, lng: 2 });
  s.addRecent('stop', null);
  assert.equal(s.removeRecent('stop', '1'), true);
  assert.equal(s.removeRecent('stop', '1'), false);
  assert.deepEqual(codes(s.getRecents('stop')), ['2']);
  s.clearRecents('stop');
  assert.deepEqual(s.getRecents('stop'), []);
  assert.equal(s.getRecents('place').length, 1);
  s.clearRecents();
  assert.equal(s.getRecents('place').length, 0);
});

test('settings: set, validate, coerce numeric strings, reject unknown', () => {
  const { s, ls } = make();
  assert.equal(s.setSetting('theme', 'dark'), true);
  assert.equal(s.setSetting('walkSpeed', 'fast'), true);
  assert.equal(s.setSetting('bufferMin', '5'), true); // from a <select>
  assert.equal(s.setSetting('reminderMin', 3), true);
  assert.deepEqual(s.getSettings(), { theme: 'dark', walkSpeed: 'fast', bufferMin: 5, reminderMin: 3, lang: 'el' });
  assert.equal(s.setSetting('theme', 'blue'), false);
  assert.equal(s.setSetting('bufferMin', -1), false);
  assert.equal(s.setSetting('bufferMin', 2.5), false);
  assert.equal(s.setSetting('bufferMin', 'abc'), false);
  assert.equal(s.setSetting('nope', 1), false);
  assert.equal(s.getSettings().theme, 'dark');
  assert.equal(s.getSettings().nope, undefined);
  assert.deepEqual(JSON.parse(ls.getItem(KEY)).settings, { theme: 'dark', walkSpeed: 'fast', bufferMin: 5, reminderMin: 3 });
  s.resetSettings();
  assert.deepEqual(s.getSettings(), { ...DEFAULT_SETTINGS });
});

test('corrupt or foreign data falls back to defaults / is sanitised', () => {
  assert.deepEqual(make(fakeStorage({ [KEY]: '{oops' })).s.getSettings(), { ...DEFAULT_SETTINGS });
  assert.deepEqual(make(fakeStorage({ [KEY]: 'null' })).s.getFavorites(), []);
  const dirty = { v: 2, favorites: ['1', '1', null, 5], recents: { stop: 'x', place: [null, { name: 'a', lat: 1, lng: 2 }] }, settings: { theme: 'purple', bufferMin: 4, junk: true } };
  const { s } = make(fakeStorage({ [KEY]: JSON.stringify(dirty) }));
  assert.deepEqual(s.getFavorites(), ['1', '5']);
  assert.deepEqual(s.getRecents('stop'), []);
  assert.equal(s.getRecents('place').length, 1);
  assert.deepEqual(s.getSettings(), { ...DEFAULT_SETTINGS, bufferMin: 4 });
});

test('storage unavailable: works in memory', () => {
  const events = new EventTarget();
  const s = createStore({ storage: () => { throw new Error('SecurityError'); }, events });
  assert.equal(s.toggleFavorite('1'), true);
  s.addRecent('stop', '9');
  s.setSetting('theme', 'light');
  assert.deepEqual(s.getFavorites(), ['1']);
  assert.deepEqual(codes(s.getRecents('stop')), ['9']);
  assert.equal(s.getSettings().theme, 'light');
  const none = createStore({ storage: () => null, events: null });
  none.addFavorite('x');
  assert.deepEqual(none.getFavorites(), ['x']);
});

test('storage that throws on read or write keeps memory state', () => {
  const ls = fakeStorage();
  const { s } = make(ls);
  s.addFavorite('1');
  ls.failSet = true; // quota exceeded / read-only
  assert.equal(s.toggleFavorite('2'), true);
  assert.deepEqual(s.getFavorites(), ['1', '2']);
  ls.failSet = false; ls.failGet = true; // read blocked
  assert.deepEqual(s.getFavorites(), ['1', '2']);
  ls.failGet = false;
});

test('onChange: kinds, unsubscribe, isolation from throwing listeners', () => {
  const { s } = make();
  const seen = [];
  const off = s.onChange((k) => seen.push(k));
  s.onChange(() => { throw new Error('boom'); });
  s.toggleFavorite('1'); s.addRecent('stop', '1'); s.setSetting('theme', 'dark');
  s.setSetting('theme', 'dark'); // unchanged → no event
  assert.deepEqual(seen, ['favorites', 'recents', 'settings']);
  off();
  s.toggleFavorite('2');
  assert.equal(seen.length, 3);
});

test('cross-tab: storage event reloads state and notifies', () => {
  const ls = fakeStorage();
  const events = new EventTarget();
  const a = createStore({ storage: () => ls, events });
  const b = createStore({ storage: () => ls, events: new EventTarget() }); // "another tab" writes through the same storage
  const seen = [];
  a.onChange((k) => seen.push(k));
  assert.deepEqual(a.getFavorites(), []);
  b.addFavorite('77');
  events.dispatchEvent(storageEvent(KEY));
  assert.deepEqual(seen, ['all']);
  assert.deepEqual(a.getFavorites(), ['77']);
  events.dispatchEvent(storageEvent('something-else')); // ignored
  assert.deepEqual(seen, ['all']);
  b.clearAll();
  events.dispatchEvent(storageEvent(null)); // localStorage.clear()
  assert.deepEqual(a.getFavorites(), []);
});

test('reads see another tab even before the storage event arrives', () => {
  const ls = fakeStorage();
  const a = createStore({ storage: () => ls, events: null });
  const b = createStore({ storage: () => ls, events: null });
  a.addFavorite('1');
  b.addFavorite('2'); // b syncs before writing, so 1 is not lost
  assert.deepEqual(a.getFavorites(), ['1', '2']);
});

test('clearAll wipes everything including the legacy key', () => {
  const ls = fakeStorage();
  const { s } = make(ls);
  s.addFavorite('1'); s.addRecent('stop', '2'); s.setSetting('theme', 'dark');
  ls.setItem('favs', '["9"]');
  s.clearAll();
  assert.deepEqual(s.getFavorites(), []);
  assert.deepEqual(s.getRecents('stop'), []);
  assert.deepEqual(s.getSettings(), { ...DEFAULT_SETTINGS });
  assert.equal(ls.getItem(KEY), null);
  assert.equal(ls.getItem('favs'), null);
});

test('module singleton imports and works without localStorage', async () => {
  const m = await import('../web/js/store.js');
  assert.equal(typeof m.getFavorites, 'function');
  assert.deepEqual(m.getFavorites(), []);
  assert.equal(m.toggleFavorite('1011'), true);
  assert.equal(m.isFavorite('1011'), true);
  m.clearAll();
  assert.equal(resolveTheme('dark'), 'dark');
  assert.equal(resolveTheme('auto'), 'light'); // no matchMedia in node
});

// ---- reminders (notify.js core; persisted in the same kind of storage) ----
import { createReminders } from '../web/js/notify.js';

function remEnv() {
  let t = 1_000_000; const timers = []; const fired = []; const ls = fakeStorage();
  const mk = () => createReminders({
    storage: () => ls, now: () => t, onFire: (r) => fired.push(r.tag),
    setTimer: (fn, ms) => { const x = { fn, at: t + ms }; timers.push(x); return x; },
    clearTimer: (x) => { const i = timers.indexOf(x); if (i >= 0) timers.splice(i, 1); },
  });
  const advance = (ms) => { const end = t + ms; for (;;) { timers.sort((a, b) => a.at - b.at); const n = timers[0]; if (!n || n.at > end) break; timers.shift(); t = Math.max(t, n.at); n.fn(); } t = end; };
  return { mk, advance, fired, ls, now: () => t, set: (v) => { t = v; } };
}

test('reminders: fire once at the due time and are removed from storage', () => {
  const e = remEnv(); const r = e.mk();
  r.scheduleReminder({ at: e.now() + 70_000, title: 'a', tag: 'x' });
  assert.equal(r.listReminders().length, 1);
  e.advance(69_000); assert.deepEqual(e.fired, []);
  e.advance(2_000); assert.deepEqual(e.fired, ['x']);
  assert.equal(r.listReminders().length, 0);
  assert.equal(e.ls.getItem('patra-bus:reminders'), null);
  e.advance(100_000); assert.deepEqual(e.fired, ['x']);
});

test('reminders: same tag replaces; a stale cancel handle does not cancel the replacement', () => {
  const e = remEnv(); const r = e.mk();
  const h1 = r.scheduleReminder({ at: e.now() + 10_000, title: 'a', tag: 'x' });
  r.scheduleReminder({ at: e.now() + 20_000, title: 'b', tag: 'x' });
  assert.equal(r.listReminders().length, 1);
  assert.equal(r.listReminders()[0].title, 'b');
  h1.cancel(); assert.equal(r.listReminders().length, 1);
  e.advance(25_000); assert.deepEqual(e.fired, ['x']);
  r.scheduleReminder({ at: e.now() + 10_000, tag: 'y' }).cancel();
  e.advance(20_000); assert.deepEqual(e.fired, ['x']);
});

test('reminders: a reload re-arms pending ones; late-within-grace fire, stale are dropped', () => {
  const e = remEnv(); const a = e.mk();
  a.scheduleReminder({ at: e.now() + 60_000, title: 'soon', tag: 'soon' });
  const b = e.mk(); e.set(e.now() + 90_000); b.start(); // "reload" 30 s after it was due
  assert.deepEqual(e.fired, ['soon']);
  const e2 = remEnv(); const c = e2.mk();
  c.scheduleReminder({ at: e2.now() + 60_000, tag: 'old' });
  const d = e2.mk(); e2.set(e2.now() + 60_000 + 5 * 60_000); d.start(); // 5 min late: not worth firing
  assert.deepEqual(e2.fired, []); assert.equal(d.listReminders().length, 0);
});

test('reminders: a second tab sees cancellations; far-past times are not scheduled; bad input throws', () => {
  const e = remEnv(); const a = e.mk(); const b = e.mk();
  a.scheduleReminder({ at: e.now() + 10_000, tag: 'x' });
  assert.equal(b.hasReminder('x'), true);
  b.cancelReminder('x'); assert.equal(a.hasReminder('x'), false);
  e.advance(20_000); assert.deepEqual(e.fired, []);
  assert.equal(a.scheduleReminder({ at: e.now() - 10 * 60_000, tag: 'p' }).dropped, true);
  assert.throws(() => a.scheduleReminder({ at: 'soon' }), TypeError);
});

test('reminders: long horizons are re-checked at least every 30 s; works without storage', () => {
  const e = remEnv(); const r = e.mk();
  r.scheduleReminder({ at: e.now() + 10 * 60_000, tag: 'l' });
  e.advance(9 * 60_000); assert.deepEqual(e.fired, []);
  e.advance(61_000); assert.deepEqual(e.fired, ['l']);
  let t = 5000; const timers = []; const fired = [];
  const m = createReminders({ storage: () => null, now: () => t, setTimer: (fn) => { const x = { fn }; timers.push(x); return x; }, clearTimer() {}, onFire: (x) => fired.push(x.tag) });
  m.scheduleReminder({ at: t + 1000, tag: 'mem' });
  assert.equal(m.listReminders().length, 1);
  t += 1000; timers.at(-1).fn(); assert.deepEqual(fired, ['mem']);
});

test('settings: lang is auto|el|en, defaults to el, persists, rejects anything else', () => {
  const { s, ls } = make();
  assert.equal(s.getSettings().lang, 'el');
  for (const v of ['el', 'en', 'auto']) assert.equal(s.setSetting('lang', v), true);
  assert.equal(s.setSetting('lang', 'fr'), false);
  assert.equal(s.setSetting('lang', 'EN'), false);
  assert.equal(s.setSetting('lang', 1), false);
  s.setSetting('lang', 'en');
  assert.equal(JSON.parse(ls.getItem(KEY)).settings.lang, 'en');
  assert.equal(make(ls).s.getSettings().lang, 'en'); // survives a reload
  s.resetSettings();
  assert.equal(s.getSettings().lang, 'el');
});

test('settings: a corrupt stored lang is dropped to the default', () => {
  const dirty = { v: 2, favorites: [], recents: {}, settings: { lang: 'klingon', theme: 'dark' } };
  const { s } = make(fakeStorage({ [KEY]: JSON.stringify(dirty) }));
  assert.deepEqual(s.getSettings(), { ...DEFAULT_SETTINGS, theme: 'dark' });
});

test('settings: changing lang emits a settings event once', () => {
  const { s } = make();
  const seen = [];
  s.onChange((k) => seen.push(k));
  s.setSetting('lang', 'en'); s.setSetting('lang', 'en');
  assert.deepEqual(seen, ['settings']);
});

// ---- first-run flags (guide seen, install hint dismissed): booleans, absent = false ----
const FLAGS = ['guideSeen', 'installHintDismissed', 'welcomeSeen', 'legendSeen'];

test('first-run flags: absent by default, booleans only, persisted', () => {
  const { s, ls } = make();
  for (const key of FLAGS) {
    assert.equal(DEFAULT_SETTINGS[key], undefined);
    assert.equal(s.getSettings()[key], undefined);
    assert.equal(s.setSetting(key, true), true);
    assert.equal(s.getSettings()[key], true);
    assert.equal(JSON.parse(ls.getItem(KEY)).settings[key], true);
    assert.equal(s.setSetting(key, false), true);
    assert.equal(s.getSettings()[key], false);
    assert.equal(JSON.parse(ls.getItem(KEY)).settings[key], false);
  }
});

test('first-run flags: non-boolean values are rejected and leave state alone', () => {
  const { s } = make();
  for (const key of FLAGS) {
    for (const bad of ['true', 1, null]) assert.equal(s.setSetting(key, bad), false);
    assert.equal(s.getSettings()[key], undefined);
    s.setSetting(key, true);
    for (const bad of ['true', 1, null]) assert.equal(s.setSetting(key, bad), false);
    assert.equal(s.getSettings()[key], true);
  }
});

test('first-run flags: a dirty stored blob keeps only the valid one', () => {
  const dirty = { v: 3, favorites: [], recents: {}, settings: { guideSeen: 'yes', installHintDismissed: true } };
  const { s } = make(fakeStorage({ [KEY]: JSON.stringify(dirty) }));
  assert.deepEqual(s.getSettings(), { ...DEFAULT_SETTINGS, installHintDismissed: true });
});

test('first-run flags: survive resetSettings together with city, other settings are dropped', () => {
  const ls = fakeStorage();
  const { s } = make(ls);
  s.setSetting('city', 'patra');
  s.setSetting('theme', 'dark'); s.setSetting('bufferMin', 5);
  s.setSetting('guideSeen', true); s.setSetting('installHintDismissed', true);
  s.resetSettings();
  assert.deepEqual(s.getSettings(), { ...DEFAULT_SETTINGS, city: 'patra', guideSeen: true, installHintDismissed: true });
  assert.deepEqual(JSON.parse(ls.getItem(KEY)).settings, { city: 'patra', guideSeen: true, installHintDismissed: true });
});

test('first-run flags: clearAll wipes them', () => {
  const { s } = make();
  s.setSetting('guideSeen', true); s.setSetting('installHintDismissed', true);
  s.clearAll();
  for (const key of FLAGS) assert.equal(s.getSettings()[key], undefined);
  assert.deepEqual(s.getSettings(), { ...DEFAULT_SETTINGS });
});

test('first-run flags: one settings event per real change', () => {
  const { s } = make();
  const seen = [];
  s.onChange((k) => seen.push(k));
  s.setSetting('guideSeen', true); s.setSetting('guideSeen', true);
  s.setSetting('installHintDismissed', true); s.setSetting('installHintDismissed', 'yes');
  assert.deepEqual(seen, ['settings', 'settings']);
});
