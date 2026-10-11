import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { contrast, readableLine } from '../web/js/color.js';
import { buildIndex } from '../web/js/data.js';

const json = (p) => JSON.parse(readFileSync(new URL(`../web/data/${p}`, import.meta.url), 'utf8'));

test('contrast: WCAG ratios', () => {
  assert.equal(contrast('#000', '#fff').toFixed(1), '21.0');
  assert.equal(contrast('#ffffff', '#ffffff'), 1);
  assert.equal(contrast('#767676', '#fff').toFixed(2), '4.54');
  assert.equal(contrast('red', '#fff'), null);
});

test('readableLine: readable pairs are left alone', () => {
  assert.deepEqual(readableLine('#1a237e', '#ffffff'), { color: '#1a237e', textColor: '#ffffff' });
  assert.deepEqual(readableLine(null, null), { color: null, textColor: null });
  assert.deepEqual(readableLine('rebeccapurple', '#fff'), { color: 'rebeccapurple', textColor: '#fff' });
});

test('readableLine: a barely visible darkening first, then dark text on bright lines', () => {
  assert.deepEqual(readableLine('#787878', '#ffffff'), { color: '#767676', textColor: '#ffffff' }); // 4.42 → 4.54
  assert.deepEqual(readableLine('#00bcd4', '#ffffff'), { color: '#00bcd4', textColor: '#1f1f1f' }); // 2.30 → 7.18
  assert.deepEqual(readableLine('#ff5722', null), { color: '#ff5722', textColor: '#1f1f1f' });
});

test('every line of both cities reads at 4.5:1 or more, colour kept or nudged by at most 6%', () => {
  for (const dir of ['', 'corfu/']) {
    const raw = json(`${dir}lines.json`);
    const { lines } = buildIndex([], raw, null);
    for (const l of lines) {
      assert.ok(contrast(l.color, l.textColor || '#fff') >= 4.5, `${dir}${l.code} ${l.color}/${l.textColor}`);
      const src = raw.find((r) => String(r.code) === l.code);
      const drift = [1, 3, 5].map((i) => Math.abs(parseInt(src.color.slice(i, i + 2), 16) - parseInt(l.color.slice(i, i + 2), 16)));
      assert.ok(Math.max(...drift) <= Math.ceil(255 * 0.06), `${dir}${l.code} ${src.color} → ${l.color}`);
    }
  }
});
