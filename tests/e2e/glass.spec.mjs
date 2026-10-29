// TEL-83: the glass UI (css/glass.css + js/glass.js) is on for everyone, keeps LIVE and scheduled apart,
// and falls back to solid, static surfaces with prefers-contrast: more (reduced transparency has no Playwright
// emulation; it shares the same variables and the same early return in js/glass.js).
import { test, expect } from './mock.mjs';

// the sheet's glass is the layer behind its content (TEL-222)
const sheetFilter = (page) => page.evaluate(() => getComputedStyle(document.querySelector('.sheet'), '::before').backdropFilter);

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
  const bg = await page.evaluate(() => getComputedStyle(document.querySelector('.sheet'), '::before').backgroundColor);
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

test('glass: the sheet has three states: a floating card at peek and half, solid and edge to edge at full', async ({ page }) => {
  await page.goto('/?demo&debug#/stop/1011');
  await expect(page.locator('.stopv .atile:not(.atile-skel)').first()).toBeVisible();
  const seen = new Set();
  for (let i = 0; i < 4; i++) {
    await page.locator('#sheet-handle').dispatchEvent('click'); // a tap walks the states
    await page.waitForTimeout(150);
    seen.add(await page.evaluate(() => document.getElementById('sheet').dataset.state));
  }
  expect([...seen].sort()).toEqual(['full', 'half', 'peek']);
  // the card behind the content, once the sheet has settled in a state
  const card = async (state) => {
    await page.evaluate((s) => window.__app.sheet.snap(s, { animate: false }), state);
    await page.waitForTimeout(100);
    return page.evaluate(() => {
      const sheet = document.getElementById('sheet');
      const cs = getComputedStyle(sheet, '::before');
      const r = sheet.getBoundingClientRect();
      return { t: parseFloat(sheet.style.getPropertyValue('--sheet-t')), left: parseFloat(cs.left), radiusBottom: parseFloat(cs.borderBottomLeftRadius), cardBottom: r.top + r.height - parseFloat(cs.bottom), screen: innerHeight, bg: cs.backgroundColor };
    });
  };
  const peek = await card('peek');
  const half = await card('half');
  const full = await card('full');
  expect([peek.t, half.t, full.t]).toEqual([0, 1, 2]);
  // peek and half: a rounded card with a margin, ending above the bottom of the screen
  for (const c of [peek, half]) {
    expect(c.left).toBeGreaterThan(4);
    expect(c.radiusBottom).toBeGreaterThan(10);
    expect(c.cardBottom).toBeLessThan(c.screen - 4);
  }
  // full: edge to edge, to the bottom, square at the bottom, and solid (no see-through glass)
  expect(full.left).toBe(0);
  expect(full.radiusBottom).toBe(0);
  expect(Math.abs(full.cardBottom - full.screen)).toBeLessThan(2);
  expect(full.bg).not.toMatch(/\/ 0\.\d|, 0\.\d+\)$/);
  // the map stays still when the sheet goes to or from full; between low and mid it glides the stop to the centre of
  // the part left above the sheet (Apple Maps). The map has no style here (no network), so watch the call itself.
  await page.evaluate(() => {
    window.__recenter = [];
    const api = window.__app.map;
    const orig = api.recenter;
    api.recenter = (p) => { window.__recenter.push(p ? p.code || 'point' : 'user'); orig(p); };
  });
  await page.evaluate(() => window.__app.sheet.snap('full', { animate: false }));
  for (const st of ['half', 'peek', 'half', 'full']) { await page.evaluate((x) => window.__app.sheet.snap(x), st); await page.waitForTimeout(100); }
  expect(await page.evaluate(() => window.__recenter)).toEqual(['1011', '1011']);
  // from full: an easy flick down stops at half; a fast one goes on to peek, and a fast one up from peek reaches full
  const flick = async (from, dy, pause) => {
    await page.evaluate((st) => window.__app.sheet.snap(st, { animate: false }), from);
    await page.waitForTimeout(100);
    const h = await page.locator('#sheet-handle').boundingBox();
    const x = h.x + h.width / 2, y0 = h.y + h.height / 2;
    await page.mouse.move(x, y0);
    await page.mouse.down();
    // slow: four steps with a pause; fast: one quick stroke (steps in one call, so a slow CI runner still flicks fast,
    // and a fast local one flicks very fast: the case where half used to win)
    if (pause) for (let i = 1; i <= 4; i++) { await page.mouse.move(x, y0 + (i * dy) / 4); await page.waitForTimeout(pause); }
    else await page.mouse.move(x, y0 + dy, { steps: 3 });
    await page.mouse.up();
    await page.waitForTimeout(700);
    return page.evaluate(() => document.getElementById('sheet').dataset.state);
  };
  expect(await flick('full', 160, 40)).toBe('half');
  expect(await flick('full', 270, 0)).toBe('peek');
  expect(await flick('peek', -255, 0)).toBe('full');
  // peek is tight: the handle, the stop's header and its line pills (TEL-224), nothing more
  await expect(page.locator('.stopv-chipbar')).toBeVisible();
  await page.evaluate(() => window.__app.sheet.snap('peek', { animate: false }));
  await page.waitForTimeout(150);
  const low = await page.evaluate(() => {
    const s = document.getElementById('sheet').getBoundingClientRect();
    const bar = document.querySelector('.stopv-chipbar').getBoundingClientRect();
    return { shown: innerHeight - s.top, below: innerHeight - bar.bottom };
  });
  expect(low.below).toBeGreaterThan(0); // the pills are on screen
  expect(low.below).toBeLessThan(40); // and low ends right under them
  expect(low.shown).toBeLessThan(200);
});

test('search in the sheet: ☰ alone at the top, search home only, open = up, closed = back where it was', async ({ page }) => {
  await page.goto('/?demo&debug#/');
  const bar = page.locator('#searchbar');
  await expect(bar).toBeVisible();
  // the ☰ is not part of the search: a round button of its own, above the sheet
  expect(await page.evaluate(() => !document.getElementById('menu-btn').closest('#sheet') && !!document.getElementById('searchbar').closest('#sheet'))).toBe(true);
  // home opens at half; low shows the search and nothing below it
  await expect.poll(() => page.evaluate(() => document.getElementById('sheet').dataset.state)).toBe('half');
  await page.evaluate(() => window.__app.sheet.snap('peek', { animate: false }));
  await page.waitForTimeout(100);
  const low = await page.evaluate(() => {
    const s = document.getElementById('sheet').getBoundingClientRect(); const b = document.getElementById('searchbar').getBoundingClientRect();
    return { below: innerHeight - b.bottom, sheetTop: s.top, barTop: b.top };
  });
  expect(low.barTop).toBeGreaterThan(low.sheetTop);
  expect(low.below).toBeLessThan(40);
  // tap the search: the sheet goes up and the view gives way to the results; Escape puts it back at low
  await page.locator('#search-input').click();
  await expect.poll(() => page.evaluate(() => document.getElementById('sheet').dataset.state)).toBe('full');
  await expect(page.locator('#search-panel')).toBeVisible();
  await expect(page.locator('#sheet-content')).toBeHidden();
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => document.getElementById('sheet').dataset.state)).toBe('peek');
  await expect(page.locator('#sheet-content')).toBeVisible();
  // the ☰ is the way back while searching: it closes the search, it does not open the menu
  await page.locator('#search-input').click();
  await expect.poll(() => page.evaluate(() => document.getElementById('sheet').dataset.state)).toBe('full');
  await page.locator('#menu-btn').click();
  await expect.poll(() => page.evaluate(() => document.getElementById('sheet').dataset.state)).toBe('peek');
  await expect(page.locator('#search-panel')).toBeHidden();
  await expect(page.locator('#menu-pop')).toBeHidden();
  // another view puts its own header in the search's place
  await page.goto('/?demo&debug#/stop/1011');
  await expect(page.locator('.stopv-head')).toBeVisible();
  await expect(bar).toBeHidden();
});

test.describe('touch', () => {
  test.use({ hasTouch: true });
  test('search in the sheet: a tap at low opens the keyboard at the top, then the real field once the sheet is up', async ({ page }) => {
    await page.goto('/?demo&debug#/');
    await expect(page.locator('#searchbar')).toBeVisible();
    await page.evaluate(() => window.__app.sheet.snap('peek', { animate: false }));
    await page.waitForTimeout(100);
    await page.locator('#search-input').tap();
    // the keyboard opens on the hidden field at the top while the sheet goes up (no pan on iOS)
    expect(await page.evaluate(() => document.activeElement.className)).toBe('kb-proxy');
    await expect.poll(() => page.evaluate(() => document.getElementById('sheet').dataset.state)).toBe('full');
    await expect.poll(() => page.evaluate(() => document.activeElement.id)).toBe('search-input');
    await expect(page.locator('#search-panel')).toBeVisible();
  });
});

test('map buttons: the attribution (i) sits in the column of map buttons, above locate', async ({ page }) => {
  await page.goto('/?demo#/');
  await expect(page.locator('#locate-btn')).toBeVisible();
  const order = await page.evaluate(() => [...document.getElementById('fabs-bottom').children].map((e) => e.id || e.className.split(' ').find((c) => c.startsWith('maplibregl-ctrl-')) || e.className));
  expect(order[0]).toBe('maplibregl-ctrl-attrib');
  expect(order.at(-1)).toBe('locate-btn');
});
