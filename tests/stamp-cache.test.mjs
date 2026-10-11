import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stamp } from '../scripts/stamp-cache.mjs';

test('stamp: replaces the CACHE line only, idempotent across shas', () => {
  const sw = readFileSync(new URL('../web/sw.js', import.meta.url), 'utf8');
  const a = stamp(sw, 'f596769b671e8f9674ae83f2bf1ef5c8d1096566');
  assert.ok(a.includes("const CACHE = 'patra-bus-f596769b';"));
  assert.equal(a.length - sw.length, "patra-bus-f596769b".length - "patra-bus-v18".length);
  const b = stamp(a, '0123456789abcdef');
  assert.ok(b.includes("const CACHE = 'patra-bus-01234567';") && !b.includes('f596769b'));
});

test('stamp: refuses a file without a CACHE line', () => {
  assert.throws(() => stamp('const X = 1;', 'abcdef12'), /CACHE line not found/);
});
