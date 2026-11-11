import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AREAS, COLORS, UI } from '../scripts/ui-map.mjs';

// docs/DESIGN.md §9: every element has a permanent ID and nick, never reused (TEL-198, TEL-230).
test('every UI map entry has a unique ID of a known area', () => {
  const ids = UI.map((u) => u.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate ID: ${ids.filter((x, i) => ids.indexOf(x) !== i)}`);
  for (const u of UI) {
    assert.match(u.id, /^[A-Z]\d+$/, u.id);
    assert.ok(AREAS[u.id[0]] && COLORS[u.id[0]], `${u.id}: unknown area`);
    assert.ok(u.name && u.sel, `${u.id}: needs name and sel`);
  }
});

test('every UI map entry has a unique nick: English, lower case, one or two words', () => {
  const nicks = UI.map((u) => u.nick);
  for (const u of UI) assert.match(u.nick || '', /^[a-z]+( [a-z]+)?$/, `${u.id}: nick "${u.nick}"`);
  assert.equal(new Set(nicks).size, nicks.length, `duplicate nick: ${nicks.filter((x, i) => nicks.indexOf(x) !== i)}`);
});
