import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildIndex } from '../web/js/data.js';
import { stopBearings, stopIconPx } from '../web/js/map-stops.js';

const read = (f) => JSON.parse(readFileSync(new URL(`../web/data/${f}`, import.meta.url), 'utf8'));
const data = buildIndex(read('stops.json'), read('lines.json'), read('routes.json'));
const bearings = stopBearings(data, read('shapes.json'));
const apart = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

test('stop arrows: the opposite stops 1011 and 330 point opposite ways', () => {
  assert.ok(bearings.has('1011') && bearings.has('330'));
  assert.ok(apart(bearings.get('1011'), bearings.get('330')) >= 150);
});

test('stop arrows: most Patras stops get one, every value is a real angle', () => {
  assert.ok(bearings.size / data.stops.length > 0.7, `${bearings.size} of ${data.stops.length}`);
  for (const b of bearings.values()) assert.ok(Number.isInteger(b) && b >= 0 && b < 360);
});

test('stop arrows: no shapes means no arrows, not a crash', () => {
  assert.equal(stopBearings(data, {}).size, 0);
  assert.equal(stopBearings(data, null).size, 0);
});

test('stop icon size grows with zoom', () => {
  for (let z = 11; z < 19; z += 0.5) assert.ok(stopIconPx(z + 0.5) >= stopIconPx(z));
});
