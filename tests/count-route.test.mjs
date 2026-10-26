import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/src/index.js';

const ALLOWED_ORIGIN = 'https://costgal.github.io,http://localhost:8080,https://patra-bus-dev.patra-bus.workers.dev,https://*-patra-bus-dev.patra-bus.workers.dev';
const PROD = 'https://costgal.github.io';

// Each test gets its own IP so the in-memory rate limiter (shared by the module) never carries over between tests.
let ipSeq = 0;

// A fake COUNTERS binding that remembers what reached the Durable Object.
function setup() {
  const sent = [];
  const env = {
    ALLOWED_ORIGIN,
    COUNTERS: {
      idFromName: (n) => n,
      get: () => ({ fetch: async (url, init) => { sent.push(JSON.parse(init.body)); return new Response('{"ok":true}'); } }),
    },
  };
  return { env, sent, ip: `10.0.0.${++ipSeq}` };
}

const post = (body, { origin = PROD, type = 'application/json', ip = '10.9.9.9' } = {}) =>
  new Request('https://w.example/api/count', {
    method: 'POST',
    headers: { 'Content-Type': type, 'CF-Connecting-IP': ip, ...(origin ? { Origin: origin } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const ctx = { waitUntil() {} };

test('count: open and install from the app add 1 with the city, answer 204', async () => {
  const { env, sent, ip } = setup();
  for (const metric of ['open', 'install']) {
    const res = await worker.fetch(post({ metric, city: 'corfu' }, { ip }), env, ctx);
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), PROD);
  }
  assert.deepEqual(sent.map(({ metric, city }) => [metric, city]), [['open', 'corfu'], ['install', 'corfu']]);
});

test('count: only city and metric are kept, extra fields are ignored', async () => {
  const { env, sent, ip } = setup();
  await worker.fetch(post({ metric: 'open', city: 'patra', device: 'abc', lat: 38.2 }, { ip }), env, ctx);
  assert.equal(sent.length, 1);
  assert.deepEqual(Object.keys(sent[0]).sort(), ['city', 'day', 'metric']);
});

test('count: the app cannot report feedback, push or unknown metrics and cities (400)', async () => {
  const { env, sent, ip } = setup();
  for (const body of [
    { metric: 'feedback', city: 'patra' },
    { metric: 'push', city: 'patra' },
    { metric: 'visits', city: 'patra' },
    { metric: 'open', city: 'athens' },
    { metric: 'open' },
    {},
  ]) {
    assert.equal((await worker.fetch(post(body, { ip }), env, ctx)).status, 400, JSON.stringify(body));
  }
  assert.equal((await worker.fetch(post('not json', { ip }), env, ctx)).status, 400);
  assert.equal(sent.length, 0);
});

test('count: foreign origin 403, wrong content type 415, GET 404, too large 413', async () => {
  const { env, sent, ip } = setup();
  assert.equal((await worker.fetch(post({ metric: 'open', city: 'patra' }, { origin: 'https://evil.example', ip }), env, ctx)).status, 403);
  assert.equal((await worker.fetch(post({ metric: 'open', city: 'patra' }, { type: 'text/plain', ip }), env, ctx)).status, 415);
  assert.equal((await worker.fetch(new Request('https://w.example/api/count'), env, ctx)).status, 404);
  const big = JSON.stringify({ metric: 'open', city: 'patra', pad: 'x'.repeat(300) });
  assert.equal((await worker.fetch(post(big, { ip }), env, ctx)).status, 413);
  assert.equal(sent.length, 0);
});

test('count: previews and localhost answer 204 but are not counted', async () => {
  const { env, sent, ip } = setup();
  for (const origin of ['https://claude-tel-1-x-patra-bus-dev.patra-bus.workers.dev', 'http://localhost:8080']) {
    assert.equal((await worker.fetch(post({ metric: 'open', city: 'patra' }, { origin, ip }), env, ctx)).status, 204, origin);
  }
  assert.equal(sent.length, 0);
});

test('count: no Origin (not a browser) is counted, like the other POST routes', async () => {
  const { env, sent, ip } = setup();
  assert.equal((await worker.fetch(post({ metric: 'open', city: 'patra' }, { origin: null, ip }), env, ctx)).status, 204);
  assert.equal(sent.length, 1);
});

test('count: more than 20 calls in 10 minutes from one IP get 429 and are not counted', async () => {
  const { env, sent, ip } = setup();
  for (let i = 0; i < 20; i++) await worker.fetch(post({ metric: 'open', city: 'patra' }, { ip }), env, ctx);
  assert.equal((await worker.fetch(post({ metric: 'open', city: 'patra' }, { ip }), env, ctx)).status, 429);
  assert.equal(sent.length, 20);
});
