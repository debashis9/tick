import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createPublicKey, verify } from 'node:crypto';
import { vapidAuth, localTime, dueSlots, cleanSlots, validEndpoint, validTimeZone, unb64u } from '../worker/webpush.js';

test('VAPID header is an ES256 JWT for the push service origin, signed by the key it names', async () => {
  const jwk = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' });
  const now = Date.UTC(2026, 8, 30, 12);
  const auth = await vapidAuth('https://fcm.googleapis.com/fcm/send/abc', jwk, 'https://tick.example.dev', now);
  const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(auth);
  assert.ok(m, auth);
  const [, h, p, sig, k] = m;
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { typ: 'JWT', alg: 'ES256' });
  assert.deepEqual(JSON.parse(Buffer.from(p, 'base64url')), { aud: 'https://fcm.googleapis.com', exp: now / 1000 + 12 * 3600, sub: 'https://tick.example.dev' });
  const pub = Buffer.from(k, 'base64url');
  assert.equal(pub.length, 65);
  assert.deepEqual([...pub.subarray(1, 33)], [...unb64u(jwk.x)]);
  const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, format: 'jwk' });
  assert.ok(verify('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
});

test('local time in the device time zone', () => {
  // 14:30 UTC is 20:00 in India, on Wednesday 30 September 2026.
  assert.deepEqual(localTime('Asia/Kolkata', new Date(Date.UTC(2026, 8, 30, 14, 30))), { date: '2026-09-30', minutes: 20 * 60, dow: 3 });
  // …and still Tuesday evening in Los Angeles a day earlier.
  assert.deepEqual(localTime('America/Los_Angeles', new Date(Date.UTC(2026, 8, 30, 3, 15))), { date: '2026-09-29', minutes: 20 * 60 + 15, dow: 2 });
});

test('a slot is due from its minute for 30 minutes, once per day, on its weekdays', () => {
  const slots = [{ t: '20:00', days: [3] }, { t: '07:30', days: [0, 1, 2, 3, 4, 5, 6] }];
  const at = (minutes, dow = 3) => ({ date: '2026-09-30', minutes, dow });
  assert.deepEqual(dueSlots(slots, {}, at(20 * 60)), ['20:00']);
  assert.deepEqual(dueSlots(slots, {}, at(20 * 60 + 29)), ['20:00']);
  assert.deepEqual(dueSlots(slots, {}, at(20 * 60 + 30)), []);
  assert.deepEqual(dueSlots(slots, {}, at(19 * 60 + 59)), []);
  assert.deepEqual(dueSlots(slots, { '20:00': '2026-09-30' }, at(20 * 60 + 1)), []);
  assert.deepEqual(dueSlots(slots, { '20:00': '2026-09-23' }, at(20 * 60 + 1)), ['20:00']);
  assert.deepEqual(dueSlots(slots, {}, at(20 * 60, 4)), []); // Thursday
});

test('input checks', () => {
  assert.ok(validEndpoint('https://fcm.googleapis.com/fcm/send/x'));
  assert.ok(validEndpoint('https://web.push.apple.com/abc'));
  assert.ok(validEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x'));
  assert.ok(!validEndpoint('https://evil.example.com/push.apple.com'));
  assert.ok(!validEndpoint('http://fcm.googleapis.com/x'));
  assert.ok(!validEndpoint('https://notpush.apple.com.evil.dev/'));
  assert.ok(validTimeZone('Asia/Kolkata'));
  assert.ok(!validTimeZone('Mars/Olympus'));
  assert.deepEqual(cleanSlots([{ t: '07:05', days: [3, 1, 1] }]), [{ t: '07:05', days: [1, 3] }]);
  assert.equal(cleanSlots([{ t: '24:00', days: [1] }]), null);
  assert.equal(cleanSlots([{ t: '07:00', days: [] }]), null);
  assert.equal(cleanSlots([]), null);
});
