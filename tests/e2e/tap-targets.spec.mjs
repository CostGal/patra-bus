// TEL-48: controls drawn smaller than 44 px still have a 44 px tap area (a transparent ::after, app.css "hit area").
// The probe point sits 1 px inside the extended edge, outside the visible box: the control must be what is hit there.
// Measuring and probing happen in ONE page.evaluate, after the list has rendered: the demo list arrives ~250 ms after load and moves the
// footer, so a measure-then-probe across two round trips raced with it in CI.
import { test, expect } from './mock.mjs';

const CONTROLS = ['.stopv-refresh', '.stopv-chip', '.stopv-pill']; // .stopv-pill: TEL-227

for (const sel of CONTROLS) {
  test(`stop view: ${sel} can be tapped anywhere in a 44 px high area`, async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 5000 }); // very tall, so the whole sheet (list, chips, footer) is on screen whatever the demo list length
    await page.goto('/?demo#/stop/1011');
    await expect(page.locator('.stopv .atile:not(.atile-skel)').first()).toBeVisible();
    await expect(page.locator(`.stopv ${sel}`).first()).toBeVisible();
    const r = await page.evaluate((s) => {
      const el = document.querySelector(`.stopv ${s}`);
      const b = el.getBoundingClientRect();
      const grow = (44 - b.height) / 2;
      const hit = (y) => document.elementFromPoint(b.x + b.width / 2, y)?.closest(s) != null;
      return { height: b.height, top: hit(b.y - grow + 1), bottom: hit(b.y + b.height + grow - 1), y: Math.round(b.y) };
    }, sel);
    expect(r.height, `${sel} drawn height`).toBeLessThan(44);
    expect(r.top, `${sel} hit just above the box (y=${r.y})`).toBe(true);
    expect(r.bottom, `${sel} hit just below the box (y=${r.y})`).toBe(true);
  });
}
