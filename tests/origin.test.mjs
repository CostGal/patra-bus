import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedOrigin, isPatternOrigin, corsOriginFor } from '../worker/src/origin.js';

const env = { ALLOWED_ORIGIN: 'https://costgal.github.io,http://localhost:8080,https://*.patra-bus.pages.dev' };

test('origin: exact entries and project-scoped wildcard', () => {
  assert.equal(isAllowedOrigin(env, 'https://costgal.github.io'), true);
  assert.equal(isAllowedOrigin(env, 'https://alice-ux.patra-bus.pages.dev'), true);
  assert.equal(isAllowedOrigin(env, 'https://3f2a1b.patra-bus.pages.dev'), true);
});

test('origin: wildcard is one label of that project only', () => {
  for (const o of ['https://evil.pages.dev', 'https://patra-bus.pages.dev', 'https://a.b.patra-bus.pages.dev',
    'https://x.patra-bus.pages.dev.evil.com', 'https://evilpatra-bus.pages.dev', 'http://x.patra-bus.pages.dev',
    'https://x.patra-bus.pagesXdev', null, '']) {
    assert.equal(isAllowedOrigin(env, o), false, String(o));
  }
});

test('origin: "*" and empty config allow everything', () => {
  assert.equal(isAllowedOrigin({ ALLOWED_ORIGIN: '*' }, 'https://x.test'), true);
  assert.equal(isAllowedOrigin({}, 'https://x.test'), true);
});

test('origin: only pattern matches count as preview', () => {
  assert.equal(isPatternOrigin(env, 'https://alice-ux.patra-bus.pages.dev'), true);
  assert.equal(isPatternOrigin(env, 'https://costgal.github.io'), false);
  assert.equal(isPatternOrigin(env, null), false);
  assert.equal(isPatternOrigin({ ALLOWED_ORIGIN: '*' }, 'https://x.test'), false);
});

test('origin: CORS echoes allowed origins, else the first exact entry (never the pattern)', () => {
  assert.equal(corsOriginFor(env, 'https://alice-ux.patra-bus.pages.dev'), 'https://alice-ux.patra-bus.pages.dev');
  assert.equal(corsOriginFor(env, 'https://evil.test'), 'https://costgal.github.io');
  assert.equal(corsOriginFor(env, null), 'https://costgal.github.io');
  assert.equal(corsOriginFor({ ALLOWED_ORIGIN: 'https://*.patra-bus.pages.dev' }, 'https://evil.test'), 'null');
  assert.equal(corsOriginFor({ ALLOWED_ORIGIN: '*' }, null), '*');
});
