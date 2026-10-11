import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkI18n, callKeys, literals, htmlLabels } from '../scripts/check-i18n.mjs';

const run = (o) => checkI18n({ pairs: {}, calls: [], used: new Set(), html: [], allow: [], ...o });

test('check-i18n: clean input passes', () => {
  const res = run({ pairs: { 'a.js': [['Πίσω', 'Back'], ['σε {n}′', 'in {n}′'], ['LIVE', 'LIVE']] },
    calls: [{ file: 'x.js', key: 'Πίσω' }], used: new Set(['Πίσω', 'σε {n}′', 'LIVE']), html: ['Πίσω'] });
  assert.deepEqual(Object.values(res).flat(), []);
});

test('check-i18n: reports each category', () => {
  const res = run({
    pairs: { 'a.js': [['Α', 'A'], ['Β {n}', 'B'], ['Γ', ''], ['Δ', 'Δ']], 'b.js': [['Α', 'Other']] },
    calls: [{ file: 'x.js', key: 'Ε' }, { file: 'x.js', key: 'Ε' }], used: new Set(['Α', 'Β {n}', 'Γ']), html: ['Ζ'],
  });
  assert.deepEqual(res.missing, ['x.js: Ε']);
  assert.deepEqual(res.html, ['index.html: Ζ']);
  assert.deepEqual(res.orphan, ['a.js: Δ']);
  assert.equal(res.bad.length, 3); // placeholder, empty, same as key
  assert.equal(res.dupe.length, 1);
});

test('check-i18n: ALLOW silences a gap, and a fixed one is reported as stale', () => {
  const allow = [['missing', 'Ε', 'why'], ['orphan', 'Α', 'why']];
  const res = run({ pairs: { 'a.js': [['Α', 'A']] }, calls: [{ file: 'x.js', key: 'Ε' }], used: new Set(['Α']), allow });
  assert.deepEqual(res.missing, []);
  assert.deepEqual(res.stale, ['orphan: Α']);
});

test('check-i18n: scanners read t/tn/N_ keys, nested template literals and index.html labels', () => {
  const src = [
    "t('Στάση {code}', { code }); tn(n, '{n} γραμμή', \"{n} γραμμές\"); N_('Στο iPhone');",
    "x.t('όχι'); t(name); t('plain'); // t('σχόλιο')",
    "const s = `${t('ώ')} ${n}`; const u = `Κείμενο`;",
  ].join('\n');
  assert.deepEqual(callKeys(src), ['Στάση {code}', '{n} γραμμή', '{n} γραμμές', 'Στο iPhone', 'ώ']);
  const lits = literals(src);
  assert.ok(lits.includes('ώ') && lits.includes('Κείμενο') && !lits.includes('σχόλιο'));
  const html = '<meta content="Περιγραφή"><button aria-label="Μενού" title="x"></button><p>Φόρτωση…</p><noscript>Χωρίς JS</noscript>';
  assert.deepEqual(htmlLabels(html), ['Μενού', 'Φόρτωση…']);
});
