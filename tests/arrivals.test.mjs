import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { isLive, normalizeLive, noServiceResult, etaText, etaSpoken, ageText } from '../web/js/arrivals.js';
import { demoLive, demoRoutes, _setDemoData } from '../web/js/demo.js';

const readJSON = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const fixture = readJSON('../web/fixtures/live-1011.json');
const T = Date.UTC(2026, 9, 9, 19, 24, 33); // 22:24:33 Athens (UTC+3)

const raw = (over = {}) => ({
  lineCode: '201', lineName: 'X', routeCode: '2015', routeName: 'Y', latitude: '0', longitude: '0',
  departureMins: 5, departureSeconds: 0, vehicleCode: 'V1', lineColor: '#ff5722', lineTextColor: '#fff', borderColor: '#f00', ...over,
});

// ---------- normalizeLive ----------

test('real fixture: one live (with position), one scheduled (without)', () => {
  const r = normalizeLive(fixture, T);
  assert.equal(r.fetchedAt, T);
  assert.equal(r.vehicles.length, 2);
  const [live, sched] = r.vehicles;
  assert.equal(live.live, true);
  assert.equal(live.lineCode, '609');
  assert.equal(live.lat, 38.269696);
  assert.equal(live.lng, 21.758322);
  assert.equal(live.etaSec, 74); // 1′14″: secs is the remainder
  assert.equal(live.departureMins, 1);
  assert.equal(live.vehicleCode, '20261009_6091_0000100_22_10');
  assert.equal(sched.live, false);
  assert.equal(sched.lineCode, '201');
  assert.equal(sched.etaSec, 1260);
  assert.equal(sched.vehicleCode, '20261009_2015_0000100_22_40');
  assert.ok(!('lat' in sched) && !('lng' in sched), 'scheduled vehicles carry no coordinates');
});

test('0/0 in any form is scheduled and coordinates are stripped', () => {
  for (const [latitude, longitude] of [['0', '0'], [0, 0], ['0.0', '0.000000'], [null, null], [undefined, undefined], ['', '']]) {
    const [v] = normalizeLive({ vehicles: [raw({ latitude, longitude })] }, T).vehicles;
    assert.equal(v.live, false, JSON.stringify([latitude, longitude]));
    assert.ok(!('lat' in v) && !('lng' in v));
  }
});

test('unparseable or out-of-range coordinates are not live', () => {
  for (const [latitude, longitude] of [['abc', '21.7'], ['38.2', 'x'], ['95', '21.7'], ['38.2', '200'], ['NaN', 'NaN']]) {
    assert.equal(isLive({ latitude, longitude }), false, JSON.stringify([latitude, longitude]));
  }
});

test('string coordinates become numbers; a single zero axis is still live', () => {
  const [a] = normalizeLive({ vehicles: [raw({ latitude: '38.25', longitude: '21.73' })] }, T).vehicles;
  assert.deepEqual([a.live, a.lat, a.lng], [true, 38.25, 21.73]);
  assert.equal(isLive({ latitude: '38.2', longitude: '0' }), true);
});

test('departureSeconds is a 0-59 remainder, also on scheduled departures', () => {
  const [b, a] = normalizeLive({ vehicles: [raw({ departureMins: 21, departureSeconds: 33 }), raw({ latitude: '38.2', longitude: '21.7', departureMins: 0, departureSeconds: 40 })] }, T).vehicles;
  assert.equal(b.etaSec, 40);
  assert.equal(b.live, true);
  assert.equal(a.etaSec, 21 * 60 + 33);
  assert.equal(a.live, false);
  assert.equal(a.departureMins, 21);
  // scheduled clock time = fetchedAt + etaSec, stable between fetches
  const first = T + a.etaSec * 1000;
  const [a2] = normalizeLive({ vehicles: [raw({ departureMins: 21, departureSeconds: 23 })] }, T + 10000).vehicles;
  assert.equal(T + 10000 + a2.etaSec * 1000, first);
});

test('vehicleCode: string or null', () => {
  const v = (vehicleCode) => normalizeLive({ vehicles: [raw({ vehicleCode })] }, T).vehicles[0].vehicleCode;
  assert.equal(v('20261009_2015_0000100_22_40'), '20261009_2015_0000100_22_40');
  assert.equal(v(12345), '12345');
  assert.equal(v(null), null);
  assert.equal(v(undefined), null);
  assert.equal(v(''), null);
  assert.equal(v('   '), null);
  const { vehicleCode: _, ...noCode } = raw();
  assert.equal(normalizeLive({ vehicles: [noCode] }, T).vehicles[0].vehicleCode, null);
});

test('codes become strings; colours pass through, missing colour is null', () => {
  const [v] = normalizeLive({ vehicles: [raw({ lineCode: 201, routeCode: 2015, lineColor: undefined, lineTextColor: '' })] }, T).vehicles;
  assert.equal(v.lineCode, '201');
  assert.equal(v.routeCode, '2015');
  assert.equal(v.color, null);
  assert.equal(v.textColor, null);
});

test('sorted by ETA; garbage input yields an empty list', () => {
  const r = normalizeLive({ vehicles: [raw({ departureMins: 9 }), raw({ departureMins: 2 }), raw({ departureMins: 5 })] }, T);
  assert.deepEqual(r.vehicles.map((v) => v.departureMins), [2, 5, 9]);
  for (const bad of [null, undefined, {}, { vehicles: 'x' }, []]) assert.deepEqual(normalizeLive(bad, T), { fetchedAt: T, vehicles: [] });
});

test('noServiceResult shape', () => {
  assert.deepEqual(noServiceResult(5), { fetchedAt: 5, vehicles: [], noService: true });
});

// ---------- formatters ----------

test('etaText', () => {
  assert.equal(etaText(0), 'τώρα');
  assert.equal(etaText(14.9), 'τώρα');
  assert.equal(etaText(15), '<1′');
  assert.equal(etaText(59.9), '<1′');
  assert.equal(etaText(60), '1′');
  assert.equal(etaText(7 * 60 + 59), '7′');
  assert.equal(etaText(59 * 60 + 59), '59′');
  assert.equal(etaText(3600), '1 ώ 00′');
  assert.equal(etaText(65 * 60), '1 ώ 05′');
  assert.equal(etaText(125 * 60), '2 ώ 05′');
  assert.equal(etaText(NaN), 'τώρα');
});

test('etaSpoken / ageText', () => {
  assert.equal(etaSpoken(3), 'τώρα');
  assert.equal(etaSpoken(40), 'λιγότερο από ένα λεπτό');
  assert.equal(etaSpoken(60), '1 λεπτό');
  assert.equal(etaSpoken(7 * 60), '7 λεπτά');
  assert.equal(etaSpoken(65 * 60), '1 ώρα και 5 λεπτά');
  assert.equal(etaSpoken(120 * 60), '2 ώρες');
  assert.equal(ageText(8.7), '8″');
  assert.equal(ageText(119), '119″');
  assert.equal(ageText(125), '2′');
  assert.equal(ageText(-3), '0″');
});

// ---------- demo ----------

// A tiny hand-made network: R1 runs S1→S5 (60 s legs), R2 runs S5→S3 on the way back.
const mini = {
  stops: ['S1', 'S2', 'S3', 'S4', 'S5'].map((c, i) => ({ code: c, name: c, latitude: 38.2 + i * 0.002, longitude: 21.7 + i * 0.001, lineCodes: ['9'], routeCodes: i < 3 ? ['R1', 'R2'] : ['R1'] })),
  lines: [{ code: '9', name: 'Line nine', color: '#123456', textColor: '#ffffff', borderColor: '#000000', routes: [{ code: 'R1', name: 'ΑΠΟ-ΠΡΟΣ', direction: 1 }, { code: 'R2', name: 'ΠΙΣΩ', direction: 2 }] }],
  routes: { routes: {
    R1: { code: 'R1', lineCode: '9', name: 'ΑΠΟ-ΠΡΟΣ', direction: 1, stops: ['S1', 'S2', 'S3', 'S4', 'S5'], legSec: [60, 90, 120, 60] },
    R2: { code: 'R2', lineCode: '9', name: 'ΠΙΣΩ', direction: 2, stops: ['S3', 'S2', 'S1'], legSec: [100, 100] },
  } },
};

// For every vehicle seen at an earlier stop of its route, check it at a later one.
function checkRoute(route, now) {
  const stops = route.pts.map((p) => p.code);
  const at = stops.map((c) => demoLive(c, now));
  let matches = 0;
  for (let i = 0; i < stops.length; i++) {
    for (let j = i + 1; j < stops.length; j++) {
      const byCode = new Map(at[j].vehicles.filter((v) => v.routeCode === route.code).map((v) => [v.vehicleCode, v]));
      for (const a of at[i].vehicles.filter((v) => v.routeCode === route.code)) {
        const b = byCode.get(a.vehicleCode);
        if (!b) continue;
        matches++;
        const want = route.off[j] - route.off[i];
        assert.ok(Math.abs(b.etaSec - a.etaSec - want) <= 1, `${route.code} ${stops[i]}->${stops[j]}: ${b.etaSec} - ${a.etaSec} vs ${want}`);
        assert.ok(b.etaSec > a.etaSec);
      }
    }
  }
  return matches;
}

test('demo: unknown stop and not-ready model', () => {
  _setDemoData(null);
  assert.equal(demoLive('S1', T), null);
  _setDemoData(mini);
  assert.deepEqual(demoLive('nope', T), { fetchedAt: T, vehicles: [], noService: true });
});

test('demo: same vehicle passes stops in route order with increasing ETAs', () => {
  _setDemoData(mini);
  const routes = demoRoutes();
  assert.equal(routes.length, 2);
  for (let k = 0; k < 40; k++) {
    const now = T + k * 97000; // varying phases
    for (const r of routes) checkRoute(r, now);
  }
  let total = 0;
  for (const r of routes) total += checkRoute(r, T);
  assert.ok(total > 0, 'at least one vehicle is visible at two stops');
});

test('demo: shape, live/scheduled rules, determinism', () => {
  _setDemoData(mini);
  const a = demoLive('S2', T);
  assert.deepEqual(demoLive('S2', T), a, 'same clock, same answer');
  assert.equal(a.fetchedAt, T);
  assert.ok(a.vehicles.length > 0);
  const sorted = [...a.vehicles].sort((x, y) => x.etaSec - y.etaSec);
  assert.deepEqual(a.vehicles, sorted);
  for (const v of a.vehicles) {
    assert.match(v.vehicleCode, /^\d{8}_R[12]_0000100_\d\d_\d\d$/);
    assert.equal(v.color, '#123456');
    assert.ok(Number.isInteger(v.etaSec) && v.etaSec >= 0);
    assert.equal(v.departureMins, Math.floor(v.etaSec / 60));
    if (v.live) {
      assert.ok(v.etaSec <= 20 * 60);
      assert.ok(Number.isFinite(v.lat) && Number.isFinite(v.lng));
      assert.ok(!(v.lat === 0 && v.lng === 0));
      assert.ok(v.lat >= 38.2 && v.lat <= 38.208 && v.lng >= 21.7 && v.lng <= 21.704, 'between the stops');
    } else {
      assert.ok(!('lat' in v) && !('lng' in v));
    }
  }
});

test('demo: live buses exist, and only within 20 min', () => {
  _setDemoData(mini);
  let live = 0;
  let sched = 0;
  for (let k = 0; k < 200; k++) {
    for (const v of demoLive('S3', T + k * 53000).vehicles) {
      if (v.live) live++;
      else sched++;
    }
  }
  assert.ok(live > 0 && sched > 0, `live ${live}, scheduled ${sched}`);
});

test('demo: time moves ETAs down and live buses along the route', () => {
  _setDemoData(mini);
  let moved = 0;
  for (let k = 0; k < 30; k++) {
    const now = T + k * 61000;
    const a = demoLive('S5', now);
    const b = demoLive('S5', now + 20000);
    for (const v of a.vehicles) {
      const w = b.vehicles.find((x) => x.vehicleCode === v.vehicleCode);
      if (!w) continue;
      assert.ok(Math.abs(v.etaSec - 20 - w.etaSec) <= 1);
      assert.equal(w.live || !v.live, true, 'a bus does not stop being live as it approaches');
      if (v.live && w.live && (v.lat !== w.lat || v.lng !== w.lng)) {
        moved++;
        assert.ok(Math.hypot(w.lat - 38.208, (w.lng - 21.704) * 0.79) < Math.hypot(v.lat - 38.208, (v.lng - 21.704) * 0.79) + 1e-9, 'closer to the stop');
      }
    }
  }
  assert.ok(moved > 0);
});

test('demo: headway 10-25 min, whole minutes apart', () => {
  _setDemoData(mini);
  for (const r of demoRoutes()) {
    assert.ok(r.headwaySec >= 600 && r.headwaySec <= 1500 && r.headwaySec % 60 === 0, `${r.code} ${r.headwaySec}`);
    assert.ok(r.phaseSec >= 0 && r.phaseSec < r.headwaySec);
  }
  const v = demoLive('S1', T).vehicles.filter((x) => x.routeCode === 'R1');
  assert.ok(v.length >= 2);
  assert.equal((v[1].etaSec - v[0].etaSec) % 60, 0);
});

test('demo on the real network (routes.json when present, nearest-neighbour order otherwise)', () => {
  const stops = readJSON('../web/data/stops.json');
  const lines = readJSON('../web/data/lines.json');
  const routes = existsSync(new URL('../web/data/routes.json', import.meta.url)) ? readJSON('../web/data/routes.json') : null;
  _setDemoData({ stops, lines, routes });
  const rs = demoRoutes();
  assert.ok(rs.length > 20, `${rs.length} routes`);
  let matches = 0;
  for (const r of rs) {
    assert.ok(r.pts.length >= 2 && r.off.length === r.pts.length);
    for (let i = 1; i < r.off.length; i++) assert.ok(r.off[i] > r.off[i - 1], `${r.code}: offsets strictly increase`);
    matches += checkRoute(r, T + ((r.code.length * 7 + r.pts.length) % 50) * 41000);
  }
  assert.ok(matches > 0);
  // The test stop from CLAUDE.md: lines 201, 606, 609 all show up with realistic fields.
  const r = demoLive('1011', T);
  assert.ok(r.vehicles.length > 0 && !r.noService);
  const seen = new Set(r.vehicles.map((v) => v.lineCode));
  for (const l of ['201', '606', '609']) assert.ok(seen.has(l), `line ${l} at 1011`);
  for (const v of r.vehicles) assert.ok(v.routeName && v.vehicleCode && v.color);
  _setDemoData(null);
});
