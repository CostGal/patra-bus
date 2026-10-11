// i18n coverage: Greek keys used in web/ <-> English in web/js/i18n-en*.js. `npm run check:i18n`, exits 1 on any gap.
//  1. EL->EN: every Greek literal passed to t() / tn() / N_() in web/js, and every Greek label in index.html, has English.
//  2. EN->EL: every English entry's Greek key still appears as a string literal in web/ code (no orphans).
//  3. Entries: English non-empty and != key, same {placeholders}, no key defined twice with different English.
// Not keyed, Greek only by design: arrivals.js (shared with the worker), accents.js (data), <meta>/<noscript> in
// index.html, manifest.webmanifest, the fallback body in sw-push.js (service worker, no i18n there).
import { readFileSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const GREEK = /[\u0370-\u03ff\u1f00-\u1fff]/;
const SAME_OK = new Set(['LIVE']); // English == Greek key on purpose
const ph = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

// Reviewed gaps that do not fail the check: [category, key, why]. Categories: missing, orphan, html.
// The 'missing' ones were never caught by tests/i18n.test.mjs: its literal regex skips strings containing a Latin "n".
export const ALLOW = [
  // index.html fallback; sheet.js replaces it with 'Αλλαγή μεγέθους πίνακα (τώρα: {state})' on the first snap.
  ['html', 'Αλλαγή μεγέθους πίνακα', 'replaced at runtime by a keyed label'],
  // planner-view.js screen-reader count after a search: no English yet (shows Greek in English UI).
  ['missing', 'Βρέθηκε {n} επιλογή διαδρομής', 'TODO: add English'],
  ['missing', 'Βρέθηκαν {n} επιλογές διαδρομής', 'TODO: add English'],
  // push.js / routines.js iOS "install first" hints: no English yet.
  ['missing', 'Στο iPhone και στο iPad οι ειδοποιήσεις λειτουργούν μόνο από την εγκατεστημένη εφαρμογή. Πάτα «Κοινοποίηση» και μετά «Προσθήκη στην οικ. οθόνη», άνοιξε την εφαρμογή από την οθόνη σου και γύρνα εδώ για να τις ενεργοποιήσεις.', 'TODO: add English'],
  ['missing', 'Στο iPhone και στο iPad χρειάζεται η εγκατεστημένη εφαρμογή (Κοινοποίηση → Προσθήκη στην οικ. οθόνη).', 'TODO: add English'],
  // Only tests/i18n.test.mjs calls t() with it (placeholder fill in Greek); the UI uses 'σε {when}'.
  ['orphan', 'σε {n}′', 'test-only key'],
  // Dead since the v2/round-3 UI rework: nothing in web/ uses them any more.
  ['orphan', 'Θέση σε πραγματικό χρόνο', 'TODO: delete from i18n-en.js'],
  ['orphan', 'Ώρα προγράμματος, μπορεί να μην τηρηθεί', 'TODO: delete from i18n-en.js'],
  ['orphan', 'Γραμμές που περνούν', 'TODO: delete from i18n-en.js'],
];

// Pure. pairs: { file: [[el, en], ...] }; calls: [{ file, key }]; used: Set of string literals in code;
// html: [Greek label in index.html]. Returns the grouped problems (empty arrays = pass).
export function checkI18n({ pairs, calls, used, html = [], allow = ALLOW }) {
  const hit = new Set();
  const ok = (cat, key) => { const a = allow.find(([c, k]) => c === cat && k === key); if (a) hit.add(a); return !!a; };
  const en = new Map();
  const out = { missing: [], orphan: [], html: [], bad: [], dupe: [], stale: [] };
  for (const [file, list] of Object.entries(pairs)) {
    for (const [el, tr] of list) {
      const prev = en.get(el);
      if (prev && prev.tr !== tr) out.dupe.push(`${el}  (${prev.file}: ${prev.tr} | ${file}: ${tr})`);
      if (!prev) en.set(el, { tr, file });
      if (typeof tr !== 'string' || !tr.trim()) out.bad.push(`${file}: empty English for ${el}`);
      else if (tr === el && !SAME_OK.has(el)) out.bad.push(`${file}: English same as key: ${el}`);
      else if (ph(tr) !== ph(el)) out.bad.push(`${file}: placeholders {${ph(el)}} vs {${ph(tr)}}: ${el}`);
    }
  }
  for (const { file, key } of calls) if (!en.has(key) && !ok('missing', key)) out.missing.push(`${file}: ${key}`);
  for (const key of html) if (!en.has(key) && !ok('html', key)) out.html.push(`index.html: ${key}`);
  for (const [el, { file }] of en) if (!used.has(el) && !ok('orphan', el)) out.orphan.push(`${file}: ${el}`);
  out.missing = [...new Set(out.missing)];
  for (const a of allow) if (!hit.has(a)) out.stale.push(`${a[0]}: ${a[1]}`); // fixed: drop it from ALLOW
  return out;
}

// ---- reading web/ ----
const WEB = new URL('../web/', import.meta.url);
const JS = new URL('js/', WEB);
const DICT = /^i18n-en.*\.js$/;
const NOT_KEYED = new Set(['arrivals.js', 'accents.js']);

// String literals ('…', "…", `…`), comments dropped the same way tests/i18n.test.mjs does.
const LIT = String.raw`'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|\x60(?:\\.|[^\x60\\])*\x60`;
const unquote = (l) => (l.includes('\\') ? new Function(`return ${l}`)() : l.slice(1, -1));
const strip = (src) => src.split('\n').filter((l) => !/^\s*(\/\/|\/?\*)/.test(l)).map((l) => l.replace(/\s\/\/\s.*$/, '')).join('\n');
// A template with ${…} is not a literal itself, but the strings inside its expressions are (`${t('ώ')}`).
const scan = (s) => [...s.matchAll(new RegExp(LIT, 'g'))].flatMap(([l]) => (l.includes('${') ? scan(l.slice(1, -1)) : [unquote(l)]));
export const literals = (src) => scan(strip(src));

const CALL = new RegExp(String.raw`(?<![\w.$])(?:(?:t|N_)\(\s*(${LIT})|tn\(\s*[^,]+,\s*(${LIT})\s*,\s*(${LIT}))`, 'g');
export function callKeys(src) {
  const keys = [];
  for (const m of strip(src).matchAll(CALL)) {
    for (const l of m.slice(1).filter(Boolean)) {
      // A template with ${} can't be checked statically: keep it verbatim so it shows up as missing.
      const k = l.includes('${') ? l : unquote(l);
      if (GREEK.test(k)) keys.push(k);
    }
  }
  return keys;
}

// Greek attribute values and text in index.html, minus <meta> and <noscript> (static, Greek only).
export function htmlLabels(src) {
  src = src.replace(/<meta\b[^>]*>|<noscript>[\s\S]*?<\/noscript>|<!--[\s\S]*?-->/g, '');
  const vals = [...src.matchAll(/\s[\w-]+="([^"]*)"/g)].map((m) => m[1]);
  const text = [...src.replace(/<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>/g, '').matchAll(/>([^<]+)</g)].map((m) => m[1].trim());
  return [...new Set([...vals, ...text].filter((s) => GREEK.test(s)))];
}

async function load() {
  const read = (u) => readFileSync(u, 'utf8');
  const files = readdirSync(JS).filter((f) => f.endsWith('.js')).sort();
  // Per-file pairs for duplicate detection; i18n-en.js keeps its own PAIRS private, so read that array literal.
  const main = read(new URL('i18n-en.js', JS)).match(/\nconst PAIRS = (\[[\s\S]*?\n\]);/);
  if (!main) throw new Error('check-i18n: PAIRS not found in i18n-en.js');
  const pairs = { 'i18n-en.js': new Function(`return ${main[1]}`)() };
  for (const f of files.filter((f) => DICT.test(f) && f !== 'i18n-en.js')) pairs[f] = (await import(new URL(f, JS).href)).PAIRS;
  // Sanity: the pieces, in i18n-en.js merge order, must rebuild the app's EN map, else this reads the wrong thing.
  const { EN } = await import(new URL('i18n-en.js', JS).href);
  const rebuilt = new Map(Object.values(pairs).flat());
  if (rebuilt.size !== EN.size || [...EN].some(([k, v]) => rebuilt.get(k) !== v)) throw new Error('check-i18n: PAIRS files do not add up to EN');

  const calls = [];
  const used = new Set();
  for (const f of files.filter((f) => !DICT.test(f) && f !== 'accents.js')) {
    const src = read(new URL(f, JS));
    for (const l of literals(src)) used.add(l);
    if (!NOT_KEYED.has(f)) for (const key of callKeys(src)) calls.push({ file: f, key });
  }
  for (const l of literals(read(new URL('sw-push.js', WEB)))) used.add(l);
  return { pairs, calls, used, html: htmlLabels(read(new URL('index.html', WEB))), size: EN.size };
}

const TITLES = {
  missing: 'EL->EN: Greek key passed to t()/tn()/N_() has no English',
  html: 'EL->EN: Greek label in index.html is not an EN key',
  orphan: 'EN->EL: English entry whose Greek key is not used anywhere in web/',
  bad: 'EN: empty English, same as key, or {placeholder} mismatch',
  dupe: 'EN: Greek key defined twice with different English',
  stale: 'ALLOW entry no longer needed (remove it from scripts/check-i18n.mjs)',
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const input = await load();
  const res = checkI18n(input);
  const n = Object.values(res).reduce((a, l) => a + l.length, 0);
  for (const [k, list] of Object.entries(res)) {
    if (!list.length) continue;
    console.log(`\n${TITLES[k]} (${list.length}):`);
    for (const s of list) console.log(`  - ${s}`);
  }
  console.log(`\ni18n: ${input.size} EN entries, ${input.calls.length} keyed calls, ${input.html.length} index.html labels, ${ALLOW.length} allowed; ${n ? `${n} problem(s)` : 'OK'}`);
  process.exitCode = n ? 1 : 0;
}
