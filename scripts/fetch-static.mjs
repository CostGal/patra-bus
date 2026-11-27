// Fetches stops + lines from the citybus API and writes them to the city's data dir (web/data/ for Patras,
// web/data/{city}/ otherwise). The token is scraped fresh each run and never written to disk.
// Usage: node scripts/fetch-static.mjs [--city=corfu] [--no-routes] [--force]
//   --force  write even when checkStatic finds problems (printed as warnings). Only after a person has looked at them,
//            e.g. a seasonal line that really went away.
// TEL-401: nothing is written unless both files pass checkStatic (a bad upstream answer must not replace good data).
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { city, apiBase, dataDir, setActiveCity, DEFAULT_CITY } from '../web/js/cities.js';

export const LIMITS = { minStops: 50, minLines: 5, minRatio: 0.8 };

// Problems with a fresh stops/lines answer, as human-readable strings ([] = fine). `current` holds the files on disk
// ({ stops, lines }, either may be null for a new city): a count below LIMITS.minRatio of it is refused.
export function checkStatic(stops, lines, current = {}) {
  const out = [];
  if (!Array.isArray(stops)) return ['stops: not a list'];
  if (!Array.isArray(lines)) return ['lines: not a list'];
  if (stops.length < LIMITS.minStops) out.push(`stops: ${stops.length} < minimum ${LIMITS.minStops}`);
  if (lines.length < LIMITS.minLines) out.push(`lines: ${lines.length} < minimum ${LIMITS.minLines}`);
  for (const [name, now, prev] of [['stops', stops, current.stops], ['lines', lines, current.lines]]) {
    if (Array.isArray(prev) && prev.length && now.length < prev.length * LIMITS.minRatio) {
      out.push(`${name}: ${now.length}, was ${prev.length} (dropped more than ${Math.round((1 - LIMITS.minRatio) * 100)}%)`);
    }
  }
  const notStr = [], badPos = [];
  const isStr = (c) => typeof c === 'string' && c !== '';
  for (const s of stops) {
    if (!isStr(s?.code)) notStr.push(`stop ${JSON.stringify(s?.code)}`);
    for (const k of ['routeCodes', 'lineCodes']) {
      if (!Array.isArray(s?.[k]) || !s[k].every(isStr)) notStr.push(`stop ${s?.code} ${k}`);
    }
    const lat = s?.latitude, lng = s?.longitude;
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) badPos.push(String(s?.code));
  }
  for (const l of lines) {
    if (!isStr(l?.code)) notStr.push(`line ${JSON.stringify(l?.code)}`);
    if (!Array.isArray(l?.routes)) { notStr.push(`line ${l?.code} routes`); continue; }
    for (const r of l.routes) if (!isStr(r?.code)) notStr.push(`line ${l?.code} route ${JSON.stringify(r?.code)}`);
  }
  if (notStr.length) out.push(`codes that are not strings: ${notStr.slice(0, 20).join(', ')}${notStr.length > 20 ? ` (+${notStr.length - 20})` : ''}`);
  if (badPos.length) out.push(`stops with 0/0 or missing coordinates: ${badPos.slice(0, 20).join(', ')}${badPos.length > 20 ? ` (+${badPos.length - 20})` : ''}`);
  return out;
}

// What to do with checkStatic's problems: { write, warnings, error }. --force turns refusals into warnings.
export function decideWrite(problems, { force = false } = {}) {
  if (!problems.length) return { write: true, warnings: [], error: null };
  if (force) return { write: true, warnings: problems, error: null };
  return {
    write: false,
    warnings: [],
    error: `fetch-static: nothing written, the fresh data failed the checks:\n  - ${problems.join('\n  - ')}\n` +
      'If a person has looked and the change is real (e.g. seasonal lines), run again with --force.',
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = async (url) => { try { return JSON.parse(await readFile(url, 'utf8')); } catch { return null; } };

async function scrapeToken(PAGE) {
  const html = await (await fetch(PAGE, { headers: { 'User-Agent': 'Mozilla/5.0' } })).text();
  const m = html.match(/const token = '([^']+)'/);
  if (!m) throw new Error('token not found in ' + PAGE);
  return m[1];
}

async function get(API, PAGE, path, token) {
  let res = await fetch(API + path, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401 || res.status === 403) {
    res = await fetch(API + path, {
      headers: { Authorization: `Bearer ${token}`, Referer: new URL('/', PAGE).href },
    });
  }
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

export async function main(argv = process.argv.slice(2)) {
  const cityArg = argv.find((a) => a.startsWith('--city='))?.slice('--city='.length) ?? DEFAULT_CITY;
  if (!setActiveCity(cityArg)) throw new Error(`unknown city: ${cityArg}`);
  const CITY = city();
  const PAGE = CITY.page;
  const API = apiBase(CITY);
  const OUT = new URL(`../web/${dataDir().slice(2)}`, import.meta.url);
  await mkdir(OUT, { recursive: true });

  const token = await scrapeToken(PAGE);
  const stops = await get(API, PAGE, '/stops', token);
  await sleep(250);
  const lines = await get(API, PAGE, '/lines', token);

  // `distance` is always 0 in this endpoint, so it is dropped.
  const slimStops = Array.isArray(stops) ? stops.map(({ distance, ...s }) => s) : stops;

  const current = { stops: await readJson(new URL('stops.json', OUT)), lines: await readJson(new URL('lines.json', OUT)) };
  const d = decideWrite(checkStatic(slimStops, lines, current), { force: argv.includes('--force') });
  for (const w of d.warnings) console.warn('warning (--force):', w);
  if (!d.write) { console.error(d.error); process.exitCode = 1; return; }

  await writeFile(new URL('stops.json', OUT), JSON.stringify(slimStops) + '\n');
  await writeFile(new URL('lines.json', OUT), JSON.stringify(lines) + '\n');
  console.log(`stops: ${slimStops.length}, lines: ${lines.length}`);

  // Rebuild routes.json / shapes.json from the fresh stops. build-routes only talks to OSRM (cached), never to
  // citybus. Skip with --no-routes; a failure here must not lose the stops/lines just written.
  if (!argv.includes('--no-routes')) {
    try {
      const { main: buildRoutes } = await import('./build-routes.mjs');
      await buildRoutes(['--quiet', `--city=${CITY.id}`]);
    } catch (e) {
      console.warn('build-routes failed (stops/lines were saved):', e.message);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
