// TEL-232: the home in the sheet (Apple Maps search mode): Places at mid, the first recent whole and the second 20% in,
// favourites with their next arrival at up.
import { test, expect } from './mock.mjs';

const seed = (page) => page.addInitScript(() => {
  if (sessionStorage.getItem('home-seeded')) return;
  sessionStorage.setItem('home-seeded', '1');
  localStorage.setItem('patra-bus:places', JSON.stringify([{ id: 'home', name: 'Σπίτι', lat: 38.2466, lng: 21.7346 }, { id: 'gym', name: 'Γυμναστήριο', lat: 38.25, lng: 21.74 }]));
  const st = JSON.parse(localStorage.getItem('patra-bus:v2') || '{}');
  st.v = 3;
  st.favorites = [{ code: '1011', city: 'patra' }];
  st.recents = { stop: [{ code: '1011', city: 'patra' }, { code: '1012', city: 'patra' }, { code: '1013', city: 'patra' }], place: [] };
  localStorage.setItem('patra-bus:v2', JSON.stringify(st));
});

test('home: Places as round buttons, then recents; mid ends 20% into the second recent', async ({ page }) => {
  await seed(page);
  await page.goto('/?demo&debug#/');
  const places = page.locator('.hm-place');
  await expect(places).toHaveCount(4); // Σπίτι (set), Δουλειά (empty), Γυμναστήριο, +
  await expect(places.nth(0)).toHaveAttribute('href', /#\/pin\?lat=38\.24660&lng=21\.73460/);
  await expect(places.nth(1)).toHaveClass(/is-empty/);
  await expect(places.nth(1)).toHaveAttribute('href', /#\/place\?id=work/);
  await expect(places.nth(3)).toHaveAttribute('href', /#\/place\?id=new/);
  await expect(places.nth(3)).toHaveClass(/is-add/);
  await expect(page.locator('.home-recents .stop-row')).toHaveCount(3);
  await page.evaluate(() => window.__app.sheet.snap('half', { animate: false }));
  await page.waitForTimeout(300);
  const r = await page.evaluate(() => {
    const cut = innerHeight - 8;
    const [a, b] = [...document.querySelectorAll('.home-recents .stop-row')].map((x) => x.getBoundingClientRect());
    return { firstWhole: a.bottom <= cut + 1, share: (cut - b.top) / b.height };
  });
  expect(r.firstWhole).toBe(true);
  expect(r.share).toBeGreaterThan(0.05);
  expect(r.share).toBeLessThan(0.45);
});

test('home: the empty place opens its panel in the sheet; ✓ saves it and goes back home (TEL-239)', async ({ page }) => {
  await seed(page);
  await page.goto('/?demo&debug#/');
  await page.locator('.hm-place.is-empty').click();
  await expect(page).toHaveURL(/#\/place\?id=work/);
  await expect(page.locator('.plc-title')).toHaveText('Όρισε τη Δουλειά');
  const ok = page.locator('.plc-ok');
  await expect(ok).toBeDisabled();
  await page.locator('#plc-q').fill('Πανεπιστημίου');
  await page.locator('.plc-sr').first().click();
  await expect(ok).toBeEnabled();
  await ok.click();
  await expect(page.locator('.hm-place').nth(1)).toHaveClass(/is-set/);
  const work = await page.evaluate(() => JSON.parse(localStorage.getItem('patra-bus:places')).find((p) => p.id === 'work'));
  expect(work?.name).toBe('Δουλειά');
});

test('home: touch & hold on a set place opens «Διαδρομή / Αλλαγή / Διαγραφή» (TEL-239)', async ({ page }) => {
  await seed(page);
  await page.goto('/?demo&debug#/');
  await page.locator('.hm-place.is-set').first().click({ button: 'right' });
  const items = page.locator('.hm-menu .pop-item');
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toHaveAttribute('href', /#\/trip\?lat=38\.24660&lng=21\.73460/);
  await expect(items.nth(1)).toHaveAttribute('href', /#\/place\?id=home/);
  await items.nth(2).click();
  await expect(page.locator('.hm-menu')).toHaveCount(0);
  await expect(page.locator('.hm-place').nth(0)).toHaveClass(/is-empty/);
});

test('home: favourites show their next arrival only when the sheet is up', async ({ page }) => {
  await seed(page);
  await page.goto('/?demo&debug#/');
  await expect(page.locator('.hm-fav')).toHaveCount(1);
  await page.waitForTimeout(500);
  await expect(page.locator('.hm-fav .atile')).toHaveCount(0); // not polled while the sheet is at low/mid
  await page.evaluate(() => window.__app.sheet.snap('full', { animate: false }));
  await expect(page.locator('.hm-fav .atile').first()).toBeVisible();
});

test('welcome card: «Στείλε σχόλια» opens the «Πρόταση» form (TEL-385)', async ({ page }) => {
  await page.goto('/?demo&welcome#/');
  await page.locator('.wl-link').click();
  await expect.poll(() => page.evaluate(() => location.hash)).toMatch(/#\/report\?kind=idea$/);
  await expect(page.locator('.rp-text')).toBeVisible();
});
