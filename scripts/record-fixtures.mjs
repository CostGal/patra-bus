// Records real upstream /stops/live/{code} responses for the Playwright smoke tests (tests/e2e/).
// One live request per stop, nothing else: same token scrape as fetch-static.mjs, token never written to disk.
// The tests serve these files through route mocking and never touch citybus.gr or the worker.
// Usage: node scripts/record-fixtures.mjs [--only=patra|corfu] [--force]
// Record during service hours (weekday daytime): a recording without both a LIVE and a scheduled departure is
// not written unless --force, so a night-time run can't replace a good fixture with a weaker one.
import { writeFile, mkdir } from 'node:fs/promises';
import { CITIES, apiBase } from '../web/js/cities.js';
import { isLive } from '../web/js/arrivals.js';
import { E2E_STOPS } from '../tests/e2e/stops.mjs';

const OUT = new URL('../tests/e2e/fixtures/', import.meta.url);
const force = process.argv.includes('--force');
const only = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function scrapeToken(page) {
  const html = await (await fetch(page, { headers: { 'User-Agent': 'Mozilla/5.0' } })).text();
  const m = html.match(/const token = '([^']+)'/);
  if (!m) throw new Error('token not found in ' + page);
  return m[1];
}

async function getLive(c, code, token) {
  const url = `${apiBase(c)}/stops/live/${encodeURIComponent(code)}`;
  let res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401 || res.status === 403) {
    res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Referer: new URL('/', c.page).href } });
  }
  if (res.status === 404) return { status: 404, body: null }; // no departures right now
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const text = await res.text();
  if (!text.trim()) throw new Error(`${url}: empty body, try again in a few seconds`);
  return { status: res.status, body: JSON.parse(text) };
}

await mkdir(OUT, { recursive: true });
for (const [cityId, code] of Object.entries(E2E_STOPS)) {
  if (only && only !== cityId) continue;
  const c = CITIES[cityId];
  const token = await scrapeToken(c.page);
  await sleep(250);
  const { status, body } = await getLive(c, code, token);
  const file = `${cityId}-live-${code}.json`;
  const vs = body?.vehicles ?? [];
  const live = vs.filter(isLive).length;
  console.log(`${file}: HTTP ${status}, ${live} live, ${vs.length - live} scheduled`);
  if (!(live > 0 && live < vs.length) && !force) {
    console.warn('  not written: needs at least one LIVE and one scheduled departure (re-record in service hours, or --force)');
    process.exitCode = 1;
    continue;
  }
  const fixture = { city: cityId, stop: code, recordedAt: new Date().toISOString(), status, body };
  await writeFile(new URL(file, OUT), JSON.stringify(fixture, null, 2) + '\n');
}
