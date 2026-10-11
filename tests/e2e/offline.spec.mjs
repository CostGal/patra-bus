// After one online visit the service worker serves the app shell (and the stops data) with the network gone.
import { test, expect } from './mock.mjs';

test.use({ serviceWorkers: 'allow' });

test('app shell loads offline after the first visit', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.getByText('Telematica · Πάτρα')).toBeVisible();
  // Installed (shell precached) and controlling this page (clients.claim on activate).
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);

  await context.setOffline(true);
  const res = await page.reload();
  expect(res.fromServiceWorker(), 'the navigation is answered by the service worker').toBe(true);
  expect(await page.evaluate(() => navigator.onLine)).toBe(false);

  await expect(page.getByText('Telematica · Πάτρα')).toBeVisible();
  await expect(page.locator('#search-input')).toBeVisible();
  // Static data came from the cache too: stop search still works.
  await page.locator('#search-input').fill('πανεπιστημιου αρεθα');
  await expect(page.getByRole('option').filter({ hasText: '#1011' })).toBeVisible();
});
