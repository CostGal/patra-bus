import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildIndex, searchStops, stopsOfRoute, rideSec } from '../web/js/data.js';

const stop = (code, name, lat = 38.24, lng = 21.73, extra = {}) => ({ code, name, latitude: lat, longitude: lng, lineCodes: ['1'], routeCodes: ['r1'], ...extra });
const RAW_STOPS = [
  stop('10', 'ΠΑΝΕΠΙΣΤΗΜΙΟΥ & ΑΡΕΘΑ'),
  stop('11', 'ΑΡΕΘΑ'),
  stop('12', 'ΠΛΑΤΕΙΑ ΑΡΕΘΑ'),
  stop('13', 'ΒΑΣΙΛΕΩΣ ΓΕΩΡΓΙΟΥ'),
  stop('1011', 'ΠΑΝΕΠΙΣΤΗΜΙΟΥ & ΑΡΕΘΑ'),
  stop('101', '10ο ΛΥΚΕΙΟ'),
  stop('14', 'ΜΑΡΟΥΔΑ'),
];
const RAW_LINES = [{ code: '1', name: 'ΕΓΛΥΚΑΔΑ', color: '#111111', textColor: '#ffffff', routes: [{ code: 'r1', name: 'Α-Β', direction: 1 }] }];
const RAW_ROUTES = {
  version: 1, generatedAt: '2026-10-10T00:00:00.000Z',
  routes: { r1: { code: 'r1', lineCode: '1', name: 'ΑΡΕΘΑ-ΜΑΡΟΥΔΑ', direction: 1, stops: ['11', '12', '13', '14'], legSec: [30, 40, 50], confidence: 0.8, method: 'osrm-trip' } },
};

test('buildIndex: types, maps and route positions', () => {
  const d = buildIndex(RAW_STOPS, RAW_LINES, RAW_ROUTES);
  assert.equal(d.stops.length, RAW_STOPS.length);
  const s = d.stopByCode.get('11');
  assert.equal(s.displayName, 'Αρεθα');
  assert.equal(s.key, 'αρεθα');
  assert.deepEqual([s.lat, s.lng], [38.24, 21.73]);
  assert.equal(d.lineByCode.get('1').displayName, 'Εγλυκαδα');
  const r = d.routeByCode.get('r1');
  assert.deepEqual(r.stops, ['11', '12', '13', '14']);
  assert.equal(r.pos.get('13'), 2);
  assert.equal(r.displayName, 'Αρεθα-Μαρουδα');
  assert.equal(r.confidence, 0.8);
  assert.deepEqual(d.routesByStop.get('12').map((x) => x.code), ['r1']);
  assert.equal(d.routesByStop.get('10'), undefined);
  assert.equal(d.meta.routesGeneratedAt, '2026-10-10T00:00:00.000Z');
});

test('buildIndex: works without routes.json', () => {
  for (const missing of [null, undefined, {}, { routes: {} }]) {
    const d = buildIndex(RAW_STOPS, RAW_LINES, missing);
    assert.equal(d.routes.length, 0);
    assert.equal(d.routesByStop.size, 0);
    assert.equal(d.meta.routesGeneratedAt, null);
  }
});

test('buildIndex: unknown stop codes are dropped and their legs merged', () => {
  const raw = { routes: { r1: { code: 'r1', lineCode: '1', name: 'X', direction: 1, stops: ['11', 'zzz', '12', '13'], legSec: [10, 20, 30], confidence: 1, method: 'm' } } };
  const r = buildIndex(RAW_STOPS, RAW_LINES, raw).routeByCode.get('r1');
  assert.deepEqual(r.stops, ['11', '12', '13']);
  assert.deepEqual(r.legSec, [30, 30]);
  assert.equal(r.legSec.length, r.stops.length - 1);
});

test('buildIndex: malformed legSec is rebuilt, routes with < 2 known stops are dropped', () => {
  const raw = { routes: {
    a: { code: 'a', lineCode: '1', name: 'A', direction: 1, stops: ['11', '12', '13'], legSec: [5], confidence: 0.5 },
    b: { code: 'b', lineCode: '1', name: 'B', direction: 1, stops: ['11', 'nope'], legSec: [5], confidence: 0.5 },
  } };
  const d = buildIndex(RAW_STOPS, RAW_LINES, raw);
  assert.equal(d.routeByCode.get('a').legSec.length, 2);
  assert.ok(d.routeByCode.get('a').legSec.every((x) => x > 0));
  assert.equal(d.routeByCode.has('b'), false);
});

test('stopsOfRoute and rideSec', () => {
  const d = buildIndex(RAW_STOPS, RAW_LINES, RAW_ROUTES);
  assert.deepEqual(stopsOfRoute(d, 'r1').map((s) => s.code), ['11', '12', '13', '14']);
  assert.deepEqual(stopsOfRoute(d, 'nope'), []);
  const r = d.routeByCode.get('r1');
  assert.equal(rideSec(r, '11', '14'), 120);
  assert.equal(rideSec(r, '12', '13'), 40);
  assert.equal(rideSec(r, '12', '12'), 0);
  assert.equal(rideSec(r, '14', '11'), null);
  assert.equal(rideSec(r, '11', 'zzz'), null);
});

test('searchStops: exact code first, then name prefix, word prefix, substring', () => {
  const d = buildIndex(RAW_STOPS, RAW_LINES, RAW_ROUTES);
  assert.equal(searchStops(d, '1011')[0].code, '1011');
  // "αρεθα": whole name first (shorter beats longer), then word-prefix hits, nothing else matches
  assert.deepEqual(searchStops(d, 'αρεθα').map((s) => s.code), ['11', '12', '10', '1011']);
  // substring only ("ΟΥΔΑ" inside ΜΑΡΟΥΔΑ) ranks after prefix hits
  const sub = searchStops(d, 'ουδα');
  assert.deepEqual(sub.map((s) => s.code), ['14']);
});

test('searchStops: accent / case / final-sigma insensitive and multi-word', () => {
  const d = buildIndex(RAW_STOPS, RAW_LINES, RAW_ROUTES);
  assert.deepEqual(searchStops(d, 'Πανεπιστήμιου').map((s) => s.code).sort(), ['10', '1011']);
  assert.deepEqual(searchStops(d, 'ΠΑΝΕΠΙΣΤΗΜΙΟΥ ΑΡΕΘΑ').map((s) => s.code).sort(), ['10', '1011']);
  assert.deepEqual(searchStops(d, 'αρεθα πανεπ').map((s) => s.code).sort(), ['10', '1011']); // word order is free
  assert.deepEqual(searchStops(d, 'βασιλεως γεωργ').map((s) => s.code), ['13']);
  assert.deepEqual(searchStops(d, 'γεωργιος'), []); // σ/ς folded, but this is not a prefix of any word
});

test('searchStops: numeric query matches code prefix after exact, limit and empty query', () => {
  const d = buildIndex(RAW_STOPS, RAW_LINES, RAW_ROUTES);
  const r = searchStops(d, '101');
  assert.equal(r[0].code, '101');                    // exact code
  assert.ok(r.some((s) => s.code === '1011'));       // code prefix
  assert.equal(searchStops(d, '', 5).length, 0);
  assert.equal(searchStops(d, '   ', 5).length, 0);
  assert.equal(searchStops(d, 'α', 2).length, 2);
});

test('real data: stop 1011 is found by code and by name, routes.json (if built) is consistent with stops', () => {
  const read = (f) => JSON.parse(readFileSync(new URL(`../web/data/${f}`, import.meta.url), 'utf8'));
  let routes = null;
  try { routes = read('routes.json'); } catch { /* not built yet */ }
  const d = buildIndex(read('stops.json'), read('lines.json'), routes);
  assert.equal(searchStops(d, '1011')[0].name, 'ΠΑΝΕΠΙΣΤΗΜΙΟΥ & ΑΡΕΘΑ');
  assert.ok(searchStops(d, 'πανεπιστημιου αρεθα').some((s) => s.code === '1011'));
  if (!routes) return;
  assert.equal(routes.version, 1);
  for (const r of Object.values(routes.routes)) {
    assert.equal(r.legSec.length, r.stops.length - 1, `legSec length of ${r.code}`);
    assert.ok(r.confidence >= 0 && r.confidence <= 1);
    for (const c of r.stops) assert.ok(d.stopByCode.has(c), `unknown stop ${c} in route ${r.code}`);
    assert.equal(new Set(r.stops).size, r.stops.length, `duplicate stop in ${r.code}`);
  }
  // a route's stop set equals the set implied by stops.json routeCodes
  const byRoute = new Map();
  for (const s of d.stops) for (const rc of s.routeCodes) (byRoute.get(rc) || byRoute.set(rc, new Set()).get(rc)).add(s.code);
  for (const r of d.routes) assert.deepEqual([...r.stops].sort(), [...byRoute.get(r.code)].sort(), `stop set of ${r.code} (routes.json stale? run npm run build-routes)`);
  // stop 1011 is on lines 201, 606, 609 (CLAUDE.md)
  const lines = new Set((d.routesByStop.get('1011') || []).map((r) => r.lineCode));
  for (const l of ['201', '606', '609']) assert.ok(lines.has(l), `line ${l} at 1011`);
});
