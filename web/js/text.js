// Display + search helpers for Greek stop/route names.

// Upstream names are uppercase without accents. We only change case; accents
// are not guessed. "ΠΑΝΕΠΙΣΤΗΜΙΟΥ & ΑΡΕΘΑ" → "Πανεπιστημιου & Αρεθα".
export function titleCase(s) {
  const lower = String(s ?? '').replace(/\s+/g, ' ').trim().toLocaleLowerCase('el');
  let out = '';
  let prevAlnum = false;
  for (const ch of lower) {
    const alnum = /[\p{L}\p{N}]/u.test(ch);
    out += alnum && !prevAlnum ? ch.toLocaleUpperCase('el') : ch;
    prevAlnum = alnum;
  }
  // Final sigma: σ at the end of a word.
  return out.replace(/σ(?![\p{L}\p{N}])/gu, 'ς');
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
