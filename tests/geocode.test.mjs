// TEL-172: search fallback in web/js/geocode.js. No network: fetch is faked from the FEATURES map below.
// The module cache lives for the whole file, so every test that goes through fetch uses its own street.
// Privacy (card TEL-172): no single house number on Κορίνθου goes to fetch here; Κορίνθου appears only in the
// pure-function cases.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  searchPlaces, mapPhoton, queryNumber, stripNumber, numberMatches, latinToGreek, streetPlace, rankExact,
} from '../web/js/geocode.js';
import { searchKey } from '../web/js/text.js';
import { city } from '../web/js/cities.js';
import { haversine } from '../web/js/geo.js';

const near = city().center;
const feat = ({ name, street, housenumber, osm_key = 'highway', osm_value, lat, lng }) => ({
  geometry: { type: 'Point', coordinates: [lng, lat] },
  properties: { name, street, housenumber, osm_key, osm_value, city: 'Πάτρα' },
});
// Five segments of one street along a line (the middle one is index 2) plus one of another street.
const segments = (name, lat0 = 38.24, lng0 = 21.73) =>
  [0, 1, 2, 3, 4].map((i) => feat({ name, lat: lat0 + i * 0.001, lng: lng0 + i * 0.001 }));

// text sent as q → features. Anything else answers [].
const FEATURES = {
  'Μαιζώνος': segments('Μαιζώνος'),
  'Γούναρη 20': [feat({ street: 'Γούναρη', housenumber: '20', osm_key: 'place', lat: 38.245, lng: 21.735 })],
  'κανακαρι': segments('Κανακάρη', 38.25, 21.74),
  'Lidl': [feat({ name: 'Lidl', osm_key: 'shop', lat: 38.26, lng: 21.75 })],
  'αγιου νικολαου': segments('Αγίου Νικολάου', 38.247, 21.732),
  'Ερμού': segments('Ερμού', 38.243, 21.731),
  // TEL-161 (iPhone in Patras, 2026-10-19): what Photon answers, plus an OSM bus stop like those of TEL-172.
  'Άγιος Ανδρέας': [
    feat({ name: 'Αγγλικανική Εκκλησία - Άγιος Ανδρέας', osm_key: 'amenity', osm_value: 'place_of_worship', lat: 38.2518, lng: 21.7378 }),
    feat({ name: 'ΑΓΙΟΣ ΑΝΔΡΕΑΣ', osm_key: 'highway', osm_value: 'bus_stop', lat: 38.2401, lng: 21.7262 }),
    feat({ name: 'Άγιος Ανδρέας', osm_key: 'amenity', osm_value: 'place_of_worship', lat: 38.2423, lng: 21.7279 }),
  ],
};

let urls = [];
const realFetch = globalThis.fetch;
beforeEach(() => {
  urls = [];
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    urls.push(u);
    const features = FEATURES[u.searchParams.get('q')] || [];
    return { ok: true, status: 200, json: async () => ({ type: 'FeatureCollection', features }) };
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

const search = (q) => searchPlaces(q, { data: { stops: [] }, near });
const qs = () => urls.map((u) => u.searchParams.get('q'));

test('queryNumber / stripNumber pick the house number, not the first digits', () => {
  const cases = [
    ['Κορίνθου 121', '121', 'Κορίνθου'],
    ['25ης Μαρτίου 10', '10', '25ης Μαρτίου'],
    ['28ης Οκτωβρίου', null, '28ης Οκτωβρίου'],
    ['Μαιζώνος 335Α', '335', 'Μαιζώνος'],
    ['Ερμού 37-41', '37', 'Ερμού'],
    ['Κορίνθου 26221', null, 'Κορίνθου 26221'],
    ['1011', null, '1011'],
  ];
  for (const [q, num, rest] of cases) {
    assert.equal(queryNumber(q), num, q);
    assert.equal(stripNumber(q), rest, q);
  }
  assert.equal(queryNumber('Γούναρη 12b'), '12');
  assert.equal(stripNumber('  Γούναρη ,  12b '), 'Γούναρη');
});

test('numberMatches: ranges, letters and lists in OSM still match', () => {
  const yes = ['37', '37-41', '35-41', '37Α', '35,37'];
  const no = ['39', '137', undefined];
  for (const h of yes) assert.equal(numberMatches(h, '37'), true, String(h));
  for (const h of no) assert.equal(numberMatches(h, '37'), false, String(h));

  const f = (housenumber) => feat({ street: 'Ερμού', housenumber, osm_key: 'place', lat: 38.245, lng: 21.735 });
  assert.equal(mapPhoton(f('37-41'), { queryNumber: '37' }).approx, undefined);
  assert.equal(mapPhoton(f('39'), { queryNumber: '37' }).approx, true);
});

test('latinToGreek: for the request only, null for Greek or no Latin', () => {
  assert.equal(latinToGreek('Korinthou 129'), 'κορινθου 129');
  assert.equal(latinToGreek('Maizonos'), 'μαιζονος');
  assert.equal(latinToGreek('Agiou Nikolaou'), 'αγιου νικολαου');
  assert.equal(latinToGreek('Κορίνθου'), null);
  assert.equal(latinToGreek('Lidl Πάτρα'), null);
  assert.equal(latinToGreek('129'), null);
});

test('streetPlace: one place, the middle segment, approx', () => {
  const segs = segments('Μαιζώνος');
  const other = feat({ name: 'Γούναρη', lat: 38.249, lng: 21.739 });
  const out = streetPlace([segs[0], other, ...segs.slice(1)]);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'Μαιζώνος');
  assert.equal(out[0].approx, true);
  const mid = segs[2].geometry.coordinates;
  assert.ok(haversine(out[0], { lat: mid[1], lng: mid[0] }) < 1);

  const shop = feat({ name: 'Φούρνος', osm_key: 'shop', lat: 38.25, lng: 21.74 });
  const noRoad = streetPlace([shop, feat({ name: 'Κάτι', osm_key: 'amenity', lat: 38.251, lng: 21.741 })]);
  assert.equal(noRoad.length, 1);
  assert.equal(noRoad[0].name, 'Φούρνος');
  assert.equal(noRoad[0].approx, true);

  assert.deepEqual(streetPlace([]), []);
  assert.deepEqual(streetPlace([feat({ name: 'Μακριά', lat: 37.9, lng: 23.7 })]), []); // outside the city
});

test('Greek with an unknown number → the street, approx, two requests', async () => {
  const out = await search('Μαιζώνος 150');
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'Μαιζώνος');
  assert.equal(out[0].approx, true);
  assert.deepEqual(qs(), ['Μαιζώνος 150', 'Μαιζώνος']);
  assert.ok(!/\d/.test(qs()[1]));
});

test('Greek with a known number → the address, one request, not approx', async () => {
  const out = await search('Γούναρη 20');
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'Γούναρη 20');
  assert.equal(out[0].approx, undefined);
  assert.equal(urls.length, 1);
});

test('Latin with a number → asked in Greek letters, then the street in Greek', async () => {
  const out = await search('Kanakari 77');
  assert.deepEqual(qs(), ['κανακαρι 77', 'κανακαρι']);
  assert.equal(out.length, 1);
  assert.equal(out[0].approx, true);
  // The shown name comes from Photon's answer, never from the converted query.
  assert.equal(out[0].name, 'Κανακάρη');
  assert.ok(!out[0].name.includes('κανακαρι') && !out[0].subtitle.includes('κανακαρι'));
});

test('Latin without a number → as typed first; Greek letters only when that is empty', async () => {
  const shop = await search('Lidl');
  assert.deepEqual(qs(), ['Lidl']);
  assert.equal(shop[0].name, 'Lidl');

  urls = [];
  const street = await search('Agiou Nikolaou');
  assert.deepEqual(qs(), ['Agiou Nikolaou', 'αγιου νικολαου']);
  assert.ok(street.length >= 1);
  for (const p of street) {
    assert.equal(p.name, 'Αγίου Νικολάου');
    assert.equal(p.approx, undefined);
  }
});

test('request shape: only q, lat, lon, limit, bbox; position at 2 decimals', async () => {
  await search('Ρήγα Φεραίου 9');
  await search('Ανθείας');
  assert.ok(urls.length >= 3);
  for (const u of urls) {
    assert.deepEqual([...u.searchParams.keys()].sort(), ['bbox', 'lat', 'limit', 'lon', 'q']);
    assert.match(u.searchParams.get('lat'), /^-?\d+\.\d{2}$/);
    assert.match(u.searchParams.get('lon'), /^-?\d+\.\d{2}$/);
  }
});

test('TEL-161: the landmark named like the query comes before a look-alike stop; OSM bus stops are dropped', async () => {
  const stop = { code: '529', key: searchKey('ΝΟΣ. ΑΓΙΟΣ ΑΝΔΡΕΑΣ'), displayName: 'Νοσ. Άγιος Ανδρέας', lat: 38.2367, lng: 21.7458, lineCodes: ['601'] };
  const out = await searchPlaces('Άγιος Ανδρέας', { data: { stops: [stop] }, near });
  assert.equal(out[0].name, 'Άγιος Ανδρέας');
  assert.equal(out[0].exact, true);
  assert.ok(out.some((p) => p.kind === 'stop' && p.stopCode === '529'), 'the stop is still offered');
  assert.ok(!out.some((p) => p.name === 'ΑΓΙΟΣ ΑΝΔΡΕΑΣ'), 'no OSM bus stop');
  assert.equal(out.find((p) => p.name.startsWith('Αγγλικανική')).exact, undefined);
});

test('rankExact: approximate places and stops never count as exact; order otherwise kept', () => {
  const places = [
    { kind: 'stop', name: 'Ερμού', stopCode: '1' },
    { kind: 'place', name: 'Ερμού', approx: true },
    { kind: 'place', name: 'Πλατεία Ερμού' },
    { kind: 'place', name: 'Ερμού 5' },
  ];
  const out = rankExact('Ερμού', places);
  assert.deepEqual(out.map((p) => p.name), ['Ερμού 5', 'Ερμού', 'Ερμού', 'Πλατεία Ερμού']);
  assert.deepEqual(out.map((p) => !!p.exact), [true, false, false, false]);
});

test('cache: the street request is shared by two unknown numbers', async () => {
  await search('Ερμού 300');
  await search('Ερμού 301');
  assert.deepEqual(qs(), ['Ερμού 300', 'Ερμού', 'Ερμού 301']);
});
