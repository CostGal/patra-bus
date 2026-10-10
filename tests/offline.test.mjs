import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CITIES } from '../web/js/cities.js';
import {
  lon2x, lat2y, tileRange, tileCount, tileList, tileUrl, fontStacks, glyphUrls, spriteUrls,
  buildPlan, estimateDownload, fmtBytes, ZOOMS, GLYPH_RANGES,
} from '../web/js/offline.js';

const PATRAS_BBOX = CITIES.patra.bbox;

// The real pure section of the service worker, evaluated verbatim.
const swSrc = readFileSync(new URL('../web/sw.js', import.meta.url), 'utf8');
const pure = swSrc.slice(swSrc.indexOf('// <pure>'), swSrc.indexOf('// </pure>'));
const { mapKind, trimSelect } = new Function(`${pure}; return { mapKind, trimSelect };`)();

test('tile math: known coordinates', () => {
  assert.equal(lon2x(-180, 3), 0);
  assert.equal(lon2x(179.99, 3), 7);
  assert.equal(lon2x(0, 1), 1);
  assert.equal(lat2y(0, 1), 1);
  assert.equal(lat2y(85, 2), 0);
  // Athens is OSM tile 10/579/395; the asinh form is an independent formula for y
  assert.equal(lon2x(23.7275, 10), 579);
  assert.equal(lat2y(37.9838, 10), 395);
  for (const [lat, z] of [[38.2466, 14], [38.13, 12], [38.33, 9]]) {
    assert.equal(lat2y(lat, z), Math.floor(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** z));
  }
  assert.equal(lon2x(21.7346, 14), 9181);
  assert.equal(lat2y(38.2466, 14), 6305);
});

test('tileRange: bbox corners, clamped, never empty', () => {
  const r = tileRange(PATRAS_BBOX, 12);
  assert.ok(r.x0 <= r.x1 && r.y0 <= r.y1);
  assert.equal(r.x0, lon2x(21.6, 12));
  assert.equal(r.y0, lat2y(38.33, 12)); // north = smaller y
  assert.equal(r.y1, lat2y(38.13, 12));
  const w = tileRange({ west: -200, east: 200, south: -89, north: 89 }, 2);
  assert.deepEqual(w, { x0: 0, x1: 3, y0: 0, y1: 3 });
  const z0 = tileRange(PATRAS_BBOX, 0);
  assert.deepEqual(z0, { x0: 0, x1: 0, y0: 0, y1: 0 });
});

test('tileCount matches tileList and doubles roughly per level', () => {
  const list = tileList(PATRAS_BBOX, 8, 14);
  assert.equal(list.length, tileCount(PATRAS_BBOX, 8, 14));
  assert.equal(new Set(list.map((t) => `${t.z}/${t.x}/${t.y}`)).size, list.length);
  assert.ok(list.every((t) => t.z >= 8 && t.z <= 14));
  assert.equal(tileCount(PATRAS_BBOX, 14, 14), 182);
  assert.ok(tileCount(PATRAS_BBOX, 15, 15) > 3 * tileCount(PATRAS_BBOX, 14, 14));
  assert.equal(tileCount(PATRAS_BBOX, 10, 14), 271);
  // the default download stays small (a single sweep of Patras is a few hundred tiles)
  assert.ok(tileCount(PATRAS_BBOX, ZOOMS.min, ZOOMS.max) < 500);
});

test('tileUrl fills the TileJSON template', () => {
  const tpl = 'https://tiles.openfreemap.org/planet/20261004_113936_pt/{z}/{x}/{y}.pbf';
  assert.equal(tileUrl(tpl, { z: 14, x: 9181, y: 6305 }), 'https://tiles.openfreemap.org/planet/20261004_113936_pt/14/9181/6305.pbf');
});

test('fontStacks: plain, literal and stops forms, deduplicated', () => {
  const style = {
    layers: [
      { id: 'a', layout: { 'text-font': ['Noto Sans Regular'] } },
      { id: 'b', layout: { 'text-font': ['Noto Sans Bold'] } },
      { id: 'c', layout: { 'text-font': ['Noto Sans Regular'] } },
      { id: 'd', layout: { 'text-font': ['literal', ['Noto Sans Italic', 'Arial']] } },
      { id: 'e', layout: { 'text-font': { stops: [[5, ['Foo']], [9, ['Bar']]] } } },
      { id: 'f', layout: {} },
      { id: 'g' },
    ],
  };
  assert.deepEqual(fontStacks(style), ['Bar', 'Foo', 'Noto Sans Bold', 'Noto Sans Italic,Arial', 'Noto Sans Regular']);
  assert.deepEqual(fontStacks({}), []);
});

test('glyph ranges cover Latin and Greek (incl. tonos, extended, dashes)', () => {
  const covers = (cp) => GLYPH_RANGES.some(([a, b]) => cp >= a && cp <= b);
  for (const ch of 'AaZzéüŁΆάωϊἀᾶ–’') assert.ok(covers(ch.codePointAt(0)), ch);
  // ranges are the 256-aligned blocks the glyph protocol uses
  for (const [a, b] of GLYPH_RANGES) { assert.equal(a % 256, 0); assert.equal(b - a, 255); }
});

test('glyphUrls and spriteUrls', () => {
  const g = glyphUrls('https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf', ['Noto Sans Regular']);
  assert.equal(g.length, GLYPH_RANGES.length);
  assert.equal(g[0], 'https://tiles.openfreemap.org/fonts/Noto Sans Regular/0-255.pbf');
  assert.equal(new URL(g[0]).href, 'https://tiles.openfreemap.org/fonts/Noto%20Sans%20Regular/0-255.pbf');
  assert.deepEqual(spriteUrls('https://x/s/ofm'), ['https://x/s/ofm.json', 'https://x/s/ofm.png', 'https://x/s/ofm@2x.json', 'https://x/s/ofm@2x.png']);
  assert.deepEqual(spriteUrls(undefined), []);
});

test('buildPlan dedupes shared sprites and glyphs across styles', () => {
  const mk = (fonts) => ({
    glyphs: 'https://t/fonts/{fontstack}/{range}.pbf',
    sprite: 'https://t/sprites/v1/ofm',
    layers: fonts.map((f) => ({ layout: { 'text-font': [f] } })),
  });
  const tilejson = { tiles: ['https://t/planet/v/{z}/{x}/{y}.pbf'], minzoom: 0, maxzoom: 14 };
  const plan = buildPlan([mk(['A', 'B']), mk(['A'])], tilejson);
  assert.equal(plan.sprites.length, 4);
  assert.equal(plan.glyphs.length, 2 * GLYPH_RANGES.length);
  assert.equal(plan.tiles.length, tileCount(PATRAS_BBOX, ZOOMS.min, ZOOMS.max));
  assert.equal(plan.all.length, plan.sprites.length + plan.glyphs.length + plan.tiles.length);
  assert.equal(new Set(plan.all).size, plan.all.length);
  assert.ok(plan.tiles[0].startsWith('https://t/planet/v/8/'));
  // a source that stops at z12 caps the zoom range
  const capped = buildPlan([mk(['A'])], { ...tilejson, maxzoom: 12 });
  assert.equal(capped.tiles.length, tileCount(PATRAS_BBOX, 8, 12));
  assert.equal(buildPlan([mk(['A'])], null).tiles.length, 0);
});

test('estimateDownload is exact on tiles and sane on bytes', () => {
  const e = estimateDownload();
  assert.equal(e.tiles, tileCount(PATRAS_BBOX, ZOOMS.min, ZOOMS.max));
  assert.ok(e.files > e.tiles);
  assert.ok(e.bytes > 1e6 && e.bytes < 100e6);
});

test('fmtBytes', () => {
  assert.equal(fmtBytes(0), '0 MB');
  assert.equal(fmtBytes(512 * 1024), '512 KB');
  assert.equal(fmtBytes(1.5 * 1048576), '1,5 MB');
  assert.equal(fmtBytes(25 * 1048576), '25 MB');
});

test('sw mapKind: only OpenFreeMap assets are classified', () => {
  const H = 'https://tiles.openfreemap.org';
  assert.equal(mapKind(`${H}/styles/liberty`), 'dynamic');
  assert.equal(mapKind(`${H}/styles/fiord`), 'dynamic');
  assert.equal(mapKind(`${H}/planet`), 'dynamic');
  assert.equal(mapKind(`${H}/planet/`), 'dynamic');
  assert.equal(mapKind(`${H}/planet/20261004_113936_pt/14/9023/6354.pbf`), 'static');
  assert.equal(mapKind(`${H}/fonts/Noto%20Sans%20Regular/768-1023.pbf`), 'static');
  assert.equal(mapKind(`${H}/sprites/ofm_f384/ofm.png`), 'static');
  assert.equal(mapKind(`${H}/sprites/ofm_f384/ofm@2x.json`), 'static');
  assert.equal(mapKind(`${H}/natural_earth/ne2sr/1/0/0.png`), null);
  assert.equal(mapKind(`${H}/`), null);
  // everything else stays on the network
  for (const u of [
    'https://routing.openstreetmap.de/routed-foot/route/v1/foot/1,2;3,4',
    'https://photon.komoot.io/api/?q=patra',
    'https://tiles.openfreemap.org.evil.example/planet/1/2/3.pbf',
    'https://evil.example/tiles.openfreemap.org/planet/1/2/3.pbf',
    'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js',
    'http://localhost:8787/api/live/1011',
    'not a url',
  ]) assert.equal(mapKind(u), null, u);
});

test('sw trimSelect: oldest static first, nothing below the limit, style/TileJSON kept', () => {
  const H = 'https://tiles.openfreemap.org';
  const tile = (i) => `${H}/planet/v/14/${i}/1.pbf`;
  const urls = [`${H}/styles/liberty`, `${H}/planet`, ...Array.from({ length: 100 }, (_, i) => tile(i))];
  assert.deepEqual(trimSelect(urls, 102), []);
  assert.deepEqual(trimSelect(urls, 500), []);
  const drop = trimSelect(urls, 100); // 102 entries, keep 90% of 100 = 90 -> drop 12
  assert.equal(drop.length, 12);
  assert.deepEqual(drop, Array.from({ length: 12 }, (_, i) => tile(i))); // oldest first, never the style / TileJSON
  assert.ok(!drop.includes(`${H}/styles/liberty`) && !drop.includes(`${H}/planet`));
  // only dynamic entries left: nothing can be dropped
  assert.deepEqual(trimSelect([`${H}/styles/a`, `${H}/styles/b`, `${H}/planet`], 1), []);
  // real limit
  const many = Array.from({ length: 4001 }, (_, i) => tile(i));
  assert.equal(trimSelect(many, 4000).length, 4001 - 3600);
});

test('sw.js: still keeps importScripts, notificationclick, and never matches /api/', () => {
  assert.match(swSrc, /^[^\n]*\n(?:\/\/[^\n]*\n)*importScripts\('sw-push\.js'\);/);
  assert.match(swSrc, /addEventListener\('notificationclick'/);
  assert.match(swSrc, /pathname\.includes\('\/api\/'\)/);
  assert.match(swSrc, /vendor\/maplibre-gl\/maplibre-gl\.js/);
  assert.match(swSrc, /vendor\/maplibre-gl\/maplibre-gl\.css/);
});
