import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The real pure section of the service worker, evaluated verbatim.
const swSrc = readFileSync(new URL('../web/sw.js', import.meta.url), 'utf8');
const pure = swSrc.slice(swSrc.indexOf('// <pure>'), swSrc.indexOf('// </pure>'));
const { mapKind, trimSelect } = new Function(`${pure}; return { mapKind, trimSelect };`)();

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

test('sw.js: never matches /api/, keeps the MapLibre shell, has no offline-download cache', () => {
  assert.match(swSrc, /pathname\.includes\('\/api\/'\)/);
  assert.match(swSrc, /vendor\/maplibre-gl\/maplibre-gl\.js/);
  assert.match(swSrc, /vendor\/maplibre-gl\/maplibre-gl\.css/);
  assert.doesNotMatch(swSrc, /importScripts|map-offline/);
});
