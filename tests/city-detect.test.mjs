// Automatic city detection from a position (TEL-142): which city box a point is in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CITIES } from '../web/js/cities.js';
import { cityAt } from '../web/js/city-detect.js';

test('a point in Patras is Patras, a point in Corfu is Corfu', () => {
  assert.equal(cityAt({ lat: CITIES.patra.center.lat, lng: CITIES.patra.center.lng }), 'patra');
  assert.equal(cityAt({ lat: CITIES.corfu.center.lat, lng: CITIES.corfu.center.lng }), 'corfu');
});

test('a point outside both boxes (Athens) is null', () => {
  assert.equal(cityAt({ lat: 37.98, lng: 23.73 }), null);
});

test('the box edges count as inside', () => {
  const b = CITIES.corfu.bbox;
  assert.equal(cityAt({ lat: b.south, lng: b.west }), 'corfu');
  assert.equal(cityAt({ lat: b.north, lng: b.east }), 'corfu');
});

test('just outside the edge is null', () => {
  const b = CITIES.patra.bbox;
  assert.equal(cityAt({ lat: 38.2, lng: b.east + 0.001 }), null);
  assert.equal(cityAt({ lat: b.north + 0.001, lng: 21.7 }), null);
});

test('missing or non-numeric positions are null', () => {
  assert.equal(cityAt(null), null);
  assert.equal(cityAt(undefined), null);
  assert.equal(cityAt({ lat: NaN, lng: 21.7 }), null);
  assert.equal(cityAt({ lat: '38.2', lng: '21.7' }), null);
});

test('the two boxes do not overlap', () => {
  for (const [id, c] of Object.entries(CITIES)) {
    for (const [other, o] of Object.entries(CITIES)) {
      if (id === other) continue;
      const overlap = c.bbox.west <= o.bbox.east && o.bbox.west <= c.bbox.east
        && c.bbox.south <= o.bbox.north && o.bbox.south <= c.bbox.north;
      assert.equal(overlap, false, `${id} and ${other} overlap`);
    }
  }
});

test('a custom table of cities can be passed in', () => {
  const fake = { x: { id: 'x', bbox: { west: 0, south: 0, east: 1, north: 1 } } };
  assert.equal(cityAt({ lat: 0.5, lng: 0.5 }, fake), 'x');
  assert.equal(cityAt({ lat: 0.5, lng: 0.5 }), null);
});
