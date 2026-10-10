// Fetches stops + lines from the citybus API and writes them to web/data/.
// The token is scraped fresh each run and never written to disk.
import { writeFile } from 'node:fs/promises';
import { city, apiBase } from '../web/js/cities.js';

const CITY = city();
const PAGE = CITY.page;
const API = apiBase(CITY);
const OUT = new URL('../web/data/', import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function scrapeToken() {
  const html = await (await fetch(PAGE, { headers: { 'User-Agent': 'Mozilla/5.0' } })).text();
  const m = html.match(/const token = '([^']+)'/);
  if (!m) throw new Error('token not found in ' + PAGE);
  return m[1];
}

async function get(path, token) {
  let res = await fetch(API + path, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401 || res.status === 403) {
    res = await fetch(API + path, {
      headers: { Authorization: `Bearer ${token}`, Referer: new URL('/', PAGE).href },
    });
  }
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

const token = await scrapeToken();
const stops = await get('/stops', token);
await sleep(250);
const lines = await get('/lines', token);

// `distance` is always 0 in this endpoint, so it is dropped.
const slimStops = stops.map(({ distance, ...s }) => s);

await writeFile(new URL('stops.json', OUT), JSON.stringify(slimStops) + '\n');
await writeFile(new URL('lines.json', OUT), JSON.stringify(lines) + '\n');
console.log(`stops: ${slimStops.length}, lines: ${lines.length}`);

// Rebuild routes.json / shapes.json from the fresh stops. build-routes only talks to OSRM (cached), never to
// citybus. Skip with --no-routes; a failure here must not lose the stops/lines just written.
if (!process.argv.includes('--no-routes')) {
  try {
    const { main } = await import('./build-routes.mjs');
    await main(['--quiet']);
  } catch (e) {
    console.warn('build-routes failed (stops/lines were saved):', e.message);
  }
}
