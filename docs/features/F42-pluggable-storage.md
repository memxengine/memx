# F42 — Pluggable Storage (Tigris + R2 Adapters)

**Phase:** 2
**Status:** Planned
**Depends on:** F13 (Storage Adapter interface, Done)
**Blocks:** F41 (Tenant Provisioning + Signup), F52 (FysioDK Onboarding), Enterprise tier
**Related:** F45 (`@webhouse/cms` adapter — may carry its own storage preference), F81 (Per-KB Encryption)
**Updated:** 2026-04-16

---

## Note on this plan doc

This plan is a proposal by claude.ai, based on the architectural decisions in [SAAS-SCALING-PLAN.md](../SAAS-SCALING-PLAN.md). The shape is confident, but **specific implementation details are up to cc and Christian to refine together**. Where this doc says "suggested," "likely," or "we propose," those are starting points for discussion, not locked requirements. The cc session implementing this should surface alternatives where relevant and flag disagreements with the claude.ai reasoning below.

---

## Summary

Replace the original F42 scope ("Cloudflare R2 Storage Adapter") with two production-ready adapters shipped together: **Tigris** (Fly.io's native object storage) and **Cloudflare R2**. Both are S3-compatible and implement the existing `Storage` interface from F13. Tenants configure which adapter they use; Pro+ tenants can migrate between them without downtime.

This expansion is driven by three observations:

1. **Vendor optionality is cheap to build and expensive to retrofit.** Shipping both adapters now costs maybe 2-3 days of additional work and locks in flexibility for every future customer conversation.
2. **Enterprise customers often have existing cloud relationships.** Refusing to support R2 closes deals with customers who've standardized on Cloudflare.
3. **Data residency and cost-optimization use cases differ per tenant.** Giving tenants a choice costs Trail nothing operationally once the adapters exist.

---

## Goals

- Ship Tigris adapter as the default storage for all tiers
- Ship R2 adapter as an alternative for Pro+ tenants
- Enable per-tenant storage migration (Tigris ↔ R2) as a background job with no application-level downtime
- Keep the `Storage` interface (F13) stable; no breaking changes to consumers
- Preserve the path to additional adapters (S3, B2, MinIO, Wasabi) as Phase 3 drop-ins

---

## Non-goals

- **Multi-provider active-active replication.** A tenant uses one storage provider at a time. Warm standby via periodic sync is a Phase 3 Business+ feature, not part of F42.
- **Cross-provider object-level sync.** If a tenant migrates Tigris → R2, the old bucket is deleted after a 30-day grace period. No attempt to keep both in sync.
- **Custom per-object ACLs.** All objects are tenant-prefixed and accessed via signed URLs. Fine-grained ACLs are Enterprise-tier scope.
- **CDN edge caching.** Tigris is globally distributed by default; R2 integrates with Cloudflare's CDN separately. Neither case requires custom work in this feature.

---

## Proposed implementation

### Package structure (suggested)

```
packages/
  storage/
    src/
      interface.ts        ← Storage interface (already exists per F13)
      types.ts            ← shared types, metadata shapes
      tigris-adapter.ts   ← new
      r2-adapter.ts       ← new
      local-adapter.ts    ← exists, keeps working for dev
      factory.ts          ← new: selects adapter based on tenant config
      migration.ts        ← new: cross-provider tenant migration job
    test/
      tigris.test.ts
      r2.test.ts
      migration.test.ts
    README.md
```

The factory reads the tenant's `storage_provider` and `storage_config` fields and returns the right adapter instance. Handlers consume `Storage` through the factory, never instantiate adapters directly.

### Suggested interface (mostly unchanged from F13)

```typescript
export interface Storage {
  put(key: string, data: Buffer, metadata?: StorageMetadata): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  list(prefix: string): AsyncIterable<StorageObject>;
  signUrl(key: string, ttlSeconds: number): Promise<string>;

  // New in F42, needed for migration:
  stat(key: string): Promise<StorageObjectStat>;
  copy(srcKey: string, dstKey: string): Promise<void>;
}

export interface StorageObjectStat {
  key: string;
  size: number;
  etag: string;
  lastModified: Date;
  metadata?: StorageMetadata;
}
```

The additional `stat` and `copy` methods enable checksummed migration without downloading full object payloads. cc may find other methods worth adding (e.g., `exists`, `putStream` for large uploads); keep the interface minimal and add only what's needed for Trail's actual use cases.

### Tigris configuration (suggested)

Tigris speaks S3-compatible API. The AWS S3 SDK works directly with the right endpoint URL. `fly storage create` injects these as secrets:

```typescript
export interface TigrisConfig {
  endpoint: string;       // AWS_ENDPOINT_URL_S3
  region: string;         // AWS_REGION (usually 'auto' for Tigris)
  bucket: string;         // BUCKET_NAME
  accessKeyId: string;    // AWS_ACCESS_KEY_ID
  secretAccessKey: string; // AWS_SECRET_ACCESS_KEY
}
```

cc might prefer to construct these from a single `TIGRIS_*` namespace rather than the `AWS_*` aliases Tigris uses — that's a call to make based on the broader env-var convention in the server.

### R2 configuration (suggested)

R2 also speaks S3-compatible API but with a different endpoint format:

```typescript
export interface R2Config {
  accountId: string;      // Cloudflare account ID
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  // Endpoint is derived: https://<accountId>.r2.cloudflarestorage.com
}
```

R2 has two endpoint modes: default (requires account ID in URL) and jurisdictional (EU data residency). Business+ tenants in regulated EU industries will likely need the jurisdictional variant. cc should verify current R2 SDK behavior and decide if exposing `endpoint` directly is cleaner than computing it.

### Key naming convention (proposed)

All tenants use the same prefix scheme regardless of provider:

```
tenants/<tenant-id>/sources/<source-id>/<filename>
tenants/<tenant-id>/exports/<export-id>/<filename>
tenants/<tenant-id>/assets/<wiki-page-id>/<asset-id>.<ext>
```

This matters because migration relies on `list(prefix)` returning everything under `tenants/<tenant-id>/`. cc should verify this pattern works across both Tigris and R2's list semantics — S3-compatible APIs have historically had subtle behavioral differences on list pagination.

### Tenant storage config schema (suggested)

Adds two columns to the `tenants` table:

```sql
ALTER TABLE tenants ADD COLUMN storage_provider TEXT NOT NULL DEFAULT 'tigris';
ALTER TABLE tenants ADD COLUMN storage_config JSON;
ALTER TABLE tenants ADD COLUMN storage_status TEXT NOT NULL DEFAULT 'active';
-- storage_status: 'active' | 'migrating' | 'migration_failed'
```

`storage_config` holds either `TigrisConfig` or `R2Config` as JSON, encrypted at rest. cc should decide whether to use column-level encryption (Drizzle + app-layer crypto) or rely on volume-level encryption (simpler, less granular).

### Per-tenant migration flow (proposed)

```
POST /admin/tenants/:id/storage/migrate
Body: { target_provider: 'r2', target_config: R2Config }

1. Validate target_config by testing put/get/delete on a throwaway key
2. UPDATE tenants SET storage_status = 'migrating' WHERE id = :id
3. Enqueue migration job: { tenantId, sourceProvider, targetProvider, targetConfig }
4. Return 202 Accepted with migration job ID

Background worker:
1. List all objects with prefix tenants/<id>/ from source provider
2. For each object:
   a. stat() on source → get etag/size
   b. copy from source to target (stream, don't materialize in memory)
   c. stat() on target → verify etag/size match
   d. Log progress; increment migration counter
3. Verify final object count and total bytes match
4. UPDATE tenants SET storage_provider = :target, storage_config = :config, storage_status = 'active'
5. Schedule source-provider cleanup job for +30 days
6. Notify tenant admin via email

On failure:
- UPDATE tenants SET storage_status = 'migration_failed'
- Keep source provider active; do NOT delete target objects
- Page on-call, allow retry or manual cleanup
```

During migration, source uploads are blocked at the API level (`storage_status = 'migrating'` returns 423 Locked on new source uploads). Existing libSQL writes are unaffected — migration only touches object storage.

cc should consider: is 30 days the right grace period? Should it be configurable per-plan? Should admins be able to restore from the old bucket if they notice a problem after day 10? These are policy decisions, not architectural ones.

### Default selection per tier (from SAAS-SCALING-PLAN)

| Tier | Default | Can change | Migration frequency |
|------|---------|------------|---------------------|
| Hobby | Tigris | No | — |
| Starter | Tigris | No | — |
| Pro | Tigris | Yes, self-service | 1/year |
| Business | Customer choice at signup | Yes | As needed |
| Enterprise | Customer choice at contract | Yes | As needed |

cc may want to gate self-service migration behind additional checks (e.g., require 2FA, rate-limit at admin API level) to prevent accidents.

---

## Testing strategy (suggested)

**Unit tests per adapter:** put/get/delete/list/stat/copy against a mock S3-compatible server (minio in Docker). Verify tenant prefix isolation — one tenant's list() must not surface another tenant's objects.

**Integration tests against real Tigris:** `fly storage create` a throwaway bucket in CI, run full adapter test suite, clean up. This needs a Fly.io test account and CI secret injection — cc should evaluate whether this is worth the setup complexity vs. relying on Tigris's S3 compatibility claim.

**Integration tests against real R2:** similar to Tigris but against a Cloudflare test account. Optional in CI if S3 compatibility is trusted.

**Migration test:** end-to-end test that puts 100 objects of varying sizes in Tigris, triggers migration to R2, verifies all objects arrive with matching etags, verifies source bucket deletion after grace period.

**Failure injection:** simulate target-provider unreachability mid-migration, verify `storage_status = 'migration_failed'` and source remains intact.

---

## Open questions for cc and Christian

1. **SDK choice.** AWS SDK v3 is the obvious default and works with both. Alternatives: `@aws-sdk/client-s3` directly vs. a lighter abstraction. Any preference from the existing `apps/server` stack?

2. **Stream handling.** Large source uploads (video files for F46) may be 500MB+. Adapter should stream put/get, not buffer full objects in memory. AWS SDK v3 supports this but the ergonomics differ by upload strategy (single put vs. multipart). Worth benchmarking on a 500MB upload before locking.

3. **Signed URL caching.** Signed URLs for wiki-page assets get generated per-request. Should we cache them in libSQL with TTL, or regenerate each time? Caching adds complexity but reduces S3 API calls significantly for hot assets. Probably out of scope for F42 but worth flagging.

4. **Credentials rotation.** Tigris and R2 credentials may rotate. Should the adapter re-read credentials from env on each request, or cache them in-process? If cached, what's the invalidation strategy? Probably in-process cache with restart-to-rotate is fine for MVP.

5. **Encryption at rest.** Tigris and R2 both encrypt at rest by default. F81 adds customer-held-key encryption for Enterprise — that's separate scope but should interoperate cleanly with F42. cc should ensure the adapter interface doesn't preclude F81's design.

6. **Migration cost.** Large Business-tier tenants may have 2TB+ of sources. Egress cost from Tigris during migration is non-trivial ($20+ for 2TB). Who pays? Probably Broberg.ai for initial migrations, but consider charging Enterprise customers for ad-hoc migrations beyond the first.

---

## Acceptance criteria

- [ ] `@trail/storage` package exports both `TigrisStorage` and `R2Storage` implementations of the `Storage` interface
- [ ] Factory function returns the right adapter based on tenant config
- [ ] All existing F13 consumers work unchanged
- [ ] Migration endpoint accepts a target provider + config and enqueues a background job
- [ ] Background migration completes successfully for a test tenant with ≥1000 objects and ≥10GB total size
- [ ] Migration verifies etag match for every object; fails loudly on any mismatch
- [ ] Tenant API enforces `storage_status` for writes (blocked during migration)
- [ ] Admin UI shows migration progress (extension of F54 analytics dashboard)
- [ ] 30-day delayed cleanup job removes source-provider objects after successful migration
- [ ] Unit tests cover put/get/delete/list/stat/copy on both adapters with minio mock
- [ ] Integration test against real Tigris bucket passes in CI

---

## Estimate

**Effort:** Medium.

- Tigris adapter: 1-2 days (thin wrapper over AWS SDK v3)
- R2 adapter: 1 day (same SDK, different endpoint)
- Factory and config wiring: half a day
- Migration job: 2-3 days (the genuinely new logic)
- Tests and CI setup: 2 days
- Admin UI surface for migration: depends on F54, could be deferred

Total: 1-1.5 weeks of focused work, assuming no surprises in S3-compatibility edge cases between providers.

---

## References

- SAAS-SCALING-PLAN.md — storage layer decisions
- F13 — existing Storage interface
- [Fly.io Tigris docs](https://fly.io/docs/reference/tigris/)
- [Cloudflare R2 docs](https://developers.cloudflare.com/r2/)
- [AWS SDK v3 S3 client docs](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/clients/client-s3/)
