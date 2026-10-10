import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// i18n.js reads these at import time.
globalThis.document = { documentElement: {} };
Object.defineProperty(globalThis, 'navigator', { value: { language: 'el-GR' }, configurable: true, writable: true });

const guide = await import('../web/js/guide-view.js');
const { EN } = await import('../web/js/i18n-en.js');
const { PAIRS } = await import('../web/js/i18n-en-guide.js');

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const SRC = read('../web/js/guide-view.js');
const hasGreek = (s) => /[Α-Ωα-ω]/.test(s);
const ph = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

test('guide-view exports mountGuide (el, ctx) and the content tables', () => {
  assert.equal(typeof guide.mountGuide, 'function');
  assert.ok(guide.mountGuide.length >= 1);
  assert.ok(Array.isArray(guide.HOW) && guide.HOW.length >= 8);
  assert.ok(Array.isArray(guide.TAPS) && guide.TAPS.length >= 8);
});

test('every icon the guide draws exists in ui.js', () => {
  const ui = read('../web/js/ui.js');
  const names = new Set([...ui.matchAll(/^\s{2}'?([\w-]+)'?:\s*['"<]/gm)].map((m) => m[1]));
  assert.ok(names.size > 20, `found only ${names.size} icons in ui.js`);
  for (const n of guide.GUIDE_ICONS) assert.ok(names.has(n), `icon "${n}" is not defined in ui.js`);
  // and nothing in the source asks for an icon the table does not know about
  for (const m of SRC.matchAll(/icon\('([\w-]+)'\)/g)) assert.ok(names.has(m[1]), `icon('${m[1]}') is not defined in ui.js`);
});

test('content rows are well formed (ids unique, every row has a title and text)', () => {
  const ids = guide.HOW.map((r) => r[0]);
  assert.equal(new Set(ids).size, ids.length);
  for (const [id, ico, title, text] of guide.HOW) {
    assert.ok(id && ico && hasGreek(title) && hasGreek(text), `bad HOW row: ${id}`);
  }
  for (const [key, label, text] of guide.TAPS) {
    assert.ok(Boolean(key.icon) !== Boolean(key.glyph), `a TAPS key needs exactly one of icon / glyph: ${label}`);
    assert.ok(hasGreek(label) && hasGreek(text), `bad TAPS row: ${label}`);
  }
});

test('all Greek t() / N_() literals of guide-view.js have an English pair', () => {
  const lit = String.raw`'(?:\\.|[^'\\\n])*'`;
  const re = new RegExp(String.raw`(?<![\w.$])(?:t|N_)\(\s*(${lit})`, 'g');
  const keys = [...SRC.matchAll(re)].map((m) => new Function(`return ${m[1]}`)()).filter(hasGreek);
  assert.ok(keys.length > 40, `scan found only ${keys.length} literals`);
  assert.deepEqual(keys.filter((k) => !EN.has(k)), []);
});

test('i18n-en-guide.js: unique keys, placeholders match, English differs from Greek, no stale keys', () => {
  const seen = new Set();
  const used = new Set([...SRC.matchAll(/'((?:\\.|[^'\\\n])*)'/g)].map((m) => new Function(`return '${m[1]}'`)()));
  for (const [el, en] of PAIRS) {
    assert.ok(!seen.has(el), `duplicate key: ${el}`);
    seen.add(el);
    assert.ok(typeof en === 'string' && en.trim() && en !== el, `bad English for: ${el}`);
    assert.equal(ph(en), ph(el), `placeholder mismatch: ${el}`);
    assert.ok(used.has(el), `key not used by guide-view.js: ${el}`);
  }
});

test('wantedSection reads ?section=install from a hash or a params object', () => {
  assert.equal(guide.wantedSection('#/guide?section=install'), 'install');
  assert.equal(guide.wantedSection('#/corfu/guide?section=install'), 'install');
  assert.equal(guide.wantedSection('#/guide'), null);
  assert.equal(guide.wantedSection('#/guide?section=other'), null);
  assert.equal(guide.wantedSection({ section: 'install' }), 'install');
  assert.equal(guide.wantedSection({}), null);
  assert.equal(guide.wantedSection(undefined), null);
});

test('the guide only describes controls and labels that exist in the app (spot checks)', () => {
  const app = ['app.js', 'arrivals-view.js', 'planner-view.js', 'bus-view.js', 'settings-view.js', 'i18n-en.js'].map((f) => read(`../web/js/${f}`)).join('\n');
  for (const label of ['Πού πάμε;', 'Υπενθύμισέ μου', 'Είμαι στο λεωφορείο', 'Θα κατέβω σε…', 'Οδηγίες ως εδώ', 'Κοινοποίηση', 'Επαναφορά βορρά', 'Επόμενο λεωφορείο κοντά σου', 'Σπίτι, δουλειά & ρουτίνες', 'Ρυθμίσεις και σχετικά']) {
    assert.ok(app.includes(label), `label not found in the app: ${label}`);
  }
});
