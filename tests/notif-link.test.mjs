import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateUrl } from '../web/js/notif-link.js';

test('isPrivateUrl: coordinates or a place name in the link', () => {
  for (const u of ['#/plan?to=1,2', 'https://x/p/#/corfu/plan?to=1,2&name=a', '#/plan?name=Σπίτι', '#/plan?from=1,2', '#/pin?lat=1&lng=2', 'https://x/?demo#/plan?x=1&to=1,2']) {
    assert.equal(isPrivateUrl(u), true, u);
  }
  for (const u of ['#/', '#/plan', '#/patra/notif?routine=ab&stop=1011', '#/stop/1011', 'https://x/?demo#/stop/1', '#/line/601?route=2015', '#/bus/x?route=1&stop=2', undefined, null, 5]) {
    assert.equal(isPrivateUrl(u), false, String(u));
  }
});

