import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedOrigin, isPatternOrigin, corsOriginFor } from '../worker/src/origin.js';

const DEV = 'https://patra-bus-dev.patra-bus.workers.dev';
const env = { ALLOWED_ORIGIN: `https://costgal.github.io,http://localhost:8080,${DEV},https://*-patra-bus-dev.patra-bus.workers.dev` };

test('origin: exact entries and project-scoped "*-name" wildcard', () => {
  assert.equal(isAllowedOrigin(env, 'https://costgal.github.io'), true);
  assert.equal(isAllowedOrigin(env, DEV), true);
  assert.equal(isAllowedOrigin(env, 'https://alice-ux-patra-bus-dev.patra-bus.workers.dev'), true);
  assert.equal(isAllowedOrigin(env, 'https://3f2a1b4c-patra-bus-dev.patra-bus.workers.dev'), true);
});

test('origin: wildcard is inside one label of that project only', () => {
  for (const o of ['https://evil.workers.dev', 'https://-patra-bus-dev.patra-bus.workers.dev', 'https://x-patra-bus.patra-bus.workers.dev',
    'https://a.b-patra-bus-dev.patra-bus.workers.dev', 'https://x-patra-bus-dev.patra-bus.workers.dev.evil.com',
    'https://x-patra-bus-dev.other.workers.dev', 'http://x-patra-bus-dev.patra-bus.workers.dev', null, '']) {
    assert.equal(isAllowedOrigin(env, o), false, String(o));
  }
});

test('origin: "*.host" form matches exactly one extra label', () => {
  const e = { ALLOWED_ORIGIN: 'https://*.example.dev' };
  assert.equal(isAllowedOrigin(e, 'https://a.example.dev'), true);
  assert.equal(isAllowedOrigin(e, 'https://example.dev'), false);
  assert.equal(isAllowedOrigin(e, 'https://a.b.example.dev'), false);
});

test('origin: malformed wildcards match nothing', () => {
  for (const entry of ['https://a.*.example.dev', 'https://**.example.dev', 'https://*a*.example.dev', 'https://example.dev/*']) {
    assert.equal(isAllowedOrigin({ ALLOWED_ORIGIN: entry }, 'https://a.b.example.dev'), false, entry);
    assert.equal(isAllowedOrigin({ ALLOWED_ORIGIN: entry }, 'https://x.example.dev'), false, entry);
  }
});

test('origin: only an explicit "*" allows everything; empty config allows nothing (TEL-404)', () => {
  assert.equal(isAllowedOrigin({ ALLOWED_ORIGIN: '*' }, 'https://x.test'), true);
  assert.equal(isAllowedOrigin({}, 'https://x.test'), false);
});

test('origin: only pattern matches count as preview', () => {
  assert.equal(isPatternOrigin(env, 'https://alice-ux-patra-bus-dev.patra-bus.workers.dev'), true);
  assert.equal(isPatternOrigin(env, DEV), false);
  assert.equal(isPatternOrigin(env, 'https://costgal.github.io'), false);
  assert.equal(isPatternOrigin(env, null), false);
  assert.equal(isPatternOrigin({ ALLOWED_ORIGIN: '*' }, 'https://x.test'), false);
});

test('origin: CORS echoes allowed origins, else no header at all (TEL-404: never "null", never a pattern)', () => {
  const prev = 'https://alice-ux-patra-bus-dev.patra-bus.workers.dev';
  assert.equal(corsOriginFor(env, prev), prev);
  assert.equal(corsOriginFor(env, 'https://costgal.github.io'), 'https://costgal.github.io');
  assert.equal(corsOriginFor(env, 'http://localhost:8080'), 'http://localhost:8080');
  assert.equal(corsOriginFor(env, DEV), DEV);
  assert.equal(corsOriginFor(env, 'https://evil.test'), null);
  assert.equal(corsOriginFor(env, null), null);
  assert.equal(corsOriginFor(env, 'null'), null);
  assert.equal(corsOriginFor({ ALLOWED_ORIGIN: 'https://*.patra-bus.pages.dev' }, 'https://evil.test'), null);
  assert.equal(corsOriginFor({ ALLOWED_ORIGIN: '*' }, null), '*');
});

test('origin: without ALLOWED_ORIGIN nothing is allowed (TEL-404: the default is no longer "*")', () => {
  for (const e of [{}, { ALLOWED_ORIGIN: '' }, { ALLOWED_ORIGIN: ' , ' }]) {
    assert.equal(isAllowedOrigin(e, 'https://costgal.github.io'), false);
    assert.equal(isAllowedOrigin(e, 'null'), false);
    assert.equal(corsOriginFor(e, 'https://costgal.github.io'), null);
    assert.equal(corsOriginFor(e, 'null'), null);
    assert.equal(corsOriginFor(e, null), null);
  }
});
