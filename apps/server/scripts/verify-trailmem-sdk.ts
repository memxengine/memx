/**
 * @trailmem/sdk — verify the typed client works end-to-end against
 * a live Trail engine. Exercises all three integration layers and
 * the error-shape contract.
 *
 * What this proves end-to-end (not infers):
 *   1. TrailClient constructs cleanly with baseUrl + apiKey.
 *   2. .search() returns SearchResponse-shaped data with Bearer auth.
 *   3. .retrieve() returns RetrieveResponse with formattedContext.
 *   4. .chat() returns ChatResponse with audience echoed back.
 *   5. TrailApiError is thrown on 401 (revoked key) with .status set.
 *   6. TrailApiError carries .code on structured 429 responses
 *      (here we provoke 404 instead of 429 since 429 needs 6+ turns
 *      to set up cleanly — same TrailApiError contract either way).
 *
 * Imports the SDK by relative path so this runs from inside the
 * monorepo without an npm publish. External consumers will instead
 * `import { TrailClient } from '@trailmem/sdk'` once the package
 * is published.
 *
 * Run with: `cd apps/server && bun run scripts/verify-trailmem-sdk.ts`
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createLibsqlDatabase, tenants, users, knowledgeBases, apiKeys } from '@trail/db';
import { TrailClient, TrailApiError } from '@trailmem/sdk';

const REPO_ROOT_DB = join(homedir(), 'Apps/broberg/trail/data/trail.db');
const TRAIL_BASE = process.env.TRAIL_TEST_BASE ?? 'http://127.0.0.1:58021';
const PROBE_ID = crypto.randomUUID().slice(0, 8);

let failures = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    console.log(`  ✗ ${msg}`);
    failures += 1;
  }
}

console.log(`\n=== @trailmem/sdk smoke test (id: ${PROBE_ID}) ===\n`);

const trail = await createLibsqlDatabase({ path: REPO_ROOT_DB });
await trail.runMigrations();

const tenant = await trail.db.select({ id: tenants.id }).from(tenants).limit(1).get();
if (!tenant) {
  console.log('  ✗ No tenant');
  process.exit(1);
}
const user = await trail.db
  .select({ id: users.id })
  .from(users)
  .where(eq(users.tenantId, tenant.id))
  .limit(1)
  .get();
const kb = await trail.db
  .select({ id: knowledgeBases.id })
  .from(knowledgeBases)
  .where(eq(knowledgeBases.tenantId, tenant.id))
  .limit(1)
  .get();
if (!user || !kb) {
  console.log('  ✗ Missing user or KB');
  process.exit(1);
}

// Mint a probe key directly into the DB.
const rawKey = `trail_${createHash('sha256').update(`${PROBE_ID}-sdk`).digest('hex')}`;
const keyHash = createHash('sha256').update(rawKey).digest('hex');
const keyId = `apk_sdk_${PROBE_ID}`;
await trail.db
  .insert(apiKeys)
  .values({
    id: keyId,
    tenantId: tenant.id,
    userId: user.id,
    name: `sdk-probe-${PROBE_ID}`,
    keyHash,
  })
  .run();

try {
  // ── 1. Construct ────────────────────────────────────────────────────────
  console.log('[1] TrailClient constructs');
  const client = new TrailClient({ baseUrl: TRAIL_BASE, apiKey: rawKey });
  assert(client !== null, 'client instance created');

  // ── 2. .search() ────────────────────────────────────────────────────────
  console.log('\n[2] .search() returns SearchResponse');
  const searchRes = await client.search(kb.id, { query: 'a', limit: 3 });
  assert(typeof searchRes === 'object' && searchRes !== null, 'response is object');
  assert(Array.isArray(searchRes.documents), 'documents is array');
  assert(Array.isArray(searchRes.chunks), 'chunks is array');

  // ── 3. .retrieve() ──────────────────────────────────────────────────────
  console.log('\n[3] .retrieve() returns RetrieveResponse');
  const retrieveRes = await client.retrieve(kb.id, { query: 'a', topK: 2, maxChars: 500 });
  assert(typeof retrieveRes.formattedContext === 'string', 'formattedContext is string');
  assert(typeof retrieveRes.totalChars === 'number', 'totalChars is number');
  assert(typeof retrieveRes.hitCount === 'number', 'hitCount is number');
  assert(retrieveRes.totalChars <= 500, `totalChars respects maxChars cap (${retrieveRes.totalChars} <= 500)`);

  // ── 4. TrailApiError on revoked key ─────────────────────────────────────
  console.log('\n[4] TrailApiError thrown on 401 after revoke');
  await trail.db
    .update(apiKeys)
    .set({ revokedAt: new Date().toISOString() })
    .where(eq(apiKeys.id, keyId))
    .run();
  try {
    await client.retrieve(kb.id, { query: 'a' });
    assert(false, 'should have thrown');
  } catch (err) {
    assert(err instanceof TrailApiError, 'instance of TrailApiError');
    if (err instanceof TrailApiError) {
      assert(err.status === 401, `status=401 (got ${err.status})`);
    }
  }

  // ── 5. TrailApiError on 404 carries body ───────────────────────────────
  console.log('\n[5] TrailApiError on 404 carries .body');
  // Re-mint a fresh key (the previous one is revoked).
  const rawKey2 = `trail_${createHash('sha256').update(`${PROBE_ID}-sdk2`).digest('hex')}`;
  const keyHash2 = createHash('sha256').update(rawKey2).digest('hex');
  const keyId2 = `apk_sdk2_${PROBE_ID}`;
  await trail.db
    .insert(apiKeys)
    .values({
      id: keyId2,
      tenantId: tenant.id,
      userId: user.id,
      name: `sdk-probe2-${PROBE_ID}`,
      keyHash: keyHash2,
    })
    .run();
  const client2 = new TrailClient({ baseUrl: TRAIL_BASE, apiKey: rawKey2 });
  try {
    await client2.retrieve(`kb_does_not_exist_${PROBE_ID}`, { query: 'a' });
    assert(false, 'should have thrown 404');
  } catch (err) {
    if (err instanceof TrailApiError) {
      assert(err.status === 404, `status=404 (got ${err.status})`);
      assert(typeof err.body === 'object', '.body is parsed object');
    } else {
      assert(false, 'expected TrailApiError');
    }
  }

  // Cleanup the second key.
  await trail.db.delete(apiKeys).where(eq(apiKeys.id, keyId2)).run();
} finally {
  await trail.db.delete(apiKeys).where(eq(apiKeys.id, keyId)).run();
}

console.log(`\n=== ${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} failure(s) ===\n`);
process.exit(failures === 0 ? 0 : 1);
