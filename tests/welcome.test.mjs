import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { shouldWelcome } from '../web/js/welcome.js';
import { PAIRS } from '../web/js/i18n-en-welcome.js';
import { EN } from '../web/js/i18n-en.js';

const read = (f) => readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf8');

test('shouldWelcome: installed app and not seen yet; a preview always shows; a browser tab never does', () => {
  assert.equal(shouldWelcome({ standalone: true, seen: false, preview: false }), true);
  assert.equal(shouldWelcome({ standalone: true, seen: true, preview: false }), false);
  assert.equal(shouldWelcome({ standalone: false, seen: false, preview: false }), false);
  assert.equal(shouldWelcome({ standalone: false, seen: true, preview: true }), true);
  assert.equal(shouldWelcome({ standalone: true, seen: true, preview: true }), true);
  assert.equal(shouldWelcome({}), false);
});

test('welcome: English pairs exist for every string and are merged into EN', () => {
  assert.ok(PAIRS.length >= 5);
  for (const [el, en] of PAIRS) assert.ok(EN.get(el) === en && en.trim(), el);
});

test('welcome wiring: flag is set on show (not on close), preview leaves it alone, boot never waits for it', () => {
  const src = read('js/welcome.js');
  assert.match(src, /if \(!preview\) setSetting\('welcomeSeen', true\)/);
  assert.doesNotMatch(src, /onclick: \(\) => \{[^}]*setSetting/);
  const app = read('js/app.js');
  assert.match(app, /import\('\.\/welcome\.js'\)\.then\(\(m\) => m\.maybeWelcome\(\)\)\.catch\(\(\) => \{\}\)/);
  assert.ok(app.indexOf('booted = true;') < app.indexOf("import('./welcome.js')"), 'welcome starts after the first route');
  const store = read('js/store.js');
  assert.match(store, /welcomeSeen: \(v\) => typeof v === 'boolean'/);
  assert.match(store, /KEEP_ON_RESET = \[[^\]]*'welcomeSeen'/);
});

test('welcome assets: precached, linked, cache bumped, reduced motion handled', () => {
  const sw = read('sw.js');
  for (const f of ['js/welcome.js', 'css/welcome.css', 'js/i18n-en-welcome.js']) assert.ok(sw.includes(`'${f}'`), `${f} missing from SHELL`);
  assert.ok(!sw.includes("'patra-bus-v16'") && !sw.includes("'patra-bus-v15'"), 'CACHE must be bumped');
  assert.ok(read('index.html').includes('href="css/welcome.css"'));
  assert.match(read('css/welcome.css'), /prefers-reduced-motion: reduce/);
  assert.match(read('js/ui.js'), /^\s*heart: '/m);
});
