// STUB (owner: i18n). t('Greek source text', {vars}) -> current language; see docs/ARCHITECTURE.md (Round 3).
export const lang = () => 'el';
export function setLang() {}
export const onLangChange = () => () => {};
export function t(s, vars) { return vars ? String(s).replace(/{(w+)}/g, (_, k) => vars[k] ?? '') : String(s); }
