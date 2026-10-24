// TEL-49: LIVE vs scheduled in forced-colors (high contrast) mode. (The stop-view legend it also covered went in TEL-65.)
import { test, expect } from './mock.mjs';

test('forced colors: LIVE and scheduled still differ (fill, dot, stripe)', async ({ page }) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await page.goto('/?demo#/stop/1011');
  const live = page.locator('.stopv .atile-live').first();
  const sched = page.locator('.stopv .atile-sched').first();
  await expect(live).toBeVisible();
  await expect(sched).toBeVisible();
  const look = (tile) => tile.evaluate((el) => {
    const cs = (q) => getComputedStyle(q ? el.querySelector(q) : el);
    return { stripe: cs().borderLeftWidth + cs().borderLeftStyle, fill: cs('.atile-flag').backgroundColor, border: cs('.atile-flag').borderTopStyle,
      dot: el.querySelector('.atile-dot') ? cs('.atile-dot').backgroundColor : null };
  });
  const [l, s] = [await look(live), await look(sched)];
  expect(l.stripe).not.toBe(s.stripe);
  expect(l.fill).not.toBe(s.fill);
  expect(l.border).not.toBe(s.border);
  expect(l.dot, 'the dot must be drawn in a colour that differs from the LIVE fill').not.toBe(l.fill);
});
