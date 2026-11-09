import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlaces, pickPlace, usableItinerary, cleanPlace, placeHash, MAX_CUSTOM } from '../web/js/places.js';

function fakeStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
}
const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); }, removeItem() { throw new Error('denied'); } };

const HOME = { id: 'home', name: 'Σπίτι', lat: 38.2466, lng: 21.7346 };
const WORK = { id: 'work', name: 'Δουλειά', lat: 38.2900, lng: 21.7900 };
const AT_HOME = { lat: 38.2467, lng: 21.7347 };
const FAR = { lat: 38.2700, lng: 21.7600 }; // ~3 km from both

// ---------------------------------------------------------------- places storage

test('places: set / get / remove, home and work first', () => {
  const p = createPlaces({ storage: fakeStorage() });
  assert.deepEqual(p.getPlaces(), []);
  const cafe = p.setPlace({ name: 'Καφέ', lat: 38.25, lng: 21.74 });
  assert.ok(cafe.id && cafe.id !== 'home');
  p.setPlace(WORK);
  p.setPlace(HOME);
  assert.deepEqual(p.getPlaces().map((x) => x.id), ['home', 'work', cafe.id]);
  p.setPlace({ ...HOME, lat: 38.24, lng: 21.73 });
  assert.equal(p.getPlaces().length, 3);
  assert.equal(p.getPlaces()[0].lat, 38.24);
  assert.equal(p.removePlace(cafe.id), true);
  assert.equal(p.removePlace(cafe.id), false);
  assert.deepEqual(p.getPlaces().map((x) => x.id), ['home', 'work']);
});

test('places: at most 3 custom places; home/work do not count; invalid input rejected', () => {
  let n = 0;
  const p = createPlaces({ storage: fakeStorage(), rand: () => (n++ % 10) / 10 });
  for (let i = 0; i < MAX_CUSTOM; i++) assert.ok(p.setPlace({ name: `Τ${i}`, lat: 38.2 + i / 100, lng: 21.7 }));
  assert.equal(p.setPlace({ name: 'Τέταρτος', lat: 38.3, lng: 21.7 }), null);
  assert.ok(p.setPlace(HOME) && p.setPlace(WORK));
  assert.equal(p.getPlaces().length, 5);
  const first = p.getPlaces().find((x) => x.name === 'Τ0');
  assert.ok(p.setPlace({ ...first, name: 'Μετονομασία' })); // editing an existing one is fine at the cap
  assert.equal(p.getPlaces().filter((x) => x.name === 'Μετονομασία').length, 1);
  assert.equal(p.setPlace({ id: 'home', lat: 'x', lng: 21 }), null);
  assert.equal(p.setPlace({ id: 'home', lat: 0, lng: 0 }), null); // 0/0 never stored
  assert.equal(cleanPlace({ id: 'home', lat: 91, lng: 0 }), null);
});

test('places: default names, name clipped, corrupt storage ignored', () => {
  assert.equal(cleanPlace({ id: 'work', lat: 38.2, lng: 21.7 }).name, 'Δουλειά');
  assert.equal(cleanPlace({ id: 'x1', name: 'α'.repeat(100), lat: 38.2, lng: 21.7 }).name.length, 40);
  const bad = createPlaces({ storage: fakeStorage({ 'patra-bus:places': '{oops' }) });
  assert.deepEqual(bad.getPlaces(), []);
  const mixed = createPlaces({ storage: fakeStorage({ 'patra-bus:places': JSON.stringify([HOME, HOME, { id: 'z', lat: 'no' }, null]) }) });
  assert.deepEqual(mixed.getPlaces().map((x) => x.id), ['home']);
});

test('places: unusable localStorage falls back to memory and keeps working', () => {
  for (const storage of [broken, null]) {
    const p = createPlaces({ storage });
    let seen = 0;
    p.onPlacesChange(() => seen++);
    assert.ok(p.setPlace(HOME));
    assert.deepEqual(p.getPlaces().map((x) => x.id), ['home']);
    assert.ok(p.setPlace(WORK));
    assert.equal(p.removePlace('home'), true);
    assert.deepEqual(p.getPlaces().map((x) => x.id), ['work']);
    assert.equal(seen, 3);
  }
});

test('places: placeHash matches the planner deep link', () => {
  assert.equal(placeHash(HOME), '#/plan?to=38.24660,21.73460&name=%CE%A3%CF%80%CE%AF%CF%84%CE%B9');
});

// ---------------------------------------------------------------- selection

test('pickPlace: nothing within 300 m, unknown location → null', () => {
  assert.equal(pickPlace([HOME], AT_HOME, { hour: 20 }), null);
  assert.equal(pickPlace([HOME, WORK], null, { hour: 8 }), null);
  assert.equal(pickPlace([], FAR, { hour: 8 }), null);
});

test('pickPlace: mornings → Δουλειά, evenings → Σπίτι, midday → farthest', () => {
  const places = [HOME, WORK];
  assert.equal(pickPlace(places, FAR, { hour: 8 }).id, 'work');
  assert.equal(pickPlace(places, FAR, { hour: 19 }).id, 'home');
  assert.equal(pickPlace(places, FAR, { hour: 1 }).id, 'home');
  assert.equal(pickPlace(places, AT_HOME, { hour: 13 }).id, 'work'); // only work is far
  const near = { lat: 38.2475, lng: 21.7346 };
  assert.equal(pickPlace(places, near, { hour: 13 }).id, 'work'); // farthest
});

test('pickPlace: preferred place too close → the other one; custom places are candidates', () => {
  assert.equal(pickPlace([HOME, WORK], AT_HOME, { hour: 19 }).id, 'work');
  const gym = { id: 'p1', name: 'Γυμναστήριο', lat: 38.30, lng: 21.80 };
  assert.equal(pickPlace([HOME, gym], AT_HOME, { hour: 8 }).id, 'p1');
  assert.equal(pickPlace([HOME, WORK, gym], AT_HOME, { hour: 8 }).id, 'work');
});

test('usableItinerary: first walk or catchable bus; missed/none skipped', () => {
  const now = 1_700_000_000_000;
  const bus = (secs) => ({ kind: 'bus', bus: { departAt: now + secs * 1000 }, walkTo: { seconds: 120 }, bufferSec: 120 });
  const missed = bus(60); // 60 s left, walk 120 s
  const none = { kind: 'bus', bus: null };
  const ok = bus(900);
  assert.equal(usableItinerary([missed, none, ok], now), ok);
  assert.equal(usableItinerary([missed, none], now), null);
  const walk = { kind: 'walk' };
  assert.equal(usableItinerary([none, walk, ok], now), walk);
  assert.equal(usableItinerary([], now), null);
  assert.equal(usableItinerary(null, now), null);
});
