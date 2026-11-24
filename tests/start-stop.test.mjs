// TEL-365: which stop a cold start opens. The order is the one Kostas chose; the rule is CLAUDE.md rule 6.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickStartStop, START_NEAR_M } from '../web/js/start-stop.js';

const A = { code: '093', lat: 38.2661, lng: 21.7568 };
const B = { code: '1011', lat: 38.2466, lng: 21.7346 };
const stops = [A, B];
const stopByCode = new Map(stops.map((s) => [s.code, s]));
const pick = (o) => pickStartStop({ stops, stopByCode, ...o });
const nearA = { lat: 38.2662, lng: 21.7569, accuracy: 20 };

test('start stop: the nearest stop wins over a favourite and a recent, and its code stays a string', () => {
  assert.equal(pick({ fix: nearA, favorites: ['1011'], recents: ['1011'] }), '093');
});

test('start stop: no fix, the first favourite; no favourite, the last stop opened; nothing, null', () => {
  assert.equal(pick({ favorites: ['1011', '093'], recents: ['093'] }), '1011');
  assert.equal(pick({ recents: ['093', '1011'] }), '093');
  assert.equal(pick({}), null);
});

test('start stop: a fix that says nothing useful falls through to the favourite', () => {
  const far = { lat: 38.2466 + (START_NEAR_M + 3000) / 111000, lng: 21.9, accuracy: 20 }; // in no stop's reach
  assert.equal(pick({ fix: far, favorites: ['1011'] }), '1011');
  assert.equal(pick({ fix: { ...nearA, accuracy: 5000 }, favorites: ['1011'] }), '1011', 'too coarse');
  assert.equal(pick({ fix: { lat: 40.64, lng: 22.94, accuracy: 10 }, favorites: ['1011'] }), '1011', 'outside the city');
});

test('start stop: a saved code the data no longer has is skipped', () => {
  assert.equal(pick({ favorites: ['9999'], recents: ['093'] }), '093');
  assert.equal(pick({ favorites: ['93'] }), null, '93 is not 093');
});
