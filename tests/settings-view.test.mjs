import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Static check: settings-view.js needs a DOM, so it is read as text. Every paint*() it calls (the
// visibilitychange handler included) must be declared in the file; a6d7d3b removed paintInstall but
// left the call in onVis, which threw a ReferenceError each time the tab came back.
const src = readFileSync(new URL('../web/js/settings-view.js', import.meta.url), 'utf8');
const declared = new Set([
  ...[...src.matchAll(/\bfunction\s+(paint\w*)\s*\(/g)].map((m) => m[1]),
  ...[...src.matchAll(/\b(?:const|let)\s+(paint\w*)\s*=/g)].map((m) => m[1]),
]);

test('every paint*() called in settings-view.js is declared there', () => {
  const called = new Set([...src.matchAll(/(?<![\w.])(paint\w*)\s*\(/g)].map((m) => m[1]));
  const missing = [...called].filter((name) => !declared.has(name));
  assert.deepEqual(missing, []);
});
