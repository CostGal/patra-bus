import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reportUsage, usageAllowed, PROD_ORIGIN } from '../web/js/usage.js';
import { DEFAULT_SETTINGS } from '../web/js/store.js';

const NOW = Date.UTC(2026, 9, 26, 9, 0); // 2026-10-26 in Athens
const DAY = 86400 * 1000;

// Runs reportUsage with an in-memory settings object and a recording post().
function run({ settings = {}, ok = true, ...opts } = {}) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const posted = [];
  const p = reportUsage({
    settings: s,
    set: (k, v) => { s[k] = v; },
    origin: PROD_ORIGIN,
    demo: false,
    gpc: undefined,
    installed: false,
    city: 'patra',
    now: NOW,
    post: async (body) => { posted.push(body); return ok; },
    ...opts,
  });
  return p.then((sent) => ({ sent, posted, settings: s }));
}

test('usageAllowed: production only, switch on, no demo, no GPC', () => {
  const base = { settings: DEFAULT_SETTINGS, origin: PROD_ORIGIN, demo: false, gpc: undefined };
  assert.equal(usageAllowed(base), true);
  assert.equal(usageAllowed({ ...base, settings: { usageStats: false } }), false);
  assert.equal(usageAllowed({ ...base, gpc: true }), false);
  assert.equal(usageAllowed({ ...base, demo: true }), false);
  assert.equal(usageAllowed({ ...base, origin: 'http://localhost:8080' }), false);
  assert.equal(usageAllowed({ ...base, origin: 'https://claude-tel-1-x-patra-bus-dev.patra-bus.workers.dev' }), false);
  assert.equal(DEFAULT_SETTINGS.usageStats, true, 'on by default');
});

test('open: sent once per Athens day, again the next day', async () => {
  const first = await run();
  assert.deepEqual(first.sent, ['open']);
  assert.equal(first.settings.usageDay, '2026-10-26');
  const again = await run({ settings: first.settings });
  assert.deepEqual(again.posted, []);
  const tomorrow = await run({ settings: first.settings, now: NOW + DAY });
  assert.deepEqual(tomorrow.sent, ['open']);
  assert.equal(tomorrow.settings.usageDay, '2026-10-27');
});

test('install: only as an installed app, only once', async () => {
  assert.deepEqual((await run()).posted.map((b) => b.metric), ['open']);
  const first = await run({ installed: true });
  assert.deepEqual(first.sent, ['open', 'install']);
  assert.equal(first.settings.usageInstall, true);
  const later = await run({ installed: true, settings: first.settings, now: NOW + DAY });
  assert.deepEqual(later.sent, ['open']);
});

test('the body is only { metric, city }', async () => {
  const { posted } = await run({ installed: true, city: 'corfu' });
  assert.deepEqual(posted, [{ metric: 'open', city: 'corfu' }, { metric: 'install', city: 'corfu' }]);
});

test('nothing is sent with the switch off, GPC, ?demo or outside production', async () => {
  for (const opts of [
    { settings: { usageStats: false } },
    { gpc: true },
    { demo: true },
    { origin: 'http://localhost:8080' },
  ]) {
    const { posted } = await run({ installed: true, ...opts });
    assert.deepEqual(posted, [], JSON.stringify(opts));
  }
});

test('a failed send is not marked and is retried on the next launch', async () => {
  const failed = await run({ installed: true, ok: false });
  assert.deepEqual(failed.sent, []);
  assert.equal(failed.settings.usageDay, undefined);
  assert.equal(failed.settings.usageInstall, undefined);
  const retry = await run({ installed: true, settings: failed.settings });
  assert.deepEqual(retry.sent, ['open', 'install']);
});

test('never throws, even when post() throws', async () => {
  const { sent } = await run({ post: async () => { throw new Error('boom'); } });
  assert.deepEqual(sent, []);
});

test('wiring: app.js calls it after boot, the service worker precaches it', () => {
  const read = (f) => readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf8');
  assert.match(read('js/app.js'), /import\('\.\/usage\.js'\)\.then\(\(m\) => m\.reportUsage\(\)\)\.catch/);
  assert.ok(read('sw.js').includes("'js/usage.js'"));
});
