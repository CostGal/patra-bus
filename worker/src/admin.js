// Private stats page for the anonymous counters (counters.js). Two routes:
//   GET /stats              -> a static HTML page with a password field; holds no data and no secret.
//   GET /api/admin/counts   -> the counters, only with `Authorization: Bearer <STATS_TOKEN>`.
// STATS_TOKEN is a Cloudflare secret (worker/.dev.vars locally), never in the repo. The token never goes in a URL, and
// neither response is cacheable or readable by another site (no Access-Control-Allow-Origin).
import { readCounts, athensDay, METRICS } from './counters.js';
import { CITIES } from '../../web/js/cities.js';

// SHA-256 both sides, then compare every byte: the time taken does not depend on how much of the token was right.
export async function tokenMatches(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || !expected) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([given, expected].map((s) => crypto.subtle.digest('SHA-256', enc.encode(s))));
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

const bearer = (request) => (request.headers.get('Authorization') || '').match(/^Bearer (.+)$/)?.[1] ?? '';

// 'YYYY-MM-DD' moved by k calendar days. Counting on the date itself, not in milliseconds, keeps a 23- or 25-hour day
// (the clock change in Athens) from skipping or repeating a day.
const shiftDay = (day, k) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + k);
  return d.toISOString().slice(0, 10);
};

// rows [{ day, metric, city, n }] -> {
//   today,
//   days30: the last 30 days, oldest first (today is the last one),
//   totals: [{ metric, city, today, d7, prev7, d30, all, series }]: d7 = the last 7 days with today, prev7 = the 7 days
//     before those, series = one number per day of days30 (0 for a day with no row),
//   days: [{ day, metric, city, n }] (rows of the last 30 days, newest first) }.
// Everything is worked out from the same rows; nothing new is counted.
export function summarizeCounts(rows, now) {
  const today = athensDay(now);
  const days30 = Array.from({ length: 30 }, (_, i) => shiftDay(today, i - 29));
  const from7 = days30[23];
  const from14 = shiftDay(today, -13);
  const from30 = days30[0];
  const totals = new Map();
  for (const r of rows) {
    const key = `${r.metric}|${r.city}`;
    const t = totals.get(key) || { metric: r.metric, city: r.city, today: 0, d7: 0, prev7: 0, d30: 0, all: 0, series: days30.map(() => 0) };
    t.all += r.n;
    if (r.day >= from30) t.d30 += r.n;
    if (r.day >= from7) t.d7 += r.n;
    else if (r.day >= from14) t.prev7 += r.n;
    const i = days30.indexOf(r.day);
    if (i >= 0) t.series[i] += r.n;
    if (r.day === today) t.today += r.n;
    totals.set(key, t);
  }
  const order = (a, b) => METRICS.indexOf(a.metric) - METRICS.indexOf(b.metric) || a.city.localeCompare(b.city);
  const days = rows.filter((r) => r.day >= from30).sort((a, b) => b.day.localeCompare(a.day) || order(a, b));
  return { today, days30, totals: [...totals.values()].sort(order), days };
}

// What the page shows for each metric. `meaning` is the one line under a headline number. A metric that is not here
// (a new one before its labels are added) still shows, under its code. `push` is on the whitelist but nothing records
// it, so the page hides it.
const LABELS = {
  metric: { feedback: 'Feedback', open: 'Opens', install: 'Installs', push: 'Push' },
  meaning: {
    open: 'Devices that opened the app, once a day each; a device used every day counts 7 times.',
    install: 'First launch as an installed app, once per device.',
    feedback: 'Problem reports sent from the form.',
  },
  order: ['open', 'install', 'feedback'],
  hidden: ['push'],
  cities: Object.values(CITIES).map((c) => c.id),
  city: { '': 'No city', ...Object.fromEntries(Object.values(CITIES).map((c) => [c.id, c.name.en])) },
};

// The inline script uses no template literals and no backslashes, so this outer template keeps it as written.
export const STATS_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>patra-bus stats</title>
<style>
  :root {
    color-scheme: light dark; font: 15px/1.4 system-ui, sans-serif;
    --bg: #f6f6f8; --card: #fff; --fg: #1c1c1e; --muted: #6c6c70; --line: #d8d8dc;
    --bar: #9db8e8; --bar-today: #2f6fde; --bar-zero: #d8d8dc; --err: #c33;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #000; --card: #1c1c1e; --fg: #f2f2f7; --muted: #a0a0a8; --line: #3a3a3c;
      --bar: #3d5f99; --bar-today: #6fa1ff; --bar-zero: #3a3a3c; --err: #ff6b6b; }
  }
  body { margin: 0 auto; max-width: 880px; padding: 16px; background: var(--bg); color: var(--fg); }
  h1 { font-size: 24px; margin: 8px 0; }
  h2 { font-size: 19px; margin: 28px 0 8px; }
  h3 { font-size: 15px; margin: 0 0 4px; }
  form { display: flex; gap: 8px; margin: 16px 0; }
  input { flex: 1; min-width: 0; font: inherit; padding: 8px; }
  button { font: inherit; padding: 8px 14px; }
  .note { color: var(--muted); font-size: 13px; margin: 4px 0; }
  #err { color: var(--err); }
  .num { font-variant-numeric: tabular-nums; }
  [role=tablist] { display: flex; gap: 4px; border-bottom: 1px solid var(--line); margin: 8px 0 12px; }
  [role=tab] { border: 0; background: none; color: var(--muted); padding: 8px 12px; border-bottom: 2px solid transparent; cursor: pointer; }
  [role=tab][aria-selected=true] { color: var(--fg); border-bottom-color: var(--bar-today); font-weight: 600; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }
  .card { background: var(--card); border-radius: 12px; padding: 14px 16px; }
  .big { font-size: 34px; font-weight: 600; line-height: 1.1; }
  .delta { color: var(--muted); font-size: 14px; white-space: nowrap; }
  .cities { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 8px 0 6px; font-size: 14px; }
  .cities span { white-space: nowrap; }
  dl { display: grid; grid-template-columns: 1fr auto; gap: 2px 12px; margin: 6px 0 10px; }
  dt { color: var(--muted); }
  dd { margin: 0; text-align: right; }
  svg.bars { display: block; width: 100%; height: 56px; }
  svg.bars rect.b { fill: var(--bar); }
  svg.bars rect.b.today { fill: var(--bar-today); }
  svg.bars rect.b.zero { fill: var(--bar-zero); }
  svg.bars rect.hit { fill: transparent; cursor: pointer; }
  .axis { display: flex; justify-content: space-between; color: var(--muted); font-size: 12px; margin-top: 2px; }
  .pick { min-height: 1.4em; font-size: 13px; margin: 4px 0 0; }
  details { margin: 28px 0 8px; }
  summary { cursor: pointer; font-weight: 600; }
  table { border-collapse: collapse; width: 100%; margin: 8px 0 24px; font-size: 14px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); }
  td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; }
</style>
</head>
<body>
<h1>Stats</h1>
<p class="note">Anonymous daily totals (Athens time). No IP, device id or user data.</p>
<form id="f"><input id="t" type="password" autocomplete="current-password" placeholder="STATS_TOKEN" aria-label="STATS_TOKEN" required><button>Open</button></form>
<p id="err" role="alert"></p>
<div id="out"></div>
<script>
const LABELS = ${JSON.stringify(LABELS)};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const name = (kind, v) => esc(LABELS[kind][v] ?? v);
const fmt = (n) => Number(n).toLocaleString('en-GB');
const dm = (day) => day.slice(8, 10) + '/' + day.slice(5, 7);
const sum = (list, k) => list.reduce((a, t) => a + t[k], 0);

// Change against the 7 days before: an arrow and the difference, in the muted colour (more reports is not good news).
const delta = (now, before) => {
  const d = now - before;
  if (d === 0) return '<span class="delta">= 0</span>';
  const sign = d > 0 ? '▲ +' : '▼ −';
  const pct = before === 0 ? 'new' : Math.round(Math.abs(d) / before * 100) + '%';
  return '<span class="delta">' + sign + fmt(Math.abs(d)) + ' (' + pct + ')</span>';
};

// The metrics in the answer, in the page's order (unknown ones last, under their code), without the hidden ones.
const metricsOf = (d) => [...new Set(d.totals.map((t) => t.metric))]
  .filter((m) => !LABELS.hidden.includes(m))
  .sort((a, b) => ((LABELS.order.indexOf(a) + 1) || 99) - ((LABELS.order.indexOf(b) + 1) || 99));
// The columns: every city of the app, then any other city in the data, then "no city" only when it has a number.
const citiesOf = (d, metric) => {
  const rows = d.totals.filter((t) => t.metric === metric);
  const ids = [...LABELS.cities, ...rows.map((t) => t.city).filter((c) => c && !LABELS.cities.includes(c))];
  const cols = [...new Set(ids)].map((c) => rows.find((t) => t.city === c) || { metric, city: c, today: 0, d7: 0, prev7: 0, d30: 0, all: 0, series: d.days30.map(() => 0) });
  const none = rows.find((t) => t.city === '');
  return none && none.all > 0 ? cols.concat(none) : cols;
};

// 30 bars, one per day, oldest on the left; a day with no row is 0 (a thin grey bar). Tap or hover a bar for its number.
const bars = (t, days30, max) => {
  const W = 10, H = 56;
  let s = '<svg class="bars" viewBox="0 0 ' + (W * days30.length) + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="' +
    esc(name('metric', t.metric) + ', ' + LABELS.city[t.city] + ': 30 days') + '">';
  days30.forEach((day, i) => {
    const n = t.series[i] || 0;
    const h = n === 0 ? 1 : Math.max(2, Math.round(n / max * (H - 2)));
    const cls = 'b' + (n === 0 ? ' zero' : '') + (i === days30.length - 1 ? ' today' : '');
    s += '<rect class="' + cls + '" x="' + (i * W + 1) + '" y="' + (H - h) + '" width="' + (W - 2) + '" height="' + h + '"></rect>' +
      '<rect class="hit" x="' + (i * W) + '" y="0" width="' + W + '" height="' + H + '" data-pick="' + esc(dm(day) + ': ' + fmt(n)) + '"><title>' + esc(day + ': ' + n) + '</title></rect>';
  });
  return s + '</svg><div class="axis"><span>' + esc(dm(days30[0])) + '</span><span>max ' + fmt(max) + '</span><span>today</span></div><p class="pick"></p>';
};

const headline = (d, metric) => {
  const cols = citiesOf(d, metric);
  const d7 = sum(cols, 'd7');
  const prev7 = sum(cols, 'prev7');
  const meaning = LABELS.meaning[metric];
  return '<section class="card"><h3>' + name('metric', metric) + '</h3>' +
    '<div><span class="big num">' + fmt(d7) + '</span> ' + delta(d7, prev7) + '</div>' +
    '<p class="cities">' + cols.map((t) => '<span>' + name('city', t.city) + ' <b class="num">' + fmt(t.d7) + '</b> ' + delta(t.d7, t.prev7) + '</span>').join('') + '</p>' +
    (meaning ? '<p class="note">' + esc(meaning) + '</p>' : '') + '</section>';
};

const detail = (d, metric) => {
  const cols = citiesOf(d, metric);
  const max = Math.max(1, ...cols.flatMap((t) => t.series));
  return '<h2>' + name('metric', metric) + '</h2><div class="grid">' + cols.map((t) =>
    '<section class="card"><h3>' + name('city', t.city) + '</h3><dl class="num">' +
    '<dt>Today</dt><dd>' + fmt(t.today) + '</dd>' +
    '<dt>7 d</dt><dd>' + fmt(t.d7) + ' ' + delta(t.d7, t.prev7) + '</dd>' +
    '<dt>30 d</dt><dd>' + fmt(t.d30) + '</dd>' +
    '<dt>All</dt><dd>' + fmt(t.all) + '</dd></dl>' + bars(t, d.days30, max) + '</section>').join('') + '</div>';
};

const table = (head, rows) => '<table><thead><tr>' + head.map((h, i) => '<th' + (i >= 2 ? ' class="n"' : '') + '>' + h + '</th>').join('') +
  '</tr></thead><tbody>' + (rows.join('') || '<tr><td colspan="' + head.length + '">No data yet</td></tr>') + '</tbody></table>';

// The first tables of the page, closed at the bottom: the same numbers, one row each.
const raw = (d) => '<details><summary>Raw numbers</summary>' +
  '<h3>Totals</h3>' +
  table(['Metric', 'City', 'Today', '7 d', '30 d', 'All'],
    d.totals.map((t) => '<tr><td>' + name('metric', t.metric) + '</td><td>' + name('city', t.city) + '</td>' +
      [t.today, t.d7, t.d30, t.all].map((n) => '<td class="n">' + n + '</td>').join('') + '</tr>')) +
  '<h3>Per day (30 d)</h3>' +
  table(['Day', 'Metric', 'City', 'Count'],
    d.days.map((r) => '<tr><td>' + esc(r.day) + '</td><td>' + name('metric', r.metric) + '</td><td>' + name('city', r.city) + '</td><td class="n">' + r.n + '</td></tr>')) +
  '</details>';

const usage = (d) => {
  const metrics = metricsOf(d);
  if (!metrics.length) return '<p>No data yet</p>' + raw(d);
  return '<p class="note">Last 7 days to ' + esc(dm(d.today)) + ', against the 7 before.</p>' +
    '<div class="grid">' + metrics.map((m) => headline(d, m)).join('') + '</div>' +
    metrics.map((m) => detail(d, m)).join('') + raw(d);
};

// One entry per tab. A new tab (TEL-396, "Data quality") is one more line here.
const TABS = [
  { id: 'usage', label: 'Usage', render: usage },
];
let data = null;
let tab = TABS[0].id;

const show = () => {
  const out = document.getElementById('out');
  const current = TABS.find((x) => x.id === tab);
  out.innerHTML = '<nav role="tablist" aria-label="Stats">' + TABS.map((x) =>
    '<button type="button" role="tab" id="tab-' + x.id + '" data-tab="' + x.id + '" aria-controls="panel" aria-selected="' + (x.id === tab) + '">' + esc(x.label) + '</button>').join('') +
    '</nav><div role="tabpanel" id="panel" aria-labelledby="tab-' + current.id + '">' + current.render(data) + '</div>';
};

document.getElementById('out').addEventListener('click', (e) => {
  const t = e.target.closest('[data-tab]');
  if (t) { tab = t.dataset.tab; show(); return; }
  const bar = e.target.closest('[data-pick]');
  if (bar) bar.closest('.card').querySelector('.pick').textContent = bar.dataset.pick;
});

document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.getElementById('err');
  const out = document.getElementById('out');
  err.textContent = '';
  try {
    const res = await fetch('/api/admin/counts', { headers: { Authorization: 'Bearer ' + document.getElementById('t').value }, cache: 'no-store' });
    if (!res.ok) throw new Error(res.status === 401 ? 'Wrong token' : res.status === 429 ? 'Too many tries, wait 10 min' : 'HTTP ' + res.status);
    data = await res.json();
    show();
  } catch (ex) {
    out.innerHTML = '';
    err.textContent = ex.message;
  }
});
</script>
</body>
</html>
`;

const PRIVATE_HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex',
  'X-Content-Type-Options': 'nosniff',
};

const PAGE_HEADERS = {
  ...PRIVATE_HEADERS,
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
};

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), { status, headers: { ...PRIVATE_HEADERS, 'Content-Type': 'application/json; charset=utf-8', ...extra } });

// -> Response for /stats and /api/admin/counts, or null for any other path.
// `limited()` is called only after a wrong token and says whether this caller has had too many (index.js rate limiter).
export async function adminRoute(request, env, { limited = () => false, now = Date.now() } = {}) {
  const { pathname } = new URL(request.url);
  if (pathname !== '/stats' && pathname !== '/api/admin/counts') return null;
  if (request.method !== 'GET') return json({ error: 'not_found' }, 404);
  if (pathname === '/stats') return new Response(STATS_HTML, { headers: PAGE_HEADERS });

  if (!env.STATS_TOKEN || !env.COUNTERS) return json({ error: 'stats_unavailable' }, 503);
  if (!(await tokenMatches(bearer(request), env.STATS_TOKEN))) {
    if (limited()) return json({ error: 'rate_limited' }, 429, { 'Retry-After': '600' });
    return json({ error: 'unauthorized' }, 401, { 'WWW-Authenticate': 'Bearer' });
  }
  return json(summarizeCounts(await readCounts(env), now));
}
