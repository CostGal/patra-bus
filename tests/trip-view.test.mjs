import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Browser globals the modules touch; set before the dynamic import (as tests/i18n.test.mjs does).
globalThis.document = { documentElement: {} };
Object.defineProperty(globalThis, 'navigator', { value: { language: 'el-GR' }, configurable: true, writable: true });
const { tripModel, optionsModel, dur, etaOf } = await import('../web/js/trip-view.js');
const { setLang } = await import('../web/js/i18n.js');

// ---- sample itineraries, by hand, in the shape of card TEL-290 (and the transfer fields of TEL-292) ----
const NOW = 1731400000000;
const MIN = 60000;
const place = (name, stopCode = null) => ({ lat: 38.25, lng: 21.74, name, stopCode });
const walk = (from, to, seconds, meters, source = 'osrm') => ({ kind: 'walk', from, to, seconds, meters, geometry: null, source, startAt: null, endAt: null });
const bus = (o = {}) => ({
  kind: 'bus', lineCode: '201', routeCode: '2011', routeName: 'Πανεπιστήμιο',
  board: { code: '1011', name: 'ΑΡΕΘΑ', displayName: 'Αρέθα', lat: 38.25, lng: 21.74 },
  alight: { code: '0572', name: 'ΠΑΝΕΠΙΣΤΗΜΙΟ', displayName: 'Πανεπιστήμιο', lat: 38.28, lng: 21.78 },
  boardIndex: 4, alightIndex: 11, nStops: 7,
  departAt: NOW + 10 * MIN, departSource: 'live', arriveAt: NOW + 20 * MIN, arriveSource: 'estimated',
  rideSec: 600, rideSource: 'estimate', vehicleCode: '0412', vehicle: { lat: 38.24, lng: 21.73 }, fetchedAt: NOW,
  confidence: 0.89, orderEstimated: false, departures: [], ...o,
});
// walk 4′ → bus in 10′ (live) → ride 10′ → walk 2′. Leave at 10 − 4 − 2 (spare) = in 4′.
function direct(o = {}, busO = {}) {
  const b = bus(busO);
  const legs = [walk(place(null), place('Αρέθα', '1011'), 240, 300), b, walk(place('Πανεπιστήμιο', '0572'), place('Σπίτι'), 120, 150)];
  const leaveAt = b.departAt == null ? null : b.departAt - (240 + 120) * 1000;
  legs[0].startAt = leaveAt;
  return {
    id: '2011:1011:0572', kind: 'direct', transfers: 0, legs, status: b.departAt == null ? 'none' : 'ok',
    leaveAt, leaveInSec: leaveAt == null ? null : (leaveAt - NOW) / 1000, leaveSource: b.departAt == null ? null : b.departSource,
    arriveAt: b.arriveAt == null ? null : b.arriveAt + 120000, arriveSource: 'estimated',
    confidence: 0.89, estimated: false, liveError: false, next: null, missed: null, transfer: null, bufferSec: 120, ...o,
  };
}
// walk → 606 → walk to the other stop → 609 (estimated: no listed bus) → walk
function transfer({ sameStop = false } = {}) {
  const a = bus({ lineCode: '606', routeCode: '6061', alight: { code: '2001', displayName: 'Αγίου Νικολάου' }, arriveAt: NOW + 18 * MIN });
  const b = bus({ lineCode: '609', routeCode: '6091', board: { code: sameStop ? '2001' : '2002', displayName: sameStop ? 'Αγίου Νικολάου' : 'Γούναρη' },
    departAt: NOW + 24 * MIN, departSource: 'estimated', arriveAt: NOW + 34 * MIN, vehicleCode: null, vehicle: null });
  const legs = [walk(place(null), place('Αρέθα', '1011'), 240, 300), a,
    ...(sameStop ? [] : [walk(place('Αγίου Νικολάου', '2001'), place('Γούναρη', '2002'), 120, 140, 'estimate')]),
    b, walk(place('Πανεπιστήμιο', '0572'), place('Σπίτι'), 120, 150)];
  return {
    id: '6061:1011:2001~6091:2002:0572', kind: 'transfer', transfers: 1, legs, status: 'ok',
    leaveAt: NOW + 4 * MIN, leaveInSec: 240, leaveSource: 'live', arriveAt: NOW + 36 * MIN, arriveSource: 'estimated',
    confidence: 0.8, estimated: true, liveError: false, next: null, missed: null, bufferSec: 120,
    transfer: { waitSec: 360, waitSource: 'estimated', sameStop },
  };
}
const walkOnly = (seconds = 720, source = 'osrm') => ({
  id: 'walk', kind: 'walk', transfers: 0, legs: [{ ...walk(place(null), place('Σπίτι'), seconds, 900, source), startAt: NOW, endAt: NOW + seconds * 1000 }],
  status: 'ok', leaveAt: NOW, leaveInSec: 0, leaveSource: null, arriveAt: NOW + seconds * 1000, arriveSource: 'estimated',
  confidence: 1, estimated: false, liveError: false, next: null, missed: null, transfer: null, bufferSec: 0,
});

const allTimes = (m) => [m.chip.total, ...m.steps.map((s) => s.time)].filter(Boolean);

// ---- title ----
test('title: later → «Φύγε σε N′», now and run → «Φύγε τώρα», none and missed → «Χωρίς δρομολόγιο τώρα», walk → «Με τα πόδια N′»', () => {
  assert.equal(tripModel(direct(), NOW).title.text, 'Φύγε σε 4′');
  assert.equal(tripModel(direct(), NOW + 200 * 1000).title.kind, 'now'); // leave in 40 s
  assert.equal(tripModel(direct(), NOW + 200 * 1000).title.text, 'Φύγε τώρα');
  assert.equal(tripModel(direct(), NOW + 300 * 1000).title.kind, 'run'); // 1′ late, the bus still reachable
  assert.equal(tripModel(direct(), NOW + 300 * 1000).title.text, 'Φύγε τώρα');
  assert.equal(tripModel(direct(), NOW + 400 * 1000).title.kind, 'missed');
  assert.equal(tripModel(direct(), NOW + 400 * 1000).title.text, 'Χωρίς δρομολόγιο τώρα');
  const none = direct({}, { departAt: null, departSource: null, arriveAt: null });
  assert.equal(tripModel(none, NOW).title.kind, 'none');
  assert.equal(tripModel(none, NOW).title.text, 'Χωρίς δρομολόγιο τώρα');
  assert.equal(tripModel(walkOnly(720), NOW).title.text, 'Με τα πόδια 12′');
});

test('the title never has ~, even when everything else is an estimate', () => {
  for (const it of [direct(), direct({ estimated: true, confidence: 0.4 }, { orderEstimated: true }), transfer(), walkOnly(700, 'estimate')]) {
    for (const now of [NOW, NOW + 200e3, NOW + 300e3, NOW + 400e3]) assert.ok(!tripModel(it, now).title.text.includes('~'), it.id);
  }
});

test('scheduled first bus also gives the countdown', () => {
  assert.equal(tripModel(direct({ leaveSource: 'scheduled' }, { departSource: 'scheduled' }), NOW).title.text, 'Φύγε σε 4′');
});

// ---- the estimate rule (TEL-294: the view draws an orange (*) mark from the source; no ~ in any text) ----
test('every time carries its source; no text has a ~', () => {
  for (const it of [direct(), direct({ leaveSource: 'scheduled' }, { departSource: 'scheduled' }), transfer(), transfer({ sameStop: true }), walkOnly(600, 'estimate')]) {
    const m = tripModel(it, NOW, 'Σπίτι');
    for (const tm of allTimes(m)) {
      assert.ok(['live', 'scheduled', 'estimated', 'osrm'].includes(tm.source), `${it.id}: ${tm.source}`);
      assert.ok(!tm.text.includes('~'), `${it.id}: ${tm.text}`);
    }
    for (const s of m.steps) assert.ok(!s.text.includes('~'), `${it.id}: ${s.text}`);
    assert.ok(!m.summary.text.includes('~'), m.summary.text);
  }
  const m = tripModel(direct(), NOW, 'Σπίτι');
  const busStep = m.steps.find((s) => s.kind === 'bus');
  assert.equal(busStep.time.source, 'live', 'the first bus of a direct trip is not an estimate');
  assert.equal(m.chip.total.source, 'estimated', 'the total follows the estimated arrival');
  assert.match(m.summary.text, /άφιξη περίπου/);
});

test('the chip: minutes to arrival, counted from now', () => {
  const it = direct(); // arrives at NOW + 22 min
  assert.deepEqual(tripModel(it, NOW).chip.eta, { text: '22′', source: 'estimated' });
  assert.equal(etaOf(it, NOW + 10 * MIN).text, '12′');
  assert.equal(etaOf(it, NOW + 30 * MIN).text, '0′', 'never below zero');
  assert.equal(tripModel(direct({}, { departAt: null, arriveAt: null }), NOW).chip.eta, null);
});

test('ΕΚΤΙΜ. and the estimate source also in English', () => {
  setLang('en');
  try {
    const m = tripModel(transfer(), NOW, 'Home');
    assert.equal(m.title.text, 'Leave in 4′');
    const second = m.steps.filter((s) => s.kind === 'bus')[1];
    assert.equal(second.flag, 'estimated');
    assert.equal(second.time.source, 'estimated');
    assert.match(m.summary.text, /arrive about/);
    assert.ok(m.notes.includes('The time of the second bus is an estimate.'));
  } finally { setLang('el'); }
});

test('live, scheduled and estimated bus rows give three different flags', () => {
  const live = tripModel(direct(), NOW).steps.find((s) => s.kind === 'bus');
  const sched = tripModel(direct({ leaveSource: 'scheduled' }, { departSource: 'scheduled' }), NOW).steps.find((s) => s.kind === 'bus');
  const est = tripModel(transfer(), NOW).steps.filter((s) => s.kind === 'bus')[1];
  assert.deepEqual([live.flag, sched.flag, est.flag], ['live', 'scheduled', 'estimated']);
  assert.ok(live.tile && sched.tile, 'live and scheduled are arrival tiles');
  assert.ok(!est.tile, 'an estimated bus is not a tile');
});

// ---- steps ----
test('a direct trip: walk, bus, ride, walk, arrival', () => {
  const m = tripModel(direct(), NOW, 'Σπίτι');
  assert.deepEqual(m.steps.map((s) => s.kind), ['walk', 'bus', 'ride', 'walk', 'arrive']);
  assert.equal(m.steps[0].text, 'Περπάτα 4′ ως τη στάση «Αρέθα»');
  assert.equal(m.steps[2].text, '7 στάσεις');
  assert.equal(m.steps[2].sub, 'Κατέβα στη στάση «Πανεπιστήμιο»');
  assert.equal(m.steps[3].text, 'Περπάτα 2′ ως «Σπίτι»');
});

test('a transfer: walk, bus, ride, change, bus, ride, walk, arrival (walk between stops, or the same stop)', () => {
  const order = ['walk', 'bus', 'ride', 'change', 'bus', 'ride', 'walk', 'arrive'];
  const m = tripModel(transfer(), NOW, 'Σπίτι');
  assert.deepEqual(m.steps.map((s) => s.kind), order);
  assert.equal(m.steps[3].text, 'Αλλαγή: περπάτα 2′ ως τη στάση «Γούναρη»');
  assert.match(m.summary.text, /1 αλλαγή/);
  const same = tripModel(transfer({ sameStop: true }), NOW, 'Σπίτι');
  assert.deepEqual(same.steps.map((s) => s.kind), order);
  assert.equal(same.steps[3].text, 'Αλλαγή στη στάση «Αγίου Νικολάου»');
  assert.equal(same.steps[3].sub, 'Περίμενε περίπου 6′');
});

test('a last walk under 25 m is skipped', () => {
  const it = direct();
  it.legs[2].meters = 20;
  assert.deepEqual(tripModel(it, NOW).steps.map((s) => s.kind), ['walk', 'bus', 'ride', 'arrive']);
});

test('a bus with no departure says so and has no time', () => {
  const m = tripModel(direct({}, { departAt: null, departSource: null, arriveAt: null }), NOW);
  const b = m.steps.find((s) => s.kind === 'bus');
  assert.equal(b.sub, 'Χωρίς δρομολόγιο τώρα');
  assert.equal(b.time, null);
  assert.equal(m.chip.total, null, 'no total without leave and arrival');
});

// ---- notes ----
test('orderEstimated adds its note and the trip stays in the list', () => {
  const it = direct({ estimated: true, confidence: 0.5 }, { orderEstimated: true, confidence: 0.5 });
  const models = optionsModel([it], NOW);
  assert.equal(models.length, 1);
  assert.ok(models[0].notes.includes('Η σειρά των στάσεων σε αυτή τη γραμμή δεν είναι βέβαιη. Οι ώρες είναι εκτίμηση.'));
  assert.equal(models[0].summary.estimated, true, 'the ΕΚΤΙΜ. flag in the summary');
});

test('liveError and «walking is faster» notes', () => {
  assert.ok(tripModel(direct({ liveError: true }), NOW).notes.includes('Δεν φορτώθηκαν οι ώρες για αυτή τη στάση.'));
  const [w] = optionsModel([walkOnly(600), direct()], NOW);
  assert.ok(w.notes.includes('Με τα πόδια φτάνεις πιο γρήγορα.'));
  assert.ok(!optionsModel([walkOnly(600)], NOW)[0].notes.includes('Με τα πόδια φτάνεις πιο γρήγορα.'), 'not when it is the only option');
});

// ---- summary tiles and the chip's arrival clock (TEL-294) ----
test('summary tiles: total, walking, arrival, and the change of a transfer', () => {
  const d = tripModel(direct(), NOW, 'Σπίτι');
  assert.deepEqual(d.summary.stats.map((s) => s.key), ['total', 'walk', 'arrive']);
  assert.deepEqual(d.summary.stats.map((s) => s.label), ['σύνολο', 'περπάτημα', 'άφιξη']);
  assert.equal(d.summary.stats[0].value, d.chip.total);
  assert.equal(d.summary.stats[2].value.source, 'estimated');
  assert.equal(d.summary.stats[1].value.source, 'osrm', 'walks from OSRM are not estimates');
  const x = tripModel(transfer(), NOW, 'Σπίτι');
  assert.deepEqual(x.summary.stats.map((s) => s.key), ['total', 'walk', 'arrive', 'change']);
  assert.deepEqual(x.summary.stats[1].value, { text: '8′', source: 'estimated' }, 'a straight-line walk is an estimate');
  const w = tripModel(walkOnly(), NOW, 'Σπίτι');
  assert.deepEqual(w.summary.stats.map((s) => s.key), ['total', 'arrive'], 'a walk has no separate walking tile');
  const none = tripModel(direct({}, { departAt: null, arriveAt: null }), NOW, 'Σπίτι');
  assert.deepEqual(none.summary.stats.map((s) => s.key), ['walk'], 'no bus now: no total, no arrival');
});

test('the chip carries the arrival clock, as the arrival tile', () => {
  const d = tripModel(direct(), NOW, 'Σπίτι');
  assert.deepEqual(d.chip.arrive, d.summary.stats.find((s) => s.key === 'arrive').value);
  assert.equal(tripModel(direct({}, { departAt: null, arriveAt: null }), NOW).chip.arrive, null);
  setLang('en');
  try {
    assert.deepEqual(tripModel(transfer(), NOW, 'Home').summary.stats.map((s) => s.label), ['total', 'walking', 'arrival', 'change']);
  } finally { setLang('el'); }
});

// ---- chips ----
test('five itineraries in, three chips out', () => {
  const its = [1, 2, 3, 4, 5].map((n) => ({ ...direct(), id: `r${n}` }));
  assert.equal(optionsModel(its, NOW).length, 3);
});

test('chips: direct = one line, transfer = two lines, walk = no line', () => {
  const [d, x, w] = optionsModel([direct(), transfer(), walkOnly()], NOW);
  assert.deepEqual(d.chip.lines, ['201']);
  assert.deepEqual(x.chip.lines, ['606', '609']);
  assert.equal(w.chip.kind, 'walk');
  assert.deepEqual(w.chip.lines, []);
});

// ---- data rules ----
test('codes stay strings: line 093 comes out as 093', () => {
  const m = tripModel(direct({}, { lineCode: '093' }), NOW);
  assert.deepEqual(m.chip.lines, ['093']);
  assert.deepEqual(m.peek.lines, ['093']);
  assert.equal(m.steps.find((s) => s.kind === 'bus').leg.lineCode, '093');
});

test('durations: minutes rounded up, «1 ώ 05′» from an hour', () => {
  assert.equal(dur(61), '2′');
  assert.equal(dur(3900), '1 ώ 05′');
});

test('trip-view.js imports nothing from reminders, places, storage or the network', () => {
  const src = readFileSync(new URL('../web/js/trip-view.js', import.meta.url), 'utf8');
  const imports = [...src.matchAll(/^import .* from '(.+)';$/gm)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ['./arrivals-view.js', './geo.js', './i18n.js', './trip-map.js', './trip.js', './ui.js']);
  for (const name of ['onboard', 'store', 'planner', 'walk', 'api', 'geocode']) {
    assert.ok(!new RegExp(`from '\\./${name}\\.js'|import\\(['"]\\./${name}`).test(src), name);
  }
  assert.ok(!/\bfetch\(|localStorage|sendBeacon/.test(src), 'no network or storage of its own');
});

test('trip.css: no blur layer and no side padding of its own', () => {
  const css = readFileSync(new URL('../web/css/trip.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/backdrop-filter/.test(css));
  assert.ok(!/padding-inline/.test(css));
  assert.ok(css.includes('.tripv-title.card-title'), 'the title selector has two classes (U19)');
});
