// TEL-48: controls drawn smaller than 44 px still have a 44 px tap area (a transparent ::after, app.css "hit area").
// The probe point sits 1 px inside the extended edge, outside the visible box: the control must be what is hit there.
import { test, expect } from './mock.mjs';

const CONTROLS = ['.stopv-refresh', '.stopv-chip'];

for (const sel of CONTROLS) {
  test(`stop view: ${sel} can be tapped anywhere in a 44 px high area`, async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 5000 }); // very tall, so the whole sheet (list, chips, footer) is on screen whatever the demo list length
    await page.goto('/?demo#/stop/1011');
    const el = page.locator(`.stopv ${sel}`).first();
    await expect(el).toBeVisible();
    const box = await el.boundingBox();
    expect(box.height, `${sel} drawn height`).toBeLessThan(44);
    const grow = (44 - box.height) / 2;
    for (const y of [box.y - grow + 1, box.y + box.height + grow - 1]) {
      const hit = await page.evaluate(([x, py, s]) => document.elementFromPoint(x, py)?.closest(s) != null, [box.x + box.width / 2, y, sel]);
      expect(hit, `${sel} hit at y=${Math.round(y)}`).toBe(true);
    }
  });
}
