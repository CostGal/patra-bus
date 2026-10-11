// Network for the smoke tests: the static server of web/ is real, everything else is mocked or blocked.
// - http://localhost:8787/api/{city}/live/{code}: answered from the recorded upstream response in fixtures/,
//   normalised by the same normalizeLive the worker uses, fetchedAt = now (so the countdowns are fresh).
// - any other worker route (stats, push…): 404.
// - every other origin (rest.citybus.gr, the deployed worker, OpenFreeMap, OSRM, Photon): aborted and recorded,
//   so a test can never reach a live API. `blocked` lists what was stopped.
import { readFileSync } from 'node:fs';
import { test as base, expect } from '@playwright/test';
import { normalizeLive, noServiceResult } from '../../web/js/arrivals.js';
import { E2E_STOPS } from './stops.mjs';

export { expect, E2E_STOPS };

const fixture = (city, code) => JSON.parse(readFileSync(new URL(`./fixtures/${city}-live-${code}.json`, import.meta.url), 'utf8'));
export const FIXTURES = Object.fromEntries(Object.entries(E2E_STOPS).map(([city, code]) => [city, fixture(city, code)]));

const WORKER = 'http://localhost:8787';
const LIVE = /^\/api\/(\w+)\/live\/([^/?]+)$/;
const json = (status, body) => ({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });

export async function mockNetwork(context, baseURL) {
  const origin = new URL(baseURL).origin;
  const blocked = [];
  const liveCalls = [];
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin) return route.continue();
    if (url.origin === WORKER) {
      const m = url.pathname.match(LIVE);
      const fx = m && FIXTURES[m[1]];
      if (fx && fx.stop === decodeURIComponent(m[2])) {
        liveCalls.push(`${m[1]}/${fx.stop}`);
        const now = Date.now();
        return route.fulfill(json(200, fx.status === 404 ? noServiceResult(now) : normalizeLive(fx.body, now)));
      }
      return route.fulfill(json(404, { error: 'not mocked' }));
    }
    blocked.push(url.href);
    return route.abort('blockedbyclient');
  });
  return { blocked, liveCalls };
}

// `net` is set up before the page exists, so even the first request is covered. Uncaught page errors fail the test.
export const test = base.extend({
  net: async ({ context, baseURL }, use) => { await use(await mockNetwork(context, baseURL)); },
  page: async ({ page, net }, use) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await use(page);
    expect(errors, 'uncaught errors in the page').toEqual([]);
    expect(net.blocked.filter((u) => /citybus\.gr|workers\.dev/.test(u)), 'calls to a live API').toEqual([]);
  },
});
