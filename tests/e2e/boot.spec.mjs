// TEL-255: the boot screen (logo in motion) on a cold start at home. Every other spec skips it (mock.mjs, boot: false).
import { test, expect } from './mock.mjs';

test.use({ boot: true });

const isBoot = (page) => page.evaluate(() => document.documentElement.classList.contains('boot'));
// 1.7 s on a phone (TEL-365: the landing takes 510 ms); the margin is for many browsers starting at once on one machine.
const LEAVES_MS = 3500;

// TEL-365: the stop a cold start opens. What it opens by itself is not saved (CLAUDE.md rule 6).
const savedRecents = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('patra-bus:v2')).recents.stop);

test('boot: with a favourite it opens that stop, and the stop does not become a recent', async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    const b = JSON.parse(localStorage.getItem('patra-bus:v2'));
    b.favorites = [{ code: '1011', city: 'patra' }];
    localStorage.setItem('patra-bus:v2', JSON.stringify(b));
  });
  await page.goto('/?demo');
  await expect(page.locator('.stopv .atile').first()).toBeVisible();
  await expect(page).toHaveURL(/#\/stop\/1011$/);
  await expect(page.locator('#boot')).toHaveCount(0, { timeout: LEAVES_MS });
  expect(await savedRecents(page)).toEqual([]);
});

test('boot: with nothing known it stays on home', async ({ page }) => {
  await page.goto('/?demo');
  await expect(page.locator('#boot')).toHaveCount(0, { timeout: LEAVES_MS });
  expect(new URL(page.url()).hash).not.toContain('stop');
});

test.describe('location already allowed', () => {
  test.use({ geolocation: { latitude: 38.26617, longitude: 21.75682 }, permissions: ['geolocation'] });
  test('boot: opens the nearest stop; its code is in the URL, the coordinates nowhere', async ({ page }) => {
    await page.goto('/?demo');
    await expect(page.locator('.stopv .atile').first()).toBeVisible();
    await expect(page).toHaveURL(/#\/stop\/1011$/);
    expect(page.url()).not.toContain('38.26');
    expect(await savedRecents(page)).toEqual([]);
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }));
    expect(stored).not.toContain('38.26');
  });
});

test('boot: shows on home, leaves on time, the app is usable', async ({ page }) => {
  await page.goto('/', { waitUntil: 'commit' });
  await expect(page.locator('#boot')).toBeVisible();
  await expect(page.locator('#boot .boot-word')).toHaveText('Telematica');
  await expect(page.locator('#boot')).toHaveCount(0, { timeout: LEAVES_MS });
  expect(await isBoot(page)).toBe(false);
  await expect(page.locator('#sheet-content')).not.toHaveAttribute('aria-busy', 'true');
  await page.locator('#menu-btn').click();
  await expect(page.locator('#menu-pop')).toBeVisible();
});

test('boot: a tap skips it at once', async ({ page }) => {
  await page.goto('/?boot=hold#/', { waitUntil: 'commit' }); // held: only the tap can end it
  await expect(page.locator('#boot')).toBeVisible();
  await page.waitForTimeout(300);
  await page.locator('#boot').tap();
  await expect(page.locator('#boot')).toHaveCount(0, { timeout: 500 });
});

test('boot: never on a deep link', async ({ page }) => {
  await page.goto('/?demo#/stop/1011');
  await expect(page.locator('.stopv .atile').first()).toBeVisible();
  expect(await page.evaluate(() => window.__boot)).toBeUndefined();
  await expect(page.locator('#boot')).toHaveCount(0);
});

test('boot: not again after a reload in the same tab', async ({ page }) => {
  await page.goto('/', { waitUntil: 'commit' });
  await expect(page.locator('#boot')).toBeVisible();
  await expect(page.locator('#boot')).toHaveCount(0, { timeout: LEAVES_MS });
  await page.reload();
  expect(await page.evaluate(() => window.__boot)).toBeUndefined();
  expect(await isBoot(page)).toBe(false);
});

test('boot: an error is not left covered (data fails to load)', async ({ page }) => {
  await page.route(/\/data\/stops\.json/, (route) => route.abort());
  await page.goto('/', { waitUntil: 'commit' });
  await expect(page.locator('#boot')).toBeVisible();
  await expect(page.locator('#boot')).toHaveCount(0, { timeout: LEAVES_MS });
  await expect(page.locator('#sheet-content .btn')).toBeVisible(); // the error state's retry button
});

test('boot: the CSS failsafe hides it at 5 s when the modules never run', async ({ page }) => {
  await page.route(/\/js\/app\.js/, (route) => route.abort());
  await page.goto('/', { waitUntil: 'commit' });
  await expect(page.locator('#boot')).toBeVisible();
  await expect(page.locator('#boot')).toBeHidden({ timeout: 6500 });
});

test.describe('first run', () => {
  test.use({ firstRun: true });
  test('boot: the setup dialog appears only once the boot screen starts to leave', async ({ page }) => {
    await page.addInitScript(() => {
      new MutationObserver((list, obs) => {
        for (const m of list) for (const n of m.addedNodes) {
          if (n.classList?.contains('su')) {
            const cl = document.documentElement.classList;
            window.__suAt = { boot: cl.contains('boot'), out: cl.contains('boot-out') };
            obs.disconnect();
          }
        }
      }).observe(document, { childList: true, subtree: true });
    });
    await page.goto('/');
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(await page.evaluate(() => typeof window.__boot)).toBe('object');
    const at = await page.evaluate(() => window.__suAt);
    expect(at.boot === false || at.out === true, JSON.stringify(at)).toBe(true);
  });
});

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });
  test('boot: still logo, no element of #boot has a running transform animation', async ({ page }) => {
    await page.goto('/?boot=hold#/', { waitUntil: 'commit' });
    await expect(page.locator('#boot')).toBeVisible();
    await page.waitForTimeout(200);
    const moving = await page.locator('#boot').evaluate((el) => el.getAnimations({ subtree: true })
      .filter((a) => a.playState === 'running' && a.effect.getKeyframes().some((k) => 'transform' in k))
      .map((a) => a.animationName || 'anim'));
    expect(moving).toEqual([]);
    await page.locator('#boot').tap();
    await expect(page.locator('#boot')).toHaveCount(0, { timeout: 500 });
  });
});

// index.html loads MapLibre with `defer` (TEL-255): it still runs before js/app.js, and a failed load still ends in list mode.
test.describe('MapLibre deferred', () => {
  test.use({ boot: false });
  test('no map: a blocked MapLibre script gives the list mode with its note', async ({ page }) => {
    await page.route(/maplibre-gl\.js/, (route) => route.abort());
    await page.goto('/?demo#/stop/1011');
    await expect(page.locator('#app')).toHaveClass(/no-map/);
    await expect(page.locator('#map-note')).toBeVisible();
    await expect(page.locator('.stopv .atile').first()).toBeVisible();
  });
  test('map: maplibregl is there when the app starts', async ({ page }) => {
    await page.goto('/?demo#/');
    await expect(page.locator('#sheet-content')).not.toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('#app')).not.toHaveClass(/no-map/);
    await expect(page.locator('#map canvas')).toHaveCount(1);
  });
});
