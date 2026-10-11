// Problem reports: shared by the frontend (pre-check, payload, transport) and the Worker (the real validation).
// Pure and DOM-free; the Worker imports it, so it must not import anything that touches the browser.
// Only what the user typed (category, text, optional email) plus the coarse diagnostics below is ever sent. Contract: docs/ARCHITECTURE.md.

export const CATEGORIES = ['data', 'app', 'idea', 'other'];
export const LIMITS = { messageMin: 10, messageMax: 2000, emailMax: 254 };
export const SEND_MS = 10000;

const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Text typed by the user: no control characters, \n only, no runs of blank lines, trimmed.
export function cleanText(s) {
  return String(s ?? '').replace(/\r\n?/g, '\n').replace(CTRL, '').replace(/\n{3,}/g, '\n\n').trim();
}

const int = (min, max) => (v) => Number.isInteger(v) && v >= min && v <= max;
const re = (rx) => (v) => typeof v === 'string' && rx.test(v);
const bool = (v) => typeof v === 'boolean';
// The whitelist of diagnostics. Every value is a short token or a number: nothing free-form, nothing that identifies a person.
// `view`/`ref` are only the screen name and a public stop/line code (never the query, so never coordinates).
const DIAG = {
  v: re(/^[\w.-]{1,16}$/),
  city: re(/^[a-z]{1,12}$/),
  lang: re(/^(el|en)$/),
  view: re(/^[a-z-]{1,16}$/),
  ref: re(/^[\w-]{1,12}$/),
  os: re(/^(ios|android|other)$/),
  browser: re(/^[a-z]{1,12}$/),
  mode: re(/^(app|browser)$/),
  vw: int(0, 20000),
  vh: int(0, 20000),
  online: bool,
  theme: re(/^(auto|light|dark)$/),
  sw: bool,
  demo: bool,
};

// Anything not on the whitelist, or of the wrong shape, is dropped (diagnostics are best effort and never fail a report).
export function cleanDiag(raw) {
  const out = {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, ok] of Object.entries(DIAG)) if (ok(raw[k])) out[k] = raw[k];
  return out;
}

// -> { ok: true, value: { category, message, email?, diag } } | { ok: false, error: field }.
export function validateReport(raw) {
  const bad = (error) => ({ ok: false, error });
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return bad('body');
  if (!CATEGORIES.includes(raw.category)) return bad('category');
  if (typeof raw.message !== 'string') return bad('message');
  const message = cleanText(raw.message);
  if (message.length < LIMITS.messageMin) return bad('message');
  if (message.length > LIMITS.messageMax) return bad('message');
  const value = { category: raw.category, message, diag: cleanDiag(raw.diag) };
  if (raw.email != null && raw.email !== '') {
    const email = typeof raw.email === 'string' ? raw.email.trim() : '';
    if (email.length > LIMITS.emailMax || !EMAIL.test(email)) return bad('email');
    value.email = email;
  }
  return { ok: true, value };
}

// Honeypot: a field no person sees. Anything in it means a script filled the form.
export const isHoneypot = (raw) => raw !== null && typeof raw === 'object' && typeof raw.hp === 'string' && raw.hp !== '';

// Coarse, non-identifying facts about the app. `i` is read from the real environment by the view (tests pass plain values).
export function collectDiagnostics(i = {}) {
  const p = i.platform || {};
  return cleanDiag({
    v: i.version, city: i.city, lang: i.lang, view: i.context?.view || undefined, ref: i.context?.ref || undefined,
    os: p.os, browser: p.browser, mode: p.mode,
    vw: Math.round(Number(i.viewport?.w)), vh: Math.round(Number(i.viewport?.h)),
    online: i.online, theme: i.theme, sw: i.sw, demo: i.demo,
  });
}

export const buildPayload = ({ category, message, email, hp, diag }) => ({
  category, message: String(message ?? ''), email: String(email ?? '').trim() || undefined, hp: String(hp ?? ''), diag: cleanDiag(diag),
});

// kind: 'network' | 'timeout' | 'rate' | 'unavailable' | 'invalid' | 'server'
export class ReportError extends Error {
  constructor(kind, status) {
    super(kind);
    this.name = 'ReportError';
    this.kind = kind;
    if (status != null) this.status = status;
  }
}

const KIND = { 429: 'rate', 503: 'unavailable', 400: 'invalid', 413: 'invalid', 415: 'invalid' };

// POST /api/report. `o` overrides the environment (tests): fetch, apiBase, timeoutMs.
export async function sendReport(payload, o = {}) {
  const doFetch = o.fetch ?? ((...a) => globalThis.fetch(...a));
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), o.timeoutMs ?? SEND_MS) : 0;
  let res;
  try {
    res = await doFetch(`${o.apiBase}/api/report`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: ctl?.signal, cache: 'no-store',
    });
  } catch (err) {
    throw new ReportError(err?.name === 'AbortError' ? 'timeout' : 'network');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new ReportError(KIND[res.status] || 'server', res.status);
  return true;
}
