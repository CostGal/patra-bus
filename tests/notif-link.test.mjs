import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateUrl, newRef, notifHash, createLinks, resolveNotif, LINKS_KEY } from '../web/js/notif-link.js';
import { buildRoutinePayload, cleanRoutine } from '../web/js/routines.js';
import { parseHash } from '../web/js/route.js';

function fakeStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
}

test('isPrivateUrl: coordinates or a place name in the link', () => {
  for (const u of ['#/plan?to=1,2', 'https://x/p/#/corfu/plan?to=1,2&name=a', '#/plan?name=Σπίτι', '#/plan?from=1,2', '#/pin?lat=1&lng=2', 'https://x/?demo#/plan?x=1&to=1,2']) {
    assert.equal(isPrivateUrl(u), true, u);
  }
  for (const u of ['#/', '#/plan', '#/patra/notif?routine=ab&stop=1011', '#/stop/1011', 'https://x/?demo#/stop/1', '#/line/601?route=2015', '#/bus/x?route=1&stop=2', undefined, null, 5]) {
    assert.equal(isPrivateUrl(u), false, String(u));
  }
});

test('newRef / notifHash', () => {
  const a = newRef();
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.notEqual(a, newRef());
  assert.equal(notifHash({ routine: 'abc', stop: '1011' }, 'patra'), '#/patra/notif?routine=abc&stop=1011');
  assert.equal(notifHash({ ref: 'r1', stop: '0015' }, 'corfu'), '#/corfu/notif?ref=r1&stop=0015');
  assert.equal(notifHash({ ref: 'r1' }, 'corfu'), '#/corfu/notif?ref=r1');
  const p = parseHash(notifHash({ routine: 'abc', stop: '0015' }, 'corfu'));
  assert.deepEqual([p.city, p.parts[0], p.params.routine, p.params.stop], ['corfu', 'notif', 'abc', '0015']);
  assert.equal(isPrivateUrl(notifHash({ routine: 'abc', stop: '1' }, 'patra')), false);
});

test('createLinks: save/get, expiry, cap, no storage', () => {
  let now = 1000;
  const storage = fakeStorage();
  const links = createLinks({ storage: () => storage, now: () => now });
  const r1 = links.save('#/patra/plan?to=1,2', 5000);
  assert.equal(links.get(r1), '#/patra/plan?to=1,2');
  assert.equal(links.get('nope'), null);
  now = 5000;
  assert.equal(links.get(r1), null); // expired
  links.save('#/x', 9000);
  assert.equal(JSON.parse(storage.getItem(LINKS_KEY)).length, 1); // the expired one was pruned on write
  for (let i = 0; i < 30; i++) links.save(`#/p${i}`, 9000);
  assert.equal(JSON.parse(storage.getItem(LINKS_KEY)).length, 20);
  const none = createLinks({ storage: () => { throw new Error('blocked'); } });
  const r = none.save('#/a');
  assert.equal(none.get(r), null);
  storage.setItem(LINKS_KEY, '{bad');
  assert.equal(links.get(r1), null);
});

test('resolveNotif: routine → plan to its place as it is now; else the stop; else home', () => {
  const places = [{ id: 'work', name: 'Δουλειά & Co', lat: 38.246123, lng: 21.735011 }];
  const routines = [{ id: 's1', ref: 'ab', placeId: 'work', trip: { stopCode: '1011' } }, { id: 's2', ref: 'cd', placeId: 'gone', trip: { stopCode: '372' } }];
  const ctx = { routines, places, hasStop: (c) => c !== '999' };
  assert.equal(resolveNotif({ routine: 'ab', stop: '1011' }, ctx), `#/plan?to=38.24612,21.73501&name=${encodeURIComponent('Δουλειά & Co')}`);
  assert.equal(resolveNotif({ routine: 'cd', stop: '1011' }, ctx), '#/stop/372'); // place deleted → its stop
  assert.equal(resolveNotif({ routine: 'zz', stop: '1011' }, ctx), '#/stop/1011'); // routine deleted → link's stop
  assert.equal(resolveNotif({ routine: 'zz', stop: '999' }, ctx), '#/'); // unknown stop
  assert.equal(resolveNotif({ routine: 'zz' }, ctx), '#/');
  // the place moved since booking: the tap follows it
  const moved = { ...ctx, places: [{ ...places[0], lat: 38.1, lng: 21.5 }] };
  assert.match(resolveNotif({ routine: 'ab' }, moved), /^#\/plan\?to=38\.10000,21\.50000&/);
});

test('resolveNotif: one-off reminder → the kept plan hash; else the stop', () => {
  const storage = fakeStorage();
  const links = createLinks({ storage: () => storage });
  const ref = links.save('#/corfu/plan?to=39.6,19.9&name=a');
  const ctx = { links, hasStop: () => true };
  assert.equal(resolveNotif({ ref, stop: '0015' }, ctx), '#/plan?to=39.6,19.9&name=a');
  assert.equal(resolveNotif({ ref: 'other', stop: '0015' }, ctx), '#/stop/0015');
  assert.equal(resolveNotif({}, ctx), '#/');
  assert.equal(resolveNotif({ stop: '1011' }, {}), '#/stop/1011');
});

test('routines client: payload never carries a place link; the local copy keeps ref', () => {
  const base = { subscription: { endpoint: 'https://push/x' }, days: [1], time: '08:00', title: 'T', trip: { stopCode: '1011', routeCode: '2015', lineCode: '201', offsetSec: 60 } };
  const opaque = 'http://localhost:8080/#/patra/notif?routine=ab&stop=1011';
  assert.equal(buildRoutinePayload({ ...base, url: opaque }).url, opaque);
  assert.equal(buildRoutinePayload({ ...base, url: 'http://localhost:8080/#/patra/plan?to=38.2,21.7&name=Home' }).url, '');
  const r = cleanRoutine({ id: 's1', days: [1], time: '08:00', placeId: 'work', trip: base.trip, leadMin: 5, ref: 'ab' });
  assert.equal(r.ref, 'ab');
  assert.ok(!('ref' in cleanRoutine({ id: 's1', days: [1], time: '08:00', trip: base.trip }))); // booked before TEL-13
});
