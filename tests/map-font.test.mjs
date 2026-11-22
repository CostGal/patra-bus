import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { styleFor } from '../web/js/map-style.js';

// TEL-361: MapLibre drops all the labels of a tile when one glyph range fails, so the tiny "empty" files must stay.
for (const face of ['Manrope Regular', 'Manrope Bold']) {
  test(`map font: ${face} has all 256 glyph ranges`, () => {
    const files = new Set(readdirSync(new URL(`../web/fonts/${face}/`, import.meta.url)));
    for (let i = 0; i < 65536; i += 256) assert.ok(files.has(`${i}-${i + 255}.pbf`), `${i}-${i + 255}.pbf missing`);
  });
}

test('map font: every text layer uses our Manrope glyphs, and the input is not changed', () => {
  const layer = (id, font) => ({ id, type: 'symbol', source: 'openmaptiles', layout: { 'text-field': '{name}', ...(font && { 'text-font': font }) } });
  const base = {
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: { openmaptiles: {} },
    layers: [layer('a', ['Noto Sans Regular']), layer('b', ['Noto Sans Bold']), layer('c', ['Noto Sans Italic']), layer('d')],
  };
  const before = JSON.stringify(base);
  const style = styleFor(base, 'light', 'el');
  assert.equal(JSON.stringify(base), before);
  assert.match(style.glyphs, /\/web\/fonts\/\{fontstack\}\/\{range\}\.pbf$/);
  assert.deepEqual(style.layers.map((l) => l.layout['text-font'][0]), ['Manrope Regular', 'Manrope Bold', 'Manrope Regular', 'Manrope Regular']);
});
