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

test('the visibilitychange handler only calls declared functions', () => {
  const onVis = src.match(/const onVis = \(\) => (.*?);\s*\/\/|const onVis = \(\) => (.*?);\n/);
  assert.ok(onVis, 'onVis handler not found');
  const body = onVis[1] ?? onVis[2];
  const calls = [...body.matchAll(/(?<![\w.])([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]).filter((n) => n !== 'if');
  assert.ok(calls.length > 0);
  for (const name of calls) assert.ok(declared.has(name), `onVis calls undeclared ${name}()`);
});
