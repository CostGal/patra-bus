import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validCode,
  summarize,
  sightingsByRoute,
  applySightings,
  MAX_SAMPLES,
  PENDING_TTL_MS,
} from '../worker/src/stats.js';

const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const MIN = 60 * 1000;

const veh = (vehicleCode, live, etaSec) => ({ vehicleCode, live, etaSec });
const batch = (fetchedAt, vehicles) => ({ fetchedAt, vehicles });

// Scheduled sighting of A at NOW, scheduled arrival T = NOW + 1200 s.
const withScheduledA = () => applySightings(undefined, batch(NOW, [veh('A', false, 1200)]), NOW).state;

// Happy path: pending A, then a live sighting at eta 250 s recording delay +50 s.
const measuredA = () => {
  const s1 = withScheduledA();
  const s2 = applySightings(s1, batch(NOW + 900000, [veh('A', true, 360)]), NOW + 900000).state;
  return applySightings(s2, batch(NOW + 1000000, [veh('A', true, 250)]), NOW + 1000000).state;
};

test('validCode accepts 1 to 8 digit strings only', () => {
  assert.equal(validCode('1'), true);
  assert.equal(validCode('12345678'), true);
  assert.equal(validCode(''), false);
  assert.equal(validCode('123456789'), false);
  assert.equal(validCode('abc'), false);
  assert.equal(validCode('12a'), false);
  assert.equal(validCode('../1'), false);
  assert.equal(validCode(5), false);
  assert.equal(validCode(null), false);
});

test('summarize: empty or missing state gives null stats', () => {
  const empty = { samples: 0, medianDelaySec: null, p80DelaySec: null, updatedAt: null };
  assert.deepEqual(summarize(undefined), empty);
  assert.deepEqual(summarize({}), empty);
  assert.deepEqual(summarize({ samples: [] }), empty);
});

test('summarize: odd count gives median 60 and nearest-rank p80 90', () => {
  const state = {
    samples: [60, 0, 120, 30, 90].map((d, i) => ({ d, t: NOW + i })),
    updatedAt: NOW,
  };
  assert.deepEqual(summarize(state), {
    samples: 5,
    medianDelaySec: 60,
    p80DelaySec: 90,
    updatedAt: NOW,
  });
});

test('summarize: even count averages the two middle values', () => {
  const state = { samples: [10, 20, 30, 40].map((d) => ({ d, t: NOW })), updatedAt: NOW };
  const s = summarize(state);
  assert.equal(s.samples, 4);
  assert.equal(s.medianDelaySec, 25);
  assert.equal(s.p80DelaySec, 40);
});

test('summarize: negative delays are sorted correctly', () => {
  const state = { samples: [-90, -30, 30].map((d) => ({ d, t: NOW })), updatedAt: NOW };
  const s = summarize(state);
  assert.equal(s.medianDelaySec, -30);
  assert.equal(s.p80DelaySec, 30);
});

test('summarize: single sample is both median and p80', () => {
  const state = { samples: [{ d: 45, t: NOW }], updatedAt: NOW };
  assert.deepEqual(summarize(state), {
    samples: 1,
    medianDelaySec: 45,
    p80DelaySec: 45,
    updatedAt: NOW,
  });
});

test('sightingsByRoute groups by routeCode and skips untrackable vehicles', () => {
  const result = {
    fetchedAt: NOW,
    vehicles: [
      { vehicleCode: 'A', routeCode: '12', live: true, etaSec: 120 },
      { vehicleCode: 'B', routeCode: '12', live: false, etaSec: 600 },
      { vehicleCode: 'C', routeCode: '7', live: false, etaSec: 60 },
      { vehicleCode: null, routeCode: '7', live: true, etaSec: 10 },
      { vehicleCode: 'D', routeCode: 'X1', live: true, etaSec: 10 },
      { vehicleCode: 'E', routeCode: '7', live: true, etaSec: NaN },
      { vehicleCode: 'F', routeCode: '7', live: true, etaSec: Infinity },
      { vehicleCode: 'G', routeCode: '7', live: true, etaSec: '60' },
    ],
  };
  const out = sightingsByRoute(result);
  assert.equal(out.size, 2);
  assert.deepEqual(out.get('12'), [
    { vehicleCode: 'A', live: true, etaSec: 120 },
    { vehicleCode: 'B', live: false, etaSec: 600 },
  ]);
  assert.deepEqual(out.get('7'), [{ vehicleCode: 'C', live: false, etaSec: 60 }]);
  assert.equal(out.has('X1'), false);
});

test('sightingsByRoute returns an empty Map without vehicles', () => {
  assert.equal(sightingsByRoute(null).size, 0);
  assert.equal(sightingsByRoute(undefined).size, 0);
  assert.equal(sightingsByRoute({}).size, 0);
  assert.equal(sightingsByRoute({ vehicles: [] }).size, 0);
});

test('applySightings: scheduled then live near arrival records delay +50 s', () => {
  const s1 = withScheduledA();
  assert.deepEqual(s1.pending, { A: { T: NOW + 1200000, seen: NOW } });

  const r1 = applySightings(undefined, batch(NOW, [veh('A', false, 1200)]), NOW);
  assert.equal(r1.recorded, 0);
  assert.equal(r1.changed, true);

  // Live but eta 360 s > 300 s: nothing recorded, pending kept.
  const r2 = applySightings(s1, batch(NOW + 900000, [veh('A', true, 360)]), NOW + 900000);
  assert.equal(r2.recorded, 0);
  assert.equal(r2.changed, false);
  assert.deepEqual(r2.state.pending, { A: { T: NOW + 1200000, seen: NOW } });
  assert.equal(r2.state.samples.length, 0);

  // Live at eta 250 s: arrival NOW+1250000, scheduled NOW+1200000 => +50 s.
  const r3 = applySightings(r2.state, batch(NOW + 1000000, [veh('A', true, 250)]), NOW + 1000000);
  assert.equal(r3.recorded, 1);
  assert.equal(r3.changed, true);
  assert.deepEqual(r3.state.samples, [{ d: 50, t: NOW + 1000000 }]);
  assert.equal(r3.state.pending.A, undefined);
  assert.equal(r3.state.done.A, NOW + 1200000);
  assert.equal(r3.state.updatedAt, NOW + 1000000);
});

test('applySightings: a measured vehicle is not measured again', () => {
  const s = measuredA();
  assert.equal(s.samples.length, 1);

  // Further live sighting with eta <= 300 s: no pending, nothing recorded.
  const live = applySightings(s, batch(NOW + 1100000, [veh('A', true, 200)]), NOW + 1100000);
  assert.equal(live.recorded, 0);
  assert.equal(live.state.samples.length, 1);

  // Scheduled re-sighting with the same T: ignored, no new pending.
  const same = applySightings(s, batch(NOW + 1100000, [veh('A', false, 100)]), NOW + 1100000);
  assert.deepEqual(same.state.pending, {});

  // Same T within +-60 s: still ignored.
  const near = applySightings(s, batch(NOW + 1100000, [veh('A', false, 160)]), NOW + 1100000);
  assert.deepEqual(near.state.pending, {});

  // Scheduled T about an hour later: a new pending is created.
  const later = applySightings(s, batch(NOW + 1100000, [veh('A', false, 3600)]), NOW + 1100000);
  assert.deepEqual(later.state.pending, { A: { T: NOW + 1100000 + 3600000, seen: NOW + 1100000 } });
});

test('applySightings: live sighting without a prior scheduled sighting records nothing', () => {
  const r = applySightings(undefined, batch(NOW, [veh('A', true, 100)]), NOW);
  assert.equal(r.recorded, 0);
  assert.equal(r.changed, false);
  assert.deepEqual(r.state.samples, []);
});

test('applySightings: delay beyond 45 min removes pending but records no sample', () => {
  const s = applySightings(undefined, batch(NOW, [veh('A', false, 600)]), NOW).state; // T = NOW+600 s
  // Live arrival at NOW+3600 s => delay +3000 s (50 min).
  const r = applySightings(s, batch(NOW + 3500000, [veh('A', true, 100)]), NOW + 3500000);
  assert.equal(r.recorded, 0);
  assert.equal(r.changed, true);
  assert.deepEqual(r.state.samples, []);
  assert.equal(r.state.pending.A, undefined);
  assert.equal(r.state.done.A, NOW + 600000);
});

test('applySightings: early bus records a negative delay', () => {
  const s = applySightings(undefined, batch(NOW, [veh('A', false, 600)]), NOW).state; // T = NOW+600 s
  // Live arrival at NOW+510 s => delay -90 s.
  const r = applySightings(s, batch(NOW + 450000, [veh('A', true, 60)]), NOW + 450000);
  assert.equal(r.recorded, 1);
  assert.equal(r.state.samples.length, 1);
  assert.equal(r.state.samples[0].d, -90);
});

test('applySightings: pending older than the TTL is pruned on the next call', () => {
  const state = {
    samples: [],
    pending: {
      A: { T: NOW + 1200000, seen: NOW - PENDING_TTL_MS - 1000 },
      B: { T: NOW + 1200000, seen: NOW - 2 * 3600 * 1000 },
    },
    done: {},
    updatedAt: null,
  };
  const r = applySightings(state, batch(NOW, []), NOW);
  assert.equal(r.changed, true);
  assert.equal(r.state.pending.A, undefined);
  assert.deepEqual(r.state.pending.B, { T: NOW + 1200000, seen: NOW - 2 * 3600 * 1000 });
});

test('applySightings: fresh pending with no vehicles is kept and nothing changes', () => {
  const state = { samples: [], pending: { B: { T: NOW + 1200000, seen: NOW - 2 * 3600 * 1000 } }, done: {}, updatedAt: null };
  const r = applySightings(state, batch(NOW, []), NOW);
  assert.equal(r.changed, false);
  assert.ok(r.state.pending.B);
});

test('applySightings: stale pending (T older than fetchedAt - 20 min) is replaced', () => {
  const state = { samples: [], pending: { A: { T: NOW, seen: NOW } }, done: {}, updatedAt: null };
  const fetchedAt = NOW + 25 * MIN;
  const r = applySightings(state, batch(fetchedAt, [veh('A', false, 900)]), fetchedAt);
  assert.equal(r.changed, true);
  assert.deepEqual(r.state.pending.A, { T: fetchedAt + 900000, seen: fetchedAt });
});

test('applySightings: keeps only the last MAX_SAMPLES samples', () => {
  const N = 250;
  // Vehicle i is scheduled at NOW + (1000 + i) s.
  const scheduled = Array.from({ length: N }, (_, i) => veh(`V${i}`, false, 1000 + i));
  const s1 = applySightings(undefined, batch(NOW, scheduled), NOW).state;
  assert.equal(Object.keys(s1.pending).length, N);

  // Live at NOW+1000 s for all, eta 100 s: delay for vehicle i is -i seconds.
  const live = Array.from({ length: N }, (_, i) => veh(`V${i}`, true, 100));
  const r = applySightings(s1, batch(NOW + 900000, live), NOW + 900000);
  assert.equal(r.recorded, N);
  assert.equal(r.state.samples.length, MAX_SAMPLES);
  assert.equal(MAX_SAMPLES, 200);
  // Oldest 50 dropped: first kept is vehicle 50 (d -50), last is vehicle 249 (d -249).
  assert.equal(r.state.samples[0].d, -(N - MAX_SAMPLES));
  assert.equal(r.state.samples[MAX_SAMPLES - 1].d, -(N - 1));
});

test('applySightings does not mutate its input (live recording path)', () => {
  const s0 = withScheduledA();
  const before = JSON.stringify(s0);
  const r = applySightings(s0, batch(NOW + 1000000, [veh('A', true, 250)]), NOW + 1000000);
  assert.equal(r.recorded, 1);
  assert.equal(JSON.stringify(s0), before);
});

test('applySightings does not mutate its input (re-seen path)', () => {
  const s0 = withScheduledA(); // pending A seen at NOW
  const before = JSON.stringify(s0);
  // Same T re-sighted 11 min later refreshes "seen" (RESEEN_MS = 10 min).
  const r = applySightings(s0, batch(NOW + 600000, [veh('A', false, 600)]), NOW + 660000);
  assert.equal(r.state.pending.A.seen, NOW + 660000);
  assert.equal(JSON.stringify(s0), before);
});
