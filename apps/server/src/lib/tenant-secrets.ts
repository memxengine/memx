/**
 * F149 Phase 2e — Per-tenant API-key encryption.
 *
 * AES-256-GCM authenticated encryption. Master key lives in
 * TRAIL_SECRETS_MASTER_KEY env (base64-encoded 32 bytes). Each stored
 * secret is a base64-encoded `nonce:ciphertext:tag` tuple (12-byte
 * nonce, variable ciphertext, 16-byte tag).
 *
 * Why AES-256-GCM, not libsodium:
 * - Node's built-in `crypto` module — zero new deps, same audited
 *   primitive NIST recommends + every major framework uses.
 * - libsodium's `crypto_secretbox_easy` is XChaCha20-Poly1305 which
 *   is equally strong; the tie-break is avoiding a native-build dep
 *   on a Bun codebase where adding builds is unusual.
 *
 * Key-rotation path: apps/server/scripts/rotate-secrets-key.ts
 * decrypts every row with OLD_MASTER_KEY and re-encrypts with the
 * new one. Master key rotation is a one-shot operation; runtime-
 * rotation-without-downtime is out of scope for v1.
 */

import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;

function getMasterKey(): Buffer {
  const raw = process.env.TRAIL_SECRETS_MASTER_KEY;
  if (!raw) {
    throw new Error(
      'TRAIL_SECRETS_MASTER_KEY not set. Generate with `openssl rand -base64 32` and add to .env.',
    );
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error(
      `TRAIL_SECRETS_MASTER_KEY must decode to exactly 32 bytes (got ${key.length}). Use \`openssl rand -base64 32\`.`,
    );
  }
  return key;
}

/**
 * Encrypt a plaintext API key (or any secret string) into the
 * serialized on-disk format: `<nonce-b64>:<ciphertext-b64>:<tag-b64>`.
 * All three components are url-safe-ish base64 (standard base64 with
 * padding). Returns a single string safe for storing in the
 * `openrouter_api_key_encrypted` / `anthropic_api_key_encrypted`
 * columns.
 */
export function sealSecret(plaintext: string, masterKey?: Buffer): string {
  const key = masterKey ?? getMasterKey();
  const nonce = randomBytes(NONCE_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [nonce.toString('base64'), ciphertext.toString('base64'), tag.toString('base64')].join(':');
}

/**
 * Decrypt a sealed blob back into plaintext. Throws if the blob is
 * malformed, the tag doesn't verify, or the master key is wrong.
 * Callers should catch and treat failure as "no valid tenant key
 * configured" → fall back to env.
 */
export function unsealSecret(sealed: string, masterKey?: Buffer): string {
  const key = masterKey ?? getMasterKey();
  const parts = sealed.split(':');
  if (parts.length !== 3) {
    throw new Error(`Malformed sealed blob: expected 3 colon-separated parts, got ${parts.length}`);
  }
  const nonce = Buffer.from(parts[0]!, 'base64');
  const ciphertext = Buffer.from(parts[1]!, 'base64');
  const tag = Buffer.from(parts[2]!, 'base64');
  if (nonce.length !== NONCE_LENGTH) {
    throw new Error(`Invalid nonce length: expected ${NONCE_LENGTH}, got ${nonce.length}`);
  }
  if (tag.length !== TAG_LENGTH) {
    throw new Error(`Invalid tag length: expected ${TAG_LENGTH}, got ${tag.length}`);
  }
  const decipher = createDecipheriv(ALGORITHM, key, nonce);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

/** Generate a fresh 32-byte master key encoded as base64. */
export function generateMasterKey(): string {
  return randomBytes(32).toString('base64');
}

/**
 * Re-encrypt a sealed blob with a new master key. Used by the
 * rotate-secrets-key.ts script. Caller passes both the OLD key (to
 * decrypt) and the NEW key (to re-encrypt). The returned string is
 * the new sealed form safe to UPDATE into the DB.
 */
export function rotateSecret(sealed: string, oldKey: Buffer, newKey: Buffer): string {
  const plaintext = unsealSecret(sealed, oldKey);
  return sealSecret(plaintext, newKey);
}
