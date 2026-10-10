// UI language (owner: i18n). t('Greek source text', { vars }) -> current language; the Greek text IS the key.
// Missing English falls back to Greek (logged once with ?debug). Stop/line names are data, never translated.
import { getSettings, setSetting, onChange } from './store.js';
import { EN } from './i18n-en.js';
import { etaText } from './arrivals.js';

export const LANGS = ['el', 'en'];
export const PREFS = ['auto', 'el', 'en'];

// Pure: the stored preference + navigator.language -> 'el' | 'en'.
export function resolveLang(pref, navLang) {
  if (pref === 'el' || pref === 'en') return pref;
  return String(navLang || '').toLowerCase().startsWith('el') ? 'el' : 'en';
}

const navLang = () => { try { return globalThis.navigator?.language || globalThis.navigator?.languages?.[0] || ''; } catch { return ''; } };
const debugOn = () => { try { return /[?&]debug\b/.test(globalThis.location?.search || ''); } catch { return false; } };

let cur = null;
const subs = new Set();
const missing = new Set();

function compute() { return resolveLang(getSettings().lang, navLang()); }
function paintHtml() { try { if (globalThis.document?.documentElement) globalThis.document.documentElement.lang = cur; } catch { /* ignore */ } }
function refresh() {
  const next = compute();
  if (next === cur) return;
  cur = next; paintHtml();
  for (const fn of [...subs]) { try { fn(cur); } catch (err) { console.warn('[i18n] listener failed', err); } }
}
cur = compute(); paintHtml();
onChange(refresh); // settings change, other tab, "delete all data"

export const lang = () => cur;
export const langPref = () => getSettings().lang;
export const locale = () => (cur === 'en' ? 'en-GB' : 'el-GR');
// 'el' | 'en' | 'auto'. Returns false for anything else.
export function setLang(v) { const ok = setSetting('lang', v); refresh(); return ok; }
export function onLangChange(fn) { subs.add(fn); return () => subs.delete(fn); }

const fill = (s, vars) => (vars ? s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '') : s);

export function t(s, vars) {
  s = String(s);
  let out = s;
  if (cur === 'en') {
    const en = EN.get(s);
    if (en != null) out = en;
    else if (debugOn() && !missing.has(s)) { missing.add(s); console.warn(`[i18n] no English for: ${s}`); }
  }
  return fill(out, vars);
}

// Count + noun: tn(3, '{n} γραμμή', '{n} γραμμές') picks by n === 1 (both forms are keys in EN).
export const tn = (n, one, many) => t(n === 1 ? one : many, { n });
// Minutes in the compact form used everywhere ("5′").
export const fmtMin = (n) => `${n}′`;
// Marks a Greek literal that is translated later with t(variable); the test scan requires an EN entry for it.
export const N_ = (s) => s;

// Display forms of the shared (Greek-only) arrivals.js helpers: compact "7′" / "1 h 05′" and spoken "5 minutes".
export function etaTxt(sec) {
  const s = etaText(sec);
  return s === 'τώρα' ? t('τώρα') : s.replace(' ώ ', ` ${t('ώ')} `);
}
export function etaSay(sec) {
  const s = Number(sec);
  if (!Number.isFinite(s) || s < 15) return t('τώρα');
  if (s < 60) return t('λιγότερο από ένα λεπτό');
  const m = Math.floor(s / 60);
  const min = (n) => tn(n, '{n} λεπτό', '{n} λεπτά');
  if (m < 60) return min(m);
  const hours = tn(Math.floor(m / 60), '{n} ώρα', '{n} ώρες');
  return m % 60 ? t('{hours} και {min}', { hours, min: min(m % 60) }) : hours;
}
