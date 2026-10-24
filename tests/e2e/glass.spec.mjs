// TEL-83: the glass prototype only turns on with ?glass, keeps LIVE and scheduled apart, and falls back to solid
// surfaces with prefers-contrast: more (reduced transparency has no Playwright emulation; it shares the same variables).
import { test, expect } from './mock.mjs';

const sheetFilter = (page) => page.evaluate(() => getComputedStyle(document.querySelector('.sheet')).backdropFilter);

test('glass: off by default, on with ?glass', async ({ page }) => {
  await page.goto('/?demo#/stop/1011');
  await expect(page.locator('.stopv .atile:not(.atile-skel)').first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.classList.contains('glass'))).toBe(false);
  expect(await sheetFilter(page)).toContain('blur(20px)');

  await page.goto('/?glass&demo#/stop/1011');
  await expect(page.locator('.stopv .atile:not(.atile-skel)').first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.classList.contains('glass'))).toBe(true);
  expect(await sheetFilter(page)).toContain('blur(28px)');
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
  const bg = await page.evaluate(() => getComputedStyle(document.querySelector('.sheet')).backgroundColor);
  expect(bg).not.toMatch(/rgba\(.*, 0\.\d+\)|color\(srgb .* \/ 0\.\d+\)/);
});
