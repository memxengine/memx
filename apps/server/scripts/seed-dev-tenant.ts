/**
 * F149 Phase 2e — seed a hidden dev tenant with tenant_secrets for
 * testing per-tenant API-key fallback without a real tenant-signup UI.
 *
 * Creates:
 *   - tenant `t-f149-dev-probe`
 *   - owner user `u-f149-dev-probe`
 *   - one KB `f149-dev-probe` (Danish)
 *   - tenant_secrets row with the provided OpenRouter key sealed
 *
 * Idempotent: re-running updates the sealed key + preserves the
 * existing tenant/user/kb.
 *
 * Usage:
 *   TRAIL_SECRETS_MASTER_KEY=... \
 *   OPENROUTER_API_KEY_FOR_SEED=sk-or-v1-... \
 *   cd apps/server && bun run scripts/seed-dev-tenant.ts
 *
 * The OpenRouter key-for-seed is read from env so the plaintext key
 * never hits the script's arg-list (which would show in `ps`).
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  createLibsqlDatabase,
  knowledgeBases,
  tenants,
  tenantSecrets,
  users,
} from '@trail/db';
import { eq } from 'drizzle-orm';
import { sealSecret } from '../src/lib/tenant-secrets.ts';

const DB_PATH = join(homedir(), 'Apps/broberg/trail/data/trail.db');
const TENANT_ID = 't-f149-dev-probe';
const USER_ID = 'u-f149-dev-probe';
const KB_ID = 'kb-f149-dev-probe';

const seedOpenrouterKey = process.env.OPENROUTER_API_KEY_FOR_SEED || '';
if (!seedOpenrouterKey) {
  console.error('Set OPENROUTER_API_KEY_FOR_SEED env to the key you want sealed into the dev tenant.');
  process.exit(1);
}

const trail = await createLibsqlDatabase({ path: DB_PATH });
const nowIso = new Date().toISOString();

// Upsert tenant
const existingTenant = await trail.db.select().from(tenants).where(eq(tenants.id, TENANT_ID)).get();
if (!existingTenant) {
  await trail.db.insert(tenants).values({
    id: TENANT_ID,
    slug: 'f149-dev-probe',
    name: 'F149 dev probe (hidden)',
    plan: 'hobby',
  }).run();
  console.log(`✓ tenant created: ${TENANT_ID}`);
} else {
  console.log(`  tenant exists: ${TENANT_ID}`);
}

// Upsert user
const existingUser = await trail.db.select().from(users).where(eq(users.id, USER_ID)).get();
if (!existingUser) {
  await trail.db.insert(users).values({
    id: USER_ID,
    tenantId: TENANT_ID,
    email: 'f149-dev-probe@local.trail',
    displayName: 'F149 Probe Owner',
    role: 'owner',
    onboarded: true,
  }).run();
  console.log(`✓ user created: ${USER_ID}`);
} else {
  console.log(`  user exists: ${USER_ID}`);
}

// Upsert KB
const existingKb = await trail.db.select().from(knowledgeBases).where(eq(knowledgeBases.id, KB_ID)).get();
if (!existingKb) {
  await trail.db.insert(knowledgeBases).values({
    id: KB_ID,
    tenantId: TENANT_ID,
    createdBy: USER_ID,
    name: 'F149 dev probe KB',
    slug: 'f149-dev-probe',
    description: 'Hidden KB for testing per-tenant API-key fallback (F149 Phase 2e).',
    language: 'da',
    // Configure ingest for openrouter + Flash so the probe exercises
    // the tenant-key fallback path directly.
    ingestBackend: 'openrouter',
    ingestModel: 'google/gemini-2.5-flash',
  }).run();
  console.log(`✓ KB created: ${KB_ID} (openrouter + Flash)`);
} else {
  console.log(`  KB exists: ${KB_ID}`);
}

// Seal + upsert the OpenRouter key
const sealed = sealSecret(seedOpenrouterKey);
console.log(`✓ OpenRouter key sealed (${sealed.length} char blob)`);

const existingSecret = await trail.db.select().from(tenantSecrets).where(eq(tenantSecrets.tenantId, TENANT_ID)).get();
if (existingSecret) {
  await trail.db
    .update(tenantSecrets)
    .set({ openrouterApiKeyEncrypted: sealed, updatedAt: nowIso })
    .where(eq(tenantSecrets.tenantId, TENANT_ID))
    .run();
  console.log(`✓ tenant_secrets row UPDATED for ${TENANT_ID}`);
} else {
  await trail.db.insert(tenantSecrets).values({
    tenantId: TENANT_ID,
    openrouterApiKeyEncrypted: sealed,
  }).run();
  console.log(`✓ tenant_secrets row INSERTED for ${TENANT_ID}`);
}

console.log(`\nDev tenant ready:`);
console.log(`  tenant_id : ${TENANT_ID}`);
console.log(`  user_id   : ${USER_ID}`);
console.log(`  kb_id     : ${KB_ID}`);
console.log(`  kb_slug   : f149-dev-probe`);
console.log(`  backend   : openrouter (google/gemini-2.5-flash)`);
console.log(`  OR key    : sealed in tenant_secrets (falls back to env if decrypt fails)`);
console.log(`\nTest ingest via: POST /api/v1/knowledge-bases/kb-f149-dev-probe/documents/upload`);
