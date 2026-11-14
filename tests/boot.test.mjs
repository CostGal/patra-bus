// Boot screen (TEL-255): the inline head script of index.html, its assets and its CSS rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parseHash } from '../web/js/route.js';
import { CITIES } from '../web/js/cities.js';

const read = (f) => readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf8');
const html = read('index.html');
const inline = html.match(/<script>([\s\S]*?)<\/script>/)[1];

// Runs the head script against a fake page; returns what it did to <html>, sessionStorage and window.
function runHead({ hash = '', search = '', stored = null, settings = {}, lang = 'el-GR', storage = true } = {}) {
  const classes = new Set();
  const ss = new Map(stored ? [['patra-bus:boot', stored]] : []);
  const d = { dataset: {}, lang: 'el', classList: { add: (...c) => c.forEach((x) => classes.add(x)), remove: (...c) => c.forEach((x) => classes.delete(x)) } };
  const blocked = () => { throw new Error('blocked'); };
  const win = {
    document: { documentElement: d, addEventListener() {}, removeEventListener() {}, getElementById: () => null },
    location: { hash, search },
    navigator: { language: lang },
    localStorage: { getItem: () => JSON.stringify({ settings }) },
    sessionStorage: storage ? { getItem: (k) => ss.get(k) ?? null, setItem: (k, v) => ss.set(k, v) } : { getItem: blocked, setItem: blocked },
    URLSearchParams, performance: { now: () => 0 }, setTimeout, JSON, String,
  };
  win.window = win;
  vm.runInNewContext(inline, win);
  return { shown: classes.has('boot'), classes, d, ss, win };
}

test('boot: the home rule of the head script agrees with parseHash(...).path === "/"', () => {
  for (const h of ['', '#', '#/', '#/corfu/', '#/corfu', '#/patra/', '#/?x=1', '#/stop/1011', '#/corfu/stop/801', '#/lines', '#/settings', '#/xyz']) {
    assert.equal(runHead({ hash: h }).shown, parseHash(h).path === '/', h);
  }
});

test('boot: the head script knows every city prefix', () => {
  const list = inline.match(/var cities = \[([^\]]*)\]/)[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1));
  assert.deepEqual(list.sort(), Object.keys(CITIES).sort());
});

test('boot: once per tab; ?boot forces it and leaves the key alone; ?boot=hold holds; blocked storage still shows it', () => {
  const first = runHead({ hash: '#/' });
  assert.equal(first.shown, true);
  assert.equal(first.ss.get('patra-bus:boot'), '1');
  assert.equal(runHead({ hash: '#/', stored: '1' }).shown, false, 'not again in the same tab');
  assert.equal(runHead({ hash: '#/stop/1011' }).ss.get('patra-bus:boot'), '1', 'a deep link also counts as the cold start');
  const forced = runHead({ hash: '#/stop/1011', search: '?demo&boot', stored: '1' });
  assert.equal(forced.shown, true);
  assert.equal(forced.win.__boot.hold, false);
  const fresh = runHead({ hash: '#/stop/1011', search: '?boot' });
  assert.equal(fresh.ss.has('patra-bus:boot'), false, '?boot does not set the key');
  const hold = runHead({ search: '?boot=hold' });
  assert.equal(hold.win.__boot.hold, true);
  assert.ok(hold.classes.has('boot-hold'));
  assert.equal(runHead({ hash: '#/', storage: false }).shown, true);
});

test('boot: the head script sets <html lang> with the rule of resolveLang', () => {
  assert.equal(runHead({ settings: { lang: 'en' }, lang: 'el-GR' }).d.lang, 'en');
  assert.equal(runHead({ settings: { lang: 'el' }, lang: 'en-US' }).d.lang, 'el');
  assert.equal(runHead({ settings: { lang: 'auto' }, lang: 'en-US' }).d.lang, 'en');
  assert.equal(runHead({ settings: {}, lang: 'el-GR' }).d.lang, 'el');
  assert.equal(runHead({ settings: { theme: 'dark' } }).d.dataset.theme, 'dark');
});

test('boot assets: precached, linked, #boot hidden from screen readers, no "Φόρτωση…" in index.html', () => {
  const sw = read('sw.js');
  for (const f of ['css/boot.css', 'js/boot.js']) assert.ok(sw.includes(`'${f}'`), `${f} missing from SHELL`);
  assert.ok(html.includes('href="css/boot.css"'));
  assert.match(html, /<body>\s*(<!--[^>]*-->\s*)?<div id="boot" aria-hidden="true">/, '#boot is the first child of <body>');
  assert.ok(!html.includes('Φόρτωση…'));
  assert.match(html, /id="sheet-content" aria-busy="true"/);
  assert.ok(html.indexOf('href="css/boot.css"') < html.indexOf('<script>'), 'boot.css loads before the head script');
});

test('boot.css: a reduced-motion block, a failsafe, and only transform, opacity, visibility animated', () => {
  const css = read('css/boot.css');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /boot-failsafe[^;]*5s/);
  // each @keyframes block, braces balanced; animation-timing-function inside a keyframe is allowed (it is not animated)
  const frames = [];
  for (const m of css.matchAll(/@keyframes [\w-]+ \{/g)) {
    let i = m.index + m[0].length, depth = 1;
    while (depth && i < css.length) { if (css[i] === '{') depth++; else if (css[i] === '}') depth--; i++; }
    frames.push(css.slice(m.index + m[0].length, i - 1));
  }
  assert.ok(frames.length >= 10);
  for (const f of frames) {
    for (const [, prop] of f.matchAll(/([a-z-]+)\s*:/g)) {
      assert.ok(['transform', 'opacity', 'visibility', 'animation-timing-function'].includes(prop), `animates ${prop}`);
    }
  }
  assert.doesNotMatch(css, /transition\s*:/, 'keyframes only');
});

test('boot wiring: finish() after the first route and on both error paths; the setup and welcome wait for it', () => {
  const app = read('js/app.js');
  const start = app.indexOf('async function boot()');
  const body = app.slice(start);
  assert.equal(body.match(/bootScreen\.finish\(\)/g).length, 3);
  assert.ok(body.indexOf('booted = true;\n  bootScreen.finish();') > 0, 'after the first route');
  assert.match(app, /maybeSetup\(\{ bootHome, ctx, after: bootScreen\.leaving \}\)/);
  assert.match(read('js/setup.js'), /Promise\.resolve\(after\)\.then\(/);
});
