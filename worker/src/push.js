// Web Push with WebCrypto only: VAPID (RFC 8292, ES256) + aes128gcm payload encryption (RFC 8291).
// Pure helpers are exported for tests. No Workers-only APIs here (runs on Node too).

const enc = new TextEncoder();
const subtle = () => globalThis.crypto.subtle;

export function b64uEncode(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64uDecode(str) {
  if (typeof str !== 'string' || !/^[A-Za-z0-9_-]*$/.test(str)) throw new TypeError('bad base64url');
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

async function hkdf(salt, ikm, info, length) {
  const key = await subtle().importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

// Uncompressed P-256 point (65 bytes, 0x04 || X || Y) -> public JWK fields.
const pointToJwk = (pub) => ({
  kty: 'EC',
  crv: 'P-256',
  x: b64uEncode(pub.slice(1, 33)),
  y: b64uEncode(pub.slice(33, 65)),
});

export async function importPublic(pub) {
  if (pub.length !== 65 || pub[0] !== 4) throw new TypeError('bad P-256 point');
  return subtle().importKey('jwk', pointToJwk(pub), { name: 'ECDH', namedCurve: 'P-256' }, true, []);
}

// Application-server key pair. Fixed `{ privateKey: b64u d, publicKey: b64u point }` only in tests.
async function serverKeys(fixed) {
  if (fixed) {
    const pub = b64uDecode(fixed.publicKey);
    const priv = await subtle().importKey(
      'jwk',
      { ...pointToJwk(pub), d: fixed.privateKey },
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      ['deriveBits'],
    );
    return { priv, pub };
  }
  const kp = await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const pub = new Uint8Array(await subtle().exportKey('raw', kp.publicKey));
  return { priv: kp.privateKey, pub };
}

// RFC 8291 §3.4 + RFC 8188: single record, record size 4096, keyid = as_public.
// Returns the full request body: salt(16) | rs(4) | idlen(1) | keyid(65) | ciphertext.
export async function encryptPayload(plaintext, { p256dh, auth }, opts = {}) {
  const uaPub = b64uDecode(p256dh);
  const authSecret = b64uDecode(auth);
  if (authSecret.length !== 16) throw new TypeError('auth must be 16 bytes');
  const data = typeof plaintext === 'string' ? enc.encode(plaintext) : plaintext;
  if (data.length > 4096 - 17 - 1) throw new RangeError('payload too large');

  const { priv, pub: asPub } = await serverKeys(opts.server);
  const secret = new Uint8Array(
    await subtle().deriveBits({ name: 'ECDH', public: await importPublic(uaPub) }, priv, 256),
  );
  const salt = opts.salt ? b64uDecode(opts.salt) : globalThis.crypto.getRandomValues(new Uint8Array(16));

  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPub, asPub);
  const ikm = await hkdf(authSecret, secret, keyInfo, 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const padded = concat(data, new Uint8Array([2])); // 0x02 = last record delimiter
  const key = await subtle().importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: nonce }, key, padded));

  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPub.length;
  return concat(header, asPub, ct);
}

// --- VAPID (RFC 8292) ---

export const audOf = (endpoint) => new URL(endpoint).origin;

// privateKey: b64url 32-byte scalar `d`; publicKey: b64url uncompressed point.
export async function vapidJwt({ aud, sub, privateKey, publicKey, now = Date.now(), ttlSec = 12 * 3600 }) {
  const pub = b64uDecode(publicKey);
  const key = await subtle().importKey(
    'jwk',
    { ...pointToJwk(pub), d: privateKey },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const exp = Math.floor(now / 1000) + Math.min(ttlSec, 12 * 3600);
  const head = b64uEncode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64uEncode(enc.encode(JSON.stringify({ aud, exp, sub })));
  const input = enc.encode(`${head}.${body}`);
  // WebCrypto ECDSA already returns raw r||s (64 bytes), which is the JWS ES256 format.
  const sig = new Uint8Array(await subtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, key, input));
  return `${head}.${body}.${b64uEncode(sig)}`;
}

export async function vapidHeader(opts) {
  return `vapid t=${await vapidJwt(opts)}, k=${opts.publicKey}`;
}

// --- endpoint allowlist ---

// [host, matchSubdomains]
const PUSH_HOSTS = [
  ['fcm.googleapis.com', false],
  ['updates.push.services.mozilla.com', false],
  ['notify.windows.com', true],
  ['web.push.apple.com', false],
  ['push.apple.com', true],
];

export function isAllowedEndpoint(endpoint, { allowLocal = false } = {}) {
  if (typeof endpoint !== 'string' || endpoint.length > 1024) return false;
  let u;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.username || u.password || u.hash) return false;
  if (allowLocal && u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return true;
  if (u.protocol !== 'https:' || u.port) return false;
  const host = u.hostname.toLowerCase();
  return PUSH_HOSTS.some(([h, sub]) => host === h || (sub && host.endsWith('.' + h)));
}

// 201/200/202 ok; 404/410 subscription gone; 429/5xx retry once later; anything else fail.
export function classifyPushStatus(status) {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 404 || status === 410) return 'gone';
  if (status === 429 || status >= 500) return 'retry';
  return 'fail';
}

// Sends one message. Returns { result: 'ok'|'gone'|'retry'|'fail', status, retryAfterSec? }.
export async function sendPush(env, subscription, message, { ttl = 600, urgency = 'high', fetchFn = fetch, now = Date.now() } = {}) {
  const { endpoint, keys } = subscription;
  const body = await encryptPayload(JSON.stringify(message), keys);
  const authorization = await vapidHeader({
    aud: audOf(endpoint),
    sub: env.VAPID_SUBJECT,
    privateKey: env.VAPID_PRIVATE_KEY,
    publicKey: env.VAPID_PUBLIC_KEY,
    now,
  });
  let res;
  try {
    res = await fetchFn(endpoint, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(ttl),
        Urgency: urgency,
      },
      body,
    });
  } catch {
    return { result: 'retry', status: 0 };
  }
  const result = classifyPushStatus(res.status);
  const ra = Number(res.headers.get('Retry-After'));
  return { result, status: res.status, retryAfterSec: Number.isFinite(ra) && ra > 0 ? ra : undefined };
}
