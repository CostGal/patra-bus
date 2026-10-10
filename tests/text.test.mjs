import { test } from 'node:test';
import assert from 'node:assert/strict';
import { titleCase, searchKey } from '../web/js/text.js';
import { ACCENTS } from '../web/js/accents.js';

const stripAll = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLocaleUpperCase('el');
const vowels = (s) => (s.normalize('NFD').match(/[αεηιουω]/gu) || []).length;

test('accents from the dictionary', () => {
  assert.equal(titleCase('ΠΑΝΕΠΙΣΤΗΜΙΟΥ & ΑΡΕΘΑ'), 'Πανεπιστημίου & Αρέθα');
  assert.equal(titleCase('ΑΓΙΟΥ ΝΙΚΟΛΑΟΥ'), 'Αγίου Νικολάου');
  assert.equal(titleCase('ΝΟΣΟΚΟΜΕΙΟ'), 'Νοσοκομείο');
  assert.equal(titleCase('ΠΛΑΤΕΙΑ ΥΨΗΛΩΝ ΑΛΩΝΙΩΝ'), 'Πλατεία Υψηλων Αλωνιων'); // unknown words untouched
});

test('accent on the first letter keeps the tonos capital', () => {
  assert.equal(titleCase('ΑΝΩ ΣΥΧΑΙΝΑ'), 'Άνω Συχαινα');
  assert.equal(titleCase('ΟΒΡΥΑ'), 'Όβρυα');
});

test('unknown, ambiguous, acronyms and Latin words are only re-cased', () => {
  assert.equal(titleCase('ΠΟΤΕ ΟΤΕ ΚΤΕΛ ΤΕΙ'), 'Ποτε Οτε Κτελ Τει');
  assert.equal(titleCase('CARREFOUR PARKING'), 'Carrefour Parking');
  assert.equal(titleCase('ΑΓ. ΑΝΔΡΕΟΥ'), 'Αγ. Ανδρέου');
  assert.equal(titleCase('ΤΑΡΑΜΠΟΥΡΑ'), 'Ταραμπουρα');
});

test('final sigma, also for unknown words', () => {
  assert.equal(titleCase('ΣΟΛΩΜΟΥ ΚΑΛΛΙΘΕΑΣ'), 'Σολωμού Καλλιθέας');
  assert.equal(titleCase('ΤΣΟΥΡΟΣ'), 'Τσουρος');
  assert.equal(titleCase('ΣΩΣΤΟΣ ΑΣΤΡΑΣ'), 'Σωστος Αστρας');
  assert.ok(!/σ(?![\p{L}\p{N}])/u.test(titleCase('ΠΛΑΤΕΙΑ ΒΟΥΝΤΕΝΗΣ ΤΟΥΣ')));
});

test('hyphen and parentheses', () => {
  assert.equal(titleCase('ΚΟΜΒΟΣ-ΒΕΤΑ-ΜΠΕΓΟΥΛΑΚΙ'), 'Κόμβος-Βετα-Μπεγουλάκι');
  assert.equal(titleCase('ΑΦΕΤΗΡΙΑ ΤΑΡΑΜΠΟΥΡΑ (ΝΟΣΟΚΟΜΕΙΟ)'), 'Αφετηρία Ταραμπουρα (Νοσοκομείο)');
});

test('digits and ordinals', () => {
  assert.equal(titleCase('10ο ΛΥΚΕΙΟ'), '10ο Λύκειο');
  assert.equal(titleCase('12ου ΣΥΝΤΑΓΜΑΤΟΣ'), '12ου Συντάγματος');
});

test('diaeresis written as apostrophes', () => {
  assert.equal(titleCase("ΑΧΑ'Ι'ΑΣ"), 'Αχαΐας');
  assert.equal(titleCase("ΡΟ'Ι'ΤΙΚΑ"), 'Ροΐτικα');
  assert.equal(titleCase("ΤΣΟΥΚΑΛΕ'Ι'ΚΑ"), 'Τσουκαλέικα');
  assert.equal(titleCase("ΓΙΑΝΝΗΣ Γ' ΣΧΟΛΕΙΟ"), "Γιάννης Γ' Σχολείο");
  assert.equal(titleCase('ΡΟΪΤΙΚΩΝ'), 'Ροϊτικων');
});

test('already accented or mixed-case input is not touched', () => {
  assert.equal(titleCase('Γούναρη'), 'Γούναρη');
  assert.equal(titleCase('μετάβαση'), 'Μετάβαση');
  assert.equal(titleCase('μεταβαση'), 'Μετάβαση');
  assert.equal(titleCase('Πάτρα'), 'Πάτρα');
});

test('Latin lookalikes inside Greek words fold for lookup only', () => {
  assert.equal(titleCase('ZΑΡΟΥΧΛEIKA'), 'Ζαρουχλέικα');
  assert.equal(titleCase('CLUB'), 'Club');
});

test('whitespace and nullish input', () => {
  assert.equal(titleCase('  ΚΕΝΤΡΟ   ΠΑΤΡΩΝ '), 'Κέντρο Πατρών');
  assert.equal(titleCase(null), '');
  assert.equal(titleCase(undefined), '');
});

test('searchKey stays accent- and case-insensitive', () => {
  assert.equal(searchKey('Πανεπιστημίου & Αρέθα'), 'πανεπιστημιου & αρεθα');
  assert.equal(searchKey('ΠΑΝΕΠΙΣΤΗΜΙΟΥ & ΑΡΕΘΑ'), 'πανεπιστημιου & αρεθα');
  assert.equal(searchKey(titleCase('ΝΟΣΟΚΟΜΕΙΟ ΠΑΤΡΩΝ')), searchKey('ΝΟΣΟΚΟΜΕΙΟ ΠΑΤΡΩΝ'));
  assert.equal(searchKey('Όβρυας'), 'οβρυασ');
  assert.equal(searchKey(null), '');
});

test('dictionary invariants', () => {
  assert.ok(ACCENTS.size > 100);
  for (const [k, v] of ACCENTS) {
    assert.equal(k, k.toLocaleUpperCase('el'), `${k}: key must be uppercase`);
    assert.ok(!/[ΆΈΉΊΌΎΏ]/.test(k.normalize('NFC')), `${k}: key must carry no tonos`);
    assert.equal(stripAll(v), stripAll(k), `${k} → ${v}: strip(value) must equal key`);
    assert.equal(v, v.toLocaleLowerCase('el'), `${k}: value must be lowercase`);
    assert.equal(v, v.normalize('NFC'));
    assert.ok(/^[α-ωάέήίόύώϊΐϋΰς]+$/.test(v), `${k} → ${v}: unexpected characters`);
    if (/[άέήίόύώΐΰ]/.test(v)) assert.ok(vowels(v) > 1, `${k} → ${v}: monosyllable must not be accented`);
    assert.equal((v.match(/[άέήίόύώΐΰ]/g) || []).length <= 1, true, `${k} → ${v}: more than one tonos`);
  }
});

test('every dictionary word applies through titleCase', () => {
  for (const [k, v] of ACCENTS) {
    const out = titleCase(k);
    assert.equal(out.toLocaleLowerCase('el'), v, k);
  }
});

test('titleCase is fast for a stop list', () => {
  const names = Array.from({ length: 1000 }, (_, i) => `ΠΑΝΕΠΙΣΤΗΜΙΟΥ & ΑΡΕΘΑ ${i} ΑΓΙΟΥ ΝΙΚΟΛΑΟΥ ΤΕΡΜΑ`);
  const t = performance.now();
  for (const n of names) titleCase(n);
  assert.ok(performance.now() - t < 200);
});
