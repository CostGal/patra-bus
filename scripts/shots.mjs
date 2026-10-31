// Screenshot sweep: key screens × phone/tablet sizes × light/dark × Greek/English -> shots/ (PNG + SUMMARY.md).
// Run: npm run shots [-- --device="iPhone SE,Pixel 7" --lang=el --theme=dark --screen=stop,settings --base=https://<preview> --web=<other checkout>/web]
//      --map: let OpenFreeMap through so the map is drawn behind the chrome
//      (tiles only: no location, no user data; every other third party stays blocked)
//      --annotate: numbered UI map for UI reviews (TEL-198): every element boxed with its permanent ID from scripts/ui-map.mjs,
//      -> shots/ui-map/ + LEGEND.md; its own screens (menus open, vehicle…), default iPhone 15 · el · light
// Uses the ?demo mode and the same network mocks as the smoke tests (nothing reaches citybus.gr or any third party), so
// it checks LAYOUT only: the map tiles are blocked (the map area stays empty), fonts are the computer's (not SF/Roboto), and touch feel, push, install, GPS,
// speed and sunlight still need a real phone (CLAUDE.md rule 9).
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit, firefox, devices } from '@playwright/test';
import { mockNetwork } from '../tests/e2e/mock.mjs';
import { UI, UI_SCREENS, annotate, legend } from './ui-map.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = fileURLToPath(new URL('../shots/', import.meta.url));
const PORT = 4174; // 4173 belongs to the smoke tests
const ENGINES = { chromium, webkit, firefox };

const DEFAULT_DEVICES = ['iPhone SE', 'iPhone 15', 'Pixel 7', 'iPad Mini landscape'];
// hash is appended to <base>/?demo…; scroll = also capture the content below the fold (pages of the sheet);
// steps = also capture that many next steps of a dialog (its .su-next button).
const SCREENS = [
  { id: 'home', url: '/?demo#/' },
  { id: 'stop', url: '/?demo#/stop/1011', scroll: 1 },
  { id: 'stop-error', url: '/?demo=error#/stop/1011' },
  { id: 'stop-nosvc', url: '/?demo=nosvc#/stop/1011' },
  { id: 'corfu-stop', url: '/?demo#/corfu/stop/801' },
  { id: 'lines', url: '/?demo#/lines', scroll: 1 },
  { id: 'favorites', url: '/?demo#/favorites' },
  { id: 'plan', url: '/?demo#/plan?to=38.2466,21.7346&name=Test' },
  { id: 'settings', url: '/?demo#/settings', scroll: 3 },
  { id: 'guide', url: '/?demo#/guide', scroll: 2 },
  { id: 'report', url: '/?demo#/report', scroll: 1 },
  { id: 'setup', url: '/?demo&setup#/', steps: 2 },
];

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=') || 'true']; }));
const list = (v, all) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : all);
const ANNOTATE = Boolean(args.annotate);
const ALL_SCREENS = ANNOTATE ? UI_SCREENS : SCREENS;
const wantDevices = list(args.device, ANNOTATE ? ['iPhone 15'] : DEFAULT_DEVICES);
const wantLangs = list(args.lang, ANNOTATE ? ['el'] : ['el', 'en']);
const wantThemes = list(args.theme, ANNOTATE ? ['light'] : ['light', 'dark']);
const wantScreens = list(args.screen, ALL_SCREENS.map((s) => s.id));
const screens = ALL_SCREENS.filter((s) => wantScreens.includes(s.id));
const bad = [...wantDevices.filter((d) => !devices[d]).map((d) => `device "${d}"`), ...wantLangs.filter((l) => !['el', 'en'].includes(l)).map((l) => `lang "${l}"`),
  ...wantThemes.filter((t) => !['light', 'dark'].includes(t)).map((t) => `theme "${t}"`), ...wantScreens.filter((s) => !ALL_SCREENS.some((x) => x.id === s)).map((s) => `screen "${s}"`)];
if (bad.length) { console.error(`Unknown: ${bad.join(', ')}\nDevices: ${Object.keys(devices).filter((d) => !/landscape/.test(d)).join(', ')}\nScreens: ${ALL_SCREENS.map((s) => s.id).join(', ')}`); process.exit(2); }

const WEB = args.web ? resolve(String(args.web)) : `${ROOT}web`; // --web: serve another checkout's web/ (e.g. a git worktree of a PR branch)
let server = null;
async function startServer() {
  server = spawn(process.execPath, [`${ROOT}node_modules/http-server/bin/http-server`, WEB, '-p', String(PORT), '-c-1', '--silent'], { stdio: 'ignore' });
  const url = `http://localhost:${PORT}`;
  for (let i = 0; i < 50; i++) { try { if ((await fetch(url)).ok) return url; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 100)); }
  throw new Error('static server did not start');
}

// The app picks its language from settings (default 'auto' follows the phone), so the blob is written before the app starts.
const seed = (lang) => `try { if (!localStorage.getItem('patra-bus:v2')) localStorage.setItem('patra-bus:v2', JSON.stringify({ v: 3, favorites: [], recents: { stop: [], place: [] }, settings: { lang: '${lang}', setupDone: true } })); } catch {}`;

const launched = new Map();
async function browserFor(device, notes) {
  const want = devices[device].defaultBrowserType;
  const name = args.engine || want;
  const key = `${name}`;
  if (launched.has(key)) return launched.get(key);
  let b;
  // --chromium=<path> (or CHROMIUM_PATH) uses an existing Chromium instead of the one Playwright downloads.
  const chromiumOpts = (args.chromium || process.env.CHROMIUM_PATH) ? { executablePath: args.chromium || process.env.CHROMIUM_PATH } : {};
  try { b = { browser: await ENGINES[name].launch(name === 'chromium' ? chromiumOpts : {}), engine: name }; } catch (e) {
    if (name === 'chromium') throw e;
    b = { browser: await chromium.launch(chromiumOpts), engine: 'chromium' };
    notes.add(`${name} is not installed (run: npx playwright install ${name}); ${device} was rendered with Chromium at the same size, so Safari-only quirks are NOT covered.`);
  }
  launched.set(key, b);
  return b;
}

const scrollerInfo = () => {
  const el = document.getElementById('sheet-body');
  return el ? { top: el.scrollTop, max: el.scrollHeight - el.clientHeight, page: el.clientHeight } : null;
};

async function shoot(page, file) { await page.screenshot({ path: file }); }


async function capture(context, base, screen, dir, summary) {
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`error: ${e.message}`));
  await page.goto(base + screen.url);
  await page.waitForFunction(() => { const c = document.getElementById('sheet-content'); return c && !/Φόρτωση…|Loading…/.test(c.textContent || ''); }, null, { timeout: 8000 }).catch(() => problems.push('still loading after 8 s'));
  await page.waitForTimeout(args.map ? 2500 : 500); // --map: give the tiles time to draw
  if (ANNOTATE) {
    if (screen.act) { await screen.act(page).catch((e) => problems.push(`could not open the screen: ${e.message.split('\n')[0]}`)); await page.waitForTimeout(700); }
    const { ids, unknown } = await page.evaluate(annotate, UI);
    await shoot(page, `${dir}/${screen.id}.png`);
    await page.close();
    summary.push({ dir, screen: screen.id, files: [`${screen.id}.png`], problems, ids, unknown });
    return;
  }
  const files = [];
  const first = `${screen.id}.png`;
  await shoot(page, `${dir}/${first}`); files.push(first);
  for (let i = 1; i <= (screen.steps || 0); i++) {
    await page.click('.su-next');
    await page.waitForTimeout(500);
    const f = `${screen.id}-step${i + 1}.png`;
    await shoot(page, `${dir}/${f}`); files.push(f);
  }
  const info = await page.evaluate(scrollerInfo);
  for (let i = 1; info && i <= (screen.scroll || 0); i++) {
    const moved = await page.evaluate(() => { const el = document.getElementById('sheet-body'); const before = el.scrollTop; el.scrollTop = before + el.clientHeight * 0.85; return el.scrollTop > before; });
    if (!moved) break;
    await page.waitForTimeout(150);
    const f = `${screen.id}-${i + 1}.png`;
    await shoot(page, `${dir}/${f}`); files.push(f);
  }
  const over = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  if (over.sw > over.iw + 1) problems.push(`horizontal overflow (page ${over.sw}px wide in a ${over.iw}px window)`);
  await page.close();
  summary.push({ dir, screen: screen.id, files, problems });
}

const base = args.base ? String(args.base).replace(/\/$/, '') : await startServer();
const notes = new Set();
const summary = [];
await rm(OUT, { recursive: true, force: true });
const outDir = ANNOTATE ? `${OUT}ui-map/` : OUT;
try {
  for (const device of wantDevices) {
    const { browser, engine } = await browserFor(device, notes);
    const { defaultBrowserType, ...desc } = devices[device];
    for (const lang of wantLangs) for (const theme of wantThemes) {
      const dir = `${outDir}${device.replace(/\s+/g, '-')}/${lang}-${theme}`;
      await mkdir(dir, { recursive: true });
      const context = await browser.newContext({ ...desc, locale: lang === 'el' ? 'el-GR' : 'en-GB', timezoneId: 'Europe/Athens', colorScheme: theme, reducedMotion: 'reduce', serviceWorkers: 'block' });
      await context.addInitScript(seed(lang));
      await mockNetwork(context, base);
      // registered after the mocks, so it wins for this host only
      if (args.map) await context.route((u) => u.hostname === 'tiles.openfreemap.org', (route) => route.continue());
      for (const screen of screens) await capture(context, base, screen, dir, summary);
      await context.close();
      console.log(`${device} · ${lang} · ${theme} (${engine}): ${screens.length} screens`);
    }
  }
} finally {
  for (const { browser } of launched.values()) await browser.close().catch(() => {});
  server?.kill();
}

const rel = (p) => p.replace(OUT, '');
if (ANNOTATE) {
  const one = summary.every((s) => s.dir === summary[0]?.dir);
  const results = summary.map((s) => ({ screen: one ? s.screen : `${rel(s.dir).replace('ui-map/', '')}/${s.screen}`, file: `${rel(s.dir).replace('ui-map/', '')}/${s.screen}.png`, ids: s.ids, unknown: s.unknown }));
  const flagged = summary.filter((s) => s.problems.length);
  const meta = `Base: ${base}/ · ${new Date().toISOString()} · ${wantDevices.join(', ')} · ${wantLangs.join(', ')} · ${wantThemes.join(', ')}${args.map ? ' · map tiles from OpenFreeMap' : ''}${[...notes].map((n) => `\n\n> **Note:** ${n}`).join('')}${flagged.map((s) => `\n\n> **Problem** \`${rel(s.dir)}/${s.screen}\`: ${s.problems.join('; ')}`).join('')}`;
  await writeFile(`${outDir}LEGEND.md`, legend(results, meta));
  console.log(`\n${summary.length} annotated screens -> shots/ui-map/ (see shots/ui-map/LEGEND.md); ${summary.reduce((n, s) => n + s.unknown.length, 0)} elements not in the registry`);
  process.exit(0);
}
const lines = ['# Screenshot sweep', '', `Base: ${base}/ · ${new Date().toISOString()}`, '', `Layout only (demo data, ${args.map ? 'map tiles from OpenFreeMap' : 'map tiles blocked'}). Fonts come from this computer, not the phone, so letter shapes and thickness differ from a real iPhone/Android. Real-phone checks stay as \`device-test\` issues.`, ''];
for (const n of notes) lines.push(`> **Note:** ${n}`, '');
const flagged = summary.filter((s) => s.problems.length);
lines.push(`## Problems found by the script (${flagged.length})`, '');
if (!flagged.length) lines.push('None (no uncaught errors, no horizontal overflow, nothing stuck loading).');
for (const s of flagged) lines.push(`- \`${rel(s.dir)}/${s.screen}\`: ${s.problems.join('; ')}`);
lines.push('', '## Files', '');
for (const s of summary) lines.push(`- ${s.files.map((f) => `${rel(s.dir)}/${f}`).join(', ')}`);
await writeFile(`${OUT}SUMMARY.md`, lines.join('\n') + '\n');
console.log(`\n${summary.reduce((n, s) => n + s.files.length, 0)} screenshots -> shots/ (see shots/SUMMARY.md); ${flagged.length} screens with problems`);
