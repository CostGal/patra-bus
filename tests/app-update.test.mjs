// TEL-286: «update the app» when this app is older than the worker's minApp (docs/WORKER.md section 12).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compareVersions, isOutdated, checkAppVersion } from '../web/js/app-update.js';

const answer = (body, ok = true) => async () => ({ ok, json: async () => body });

test('compareVersions: semver order with prereleases (as tests/worker-contract.test.mjs)', () => {
  const order = ['0.8.9', '0.9.0-beta.1', '0.9.0-beta.2', '0.9.0-beta.10', '0.9.0', '0.9.1', '0.10.0', '1.0.0'];
  for (let i = 0; i < order.length; i++) for (let j = 0; j < order.length; j++) assert.equal(compareVersions(order[i], order[j]), Math.sign(i - j), `${order[i]} vs ${order[j]}`);
});

test('isOutdated: only a well-formed minApp newer than the app', () => {
  assert.equal(isOutdated('0.9.1', '0.9.0-beta.1'), false);
  assert.equal(isOutdated('0.9.1', '0.9.1'), false);
  assert.equal(isOutdated('0.9.1', '0.10.0'), true);
  assert.equal(isOutdated('0.9.0-beta.1', '0.9.0'), true);
  for (const bad of [undefined, null, '', 'latest', 10, '1.0']) assert.equal(isOutdated('0.9.1', bad), false, String(bad));
});

test('checkAppVersion: shows the toast only when outdated', async () => {
  let shown = 0;
  const show = () => { shown++; };
  assert.equal(await checkAppVersion({ fetchFn: answer({ api: 1, minApp: '0.9.0-beta.1' }), demo: false, app: '0.9.1', show }), false);
  assert.equal(await checkAppVersion({ fetchFn: answer({ api: 1, minApp: '1.0.0' }), demo: false, app: '0.9.1', show }), true);
  assert.equal(shown, 1);
});

test('checkAppVersion: silent in ?demo, on an error answer, on a network failure or bad JSON', async () => {
  let shown = 0, asked = 0;
  const show = () => { shown++; };
  const counting = async () => { asked++; return { ok: true, json: async () => ({ minApp: '9.9.9' }) }; };
  assert.equal(await checkAppVersion({ fetchFn: counting, demo: true, app: '0.9.1', show }), false);
  assert.equal(asked, 0);
  assert.equal(await checkAppVersion({ fetchFn: answer({ minApp: '9.9.9' }, false), demo: false, app: '0.9.1', show }), false);
  assert.equal(await checkAppVersion({ fetchFn: async () => { throw new TypeError('offline'); }, demo: false, app: '0.9.1', show }), false);
  assert.equal(await checkAppVersion({ fetchFn: async () => ({ ok: true, json: async () => { throw new SyntaxError('x'); } }), demo: false, app: '0.9.1', show }), false);
  assert.equal(shown, 0);
});

test('checkAppVersion: asks only GET /version, with no credentials (CLAUDE.md rule 4)', async () => {
  const calls = [];
  await checkAppVersion({ fetchFn: async (url, opts) => { calls.push([url, opts]); return { ok: true, json: async () => ({}) }; }, demo: false, app: '0.9.1', show: () => {} });
  assert.equal(calls.length, 1);
  assert.match(calls[0][0], /\/version$/);
  assert.equal(calls[0][1].method, undefined);
  assert.equal(calls[0][1].body, undefined);
  assert.equal(calls[0][1].credentials, 'omit');
});

test('wiring: app.js loads it after boot, sw.js caches it', () => {
  const read = (f) => readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf8');
  assert.match(read('js/app.js'), /import\('\.\/app-update\.js'\)\.then\(\(m\) => m\.checkAppVersion\(\)\)/);
  assert.ok(read('sw.js').includes("'js/app-update.js'"));
});
