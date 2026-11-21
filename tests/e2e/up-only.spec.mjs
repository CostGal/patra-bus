// TEL-352: Settings and Report have no low or mid. A drag down from the top (or a tap on the handle) at up opens
// home at mid in one move. A drag that is only a scroll of the list never closes them.
import { test, expect } from './mock.mjs';

const state = (page) => page.evaluate(() => document.getElementById('sheet').dataset.state);

async function dragDown(page, dy) {
  const h = await page.locator('#sheet-handle').boundingBox();
  const x = h.x + h.width / 2, y0 = h.y + h.height / 2;
  await page.mouse.move(x, y0);
  await page.mouse.down();
  await page.mouse.move(x, y0 + dy, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(700);
}

for (const [name, hash] of [['Settings', '#/settings'], ['Report', '#/report']]) {
  test(`up only: a drag down from ${name} ends on home at mid`, async ({ page }) => {
    await page.goto(`/?demo${hash}`);
    await expect.poll(() => state(page)).toBe('full');
    await dragDown(page, 300);
    expect(await state(page)).toBe('half');
    expect(await page.evaluate(() => location.hash)).toBe('#/');
    await expect(page.locator('.sheet-search, #searchbar').first()).toBeVisible();
  });
}

test('up only: a small drag springs back to up and stays on Settings', async ({ page }) => {
  await page.goto('/?demo#/settings');
  await expect.poll(() => state(page)).toBe('full');
  await dragDown(page, 20);
  expect(await state(page)).toBe('full');
  expect(await page.evaluate(() => location.hash)).toBe('#/settings');
});

test('up only: a tap on the handle from Settings opens home at mid', async ({ page }) => {
  await page.goto('/?demo#/settings');
  await expect.poll(() => state(page)).toBe('full');
  await page.locator('#sheet-handle').click(); // a real tap (dispatchEvent leaves the focus on the page, which reopens the sheet)
  await expect.poll(() => state(page)).toBe('half');
  expect(await page.evaluate(() => location.hash)).toBe('#/');
});

test('up only: other views keep their three states', async ({ page }) => {
  await page.goto('/?demo&debug#/stop/1011');
  await expect(page.locator('.stopv .atile:not(.atile-skel)').first()).toBeVisible();
  await page.evaluate(() => window.__app.sheet.snap('full', { animate: false }));
  await page.waitForTimeout(100);
  await dragDown(page, 160);
  expect(await state(page)).toBe('half');
  expect(await page.evaluate(() => location.hash)).toContain('#/stop/1011');
});
