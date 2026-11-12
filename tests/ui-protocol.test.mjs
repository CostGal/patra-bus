// TEL-269: the static half of the UI protocol checks (docs/UI-PROTOCOL.md, rules marked "auto").
// It reads the CSS, JS and HTML as text, without running the app, and checks the rules a file can show on its own:
// U3 (.g-circle's size lives only in the kit), U8 (the sheet drag never drives a layout property), U12 (a glass layer
// never fades with the drag), U14 (up from mid is the quickest spring), U15 (status bar style), U19 (title selectors).
// The e2e half (tests/e2e/ui-protocol.spec.mjs) measures what only a browser can.
// What breaks today is listed in tests/ui-protocol-exceptions.mjs; a listed exception that no longer breaks fails too,
// so the list only gets shorter. Empty list = UI protocol v1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { STATIC_EXCEPTIONS } from './ui-protocol-exceptions.mjs';

const WEB = new URL('../web/', import.meta.url);
const read = (p) => readFileSync(new URL(p, WEB), 'utf8');

// The stylesheets the app loads, in order (index.html), minus the vendored map.
const SHEETS = [...read('index.html').matchAll(/<link rel="stylesheet" href="([^"]+\.css)">/g)]
  .map((m) => m[1]).filter((f) => !f.startsWith('vendor/'));

// ---- a small CSS reader: enough for our own files (rules, nested @media/@supports, comments) ----
// Returns [{ file, selector, media, decls: [{ prop, value }] }], one entry per rule.
export function parseCss(text, file = '') {
  const src = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  let i = 0;
  const walk = (media) => {
    let start = i;
    while (i < src.length) {
      const c = src[i];
      if (c === '{') {
        const head = src.slice(start, i).trim();
        i++;
        if (head.startsWith('@media') || head.startsWith('@supports') || head.startsWith('@layer')) {
          walk(media ? `${media} and ${head}` : head);
        } else if (head.startsWith('@')) { // @keyframes, @font-face…: skip the whole block
          let depth = 1;
          while (i < src.length && depth) { if (src[i] === '{') depth++; else if (src[i] === '}') depth--; i++; }
        } else {
          const end = src.indexOf('}', i);
          const body = src.slice(i, end);
          i = end + 1;
          rules.push({ file, selector: head.replace(/\s+/g, ' '), media, decls: parseDecls(body) });
        }
        start = i;
      } else if (c === '}') { i++; return; } else if (c === ';' && src.slice(start, i).trim().startsWith('@')) {
        i++; start = i; // @import / @charset
      } else i++;
    }
  };
  walk('');
  return rules;
}

function parseDecls(body) {
  const out = [];
  let depth = 0, start = 0;
  for (let i = 0; i <= body.length; i++) {
    const c = body[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if ((c === ';' || i === body.length) && depth === 0) {
      const d = body.slice(start, i).trim();
      start = i + 1;
      const k = d.indexOf(':');
      if (k > 0) out.push({ prop: d.slice(0, k).trim().toLowerCase(), value: d.slice(k + 1).trim().replace(/\s*!important$/, '') });
    }
  }
  return out;
}

const RULES = SHEETS.flatMap((f) => parseCss(read(f), f));
const key = (r, prop) => `${r.file}: ${r.selector} { ${prop} }`;

// Compares what broke with the listed exceptions of one rule: both lists must match exactly.
function expectOnly(rule, broken) {
  const listed = Object.keys(STATIC_EXCEPTIONS[rule] || {});
  const unlisted = broken.filter((k) => !listed.includes(k));
  const fixed = listed.filter((k) => !broken.includes(k));
  assert.deepEqual(unlisted, [], `${rule} breaks here (fix it, or list it with a reason in tests/ui-protocol-exceptions.mjs):\n  ${unlisted.join('\n  ')}`);
  assert.deepEqual(fixed, [], `${rule} holds now here: remove these from tests/ui-protocol-exceptions.mjs:\n  ${fixed.join('\n  ')}`);
}

// ---- the parser itself ----
test('ui protocol: the CSS reader finds rules, @media blocks and declarations', () => {
  const r = parseCss('/* x { } */ .a, .b { color: red; width: calc(1px + var(--l, 1) * 2px) }\n@media (max-width: 9px) { .c { top: 0 !important } }\n@keyframes k { from { top: 0 } }', 't.css');
  assert.deepEqual(r.map((x) => x.selector), ['.a, .b', '.c']);
  assert.equal(r[0].decls[1].value, 'calc(1px + var(--l, 1) * 2px)');
  assert.equal(r[1].media, '@media (max-width: 9px)');
  assert.deepEqual(r[1].decls, [{ prop: 'top', value: '0' }]);
  assert.ok(SHEETS.includes('css/ui-kit.css') && SHEETS.includes('app.css'), 'reads the app\'s stylesheets from index.html');
  assert.ok(RULES.length > 300, `read ${RULES.length} rules`);
});

// ---- U3: a round button in a card is .g-circle, sized only by the kit ----
const SIZE = new Set(['width', 'height', 'min-width', 'min-height', 'max-width', 'max-height', 'padding', 'inline-size', 'block-size']);
test('U3: .g-circle is 38 px, min-height and padding reset, a 20 px icon, and only the kit sizes it', () => {
  const kit = RULES.filter((r) => r.file === 'css/ui-kit.css' && r.selector === '.btn.round.g-circle')[0];
  assert.ok(kit, 'css/ui-kit.css has .btn.round.g-circle');
  const v = Object.fromEntries(kit.decls.map((d) => [d.prop, d.value]));
  assert.deepEqual([v.width, v.height, v['min-height'], v.padding], ['38px', '38px', '0', '0']);
  const tap = RULES.find((r) => r.file === 'css/ui-kit.css' && r.selector === '.btn.round.g-circle::after');
  assert.ok(tap?.decls.some((d) => d.prop === 'inset' && d.value === '-3px'), '::after reaches 3 px out: a 44 px tap area');
  const ico = RULES.find((r) => r.file === 'css/ui-kit.css' && r.selector === '.btn.round.g-circle .icon');
  assert.ok(ico?.decls.some((d) => d.prop === 'width' && d.value === '20px'), '20 px icon');
  // anywhere else: a rule whose subject is the circle (or its icon) does not set a size
  const broken = RULES.filter((r) => r.file !== 'css/ui-kit.css')
    .flatMap((r) => r.selector.split(',').map((s) => s.trim())
      .filter((s) => /\.g-circle(?:[.:[][^ >+~]*)?(?: \.icon)?$/.test(s))
      .flatMap((s) => r.decls.filter((d) => SIZE.has(d.prop) || (/ \.icon$/.test(s) && (d.prop === 'width' || d.prop === 'height')))
        .map((d) => `${r.file}: ${s} { ${d.prop} }`)));
  expectOnly('U3', [...new Set(broken)]);
});

// ---- U8: the drag (--l, --u, --sheet-t) drives only transform, opacity and paint, never layout ----
const DRAG = /var\(\s*--(?:l|u|sheet-t)\s*[,)]/;
// custom properties computed from the drag count as the drag (e.g. --g-blur-sheet), one level after another
function tainted() {
  const names = new Set();
  for (let grew = true; grew;) {
    grew = false;
    for (const r of RULES) for (const d of r.decls) {
      if (!d.prop.startsWith('--') || names.has(d.prop) || ['--l', '--u'].includes(d.prop)) continue;
      if (DRAG.test(d.value) || [...names].some((n) => d.value.includes(`var(${n}`))) { names.add(d.prop); grew = true; }
    }
  }
  return names;
}
const TAINT = tainted();
const fromDrag = (v) => DRAG.test(v) || [...TAINT].some((n) => new RegExp(`var\\(\\s*${n}\\s*[,)]`).test(v));
const LAYOUT = /^(?:font|font-size|line-height|letter-spacing|width|height|(?:min|max)-(?:width|height)|inline-size|block-size|margin(?:-.+)?|padding(?:-.+)?|top|right|bottom|left|inset(?:-.+)?|gap|row-gap|column-gap|flex|flex-grow|flex-shrink|flex-basis|grid(?:-.+)?|border(?:-[a-z]+)?-width|border-width)$/;
test('U8: the sheet drag never changes a font size or a layout property', () => {
  assert.ok(TAINT.size >= 0);
  const broken = RULES.flatMap((r) => r.decls.filter((d) => LAYOUT.test(d.prop) && fromDrag(d.value)).map((d) => key(r, d.prop)));
  expectOnly('U8', [...new Set(broken)]);
});

// ---- U12: a glass layer never fades with the drag ----
test('U12: a rule with a backdrop-filter does not take its opacity from the drag', () => {
  const glassSel = new Set(RULES.filter((r) => r.decls.some((d) => d.prop === 'backdrop-filter' && d.value !== 'none')).map((r) => r.selector));
  const broken = RULES.filter((r) => glassSel.has(r.selector))
    .flatMap((r) => r.decls.filter((d) => d.prop === 'opacity' && fromDrag(d.value)).map((d) => key(r, d.prop)));
  expectOnly('U12', broken);
});

// ---- U14: up from mid is quicker than the other moves ----
test('U14: the mid→up spring has response 0.3, the quickest of the sheet\'s springs', () => {
  const js = read('js/sheet.js');
  const springs = Object.fromEntries([...js.matchAll(/'(\w+>\w+)':\s*\{[^}]*response:\s*([\d.]+)/g)].map((m) => [m[1], Number(m[2])]));
  const settle = Number(js.match(/const SETTLE = \{[^}]*response:\s*([\d.]+)/)?.[1]);
  assert.equal(springs['half>full'], 0.3, 'half>full response');
  for (const [k, r] of Object.entries(springs)) if (k !== 'half>full') assert.ok(r > 0.3, `${k} (${r}) is slower than mid→up`);
  assert.ok(settle > 0.3, `SETTLE (${settle}) is slower than mid→up`);
});

// ---- U15: the installed app keeps the default status bar ----
test('U15: apple-mobile-web-app-status-bar-style is "default"', () => {
  const html = read('index.html');
  const m = [...html.matchAll(/<meta name="apple-mobile-web-app-status-bar-style" content="([^"]*)">/g)];
  assert.equal(m.length, 1, 'one status bar meta');
  assert.equal(m[0][1], 'default');
});

// ---- U19: a title's selector beats .sheet-content h1 (two classes) ----
// A title is an h1, or an element with a class the views give to an h1 (h('h1', { class: '…' })).
const VIEW_JS = ['js/app.js', 'js/arrivals-view.js', 'js/bus-view.js', 'js/lines-view.js', 'js/settings-view.js', 'js/report-view.js', 'js/home-view.js'];
const H1_CLASSES = new Set(VIEW_JS.flatMap((f) => [...read(f).matchAll(/h\(\s*'h1'\s*,\s*\{\s*class:\s*'([^']+)'/g)].flatMap((m) => m[1].split(/\s+/))));
const TYPE = new Set(['font', 'font-size', 'line-height', 'letter-spacing', 'font-weight']);
const classCount = (s) => (s.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) || []).length;
test('U19: a rule that sets a title\'s type uses at least two classes', () => {
  const broken = RULES.filter((r) => r.decls.some((d) => TYPE.has(d.prop))).flatMap((r) => r.selector.split(',').map((s) => s.trim())
    .filter((s) => {
      const subject = s.split(/[ >+~]+/).pop();
      const isTitle = /^h1\b/.test(subject) || (subject.match(/\.[\w-]+/g) || []).some((c) => H1_CLASSES.has(c.slice(1)));
      return isTitle && s !== '.sheet-content h1' && classCount(s) < 2;
    }).map((s) => `${r.file}: ${s}`));
  expectOnly('U19', [...new Set(broken)]);
});
