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
  expect(await settings(page)).toMatchObject({ lang: 'en', setupDone: true, guideSeen: true });
  await expect(page.locator('.guide-hint-go')).toHaveCount(0); // no "first time here?" card after the setup
  await page.reload();
  await expect(page.locator('#sheet-content')).not.toContainText('Loading…');
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
