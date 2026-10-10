// Guide integration (docs/GUIDE.md part C): hash parsing of #/guide, shell wiring (SNAP, menu, service worker, index.html).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseHash, formatHash, resolveBootCity } from '../web/js/route.js';

const read = (p) => readFileSync(new URL(`../web/${p}`, import.meta.url), 'utf8');

test('#/guide parses with and without a city prefix and with ?section=install', () => {
  const a = parseHash('#/guide');
  assert.deepEqual([a.city, a.parts, a.rel], [null, ['guide'], '#/guide']);
  const b = parseHash('#/corfu/guide');
  assert.deepEqual([b.city, b.parts, b.rel], ['corfu', ['guide'], '#/guide']);
  const c = parseHash('#/guide?section=install');
  assert.deepEqual([c.city, c.parts, c.params], [null, ['guide'], { section: 'install' }]);
  const d = parseHash('#/corfu/guide?section=install');
  assert.deepEqual([d.city, d.parts, d.params, d.rel], ['corfu', ['guide'], { section: 'install' }, '#/guide?section=install']);
});

test('#/guide gets the city prefix on the way out, except for the default city', () => {
  assert.equal(formatHash('#/guide', 'patra'), '#/guide');
  assert.equal(formatHash('#/guide?section=install', 'corfu'), '#/corfu/guide?section=install');
  assert.equal(formatHash('#/corfu/guide', 'patra'), '#/guide');
});

test('boot city: a bare #/guide opens in the saved city, a prefixed one in its own city', () => {
  assert.equal(resolveBootCity('#/guide', 'corfu'), 'corfu');
  assert.equal(resolveBootCity('#/corfu/guide', 'patra'), 'corfu');
});

test('app.js: guide route is full-height, in the menu above settings, and loads the install helper without awaiting it at boot', () => {
  const src = read('js/app.js');
  assert.match(src, /SNAP = \{[^}]*guide: 'full'/);
  assert.match(src, /case 'guide':/);
  assert.match(src, /mountGuide\(content, ctx/);
  assert.match(src, /ctx\.renderInstall = /);
  assert.match(src, /captureInstallPrompt\(\)/);
  assert.ok(src.indexOf("item('#/guide'") > 0 && src.indexOf("item('#/guide'") < src.indexOf("item('#/settings'"), 'guide menu item must sit above settings');
  assert.match(src, /const bootHome = parseHash\(location\.hash\)\.path === '\/'/);
});

test('service worker precaches the guide files and index.html links their styles', () => {
  const sw = read('sw.js');
  for (const f of ['js/guide-view.js', 'js/platform.js', 'js/install-guide.js', 'css/guide.css', 'css/install.css']) {
    assert.ok(sw.includes(`'${f}'`), `${f} missing from SHELL`);
  }
  assert.ok(!sw.includes("'patra-bus-v14'"), 'CACHE must be bumped');
  const html = read('index.html');
  for (const f of ['css/guide.css', 'css/install.css']) assert.ok(html.includes(`href="${f}"`), `${f} not linked`);
});
