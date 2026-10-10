import { test } from 'node:test';
import assert from 'node:assert/strict';

// install-guide.js touches the DOM only inside renderInstallSection; importing it and installHint() must work in node.
const { installHint, captureInstallPrompt } = await import('../web/js/install-guide.js');
const { PAIRS } = await import('../web/js/i18n-en-install.js');

test('installHint() with no globals is null (desktop-like), and an explicit platform is honoured', () => {
  assert.equal(installHint(), null);
  assert.deepEqual(installHint({ os: 'ios', mode: 'browser', browser: 'safari', canPrompt: false }), { os: 'ios', browser: 'safari' });
  assert.equal(installHint({ os: 'ios', mode: 'app', browser: 'safari', canPrompt: false }), null);
});

test('captureInstallPrompt is idempotent and safe without window', () => {
  captureInstallPrompt();
  captureInstallPrompt();
});

test('install English pairs are well formed (unique keys, same placeholders)', () => {
  const ph = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  const seen = new Set();
  for (const [el, en] of PAIRS) {
    assert.ok(!seen.has(el), `duplicate: ${el}`);
    seen.add(el);
    assert.ok(en.trim() && en !== el, `bad pair: ${el}`);
    assert.equal(ph(en), ph(el), `placeholders: ${el}`);
  }
});
