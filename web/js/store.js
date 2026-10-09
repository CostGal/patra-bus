// STUB (owner: extras).
const read = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } };
const subs = new Set(); const emit = () => subs.forEach((f) => f());
export const getFavorites = () => read('favs', []).map(String);
export const isFavorite = (c) => getFavorites().includes(String(c));
export function toggleFavorite(c) { const f = getFavorites(); const on = !f.includes(String(c)); write('favs', on ? [...f, String(c)] : f.filter((x) => x !== String(c))); emit(); return on; }
export const getRecents = (kind) => read(`recents:${kind}`, []);
export function addRecent(kind, item) { write(`recents:${kind}`, [item, ...getRecents(kind)].slice(0, 10)); emit(); }
export const getSettings = () => ({ theme: 'auto', walkSpeed: 'normal', bufferMin: 2, reminderMin: 2, ...read('settings', {}) });
export function setSetting(k, v) { write('settings', { ...read('settings', {}), [k]: v }); emit(); }
export const onChange = (fn) => { subs.add(fn); return () => subs.delete(fn); };
