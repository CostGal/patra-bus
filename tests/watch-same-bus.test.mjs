import test from 'node:test';
import assert from 'node:assert/strict';
import { findPairs, commentFor, selectNew, MAX_MATCH_COMMENTS } from '../scripts/watch-same-bus.mjs';
import { normalizeLive } from '../web/js/arrivals.js';

const raw = (lineCode, mins, secs, vehicleCode, live) => ({
  lineCode, routeCode: lineCode + '1', lineName: 'L' + lineCode, routeName: 'R',
  latitude: live ? '38.27' : '0', longitude: live ? '21.74' : '0',
  departureMins: mins, departureSeconds: secs, vehicleCode,
});

test('findPairs: same vehicleCode is rule A', () => {
  const p = findPairs([raw('201', 5, 0, 'D_2011_0_10_00', true), raw('201', 5, 30, 'D_2011_0_10_00', false)]);
  assert.equal(p.length, 1);
  assert.equal(p[0].rule, 'A');
});

test('findPairs: same line within 60 s but different codes is rule B', () => {
  const p = findPairs([raw('201', 5, 0, 'D_2011_0_10_00', true), raw('201', 5, 50, 'D_2011_0_10_30', false)]);
  assert.equal(p.length, 1);
  assert.equal(p[0].rule, 'B');
});

test('findPairs: other line, ETA outside the window, or a lone row is not a pair', () => {
  assert.deepEqual(findPairs([raw('201', 5, 0, 'a', true), raw('606', 5, 0, 'b', false)]), []);
  assert.deepEqual(findPairs([raw('201', 5, 0, 'a', true), raw('201', 6, 1, 'b', false)]), []);
  assert.deepEqual(findPairs([raw('201', 5, 0, 'a', false)]), []);
  assert.deepEqual(findPairs(null), []);
});

test('findPairs: each live row absorbs at most one scheduled row', () => {
  const p = findPairs([raw('201', 5, 0, 'a', true), raw('201', 5, 10, 'b', false), raw('201', 5, 20, 'c', false)]);
  assert.equal(p.length, 1);
});

// The watcher keeps its own copy of the pairing rules; this ties it to dropScheduledDuplicates.
test('findPairs finds exactly the scheduled rows that normalizeLive drops', () => {
  const cases = [
    [raw('201', 5, 0, 'a', true), raw('201', 5, 30, 'a', false)],
    [raw('201', 5, 0, 'a', true), raw('201', 5, 50, 'b', false), raw('606', 3, 0, 'c', true), raw('606', 9, 0, 'd', false)],
    [raw('201', 5, 0, 'a', true), raw('201', 5, 10, null, false), raw('201', 5, 20, 'a', false)],
    [raw('201', 5, 0, 'a', true), raw('201', 5, 30, 'b', true), raw('201', 5, 40, 'c', false), raw('201', 5, 45, 'd', false)],
  ];
  for (const c of cases) {
    const dropped = c.length - normalizeLive({ vehicles: c }, 0).vehicles.length;
    assert.equal(findPairs(c).length, dropped);
  }
});

test('commentFor: marker line, no coordinates, mismatch carries both codes', () => {
  const pair = findPairs([raw('201', 5, 0, 'D_2011_0_10_00', true), raw('201', 5, 50, 'D_2011_0_10_30', false)])[0];
  const text = commentFor('mismatch', { city: 'patra', stop: '280', at: '2026-10-19T09:00:00Z', pair });
  assert.match(text, /^<!-- same-bus:mismatch:D_2011_0_10_00\|D_2011_0_10_30 -->/);
  assert.match(text, /D_2011_0_10_30/);
  assert.doesNotMatch(text, /38\.27|21\.74/);
});

test('selectNew: skips pairs already on the issue and caps match evidence', () => {
  const mk = (kind, a, b) => ({ kind, city: 'patra', stop: '280', at: 'now', pair: { live: { vehicleCode: a }, scheduled: { vehicleCode: b } } });
  const bodies = ['<!-- same-bus:mismatch:x|y -->\nold'];
  assert.deepEqual(selectNew([mk('mismatch', 'x', 'y'), mk('mismatch', 'x', 'z')], bodies).map((f) => f.pair.scheduled.vehicleCode), ['z']);
  const many = Array.from({ length: MAX_MATCH_COMMENTS + 3 }, (_, i) => mk('match', 'm' + i, 'm' + i));
  assert.equal(selectNew(many, []).length, MAX_MATCH_COMMENTS);
  assert.equal(selectNew(many, ['<!-- same-bus:match:q|q -->']).length, MAX_MATCH_COMMENTS - 1);
});
