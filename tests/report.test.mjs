import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cleanText, cleanDiag, validateReport, isHoneypot, collectDiagnostics, buildPayload, sendReport, ReportError, LIMITS } from '../web/js/report.js';
import { notionPage, forwardReport, takeDailySlot, DAILY_MAX, MAX_REPORT_BYTES } from '../worker/src/report.js';
import worker from '../worker/src/index.js';

const read = (f) => readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf8');
const MSG = 'Η στάση 1011 δείχνει λάθος ώρα για τη 601';

// ---- shared validation ----
test('cleanText: strips control chars, normalises newlines, trims, caps blank runs', () => {
  assert.equal(cleanText('  a\u0000b\r\nc\n\n\n\nd\u0007  '), 'ab\nc\n\nd');
  assert.equal(cleanText(null), '');
});

test('validateReport: category, message length and email', () => {
  const ok = validateReport({ category: 'data', message: `  ${MSG}  `, email: ' a@b.gr ', diag: { city: 'patra' } });
  assert.deepEqual(ok, { ok: true, value: { category: 'data', message: MSG, email: 'a@b.gr', diag: { city: 'patra' } } });
  assert.equal(validateReport({ category: 'x', message: MSG }).error, 'category');
  assert.equal(validateReport({ category: 'app', message: 'κοντό' }).error, 'message');
  assert.equal(validateReport({ category: 'app', message: 12345678901 }).error, 'message');
  assert.equal(validateReport({ category: 'app', message: 'x'.repeat(LIMITS.messageMax + 1) }).error, 'message');
  assert.equal(validateReport({ category: 'app', message: 'x'.repeat(LIMITS.messageMax) }).ok, true);
  for (const bad of ['nope', 'a@b', '@b.gr', 'a b@c.gr', 42, 'a@b.gr'.padStart(300, 'x')]) {
    assert.equal(validateReport({ category: 'app', message: MSG, email: bad }).error, 'email', String(bad));
  }
  assert.equal('email' in validateReport({ category: 'app', message: MSG, email: '' }).value, false); // empty = no email
  assert.equal(validateReport(null).error, 'body');
  assert.equal(validateReport([]).error, 'body');
});

test('cleanDiag: whitelist only, wrong shapes dropped, nothing free-form survives', () => {
  const d = cleanDiag({
    v: '2.0.0', city: 'corfu', lang: 'en', view: 'stop', ref: '0015', os: 'ios', browser: 'safari', mode: 'app', vw: 390, vh: 700,
    online: true, theme: 'dark', sw: false, demo: false,
    lat: 38.2, userAgent: 'Mozilla/5.0', ip: '1.2.3.4', query: 'lat=38.2&lng=21.7',
  });
  assert.deepEqual(Object.keys(d).sort(), ['browser', 'city', 'demo', 'lang', 'mode', 'online', 'os', 'ref', 'sw', 'theme', 'v', 'vh', 'view', 'vw']);
  assert.deepEqual(cleanDiag({ city: 'Patra!', view: 'stop?lat=1', ref: '38.2,21.7', vw: 1.5, vh: -1, online: 'yes', os: 'windows' }), {});
  assert.deepEqual(cleanDiag('x'), {});
  assert.deepEqual(cleanDiag([1]), {});
  assert.deepEqual(cleanDiag(undefined), {});
});

test('collectDiagnostics: from plain inputs, empty context is left out', () => {
  const d = collectDiagnostics({
    version: '2.0.0', city: 'patra', lang: 'el', context: { view: 'home', ref: '' }, platform: { os: 'android', mode: 'browser', browser: 'chrome', canPrompt: true },
    viewport: { w: 411.4, h: 800 }, online: true, theme: 'auto', sw: true, demo: false,
  });
  assert.deepEqual(d, { v: '2.0.0', city: 'patra', lang: 'el', view: 'home', os: 'android', browser: 'chrome', mode: 'browser', vw: 411, vh: 800, online: true, theme: 'auto', sw: true, demo: false });
  assert.deepEqual(collectDiagnostics({}), {});
});

test('buildPayload / isHoneypot', () => {
  const p = buildPayload({ category: 'idea', message: MSG, email: '  ', hp: '', diag: { city: 'patra', x: 1 } });
  assert.deepEqual(p, { category: 'idea', message: MSG, email: undefined, hp: '', diag: { city: 'patra' } });
  assert.equal(isHoneypot(p), false);
  assert.equal(isHoneypot({ ...p, hp: 'http://spam' }), true);
  assert.equal(isHoneypot({ ...p, hp: 5 }), false);
  assert.equal(isHoneypot(null), false);
});

test('sendReport: posts JSON to /api/report and maps failures to kinds', async () => {
  const calls = [];
  const mk = (status) => async (url, init) => { calls.push([url, init]); return { ok: status < 300, status }; };
  assert.equal(await sendReport({ a: 1 }, { fetch: mk(200), apiBase: 'https://w.test' }), true);
  assert.equal(calls[0][0], 'https://w.test/api/report');
  assert.equal(calls[0][1].method, 'POST');
  assert.equal(calls[0][1].headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0][1].body), { a: 1 });
  for (const [status, kind] of [[429, 'rate'], [503, 'unavailable'], [400, 'invalid'], [413, 'invalid'], [502, 'server'], [500, 'server']]) {
    await assert.rejects(sendReport({}, { fetch: mk(status), apiBase: '' }), (e) => e instanceof ReportError && e.kind === kind && e.status === status, String(status));
  }
  await assert.rejects(sendReport({}, { fetch: async () => { throw new TypeError('offline'); }, apiBase: '' }), (e) => e.kind === 'network');
  await assert.rejects(sendReport({}, { fetch: (u, i) => new Promise((_, rej) => i.signal.addEventListener('abort', () => rej(Object.assign(new Error('x'), { name: 'AbortError' })))), apiBase: '', timeoutMs: 10 }), (e) => e.kind === 'timeout');
});

// ---- Notion payload ----
test('notionPage: schema, title, diagnostics block, email only when given', () => {
  const v = { category: 'data', message: `${MSG}\nδεύτερη γραμμή`, email: 'a@b.gr', diag: { city: 'corfu', v: '2.0.0' } };
  const page = notionPage(v, { dbId: 'DB1', now: Date.UTC(2026, 9, 11, 12, 0, 0) });
  assert.equal(page.parent.database_id, 'DB1');
  assert.equal(page.properties.Name.title[0].text.content, `Data: ${MSG}`);
  assert.deepEqual(page.properties.Category, { select: { name: 'Data' } });
  assert.deepEqual(page.properties.Status, { select: { name: 'New' } });
  assert.deepEqual(page.properties.City, { select: { name: 'corfu' } });
  assert.deepEqual(page.properties.Email, { email: 'a@b.gr' });
  assert.equal(page.properties.Received.date.start, '2026-10-11T12:00:00.000Z');
  assert.equal(page.children[0].paragraph.rich_text[0].text.content, v.message);
  assert.deepEqual(JSON.parse(page.children[2].code.rich_text[0].text.content), v.diag);
  const pv = notionPage(v, { dbId: 'DB1', now: 0, preview: true });
  assert.equal(pv.properties.Name.title[0].text.content, `[preview] Data: ${MSG}`);
  const bare = notionPage({ category: 'idea', message: 'x'.repeat(200), diag: {} }, { dbId: 'DB1', now: 0 });
  assert.equal('Email' in bare.properties, false);
  assert.equal('City' in bare.properties, false);
  assert.ok(Array.from(bare.properties.Name.title[0].text.content).length <= 'Suggestion: '.length + 70);
  assert.ok(bare.properties.Name.title[0].text.content.endsWith('…'));
});

test('forwardReport: Notion headers and body; failures carry the status only', async () => {
  const seen = [];
  await forwardReport({ NOTION_TOKEN: 'secret_x', NOTION_DB_ID: 'DB1' }, { category: 'app', message: MSG, diag: {} }, 0, async (url, init) => { seen.push([url, init]); return { ok: true }; });
  assert.equal(seen[0][0], 'https://api.notion.com/v1/pages');
  assert.equal(seen[0][1].headers.Authorization, 'Bearer secret_x');
  assert.equal(seen[0][1].headers['Notion-Version'], '2022-06-28');
  await assert.rejects(forwardReport({}, { category: 'app', message: MSG, diag: {} }, 0, async () => ({ ok: false, status: 429 })), (e) => e.status === 429 && !e.message.includes(MSG));
  await assert.rejects(forwardReport({}, { category: 'app', message: MSG, diag: {} }, 0, async () => { throw new Error('boom'); }), (e) => e.status === 0);
});

test('takeDailySlot: counts per UTC day, stops at the cap, fails open when KV is down', async () => {
  const store = new Map();
  const KV = { get: async (k) => store.get(k) ?? null, put: async (k, v) => { store.set(k, v); } };
  const day = Date.UTC(2026, 9, 11, 23, 59);
  for (let i = 0; i < DAILY_MAX; i++) assert.equal(await takeDailySlot({ KV }, day), true);
  assert.equal(await takeDailySlot({ KV }, day), false);
  assert.equal(await takeDailySlot({ KV }, day + 120000), true); // next UTC day
  assert.equal(await takeDailySlot({ KV: { get: async () => { throw new Error('down'); } } }, day), true);
});

// ---- the route ----
const ORIGIN = 'https://costgal.github.io';
let ipN = 0;
function setup(over = {}) {
  const forwarded = [];
  const kv = new Map();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { forwarded.push([String(url), init]); return over.notion ? over.notion() : new Response('{}', { status: 200 }); };
  const env = {
    ALLOWED_ORIGIN: `${ORIGIN},http://localhost:8080`, NOTION_TOKEN: 'secret_x', NOTION_DB_ID: 'DB1',
    KV: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); } }, ...over.env,
  };
  const ip = `203.0.113.${++ipN}`;
  const post = (body, headers = {}) => worker.fetch(new Request('https://w.test/api/report', {
    method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'CF-Connecting-IP': ip, ...headers },
  }), env, { waitUntil() {} });
  return { env, forwarded, kv, post, restore: () => { globalThis.fetch = realFetch; } };
}
const good = { category: 'data', message: MSG, hp: '', diag: { city: 'patra', view: 'stop', ref: '1011' } };

test('POST /api/report: a report from a preview origin is tagged [preview] in Notion', async () => {
  const PREVIEW = 'https://alice-ux.patra-bus.pages.dev';
  const s = setup({ env: { ALLOWED_ORIGIN: `${ORIGIN},https://*.patra-bus.pages.dev` } });
  try {
    const res = await s.post(good, { Origin: PREVIEW });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), PREVIEW);
    assert.ok(JSON.parse(s.forwarded[0][1].body).properties.Name.title[0].text.content.startsWith('[preview] '));
    const prod = await s.post(good);
    assert.equal(prod.status, 200);
    assert.ok(!JSON.parse(s.forwarded[1][1].body).properties.Name.title[0].text.content.startsWith('[preview]'));
    assert.equal((await s.post(good, { Origin: 'https://evil.pages.dev' })).status, 403);
  } finally { s.restore(); }
});

test('POST /api/report: valid report is forwarded to Notion, nothing identifying goes along', async () => {
  const s = setup();
  try {
    const res = await s.post({ ...good, email: 'me@example.gr' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(s.forwarded.length, 1);
    const out = s.forwarded[0][1].body;
    assert.ok(out.includes(MSG) && out.includes('me@example.gr'));
    assert.ok(!out.includes('203.0.113'), 'the caller IP must not be forwarded');
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
    assert.equal([...s.kv.keys()].length, 1); // only the daily counter
  } finally { s.restore(); }
});

test('POST /api/report: honeypot answers like a success and forwards nothing', async () => {
  const s = setup();
  try {
    const res = await s.post({ ...good, hp: 'http://spam.example' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(s.forwarded.length, 0);
    assert.equal(s.kv.size, 0);
  } finally { s.restore(); }
});

test('POST /api/report: rate limit is 3 per client, then 429 with Retry-After', async () => {
  const s = setup();
  try {
    for (let i = 0; i < 3; i++) assert.equal((await s.post(good)).status, 200);
    const res = await s.post(good);
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('Retry-After'), '600');
    assert.equal(s.forwarded.length, 3);
  } finally { s.restore(); }
});

test('POST /api/report: honeypot hits count against the limit too', async () => {
  const s = setup();
  try {
    for (let i = 0; i < 3; i++) await s.post({ ...good, hp: 'x' });
    assert.equal((await s.post(good)).status, 429);
  } finally { s.restore(); }
});

test('POST /api/report: daily cap stops the flood across clients', async () => {
  const s = setup();
  try {
    s.kv.set(`report-day/${new Date().toISOString().slice(0, 10)}`, String(DAILY_MAX));
    const res = await s.post(good);
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('Retry-After'), '3600');
    assert.equal(s.forwarded.length, 0);
  } finally { s.restore(); }
});

test('POST /api/report: refusals (config, origin, content type, size, json, fields)', async () => {
  const s = setup();
  let n = 0;
  const post = (body, headers = {}) => s.post(body, { 'CF-Connecting-IP': `198.51.100.${++n}`, ...headers }); // fresh client each time: no rate limit here
  try {
    assert.equal((await post(good, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await post(good, { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await post('{nope')).status, 400);
    assert.equal((await post({ ...good, message: 'κοντό' })).status, 400);
    assert.deepEqual(await (await post({ ...good, category: 'zzz' })).json(), { error: 'bad_request', field: 'category' });
    assert.deepEqual(await (await post({ ...good, email: 'nope' })).json(), { error: 'bad_request', field: 'email' });
    assert.equal((await post({ ...good, message: 'α'.repeat(MAX_REPORT_BYTES) })).status, 413);
    assert.equal(s.forwarded.length, 0);
    assert.equal((await post(good, { Origin: '' })).status, 200); // no Origin (non-browser client) is allowed; the limits cover it
  } finally { s.restore(); }
  const noCfg = setup({ env: { NOTION_TOKEN: undefined } });
  try {
    assert.equal((await noCfg.post(good)).status, 503);
    assert.equal(noCfg.forwarded.length, 0);
  } finally { noCfg.restore(); }
});

test('POST /api/report: Notion failure is a 502 and never echoes the report or the token', async () => {
  const s = setup({ notion: () => new Response('{"message":"nope"}', { status: 400 }) });
  const log = console.error; let logged = '';
  console.error = (...a) => { logged += a.join(' '); };
  try {
    const res = await s.post(good);
    assert.equal(res.status, 502);
    const body = await res.text();
    assert.equal(body, '{"error":"forward_failed"}');
    assert.ok(!logged.includes(MSG) && !logged.includes('secret_x'), logged);
  } finally { console.error = log; s.restore(); }
});

test('/api/report: GET is 404, preflight allows POST + Content-Type', async () => {
  const s = setup();
  try {
    const get = await worker.fetch(new Request('https://w.test/api/report'), s.env, { waitUntil() {} });
    assert.equal(get.status, 404);
    const pre = await worker.fetch(new Request('https://w.test/api/report', { method: 'OPTIONS', headers: { Origin: ORIGIN } }), s.env, {});
    assert.equal(pre.status, 204);
    assert.match(pre.headers.get('Access-Control-Allow-Methods'), /POST/);
    const other = await worker.fetch(new Request('https://w.test/api/report', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }), s.env, {});
    assert.equal(other.headers.get('Access-Control-Allow-Origin'), ORIGIN); // not echoed to the other site: its browser blocks the call
  } finally { s.restore(); }
});

// ---- wiring in the app ----
test('app wiring: bug icon in the menu above settings, full-height route, shell files precached and linked', () => {
  const app = read('js/app.js');
  assert.match(app, /item\('#\/report', 'bug', t\('Αναφορά προβλήματος'\)\)/);
  assert.ok(app.indexOf("item('#/report'") > app.indexOf("item('#/guide'") && app.indexOf("item('#/report'") < app.indexOf("item('#/settings'"));
  assert.match(app, /SNAP = \{[^}]*report: 'full'/);
  assert.match(app, /case 'report':/);
  assert.match(app, /mountReport\(content, ctx, \{ context: reportCtx \}\)/);
  assert.match(read('js/ui.js'), /^\s*bug: '/m);
  const sw = read('sw.js');
  for (const f of ['js/report.js', 'js/report-view.js', 'js/i18n-en-report.js', 'css/report.css']) assert.ok(sw.includes(`'${f}'`), `${f} missing from SHELL`);
  assert.ok(!sw.includes("'patra-bus-v15'"), 'CACHE must be bumped');
  assert.ok(read('index.html').includes('href="css/report.css"'));
});

test('report view: honeypot and the diagnostics preview are in the form, the view uses only the shared pure module for logic', () => {
  const src = read('js/report-view.js');
  assert.match(src, /name: 'contact_me_by_fax_only'/);
  assert.match(src, /hp: trap\.value/);
  assert.match(src, /JSON\.stringify\(diag, null, 1\)/);
  assert.doesNotMatch(src, /location\.(hash|search|href)|geolocation|userAgent/, 'no URL, location or UA may reach the report');
});
