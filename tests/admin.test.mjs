import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adminRoute, summarizeCounts, tokenMatches, STATS_HTML } from '../worker/src/admin.js';

const TOKEN = 'test-token-0123456789abcdef';
const NOW = Date.UTC(2026, 9, 25, 12, 0); // 2026-10-25 in Athens

const ROWS = [
  { day: '2026-10-25', metric: 'feedback', city: 'patra', n: 2 },
  { day: '2026-10-22', metric: 'feedback', city: 'patra', n: 1 },
  { day: '2026-10-01', metric: 'feedback', city: 'patra', n: 5 },
  { day: '2026-09-01', metric: 'feedback', city: 'patra', n: 7 },
  { day: '2026-10-25', metric: 'feedback', city: '', n: 1 },
];

// A fake COUNTERS binding whose Durable Object answers GET with ROWS.
const env = (extra = {}) => ({
  STATS_TOKEN: TOKEN,
  COUNTERS: { idFromName: (n) => n, get: () => ({ fetch: async () => new Response(JSON.stringify({ rows: ROWS })) }) },
  ...extra,
});
const get = (path, token) =>
  new Request(`https://w.example${path}`, token === undefined ? {} : { headers: { Authorization: `Bearer ${token}` } });

test('tokenMatches: exact token only', async () => {
  assert.equal(await tokenMatches(TOKEN, TOKEN), true);
  assert.equal(await tokenMatches(`${TOKEN}x`, TOKEN), false);
  assert.equal(await tokenMatches('', TOKEN), false);
  assert.equal(await tokenMatches(TOKEN, ''), false, 'an empty secret never matches');
  assert.equal(await tokenMatches(undefined, TOKEN), false);
});

test('adminRoute: other paths are not handled', async () => {
  assert.equal(await adminRoute(get('/health'), env()), null);
  assert.equal(await adminRoute(get('/api/report'), env()), null);
});

test('adminRoute: /stats is a page with no data and no secret, never cached', async () => {
  const res = await adminRoute(get('/stats'), env());
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Content-Type'), /text\/html/);
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
  const html = await res.text();
  assert.ok(!html.includes(TOKEN));
  assert.ok(!/\?token=|location\.search|URLSearchParams/.test(STATS_HTML), 'the token never travels in a URL');
});

test('adminRoute: counts need the right token (401), then rate limit (429)', async () => {
  assert.equal((await adminRoute(get('/api/admin/counts'), env())).status, 401);
  assert.equal((await adminRoute(get('/api/admin/counts', 'wrong'), env())).status, 401);
  const res = await adminRoute(get('/api/admin/counts', 'wrong'), env(), { limited: () => true });
  assert.equal(res.status, 429);
});

test('adminRoute: the limiter is only asked after a wrong token', async () => {
  let asked = 0;
  await adminRoute(get('/api/admin/counts', TOKEN), env(), { limited: () => { asked++; return true; }, now: NOW });
  assert.equal(asked, 0);
});

test('adminRoute: 503 without the secret or the binding', async () => {
  assert.equal((await adminRoute(get('/api/admin/counts', TOKEN), env({ STATS_TOKEN: undefined }))).status, 503);
  assert.equal((await adminRoute(get('/api/admin/counts', TOKEN), env({ COUNTERS: undefined }))).status, 503);
});

test('adminRoute: right token gives the summary, not cacheable, no CORS', async () => {
  const res = await adminRoute(get('/api/admin/counts', TOKEN), env(), { now: NOW });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
  const d = await res.json();
  assert.equal(d.today, '2026-10-25');
  assert.equal(d.totals.length, 2);
});

test('adminRoute: only GET', async () => {
  const res = await adminRoute(new Request('https://w.example/api/admin/counts', { method: 'POST' }), env());
  assert.equal(res.status, 404);
});

test('summarizeCounts: today, 7 days, 30 days and all time per metric and city', () => {
  const s = summarizeCounts(ROWS, NOW);
  assert.deepEqual(s.totals.map(({ metric, city, today, d7, d30, all }) => ({ metric, city, today, d7, d30, all })), [
    { metric: 'feedback', city: '', today: 1, d7: 1, d30: 1, all: 1 },
    // 10-22 is inside 7 days (from 10-19); 10-01 inside 30 days (from 09-26); 09-01 only in "all".
    { metric: 'feedback', city: 'patra', today: 2, d7: 3, d30: 8, all: 15 },
  ]);
});

test('summarizeCounts: day list keeps only the last 30 days, newest first', () => {
  const s = summarizeCounts(ROWS, NOW);
  assert.deepEqual(s.days.map((r) => r.day), ['2026-10-25', '2026-10-25', '2026-10-22', '2026-10-01']);
});

test('summarizeCounts: days30 is the last 30 Athens days, oldest first, ending today', () => {
  const s = summarizeCounts(ROWS, NOW);
  assert.equal(s.days30.length, 30);
  assert.equal(s.days30[0], '2026-09-26');
  assert.equal(s.days30[29], '2026-10-25');
});

test('summarizeCounts: prev7 is the 7 days before the last 7, and series has a 0 for every missing day', () => {
  const rows = [
    { day: '2026-10-25', metric: 'open', city: 'patra', n: 4 }, // today: d7
    { day: '2026-10-19', metric: 'open', city: 'patra', n: 3 }, // first day of d7
    { day: '2026-10-18', metric: 'open', city: 'patra', n: 2 }, // last day of prev7
    { day: '2026-10-12', metric: 'open', city: 'patra', n: 1 }, // first day of prev7
    { day: '2026-10-11', metric: 'open', city: 'patra', n: 9 }, // before prev7, still in 30 days
    { day: '2026-10-20', metric: 'open', city: 'corfu', n: 5 },
  ];
  const s = summarizeCounts(rows, NOW);
  const patra = s.totals.find((t) => t.metric === 'open' && t.city === 'patra');
  assert.equal(patra.d7, 7);
  assert.equal(patra.prev7, 3);
  assert.equal(patra.d30, 19);
  assert.equal(patra.series.length, 30);
  assert.equal(patra.series[29], 4);
  assert.equal(patra.series[s.days30.indexOf('2026-10-11')], 9);
  assert.equal(patra.series.reduce((a, n) => a + n, 0), 19, 'every other day is 0');
  const corfu = s.totals.find((t) => t.metric === 'open' && t.city === 'corfu');
  assert.deepEqual([corfu.d7, corfu.prev7], [5, 0]);
});

test('summarizeCounts: a city-less row (feedback) gets its own prev7 and series', () => {
  const s = summarizeCounts(ROWS, NOW);
  const none = s.totals.find((t) => t.city === '');
  assert.equal(none.prev7, 0);
  assert.equal(none.series[29], 1);
  const patra = s.totals.find((t) => t.city === 'patra');
  assert.equal(patra.prev7, 0, '10-22 is in d7, 10-01 is before prev7 (from 10-12)');
  assert.equal(patra.series[s.days30.indexOf('2026-10-01')], 5);
});

test('summarizeCounts: the day after the clock goes forward neither skips nor repeats a day', () => {
  // Athens moves to summer time on Sunday 2026-03-29, a 23-hour day. 2026-03-30 00:30 in Athens is 03-29 21:30 UTC.
  const s = summarizeCounts([{ day: '2026-03-24', metric: 'open', city: 'patra', n: 1 }], Date.UTC(2026, 2, 29, 21, 30));
  assert.equal(s.today, '2026-03-30');
  assert.equal(new Set(s.days30).size, 30);
  assert.equal(s.days30[28], '2026-03-29');
  assert.equal(s.days30[23], '2026-03-24');
  assert.equal(s.totals[0].d7, 1, '03-24 is the first day of the last 7');
});

test('STATS_HTML: the inline script parses, has one tab list to extend, hides push', () => {
  const script = STATS_HTML.match(/<script>([\s\S]*)<\/script>/)[1];
  assert.doesNotThrow(() => new Function(script));
  assert.match(script, /const TABS = \[/);
  assert.match(script, /"hidden":\["push"\]/);
});

test('STATS_HTML: English only (Kostas, 2026-11-27), no Greek letters', () => {
  assert.doesNotMatch(STATS_HTML, /[\u0370-\u03ff\u1f00-\u1fff]/);
  assert.match(STATS_HTML, /<html lang="en">/);
});
