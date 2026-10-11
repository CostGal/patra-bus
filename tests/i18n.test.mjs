import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Browser globals the module touches; set before the dynamic import (the module reads them at load).
const html = {};
globalThis.document = { documentElement: html };
Object.defineProperty(globalThis, 'navigator', { value: { language: 'el-GR' }, configurable: true, writable: true });
const { t, tn, lang, langPref, setLang, onLangChange, resolveLang, locale, fmtMin, etaTxt, etaSay } = await import('../web/js/i18n.js');
const { EN } = await import('../web/js/i18n-en.js');
const { getSettings } = await import('../web/js/store.js');

test('auto detection: navigator.language starting with el -> el, anything else -> en', () => {
  assert.equal(resolveLang('auto', 'el-GR'), 'el');
  assert.equal(resolveLang('auto', 'EL'), 'el');
  assert.equal(resolveLang('auto', 'en-US'), 'en');
  assert.equal(resolveLang('auto', 'de'), 'en');
  assert.equal(resolveLang('auto', ''), 'en');
  assert.equal(resolveLang(undefined, undefined), 'en');
  assert.equal(resolveLang('el', 'en-US'), 'el'); // explicit choice wins
  assert.equal(resolveLang('en', 'el-GR'), 'en');
});

test('starts in Greek for an el browser, <html lang> follows', () => {
  assert.equal(langPref(), 'auto');
  assert.equal(lang(), 'el');
  assert.equal(html.lang, 'el');
  assert.equal(locale(), 'el-GR');
});

test('t() in Greek returns the source and fills {placeholders}', () => {
  assert.equal(t('τώρα'), 'τώρα');
  assert.equal(t('Φύγε σε {n}′', { n: 6 }), 'Φύγε σε 6′');
  assert.equal(t('Γραμμή {code} · {name}', { code: '601', name: 'Άγιος' }), 'Γραμμή 601 · Άγιος');
  assert.equal(t('Περπάτησε {n}′', { n: 0 }), 'Περπάτησε 0′'); // 0 is a value, not "missing"
  assert.equal(t('Περπάτησε {n}′', {}), 'Περπάτησε ′'); // missing var -> empty, never "undefined"
  assert.equal(t('κείμενο χωρίς vars', { n: 1 }), 'κείμενο χωρίς vars');
  assert.equal(tn(1, '{n} γραμμή', '{n} γραμμές'), '1 γραμμή');
  assert.equal(tn(5, '{n} γραμμή', '{n} γραμμές'), '5 γραμμές');
  assert.equal(fmtMin(7), '7′');
});

test('setLang("en") translates, fills placeholders, persists in settings, updates <html lang>, notifies', () => {
  const seen = [];
  const off = onLangChange((l) => seen.push(l));
  assert.equal(setLang('en'), true);
  assert.equal(lang(), 'en');
  assert.equal(html.lang, 'en');
  assert.equal(locale(), 'en-GB');
  assert.equal(getSettings().lang, 'en'); // persisted through store.js
  assert.equal(t('τώρα'), 'now');
  assert.equal(t('Φύγε σε {n}′', { n: 6 }), 'Leave in 6′');
  assert.equal(t('Γραμμή {code} · {name}', { code: '601', name: 'ΠΑΝΕΠΙΣΤΗΜΙΟΥ' }), 'Line 601 · ΠΑΝΕΠΙΣΤΗΜΙΟΥ'); // names pass through untouched
  assert.equal(tn(1, '{n} γραμμή', '{n} γραμμές'), '1 line');
  assert.equal(tn(3, '{n} γραμμή', '{n} γραμμές'), '3 lines');
  assert.deepEqual(seen, ['en']);
  setLang('en'); // unchanged -> no event
  assert.deepEqual(seen, ['en']);
  off();
  setLang('el');
  assert.deepEqual(seen, ['en']); // unsubscribed
  assert.equal(lang(), 'el');
});

test('setLang rejects unknown values and keeps the current language', () => {
  assert.equal(setLang('fr'), false);
  assert.equal(setLang(null), false);
  assert.equal(lang(), 'el');
});

test('setLang("auto") re-detects from navigator.language', () => {
  setLang('en');
  assert.equal(lang(), 'en');
  assert.equal(setLang('auto'), true);
  assert.equal(getSettings().lang, 'auto');
  assert.equal(lang(), 'el'); // navigator.language is el-GR
  globalThis.navigator = { language: 'en-GB' };
  setLang('el'); setLang('auto');
  assert.equal(lang(), 'en');
  globalThis.navigator = { language: 'el-GR' };
  setLang('auto'); // same pref: no change event, but explicit pick re-resolves on the next change
  setLang('en'); setLang('auto');
  assert.equal(lang(), 'el');
});

test('missing English falls back to Greek (with placeholders) and logs once with ?debug', () => {
  setLang('en');
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  try {
    assert.equal(t('άγνωστο κείμενο {x}', { x: 1 }), 'άγνωστο κείμενο 1');
    assert.equal(warns.length, 0); // no ?debug -> silent
    globalThis.location = { search: '?debug' };
    assert.equal(t('άλλο άγνωστο'), 'άλλο άγνωστο');
    assert.equal(t('άλλο άγνωστο'), 'άλλο άγνωστο');
    assert.equal(warns.length, 1);
    assert.match(warns[0], /άλλο άγνωστο/);
    setLang('el');
    assert.equal(t('τρίτο άγνωστο'), 'τρίτο άγνωστο'); // Greek never warns
    assert.equal(warns.length, 1);
  } finally {
    console.warn = orig;
    delete globalThis.location;
    setLang('el');
  }
});

test('a throwing language listener does not break the others', () => {
  const orig = console.warn; console.warn = () => {};
  const got = [];
  const a = onLangChange(() => { throw new Error('boom'); });
  const b = onLangChange((l) => got.push(l));
  try { setLang('en'); } finally { console.warn = orig; a(); b(); setLang('el'); }
  assert.deepEqual(got, ['en']);
});

// ---- the dictionary itself ----
const ph = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

test('EN: every entry keeps the same {placeholders} as its Greek key and is non-empty', () => {
  assert.ok(EN.size > 100, `only ${EN.size} entries`);
  for (const [el, en] of EN) {
    assert.ok(typeof en === 'string' && en.trim() && en !== el || el === 'LIVE', `bad entry: ${el}`);
    assert.equal(ph(en), ph(el), `placeholder mismatch: ${el}`);
  }
});

test('EN: covers every Greek UI string of settings-view.js and lines-view.js', () => {
  const RAW = new Set(['Ελληνικά']); // language names stay native
  for (const file of ['settings-view.js', 'lines-view.js']) {
    const src = readFileSync(new URL(`../web/js/${file}`, import.meta.url), 'utf8')
      .split('\n').filter((l) => !/^\s*\/\//.test(l)).map((l) => l.replace(/\s\/\/\s.*$/, '')).join('\n');
    const lits = [...src.matchAll(/'((?:[^'\\\n]|\\.)*)'/g)].map((m) => m[1]).filter((s) => /[Α-Ωα-ωάέήίόύώ]/.test(s) && !RAW.has(s));
    assert.ok(lits.length > 20, `${file}: found only ${lits.length} Greek literals`);
    const missing = lits.filter((s) => !EN.has(s));
    assert.deepEqual(missing, [], `${file}: no English for ${JSON.stringify(missing)}`);
  }
});

// The t() / tn / N_ coverage scan (EL<->EN, both directions) lives in scripts/check-i18n.mjs (`npm run check:i18n`, CI).

test('etaTxt / etaSay follow the language', () => {
  setLang('en');
  try {
    assert.equal(etaTxt(0), 'now');
    assert.equal(etaTxt(125 * 60), '2 h 05′');
    assert.equal(etaSay(5 * 60), '5 minutes');
    assert.equal(etaSay(65 * 60), '1 hour and 5 minutes');
  } finally { setLang('el'); }
  assert.equal(etaTxt(125 * 60), '2 ώ 05′');
  assert.equal(etaSay(60), '1 λεπτό');
});
