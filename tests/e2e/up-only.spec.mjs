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

// the card has stopped moving, so the handle is where its box says when the drag begins
const sheetAtRest = (page) => page.waitForFunction(() => new Promise((done) => {
  const s = document.getElementById('sheet');
  let last = s.getBoundingClientRect().top, still = 0, n = 0;
  const loop = () => {
    const top = s.getBoundingClientRect().top;
    still = Math.abs(top - last) < 0.5 ? still + 1 : 0;
    last = top;
    if (still >= 12) done(true); else if (++n > 240) done(false); else requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}));

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

test('up only: --leave is 0 near the top and 1 once the sheet is pulled to half, and the texts blur with it', async ({ page }) => {
  await page.goto('/?demo#/settings');
  await expect.poll(() => state(page)).toBe('full');
  const leave = () => page.evaluate(() => parseFloat(document.getElementById('sheet').style.getPropertyValue('--leave')) || 0);
  expect(await leave()).toBe(0);
  const h = await page.locator('#sheet-handle').boundingBox();
  const x = h.x + h.width / 2, y0 = h.y + h.height / 2;
  await page.mouse.move(x, y0);
  await page.mouse.down();
  await page.mouse.move(x, y0 + 60, { steps: 4 }); // still over 65% of the screen
  await page.waitForTimeout(100);
  expect(await leave()).toBe(0);
  await page.mouse.move(x, y0 + 420, { steps: 8 }); // down to about 45% of the screen
  await expect.poll(leave).toBeGreaterThan(0.9);
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('.sheet-content > .ex-view')).filter)).toContain('blur(');
  await page.mouse.up();
});

for (const [name, dist] of [['short', 110], ['medium', 230], ['long', 380]]) {
  test(`live menu: a ${name} flick glides to mid with the menu's copy, with no jump`, async ({ page }) => {
    await page.goto('/?demo#/settings');
    await expect.poll(() => state(page)).toBe('full');
    await page.waitForTimeout(300); // the copy's parts have loaded
    const h = await page.locator('#sheet-handle').boundingBox();
    const x = h.x + h.width / 2, y0 = h.y + h.height / 2;
    await page.mouse.move(x, y0);
    await page.mouse.down();
    for (let i = 1; i <= 4; i++) { await page.mouse.move(x, y0 + dist * i / 4); await page.waitForTimeout(16); }
    await page.evaluate(() => { // from the release on: the biggest move in one frame, and whether the copy showed
      const s = document.getElementById('sheet');
      window.__flick = { max: 0, copy: false };
      let last = s.getBoundingClientRect().top, n = 0;
      const loop = () => {
        const top = s.getBoundingClientRect().top;
        window.__flick.max = Math.max(window.__flick.max, Math.abs(top - last));
        window.__flick.copy ||= !!document.querySelector('.leave-menu');
        last = top;
        if (++n < 60) requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    });
    await page.mouse.up();
    await expect.poll(() => state(page)).toBe('half');
    await page.waitForTimeout(1000);
    const f = await page.evaluate(() => window.__flick);
    expect(f.copy).toBe(true);
    expect(f.max).toBeLessThan(150); // the old bug moved it 250 to 370 px in one frame
    await expect(page.locator('.leave-menu')).toHaveCount(0);
    await expect(page.locator('#sheet-content .hm-place').first()).toBeVisible();
    expect(await page.evaluate(() => document.getElementById('sheet').classList.contains('up-only'))).toBe(false);
  });
}

// TEL-372: Favourites melts into home's search when swiped from mid to low
test('favourites: a swipe from mid to low ends on home at low with the search', async ({ page }) => {
  await page.goto('/?demo#/favorites');
  await expect(page.locator('.fav-view')).toBeVisible(); // "half" alone is also the sheet before the view has mounted
  await expect.poll(() => state(page)).toBe('half');
  await sheetAtRest(page);
  await dragDown(page, 320);
  await expect.poll(() => state(page)).toBe('peek');
  expect(await page.evaluate(() => location.hash)).toBe('#/');
  await expect(page.locator('#searchbar')).toBeVisible();
  await expect(page.locator('.leave-menu')).toHaveCount(0);
  expect(await page.evaluate(() => document.getElementById('sheet').classList.contains('low-leave'))).toBe(false);
});

test('favourites: the copy follows the finger, and a cancelled swipe stays on Favourites at mid', async ({ page }) => {
  await page.goto('/?demo#/favorites');
  await expect(page.locator('.fav-view')).toBeVisible(); // "half" alone is also the sheet before the view has mounted
  await expect.poll(() => state(page)).toBe('half');
  await page.waitForTimeout(300);
  const leave = () => page.evaluate(() => parseFloat(document.getElementById('sheet').style.getPropertyValue('--leave')) || 0);
  const h = await page.locator('#sheet-handle').boundingBox();
  const x = h.x + h.width / 2, y0 = h.y + h.height / 2;
  await page.mouse.move(x, y0);
  await page.mouse.down();
  await page.mouse.move(x, y0 + 90, { steps: 6 });
  await expect(page.locator('.leave-menu')).toHaveCount(1);
  await expect.poll(leave).toBeGreaterThan(0);
  expect(await leave()).toBeLessThan(1);
  await page.mouse.move(x, y0 + 8, { steps: 6 });
  for (let i = 0; i < 7; i++) { await page.mouse.move(x, y0 + 8 + (i % 2)); await page.waitForTimeout(25); } // the finger rests: no flick up
  await page.mouse.up();
  await expect.poll(() => state(page)).toBe('half');
  await page.waitForTimeout(1000);
  expect(await page.evaluate(() => location.hash)).toContain('favorites');
  await expect(page.locator('.leave-menu')).toHaveCount(0);
  expect(await leave()).toBe(0);
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('.fav-view')).opacity)).toBe('1');
});

test('favourites: with reduced motion the swipe is a plain jump to home at low', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/?demo#/favorites');
  await expect(page.locator('.fav-view')).toBeVisible(); // "half" alone is also the sheet before the view has mounted
  await expect.poll(() => state(page)).toBe('half');
  await sheetAtRest(page);
  await dragDown(page, 320);
  await expect.poll(() => state(page)).toBe('peek');
  expect(await page.evaluate(() => location.hash)).toBe('#/');
  await expect(page.locator('.leave-menu')).toHaveCount(0);
});

test('favourites: a swipe that starts at up does not leave Favourites', async ({ page }) => {
  await page.goto('/?demo&debug#/favorites');
  await expect(page.locator('.fav-view')).toBeVisible();
  await expect.poll(() => state(page)).toBe('half');
  await page.waitForFunction(() => window.__app?.sheet); // the debug handle is set after the first view
  await page.evaluate(() => window.__app.sheet.snap('full', { animate: false }));
  await page.waitForTimeout(100);
  await dragDown(page, 160); // a quick pull may land on mid or low: either way it is still Favourites
  expect(await state(page)).not.toBe('full');
  expect(await page.evaluate(() => location.hash)).toContain('favorites');
  await expect(page.locator('.leave-menu')).toHaveCount(0);
});

test('live menu: a still copy shows under the finger below 65%, goes when pulled back, and the real menu replaces it', async ({ page }) => {
  const calls = [];
  page.on('request', (r) => { if (r.url().includes('/api/')) calls.push(r.url()); });
  await page.goto('/?demo#/settings');
  await expect.poll(() => state(page)).toBe('full');
  const copy = page.locator('.leave-menu');
  const h = await page.locator('#sheet-handle').boundingBox();
  const x = h.x + h.width / 2, y0 = h.y + h.height / 2;
  await page.mouse.move(x, y0);
  await page.mouse.down();
  await page.mouse.move(x, y0 + 60, { steps: 4 });
  await page.waitForTimeout(100);
  await expect(copy).toHaveCount(0); // still over 65%
  calls.length = 0;
  await page.mouse.move(x, y0 + 420, { steps: 8 });
  await expect(copy).toHaveCount(1);
  await expect(copy.locator('.hm-place').first()).toBeAttached();
  expect(await copy.evaluate((n) => n.inert && n.getAttribute('aria-hidden'))).toBe('true');
  expect(await page.evaluate(() => location.hash)).toBe('#/settings'); // nothing has navigated yet
  await page.mouse.move(x, y0 + 40, { steps: 6 }); // back up: the copy goes
  await expect(copy).toHaveCount(0);
  await page.mouse.move(x, y0 + 420, { steps: 8 });
  await expect(copy).toHaveCount(1);
  expect(calls).toEqual([]); // the copy loads no bus data
  await page.waitForTimeout(100);
  const top = () => page.evaluate(() => document.getElementById('sheet').getBoundingClientRect().top);
  expect(Math.abs(await top() - (h.y + 420))).toBeLessThan(3); // the card stays under the finger
  await page.evaluate(() => { // the first frame after release: no jump
    const s = document.getElementById('sheet');
    window.__top0 = s.getBoundingClientRect().top;
    addEventListener('hashchange', () => { window.__top1 = s.getBoundingClientRect().top; }, { once: true });
  });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.__top1 ?? null)).not.toBeNull();
  expect(await page.evaluate(() => Math.abs(window.__top1 - window.__top0))).toBeLessThan(40);
  await expect.poll(() => state(page)).toBe('half');
  await expect(copy).toHaveCount(0);
  await expect(page.locator('#sheet-content .hm-place').first()).toBeVisible();
  expect(await page.evaluate(() => getComputedStyle(document.getElementById('sheet-content')).opacity)).toBe('1');
});
