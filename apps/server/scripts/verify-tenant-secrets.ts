/**
 * F149 Phase 2e probe — round-trip tenant_secrets seal/unseal + cover
 * failure-modes (bad master key, malformed blob, rotation).
 *
 * Safe to run repeatedly — touches only an in-memory master key, not
 * TRAIL_SECRETS_MASTER_KEY from env. No DB writes.
 */
import { randomBytes } from 'node:crypto';
import { sealSecret, unsealSecret, generateMasterKey, rotateSecret } from '../src/lib/tenant-secrets.ts';

let failures = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) console.log(`  ✓ ${msg}`);
  else { console.log(`  ✗ ${msg}`); failures += 1; }
}

console.log('\n=== F149 Phase 2e — tenant_secrets encryption probe ===\n');

// ── 1. Master key generation ─────────────────────────────────────
console.log('[1] generateMasterKey');
const masterKey = generateMasterKey();
const keyBytes = Buffer.from(masterKey, 'base64');
assert(keyBytes.length === 32, 'key decodes to exactly 32 bytes');
assert(masterKey !== generateMasterKey(), 'two calls produce different keys (random)');

const key = keyBytes;

// ── 2. Round-trip seal + unseal ──────────────────────────────────
console.log('\n[2] seal + unseal roundtrip');
const plaintext = 'sk-or-v1-abcdef0123456789';
const sealed = sealSecret(plaintext, key);
assert(sealed.includes(':'), 'sealed blob has colon separators');
assert(sealed.split(':').length === 3, 'sealed blob has exactly 3 parts (nonce:ciphertext:tag)');
assert(!sealed.includes(plaintext), 'plaintext NOT present in sealed blob');
assert(unsealSecret(sealed, key) === plaintext, 'unseal returns original plaintext');

// ── 3. Nonce uniqueness ──────────────────────────────────────────
console.log('\n[3] nonce uniqueness');
const s1 = sealSecret(plaintext, key);
const s2 = sealSecret(plaintext, key);
assert(s1 !== s2, 'sealing the same plaintext twice produces different blobs (nonce randomised)');
assert(unsealSecret(s1, key) === unsealSecret(s2, key), 'both blobs unseal to the same plaintext');

// ── 4. Wrong master key fails ────────────────────────────────────
console.log('\n[4] wrong master key rejected');
const otherKey = randomBytes(32);
let threw = false;
try {
  unsealSecret(sealed, otherKey);
} catch {
  threw = true;
}
assert(threw, 'unseal with wrong master key throws (AES-GCM tag mismatch)');

// ── 5. Malformed blobs rejected ──────────────────────────────────
console.log('\n[5] malformed blobs');
for (const bad of ['just-one-part', 'two:parts', 'a:b:c:d:e', '']) {
  let badThrew = false;
  try { unsealSecret(bad, key); } catch { badThrew = true; }
  assert(badThrew, `rejects malformed blob "${bad.slice(0, 20)}"`);
}

// ── 6. Key rotation preserves plaintext ──────────────────────────
console.log('\n[6] key rotation round-trip');
const oldKey = key;
const newKey = randomBytes(32);
const rotated = rotateSecret(sealed, oldKey, newKey);
assert(rotated !== sealed, 'rotated blob differs from original (new nonce + ciphertext)');
assert(unsealSecret(rotated, newKey) === plaintext, 'rotated blob unseals with new key → original plaintext');
let postRotateThrew = false;
try { unsealSecret(rotated, oldKey); } catch { postRotateThrew = true; }
assert(postRotateThrew, 'rotated blob no longer unseals with old key');

// ── 7. Unicode/long plaintext survives ───────────────────────────
console.log('\n[7] edge cases');
for (const p of ['sk-' + 'x'.repeat(500), '🔐 Danish æøå Norwegian ÆØÅ', '', 'a']) {
  const roundtripped = unsealSecret(sealSecret(p, key), key);
  assert(roundtripped === p, `roundtrip length=${p.length} preserves plaintext`);
}

console.log(`\n${failures === 0 ? '✓ ALL PROBES PASSED' : `✗ ${failures} probe(s) failed`}\n`);
process.exit(failures === 0 ? 0 : 1);
