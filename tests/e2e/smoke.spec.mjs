// Smoke tests at a 360×780 phone viewport, both cities, against recorded upstream data (fixtures/, see mock.mjs).
import { test, expect, FIXTURES } from './mock.mjs';
import { isLive } from '../../web/js/arrivals.js';

const CITY = {
  patra: { home: '/#/', name: 'Πάτρα', query: 'πανεπιστημιου αρεθα', stopName: 'Πανεπιστημίου & Αρέθα', stopHash: '#/stop/1011' },
  corfu: { home: '/#/corfu/', name: 'Κέρκυρα', query: 'πολυκλινικη', stopName: 'Πολυκλινικη', stopHash: '#/corfu/stop/404' },
};
const tiles = (page) => page.locator('.stopv .atile:not(.atile-skel)');

for (const [id, c] of Object.entries(CITY)) {
  const fx = FIXTURES[id];

  test(`${id}: app loads`, async ({ page }) => {
    await page.goto(c.home);
    await expect(page.getByText(`Telematica · ${c.name}`)).toBeVisible();
    await expect(page.locator('#search-input')).toBeVisible();
    await expect(page.locator('#sheet-content')).not.toContainText('Φόρτωση…');
  });

  test(`${id}: stop search finds the stop`, async ({ page }) => {
    await page.goto(c.home);
    await expect(page.getByText(`Telematica · ${c.name}`)).toBeVisible();
    await page.locator('#search-input').fill(c.query);
    const hit = page.getByRole('option').filter({ hasText: `#${fx.stop}` });
    await expect(hit).toBeVisible();
    await expect(hit).toContainText(c.stopName);
    await hit.click();
    await expect(page).toHaveURL(new RegExp(`${c.stopHash.replace(/[/#]/g, '\\$&')}$`));
    await expect(page.locator('.stopv-name')).toContainText(c.stopName);
  });

  test(`${id}: arrivals render from the recorded response`, async ({ page, net }) => {
    await page.goto(`/${c.stopHash}`);
    const vs = fx.body.vehicles;
    await expect(tiles(page)).toHaveCount(vs.length);
    expect(net.liveCalls).toContain(`${id}/${fx.stop}`);
    for (const v of vs) {
      const tile = tiles(page).filter({ has: page.locator('.atile-badge', { hasText: new RegExp(`^${v.lineCode}$`) }) }).first();
      await expect(tile).toHaveClass(isLive(v) ? /\batile-live\b/ : /\batile-sched\b/);
      await expect(tile.locator('.atile-dest')).not.toBeEmpty();
      await expect(tile.locator('.atile-num')).toHaveText(/^(τώρα|<1′|\d+′|\d+ ώ \d+′)$/);
    }
  });
}

for (const id of Object.keys(CITY)) test(`${id}: LIVE and scheduled departures look different`, async ({ page }) => {
  const vs = FIXTURES[id].body.vehicles;
  expect(vs.some(isLive) && !vs.every(isLive), `the ${id} fixture needs one LIVE and one scheduled departure`).toBe(true);
  await page.goto(`/${CITY[id].stopHash}`);
  const live = page.locator('.atile-live').first();
  const sched = page.locator('.atile-sched').first();
  await expect(live).toBeVisible();
  await expect(sched).toBeVisible();

  // Label: LIVE with a pulsing dot vs ΠΡΟΓΡ. with a clock icon and the timetable time.
  await expect(live.locator('.atile-flag')).toHaveText('LIVE');
  await expect(live.locator('.atile-dot')).toBeVisible();
  await expect(sched.locator('.atile-flag')).toContainText('ΠΡΟΓΡ.');
  await expect(sched.locator('.atile-flag .icon')).toBeVisible();
  await expect(sched.locator('.atile-clock')).toHaveText(/^\d{2}:\d{2}$/);
  await expect(live.locator('.atile-clock')).toHaveCount(0);

  // Colour: accent stripe, countdown and pill all differ.
  const look = (tile) => tile.evaluate((el) => {
    const cs = (q) => getComputedStyle(q ? el.querySelector(q) : el);
    return { stripe: cs().borderLeftColor, num: cs('.atile-num').color, pill: cs('.atile-flag').backgroundColor, pillText: cs('.atile-flag').color };
  });
  const [l, s] = [await look(live), await look(sched)];
  for (const k of Object.keys(l)) expect(l[k], `${k} colour`).not.toBe(s[k]);

  await test.info().attach(`${id}-live-vs-scheduled.png`, { body: await page.locator('.stopv').screenshot(), contentType: 'image/png' });
});

// Greek letters in visible text, placeholders and labels, minus upstream data (stop and route names) and the
// "Ελληνικά" option, which stays in its own language on purpose.
const GREEK = /[Ͱ-Ͽἀ-῿]/;
const greekLeft = (page) => page.evaluate((re) => {
  const greek = new RegExp(re);
  const DATA = '.stopv-name, .atile-dest, [data-lang-seg] [data-v="el"]';
  const shown = (el) => el.checkVisibility({ visibilityProperty: true, opacityProperty: true });
  const out = [];
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n; (n = walk.nextNode());) {
    const el = n.parentElement;
    if (greek.test(n.data) && shown(el) && !el.closest(DATA)) out.push(n.data.trim());
  }
  // Labels may quote the data (a tile's label names its destination): drop those quotes first.
  const data = [...document.querySelectorAll(DATA)].map((el) => el.textContent.trim()).filter(Boolean);
  for (const el of document.querySelectorAll('[placeholder], [aria-label], [title]')) {
    if (!shown(el) || el.closest(DATA)) continue;
    for (const a of ['placeholder', 'aria-label', 'title']) {
      const v = el.getAttribute(a) || '';
      if (greek.test(data.reduce((s, d) => s.split(d).join(''), v))) out.push(`${a}="${v}"`);
    }
  }
  return out;
}, GREEK.source);

test('EL/EN toggle switches all visible text', async ({ page }) => {
  await page.goto('/#/settings');
  await expect(page.getByRole('heading', { name: 'Ρυθμίσεις' })).toBeVisible();
  await page.getByRole('button', { name: 'English', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');

  for (const hash of ['#/settings', '#/', '#/stop/1011']) {
    await page.evaluate((h) => { location.hash = h; }, hash);
    if (hash === '#/stop/1011') await expect(tiles(page)).toHaveCount(FIXTURES.patra.body.vehicles.length);
    else await expect(page.locator('#sheet-content')).not.toBeEmpty();
    await expect.poll(() => greekLeft(page), { message: `Greek text left on ${hash} in English` }).toEqual([]);
  }
  await expect(page.locator('#search-input')).toHaveAttribute('placeholder', 'Where to?');
  await expect(page.locator('.atile-sched .atile-flag').first()).toContainText('SCHED');

  // And back: the Greek UI returns.
  await page.evaluate(() => { location.hash = '#/settings'; });
  await page.getByRole('button', { name: 'Ελληνικά', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Ρυθμίσεις' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'el');
  await expect(page.locator('#search-input')).toHaveAttribute('placeholder', 'Πού πάμε;');
});
