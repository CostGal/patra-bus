// TEL-269: the browser half of the UI protocol checks (docs/UI-PROTOCOL.md, rules marked "auto"). Every view we keep,
// at low / mid / up (the sheet's peek / half / full), measured in one page.evaluate per state:
// U2 one 16 px inset · U3 .g-circle 38 px with a 44 px tap area · U4 the kit's title, 17 px then 24 px up, one line ·
// U5 low is one centred row without actions · U9 the measured layout does not follow the drag · U12 glass never
// fades · U20 every tap area can be hit · and, for what floats over the map, U11 no transition on transform.
// What breaks today is listed per view in tests/ui-protocol-exceptions.mjs; the test fails on an unlisted break and on
// a listed one that holds now, so the list only gets shorter. The static half: tests/ui-protocol.test.mjs.
import { test, expect } from './mock.mjs';
import { VIEW_EXCEPTIONS } from '../ui-protocol-exceptions.mjs';

const STATES = { low: 'peek', mid: 'half', up: 'full' };
const VIEWS = {
  home: '#/',
  stop: '#/stop/1011',
  lines: '#/lines',
  line: '#/line/101',
  bus: null, // a live bus from the stop's arrivals (the demo's vehicle codes change with the clock)
  favorites: '#/favorites',
  settings: '#/settings',
  report: '#/report',
};

// Runs in the page. Returns { rule: [problem, …] } for one state.
function measure({ state, tol }) {
  const out = { U2: [], U3: [], U4: [], U5: [], U9: [], U12: [], U20: [] };
  const sheet = document.getElementById('sheet');
  const content = sheet.querySelector('.sheet-content');
  const sr = sheet.getBoundingClientRect();
  const before = getComputedStyle(sheet, '::before');
  // the glass card is the sheet's ::before (TEL-222): its edges are the card's edges
  const card = { left: sr.left + (parseFloat(before.left) || 0), right: sr.right - (parseFloat(before.right) || 0), top: sr.top,
    bottom: Math.min(innerHeight, sr.bottom - (parseFloat(before.bottom) || 0)) };
  const r1 = (n) => Math.round(n * 10) / 10;
  const name = (el) => el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '') + [...el.classList].slice(0, 3).map((c) => `.${c}`).join('');
  const shown = (el) => {
    const b = el.getBoundingClientRect();
    if (b.width < 1 || b.height < 1 || getComputedStyle(el).visibility === 'hidden') return false;
    for (let e = el; e; e = e.parentElement) if (parseFloat(getComputedStyle(e).opacity) < 0.05) return false;
    return b.bottom > card.top && b.top < card.bottom && b.right > 0 && b.left < innerWidth;
  };

  // U2: one inset, 16 px from the card's edge: the view's content, the header circles, the wide actions
  // the view's root: the first child of the sheet's content that is in the flow (not a visually hidden h1)
  const root = [...content.children].find((e) => e.offsetWidth > 1 && !['absolute', 'fixed'].includes(getComputedStyle(e).position));
  if (root) {
    const rb = root.getBoundingClientRect(), cs = getComputedStyle(root);
    const inner = rb.left + parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth) - card.left;
    if (Math.abs(inner - 16) > tol) out.U2.push(`${name(root)} content starts ${r1(inner)} px from the card's edge`);
  }
  for (const el of content.querySelectorAll('.card-head > .g-circle, .g-pill')) {
    if (!shown(el)) continue;
    const b = el.getBoundingClientRect();
    const d = Math.min(b.left - card.left, card.right - b.right);
    if (Math.abs(d - 16) > tol) out.U2.push(`${name(el)} is ${r1(d)} px from the card's edge`);
  }

  // U3: a round button in the card is .g-circle, drawn 38 px with a 44 px tap area
  for (const el of content.querySelectorAll('.btn.round')) {
    if (!shown(el)) continue;
    if (!el.classList.contains('g-circle')) { out.U3.push(`${name(el)} is a round button without .g-circle`); continue; }
    const w = el.offsetWidth, hgt = el.offsetHeight;
    if (Math.abs(w - 38) > tol || Math.abs(hgt - 38) > tol) out.U3.push(`${name(el)} is ${w}×${hgt}`);
    const a = getComputedStyle(el, '::after');
    const tap = w - 2 * (parseFloat(a.left) || 0);
    if (a.content === 'none' || tap < 44 - tol) out.U3.push(`${name(el)} tap area ${r1(tap)} px`);
  }

  // U4: the kit's title: 17 px (on screen, scale included) at low and mid, 24 px up, one line
  const title = content.querySelector('.card-head .card-title');
  if (!title) out.U4.push('no .card-head .card-title (the kit\'s header)');
  else {
    const px = parseFloat(getComputedStyle(title).fontSize) * title.getBoundingClientRect().height / title.offsetHeight;
    // 17 px, or less down to the 14 px floor when the name does not fit (it depends on the font: Linux CI's is wider);
    // up 24 px, or less for a long name, never under the floor
    const max = state === 'full' ? 24 : 17;
    if (px > max + 0.6 || px < 14 - 0.6) out.U4.push(`title ${r1(px)} px, wants ${max} (or down to 14 for a long name)`);
    if (title.scrollHeight > title.clientHeight + 1) out.U4.push('title wraps');
  }

  // U5: low is one row (as tall as the buttons), centred in the card, with no actions
  if (state === 'peek') {
    const head = content.querySelector('.card-head');
    if (!head) out.U5.push('no .card-head');
    else {
      const hb = head.getBoundingClientRect();
      if (head.offsetHeight > 38 + tol) out.U5.push(`the header row is ${head.offsetHeight} px (two rows?)`);
      const handle = sheet.querySelector('.sheet-handle');
      const top = handle ? handle.getBoundingClientRect().bottom : card.top;
      const off = (hb.top + hb.bottom) / 2 - (top + card.bottom) / 2;
      if (Math.abs(off) > 3) out.U5.push(`the row is ${r1(off)} px off the centre of the card's low part`);
    }
    for (const el of content.querySelectorAll('.g-pill')) {
      const b = el.getBoundingClientRect();
      const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      if (b.top < card.bottom - 1 && hit && el.contains(hit)) out.U5.push(`${name(el)} can be tapped at low`);
    }
  }

  // U9: the measured layout (up to [data-peek-end] / [data-mid-end], or the view's head) does not follow the drag:
  // the same tops and heights for --sheet-t from 0 to just under up (offsets ignore transforms)
  if (state === 'half') {
    const marks = [...content.querySelectorAll('[data-peek-end], [data-mid-end]')];
    if (!marks.length) marks.push(...content.querySelectorAll('.stopv-head, .ex-head, .view-head'));
    const last = marks[marks.length - 1];
    const els = last ? [...content.querySelectorAll('*')].filter((e) => e === last || (e.compareDocumentPosition(last) & Node.DOCUMENT_POSITION_FOLLOWING) || e.contains(last)) : [];
    const top = (e) => { let y = 0; for (let x = e; x && x !== content && content.contains(x); x = x.offsetParent) y += x.offsetTop; return y; };
    const snap = () => els.map((e) => [top(e), e.offsetHeight]);
    const set = (t) => { sheet.style.setProperty('--sheet-t', t); document.documentElement.style.setProperty('--sheet-t', t); };
    const was = sheet.style.getPropertyValue('--sheet-t');
    set('1');
    const base = snap();
    for (const t of [0, 0.25, 0.5, 0.75, 1.5, 1.9]) {
      set(String(t));
      snap().forEach(([y, hh], i) => {
        if (Math.abs(y - base[i][0]) > 0.5 || Math.abs(hh - base[i][1]) > 0.5) out.U9.push(`${name(els[i])} moves at --sheet-t ${t} (top ${base[i][0]}→${y}, height ${base[i][1]}→${hh})`);
      });
    }
    set(was || '1');
    out.U9 = [...new Set(out.U9.map((s) => s.replace(/ at --sheet-t [\d.]+ .*/, ' with the drag')))];
  }

  // U12: a glass layer (backdrop-filter) is never faded
  const glass = [...document.querySelectorAll('body *')].filter((e) => getComputedStyle(e).backdropFilter !== 'none');
  for (const el of glass) {
    const b = el.getBoundingClientRect();
    if (b.width < 1 || b.height < 1 || getComputedStyle(el).visibility === 'hidden' || el.closest('[hidden]')) continue;
    let o = 1;
    for (let e = el; e; e = e.parentElement) o *= parseFloat(getComputedStyle(e).opacity);
    if (o < 0.999 && o > 0) out.U12.push(`${name(el)} opacity ${r1(o)}`);
  }
  if (before.backdropFilter !== 'none' && parseFloat(before.opacity) < 0.999) out.U12.push(`the sheet's glass opacity ${before.opacity}`);

  // U20: every tap area (the element's box, grown by an absolutely placed ::after, the app's "hit area") can be hit at
  // its edges: not clipped by a scroller, not covered by something else. A neighbour's tap area counts as a hit.
  const TAP = 'button, a[href], [role="button"], summary, input:not([type="hidden"]), select, textarea';
  const tappable = (e) => e && e.closest(TAP);
  // what the clipping ancestors (overflow other than visible) leave of a box: a closed section hides its rows whole
  const clipped = (el, b) => {
    let { left, top, right, bottom } = b;
    for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
      const c = e.getBoundingClientRect();
      if (cs.overflowX !== 'visible') { left = Math.max(left, c.left); right = Math.min(right, c.right); }
      if (cs.overflowY !== 'visible') { top = Math.max(top, c.top); bottom = Math.min(bottom, c.bottom); }
    }
    return right - left < 1 || bottom - top < 1;
  };
  for (const el of content.querySelectorAll(TAP)) {
    if (!shown(el) || el.disabled || el.closest('[inert], details:not([open])') || getComputedStyle(el).pointerEvents === 'none') continue; // not meant to be tapped now (the stop's chips at low)
    const b = el.getBoundingClientRect();
    if (clipped(el, b)) continue; // hidden whole (a closed section): nothing to tap; a box cut in part is what U20 catches
    const a = getComputedStyle(el, '::after');
    const out1 = (v) => (a.content !== 'none' && a.position === 'absolute' && v.endsWith('px') ? Math.max(0, -parseFloat(v)) : 0);
    const k = b.width / (el.offsetWidth || b.width); // the element's own scale, for the ::after offsets
    const x0 = b.left - out1(a.left) * k, y0 = b.top - out1(a.top) * k;
    const w = b.width + (out1(a.left) + out1(a.right)) * k, hh = b.height + (out1(a.top) + out1(a.bottom)) * k;
    if (y0 < card.top || y0 + hh > card.bottom || x0 < 0 || x0 + w > innerWidth) continue; // not all on screen at this state
    const pts = [[x0 + w / 2, y0 + 1], [x0 + w / 2, y0 + hh - 1], [x0 + 1, y0 + hh / 2], [x0 + w - 1, y0 + hh / 2]];
    const miss = pts.filter(([x, y]) => !tappable(document.elementFromPoint(x, y)));
    if (miss.length) out.U20.push(`${name(el)} misses ${miss.length}/4 edges (hit ${name(document.elementFromPoint(...miss[0]) || document.body)})`);
  }
  out.headH = content.querySelector('.card-head')?.offsetHeight ?? null; // for the long-name check (U4)
  return out;
}

async function open(page, view) {
  let hash = VIEWS[view];
  if (view === 'bus') {
    await page.goto('/?demo&debug#/stop/1011');
    const link = page.locator('.stopv a.atile-link[href*="/bus/"]').first();
    await expect(link).toBeAttached();
    hash = new URL(await link.getAttribute('href'), page.url()).hash;
  }
  await page.goto(`/?demo&debug${hash}`);
  await page.waitForFunction(() => window.__app?.sheet && document.querySelector('#sheet .sheet-content')?.firstElementChild);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400); // the demo's arrivals and the view's own first layout
}

for (const view of Object.keys(VIEWS)) {
  test(`UI protocol: ${view} at low / mid / up`, async ({ page }) => {
    await open(page, view);
    const problems = {};
    for (const [label, state] of Object.entries(STATES)) {
      await page.evaluate((s) => window.__app.sheet.snap(s, { animate: false }), state);
      await page.waitForTimeout(150);
      const r = await page.evaluate(measure, { state, tol: 1 });
      delete r.headH;
      for (const [rule, list] of Object.entries(r)) for (const p of list) (problems[rule] ||= new Set()).add(`${label}: ${p}`);
    }
    const listed = Object.keys(VIEW_EXCEPTIONS[view] || {});
    const broken = Object.keys(problems).filter((k) => problems[k].size);
    const report = broken.filter((k) => !listed.includes(k)).map((k) => `${k}:\n    ${[...problems[k]].join('\n    ')}`);
    expect(report, `${view}: breaks the UI protocol (fix it, or list it in tests/ui-protocol-exceptions.mjs with a reason)`).toEqual([]);
    expect(listed.filter((k) => !broken.includes(k)), `${view}: holds now, remove from tests/ui-protocol-exceptions.mjs`).toEqual([]);
  });
}

// U11: what floats over the map moves with the sheet frame by frame (app.js onMove), so its transform has no
// transition (a drag adds html.sheet-dragging, but a programmatic snap moves it frame by frame too)
test('UI protocol: chrome over the map has no transition on transform (U11)', async ({ page }) => {
  await open(page, 'stop');
  const r = await page.evaluate(() => [...document.querySelectorAll('.fabs-bottom, .map-attrib, .toast-host')].flatMap((el) => {
    const cs = getComputedStyle(el);
    const props = cs.transitionProperty.split(',').map((s) => s.trim());
    const durs = cs.transitionDuration.split(',').map((s) => parseFloat(s));
    const bad = props.some((p, i) => (p === 'transform' || p === 'all') && durs[i % durs.length] > 0);
    return bad ? [`${el.className}: ${cs.transitionProperty} ${cs.transitionDuration}`] : [];
  }));
  const listed = Object.keys(VIEW_EXCEPTIONS.chrome || {});
  expect(r.length ? ['U11'] : [], `U11: ${r.join('; ')}`).toEqual(listed.filter((k) => k === 'U11'));
});

// U4, the rest: a long name shrinks (to 14 px at the least, js/arrivals-view.js) and then "…": the card's header is as
// tall as with a short one, at every state. Both names are set here, so the result does not depend on the font (Linux
// CI's is wider than Windows': there 1011's real name already takes two lines up): 1011 gets a one-word name, 826 (the
// longest name in Patras) a longer one still.
const SHORT = 'ΑΓΟΡΑ';
const LONG = 'ΑΚΡΩΤΗΡΙΟΥ ΚΑΙ ΓΛΑΥΚΟΣ ΠΑΝΕΠΙΣΤΗΜΙΟΥΠΟΛΗ ΡΙΟΥ (προς Πάτρα)';
test.describe('long name', () => {
test.use({ serviceWorkers: 'block' }); // the service worker would serve stops.json from its cache, past page.route
test('UI protocol: a long stop name keeps the card\'s height (U4)', async ({ page }) => {
  await page.route('**/data/stops.json', async (route) => {
    const res = await route.fetch();
    const stops = await res.json();
    for (const s of stops) if (String(s.code) === '826') s.name = LONG; else if (String(s.code) === '1011') s.name = SHORT;
    await route.fulfill({ response: res, json: stops });
  });
  const heads = {};
  for (const code of ['1011', '826']) {
    await page.goto(`/?demo&debug#/stop/${code}`);
    await page.waitForFunction(() => window.__app?.sheet && document.querySelector('.stopv .card-head'));
    expect(await page.locator('.stopv .card-title').getAttribute('title')).toMatch(code === '826' ? /Πανεπιστημιουπολη/i : /^Αγορα$/i); // the test's names are in
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);
    for (const [label, state] of Object.entries(STATES)) {
      await page.evaluate((s) => window.__app.sheet.snap(s, { animate: false }), state);
      await page.waitForTimeout(150);
      heads[`${code} ${label}`] = await page.evaluate(() => {
        const t = document.querySelector('.stopv .card-head .card-title');
        return { head: document.querySelector('.stopv .card-head').offsetHeight, titleH: t.offsetHeight, lh: getComputedStyle(t).lineHeight, font: getComputedStyle(t).fontFamily.slice(0, 40),
          px: Math.round(parseFloat(getComputedStyle(t).fontSize) * t.getBoundingClientRect().height / t.offsetHeight * 10) / 10 };
      });
    }
  }
  const broken = Object.keys(STATES).flatMap((s) => {
    const a = heads[`1011 ${s}`], b = heads[`826 ${s}`];
    return [
      ...(a.head !== b.head ? [`${s}: header ${a.head} px with a short name, ${b.head} px with a long one`] : []),
      ...(b.px < 14 - 0.6 ? [`${s}: the long name is ${b.px} px, under the 14 px floor`] : []),
    ];
  });
  const listed = Object.keys(VIEW_EXCEPTIONS['stop-long'] || {});
  expect(broken.length ? ['U4'] : [], `U4 (long name):\n  ${broken.join('\n  ')}\n  measured: ${JSON.stringify(heads)}`).toEqual(listed.filter((k) => k === 'U4'));
});
});
