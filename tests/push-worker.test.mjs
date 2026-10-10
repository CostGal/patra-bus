import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  b64uEncode,
  b64uDecode,
  encryptPayload,
  vapidJwt,
  vapidHeader,
  audOf,
  isAllowedEndpoint,
  classifyPushStatus,
  sendPush,
} from '../worker/src/push.js';
import { validateReminder, decideReminder, findBus } from '../worker/src/reminders.js';

// --- RFC 8291 Appendix A ---
const RFC = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24', // "When I grow up, I want to be a watermelon"
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  body:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
    'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
    'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

test('b64u round trip', () => {
  const bytes = new Uint8Array([0, 251, 252, 253, 254, 255, 1]);
  assert.deepEqual(b64uDecode(b64uEncode(bytes)), bytes);
  assert.throws(() => b64uDecode('a+b'));
});

test('RFC 8291 Appendix A: exact aes128gcm body', async () => {
  const plaintext = b64uDecode(RFC.plaintext);
  assert.equal(new TextDecoder().decode(plaintext), 'When I grow up, I want to be a watermelon');
  const body = await encryptPayload(
    plaintext,
    { p256dh: RFC.uaPublic, auth: RFC.auth },
    { salt: RFC.salt, server: { privateKey: RFC.asPrivate, publicKey: RFC.asPublic } },
  );
  assert.equal(b64uEncode(body), RFC.body);
  assert.equal(body.length, 86 + 41 + 1 + 16); // 144; the RFC example prints Content-Length 145 (known typo)
});

test('encryptPayload: random keys/salt, header layout, decryptable by the receiver', async () => {
  const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const uaPub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const msg = 'Φύγε τώρα για το 601 · έρχεται σε 7′';
  const body = await encryptPayload(msg, { p256dh: b64uEncode(uaPub), auth: b64uEncode(auth) });
  assert.equal(new DataView(body.buffer).getUint32(16), 4096);
  assert.equal(body[20], 65);
  const asPub = body.slice(21, 86);
  const salt = body.slice(0, 16);
  // Receiver side (RFC 8291 §3.4).
  const secret = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: await crypto.subtle.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []) },
    kp.privateKey,
    256,
  );
  const hk = async (s, ikm, info, n) =>
    new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt: s, info },
        await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']),
        n * 8,
      ),
    );
  const te = new TextEncoder();
  const info = new Uint8Array([...te.encode('WebPush: info\0'), ...uaPub, ...asPub]);
  const ikm = await hk(auth, new Uint8Array(secret), info, 32);
  const cek = await hk(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hk(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
  const plain = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce },
      await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']),
      body.slice(86),
    ),
  );
  assert.equal(plain.at(-1), 2);
  assert.equal(new TextDecoder().decode(plain.slice(0, -1)), msg);
});

test('encryptPayload rejects oversize payloads and bad keys', async () => {
  const keys = { p256dh: RFC.uaPublic, auth: RFC.auth };
  await assert.rejects(encryptPayload(new Uint8Array(4100), keys), RangeError);
  await assert.rejects(encryptPayload('x', { p256dh: RFC.uaPublic, auth: 'AAAA' }), TypeError);
  await assert.rejects(encryptPayload('x', { p256dh: 'AAAA', auth: RFC.auth }));
});

// --- VAPID ---
async function vapidKeys() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  return { privateKey: jwk.d, publicKey: b64uEncode(pub), verifyKey: kp.publicKey };
}

test('VAPID JWT: ES256 format, claims, verifiable signature, exp <= 12 h', async () => {
  const k = await vapidKeys();
  const now = Date.UTC(2026, 9, 10, 12, 0, 0);
  const aud = audOf('https://fcm.googleapis.com/fcm/send/abc');
  assert.equal(aud, 'https://fcm.googleapis.com');
  const jwt = await vapidJwt({ aud, sub: 'https://github.com/CostGal/patra-bus', ...k, now, ttlSec: 99 * 3600 });
  const [h, p, s] = jwt.split('.');
  assert.deepEqual(JSON.parse(new TextDecoder().decode(b64uDecode(h))), { typ: 'JWT', alg: 'ES256' });
  const claims = JSON.parse(new TextDecoder().decode(b64uDecode(p)));
  assert.equal(claims.aud, aud);
  assert.equal(claims.sub, 'https://github.com/CostGal/patra-bus');
  assert.equal(claims.exp, Math.floor(now / 1000) + 12 * 3600);
  const sig = b64uDecode(s);
  assert.equal(sig.length, 64); // raw r||s, not DER
  const ok = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    k.verifyKey,
    sig,
    new TextEncoder().encode(`${h}.${p}`),
  );
  assert.ok(ok);
  assert.ok(!/[+/=]/.test(jwt));
});

test('VAPID Authorization header shape', async () => {
  const k = await vapidKeys();
  const hdr = await vapidHeader({ aud: 'https://x.example', sub: 'mailto:a@b.c', ...k });
  assert.match(hdr, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]{87}$/);
  assert.equal(hdr.split('k=')[1], k.publicKey);
});

// --- endpoint allowlist ---
test('isAllowedEndpoint', () => {
  const ok = [
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://db5p.notify.windows.com/?token=x',
    'https://web.push.apple.com/abc',
    'https://api.push.apple.com/3/device/x',
  ];
  const bad = [
    'http://fcm.googleapis.com/x',
    'https://evil.com/',
    'https://fcm.googleapis.com.evil.com/',
    'https://evilnotify.windows.com/',
    'https://notify.windows.com.evil.com/',
    'https://user:pw@fcm.googleapis.com/x',
    'https://fcm.googleapis.com:8443/x',
    'https://localhost/x',
    'http://localhost:8799/x',
    'not a url',
    '',
    null,
    42,
  ];
  for (const u of ok) assert.ok(isAllowedEndpoint(u), u);
  for (const u of bad) assert.ok(!isAllowedEndpoint(u), String(u));
  assert.ok(isAllowedEndpoint('http://localhost:8799/x', { allowLocal: true }));
  assert.ok(isAllowedEndpoint('http://127.0.0.1:8799/x', { allowLocal: true }));
  assert.ok(!isAllowedEndpoint('http://evil.com/', { allowLocal: true }));
  assert.ok(!isAllowedEndpoint('https://evil.com/', { allowLocal: true }));
});

test('classifyPushStatus', () => {
  assert.equal(classifyPushStatus(201), 'ok');
  assert.equal(classifyPushStatus(404), 'gone');
  assert.equal(classifyPushStatus(410), 'gone');
  assert.equal(classifyPushStatus(429), 'retry');
  assert.equal(classifyPushStatus(503), 'retry');
  assert.equal(classifyPushStatus(400), 'fail');
  assert.equal(classifyPushStatus(413), 'fail');
});

test('sendPush: headers, encrypted body, status mapping', async () => {
  const k = await vapidKeys();
  const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const sub = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
    keys: {
      p256dh: b64uEncode(new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey))),
      auth: b64uEncode(crypto.getRandomValues(new Uint8Array(16))),
    },
  };
  const env = { VAPID_PRIVATE_KEY: k.privateKey, VAPID_PUBLIC_KEY: k.publicKey, VAPID_SUBJECT: 'https://example.org' };
  const calls = [];
  const mk = (status, headers = {}) => async (url, init) => {
    calls.push({ url, init });
    return new Response(null, { status, headers });
  };
  let r = await sendPush(env, sub, { title: 't' }, { fetchFn: mk(201) });
  assert.equal(r.result, 'ok');
  const { url, init } = calls[0];
  assert.equal(url, sub.endpoint);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['Content-Encoding'], 'aes128gcm');
  assert.equal(init.headers.TTL, '600');
  assert.match(init.headers.Authorization, /^vapid t=.+, k=.+$/);
  assert.ok(init.body instanceof Uint8Array && init.body.length > 86);
  r = await sendPush(env, sub, {}, { fetchFn: mk(410) });
  assert.equal(r.result, 'gone');
  r = await sendPush(env, sub, {}, { fetchFn: mk(429, { 'Retry-After': '120' }) });
  assert.deepEqual([r.result, r.retryAfterSec], ['retry', 120]);
  r = await sendPush(env, sub, {}, { fetchFn: async () => { throw new Error('net'); } });
  assert.equal(r.result, 'retry');
});

// --- request validation ---
const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const goodSub = () => ({
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
  keys: { p256dh: RFC.uaPublic, auth: RFC.auth },
});
const goodReq = (over = {}) => ({
  subscription: goodSub(),
  at: NOW + 10 * 60000,
  title: 'Ώρα να φύγεις',
  body: 'Στάση Πανεπιστημίου',
  tag: 'trip-1',
  url: '#/plan',
  trip: { stopCode: '1011', routeCode: '2015', lineCode: '201', vehicleCode: 'v1', offsetSec: 300 },
  ...over,
});
const fieldOf = (raw, opts) => {
  const r = validateReminder(raw, NOW, opts);
  return r.ok ? null : r.error;
};

test('validateReminder accepts a good request and returns a cleaned copy', () => {
  const r = validateReminder({ ...goodReq(), extra: 'x', trip: { ...goodReq().trip, junk: 1 } }, NOW);
  assert.ok(r.ok);
  assert.ok(!('extra' in r.value));
  assert.ok(!('junk' in r.value.trip));
  assert.equal(validateReminder(goodReq({ trip: undefined, url: undefined, body: undefined }), NOW).ok, true);
  assert.equal(validateReminder(goodReq({ trip: { ...goodReq().trip, vehicleCode: null } }), NOW).ok, true);
});

test('validateReminder rejects bad input', () => {
  assert.equal(fieldOf(null, {}), 'body');
  assert.equal(fieldOf([], {}), 'body');
  assert.equal(fieldOf(goodReq({ subscription: { ...goodSub(), endpoint: 'https://evil.com/x' } })), 'subscription.endpoint');
  assert.equal(fieldOf(goodReq({ subscription: { ...goodSub(), endpoint: 'http://fcm.googleapis.com/x' } })), 'subscription.endpoint');
  assert.equal(fieldOf(goodReq({ subscription: { endpoint: goodSub().endpoint } })), 'subscription.keys');
  assert.equal(fieldOf(goodReq({ subscription: { ...goodSub(), keys: { p256dh: 'AAAA', auth: RFC.auth } } })), 'subscription.keys');
  assert.equal(fieldOf(goodReq({ subscription: { ...goodSub(), keys: { p256dh: RFC.uaPublic, auth: 'AAAA' } } })), 'subscription.keys');
  assert.equal(fieldOf(goodReq({ at: NOW })), 'at');
  assert.equal(fieldOf(goodReq({ at: NOW - 1 })), 'at');
  assert.equal(fieldOf(goodReq({ at: NOW + 3 * 3600e3 + 1 })), 'at');
  assert.equal(fieldOf(goodReq({ at: String(NOW + 60000) })), 'at');
  assert.equal(fieldOf(goodReq({ at: NaN })), 'at');
  assert.equal(validateReminder(goodReq({ at: NOW + 3 * 3600e3 }), NOW).ok, true);
  assert.equal(validateReminder(goodReq({ at: NOW + 1 }), NOW).ok, true);
  assert.equal(fieldOf(goodReq({ title: '' })), 'title');
  assert.equal(fieldOf(goodReq({ title: 'x'.repeat(121) })), 'title');
  assert.equal(fieldOf(goodReq({ title: 5 })), 'title');
  assert.equal(fieldOf(goodReq({ body: 'x'.repeat(301) })), 'body');
  assert.equal(fieldOf(goodReq({ tag: '' })), 'tag');
  assert.equal(fieldOf(goodReq({ tag: 'x'.repeat(65) })), 'tag');
  assert.equal(fieldOf(goodReq({ url: 'x'.repeat(301) })), 'url');
  assert.equal(fieldOf(goodReq({ trip: 'x' })), 'trip');
  assert.equal(fieldOf(goodReq({ trip: { ...goodReq().trip, stopCode: 'abc' } })), 'trip.stopCode');
  assert.equal(fieldOf(goodReq({ trip: { ...goodReq().trip, stopCode: '1234567' } })), 'trip.stopCode');
  assert.equal(fieldOf(goodReq({ trip: { ...goodReq().trip, stopCode: '../x' } })), 'trip.stopCode');
  assert.equal(fieldOf(goodReq({ trip: { ...goodReq().trip, routeCode: '' } })), 'trip.routeCode');
  assert.equal(fieldOf(goodReq({ trip: { ...goodReq().trip, lineCode: 7 } })), 'trip.lineCode');
  assert.equal(fieldOf(goodReq({ trip: { ...goodReq().trip, vehicleCode: 'x'.repeat(65) } })), 'trip.vehicleCode');
  assert.equal(fieldOf(goodReq({ trip: { ...goodReq().trip, offsetSec: -1 } })), 'trip.offsetSec');
  assert.equal(fieldOf(goodReq({ trip: { ...goodReq().trip, offsetSec: 7201 } })), 'trip.offsetSec');
  assert.equal(fieldOf(goodReq({ trip: { ...goodReq().trip, offsetSec: '60' } })), 'trip.offsetSec');
});

test('validateReminder: local endpoint only with allowLocal', () => {
  const raw = goodReq({ subscription: { ...goodSub(), endpoint: 'http://localhost:8799/push/1' } });
  assert.equal(fieldOf(raw, {}), 'subscription.endpoint');
  assert.equal(validateReminder(raw, NOW, { allowLocal: true }).ok, true);
});

// --- decision logic ---
const trip = { stopCode: '1011', routeCode: '2015', lineCode: '201', vehicleCode: 'v1', offsetSec: 300 };
const rem = (over = {}) => ({ at: NOW, title: 'Ώρα να φύγεις', body: 'orig', trip, ...over });
const veh = (over = {}) => ({ routeCode: '2015', vehicleCode: 'v1', etaSec: 300, live: true, ...over });
const liveAt = (vehicles, fetchedAt = NOW) => ({ fetchedAt, vehicles });

test('findBus: by vehicleCode, else first of the route', () => {
  const l = liveAt([veh({ vehicleCode: 'a', etaSec: 100 }), veh({ vehicleCode: 'v1', etaSec: 500 })]);
  assert.equal(findBus(l, trip).etaSec, 500);
  assert.equal(findBus(l, { ...trip, vehicleCode: 'zzz' }), null);
  assert.equal(findBus(l, { ...trip, vehicleCode: null }).vehicleCode, 'a');
  assert.equal(findBus(l, { ...trip, vehicleCode: null, routeCode: 'nope' }), null);
  assert.equal(findBus(null, trip), null);
});

test('decideReminder: on schedule -> send with refreshed text', () => {
  const d = decideReminder({ reminder: rem(), live: liveAt([veh({ etaSec: 300 })]), now: NOW });
  assert.equal(d.action, 'send');
  assert.equal(d.title, 'Ώρα να φύγεις');
  assert.equal(d.body, 'Φύγε τώρα για το 201 · έρχεται σε 5′');
});

test('decideReminder: exactly 60 s late is tolerated, 61 s re-arms', () => {
  const at60 = decideReminder({ reminder: rem(), live: liveAt([veh({ etaSec: 360 })]), now: NOW });
  assert.equal(at60.action, 'send');
  const at61 = decideReminder({ reminder: rem(), live: liveAt([veh({ etaSec: 361 })]), now: NOW });
  assert.equal(at61.action, 'rearm');
  assert.equal(at61.at, NOW + 61000);
});

test('decideReminder: bus delayed -> rearm at new leave time; capped at 3 re-arms', () => {
  const live = liveAt([veh({ etaSec: 600 })]);
  const d = decideReminder({ reminder: rem(), live, now: NOW });
  assert.deepEqual(d, { action: 'rearm', at: NOW + 300000 });
  assert.equal(decideReminder({ reminder: rem(), live, now: NOW, rearms: 2 }).action, 'rearm');
  const last = decideReminder({ reminder: rem(), live, now: NOW, rearms: 3 });
  assert.equal(last.action, 'send');
  assert.match(last.body, /έρχεται σε 10′/);
});

test('decideReminder: bus earlier than planned -> send now', () => {
  const d = decideReminder({ reminder: rem(), live: liveAt([veh({ etaSec: 120 })]), now: NOW });
  assert.equal(d.action, 'send');
  assert.match(d.body, /έρχεται σε 2′/);
});

test('decideReminder: accounts for data age (fetchedAt older than now)', () => {
  // fetched 20 s ago with eta 320 s -> 300 s remaining now -> on schedule
  const d = decideReminder({ reminder: rem(), live: liveAt([veh({ etaSec: 320 })], NOW - 20000), now: NOW });
  assert.equal(d.action, 'send');
  assert.match(d.body, /5′/);
});

test('decideReminder: bus vanished / no live / no trip -> send-original', () => {
  assert.equal(decideReminder({ reminder: rem(), live: liveAt([]), now: NOW }).action, 'send-original');
  assert.equal(decideReminder({ reminder: rem(), live: null, now: NOW }).action, 'send-original');
  assert.equal(
    decideReminder({ reminder: rem(), live: { fetchedAt: NOW, vehicles: [], noService: true }, now: NOW }).action,
    'send-original',
  );
  assert.equal(
    decideReminder({ reminder: rem(), live: liveAt([veh({ vehicleCode: 'other' })]), now: NOW }).action,
    'send-original',
  );
  assert.equal(decideReminder({ reminder: rem({ trip: undefined }), live: liveAt([veh()]), now: NOW }).action, 'send-original');
});

test('decideReminder: imminent bus says "τώρα"', () => {
  const d = decideReminder({
    reminder: rem({ trip: { ...trip, offsetSec: 0 } }),
    live: liveAt([veh({ etaSec: 5 })]),
    now: NOW,
  });
  assert.equal(d.action, 'send');
  assert.match(d.body, /έρχεται τώρα$/);
});
