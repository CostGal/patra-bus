// Same-bus watcher (TEL-145). Run by .github/workflows/watch-same-bus.yml every 30 min in daytime.
// Question it answers: when a live row and a scheduled row of the same line could be the same bus, do they share a
// vehicleCode (rule A in web/js/arrivals.js)? Or does only rule B (same line, ETA within 60 s) catch them?
// One token scrape per city and ONE GET /stops/live/{code} per watched stop, nothing else; the token is never written.
// Posts to the standing issue "Same-bus watch (TEL-145)" (via `gh`, needs GH_TOKEN); --dry prints instead.
// What to do when it fires: docs/ARCHITECTURE.md, "Same-bus watcher".
// Usage: node scripts/watch-same-bus.mjs [--dry]
import { execFile } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { CITIES, apiBase } from '../web/js/cities.js';
import { isLive, SAME_BUS_WINDOW_SEC } from '../web/js/arrivals.js';

const run = promisify(execFile);

// Busy stops (most lines): Patras 280 ΟΣΕ, 1011 Πανεπιστημίου & Αρέθα (the smoke-test stop); Corfu 801 Πλ. Σαρόκου (hub).
export const WATCHED = { patra: ['280', '1011'], corfu: ['801'] };
export const ISSUE_TITLE = 'Same-bus watch (TEL-145)';
export const MAX_MATCH_COMMENTS = 5; // evidence that rule A works; after this only mismatches are posted
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Raw upstream rows -> the pairs dropScheduledDuplicates would collapse, with the rule that caught each.
// Same two passes as arrivals.js (A first, then B; each live row absorbs at most one scheduled row).
// A copy on purpose: arrivals.js is shared with the worker and stays untouched; the unit test keeps both in step.
export function findPairs(rawVehicles) {
  const rows = (Array.isArray(rawVehicles) ? rawVehicles : []).map((v) => {
    const code = v.vehicleCode == null ? '' : String(v.vehicleCode).trim();
    return {
      live: isLive(v),
      lineCode: String(v.lineCode ?? ''),
      routeCode: String(v.routeCode ?? ''),
      etaSec: (Number(v.departureMins) || 0) * 60 + (Number(v.departureSeconds) || 0),
      vehicleCode: code || null,
    };
  });
  const live = rows.filter((r) => r.live);
  const scheduled = rows.filter((r) => !r.live);
  const taken = new Set();
  const paired = new Set();
  const pairs = [];
  for (const s of scheduled) {
    if (!s.vehicleCode) continue;
    const l = live.find((x) => !taken.has(x) && x.vehicleCode === s.vehicleCode);
    if (l) { taken.add(l); paired.add(s); pairs.push({ rule: 'A', live: l, scheduled: s }); }
  }
  for (const s of scheduled) {
    if (paired.has(s)) continue;
    const l = live.find((x) => !taken.has(x) && x.lineCode === s.lineCode && Math.abs(x.etaSec - s.etaSec) <= SAME_BUS_WINDOW_SEC);
    if (l) { taken.add(l); paired.add(s); pairs.push({ rule: 'B', live: l, scheduled: s }); }
  }
  return pairs;
}

// Trip codes look like 20261009_6091_0000100_22_10 (date, route, …, departure time; unconfirmed format).
// A live row without one (2026-10-20: a bare 19-digit number) was not linked to a trip upstream, so rule A can't match it.
export const isTripCode = (code) => /^\d{8}_/.test(code ?? '');

const fmtRow = (r) => `line ${r.lineCode}, route ${r.routeCode}, ETA ${r.etaSec} s, \`${r.vehicleCode ?? '(no vehicleCode)'}\``;

// One comment per finding. The first line is a hidden marker used to skip pairs already reported and to count evidence.
export function commentFor(kind, { city, stop, at, pair }) {
  const key = `${pair.live.vehicleCode}|${pair.scheduled.vehicleCode}`;
  const head = `<!-- same-bus:${kind}:${key} -->`;
  const where = `${city} stop ${stop}, ${at}`;
  if (kind === 'match') {
    return `${head}\n**Rule A confirmed** (${where}): live and scheduled row share one vehicleCode.\n- both: ${fmtRow(pair.live)}`;
  }
  return `${head}\n**Rule B fired without rule A** (${where}): a live and a scheduled row of the same line are within ${SAME_BUS_WINDOW_SEC} s but have different vehicleCodes.\n- live: ${fmtRow(pair.live)}\n- scheduled: ${fmtRow(pair.scheduled)}\n\n${isTripCode(pair.live.vehicleCode)
    ? 'Different trip in the codes (route or time part) = two real buses and rule B hides one. Same trip, different format = rule A is not enough.'
    : 'The live code is not a trip code (no date/route/time part): upstream did not link this bus to a trip, so rule A can never match it and rule B is needed. Keep rule B unless the ETAs say two buses.'} See docs/ARCHITECTURE.md, "Same-bus watcher".`;
}

// Which findings still need a comment, given the markers/bodies already on the issue.
export function selectNew(findings, existingBodies) {
  const seen = new Set();
  let matches = 0;
  for (const b of existingBodies) {
    const m = /<!-- same-bus:(match|mismatch):([^>]*?) -->/.exec(b);
    if (!m) continue;
    seen.add(`${m[1]}:${m[2]}`);
    if (m[1] === 'match') matches++;
  }
  const out = [];
  for (const f of findings) {
    const id = `${f.kind}:${f.pair.live.vehicleCode}|${f.pair.scheduled.vehicleCode}`;
    if (seen.has(id)) continue;
    if (f.kind === 'match') {
      if (matches >= MAX_MATCH_COMMENTS) continue;
      matches++;
    }
    seen.add(id);
    out.push(f);
  }
  return out;
}

async function scrapeToken(page) {
  const html = await (await fetch(page, { headers: { 'User-Agent': 'Mozilla/5.0' } })).text();
  const m = html.match(/const token = '([^']+)'/);
  if (!m) throw new Error('token not found in ' + page);
  return m[1];
}

// Returns the vehicles array, [] for 404 (no departures right now) or for a rare empty 200 (skipped, not an error).
async function getLive(c, code, token) {
  const url = `${apiBase(c)}/stops/live/${encodeURIComponent(code)}`;
  let res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401 || res.status === 403) {
    res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Referer: new URL('/', c.page).href } });
  }
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const text = await res.text();
  if (!text.trim()) return [];
  const body = JSON.parse(text);
  return Array.isArray(body?.vehicles) ? body.vehicles : [];
}

const gh = async (...args) => (await run('gh', args)).stdout;

async function findOrCreateIssue() {
  const list = JSON.parse(await gh('issue', 'list', '--state', 'open', '--search', `"${ISSUE_TITLE}" in:title`, '--json', 'number,title'));
  const hit = list.find((i) => i.title === ISSUE_TITLE);
  if (hit) return hit.number;
  const body = 'Standing issue for the automatic same-bus watcher (`scripts/watch-same-bus.mjs`, `.github/workflows/watch-same-bus.yml`). '
    + 'A comment appears when a live and a scheduled row of the same line pair up. '
    + 'What to do about each kind: docs/ARCHITECTURE.md, "Same-bus watcher". Card: TEL-145.';
  const url = (await gh('issue', 'create', '--title', ISSUE_TITLE, '--body', body, '--assignee', process.env.GITHUB_REPOSITORY_OWNER || '@me')).trim();
  return Number(url.split('/').pop());
}

async function main() {
  const dry = process.argv.includes('--dry');
  const at = new Date().toISOString();
  const findings = [];
  const lines = [];
  const errors = [];
  for (const [cityId, stops] of Object.entries(WATCHED)) {
    const c = CITIES[cityId];
    let token;
    try { token = await scrapeToken(c.page); } catch (e) { errors.push(`${cityId}: ${e.message}`); continue; }
    for (const stop of stops) {
      await sleep(250);
      try {
        const vehicles = await getLive(c, stop, token);
        const pairs = findPairs(vehicles);
        const nLive = vehicles.filter(isLive).length;
        lines.push(`${cityId} ${stop}: ${nLive} live, ${vehicles.length - nLive} scheduled, ${pairs.length} pair(s)`);
        for (const pair of pairs) {
          const kind = pair.live.vehicleCode && pair.live.vehicleCode === pair.scheduled.vehicleCode ? 'match' : 'mismatch';
          findings.push({ kind, city: cityId, stop, at, pair });
        }
      } catch (e) {
        errors.push(`${cityId} ${stop}: ${e.message}`);
      }
    }
  }
  console.log(lines.join('\n') || '(no stops read)');

  let posted = 0;
  if (findings.length) {
    if (dry) {
      for (const f of findings) console.log('\n[dry] ' + commentFor(f.kind, f));
    } else {
      const issue = await findOrCreateIssue();
      const existing = JSON.parse(await gh('issue', 'view', String(issue), '--json', 'comments')).comments.map((c) => c.body);
      for (const f of selectNew(findings, existing)) {
        await gh('issue', 'comment', String(issue), '--body', commentFor(f.kind, f));
        posted++;
      }
    }
  }

  const summary = [`### Same-bus watch ${at}`, ...lines.map((l) => `- ${l}`), `- findings: ${findings.length}, new comments: ${posted}${dry ? ' (dry run)' : ''}`, ...errors.map((e) => `- ERROR ${e}`)].join('\n');
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1; // the failed run emails the owner; no issue noise for a broken watcher
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
