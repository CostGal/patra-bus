// TEL-49: the LIVE / ΠΡΟΓΡ. legend on the stop view, and LIVE vs scheduled in forced-colors (high contrast) mode.
import { test, expect } from './mock.mjs';

test('legend: shown on the stop view, dismissed for good', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 5000 }); // the legend is a footer line: keep the whole sheet on screen
  await page.goto('/?demo#/stop/1011');
  const legend = page.locator('.stopv-legend');
  await expect(legend).toBeVisible();
  await expect(legend).toContainText('LIVE = το λεωφορείο στέλνει θέση');
  await legend.getByRole('button', { name: 'Κλείσιμο' }).click();
  await expect(legend).toBeHidden();
  await expect(page.locator('.stopv-refresh')).toBeFocused();
  await page.reload();
  await page.setViewportSize({ width: 360, height: 5000 });
  await expect(page.locator('.stopv .atile').first()).toBeVisible();
  await expect(page.locator('.stopv-legend')).toBeHidden();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('patra-bus:v2')).settings.legendSeen)).toBe(true);
});

test('legend: English text', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('patra-bus:v2', JSON.stringify({ v: 3, favorites: [], recents: {}, settings: { lang: 'en' } })));
  await page.goto('/?demo#/stop/1011');
  await expect(page.locator('.stopv-legend')).toContainText('LIVE = the bus is sending its position · SCHED. = timetable time, no position · ′ = minutes, ″ = seconds');
});

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
