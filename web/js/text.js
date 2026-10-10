// Display + search helpers for Greek stop/route names.
import { ACCENTS } from './accents.js';

// Upstream writes a diaeresis as an inline apostrophe pair: ΑΧΑ'Ι'ΑΣ = ΑΧΑΪΑΣ.
const DIAERESIS = /(?<=\p{L})'([Ιι])'(?=\p{L})/gu;
const WORD = /[\p{L}\p{N}]+/gu;
const HAS_TONOS = /[άέήίόύώΐΰ]/;
// Latin letters that look like Greek ones (upstream mixes them in, e.g. "AΝΘΕΙΑΣ").
const LOOKALIKE = { A: 'Α', B: 'Β', E: 'Ε', H: 'Η', I: 'Ι', K: 'Κ', M: 'Μ', N: 'Ν', O: 'Ο', P: 'Ρ', T: 'Τ', X: 'Χ', Y: 'Υ', Z: 'Ζ' };
const cache = new Map();

function word(w) {
  let hit = cache.get(w);
  if (hit !== undefined) return hit;
  let lower = w.toLocaleLowerCase('el');
  if (!HAS_TONOS.test(lower)) {
    let key = w.toLocaleUpperCase('el');
    // Mixed Greek + Latin: fold lookalikes for the lookup only.
    if (/[A-Z]/.test(key) && /[Α-Ω]/.test(key)) key = key.replace(/[A-Z]/g, (c) => LOOKALIKE[c] ?? c);
    lower = ACCENTS.get(key) ?? lower;
  }
  // Capitalise only a leading letter (not after digits: "10ου"); toUpperCase keeps tonos.
  const first = lower[0];
  hit = (first.toLowerCase() !== first.toUpperCase() ? first.toUpperCase() + lower.slice(1) : lower)
    .replace(/σ$/, 'ς'); // final sigma
  cache.set(w, hit);
  return hit;
}

// Upstream names are uppercase without accents. Case is normalised and accents
// are added only for words in the curated ACCENTS dictionary; everything else
// stays unaccented. "ΠΑΝΕΠΙΣΤΗΜΙΟΥ & ΑΡΕΘΑ" → "Πανεπιστημίου & Αρέθα".
export function titleCase(s) {
  return String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(DIAERESIS, 'Ϊ')
    .replace(WORD, word);
}

// Accent-, case- and ς/σ-insensitive key for matching.
export function searchKey(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase('el')
    .replace(/ς/g, 'σ')
    .replace(/\s+/g, ' ')
    .trim();
}
