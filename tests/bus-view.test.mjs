import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { busTimeline, locateOnRoute, inText, MAX_SNAP_M } from '../web/js/bus-view.js';
import { routeDurationMin } from '../web/js/lines-view.js';
import { buildIndex } from '../web/js/data.js';

const NOW = 1_800_000_000_000;
const sec = (s) => NOW + s * 1000;
// s0 -60s- s1 -120s- s2 -60s- s3 -180s- s4 -60s- s5
const route = { stops: ['s0', 's1', 's2', 's3', 's4', 's5'], legSec: [60, 120, 60, 180, 60], confidence: 0.9 };
const at = (tl, i) => tl.rows[i].at;
const states = (tl) => tl.rows.map((r) => r.state[0]).join('');

test('anchor ETA is the only measured time; later stops add the typical legs', () => {
  const tl = busTimeline(route, 's3', 300, NOW, null, NOW);
  assert.equal(tl.anchor, 3);
  assert.equal(at(tl, 3), sec(300));
  assert.equal(tl.rows[3].kind, 'anchor');
  assert.equal(at(tl, 4), sec(300 + 180));
  assert.equal(at(tl, 5), sec(300 + 180 + 60));
  assert.deepEqual(tl.rows.map((r) => r.kind), ['estimate', 'estimate', 'estimate', 'anchor', 'estimate', 'estimate']);
  assert.equal(tl.rows[4].etaSec, 480);
  assert.equal(tl.endAt, sec(540));
});

test('stops before the anchor: backwards from the anchor; those already due are passed (time-based)', () => {
  const far = busTimeline(route, 's3', 300, NOW, null, NOW); // 300 s away: nothing passed yet
  assert.equal(states(far), 'uuuuuu');
  assert.equal(far.seg, -1);
  assert.equal(at(far, 2), sec(240));
  assert.equal(at(far, 0), sec(60));

  const near = busTimeline(route, 's3', 100, NOW, null, NOW); // s2 due in 40 s, s1 was due 80 s ago
  assert.equal(states(near), 'ppuuuu');
  assert.equal(near.seg, 1);
  assert.equal(near.next, 2);
  assert.equal(at(near, 2), sec(40));
  assert.equal(near.rows[0].at, null); // no invented times for passed stops
  assert.ok(Math.abs(near.t - 80 / 120) < 1e-9);
});

test('a consistent GPS placement sets passed/upcoming and rescales the legs ahead of the bus', () => {
  const tl = busTimeline(route, 's3', 200, NOW, { seg: 1, t: 0.5 }, NOW); // typical remaining 60 + 60 = 120 s, real 200 s
  assert.equal(tl.usedPosition, true);
  assert.equal(states(tl), 'ppuuuu');
  assert.equal(at(tl, 3), sec(200)); // anchor stays exactly the live ETA
  assert.equal(at(tl, 2), sec((200 / 120) * 60)); // s2 sits proportionally on the way
  assert.ok(at(tl, 2) < at(tl, 3));
});

test('a placement that contradicts the ETA is ignored', () => {
  // GPS says the bus is at the start (typical 240 s to s3) but the ETA says 10 s: wrong snap (loop / hairpin)
  const tl = busTimeline(route, 's3', 10, NOW, { seg: 0, t: 0 }, NOW);
  assert.equal(tl.usedPosition, false);
  assert.equal(states(tl), 'pppuuu');
  // position at or beyond the anchor can't be right while the bus is still due there
  const ahead = busTimeline(route, 's3', 120, NOW, { seg: 3, t: 0.2 }, NOW);
  assert.equal(ahead.usedPosition, false);
  assert.equal(ahead.anchor, 3);
});

test('a slow bus (ETA far larger than typical) keeps its GPS placement but never gets times before now', () => {
  const tl = busTimeline(route, 's3', 900, NOW, { seg: 2, t: 0.1 }, NOW);
  assert.equal(tl.usedPosition, true);
  for (const r of tl.rows) if (r.state === 'upcoming') assert.ok(r.at >= NOW && r.etaSec >= 0);
  assert.ok(at(tl, 3) === sec(900));
});

test('ETA already elapsed: the anchor is "now" and everything before it is passed', () => {
  const tl = busTimeline(route, 's3', 60, NOW - 120000, null, NOW); // fetched 120 s ago with 60 s ETA
  assert.equal(tl.remainingSec, 0);
  assert.equal(states(tl), 'pppuuu');
  assert.equal(tl.rows[3].etaSec, 0);
  assert.equal(inText(tl.rows[3].etaSec), 'τώρα');
});

test('unknown anchor, empty route, missing legs, loops, low confidence', () => {
  assert.equal(busTimeline(route, 'nope', 60, NOW, null, NOW), null);
  assert.equal(busTimeline({ stops: [], legSec: [] }, 's0', 60, NOW, null, NOW), null);
  assert.equal(busTimeline(null, 's0', 60, NOW, null, NOW), null);
  const noLegs = busTimeline({ stops: ['a', 'b', 'c'], legSec: [] }, 'a', 0, NOW, null, NOW);
  assert.equal(at(noLegs, 2), sec(120)); // default 60 s per leg
  const loop = { stops: ['a', 'b', 'c', 'a'], legSec: [60, 60, 60], confidence: 0.2 };
  assert.equal(busTimeline(loop, 'a', 100, NOW, null, NOW).anchor, 3);
  assert.equal(busTimeline(loop, 'a', 100, NOW, null, NOW).lowConfidence, true);
  assert.equal(busTimeline(route, 's3', 100, NOW, null, NOW).lowConfidence, false);
});

test('locateOnRoute: segment, fraction, and rejection of far / invalid points', () => {
  const pts = [{ lat: 38.2, lng: 21.7 }, { lat: 38.2, lng: 21.71 }, { lat: 38.21, lng: 21.71 }];
  const mid = locateOnRoute(pts, { lat: 38.2001, lng: 21.705 }); // ~11 m north of the middle of leg 0
  assert.equal(mid.seg, 0);
  assert.ok(Math.abs(mid.t - 0.5) < 0.01 && mid.meters < 20);
  assert.equal(locateOnRoute(pts, { lat: 38.205, lng: 21.71 }).seg, 1);
  assert.equal(locateOnRoute(pts, { lat: 38.3, lng: 21.9 }), null);
  assert.ok(MAX_SNAP_M > 0);
  assert.equal(locateOnRoute(pts, { lat: NaN, lng: 21.7 }), null);
  assert.equal(locateOnRoute([pts[0]], pts[0]), null);
  assert.equal(locateOnRoute(null, pts[0]), null);
});

test('inText and routeDurationMin', () => {
  assert.equal(inText(0), 'τώρα');
  assert.equal(inText(14), 'τώρα');
  assert.equal(inText(60), 'σε 1′');
  assert.equal(inText(540), 'σε 9′');
  assert.equal(inText(3900), 'σε 1 ώ 05′');
  assert.equal(routeDurationMin(route), 8); // 480 s
  assert.equal(routeDurationMin({ legSec: [] }), null);
  assert.equal(routeDurationMin(null), null);
  assert.equal(routeDurationMin({ legSec: [20] }), 1);
});

test('real routes.json: every anchor on every route gives a well-formed, monotonic timeline', () => {
  const read = (f) => JSON.parse(readFileSync(new URL(`../web/data/${f}`, import.meta.url), 'utf8'));
  const data = buildIndex(read('stops.json'), read('lines.json'), read('routes.json'));
  assert.ok(data.routes.length > 50);
  for (const r of data.routes) {
    for (const ai of [0, Math.floor(r.stops.length / 2), r.stops.length - 1]) {
      for (const eta of [0, 90, 600]) {
        const tl = busTimeline(r, r.stops[ai], eta, NOW, null, NOW);
        assert.ok(tl, `${r.code} anchor ${ai}`);
        assert.equal(tl.rows.length, r.stops.length);
        const up = tl.rows.filter((x) => x.state === 'upcoming');
        for (let i = 1; i < up.length; i++) assert.ok(up[i].at >= up[i - 1].at, `${r.code} monotonic`);
        assert.ok(tl.rows.every((x) => (x.state === 'passed') === (x.at === null)));
        assert.equal(tl.rows.filter((x) => x.kind === 'anchor').length, 1);
        assert.ok(tl.rows.slice(0, tl.seg + 1).every((x) => x.state === 'passed') && tl.rows.slice(tl.seg + 1).every((x) => x.state === 'upcoming'));
      }
    }
  }
});
