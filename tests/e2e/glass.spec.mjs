// TEL-83: the glass prototype only turns on with ?glass (css/glass.css + js/glass.js), keeps LIVE and scheduled apart,
// and falls back to solid, static surfaces with prefers-contrast: more (reduced transparency has no Playwright
// emulation; it shares the same variables and the same early return in js/glass.js).
import { test, expect } from './mock.mjs';

const sheetFilter = (page) => page.evaluate(() => getComputedStyle(document.querySelector('.sheet')).backdropFilter);

test('glass: off by default, on with ?glass', async ({ page }) => {
  await page.goto('/?demo#/stop/1011');
  await expect(page.locator('.stopv .atile:not(.atile-skel)').first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.classList.contains('glass'))).toBe(false);
  expect(await sheetFilter(page)).toContain('blur(20px)');
  expect(await page.evaluate(() => !!document.querySelector('script[src="js/glass.js"]') || document.documentElement.classList.contains('glass-lens'))).toBe(false);

  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?glass&demo#/stop/1011');
  await expect(page.locator('.stopv .atile:not(.atile-skel)').first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.classList.contains('glass'))).toBe(true);
  // Chromium: refraction filter in front of the blur
  await expect(page.locator('html.glass-lens')).toHaveCount(1);
  expect(await sheetFilter(page)).toMatch(/^url\("#g-lens-lg"\) blur\(14px\)/);
  // the sticky chip bar has no band at rest; its blur layer shows only once the list scrolls under it
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('.stopv-chipbar')).backgroundImage)).toBe('none');
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('.stopv-chipbar'), '::before').backdropFilter)).toContain('blur(');
  await page.evaluate(() => { document.getElementById('sheet-body').scrollTop = 120; });
  await expect(page.locator('.sheet.g-scrolled')).toHaveCount(1);
  await page.evaluate(() => { document.getElementById('sheet-body').scrollTop = 0; });
  await expect(page.locator('.sheet.g-scrolled')).toHaveCount(0);
  // the menu morphs out of the ☰ button: clipped and moved while it opens, plain when open
  await page.click('#menu-btn');
  await expect(page.locator('#menu-pop')).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.getElementById('menu-pop').style.clipPath)).toMatch(/^inset\(0px round \d/);
  await page.keyboard.press('Escape');
  await expect(page.locator('#menu-pop')).toBeHidden();
  // a press lights the glass up and grows it, release lets it go
  const fab = page.locator('#locate-btn');
  const box = await fab.boundingBox();
  await page.mouse.move(box.x + 10, box.y + 10);
  await page.mouse.down();
  await expect(fab).toHaveClass(/g-press/);
  // touch & hold: it grows (Web Animations on `scale`)
  await expect.poll(() => fab.evaluate((el) => parseFloat(getComputedStyle(el).scale) || 1)).toBeGreaterThan(1.02);
  await page.mouse.move(5, 300);
  await page.mouse.up();
  await expect(fab).not.toHaveClass(/g-press/);
  expect(errors).toEqual([]);
  // tiles inside the sheet are tinted, never a second blur
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('.stopv .atile')).backdropFilter)).toBe('none');
  // LIVE and scheduled still differ in stripe, countdown and pill (same check as smoke.spec.mjs)
  const look = (sel) => page.locator(sel).first().evaluate((el) => {
    const cs = (q) => getComputedStyle(q ? el.querySelector(q) : el);
    return { stripe: cs().borderLeftColor, num: cs('.atile-num').color, pill: cs('.atile-flag').backgroundColor, pillText: cs('.atile-flag').color };
  });
  const [l, s] = [await look('.atile-live'), await look('.atile-sched')];
  for (const k of Object.keys(l)) expect(l[k], `${k} colour`).not.toBe(s[k]);
});

test('glass: solid surfaces with prefers-contrast: more', async ({ page }) => {
  await page.emulateMedia({ contrast: 'more' });
  await page.goto('/?glass&demo#/stop/1011');
  await expect(page.locator('.stopv .atile:not(.atile-skel)').first()).toBeVisible();
  expect(await sheetFilter(page)).toBe('none');
  await expect(page.locator('html.glass-lens')).toHaveCount(0);
  const bg = await page.evaluate(() => getComputedStyle(document.querySelector('.sheet')).backgroundColor);
  expect(bg).not.toMatch(/rgba\(.*, 0\.\d+\)|color\(srgb .* \/ 0\.\d+\)/);
});
