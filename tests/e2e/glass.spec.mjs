// TEL-83: the glass UI (css/glass.css + js/glass.js) is on for everyone, keeps LIVE and scheduled apart,
// and falls back to solid, static surfaces with prefers-contrast: more (reduced transparency has no Playwright
// emulation; it shares the same variables and the same early return in js/glass.js).
import { test, expect } from './mock.mjs';

const sheetFilter = (page) => page.evaluate(() => getComputedStyle(document.querySelector('.sheet')).backdropFilter);

test('glass: on by default', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?demo#/stop/1011');
  await expect(page.locator('.stopv .atile:not(.atile-skel)').first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.classList.contains('glass'))).toBe(true);
  // Chromium: refraction filter in front of the blur
  await expect(page.locator('html.glass-lens')).toHaveCount(1);
  expect(await sheetFilter(page)).toMatch(/^url\("#g-lens-lg"\) blur\(14px\)/);
  // the sticky chip bar has no band at rest; its blur layer shows only once the list scrolls under it
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('.stopv-chipbar')).backgroundImage)).toBe('none');
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('.stopv-chipbar'), '::before').backdropFilter)).toContain('blur(');
  await page.evaluate(() => { document.getElementById('sheet-body').scrollTop = 120; });
  await expect(page.locator('.sheet.g-scrolled')).toHaveCount(1);
  await page.evaluate(() => { document.getElementById('sheet-body').scrollTop = 0; });
  await expect(page.locator('.sheet.g-scrolled')).toHaveCount(0);
  // the menu morphs out of the ☰ button: clipped and moved while it opens, plain when open
  await page.click('#menu-btn');
  await expect(page.locator('#menu-pop')).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.getElementById('menu-pop').style.clipPath)).toMatch(/^inset\(0px round \d/);
  // …and ☰ has turned into ✕ (and back after closing)
  const icons = () => page.evaluate(() => ['.icon-menu', '.g-x'].map((q) => getComputedStyle(document.querySelector(`#menu-btn ${q}`)).opacity).join(' '));
  await expect.poll(icons).toBe('0 1');
  await page.keyboard.press('Escape');
  await expect(page.locator('#menu-pop')).toBeHidden();
  await expect.poll(icons).toBe('1 0');
  // the stop's ⋯ menu morphs the same way: ⋯ turns into ˄ while open, and the menu is hidden only after it shrank back
  await page.click('.stopv-more-btn');
  await expect(page.locator('.stopv-menu')).toBeVisible();
  await expect(page.locator('.stopv-more-btn')).toHaveClass(/g-open/);
  await page.click('.stopv-more-btn');
  await expect(page.locator('.stopv-more-btn')).not.toHaveClass(/g-open/);
  await expect(page.locator('.stopv-menu')).toBeHidden();
  // line chips: one glass lens sits on the selected chip and follows the selection
  const lensOn = () => page.evaluate(() => { const l = document.querySelector('.g-lens').getBoundingClientRect(); const c = document.querySelector('.stopv-chip.on').getBoundingClientRect(); return Math.abs(l.left - c.left) < 2 && Math.abs(l.width - c.width) < 2; });
  await expect.poll(lensOn).toBe(true);
  await page.locator('.stopv-chip').nth(1).click();
  await expect(page.locator('.stopv-chip').nth(1)).toHaveClass(/\bon\b/);
  await expect.poll(lensOn).toBe(true);
  await page.locator('.stopv-chip').first().click();
  // a press lights the glass up and grows it, release lets it go
  const fab = page.locator('#locate-btn');
  const restBg = await fab.evaluate((el) => getComputedStyle(el).backgroundColor);
  const box = await fab.boundingBox();
  await page.mouse.move(box.x + 10, box.y + 10);
  await page.mouse.down();
  await expect(fab).toHaveClass(/g-press/);
  // touch & hold: it grows (Web Animations on `scale`)
  await expect.poll(() => fab.evaluate((el) => parseFloat(getComputedStyle(el).scale) || 1)).toBeGreaterThan(1.02);
  // …and fills with the app's blue while held (even over :hover, which iOS keeps), then sends out a ring on a tap
  // (the browser may report the blue in any colour space, so check the white icon on it and that the fill changed)
  await expect.poll(() => fab.evaluate((el) => getComputedStyle(el).color)).toBe('rgb(255, 255, 255)'); // after its .15s transition
  expect(await fab.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(restBg);
  await page.mouse.move(5, 300);
  await page.mouse.up();
  await expect(fab).not.toHaveClass(/g-press/);
  await fab.click();
  await expect(fab).toHaveClass(/g-ping/);
  expect(errors).toEqual([]);
  // tiles inside the sheet are tinted, never a second blur
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('.stopv .atile')).backdropFilter)).toBe('none');
  // LIVE and scheduled still differ in stripe, countdown and pill (same check as smoke.spec.mjs)
  const look = (sel) => page.locator(sel).first().evaluate((el) => {
    const cs = (q) => getComputedStyle(q ? el.querySelector(q) : el);
    return { stripe: cs().borderLeftColor, num: cs('.atile-num').color, pill: cs('.atile-flag').backgroundColor, pillText: cs('.atile-flag').color };
  });
  const [l, s] = [await look('.atile-live'), await look('.atile-sched')];
  for (const k of Object.keys(l)) expect(l[k], `${k} colour`).not.toBe(s[k]);
});

test('glass: solid surfaces with prefers-contrast: more', async ({ page }) => {
  await page.emulateMedia({ contrast: 'more' });
  await page.goto('/?demo#/stop/1011');
  await expect(page.locator('.stopv .atile:not(.atile-skel)').first()).toBeVisible();
  expect(await sheetFilter(page)).toBe('none');
  await expect(page.locator('html.glass-lens')).toHaveCount(0);
  const bg = await page.evaluate(() => getComputedStyle(document.querySelector('.sheet')).backgroundColor);
  expect(bg).not.toMatch(/rgba\(.*, 0\.\d+\)|color\(srgb .* \/ 0\.\d+\)/);
});

test('glass: no shine under the finger; round buttons pop out unclipped; rows get a highlight, not grey', async ({ page }) => {
  await page.goto('/?demo#/lines');
  await expect(page.locator('.lines-row').first()).toBeVisible();
  // a pressed round button grows a lot and stays inside the sheet's scroller (the sheet leaves room above its first row)
  const back = page.locator('#sheet .ex-head > .btn.round');
  const box = await back.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y - 30, { steps: 4 });
  await expect.poll(() => back.evaluate((el) => parseFloat(getComputedStyle(el).scale) || 1)).toBeGreaterThan(1.2);
  const fits = await page.evaluate(() => document.querySelector('#sheet .ex-head > .btn.round').getBoundingClientRect().top - document.getElementById('sheet-body').getBoundingClientRect().top);
  expect(fits).toBeGreaterThanOrEqual(0);
  // no light under the finger: no gradient image, no finger position variables
  expect(await back.evaluate((el) => getComputedStyle(el).backgroundImage)).toBe('none');
  expect(await back.evaluate((el) => el.style.getPropertyValue('--gx'))).toBe('');
  // pressed above its neighbours
  expect(await back.evaluate((el) => parseInt(getComputedStyle(el).zIndex, 10))).toBeGreaterThan(1);
  await page.mouse.up();

  // a list row does not grow and does not turn grey: a soft highlight fades in behind it instead
  await page.goto('/?demo#/lines');
  const row = page.locator('a.lines-row').first();
  await expect(row).toBeVisible();
  const r = await row.boundingBox();
  await page.mouse.move(r.x + 100, r.y + r.height / 2);
  await page.mouse.down();
  await expect(row).toHaveClass(/g-press/);
  await expect.poll(() => row.evaluate((el) => getComputedStyle(el, '::before').opacity)).toBe('1');
  expect(await row.evaluate((el) => getComputedStyle(el).scale)).toBe('none');
  expect(await row.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
  await page.mouse.up();
});

test('glass: the sheet has five stops', async ({ page }) => {
  const visited = async (url, taps) => {
    await page.goto(url);
    await expect(page.locator('.stopv .atile:not(.atile-skel)').first()).toBeVisible();
    const seen = new Set();
    for (let i = 0; i < taps; i++) {
      await page.locator('#sheet-handle').dispatchEvent('click'); // a tap walks the stops (the sheet may still be settling)
      await page.waitForTimeout(150);
      seen.add(await page.evaluate(() => document.getElementById('sheet').dataset.state));
    }
    return [...seen].sort();
  };
  expect(await visited('/?demo#/stop/1011', 7)).toEqual(['full', 'half', 'high', 'low', 'peek']);
});
