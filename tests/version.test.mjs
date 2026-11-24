// TEL-212: one version number. package.json is the source of truth; the app has no build step, so web/js/i18n.js keeps
// one copy (APP_VERSION) that everything in web/ reads. This test fails when any of the places disagree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const pkg = JSON.parse(read('package.json')).version;

test('version: package.json holds a plain x.y.z or x.y.z-pre.n number', () => {
  assert.match(pkg, /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/);
});

test('version: APP_VERSION in web/js/i18n.js matches package.json', () => {
  const found = [...read('web/js/i18n.js').matchAll(/APP_VERSION = '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(found, [pkg], 'exactly one APP_VERSION line, equal to package.json "version"');
});

test('version: package-lock.json matches package.json', () => {
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(lock.version, pkg, 'package-lock.json "version"');
  assert.equal(lock.packages[''].version, pkg, 'package-lock.json packages[""].version');
});
