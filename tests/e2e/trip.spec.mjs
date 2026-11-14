// The trip view wired into the app (TEL-294): a place in the search opens #/trip, plan() in js/app.js finds the start.
// Rule 6 (CLAUDE.md): the start (your location) is never in the URL or in storage; it goes only to OSRM at 5 decimals.
// The mocks block OSRM, so walks fall back to the on-device estimate; the requests themselves are still seen here.
import { test, expect } from './mock.mjs';

const START = /38\.2466|21\.7346/; // the test position below, and the demo start (Πλ. Γεωργίου)
const PLACE = { name: 'Δοκιμή', subtitle: '', lat: 38.289, lng: 21.785, city: 'patras' };

// Adds to the stored state before any page script runs (after SKIP_SETUP, which marks the setup as done).
const seed = (page, patch) => page.addInitScript((p) => {
  const k = 'patra-bus:v2';
  const b = JSON.parse(localStorage.getItem(k) || 'null') || { v: 3, favorites: [], recents: { stop: [], place: [] }, settings: {} };
  if (p.place) b.recents = { ...b.recents, place: [p.place] };
  if (p.settings) b.settings = { ...b.settings, ...p.settings };
  localStorage.setItem(k, JSON.stringify(b));
}, patch);

// Every URL the page asks for that carries the start's longitude.
const watchStart = (page) => {
  const asked = [];
  page.on('request', (r) => { if (/21\.7346/.test(r.url())) asked.push(r.url()); });
  return asked;
};
const chips = (page) => page.locator('.tripv .tripv-opt');

test.describe('trip, with location', () => {
  test.use({ permissions: ['geolocation'], geolocation: { latitude: 38.2466123, longitude: 21.7346123 } });

  test('a stop: the trip shows 1 to 3 options; the start is in no URL, only OSRM gets it', async ({ page }) => {
    const asked = watchStart(page);
    await page.goto('/?demo#/trip?stop=1011');
    await expect(page.locator('.tripv')).toBeVisible();
    await expect(chips(page).first()).toBeVisible();
    const n = await chips(page).count();
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(3);
    expect(page.url()).not.toMatch(START);
    expect(asked.length).toBeLessThanOrEqual(6);
    for (const u of asked) {
      expect(new URL(u).hostname).toBe('routing.openstreetmap.de');
      expect(u).toMatch(/21\.73461,38\.24661/); // 5 decimals, never the raw fix
    }
    // nothing stored has the start
    const values = await page.evaluate(() => Object.keys(localStorage).map((k) => localStorage.getItem(k)));
    for (const v of values) expect(v).not.toMatch(/38\.2466/);
    // back leads to the stop
    await page.locator('.tripv-head button[aria-label="Πίσω"]').click();
    await expect(page).toHaveURL(/#\/stop\/1011$/);
  });

  test('a recent place: the search opens the trip to it; back is the place view, ✕ is home', async ({ page }) => {
    await seed(page, { place: PLACE });
    await page.goto('/?demo#/');
    await page.locator('#search-input').click();
    await page.locator('#search-list .sr', { hasText: 'Δοκιμή' }).click();
    await expect(page.locator('.tripv')).toBeVisible();
    const hash = decodeURIComponent(new URL(page.url()).hash);
    expect(hash).toBe('#/trip?lat=38.28900&lng=21.78500&name=Δοκιμή');
    await expect(page.locator('.tripv')).toContainText('Δοκιμή');
    expect(page.url()).not.toMatch(START);
    const values = await page.evaluate(() => Object.keys(localStorage).map((k) => localStorage.getItem(k)));
    for (const v of values) expect(v).not.toMatch(/38\.2466/);
    await page.locator('.tripv-head button[aria-label="Πίσω"]').click();
    await expect(page).toHaveURL(/#\/pin\?lat=38\.28900&lng=21\.78500$/);
    await page.goBack();
    await expect(page.locator('.tripv')).toBeVisible();
    await page.locator('.tripv-head button[aria-label="Κλείσιμο"]').click();
    await expect(page).toHaveURL(/#\/$/);
  });

  test('no trip: «Άλλος προορισμός» opens home with the search open', async ({ page }) => {
    await page.goto('/?demo#/trip?lat=38.50000&lng=21.70000&name=Far'); // north of the city box
    const other = page.locator('.tripv button', { hasText: 'Άλλος προορισμός' });
    await expect(other).toBeVisible();
    await other.click();
    await expect(page).toHaveURL(/#\/$/);
    await expect(page.locator('#search-panel')).toBeVisible();
    await expect(page.locator('#search-input')).toBeFocused();
  });

  test('codes stay strings: a Corfu stop with a leading zero', async ({ page }) => {
    await page.goto('/?demo#/corfu/trip?stop=0015');
    await expect(page.locator('.tripv')).toBeVisible();
    expect(new URL(page.url()).hash).toBe('#/corfu/trip?stop=0015');
    await expect(page.locator('.view-head', { hasText: 'Η στάση δεν βρέθηκε' })).toHaveCount(0);
  });

  test('English: no Greek in the header of the trip view', async ({ page }) => {
    await seed(page, { settings: { lang: 'en' } });
    await page.goto('/?demo#/trip?stop=1011');
    await expect(chips(page).first()).toBeVisible();
    const greek = /[Ͱ-Ͽἀ-῿]/;
    const head = page.locator('.tripv-head');
    expect(await head.locator('.tripv-title').textContent()).not.toMatch(greek);
    for (const b of await head.locator('button').all()) expect(await b.getAttribute('aria-label')).not.toMatch(greek);
  });
});

test.describe('trip, no location', () => {
  test('not demo: a toast, then the stop, within 3 s', async ({ page }) => {
    await page.goto('/#/trip?stop=1011');
    await expect(page.locator('#toasts')).toContainText('Δεν βρέθηκε η τοποθεσία σου', { timeout: 3000 });
    await expect(page).toHaveURL(/#\/stop\/1011$/, { timeout: 3000 });
  });

  test('demo: the trip starts from the city centre', async ({ page }) => {
    await page.goto('/?demo#/trip?stop=1011');
    await expect(chips(page).first()).toBeVisible();
    expect(page.url()).not.toMatch(START);
  });
});

// TEL-295: the chosen trip drawn on the map. The map may be the no-map stand-in here (no WebGL, tiles blocked), so the
// test records what the view asks of window.__app.map (?debug) instead of looking at pixels.
test.describe('trip on the map', () => {
  test.use({ permissions: ['geolocation'], geolocation: { latitude: 38.2466123, longitude: 21.7346123 } });

  const spyMap = (page) => page.evaluate(() => {
    const m = window.__app.map;
    const calls = (window.__mapCalls = []);
    for (const k of ['setOverlay', 'clearOverlay', 'setMarkers', 'clearMarkers', 'fitTo']) {
      const f = m[k].bind(m);
      m[k] = (...a) => { calls.push({ k, id: typeof a[0] === 'string' ? a[0] : null, fc: k === 'setOverlay' ? JSON.stringify(a[1]) : null }); return f(...a); };
    }
  });
  const calls = (page) => page.evaluate(() => window.__mapCalls);
  const open = async (page) => {
    await page.goto('/?demo&debug#/');
    await page.waitForFunction(() => window.__app?.map);
    await spyMap(page);
    await page.evaluate(() => { location.hash = '#/trip?stop=1011'; });
    await expect(chips(page).first()).toBeVisible();
    await expect.poll(async () => (await calls(page)).some((c) => c.k === 'setMarkers' && c.id === 'trip')).toBe(true);
  };

  test('opening a trip draws trip- overlays and the trip markers, and fits the map once', async ({ page, net }) => {
    await open(page);
    const c = await calls(page);
    expect(c.some((x) => x.k === 'setOverlay' && /^trip-\d+$/.test(x.id))).toBe(true);
    expect(c.filter((x) => x.k === 'fitTo').length).toBe(1);
    // the drawing asks nothing of anyone: no new blocked request once the plan is on screen
    const before = net.blocked.length;
    await page.waitForTimeout(500);
    expect(net.blocked.slice(before).filter((u) => !/routing\.openstreetmap\.de|openfreemap/.test(u))).toEqual([]);
  });

  test('a tap on the second option redraws the trip and fits again', async ({ page }) => {
    await open(page);
    test.skip(await chips(page).count() < 2, 'one option only');
    const rides = async () => (await calls(page)).filter((x) => x.k === 'setOverlay').map((x) => x.fc).join('|');
    const n = (await calls(page)).length;
    const was = await rides();
    await chips(page).nth(1).click();
    await expect.poll(async () => (await calls(page)).slice(n).some((x) => x.k === 'fitTo')).toBe(true);
    const after = (await calls(page)).slice(n);
    expect(after.some((x) => x.k === 'setMarkers' && x.id === 'trip')).toBe(true);
    expect(await rides()).not.toBe(was);
  });

  test('leaving the trip clears every trip- overlay and the trip markers', async ({ page }) => {
    await open(page);
    const drawn = new Set((await calls(page)).filter((x) => x.k === 'setOverlay' && /^trip-/.test(x.id)).map((x) => x.id));
    const n = (await calls(page)).length;
    await page.evaluate(() => { location.hash = '#/'; });
    await expect(page.locator('.tripv')).toHaveCount(0);
    const after = (await calls(page)).slice(n);
    for (const id of drawn) expect(after.some((x) => x.k === 'clearOverlay' && x.id === id), id).toBe(true);
    expect(after.some((x) => x.k === 'clearMarkers' && x.id === 'trip')).toBe(true);
  });
});
