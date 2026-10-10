import { test } from 'node:test';
import assert from 'node:assert/strict';
import { b64uEncode } from '../worker/src/push.js';
import { alightText, decideReminder, validateReminder } from '../worker/src/reminders.js';
import {
  validateRoutine,
  athensParts,
  athensOffset,
  athensEpoch,
  nextOccurrence,
  pickBus,
  relocateBus,
  routineText,
  decideRoutine,
  RoutineBase,
  CHECK_LEAD_MS,
  EXPIRE_MS,
} from '../worker/src/routines.js';

const H = 3600e3;
const MIN = 60e3;
const utc = (...a) => Date.UTC(...a);

// --- Athens time helpers ---
test('athensOffset: EET in winter, EEST in summer', () => {
  assert.equal(athensOffset(utc(2026, 0, 15, 12)), 2 * H);
  assert.equal(athensOffset(utc(2026, 6, 1, 12)), 3 * H);
});

test('athensParts: local date can differ from the UTC date', () => {
  const p = athensParts(utc(2026, 9, 9, 22, 30)); // Fri 22:30Z = Sat 01:30 EEST
  assert.deepEqual([p.y, p.mo, p.d, p.h, p.mi, p.dow], [2026, 10, 10, 1, 30, 6]);
});

test('athensEpoch: plain winter/summer days', () => {
  assert.equal(athensEpoch(2026, 1, 15, 8, 0), utc(2026, 0, 15, 6, 0));
  assert.equal(athensEpoch(2026, 7, 1, 8, 0), utc(2026, 6, 1, 5, 0));
});

test('athensEpoch: DST boundaries (spring gap, autumn overlap)', () => {
  // 2026-03-29 03:00 EET -> 04:00 EEST (01:00Z). 03:30 does not exist: shifted forward to 04:30 EEST.
  assert.equal(athensEpoch(2026, 3, 29, 3, 30), utc(2026, 2, 29, 1, 30));
  assert.equal(athensEpoch(2026, 3, 29, 2, 59), utc(2026, 2, 29, 0, 59));
  assert.equal(athensEpoch(2026, 3, 29, 4, 0), utc(2026, 2, 29, 1, 0));
  // 2026-10-25 04:00 EEST -> 03:00 EET (01:00Z). 03:30 happens twice: the earlier (EEST) one wins.
  assert.equal(athensEpoch(2026, 10, 25, 3, 30), utc(2026, 9, 25, 0, 30));
  assert.equal(athensEpoch(2026, 10, 25, 2, 59), utc(2026, 9, 24, 23, 59));
  assert.equal(athensEpoch(2026, 10, 25, 4, 0), utc(2026, 9, 25, 2, 0));
  // The same wall time a day apart is 23 h / 25 h apart across the changes.
  assert.equal(athensEpoch(2026, 3, 29, 8, 0) - athensEpoch(2026, 3, 28, 8, 0), 23 * H);
  assert.equal(athensEpoch(2026, 10, 25, 8, 0) - athensEpoch(2026, 10, 24, 8, 0), 25 * H);
});

// --- nextOccurrence ---
const WEEKDAYS = [1, 2, 3, 4, 5];

test('nextOccurrence: skips weekends, strictly after', () => {
  const fri9 = athensEpoch(2026, 10, 9, 9, 0);
  assert.equal(nextOccurrence({ days: WEEKDAYS, time: '08:00' }, fri9), athensEpoch(2026, 10, 12, 8, 0)); // Monday
  assert.equal(athensParts(nextOccurrence({ days: WEEKDAYS, time: '08:00' }, fri9)).dow, 1);
  const fri8 = athensEpoch(2026, 10, 9, 8, 0);
  assert.equal(nextOccurrence({ days: WEEKDAYS, time: '08:00' }, fri8 - 1), fri8);
  assert.equal(nextOccurrence({ days: WEEKDAYS, time: '08:00' }, fri8), athensEpoch(2026, 10, 12, 8, 0));
});

test('nextOccurrence: today still ahead, or tomorrow when past', () => {
  const sat = athensEpoch(2026, 10, 10, 6, 0);
  assert.equal(nextOccurrence({ days: [6], time: '08:00' }, sat), athensEpoch(2026, 10, 10, 8, 0));
  assert.equal(nextOccurrence({ days: [6, 0], time: '05:00' }, sat), athensEpoch(2026, 10, 11, 5, 0));
  assert.equal(nextOccurrence({ days: [6], time: '05:00' }, sat), athensEpoch(2026, 10, 17, 5, 0));
});

test('nextOccurrence: uses the Athens date, not the UTC date', () => {
  const t = utc(2026, 9, 9, 22, 30); // Fri 22:30Z = Sat 01:30 Athens
  assert.equal(nextOccurrence({ days: [6], time: '08:00' }, t), utc(2026, 9, 10, 5, 0));
  assert.equal(nextOccurrence({ days: [5], time: '08:00' }, t), utc(2026, 9, 16, 5, 0)); // next Friday
});

test('nextOccurrence: across DST changes keeps 08:00 local', () => {
  const spring = nextOccurrence({ days: [0], time: '08:00' }, athensEpoch(2026, 3, 28, 12, 0));
  assert.equal(spring, utc(2026, 2, 29, 5, 0)); // 08:00 EEST
  const autumn = nextOccurrence({ days: [0], time: '08:00' }, athensEpoch(2026, 10, 24, 12, 0));
  assert.equal(autumn, utc(2026, 9, 25, 6, 0)); // 08:00 EET
  // Week after the autumn change: still 08:00 local.
  assert.equal(nextOccurrence({ days: [0], time: '08:00' }, autumn), utc(2026, 10, 1, 6, 0));
  // A routine in the spring gap lands at 04:30 that day.
  assert.equal(nextOccurrence({ days: [0], time: '03:30' }, athensEpoch(2026, 3, 28, 12, 0)), utc(2026, 2, 29, 1, 30));
  // Every-day routine over the autumn overlap: one occurrence per local day.
  const d1 = nextOccurrence({ days: [0, 1, 2, 3, 4, 5, 6], time: '03:30' }, athensEpoch(2026, 10, 24, 12, 0));
  const d2 = nextOccurrence({ days: [0, 1, 2, 3, 4, 5, 6], time: '03:30' }, d1);
  assert.equal(d1, utc(2026, 9, 25, 0, 30));
  assert.equal(d2, athensEpoch(2026, 10, 26, 3, 30));
});

test('nextOccurrence: month and year rollover', () => {
  assert.equal(nextOccurrence({ days: [5], time: '23:59' }, athensEpoch(2026, 12, 31, 23, 59)), athensEpoch(2027, 1, 1, 23, 59)); // Fri 2027-01-01
});

// --- validation ---
const RFC_UA = 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
const RFC_AUTH = 'BTBZMqHH6r4Tts7J_aSIgg';
const goodSub = () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: RFC_UA, auth: RFC_AUTH } });
const goodRoutine = (over = {}) => ({
  subscription: goodSub(),
  days: [1, 2, 3, 4, 5],
  time: '08:10',
  tz: 'Europe/Athens',
  title: 'Φύγε για τη δουλειά',
  url: '#/plan',
  trip: { stopCode: '1011', routeCode: '2015', lineCode: '201', offsetSec: 300 },
  leadMin: 2,
  ...over,
});
const tripWith = (o) => goodRoutine({ trip: { ...goodRoutine().trip, ...o } });
const fieldOf = (raw, opts) => {
  const r = validateRoutine(raw, opts);
  return r.ok ? null : r.error;
};

test('validateRoutine accepts a good request and returns a cleaned copy', () => {
  const r = validateRoutine({ ...goodRoutine({ days: [3, 1, 3, 0] }), extra: 'x', trip: { ...goodRoutine().trip, junk: 1, vehicleCode: 'v' } });
  assert.ok(r.ok);
  assert.deepEqual(r.value.days, [0, 1, 3]);
  assert.ok(!('extra' in r.value));
  assert.ok(!('junk' in r.value.trip) && !('vehicleCode' in r.value.trip));
  assert.equal(r.value.tz, 'Europe/Athens');
  assert.equal(validateRoutine(goodRoutine({ url: undefined })).ok, true);
  assert.equal(validateRoutine(goodRoutine({ leadMin: 0 })).ok, true);
  assert.equal(validateRoutine(goodRoutine({ leadMin: 15 })).ok, true);
  assert.equal(validateRoutine(goodRoutine({ days: [0, 1, 2, 3, 4, 5, 6] })).ok, true);
  assert.equal(validateRoutine(goodRoutine({ time: '00:00' })).ok, true);
  assert.equal(validateRoutine(goodRoutine({ time: '23:59' })).ok, true);
  assert.equal(validateRoutine(goodRoutine({ trip: { ...goodRoutine().trip, offsetSec: 3600 } })).ok, true);
});

test('validateRoutine rejects bad input', () => {
  assert.equal(fieldOf(null), 'body');
  assert.equal(fieldOf([]), 'body');
  assert.equal(fieldOf(goodRoutine({ subscription: { ...goodSub(), endpoint: 'https://evil.com/x' } })), 'subscription.endpoint');
  assert.equal(fieldOf(goodRoutine({ subscription: { ...goodSub(), endpoint: 'http://fcm.googleapis.com/x' } })), 'subscription.endpoint');
  assert.equal(fieldOf(goodRoutine({ subscription: { endpoint: goodSub().endpoint } })), 'subscription.keys');
  assert.equal(fieldOf(goodRoutine({ subscription: { ...goodSub(), keys: { p256dh: 'AAAA', auth: RFC_AUTH } } })), 'subscription.keys');
  for (const days of [[], undefined, 'mon', [7], [-1], [1.5], ['1'], [0, 1, 2, 3, 4, 5, 6, 0]]) {
    assert.equal(fieldOf(goodRoutine({ days })), 'days', JSON.stringify(days));
  }
  for (const time of ['8:00', '24:00', '08:60', '0800', '08:00:00', '', 800, undefined]) {
    assert.equal(fieldOf(goodRoutine({ time })), 'time', String(time));
  }
  for (const tz of ['UTC', 'europe/athens', 'Europe/Berlin', undefined]) assert.equal(fieldOf(goodRoutine({ tz })), 'tz', String(tz));
  assert.equal(fieldOf(goodRoutine({ title: '' })), 'title');
  assert.equal(fieldOf(goodRoutine({ title: 'x'.repeat(121) })), 'title');
  assert.equal(fieldOf(goodRoutine({ url: 'x'.repeat(301) })), 'url');
  for (const leadMin of [-1, 16, 1.5, '2', undefined, NaN]) assert.equal(fieldOf(goodRoutine({ leadMin })), 'leadMin', String(leadMin));
  assert.equal(fieldOf(goodRoutine({ trip: undefined })), 'trip');
  assert.equal(fieldOf(goodRoutine({ trip: [] })), 'trip');
  assert.equal(fieldOf(tripWith({ stopCode: 'abc' })), 'trip.stopCode');
  assert.equal(fieldOf(tripWith({ stopCode: '1234567' })), 'trip.stopCode');
  assert.equal(fieldOf(tripWith({ stopCode: '../x' })), 'trip.stopCode');
  assert.equal(fieldOf(tripWith({ routeCode: '' })), 'trip.routeCode');
  assert.equal(fieldOf(tripWith({ routeCode: 'x'.repeat(17) })), 'trip.routeCode');
  assert.equal(fieldOf(tripWith({ lineCode: 7 })), 'trip.lineCode');
  assert.equal(fieldOf(tripWith({ offsetSec: -1 })), 'trip.offsetSec');
  assert.equal(fieldOf(tripWith({ offsetSec: 3601 })), 'trip.offsetSec');
  assert.equal(fieldOf(tripWith({ offsetSec: '60' })), 'trip.offsetSec');
});

test('validateRoutine: local endpoint only with allowLocal', () => {
  const raw = goodRoutine({ subscription: { ...goodSub(), endpoint: 'http://localhost:8799/push/1' } });
  assert.equal(fieldOf(raw, {}), 'subscription.endpoint');
  assert.equal(validateRoutine(raw, { allowLocal: true }).ok, true);
});

// --- bus choice / decision ---
const NOW = utc(2026, 9, 12, 4, 40); // Mon 07:40 Athens
const trip = { stopCode: '1011', routeCode: '2015', lineCode: '201', offsetSec: 300 };
const veh = (over = {}) => ({ routeCode: '2015', vehicleCode: 'v1', etaSec: 900, live: true, ...over });
const liveAt = (vehicles, fetchedAt = NOW) => ({ fetchedAt, vehicles });

test('pickBus: first catchable bus of the route', () => {
  const l = liveAt([
    veh({ vehicleCode: 'gone', etaSec: 200 }), // leave = eta - 300 s < now: missed
    veh({ vehicleCode: 'other', routeCode: '9', etaSec: 400 }),
    veh({ vehicleCode: 'b', etaSec: 1500, live: false }),
    veh({ vehicleCode: 'a', etaSec: 900 }),
  ]);
  const p = pickBus(l, trip, NOW);
  assert.equal(p.vehicleCode, 'a');
  assert.equal(p.arrivalAt, NOW + 900e3);
  assert.equal(p.leaveAt, NOW + 600e3);
  assert.equal(pickBus(liveAt([veh({ etaSec: 300 })]), trip, NOW).leaveAt, NOW); // leave exactly now is fine
  assert.equal(pickBus(liveAt([veh({ etaSec: 299 })]), trip, NOW), null);
  assert.equal(pickBus(liveAt([]), trip, NOW), null);
  assert.equal(pickBus(null, trip, NOW), null);
  assert.equal(pickBus({ fetchedAt: NOW, vehicles: [], noService: true }, trip, NOW), null);
});

test('pickBus: accounts for the age of the data', () => {
  const p = pickBus(liveAt([veh({ etaSec: 900 })], NOW - 60e3), trip, NOW);
  assert.equal(p.arrivalAt, NOW + 840e3);
});

test('relocateBus: by vehicleCode, else nearest arrival within 10 min', () => {
  const pick = { arrivalAt: NOW + 900e3, vehicleCode: 'a' };
  assert.equal(relocateBus(liveAt([veh({ vehicleCode: 'a', etaSec: 1000 })]), trip, pick, NOW).leaveAt, NOW + 700e3);
  assert.equal(relocateBus(liveAt([veh({ vehicleCode: 'b', etaSec: 900 })]), trip, pick, NOW), null);
  const noCode = { arrivalAt: NOW + 900e3, vehicleCode: null };
  const l = liveAt([veh({ vehicleCode: 'x', etaSec: 100 }), veh({ vehicleCode: 'y', etaSec: 950 }), veh({ vehicleCode: 'z', etaSec: 880 })]);
  assert.equal(relocateBus(l, trip, noCode, NOW).arrivalAt, NOW + 880e3);
  assert.equal(relocateBus(liveAt([veh({ etaSec: 2000 })]), trip, noCode, NOW), null);
});

test('routineText', () => {
  assert.equal(routineText('601', 2 * MIN), 'Φύγε σε 2′ για το 601');
  assert.equal(routineText('601', 2.4 * MIN), 'Φύγε σε 2′ για το 601');
  assert.equal(routineText('601', 29e3), 'Φύγε τώρα για το 601');
  assert.equal(routineText('601', -5e3), 'Φύγε τώρα για το 601');
});

test('decideRoutine: on time -> send; delayed -> rearm (max 3); gone -> send from plan', () => {
  const pick = { arrivalAt: NOW + 900e3, leaveAt: NOW + 600e3, vehicleCode: 'a' };
  const r = { trip, leadMin: 2, pick, rearms: 0 };
  const alarmAt = NOW + 480e3; // leave - lead
  const at = NOW + 480e3;
  const d = decideRoutine({ r, live: liveAt([veh({ vehicleCode: 'a', etaSec: 900 })], NOW), now: at, alarmAt });
  // refreshed at `at` with the same absolute arrival (fetched at NOW): 420 s left, leave in 120 s
  assert.deepEqual(d, { action: 'send', body: 'Φύγε σε 2′ για το 201' });
  const late = decideRoutine({ r, live: liveAt([veh({ vehicleCode: 'a', etaSec: 1100 })], NOW), now: at, alarmAt });
  assert.deepEqual(late, { action: 'rearm', at: NOW + 800e3 - 120e3 });
  assert.equal(decideRoutine({ r: { ...r, rearms: 3 }, live: liveAt([veh({ vehicleCode: 'a', etaSec: 1100 })], NOW), now: at, alarmAt }).action, 'send');
  const tol = decideRoutine({ r, live: liveAt([veh({ vehicleCode: 'a', etaSec: 960 })], NOW), now: at, alarmAt }); // exactly 60 s late
  assert.equal(tol.action, 'send');
  assert.equal(decideRoutine({ r, live: liveAt([veh({ vehicleCode: 'a', etaSec: 961 })], NOW), now: at, alarmAt }).action, 'rearm');
  const gone = decideRoutine({ r, live: liveAt([]), now: at, alarmAt });
  assert.deepEqual(gone, { action: 'send', body: 'Φύγε σε 2′ για το 201' });
  assert.equal(decideRoutine({ r, live: null, now: at, alarmAt }).action, 'send');
  const early = decideRoutine({ r, live: liveAt([veh({ vehicleCode: 'a', etaSec: 700 })], NOW), now: at, alarmAt });
  assert.deepEqual(early, { action: 'send', body: 'Φύγε τώρα για το 201' });
});

// --- Durable Object flow with fake storage ---
function fakeStorage() {
  const m = new Map();
  const s = {
    alarm: null,
    get: async (k) => (m.has(k) ? structuredClone(m.get(k)) : undefined),
    put: async (k, v) => void m.set(k, structuredClone(v)),
    deleteAll: async () => void m.clear(),
    deleteAlarm: async () => void (s.alarm = null),
    setAlarm: async (t) => void (s.alarm = t),
    raw: m,
  };
  return s;
}

test('Routine DO: check -> send -> next day; 410 deletes; expiry deletes', async () => {
  const realNow = Date.now;
  const realFetch = globalThis.fetch;
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const env = {
    VAPID_PRIVATE_KEY: jwk.d,
    VAPID_PUBLIC_KEY: b64uEncode(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey))),
    VAPID_SUBJECT: 'https://example.org',
  };
  const pushes = [];
  let pushStatus = 201;
  globalThis.fetch = async (url) => {
    pushes.push(url);
    return new Response(null, { status: pushStatus });
  };
  let clock = utc(2026, 9, 12, 4, 0); // Mon 07:00 Athens
  Date.now = () => clock;
  let liveEta = null; // [fetchedAt, etaSec]
  try {
    const storage = fakeStorage();
    class T extends RoutineBase {
      async getLive() {
        if (!liveEta) throw new Error('down');
        return liveAt([veh({ vehicleCode: 'a', etaSec: liveEta[1] })], liveEta[0]);
      }
    }
    const make = () => new T({ storage }, env);
    const routine = { id: 'abc', ...validateRoutine(goodRoutine({ days: [0, 1, 2, 3, 4, 5, 6], time: '08:00' })).value };
    const res = await make().fetch(new Request('https://routine/', { method: 'POST', body: JSON.stringify(routine) }));
    assert.equal(res.status, 201);
    const leave = utc(2026, 9, 12, 5, 0); // 08:00 EEST
    assert.equal(storage.alarm, leave - CHECK_LEAD_MS);

    // check: upstream down -> retry in 90 s
    clock = storage.alarm;
    await make().alarm();
    assert.equal(storage.alarm, clock + 90e3);
    assert.equal(pushes.length, 0);

    // check: bus arrives in 15', offset 5', lead 2' -> alarm at +8'
    clock = storage.alarm;
    liveEta = [clock, 900];
    await make().alarm();
    assert.equal(storage.alarm, clock + 8 * MIN);

    // send
    clock = storage.alarm;
    liveEta = [clock - 5e3, 420 + 5];
    await make().alarm();
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0], 'https://fcm.googleapis.com/fcm/send/abc');
    assert.equal(storage.alarm, utc(2026, 9, 13, 5, 0) - CHECK_LEAD_MS); // next day's check
    assert.equal((await storage.get('r')).phase, 'check');

    // push service says gone -> routine removed
    clock = storage.alarm;
    liveEta = [clock, 900];
    await make().alarm();
    clock = storage.alarm;
    liveEta = [clock - 5e3, 425];
    pushStatus = 410;
    await make().alarm();
    assert.equal(storage.raw.size, 0);

    // 5xx -> one retry later, then moves on
    const s2 = fakeStorage();
    clock = utc(2026, 9, 12, 4, 0);
    liveEta = null;
    class T2 extends T {}
    await new T2({ storage: s2 }, env).fetch(new Request('https://routine/', { method: 'POST', body: JSON.stringify(routine) }));
    clock = s2.alarm;
    liveEta = [clock, 900];
    await new T2({ storage: s2 }, env).alarm();
    clock = s2.alarm;
    liveEta = [clock, 420];
    pushStatus = 503;
    const before = pushes.length;
    await new T2({ storage: s2 }, env).alarm();
    assert.equal(pushes.length, before + 1);
    assert.equal((await s2.get('r')).phase, 'retry');
    clock = s2.alarm;
    pushStatus = 201;
    await new T2({ storage: s2 }, env).alarm();
    assert.equal(pushes.length, before + 2);
    assert.equal((await s2.get('r')).phase, 'check');

    // expiry: past 120 days the next alarm deletes everything
    clock = (await s2.get('r')).createdAt + EXPIRE_MS + 1;
    await new T2({ storage: s2 }, env).alarm();
    assert.equal(s2.raw.size, 0);

    // advance() near expiry drops the routine instead of arming a day past it
    const s3 = fakeStorage();
    clock = utc(2026, 9, 12, 4, 0);
    await new T2({ storage: s3 }, env).fetch(new Request('https://routine/', { method: 'POST', body: JSON.stringify(routine) }));
    const r3 = await s3.get('r');
    await s3.put('r', { ...r3, createdAt: clock - EXPIRE_MS + 2 * H });
    liveEta = null; // nothing to pick; past the planned time -> advance
    clock = r3.leave + 1000;
    await new T2({ storage: s3 }, env).alarm();
    assert.equal(s3.raw.size, 0);
  } finally {
    Date.now = realNow;
    globalThis.fetch = realFetch;
  }
});

test('Routine DO: DELETE clears alarm and state', async () => {
  const storage = fakeStorage();
  await storage.put('r', { x: 1 });
  await storage.setAlarm(5);
  const res = await new RoutineBase({ storage }, {}).fetch(new Request('https://routine/', { method: 'DELETE' }));
  assert.equal(res.status, 204);
  assert.equal(storage.alarm, null);
  assert.equal(storage.raw.size, 0);
});

// --- reminders: kind + stopName + alight text ---
const NOW2 = utc(2026, 9, 10, 12, 0);
const remReq = (over = {}) => ({
  subscription: goodSub(),
  at: NOW2 + 10 * MIN,
  title: 'Κατέβα σύντομα',
  tag: 'onboard-1',
  trip: { stopCode: '1011', routeCode: '2015', lineCode: '201', vehicleCode: 'v1', offsetSec: 90, stopName: 'Πανεπιστημίου' },
  kind: 'alight',
  ...over,
});

test('validateReminder: kind and trip.stopName', () => {
  const v = validateReminder(remReq(), NOW2);
  assert.ok(v.ok);
  assert.equal(v.value.kind, 'alight');
  assert.equal(v.value.trip.stopName, 'Πανεπιστημίου');
  assert.equal(validateReminder(remReq({ kind: undefined }), NOW2).value.kind, 'leave');
  assert.equal(validateReminder(remReq({ kind: 'leave' }), NOW2).value.kind, 'leave');
  assert.equal(validateReminder(remReq({ kind: 'boom' }), NOW2).error, 'kind');
  assert.equal(validateReminder(remReq({ kind: 7 }), NOW2).error, 'kind');
  const noName = validateReminder(remReq({ trip: { ...remReq().trip, stopName: undefined } }), NOW2);
  assert.ok(noName.ok && !('stopName' in noName.value.trip));
  assert.equal(validateReminder(remReq({ trip: { ...remReq().trip, stopName: 'x'.repeat(81) } }), NOW2).error, 'trip.stopName');
  assert.equal(validateReminder(remReq({ trip: { ...remReq().trip, stopName: 5 } }), NOW2).error, 'trip.stopName');
  assert.equal(validateReminder(remReq({ trip: { ...remReq().trip, stopName: 'x'.repeat(80) } }), NOW2).ok, true);
});

test('alight text', () => {
  assert.equal(alightText('Πανεπιστημίου'), 'Ετοιμάσου: η στάση «Πανεπιστημίου» σε ~1′');
  assert.equal(alightText(undefined), 'Ετοιμάσου: η στάση σου σε ~1′');
  const rem = { at: NOW2, kind: 'alight', title: 't', body: 'orig', trip: remReq().trip };
  const d = decideReminder({ reminder: rem, live: liveAt([veh({ vehicleCode: 'v1', etaSec: 90 })], NOW2), now: NOW2 });
  assert.deepEqual(d, { action: 'send', title: 't', body: 'Ετοιμάσου: η στάση «Πανεπιστημίου» σε ~1′' });
  // kind 'leave' keeps the old text
  const l = decideReminder({ reminder: { ...rem, kind: 'leave' }, live: liveAt([veh({ vehicleCode: 'v1', etaSec: 90 })], NOW2), now: NOW2 });
  assert.match(l.body, /^Φύγε τώρα για το 201/);
  // alight with the bus gone falls back to the client's original text
  assert.equal(decideReminder({ reminder: rem, live: liveAt([]), now: NOW2 }).action, 'send-original');
});
