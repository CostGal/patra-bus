// TEL-401: the data scripts never write broken files. Small fake data only: no citybus.gr, no OSRM, no web/data writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeFiles, codeRanks, kendallTau } from '../scripts/build-routes.mjs';
import { checkStatic, decideWrite, LIMITS } from '../scripts/fetch-static.mjs';

// ---------------------------------------------------------------- build-routes: --only --write merges
const route = (code, extra = {}) => ({ code, lineCode: '6', name: `R ${code}`, direction: 1, stops: ['1', '2'], legSec: [60], confidence: 0.9, method: 'osrm-trip', shape: [[21.7, 38.2], [21.8, 38.3]], ...extra });

test('routeFiles: a full rebuild holds exactly the results', () => {
  const { routesJson, shapes } = routeFiles([route('0601'), route('0602', { shape: [] })], 'T');
  assert.equal(routesJson.version, 1);
  assert.equal(routesJson.generatedAt, 'T');
  assert.deepEqual(Object.keys(routesJson.routes), ['0601', '0602']);
  assert.equal(routesJson.routes['0601'].shape, undefined, 'shape is not copied into routes.json');
  assert.deepEqual(Object.keys(shapes), ['0601']);
});

test('routeFiles: --only replaces the selected routes and keeps all others', () => {
  const prev = {
    routes: { version: 1, generatedAt: 'OLD', routes: {
      '0601': { code: '0601', stops: ['9'], confidence: 0.1 },
      '0602': { code: '0602', stops: ['7', '8'], confidence: 0.5 },
      '093': { code: '093', stops: ['5'], confidence: 0.8 },
    } },
    shapes: { '0601': [[1, 1]], '0602': [[2, 2]], '093': [[3, 3]] },
  };
  const before = JSON.stringify(prev);
  const { routesJson, shapes } = routeFiles([route('0601'), route('0602', { shape: [] })], 'NEW', prev);
  assert.equal(routesJson.generatedAt, 'NEW');
  assert.deepEqual(Object.keys(routesJson.routes).sort(), ['0601', '0602', '093']);
  assert.deepEqual(routesJson.routes['0601'].stops, ['1', '2'], 'selected route replaced');
  assert.equal(routesJson.routes['0601'].confidence, 0.9);
  assert.deepEqual(routesJson.routes['093'], prev.routes.routes['093'], 'other route kept as is');
  assert.deepEqual(shapes['0601'], [[21.7, 38.2], [21.8, 38.3]], 'selected shape replaced');
  assert.equal('0602' in shapes, false, 'a selected route without a shape drops the old one');
  assert.deepEqual(shapes['093'], [[3, 3]], 'other shape kept');
  assert.equal(JSON.stringify(prev), before, 'the previous files are not mutated');
});

// ---------------------------------------------------------------- build-routes: codes compared as strings
test('codeRanks: string order, leading zeros matter', () => {
  const pts = [{ code: '2' }, { code: '15' }, { code: '0015' }, { code: '15' }];
  // string order: '0015' < '15' < '2' (as numbers 0015 and 15 would tie and 2 would come first)
  assert.deepEqual(codeRanks(pts), [2, 1, 0, 1]);
  assert.equal(kendallTau(codeRanks([{ code: '0015' }, { code: '15' }]), [0, 1]), 1, 'no tie between 0015 and 15');
});

// ---------------------------------------------------------------- fetch-static: checks before writing
const stop = (code, extra = {}) => ({ id: 1, code, name: 'S', latitude: 38.2, longitude: 21.7, lineCodes: ['6'], routeCodes: ['0601'], ...extra });
const line = (code, extra = {}) => ({ id: 1, code, name: 'L', routes: [{ id: 1, code: `${code}01`, name: 'R', direction: 1 }], ...extra });
const stops = (n) => Array.from({ length: n }, (_, i) => stop(String(i + 1).padStart(3, '0')));
const lines = (n) => Array.from({ length: n }, (_, i) => line(String(i + 1)));

test('checkStatic: good data passes, with or without current files', () => {
  assert.deepEqual(checkStatic(stops(60), lines(6)), []);
  assert.deepEqual(checkStatic(stops(60), lines(6), { stops: stops(70), lines: lines(7) }), []);
});

test('checkStatic: minimum counts', () => {
  assert.equal(LIMITS.minStops, 50);
  assert.equal(LIMITS.minLines, 5);
  const p = checkStatic(stops(49), lines(4));
  assert.equal(p.length, 2);
  assert.match(p[0], /stops: 49 < minimum 50/);
  assert.match(p[1], /lines: 4 < minimum 5/);
  assert.match(checkStatic([], lines(6))[0], /stops: 0/);
  assert.deepEqual(checkStatic(null, lines(6)), ['stops: not a list']);
});

test('checkStatic: a sharp drop against the current file is refused', () => {
  assert.deepEqual(checkStatic(stops(80), lines(8), { stops: stops(100), lines: lines(10) }), [], '80% passes');
  const p = checkStatic(stops(79), lines(7), { stops: stops(100), lines: lines(10) });
  assert.equal(p.length, 2);
  assert.match(p[0], /stops: 79, was 100/);
  assert.match(p[1], /lines: 7, was 10/);
});

test('checkStatic: every code is a string', () => {
  const s = stops(60);
  s[0] = stop(93);
  s[1] = stop('094', { routeCodes: [601] });
  const l = lines(6);
  l[0] = line(6);
  l[1].routes[0].code = 201;
  const p = checkStatic(s, l);
  assert.equal(p.length, 1);
  for (const part of ['stop 93', 'stop 094 routeCodes', 'line 6', 'route 201']) assert.ok(p[0].includes(part), part);
});

test('checkStatic: no 0/0 or missing coordinates, codes listed', () => {
  const s = stops(60);
  s[3] = stop('0042', { latitude: 0, longitude: 0 });
  s[4] = stop('0043', { latitude: null });
  s[5] = stop('0044', { latitude: 0, longitude: 21.7 }); // only both 0 means "scheduled"
  const p = checkStatic(s, lines(6));
  assert.equal(p.length, 1);
  assert.match(p[0], /0\/0 or missing coordinates: 0042, 0043$/);
});

test('decideWrite: refuses without --force and names it; --force writes with warnings', () => {
  assert.deepEqual(decideWrite([]), { write: true, warnings: [], error: null });
  const refused = decideWrite(['stops: 10 < minimum 50']);
  assert.equal(refused.write, false);
  assert.match(refused.error, /nothing written/);
  assert.match(refused.error, /stops: 10 < minimum 50/);
  assert.match(refused.error, /a person has looked.*--force/);
  const forced = decideWrite(['stops: 10 < minimum 50'], { force: true });
  assert.equal(forced.write, true);
  assert.deepEqual(forced.warnings, ['stops: 10 < minimum 50']);
  assert.equal(forced.error, null);
});
