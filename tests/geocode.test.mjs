import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapPhoton, placeType } from '../web/js/geocode.js';

// Photon GeoJSON feature inside Patras (the default city's area).
const feat = (props) => ({ geometry: { coordinates: [21.7346, 38.2466] }, properties: { city: 'Πάτρα', ...props } });

test('placeType: known OSM tag, street, bare address, unknown', () => {
  assert.equal(placeType({ osm_key: 'amenity', osm_value: 'place_of_worship', type: 'house', name: 'Άγιος Ανδρέας' }), 'Ναός');
  assert.equal(placeType({ osm_key: 'highway', osm_value: 'bus_stop', name: 'Πανεπιστήμιο' }), 'Στάση λεωφορείου');
  assert.equal(placeType({ osm_key: 'highway', osm_value: 'residential', type: 'street', name: 'Κορίνθου' }), 'Οδός');
  assert.equal(placeType({ osm_key: 'place', osm_value: 'house', type: 'house', street: 'Κορίνθου', housenumber: '121' }), 'Διεύθυνση');
  // A named place with an unknown tag: no type, never a guess (and never "Διεύθυνση").
  assert.equal(placeType({ osm_key: 'craft', osm_value: 'tailor', type: 'house', name: 'Ράφτης', housenumber: '5' }), null);
  assert.equal(placeType({}), null);
});

test('mapPhoton: the type comes first in the subtitle', () => {
  const p = mapPhoton(feat({ osm_key: 'amenity', osm_value: 'place_of_worship', name: 'Άγιος Ανδρέας', street: 'Αγίου Ανδρέου' }));
  assert.equal(p.name, 'Άγιος Ανδρέας');
  assert.equal(p.subtitle, 'Ναός · Αγίου Ανδρέου · Πάτρα');
  assert.equal(p.approx, undefined);
});

test('mapPhoton: approximate results say so in the subtitle', () => {
  const p = mapPhoton(feat({ osm_key: 'highway', osm_value: 'primary', type: 'street', name: 'Κορίνθου' }), { queryNumber: '121' });
  assert.equal(p.approx, true);
  assert.equal(p.subtitle, 'Οδός · κατά προσέγγιση · Πάτρα');
  const exact = mapPhoton(feat({ osm_key: 'place', osm_value: 'house', type: 'house', street: 'Κορίνθου', housenumber: '121' }), { queryNumber: '121' });
  assert.equal(exact.name, 'Κορίνθου 121');
  assert.equal(exact.subtitle, 'Διεύθυνση · Πάτρα');
  assert.equal(exact.approx, undefined);
});

test('mapPhoton: unknown tag keeps the old subtitle', () => {
  const p = mapPhoton(feat({ osm_key: 'craft', osm_value: 'tailor', name: 'Ράφτης', street: 'Μαιζώνος', housenumber: '5' }));
  assert.equal(p.subtitle, 'Μαιζώνος 5 · Πάτρα');
});
