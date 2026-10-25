// Private stats page for the anonymous counters (counters.js). Two routes:
//   GET /stats              -> a static HTML page with a password field; holds no data and no secret.
//   GET /api/admin/counts   -> the counters, only with `Authorization: Bearer <STATS_TOKEN>`.
// STATS_TOKEN is a Cloudflare secret (worker/.dev.vars locally), never in the repo. The token never goes in a URL, and
// neither response is cacheable or readable by another site (no Access-Control-Allow-Origin).
import { readCounts, athensDay, METRICS } from './counters.js';
import { CITIES } from '../../web/js/cities.js';

const DAY_MS = 86400 * 1000;

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

// rows [{ day, metric, city, n }] -> { today, totals: [{ metric, city, today, d7, d30, all }], days: [{ day, metric, city, n }] (last 30 days, newest first) }.
export function summarizeCounts(rows, now) {
  const today = athensDay(now);
  const from7 = athensDay(now - 6 * DAY_MS);
  const from30 = athensDay(now - 29 * DAY_MS);
  const totals = new Map();
  for (const r of rows) {
    const key = `${r.metric}|${r.city}`;
    const t = totals.get(key) || { metric: r.metric, city: r.city, today: 0, d7: 0, d30: 0, all: 0 };
    t.all += r.n;
    if (r.day >= from30) t.d30 += r.n;
    if (r.day >= from7) t.d7 += r.n;
    if (r.day === today) t.today += r.n;
    totals.set(key, t);
  }
  const order = (a, b) => METRICS.indexOf(a.metric) - METRICS.indexOf(b.metric) || a.city.localeCompare(b.city);
  const days = rows.filter((r) => r.day >= from30).sort((a, b) => b.day.localeCompare(a.day) || order(a, b));
  return { today, totals: [...totals.values()].sort(order), days };
}

const LABELS = {
  metric: { feedback: 'Αναφορές / Feedback', open: 'Ανοίγματα / Opens', install: 'Εγκαταστάσεις / Installs', push: 'Push' },
  city: { '': '—', ...Object.fromEntries(Object.values(CITIES).map((c) => [c.id, `${c.name.el} / ${c.name.en}`])) },
};

export const STATS_HTML = `<!doctype html>
<html lang="el">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>patra-bus stats</title>
<style>
  :root { color-scheme: light dark; font: 15px/1.4 system-ui, sans-serif; }
  body { margin: 0 auto; max-width: 720px; padding: 16px; }
  form { display: flex; gap: 8px; margin: 16px 0; }
  input { flex: 1; font: inherit; padding: 8px; }
  button { font: inherit; padding: 8px 14px; }
  table { border-collapse: collapse; width: 100%; margin: 8px 0 24px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #8884; }
  td.n { text-align: right; font-variant-numeric: tabular-nums; }
  .note { opacity: .7; font-size: 13px; }
  #err { color: #c33; }
</style>
</head>
<body>
<h1>Στατιστικά / Stats</h1>
<p class="note">Ανώνυμα σύνολα ανά ημέρα (ώρα Αθήνας). Χωρίς IP, id συσκευής ή στοιχεία χρήστη. / Anonymous daily totals (Athens time). No IP, device id or user data.</p>
<form id="f"><input id="t" type="password" autocomplete="current-password" placeholder="STATS_TOKEN" aria-label="STATS_TOKEN" required><button>Άνοιγμα / Open</button></form>
<p id="err" role="alert"></p>
<div id="out"></div>
<script>
const LABELS = ${JSON.stringify(LABELS)};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const name = (kind, v) => esc(LABELS[kind][v] ?? v);
const table = (head, rows) => '<table><thead><tr>' + head.map((h, i) => '<th' + (i >= 2 ? ' class="n"' : '') + '>' + h + '</th>').join('') +
  '</tr></thead><tbody>' + (rows.join('') || '<tr><td colspan="' + head.length + '">Κανένα δεδομένο ακόμα / No data yet</td></tr>') + '</tbody></table>';
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.getElementById('err');
  const out = document.getElementById('out');
  err.textContent = '';
  try {
    const res = await fetch('/api/admin/counts', { headers: { Authorization: 'Bearer ' + document.getElementById('t').value }, cache: 'no-store' });
    if (!res.ok) throw new Error(res.status === 401 ? 'Λάθος κωδικός / Wrong token' : res.status === 429 ? 'Πολλές προσπάθειες, δοκίμασε σε 10 λεπτά / Too many tries, wait 10 min' : 'HTTP ' + res.status);
    const d = await res.json();
    out.innerHTML = '<h2>Σύνολα / Totals</h2><p class="note">Σήμερα / Today: ' + esc(d.today) + '</p>' +
      table(['Μέτρηση / Metric', 'Πόλη / City', 'Σήμερα / Today', '7 ημ. / 7 d', '30 ημ. / 30 d', 'Όλα / All'],
        d.totals.map((t) => '<tr><td>' + name('metric', t.metric) + '</td><td>' + name('city', t.city) + '</td>' +
          [t.today, t.d7, t.d30, t.all].map((n) => '<td class="n">' + n + '</td>').join('') + '</tr>')) +
      '<h2>Ανά ημέρα (30 ημ.) / Per day (30 d)</h2>' +
      table(['Ημέρα / Day', 'Μέτρηση / Metric', 'Πόλη / City', 'Πλήθος / Count'],
        d.days.map((r) => '<tr><td>' + esc(r.day) + '</td><td>' + name('metric', r.metric) + '</td><td>' + name('city', r.city) + '</td><td class="n">' + r.n + '</td></tr>'));
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
