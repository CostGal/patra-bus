import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CITIES, setActiveCity, dataDir, DEFAULT_CITY } from '../web/js/cities.js';
import * as B from '../scripts/build-routes.mjs';

const read = async (f) => JSON.parse(await readFile(new URL(`../web/data/corfu/${f}`, import.meta.url), 'utf8'));
const [stops, lines, routesDoc, shapes] = await Promise.all(['stops.json', 'lines.json', 'routes.json', 'shapes.json'].map(read));
const bbox = CITIES.corfu.bbox;
const stopByCode = new Map(stops.map((s) => [s.code, s]));
const routes = Object.values(routesDoc.routes);

// ---------------------------------------------------------------- files
test('corfu stops: numeric coordinates inside the city bbox, unique codes, no 0/0', () => {
  assert.ok(stops.length > 400);
  assert.equal(stopByCode.size, stops.length);
  for (const s of stops) {
    assert.equal(typeof s.code, 'string');
    assert.equal(typeof s.latitude, 'number');
    assert.equal(typeof s.longitude, 'number');
    assert.ok(!(s.latitude === 0 && s.longitude === 0), `${s.code} is 0/0`);
    assert.ok(s.latitude >= bbox.south && s.latitude <= bbox.north, `${s.code} lat ${s.latitude}`);
    assert.ok(s.longitude >= bbox.west && s.longitude <= bbox.east, `${s.code} lng ${s.longitude}`);
    assert.ok(Array.isArray(s.routeCodes));
  }
});

test('corfu lines: routes of the lines are the routeCodes of the stops; line 16 has no routes', () => {
  assert.equal(lines.length, 13);
  assert.deepEqual(lines.find((l) => l.code === '16').routes, []);
  const fromLines = new Set(lines.flatMap((l) => l.routes.map((r) => String(r.code))));
  const fromStops = new Set(stops.flatMap((s) => s.routeCodes.map(String)));
  for (const c of fromStops) assert.ok(fromLines.has(c), `stop route ${c} not in lines`);
});

test('corfu routes.json: every route is well formed and refers to existing stops', () => {
  assert.equal(routesDoc.version, 1);
  const lineRoutes = new Set(lines.flatMap((l) => l.routes.map((r) => String(r.code))));
  assert.equal(routes.length, lineRoutes.size);
  for (const r of routes) {
    assert.ok(lineRoutes.has(r.code), `route ${r.code} not in lines`);
    assert.equal(routesDoc.routes[r.code], r);
    assert.ok(r.stops.length >= 1);
    assert.equal(new Set(r.stops).size, r.stops.length, `${r.code} repeats a stop`);
    for (const c of r.stops) assert.ok(stopByCode.has(c), `${r.code}: unknown stop ${c}`);
    assert.equal(r.legSec.length, Math.max(0, r.stops.length - 1), `${r.code} legSec length`);
    for (const t of r.legSec) assert.ok(Number.isFinite(t) && t >= B.K.MIN_LEG_SEC, `${r.code} leg ${t}`);
    assert.ok(r.confidence >= 0 && r.confidence <= 1, `${r.code} confidence ${r.confidence}`);
    assert.equal(typeof r.method, 'string');
  }
});

test('corfu routes.json: a route holds exactly the stops that list it in routeCodes', () => {
  for (const r of routes) {
    const expected = stops.filter((s) => s.routeCodes.map(String).includes(r.code)).map((s) => s.code).sort();
    assert.deepEqual(r.stops.slice().sort(), expected, `route ${r.code}`);
  }
});

test('corfu shapes.json: keyed by route code, [lng, lat] pairs inside the bbox', () => {
  for (const [code, shape] of Object.entries(shapes)) {
    assert.ok(routesDoc.routes[code], `shape for unknown route ${code}`);
    assert.ok(shape.length >= 2, `${code} shape too short`);
    for (const [lng, lat] of shape) {
      assert.ok(lng >= bbox.west - 0.05 && lng <= bbox.east + 0.05, `${code} lng ${lng}`);
      assert.ok(lat >= bbox.south - 0.05 && lat <= bbox.north + 0.05, `${code} lat ${lat}`);
    }
  }
  for (const r of routes) if (r.stops.length >= 2) assert.ok(shapes[r.code], `route ${r.code} has no shape`);
});

test('corfu routes: first stop of a ΣΑΡΟΚΟ-first route is nearer the centre than its last stop', () => {
  const dist = (c) => B.haversine(stopByCode.get(c) && { lat: stopByCode.get(c).latitude, lng: stopByCode.get(c).longitude }, CITIES.corfu.center);
  const checked = routes.filter((r) => /^ΣΑΡΟΚΟ|^ΜΕΘΟΔΙΟΥ/.test(r.name) && r.stops.length > 5);
  assert.ok(checked.length > 10);
  const ok = checked.filter((r) => dist(r.stops[0]) < dist(r.stops[r.stops.length - 1]));
  // Inferred order: not every route can be right (see confidence), but the vast majority must start in town.
  assert.ok(ok.length / checked.length >= 0.8, `${ok.length}/${checked.length} start at the centre`);
});

// ---------------------------------------------------------------- per-city centre words
test('centerWords: Patras keeps ΚΕΝΤΡΟ only, Corfu knows ΣΑΡΟΚΟ / ΜΕΘΟΔΙΟΥ / ΠΟΛΗ', () => {
  assert.deepEqual(B.CENTER_WORDS.patra, ['κεντρο']);
  assert.deepEqual(B.centerWords('patra'), ['κεντρο']);
  for (const w of ['σαροκο', 'μεθοδιου', 'πολη']) assert.ok(B.centerWords('corfu').includes(w));
  assert.deepEqual(B.centerWords('nowhere'), B.CENTER_WORDS[DEFAULT_CITY]);
  assert.deepEqual(B.centerWords(), B.CENTER_WORDS[DEFAULT_CITY], 'default = active city = Patras in tests');
});

test('parseRouteName: Corfu centre words become centre items, bracketed ΠΟΛΗ is ignored', () => {
  const corfu = B.CENTER_WORDS.corfu;
  const tok = (n, w) => B.parseRouteName(n, w).items.map((i) => (i.center ? (i.implicit ? '(c)' : 'C') : i.token) + '@' + i.p.toFixed(1));
  assert.deepEqual(tok('ΣΑΡΟΚΟ (ΠΟΛΗ) - ΤΕΜΠΛΟΝΙ', corfu), ['C@0.0', 'τεμπλονι@1.0']);
  assert.deepEqual(tok('ΤΕΜΠΛΟΝΙ- ΠΟΤΑΜΟΣ- ΣΑΡΟΚΟ (ΠΟΛΗ)', corfu), ['τεμπλονι@0.0', 'ποταμοσ@0.5', 'C@1.0']);
  assert.deepEqual(tok('ΜΕΘΟΔΙΟΥ (ΠΟΛΗ) - ΑΧΙΛΛΕΙΟN - ΠΕΡΑΜΑ', corfu), ['C@0.0', 'αχιλλειον@0.5', 'περαμα@1.0']);
  assert.deepEqual(tok('ΣΑΡΟΚΟ - ΑΓ. ΙΩΑΝΝΗΣ - ΑΦΡΑ', corfu).slice(0, 1), ['C@0.0']);
  // a lone place still gets the implicit centre, a lone centre word does not
  assert.deepEqual(tok('ΠΕΛΕΚΑΣ', corfu), ['πελεκασ@1.0', '(c)@0.0']);
  assert.deepEqual(tok('ΣΑΡΟΚΟ', corfu), ['C@1.0']);
});

test('parseRouteName: with Patras words (the default) the Corfu centre words are ordinary tokens', () => {
  const items = B.parseRouteName('ΣΑΡΟΚΟ (ΠΟΛΗ) - ΤΕΜΠΛΟΝΙ').items;
  assert.deepEqual(items.map((i) => i.token ?? 'C'), ['σαροκο', 'τεμπλονι']);
  assert.deepEqual(B.parseRouteName('ΚΕΝΤΡΟ - ΕΓΛΥΚΑΔΑ').items.map((i) => (i.center ? 'C' : i.token)), ['C', 'εγλυκαδα']);
});

test('active city drives centerWords() and the data dir; restored afterwards', () => {
  try {
    assert.ok(setActiveCity('corfu'));
    assert.deepEqual(B.centerWords(), B.CENTER_WORDS.corfu);
    assert.equal(dataDir(), './data/corfu/');
    assert.deepEqual(B.parseRouteName('ΣΑΡΟΚΟ (ΠΟΛΗ) - ΤΕΜΠΛΟΝΙ').items.map((i) => !!i.center), [true, false]);
  } finally {
    setActiveCity(DEFAULT_CITY);
  }
  assert.deepEqual(B.centerWords(), ['κεντρο']);
});
