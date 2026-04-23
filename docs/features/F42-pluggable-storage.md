# F42 — Pluggable Storage (Tigris + R2 Adapters)

> Two production-ready S3-compatible storage adapters (Tigris + Cloudflare R2) implementing the F13 `Storage` interface. Tenants configure which adapter to use; Pro+ tenants can migrate between them without downtime. Tier: Pro+. Effort: Medium (1-1.5 weeks). Status: Planned.

## Problem

Trail currently ships with a single `local-adapter.ts` for development and a `Storage` interface (F13) with no production adapters. Every tenant's sources, exports, and wiki-page assets land on the local filesystem. This blocks multi-tenant SaaS deployment (F41), prevents enterprise customers with existing Cloudflare commitments from adopting Trail, and makes data residency compliance impossible.

## Secondary Pain Points

- No path to additional adapters (S3, B2, MinIO, Wasabi) without re-architecting the interface each time.
- Large source uploads (video files for F46) buffer in memory — no streaming put/get.
- Signed URLs for wiki-page assets are regenerated per-request with no caching, inflating S3 API calls for hot assets.

## Solution

Ship two adapters together — **Tigris** (Fly.io's native object storage, default for all tiers) and **Cloudflare R2** (alternative for Pro+ tenants). Both are S3-compatible and implement the existing `Storage` interface from F13. A factory selects the adapter per-tenant based on config. A background migration job handles Tigris ↔ R2 migration with etag verification and a 30-day grace-period cleanup.

## Non-Goals

- **Multi-provider active-active replication.** A tenant uses one storage provider at a time. Warm standby via periodic sync is a Phase 3 Business+ feature.
- **Cross-provider object-level sync.** After migration, the old bucket is deleted after a 30-day grace period. No attempt to keep both in sync.
- **Custom per-object ACLs.** All objects are tenant-prefixed and accessed via signed URLs. Fine-grained ACLs are Enterprise-tier scope.
- **CDN edge caching.** Tigris is globally distributed by default; R2 integrates with Cloudflare's CDN separately. No custom work needed here.
- **Credentials rotation automation.** In-process cache with restart-to-rotate is fine for MVP.

## Technical Design

### Package structure

```
packages/storage/
  src/
    interface.ts        ← Storage interface (exists per F13)
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
```

### Storage interface extension

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

### Adapter configs

```typescript
export interface TigrisConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface R2Config {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}
```

### Key naming convention

```
tenants/<tenant-id>/sources/<source-id>/<filename>
tenants/<tenant-id>/exports/<export-id>/<filename>
tenants/<tenant-id>/assets/<wiki-page-id>/<asset-id>.<ext>
```

### Tenant storage config schema

```sql
ALTER TABLE tenants ADD COLUMN storage_provider TEXT NOT NULL DEFAULT 'tigris';
ALTER TABLE tenants ADD COLUMN storage_config JSON;
ALTER TABLE tenants ADD COLUMN storage_status TEXT NOT NULL DEFAULT 'active';
-- storage_status: 'active' | 'migrating' | 'migration_failed'
```

### Migration flow

```
POST /admin/tenants/:id/storage/migrate
Body: { target_provider: 'r2', target_config: R2Config }

1. Validate target_config by testing put/get/delete on a throwaway key
2. UPDATE tenants SET storage_status = 'migrating' WHERE id = :id
3. Enqueue migration job
4. Return 202 Accepted with migration job ID

Background worker:
1. List all objects with prefix tenants/<id>/ from source
2. For each object: stat() → copy (stream) → stat() verify etag/size
3. Verify final object count and total bytes match
4. UPDATE tenants SET storage_provider = :target, storage_status = 'active'
5. Schedule source-provider cleanup job for +30 days
6. Notify tenant admin via email
```

### Default selection per tier

| Tier | Default | Can change | Migration frequency |
|------|---------|------------|---------------------|
| Hobby | Tigris | No | — |
| Starter | Tigris | No | — |
| Pro | Tigris | Yes, self-service | 1/year |
| Business | Customer choice at signup | Yes | As needed |
| Enterprise | Customer choice at contract | Yes | As needed |

## Interface

### Factory

```typescript
// packages/storage/src/factory.ts
export function createStorage(
  provider: 'tigris' | 'r2' | 'local',
  config: TigrisConfig | R2Config | LocalConfig,
): Storage;
```

### Migration endpoint

```
POST /admin/tenants/:id/storage/migrate
  → 202 { jobId: string, status: 'queued' }

GET /admin/tenants/:id/storage/migration/:jobId
  → 200 { status: 'running' | 'completed' | 'failed', progress: { objects: number, bytes: number } }
```

## Rollout

**Single-phase deploy.** The adapters are new — no migration needed for existing dev instances (they use local-adapter). Production tenants default to Tigris. R2 is opt-in via admin API. Migration job is gated behind admin-only endpoint.

## Success Criteria

- `@trail/storage` package exports both `TigrisStorage` and `R2Storage` implementations of the `Storage` interface.
- Factory function returns the right adapter based on tenant config.
- All existing F13 consumers work unchanged.
- Background migration completes successfully for a test tenant with ≥1000 objects and ≥10GB total size.
- Migration verifies etag match for every object; fails loudly on any mismatch.
- Unit tests cover put/get/delete/list/stat/copy on both adapters with minio mock.
- Integration test against real Tigris bucket passes in CI.

## Impact Analysis

### Files created (new)

- `packages/storage/src/tigris-adapter.ts`
- `packages/storage/src/r2-adapter.ts`
- `packages/storage/src/factory.ts`
- `packages/storage/src/migration.ts`
- `packages/storage/test/tigris.test.ts`
- `packages/storage/test/r2-adapter.test.ts`
- `packages/storage/test/migration.test.ts`
- `packages/storage/README.md`
- `apps/server/src/routes/admin/storage.ts`

### Files modified

- `packages/storage/src/interface.ts` (add `stat` and `copy` methods)
- `packages/storage/src/types.ts` (add `StorageObjectStat` type)
- `packages/db/src/schema.ts` (add `storage_provider`, `storage_config`, `storage_status` columns to `tenants`)

### Downstream dependents

`packages/storage/src/interface.ts` — New file in this workspace context; no existing dependents yet. Any consumer of the `Storage` interface will need to implement `stat` and `copy` (local-adapter included).

`packages/storage/src/types.ts` — New file; no existing dependents.

`packages/db/src/schema.ts` — This is the central schema file. Adding columns to `tenants` is additive (NOT NULL with DEFAULT), so no downstream changes required. All existing tenant reads/writes are unaffected.

### Blast radius

- Adding `stat` and `copy` to the `Storage` interface is a **breaking change** for any existing adapter implementation — `local-adapter.ts` must be updated.
- `storage_config` holds credentials as JSON; must be encrypted at rest (F81 interop).
- Migration job runs as background worker — must handle process restart mid-migration (idempotent retry).
- During migration, `storage_status = 'migrating'` blocks new uploads (423 Locked) — must not block reads.

### Breaking changes

**Yes** — adding `stat` and `copy` to the `Storage` interface requires all adapter implementations (including `local-adapter.ts`) to implement these methods. Migration: add no-op or filesystem-based implementations to `local-adapter.ts`.

### Test plan

- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Unit: Tigris adapter put/get/delete/list/stat/copy against minio mock
- [ ] Unit: R2 adapter put/get/delete/list/stat/copy against minio mock
- [ ] Unit: Factory returns correct adapter for each provider config
- [ ] Unit: Tenant prefix isolation — one tenant's list() must not surface another tenant's objects
- [ ] Integration: Migration of 100 objects from Tigris to R2, all etags match
- [ ] Integration: Failure injection — target-provider unreachability mid-migration, `storage_status = 'migration_failed'`, source intact
- [ ] Regression: Local adapter still works for dev (put/get/delete)
- [ ] Regression: Existing F13 consumers work unchanged with factory-wrapped adapter

## Implementation Steps

1. Add `stat` and `copy` methods to `Storage` interface in `packages/storage/src/interface.ts`; implement them in `local-adapter.ts`.
2. Implement `TigrisStorage` class using AWS SDK v3 S3 client with Tigris endpoint.
3. Implement `R2Storage` class using AWS SDK v3 S3 client with R2 endpoint.
4. Create `createStorage()` factory in `packages/storage/src/factory.ts` that selects adapter based on tenant config.
5. Add `storage_provider`, `storage_config`, `storage_status` columns to `tenants` table via Drizzle migration.
6. Implement migration job in `packages/storage/src/migration.ts` — list, stream-copy, verify, cleanup.
7. Add admin route `POST /admin/tenants/:id/storage/migrate` + status endpoint.
8. Write unit tests for both adapters against minio mock.
9. Set up CI integration test against real Tigris bucket (Fly.io test account + secret injection).
10. Wire factory into existing F13 consumers (ingest, export, asset upload paths).

## Dependencies

- F13 (Storage Adapter interface — already done)

Blocks: F41 (Tenant Provisioning + Signup), F46 (Video ingest), F52 (FysioDK Onboarding), F81 (Per-KB Encryption — must interop).

## Open Questions

1. **SDK choice.** AWS SDK v3 is the obvious default. Any preference from the existing `apps/server` stack?
2. **Stream handling.** Large uploads (500MB+) should stream, not buffer. AWS SDK v3 supports this but ergonomics differ by strategy (single put vs. multipart). Worth benchmarking before locking.
3. **Signed URL caching.** Cache in libSQL with TTL or regenerate per-request? Probably out of scope for F42 but worth flagging.
4. **Credentials rotation.** In-process cache with restart-to-rotate fine for MVP?
5. **Migration cost.** Egress from Tigris during migration for 2TB+ tenants is $20+. Who pays?

## Related Features

- **F13** (Storage Adapter interface) — prerequisite, already done
- **F41** (Tenant Provisioning + Signup) — blocked by F42
- **F46** (Video ingest) — needs streaming put for large files
- **F52** (FysioDK Onboarding) — blocked by F42
- **F54** (Admin analytics dashboard) — migration progress UI extension
- **F81** (Per-KB Encryption) — must interop with storage_config encryption

## Effort Estimate

**Medium** — 1-1.5 weeks.

- Tigris adapter: 1-2 days (thin wrapper over AWS SDK v3)
- R2 adapter: 1 day (same SDK, different endpoint)
- Factory and config wiring: half a day
- Migration job: 2-3 days (the genuinely new logic)
- Tests and CI setup: 2 days
- Admin UI surface for migration: depends on F54, could be deferred
