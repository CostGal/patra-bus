// Fetches stops + lines from the citybus API and writes them to the city's data dir (web/data/ for Patras,
// web/data/{city}/ otherwise). The token is scraped fresh each run and never written to disk.
// Usage: node scripts/fetch-static.mjs [--city=corfu] [--no-routes]
import { writeFile, mkdir } from 'node:fs/promises';
import { city, apiBase, dataDir, setActiveCity, DEFAULT_CITY } from '../web/js/cities.js';

const cityArg = process.argv.find((a) => a.startsWith('--city='))?.slice('--city='.length) ?? DEFAULT_CITY;
if (!setActiveCity(cityArg)) throw new Error(`unknown city: ${cityArg}`);
const CITY = city();
const PAGE = CITY.page;
const API = apiBase(CITY);
const OUT = new URL(`../web/${dataDir().slice(2)}`, import.meta.url);
await mkdir(OUT, { recursive: true });
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
    await main(['--quiet', `--city=${CITY.id}`]);
  } catch (e) {
    console.warn('build-routes failed (stops/lines were saved):', e.message);
  }
}
