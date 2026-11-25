// TEL-291: citybus.gr gives a route's stops unordered; scripts/build-routes.mjs rebuilds the order and scores it
// (`confidence`, 0..1). Below LIMITS.lowConfidence the trip shows the route as "estimated" (Kostas, 2026-11-11: shown,
// not hidden). This file names those routes per city, as an exception list that may only get shorter:
// - a route that drops below the line and is not listed fails (a rebuild made the order worse: look before adding it);
// - a listed route that is now above the line fails too (remove its line, the list got shorter).
// A new `npm run fetch-static` / `build-routes` that changes the list updates it here in the same PR, saying why.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LIMITS } from '../web/js/trip.js';

// Starting list: 2026-11-25, routes.json on main. Codes are strings (leading zeros matter: '018', '00130').
const LOW = {
  patra: [
    '00130', '00131', '00132', '00133', '018',
    '1033', '1034', '1042', '2015', '3016', '3017',
    '5011', '5021', '5022', '5023', '5024', '5025', '5034',
    '6062', '6063', '7021', '7071',
    '8031', '8033', '8051', '8052', '9011', '9021',
  ],
  corfu: [],
};
const FILE = { patra: '../web/data/routes.json', corfu: '../web/data/corfu/routes.json' };

const routesOf = (city) => JSON.parse(readFileSync(new URL(FILE[city], import.meta.url), 'utf8')).routes;
const lowNow = (routes) => Object.values(routes)
  .filter((r) => !(Number.isFinite(r.confidence) && r.confidence >= LIMITS.lowConfidence))
  .map((r) => String(r.code))
  .sort();

for (const city of Object.keys(LOW)) {
  test(`route order (${city}): no route below ${LIMITS.lowConfidence} that is not on the list`, () => {
    const routes = routesOf(city);
    const added = lowNow(routes).filter((c) => !LOW[city].includes(c))
      .map((c) => `${c} (line ${routes[c].lineCode}, ${Number(routes[c].confidence ?? 0).toFixed(2)})`);
    assert.deepEqual(added, [], `stop order got less sure on: ${added.join(', ')}`);
  });

  test(`route order (${city}): every listed route is still below ${LIMITS.lowConfidence} (else remove it)`, () => {
    const routes = routesOf(city);
    const now = new Set(lowNow(routes));
    const fixed = LOW[city].filter((c) => !now.has(c));
    assert.deepEqual(fixed, [], `these are no longer low, take them off the list: ${fixed.join(', ')}`);
  });
}

test('route order: the list has no duplicates and only string codes', () => {
  for (const list of Object.values(LOW)) {
    assert.equal(new Set(list).size, list.length);
    for (const c of list) assert.equal(typeof c, 'string');
  }
});
