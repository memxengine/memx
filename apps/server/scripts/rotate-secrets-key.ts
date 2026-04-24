/**
 * F149 Phase 2e — one-shot key rotation for tenant_secrets.
 *
 * Re-encrypts every sealed blob in tenant_secrets with a new master
 * key. Run after rotating TRAIL_SECRETS_MASTER_KEY in .env (typical
 * cadence: once a year, or on suspected compromise).
 *
 * Usage:
 *   1. Generate the new master key:
 *        NEW_KEY=$(openssl rand -base64 32)
 *   2. Keep the OLD key in .env / env for this script:
 *        export TRAIL_SECRETS_OLD_MASTER_KEY=<current key>
 *        export TRAIL_SECRETS_MASTER_KEY=$NEW_KEY
 *   3. Run:
 *        cd apps/server && bun run scripts/rotate-secrets-key.ts
 *   4. When the log shows all rows re-encrypted, update .env so
 *      TRAIL_SECRETS_MASTER_KEY is the new key (it already is) and
 *      drop TRAIL_SECRETS_OLD_MASTER_KEY.
 *   5. Restart trail so the new master key takes effect in-memory.
 *
 * Safety:
 *   - Dry-run by default; pass --apply to actually write.
 *   - Refuses to run if the two keys decode to the same bytes.
 *   - Fails hard if any row's decrypt-with-old throws; you must fix
 *     that row (or tenant-nuke it) before rotation can proceed.
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createLibsqlDatabase, tenantSecrets } from '@trail/db';
import { eq } from 'drizzle-orm';
import { unsealSecret, sealSecret } from '../src/lib/tenant-secrets.ts';

const APPLY = process.argv.includes('--apply');

const oldKeyRaw = process.env.TRAIL_SECRETS_OLD_MASTER_KEY;
const newKeyRaw = process.env.TRAIL_SECRETS_MASTER_KEY;
if (!oldKeyRaw || !newKeyRaw) {
  console.error('Set TRAIL_SECRETS_OLD_MASTER_KEY (current) + TRAIL_SECRETS_MASTER_KEY (new). Both as base64 32-byte keys.');
  process.exit(1);
}
const oldKey = Buffer.from(oldKeyRaw, 'base64');
const newKey = Buffer.from(newKeyRaw, 'base64');
if (oldKey.length !== 32 || newKey.length !== 32) {
  console.error(`Keys must decode to 32 bytes (old=${oldKey.length}, new=${newKey.length}).`);
  process.exit(1);
}
if (oldKey.equals(newKey)) {
  console.error('Old and new keys are identical — no rotation needed.');
  process.exit(1);
}

const trail = await createLibsqlDatabase({ path: join(homedir(), 'Apps/broberg/trail/data/trail.db') });

const rows = await trail.db
  .select({
    tenantId: tenantSecrets.tenantId,
    openrouter: tenantSecrets.openrouterApiKeyEncrypted,
    anthropic: tenantSecrets.anthropicApiKeyEncrypted,
  })
  .from(tenantSecrets)
  .all();

console.log(`\n=== Key rotation (${APPLY ? 'APPLY' : 'DRY RUN'}) ===`);
console.log(`Found ${rows.length} tenant_secrets row(s)\n`);

if (rows.length === 0) {
  console.log('No rows to rotate.');
  process.exit(0);
}

type Update = { tenantId: string; openrouter?: string; anthropic?: string };
const updates: Update[] = [];
let failed = 0;

for (const row of rows) {
  const upd: Update = { tenantId: row.tenantId };
  let anyRotated = false;
  if (row.openrouter) {
    try {
      const plain = unsealSecret(row.openrouter, oldKey);
      upd.openrouter = sealSecret(plain, newKey);
      anyRotated = true;
    } catch (err) {
      console.error(`  ✗ ${row.tenantId}: OpenRouter decrypt failed: ${err instanceof Error ? err.message : err}`);
      failed += 1;
    }
  }
  if (row.anthropic) {
    try {
      const plain = unsealSecret(row.anthropic, oldKey);
      upd.anthropic = sealSecret(plain, newKey);
      anyRotated = true;
    } catch (err) {
      console.error(`  ✗ ${row.tenantId}: Anthropic decrypt failed: ${err instanceof Error ? err.message : err}`);
      failed += 1;
    }
  }
  if (anyRotated) {
    updates.push(upd);
    console.log(`  ✓ ${row.tenantId}: re-encryption planned`);
  } else if (!row.openrouter && !row.anthropic) {
    console.log(`  -  ${row.tenantId}: no sealed keys, skipping`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} decryption failure(s); refusing to proceed. Fix/nuke those rows first.`);
  process.exit(1);
}

if (!APPLY) {
  console.log(`\nDry run — ${updates.length} row(s) would be updated. Re-run with --apply.`);
  process.exit(0);
}

const nowIso = new Date().toISOString();
for (const upd of updates) {
  const patch: Record<string, unknown> = { updatedAt: nowIso };
  if (upd.openrouter) patch.openrouterApiKeyEncrypted = upd.openrouter;
  if (upd.anthropic) patch.anthropicApiKeyEncrypted = upd.anthropic;
  await trail.db.update(tenantSecrets).set(patch).where(eq(tenantSecrets.tenantId, upd.tenantId)).run();
}

console.log(`\n✓ ${updates.length} row(s) re-encrypted. Now:`);
console.log('  1. Drop TRAIL_SECRETS_OLD_MASTER_KEY from env.');
console.log('  2. Restart trail so in-process cipher uses the new master.');
