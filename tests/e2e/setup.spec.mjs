// TEL-74: the first-run setup (language, city, LIVE / ΠΡΟΓΡ.). Every other spec skips it (mock.mjs, firstRun: false).
import { test, expect } from './mock.mjs';

test.use({ firstRun: true });

const settings = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('patra-bus:v2') || '{}').settings || {});

test('setup: three steps, language switch, then never again', async ({ page }) => {
  await page.goto('/');
  const dlg = page.getByRole('dialog');
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText('Βήμα 1 από 3');
  // the page locale is el-GR, so Greek is pre-selected
  await expect(dlg.getByRole('button', { name: 'Ελληνικά' })).toHaveAttribute('aria-pressed', 'true');
  await dlg.getByRole('button', { name: 'English' }).click();
  await expect(dlg).toContainText('Step 1 of 3');
  await expect(dlg.getByRole('heading')).toHaveText('Welcome to Telematica');
  await dlg.getByRole('button', { name: 'Next' }).click();
  await expect(dlg).toContainText('Which city?');
  await expect(dlg.getByRole('button', { name: 'Patras' })).toHaveAttribute('aria-pressed', 'true');
  await dlg.getByRole('button', { name: 'Next' }).click();
  await expect(dlg).toContainText('LIVE or SCHED.?');
  await expect(dlg.locator('.atile-live')).toHaveCount(1);
  await expect(dlg.locator('.atile-sched')).toHaveCount(1);
  await dlg.getByRole('button', { name: 'Let’s go' }).click();
  await expect(dlg).toBeHidden();
  expect(await settings(page)).toMatchObject({ lang: 'en', setupDone: true });
  await page.reload();
  await expect(page.locator('#sheet-content')).not.toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('.su')).toHaveCount(0);
});

test('setup: picking another city reloads on that city', async ({ page }) => {
  await page.goto('/');
  const dlg = page.getByRole('dialog');
  await dlg.getByRole('button', { name: 'Επόμενο' }).click();
  await dlg.getByRole('button', { name: 'Κέρκυρα' }).click();
  await dlg.getByRole('button', { name: 'Παράλειψη' }).click();
  await page.waitForURL(/#\/corfu\//);
  expect(await settings(page)).toMatchObject({ city: 'corfu', setupDone: true });
  await expect(page.locator('.su')).toHaveCount(0);
});

test('setup: not over a shared link, Esc skips and keeps Greek', async ({ page }) => {
  await page.goto('/?demo#/stop/1011');
  await expect(page.locator('.stopv .atile').first()).toBeVisible();
  await expect(page.locator('.su')).toHaveCount(0);
  await page.goto('/');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.su')).toHaveCount(0);
  const s = await settings(page);
  expect(s.setupDone).toBe(true);
  expect(s.lang).toBeUndefined(); // the default (Greek) applies
});

test('setup: kit header, same card height on every step, button on screen on a small phone (TEL-247)', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/');
  const dlg = page.getByRole('dialog');
  await expect(dlg).toBeVisible();
  const card = dlg.locator('.su-card');
  await expect(card.locator('.su-head .g-circle')).toHaveCount(2);
  const back = dlg.locator('.su-back');
  await expect(back).toBeHidden(); // keeps its place, not shown on step 1
  await expect(dlg.getByRole('button', { name: 'Παράλειψη' })).toBeVisible();
  const heights = [];
  for (let i = 0; i < 3; i++) {
    await expect(dlg.getByText(`Βήμα ${i + 1} από 3`)).toHaveCount(1);
    await page.waitForTimeout(450); // the card's rise and the step's slide settle
    heights.push((await card.boundingBox()).height);
    const next = dlg.locator('.su-next');
    const box = await next.boundingBox();
    expect(box.y + box.height, `next button inside the screen on step ${i + 1}`).toBeLessThanOrEqual(568);
    if (i === 1) await expect(back).toBeVisible();
    if (i < 2) await next.click();
  }
  expect(new Set(heights.map(Math.round)).size, `card heights ${heights}`).toBe(1);
});

test.describe('setup on a phone that is not in Greek (TEL-247, D1)', () => {
  test.use({ locale: 'en-US' });
  test('opens in the phone\'s language; Esc keeps English', async ({ page }) => {
    await page.goto('/');
    const dlg = page.getByRole('dialog');
    await expect(dlg).toContainText('Step 1 of 3');
    await expect(dlg.getByRole('button', { name: 'English' })).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
    await expect(page.locator('.su')).toHaveCount(0);
    expect(await settings(page)).toMatchObject({ lang: 'en', setupDone: true });
  });
});
