// TEL-52: a LIVE tile whose data is older than the stale threshold stops looking LIVE; scheduled tiles and the list keep their look.
import { test, expect } from './mock.mjs';

const look = (tile) => tile.evaluate((el) => {
  const cs = (q) => getComputedStyle(q ? el.querySelector(q) : el);
  return { stripe: cs().borderLeftColor, num: cs('.atile-num').color, fill: cs('.atile-flag').backgroundColor,
    pulse: el.querySelector('.atile-dot') ? getComputedStyle(el.querySelector('.atile-dot'), '::after').content : null, flag: el.querySelector('.atile-flag').textContent };
});

test('fresh data: LIVE tiles are not aged', async ({ page }) => {
  await page.goto('/?demo#/stop/1011');
  await expect(page.locator('.stopv .atile-live').first()).toBeVisible();
  await expect(page.locator('.stopv .atile-aged')).toHaveCount(0);
});

test('stale data: LIVE tiles age out one by one, the list is not greyed', async ({ page }) => {
  await page.goto('/?demo=stale#/stop/1011');
  const live = page.locator('.stopv .atile-live').first();
  await expect(live).toBeVisible();
  await expect(live).toHaveClass(/\batile-aged\b/);
  await expect(live.locator('.atile-flag')).toContainText('LIVE');
  await expect(live.locator('.atile-age')).toHaveText(/^(\d+″|\d+′)\s*ago$|^πριν/);
  const l = await look(live);
  expect(l.pulse, 'no pulsing dot once aged').toBe('none');
  // it no longer looks like a fresh LIVE tile: neutral stripe, neutral countdown, no solid fill
  const fresh = await (async () => { const p2 = await page.context().newPage(); await p2.goto('/?demo#/stop/1011'); const f = await look(p2.locator('.stopv .atile-live').first()); await p2.close(); return f; })();
  expect(l.stripe).not.toBe(fresh.stripe);
  expect(l.num).not.toBe(fresh.num);
  expect(l.fill).not.toBe(fresh.fill);
  // the whole list is no longer greyed out
  expect(await page.locator('.stopv-list').evaluate((el) => getComputedStyle(el).filter)).toBe('none');
  // scheduled tiles are untouched
  await expect(page.locator('.stopv .atile-sched.atile-aged')).toHaveCount(0);
  // and the stale banner is still there
  await expect(page.locator('.stopv-banner')).toBeVisible();
});
