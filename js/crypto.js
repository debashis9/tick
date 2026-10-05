// End-to-end encryption for cloud backup. WebCrypto only (the same code runs in Node for tests).
//
// A vault key is 16 random bytes, shown to the user once as a recovery code. Everything else is
// derived from it with HKDF, so any device with the code has everything it needs:
//   enc  → AES-256-GCM key that encrypts every record
//   id   → the vault's id on the server
//   auth → the secret that proves you own the vault (the server keeps only its SHA-256)
//   rid  → HMAC key that turns local ids ('c:<habitId>:2026-10-01') into opaque server ids
// The server never sees the vault key, the encryption key, or any plaintext.

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder(), dec = new TextDecoder();
const utf8 = s => enc.encode(s);

export const b64u = bytes => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
export const fromB64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const hex = bytes => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
export const sha256hex = async s => hex(new Uint8Array(await subtle.digest('SHA-256', utf8(s))));

// ---------- recovery code ----------
// Crockford base32 (no I, L, O, U, so it reads aloud and types without mix-ups). 16 bytes make
// 26 characters; two more are a checksum that catches typos before anything is sent.
const ALPHA = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CODE_LENGTH = 28;

export const newVaultKey = () => globalThis.crypto.getRandomValues(new Uint8Array(16));

async function checksum(bytes) {
  const h = new Uint8Array(await subtle.digest('SHA-256', bytes));
  const v = (h[0] << 2) | (h[1] >> 6); // 10 bits
  return ALPHA[v >> 5] + ALPHA[v & 31];
}

export async function encodeCode(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = '';
  for (let i = 0; i < 26; i++) { s = ALPHA[Number(n & 31n)] + s; n >>= 5n; }
  return s + await checksum(bytes);
}

export const formatCode = code => code.replace(/(.{4})(?=.)/g, '$1 ');

export const normalizeCode = s => String(s || '').toUpperCase().replace(/[\s-]/g, '')
  .replace(/O/g, '0').replace(/[IL]/g, '1').replace(/U/g, 'V');

// Returns the 16 key bytes, or throws with a message meant for the user.
export async function decodeCode(input) {
  const s = normalizeCode(input);
  if (s.length !== CODE_LENGTH) throw new Error(`A recovery code has ${CODE_LENGTH} letters and numbers. This one has ${s.length}.`);
  let n = 0n;
  for (const ch of s.slice(0, 26)) {
    const v = ALPHA.indexOf(ch);
    if (v < 0) throw new Error(`“${ch}” can't be in a recovery code.`);
    n = (n << 5n) | BigInt(v);
  }
  if (n >> 128n) throw new Error("That code doesn't look right. Check it against your saved copy.");
  const bytes = new Uint8Array(16);
  for (let i = 15; i >= 0; i--) { bytes[i] = Number(n & 255n); n >>= 8n; }
  if (await checksum(bytes) !== s.slice(26)) throw new Error("That code doesn't look right. Check it against your saved copy.");
  return bytes;
}

// ---------- keys ----------
export async function deriveKeys(vaultKey) {
  const ikm = await subtle.importKey('raw', vaultKey, 'HKDF', false, ['deriveBits']);
  const salt = utf8('tick-vault-v1');
  const bits = async (info, n) => new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: utf8(info) }, ikm, n * 8));
  const vaultId = b64u(await bits('id', 16));
  const authSecret = b64u(await bits('auth', 32));
  return {
    vaultId,
    authSecret,
    authHash: await sha256hex(authSecret),
    encKey: await subtle.importKey('raw', await bits('enc', 32), 'AES-GCM', false, ['encrypt', 'decrypt']),
    ridKey: await subtle.importKey('raw', await bits('rid', 32), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
  };
}

export const serverId = async (keys, localId) => b64u(new Uint8Array(await subtle.sign('HMAC', keys.ridKey, utf8(localId)))).slice(0, 22);

// Pads to a multiple of 256 bytes so a record's size says little about what's in it.
const PAD = 256;
export async function encryptRecord(keys, record) {
  const id = await serverId(keys, record.id);
  const json = utf8(JSON.stringify(record));
  const padded = new Uint8Array(Math.ceil((json.length + 1) / PAD) * PAD).fill(32);
  padded.set(json);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8(keys.vaultId + '/' + id) }, keys.encKey, padded));
  return { id, iv: b64u(iv), ct: b64u(ct) };
}

// Throws if the record was changed, moved to another id or vault, or encrypted with another key.
export async function decryptRecord(keys, row) {
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: fromB64u(row.iv), additionalData: utf8(keys.vaultId + '/' + row.id) }, keys.encKey, fromB64u(row.ct));
  const record = JSON.parse(dec.decode(pt));
  if (await serverId(keys, record.id) !== row.id) throw new Error('Record id mismatch');
  return record;
}
