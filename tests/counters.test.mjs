import { test } from 'node:test';
import assert from 'node:assert/strict';
import { METRICS, athensDay, validEvent, recordCount } from '../worker/src/counters.js';

// A fake COUNTERS binding that remembers what was sent to the Durable Object.
const fakeEnv = (fetchImpl) => {
  const sent = [];
  const env = {
    COUNTERS: {
      idFromName: (name) => name,
      get: () => ({
        fetch: async (url, init) => {
          sent.push(JSON.parse(init.body));
          return fetchImpl ? fetchImpl() : new Response('{"ok":true}');
        },
      }),
    },
  };
  return { env, sent };
};

test('athensDay uses the calendar day in Athens, not UTC', () => {
  // Summer time ends 2026-10-25 01:00 UTC, so 22:30 UTC is 00:30 (UTC+2) on the 26th in Athens.
  assert.equal(athensDay(Date.UTC(2026, 9, 25, 22, 30)), '2026-10-26');
  assert.equal(athensDay(Date.UTC(2026, 9, 25, 12, 0)), '2026-10-25');
  // Winter (UTC+2): 21:59 UTC is still the same day, 22:00 UTC is the next one.
  assert.equal(athensDay(Date.UTC(2026, 0, 15, 21, 59)), '2026-01-15');
  assert.equal(athensDay(Date.UTC(2026, 0, 15, 22, 0)), '2026-01-16');
});

test('validEvent only accepts whitelisted metrics and cities', () => {
  for (const m of METRICS) assert.deepEqual(validEvent(m, 'corfu'), { metric: m, city: 'corfu' });
  assert.deepEqual(validEvent('feedback', undefined), { metric: 'feedback', city: '' });
  assert.deepEqual(validEvent('feedback', null), { metric: 'feedback', city: '' });
  assert.equal(validEvent('feedback', 'athens'), null);
  assert.equal(validEvent('feedback', '__proto__'), null);
  assert.equal(validEvent('visits', 'patra'), null);
  assert.equal(validEvent('../x', 'patra'), null);
  assert.equal(validEvent(undefined, 'patra'), null);
});

test('recordCount sends today (Athens), the metric and the city, and nothing else', async () => {
  const { env, sent } = fakeEnv();
  await recordCount(env, 'feedback', 'patra', Date.UTC(2026, 9, 25, 12, 0));
  assert.deepEqual(sent, [{ day: '2026-10-25', metric: 'feedback', city: 'patra' }]);
});

test('recordCount drops events that are not on the whitelist', async () => {
  const { env, sent } = fakeEnv();
  await recordCount(env, 'feedback', 'athens');
  await recordCount(env, 'visits', 'patra');
  assert.deepEqual(sent, []);
});

test('recordCount never throws: missing binding or failing Durable Object', async () => {
  await recordCount({}, 'feedback', 'patra');
  const { env } = fakeEnv(() => { throw new Error('boom'); });
  await assert.doesNotReject(() => recordCount(env, 'feedback', 'patra'));
});
