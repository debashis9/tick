import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newVaultKey, encodeCode, decodeCode, formatCode, deriveKeys, encryptRecord, decryptRecord, serverId, CODE_LENGTH, fromB64u } from '../js/crypto.js';

test('recovery code round-trips and is 28 characters', async () => {
  for (let i = 0; i < 50; i++) {
    const k = newVaultKey();
    const code = await encodeCode(k);
    assert.equal(code.length, CODE_LENGTH);
    assert.match(code, /^[0-9A-HJKMNP-TV-Z]+$/);
    assert.deepEqual(await decodeCode(code), k);
  }
});

test('recovery code accepts spaces, dashes, lowercase and look-alike letters', async () => {
  const k = new Uint8Array(16).fill(0x10);
  const code = await encodeCode(k);
  const messy = formatCode(code).toLowerCase().replace(/0/g, 'o').replace(/1/g, 'l').replace(/ /g, ' - ');
  assert.deepEqual(await decodeCode(messy), k);
});

test('recovery code checksum catches a single typo', async () => {
  const code = await encodeCode(newVaultKey());
  let caught = 0;
  for (let i = 0; i < 26; i++) {
    const swapped = code.slice(0, i) + (code[i] === 'A' ? 'B' : 'A') + code.slice(i + 1);
    try { await decodeCode(swapped); } catch { caught++; }
  }
  assert.ok(caught >= 25, `caught ${caught} of 26`);
  await assert.rejects(decodeCode(code.slice(0, 20)), /28 letters/);
});

test('the same code gives the same keys; a different code gives different ones', async () => {
  const k = newVaultKey();
  const a = await deriveKeys(k), b = await deriveKeys(new Uint8Array(k)), c = await deriveKeys(newVaultKey());
  assert.equal(a.vaultId, b.vaultId);
  assert.equal(a.authHash, b.authHash);
  assert.equal(await serverId(a, 'c:h1:2026-10-01'), await serverId(b, 'c:h1:2026-10-01'));
  assert.notEqual(a.vaultId, c.vaultId);
  assert.match(a.vaultId, /^[\w-]{22}$/);
  assert.match(a.authSecret, /^[\w-]{43}$/);
  assert.notEqual(a.authSecret, a.vaultId);
});

test('records encrypt, pad to 256 bytes, and decrypt', async () => {
  const keys = await deriveKeys(newVaultKey());
  const rec = { id: 'hmf3k2a1b2c', kind: 'habit', name: 'Read a book 📖', goal: { amount: 20, unit: 'pages' }, createdOn: '2026-09-28', updatedAt: 1 };
  const row = await encryptRecord(keys, rec);
  assert.equal((fromB64u(row.ct).length - 16) % 256, 0);
  assert.ok(!row.ct.includes('Read') && !JSON.stringify(row).includes('2026'));
  assert.notEqual(row.id, rec.id);
  assert.deepEqual(await decryptRecord(keys, row), rec);
  // Same record twice: different IVs and ciphertexts, same server id.
  const again = await encryptRecord(keys, rec);
  assert.equal(again.id, row.id);
  assert.notEqual(again.ct, row.ct);
});

test('a tick and a tombstone are the same size on the server', async () => {
  const keys = await deriveKeys(newVaultKey());
  const tick = await encryptRecord(keys, { id: 'c:hmf3k2a1b2c:2026-10-01', kind: 'check', at: 1759300000000, amount: 22, pick: 'Jog', updatedAt: 1759300000000 });
  const gone = await encryptRecord(keys, { id: 'c:hmf3k2a1b2c:2026-10-01', kind: 'check', deleted: true, updatedAt: 1759300000001 });
  assert.equal(tick.ct.length, gone.ct.length);
  assert.equal(tick.id, gone.id);
});

test('a Tick code and a Sol code never give the same keys', async () => {
  // Sol derives with the salt 'sol-vault-v1'. The vault id for 16 zero bytes there is fixed;
  // this only checks Tick's differs from a derivation with Sol's salt.
  const k = new Uint8Array(16);
  const ikm = await crypto.subtle.importKey('raw', k, 'HKDF', false, ['deriveBits']);
  const sol = new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('sol-vault-v1'), info: new TextEncoder().encode('id') }, ikm, 128));
  assert.notEqual((await deriveKeys(k)).vaultId, Buffer.from(sol).toString('base64url'));
});

test('decryption fails with the wrong key, a tampered record, or a swapped id', async () => {
  const keys = await deriveKeys(newVaultKey()), other = await deriveKeys(newVaultKey());
  const row = await encryptRecord(keys, { id: 'c:h1:2026-10-01', kind: 'check', amount: 22, updatedAt: 1 });
  await assert.rejects(decryptRecord(other, row));
  const bytes = fromB64u(row.ct); bytes[5] ^= 1;
  const tampered = { ...row, ct: Buffer.from(bytes).toString('base64url') };
  await assert.rejects(decryptRecord(keys, tampered));
  const row2 = await encryptRecord(keys, { id: 'c:h1:2026-10-02', kind: 'check', updatedAt: 1 });
  await assert.rejects(decryptRecord(keys, { ...row, id: row2.id }));
});
