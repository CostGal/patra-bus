// The stop's "Οδηγίες ως εδώ" pill: the walk from where you are to the stop (js/arrivals-view.js, js/walk.js).
// The mocks block OSRM, so the distance and time are the on-device estimate; the request itself is checked here:
// it goes to the routing server only, with the two ends of the walk at 5 decimals (CLAUDE.md rule 6).
import { test, expect } from './mock.mjs';

test.describe('directions', () => {
  test.use({ permissions: ['geolocation'], geolocation: { latitude: 38.2466123, longitude: 21.7346123 } });
  test('stop: the directions pill shows the walk from the device to the stop', async ({ page }) => {
    const asked = [];
    page.on('request', (r) => { if (/routed-foot/.test(r.url())) asked.push(r.url()); });
    await page.goto('/?demo#/stop/1011');
    await page.locator('.stopv-pill.primary').click();
    await expect(page.locator('#toasts')).toContainText(/με τα πόδια/);
    expect(asked.length).toBeLessThanOrEqual(1);
    for (const u of asked) {
      expect(new URL(u).hostname).toBe('routing.openstreetmap.de');
      expect(u).toMatch(/\/21\.73461,38\.24661;\d+\.\d{5},\d+\.\d{5}\?/);
    }
    expect(page.url()).not.toMatch(/38\.2466|21\.7346/); // the position never goes into the app's URL
  });
});
