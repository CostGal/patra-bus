import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { shouldSetup, initialLang, STEPS } from '../web/js/setup.js';
import { PAIRS } from '../web/js/i18n-en-setup.js';
import { EN } from '../web/js/i18n-en.js';
import { DEFAULT_SETTINGS } from '../web/js/store.js';

// Windows checkouts have CRLF line endings; drop the \r so multi-line matches behave as on Linux CI.
const read = (f) => readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('shouldSetup: once, only on a home-view boot; a preview always shows', () => {
  assert.equal(shouldSetup({ seen: false, bootHome: true }), true);
  assert.equal(shouldSetup({ seen: true, bootHome: true }), false);
  assert.equal(shouldSetup({ seen: false, bootHome: false }), false, 'never over a shared link');
  assert.equal(shouldSetup({ seen: true, bootHome: false, preview: true }), true);
  assert.equal(shouldSetup({}), false);
});

test('initialLang: system language decides, an explicit English choice stays', () => {
  assert.equal(initialLang('el', 'en-US'), 'en');
  assert.equal(initialLang('el', 'el-GR'), 'el');
  assert.equal(initialLang('auto', 'de-DE'), 'en');
  assert.equal(initialLang('en', 'el-GR'), 'en');
  assert.equal(initialLang('el', ''), 'en');
  assert.equal(STEPS, 3);
});

test('setup: skipping keeps Greek (store default stays el), flag survives reset', () => {
  assert.equal(DEFAULT_SETTINGS.lang, 'el');
  assert.match(read('js/store.js'), /KEEP_ON_RESET = \[[^\]]*'setupDone'/);
});

test('setup: English pairs exist for every string and are merged into EN', () => {
  for (const [el, en] of PAIRS) assert.ok(EN.get(el) === en && en.trim(), el);
});

test('setup wiring: flags on show, opened before the first route, welcome after it, files precached', () => {
  const src = read('js/setup.js');
  assert.match(src, /if \(!preview\) \{[^}]*setSetting\('setupDone', true\);\s*setSetting\('guideSeen', true\);/);
  const app = read('js/app.js');
  assert.ok(app.indexOf('maybeSetup(') < app.indexOf('await route();\n  booted = true;'), 'setup opens before the home mounts');
  assert.ok(app.indexOf('Promise.resolve(setupClosed)') < app.indexOf("import('./welcome.js')"), 'welcome waits for the setup');
  const sw = read('sw.js');
  for (const f of ['js/setup.js', 'css/setup.css', 'js/i18n-en-setup.js']) assert.ok(sw.includes(`'${f}'`), f);
  assert.match(read('index.html'), /href="css\/setup\.css"/);
});
