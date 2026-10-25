// Anonymous daily counters: "how many times did X happen in city Y on day D". One row per (day, metric, city) holding a
// number. No IP, no device id, no timestamps finer than the day, nothing per user: a request only ever adds 1 to a row.
// Metric and city come from the whitelists below, so no free text is ever stored.
// One Durable Object (SQLite) named `global` keeps the table; increments are atomic there, unlike a KV read-modify-write.
import { isCity } from '../../web/js/cities.js';

export const METRICS = ['feedback', 'open', 'install', 'push'];

const DAY_FORMAT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Athens', year: 'numeric', month: '2-digit', day: '2-digit' });

// Calendar day in Athens as YYYY-MM-DD: the day boundary falls at midnight for the riders, not at 02:00-03:00.
export const athensDay = (now) => DAY_FORMAT.format(now);

// -> { metric, city } (city '' = not tied to a city) or null when the metric or city is not on the whitelist.
export function validEvent(metric, city) {
  if (!METRICS.includes(metric)) return null;
  if (city === undefined || city === null || city === '') return { metric, city: '' };
  return isCity(city) ? { metric, city } : null;
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export class CountersBase {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sql = state.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS counts (day TEXT NOT NULL, metric TEXT NOT NULL, city TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, metric, city))');
  }

  async fetch(request) {
    if (request.method === 'GET') {
      return json({ rows: this.sql.exec('SELECT day, metric, city, n FROM counts ORDER BY day, metric, city').toArray() });
    }
    if (request.method !== 'POST') return json({ error: 'method' }, 405);
    const { day, metric, city } = await request.json();
    const e = validEvent(metric, city);
    if (!e || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return json({ error: 'bad_request' }, 400);
    this.sql.exec('INSERT INTO counts (day, metric, city, n) VALUES (?, ?, ?, 1) ON CONFLICT (day, metric, city) DO UPDATE SET n = n + 1', day, e.metric, e.city);
    return json({ ok: true });
  }
}

const stub = (env) => env.COUNTERS.get(env.COUNTERS.idFromName('global'));

// Add 1 to today's counter. Best effort: never throws, so a counting problem can never break the request it rides on.
export async function recordCount(env, metric, city, now = Date.now()) {
  if (!env.COUNTERS) return;
  const e = validEvent(metric, city);
  if (!e) return;
  try {
    await stub(env).fetch('https://counters/', { method: 'POST', body: JSON.stringify({ day: athensDay(now), ...e }) });
  } catch (err) {
    console.error(`counters: ${err.message}`);
  }
}

// All rows [{ day, metric, city, n }], oldest first.
export async function readCounts(env) {
  const res = await stub(env).fetch('https://counters/');
  return (await res.json()).rows;
}
