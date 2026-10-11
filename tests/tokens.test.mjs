import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { contrast } from '../web/js/color.js';

const css = readFileSync(new URL('../web/css/tokens.css', import.meta.url), 'utf8');

// Token declarations of one block, e.g. the text between "{" and its matching "}".
function declarations(block) {
  const out = {};
  for (const m of block.matchAll(/(--[\w-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}
const blocks = {
  light: css.match(/^:root \{([\s\S]*?)^\}/m)[1],
  darkMedia: css.match(/:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)^  \}/m)[1],
  darkForced: css.match(/^:root\[data-theme="dark"\] \{([\s\S]*?)^\}/m)[1],
};
const light = declarations(blocks.light);
const dark = { ...light, ...declarations(blocks.darkForced) };

test('dark theme: the media-query block and the data-theme block are identical', () => {
  const norm = (o) => Object.entries(o).sort(([a], [b]) => a.localeCompare(b));
  assert.deepEqual(norm(declarations(blocks.darkMedia)), norm(declarations(blocks.darkForced)));
});

test('dark theme overrides only roles that exist in light', () => {
  for (const k of Object.keys(declarations(blocks.darkForced))) assert.ok(k in light, `${k} is missing from :root`);
});

// [foreground, background, minimum ratio, what it is]
const PAIRS = [
  ['foreground', 'background', 7, 'body text'],
  ['card-foreground', 'card', 7, 'card text'],
  ['popover-foreground', 'popover', 7, 'popover text'],
  ['muted-foreground', 'background', 4.5, 'secondary text on the page'],
  ['muted-foreground', 'card', 4.5, 'secondary text on a card'],
  ['muted-foreground', 'muted', 4.5, 'secondary text on a muted surface'],
  ['primary-foreground', 'primary', 4.5, 'primary button'],
  ['primary', 'card', 4.5, 'primary as text/link on a card'],
  ['destructive-foreground', 'destructive', 4.5, 'destructive button'],
  ['destructive', 'card', 4.5, 'destructive as text on a card'],
  ['input', 'card', 3, 'form control edge (WCAG 1.4.11)'],
  ['ring', 'card', 3, 'focus ring'],
  ['ring', 'background', 3, 'focus ring on the page'],
  ['warning', 'warning-muted', 4.5, 'warning text'],
  ['inverse-foreground', 'inverse', 7, 'toast text'],
  ['inverse-action', 'inverse', 4.5, 'toast action'],
  // LIVE vs SCHEDULED badges must be easy to read in both themes
  ['live-foreground', 'live', 7, 'LIVE badge text on its fill'],
  ['live', 'card', 4.5, 'LIVE countdown / outline on a card'],
  ['live', 'live-muted', 4.5, 'LIVE countdown on the "now" tile'],
  ['scheduled', 'card', 7, 'SCHEDULED badge text on a card'],
  ['scheduled', 'scheduled-muted', 7, 'SCHEDULED text on a muted surface'],
  ['scheduled-border', 'card', 3, 'SCHEDULED badge outline'],
];

for (const [theme, tokens] of [['light', light], ['dark', dark]]) {
  test(`${theme}: colour pairs meet their contrast targets`, () => {
    const val = (name) => {
      let v = tokens[`--${name}`];
      assert.ok(v, `--${name} is not defined`);
      assert.match(v, /^#[0-9a-f]{3,8}$/i, `--${name} should be a hex colour (got ${v})`);
      return v;
    };
    for (const [fg, bg, min, what] of PAIRS) {
      const c = contrast(val(fg), val(bg));
      assert.ok(c >= min, `${theme}: ${what} — --${fg} on --${bg} is ${c.toFixed(2)}:1, needs ${min}:1`);
    }
  });
}

test('LIVE and SCHEDULED are never the same colour', () => {
  for (const tokens of [light, dark]) {
    assert.notEqual(tokens['--live'].toLowerCase(), tokens['--scheduled'].toLowerCase());
    assert.notEqual(tokens['--live-muted'].toLowerCase(), tokens['--scheduled-muted'].toLowerCase());
  }
});

test('radius scale derives from the single --radius knob', () => {
  assert.match(light['--radius'], /^\d+px$/);
  for (const k of ['--radius-sm', '--radius-md', '--radius-lg']) assert.match(light[k], /var\(--radius\)/, k);
  assert.equal(light['--radius-full'], '999px');
});

// TEL-50: the pre-TEL-46 names are gone: not declared in tokens.css, not used in any stylesheet or inline var() in the JS views.
const REMOVED = ['bg', 'surface', 'surface-2', 'text', 'text-2', 'accent', 'accent-text', 'accent-soft', 'danger', 'focus', 'scrim', 'live-bg',
  'sched', 'sched-bg', 'warn', 'warn-bg', 'toast-bg', 'toast-text', 'toast-action', 's1', 's2', 's3', 's4', 'fs', 'fs-sm'];
test('removed legacy token names are not declared or used', () => {
  const re = new RegExp(`--(${REMOVED.join('|')})(?![\\w-])`);
  assert.equal(Object.keys(light).filter((k) => re.test(k)).length, 0, 'declared in tokens.css');
  const files = ['app.css', 'css/arrivals.css', 'css/extras.css', 'css/guide.css', 'css/install.css', 'css/nearby.css',
    'css/places.css', 'css/planner.css', 'css/report.css', 'css/welcome.css', 'js/lines-view.js', 'js/bus-view.js', 'index.html'];
  for (const f of files) {
    const src = readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, new RegExp(`var\\(${re.source}`), `${f} uses a removed token`);
  }
});

// Every var(--x) used in the stylesheets is defined in tokens.css, or set locally (custom property declared in a rule or JS).
test('stylesheets only use tokens that exist', () => {
  const files = ['app.css', 'css/arrivals.css', 'css/extras.css', 'css/guide.css', 'css/install.css', 'css/nearby.css',
    'css/places.css', 'css/planner.css', 'css/report.css', 'css/welcome.css'];
  const local = new Set(['--hit', '--lc', '--lc-text', '--c', '--t', '--i', '--row-h', '--pl-line', '--pl-line-text', '--sheet-y', '--panel-w',
    '--top-inset', '--chips-h', '--offline-h']);
  for (const f of files) {
    const src = readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf8');
    for (const m of src.matchAll(/var\((--[\w-]+)/g)) {
      assert.ok(m[1] in light || local.has(m[1]), `${f}: ${m[1]} is not a token`);
    }
  }
});

// TEL-47: arrival, flag and meta text is at least 13 px (--text-sm). Only these are allowed to be smaller.
test('no font-size under 13px except the known exceptions', () => {
  const files = ['app.css', 'css/arrivals.css', 'css/extras.css', 'css/guide.css', 'css/install.css', 'css/nearby.css',
    'css/places.css', 'css/planner.css', 'css/report.css', 'css/welcome.css'];
  const allowed = [/\.maplibregl-ctrl-attrib\b/, /\.mk-label\b/, /\.demo-tag\b/, /\.bv-tag\b/];
  const small = (v) => {
    const px = v.match(/^([\d.]+)px$/), rem = v.match(/^([\d.]+)rem$/);
    return px ? +px[1] < 13 : rem ? +rem[1] * 16 < 13 : v === 'var(--text-xs)' || v === 'var(--text-2xs)';
  };
  const bad = [];
  for (const f of files) {
    const src = readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const fs = m[2].match(/font-size:\s*([^;}\s]+)/);
      if (fs && small(fs[1]) && !allowed.some((re) => re.test(m[1]))) bad.push(`${f}: ${m[1].trim().slice(0, 50)} → ${fs[1]}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('secondary text keeps >= 5.5:1 on the page and the card (sunlight margin)', () => {
  for (const tokens of [light, dark]) {
    for (const bg of ['--background', '--card']) assert.ok(contrast(tokens['--muted-foreground'], tokens[bg]) >= 5.5, bg);
  }
});

// TEL-48: every control that is drawn under 44 px and listed for a bigger tap area sets --hit next to its size
test('hit-area controls each set --hit', () => {
  const read = (f) => readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf8');
  const app = read('app.css');
  const listed = app.match(/\.stopv-refresh, [^{]+\{ position: relative; \}/)[0].replace(/\{.*$/, '').split(',').map((s) => s.trim());
  assert.ok(listed.length >= 8);
  const css = read('css/arrivals.css') + read('css/nearby.css');
  for (const sel of listed) {
    const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(css, new RegExp(`${esc}[^{]*\\{[^}]*--hit:`), `${sel} sets --hit`);
    assert.ok(app.includes(`${sel}::after`), `${sel}::after is declared`);
  }
});
