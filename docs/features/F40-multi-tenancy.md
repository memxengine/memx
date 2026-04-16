# F40 — Multi-Tenancy on `app.trailmem.com`

> Database-per-tenant with libSQL embedded on Fly Machine. Shared Node for Hobby/Starter/Pro, dedicated Node for Business+. This is the feature that turns Trail from single-tenant engine into SaaS.

## Note on this plan doc

This plan is a proposal by claude.ai, informed by [SAAS-SCALING-PLAN.md](../SAAS-SCALING-PLAN.md). The architectural shape is confident, but **specific implementation details are up to cc and Christian to refine together**. Where this doc says "suggested," "likely," or "we propose," those are starting points for discussion, not locked requirements. Flag disagreements with the claude.ai reasoning below.

## Problem

Phase 1 is single-tenant. `packages/db/src/schema.ts` includes a `tenants` table with `tenant_id` foreign keys already scaffolded across all relevant rows, but there is one database file and one server process. Sanne's deploy will likely be a single Fly Machine running her own Trail; that works for her, but it doesn't scale.

For Phase 2 (`app.trailmem.com`), we need:

- N tenants per physical Machine (for Hobby/Starter/Pro economics)
- One tenant per Machine (for Business dedicated Nodes)
- Request routing based on subdomain + auth context
- Database isolation strong enough to pass a basic security audit
- An upgrade path from shared-Machine to dedicated-Machine that is a file move, not a data extraction
- No accidental cross-tenant data leakage, ever

The decision made in SAAS-SCALING-PLAN.md: **libSQL embedded per-tenant, one database file per tenant, tenant routing in the Trail server process.** This document specifies how to get there.

## Scope split: F40.1 first, F40.2 second

This plan is large. It splits naturally into two shippable pieces that can land weeks apart without leaving the engine in a broken state between them.

### F40.1 — Database client migration: `drizzle-orm/bun-sqlite` → `drizzle-orm/libsql` · ~1 day

Swaps the underlying driver only. Stays single-tenant, stays on one database file, stays on the existing volume. The point is to move to libSQL **before** the Sanne deploy so that F40.2 (actual multi-tenancy) is additive rather than a simultaneous driver-and-architecture change against a live customer.

What changes:

| Layer | Before | After |
|---|---|---|
| Driver | `bun:sqlite` (Bun built-in, sync) | `@libsql/client` (npm, async) |
| Drizzle adapter | `drizzle-orm/bun-sqlite` | `drizzle-orm/libsql` |
| Client init | `new Database(path)` | `createClient({ url: 'file:' + path })` |
| Query calls | `.get() / .all() / .run()` (sync) | `await .get() / .all() / .run()` (async) |
| Transactions | `db.transaction((tx) => { … })` | `await db.transaction(async (tx) => { … })` |
| Raw SQL (MCP) | `rawDb.prepare(sql).all(...)` | `await client.execute({ sql, args })` |

What stays identical:

- The `.db` file format (libSQL is a drop-in for SQLite files — WAL, triggers, FTS5 contentless tables, indexes all work unchanged)
- Drizzle schema (`sqliteTable`, `text()`, `integer()` etc. — no schema-code changes)
- Migration files emitted by drizzle-kit (same SQL dialect)
- FTS5 + triggers (F10 unaffected — identical behaviour)
- `crypto.randomUUID()`, `Date.now()`, etc. — nothing in app logic changes

What we gain:

- Native vector search (`F32_BLOB(n)` column type + `vector_distance_cos(...)` function) available when F10 or F78 needs embeddings — no sqlite-vec extension compilation, no in-memory HNSW
- Remote-access protocol available (we don't use it, but it's there for future admin tooling and opt-in Turso Cloud backup on Business+)
- Connection-open latency: ~40µs vs ~100µs (measurable only in microbenchmarks, but relevant for the F40.2 connection pool)

What we pay:

- One additional npm dependency (`@libsql/client`, ~2 MB)
- Async migration across every DB call site (TypeScript catches all of them — missing `await` shows up as `Promise<T>` vs `T` mismatch)
- Mild async overhead (~300-800 ns vs ~200-500 ns per simple SELECT — invisible in HTTP request contexts)

Scope:

- Touch files: `packages/db/src/index.ts`, `packages/db/package.json`, every `routes/*.ts` + `services/*.ts` + `packages/core/src/queue/*.ts` + `apps/mcp/src/index.ts` query site
- Leave untouched: schema, migrations, FTS5 triggers, tests structure
- Smoke test: re-run the F17 Session A/B end-to-end smoke test against the libSQL-backed engine; verify identical wiki-doc creation, events, queue behaviour

F40.1 ships on its own commit. F40.2 below builds on top of it.

### F40.2 — Multi-tenancy on top of libSQL · 10-15 days

The big refactor described in the rest of this document — `@trail/db` with `TrailDatabase` interface, connection pool, registry database, tenant-context middleware, per-tenant file layout, migration runner, provisioning + deprovisioning + upgrade flows, dev-mode fallback. Every section below this one is part of F40.2.

## Solution

Each tenant gets an isolated libSQL database file. The Trail server process opens connections to tenant databases on demand based on authenticated tenant context. Database files live on Fly Volumes attached to the Machine. Connection pooling keeps frequently-used tenant databases warm.

A thin `@trail/db` package wraps libSQL client and exposes a `TrailDatabase` interface. Every other package (ingest, queue, wiki, chat) consumes `TrailDatabase`, never raw libSQL. This matches the pattern of F13 (storage adapter) and F14 (LLM adapter) and preserves the migration path to Postgres (F84) as a Phase 3 / emergency option.

**Critically, this is not Turso Cloud.** libSQL runs embedded as a library inside Trail's server process. Database files sit on Fly Volumes. No managed database service. No network hop for queries. The disambiguation between libSQL (production-ready), Turso Database (Rust rewrite, beta), and Turso Cloud (managed service, optional secondary use) is specified in SAAS-SCALING-PLAN.md.

## Technical Design

### Package structure (suggested)

```
packages/
  db/
    src/
      interface.ts          ← TrailDatabase interface
      factory.ts            ← returns adapter based on tenant config
      libsql-adapter.ts     ← default: libSQL embedded on Fly Volume
      postgres-adapter.ts   ← Phase 3 / emergency fallback (can stub for now)
      connection-pool.ts    ← keeps tenant DBs warm
      migration.ts          ← per-tenant schema migration runner
      schema/               ← Drizzle schema (moved here from apps/server/src/db)
    test/
      libsql.test.ts
      connection-pool.test.ts
      tenant-isolation.test.ts
    README.md
```

The factory reads the tenant's configuration and returns the right `TrailDatabase`. For Phase 2 all tenants use libSQL; Postgres comes in Phase 3 or as emergency fallback.

### TrailDatabase interface (suggested)

```typescript
// packages/db/src/interface.ts
import type { DrizzleDatabase } from 'drizzle-orm';

export interface TrailDatabase {
  // Drizzle query builder scoped to this tenant
  db: DrizzleDatabase;

  // Tenant identity (derived from connection, for logging/observability)
  tenantId: string;

  // Connection lifecycle
  close(): Promise<void>;

  // Health check for operational monitoring
  health(): Promise<{ ok: boolean; latencyMs: number }>;
}
```

Any handler that needs DB access takes a `TrailDatabase` (typically from request context), never instantiates an adapter directly.

### Connection pool (suggested)

libSQL's connection opening is fast (~40μs per Turso's benchmarks after the July 2025 optimization) but we still want to avoid reopening on every request. A warm pool keeps active tenants' connections in memory with LRU eviction.

```typescript
// packages/db/src/connection-pool.ts
interface PoolConfig {
  maxOpenTenants: number;        // default: 200 for shared Node, 1 for dedicated
  idleEvictionMs: number;        // default: 5 minutes
  tenantDbPathResolver: (tenantId: string) => string;
}

export function createConnectionPool(config: PoolConfig) {
  // LRU cache of open libSQL clients, keyed by tenantId
  // getTenantDatabase(id): opens if not present, evicts LRU if at cap
  // closeAll(): called on process shutdown
}
```

cc may want to benchmark whether 200 open connections on a shared-cpu-1x Machine is actually fine. Memory per open libSQL connection is small (tens of KB) but if the actual footprint surprises us, reduce the pool cap and accept reopen latency for cold tenants.

### Request routing (suggested)

```typescript
// apps/server/src/middleware/tenant-context.ts
export async function tenantContextMiddleware(c: Context, next: Next) {
  const auth = c.get('auth');
  if (!auth?.tenantId) {
    return c.json({ error: 'unauthenticated' }, 401);
  }

  // Get tenant's database from the pool (opens if needed)
  const trailDb = await pool.getTenantDatabase(auth.tenantId);

  // Get tenant's storage adapter (F42)
  const storage = await getTenantStorage(auth.tenantId);

  c.set('db', trailDb);
  c.set('storage', storage);

  await next();
}
```

Every route handler accesses `c.get('db')` for the tenant's scoped DB. Cross-tenant queries are impossible at this layer because the connection itself only reaches one tenant's database file.

### Tenant database file layout (suggested)

```
/data/tenants/
  <tenant-uuid>.db         ← libSQL database file
  <tenant-uuid>.db-wal     ← WAL file (same directory as .db)
  <tenant-uuid>.db-shm     ← shared memory file
```

UUID is the primary identifier. Human-readable slug (`sanne`, `fysiodk`) is stored in a separate registry (see below) and resolved to UUID at auth time.

For Business-tier tenants on dedicated Machines, the same path applies but the Machine only hosts one `<tenant-uuid>.db`. Easier mental model, same code path.

### Global registry database (suggested)

There needs to be one additional database per Machine that holds cross-tenant metadata. This is NOT a multi-tenant shared DB — it's the routing layer.

```
/data/registry.db  ← shared across all tenants on this Machine
  Tables:
    - tenant_lookup (tenant_id, slug, created_at, plan, region, active)
    - machine_metadata (machine_id, capacity, current_tenant_count)
```

`tenant_lookup` maps subdomain-slug (`sanne.trailmem.com`) to `tenant_id` UUID. Also holds plan info for quota enforcement (F44). Authentication middleware reads from `registry.db` to identify the tenant, then routes to the tenant's own database for all other queries.

cc should consider: should registry.db live on the Machine or in a global Turso Cloud registry accessible from all Machines? Local is simpler but means tenant-to-Machine mapping lives at the DNS/deploy layer, not in a queryable database. For Phase 2 MVP, local registry per Machine is probably fine; revisit for multi-region (F77).

### Tenant lifecycle

**Provisioning** (detailed in F41):

1. Create `tenant_id` UUID
2. Create `/data/tenants/<uuid>.db` with libSQL
3. Run schema migrations on the new database
4. Insert row in `registry.db` tenant_lookup
5. Set up storage prefix (F42)
6. Seed initial data (default KB, owner user, etc.)

**Deprovisioning** (off-boarding):

1. Set `tenant_lookup.active = false` (prevents new requests)
2. Wait 30 days (grace period for restoration)
3. Archive `.db` file to cold storage
4. Delete source-file objects from storage provider
5. Delete `.db` file from volume
6. Remove `tenant_lookup` row

cc should build the deprovisioning path but gate actual deletion behind a manual admin confirmation for Phase 2. Automated deletion is tempting-fate scope.

### Schema migrations (suggested)

Per-tenant databases need coordinated migrations. Proposed approach:

- `packages/db/src/migration.ts` runs migrations on a single database file
- On server startup, iterate all `tenant_lookup` rows where `active = true`, run pending migrations
- New tenants get migrations applied during provisioning
- Migration state stored in each tenant DB in `__drizzle_migrations` table (Drizzle default)

For large fleets this becomes expensive at startup. Options to consider:

- Run migrations asynchronously in background job queue, not blocking server startup
- Only migrate "hot" tenants at startup; lazy-migrate others on first access
- Separate migration command you run before deploy, not on startup

For Phase 2 with <100 tenants per Machine, synchronous-at-startup is fine. Revisit when tenant count grows.

### Schema changes needed in the global registry

```sql
-- registry.db (one per Machine)
CREATE TABLE tenant_lookup (
  tenant_id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  plan TEXT NOT NULL,                    -- 'hobby' | 'starter' | 'pro' | 'business' | 'enterprise'
  region TEXT NOT NULL,                  -- 'arn' | 'lhr' | 'fra' | ...
  storage_provider TEXT NOT NULL DEFAULT 'tigris',  -- F42 connection point
  storage_config_encrypted BLOB,
  created_at INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,

  -- Soft-deletion for 30-day grace period
  deactivated_at INTEGER,
  scheduled_deletion_at INTEGER
);

CREATE INDEX idx_tenant_lookup_slug ON tenant_lookup(slug) WHERE active = 1;

CREATE TABLE machine_metadata (
  machine_id TEXT PRIMARY KEY,
  fly_machine_id TEXT,
  region TEXT NOT NULL,
  machine_class TEXT NOT NULL,           -- 'shared-cpu-1x' | 'performance-2x' | ...
  tenant_capacity INTEGER NOT NULL,
  current_tenant_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_updated_at INTEGER NOT NULL
);
```

### Schema changes needed in tenant databases

The existing `packages/db/src/schema.ts` already has `tenant_id` columns on relevant tables. In a per-tenant database, `tenant_id` is redundant (every row is implicitly the current tenant's) but leaving it in simplifies the migration from shared-DB-with-RLS style if we ever regret the per-tenant decision. cc should decide:

- Keep `tenant_id` columns as defense-in-depth (checked on every query as belt-and-suspenders)
- Remove them for cleanliness (rely on the database file boundary as the only tenant boundary)

I lean toward keeping them. The extra bytes don't matter; the extra safety net does. This is worth a 10-minute discussion.

### Tenant upgrade path: Pro (shared) → Business (dedicated)

```
1. Mark tenant as 'migrating' in registry.db (blocks writes briefly)
2. Provision new performance-8x Machine via Fly API
3. Create new volume on that Machine
4. scp or fly ssh the tenant's .db file from old Machine to new Machine
5. Run any pending migrations on the new database
6. Update DNS: <slug>.trailmem.com now points to new Machine
7. Update global registry (if multi-Machine registry exists) or both local registries
8. Mark tenant as 'active' on new Machine
9. Verify a few queries succeed against new Machine
10. Remove tenant from old Machine's registry
11. Delete the .db file from old Machine after 7-day grace period
```

This is <15 minutes of work for typical tenants, sub-5-minute for small ones. cc may want to dry-run this flow against a test tenant before shipping F40 — migration bugs are the kind of thing you want to catch before a paying customer runs into them.

### Authentication flow (suggested)

Handled by F03 (already done for single-tenant) + extensions:

1. User hits `<slug>.trailmem.com/auth/login`
2. Subdomain `<slug>` resolves to tenant via `registry.db` lookup
3. OAuth flow proceeds, tenant context included in state
4. On callback, session cookie is scoped to that tenant
5. All subsequent requests have tenant context in auth middleware

cc should consider cookie-scoping: is the session cookie shared across `*.trailmem.com` (so a user can belong to multiple tenants) or strictly per-subdomain? Multi-tenant user accounts are a Phase 3 concern; per-subdomain sessions are simpler and matches most SaaS patterns.

## Impact Analysis

### Files affected

**Create:**
- `packages/db/` — entire new package (interface, factory, adapters, pool, migration runner)
- `apps/server/src/middleware/tenant-context.ts` — the routing middleware
- `apps/server/src/services/tenant-registry.ts` — registry.db access
- `apps/server/src/services/provisioning.ts` — tenant create/destroy (expanded in F41)
- `infra/fly/` — fly.toml updates for volume mounting

**Modify:**
- `apps/server/src/db/` — contents move to `packages/db/src/schema/`
- `apps/server/src/app.ts` — install tenant-context middleware
- Every route handler — update to read `c.get('db')` instead of importing global db
- `packages/shared/src/contracts.ts` — add tenant-related types

**Delete:**
- `apps/server/src/db/client.ts` (if it exists as singleton) — global DB client is now the registry client only

### Downstream dependents

- **F41 (Tenant Provisioning):** directly depends on F40's provisioning primitives
- **F42 (Pluggable Storage):** tenant_lookup holds storage_provider and config
- **F43 (Stripe Billing):** plan field in tenant_lookup drives quota enforcement
- **F44 (Usage Metering):** metering collectors need tenant context; bulk export runs per-tenant
- **F52 (FysioDK Onboarding):** FysioDK becomes tenant #2; can't onboard until F40 ships
- **F53 (Custom Subdomains):** tenant_lookup slug becomes the routing key

Anything that currently uses a global DB connection needs to migrate. That's most of `apps/server/src/routes/` and `apps/server/src/services/`. Mechanical refactor, not design work.

### Blast radius

Everything. This is the single biggest architectural change in Phase 2. The single-tenant dev flow becomes "you're always operating as a specific tenant" and most developer muscle memory needs to update.

Mitigation: ship F40 with a dev-mode default tenant (`dev-tenant` UUID auto-loaded when no auth is present) so local development doesn't become painful. Real auth gets enforced in production.

### Breaking changes

Dev environment breaks without dev-mode fallback. Tests break if they assume global DB. Both fixable but require attention.

External API: no breaking changes. API surface is the same; the database isolation is internal.

### Test plan

- [ ] TypeScript compiles: `bun run typecheck`
- [ ] Create a tenant via provisioning service → `.db` file exists, migrations ran, registry has entry
- [ ] Request routing: `GET <slug>.trailmem.com/api/v1/kbs` returns that tenant's KBs, NOT another tenant's
- [ ] Attempt cross-tenant query: tenant A's auth context, try to read tenant B's document → fails (404 or 403)
- [ ] Connection pool: open 250 tenant DBs in a loop, verify LRU eviction works, no file handle leaks
- [ ] Startup migration: deploy new schema, restart server, verify all active tenants have migrations applied
- [ ] Upgrade flow: migrate a test tenant from shared Machine to dedicated Machine, verify data integrity and downtime <5 minutes
- [ ] Deprovisioning: mark test tenant inactive, verify 30-day grace period, verify eventual file deletion
- [ ] Regression: Sanne's single-tenant flow (F37) still works in her single-tenant deploy
- [ ] Regression: all F01-F39 features work when running as a tenant

### Performance test

At 100 active tenants on a shared performance-2x Machine:

- [ ] Queries from 10 concurrent tenants show no cross-tenant interference
- [ ] Connection pool hit rate >90% under realistic load
- [ ] RAM usage stays under 3GB (leaves 1GB headroom on 4GB Machine)
- [ ] Compile operation on tenant A doesn't slow tenant B's queries below acceptable latency (define acceptable: p95 <500ms for wiki reads)

## Implementation Steps

1. Create `packages/db` package structure. Move existing schema from `apps/server/src/db/schema.ts` to `packages/db/src/schema/`.
2. Define `TrailDatabase` interface and `libsql-adapter.ts` implementation.
3. Implement `connection-pool.ts` with LRU and idle eviction.
4. Implement `registry.db` schema and `tenant-registry.ts` service.
5. Implement `tenantContextMiddleware` and install in app.ts.
6. Implement dev-mode default-tenant bypass so local development works.
7. Refactor every route handler to use `c.get('db')`.
8. Implement migration runner and on-startup migration for active tenants.
9. Implement basic provisioning service (create tenant + DB file + registry row).
10. Implement basic deprovisioning (soft-delete → grace period → file removal).
11. Implement upgrade flow (move .db between Machines with minimal downtime).
12. Write tenant isolation tests (every route tested against cross-tenant access attempts).
13. Dry-run upgrade flow on test tenants.
14. Deploy to `app.trailmem.com` with a test tenant; smoke-test end-to-end.

Step 6 is the one to not skip. A broken dev environment kills momentum; a good default-tenant fallback keeps local development identical to Phase 1.

## Dependencies

- F02 Tenant-aware schema (Done) — the schema is already multi-tenant; F40 makes it real
- F03 Google OAuth (Done) — auth produces the tenant context that routing depends on
- F06 Ingest pipeline — must work under per-tenant database
- F13 Storage adapter (Done) — F40 picks which adapter to use per tenant
- F33 Fly.io deploy (planned) — F40 deploys to the same infra; must understand volume layout

**Blocks:**
- F41 Tenant Provisioning + Signup
- F42 Pluggable Storage (consumes tenant storage_provider from registry)
- F43 Stripe Billing (plan field in registry)
- F44 Usage Metering (per-tenant collection)
- F45 @webhouse/cms adapter (tenants are the consumer model)
- F52 FysioDK (customer #2)
- All Phase 2 features

## Open questions for cc and Christian

1. **Registry database placement.** Local registry.db per Machine (simple, works for Phase 2) vs. global registry via Turso Cloud (scales to multi-Machine / multi-region)? Recommend local for Phase 2, revisit for F77.

2. **`tenant_id` columns in tenant DBs.** Keep as defense-in-depth or drop for cleanliness? I lean keep; cc may disagree.

3. **Migration timing.** At server startup (simple) vs. background job (scales) vs. separate command before deploy (safest)? For <100 tenants, startup is fine; at 1000+ this becomes a bottleneck.

4. **Dev-mode tenant bypass.** What's the simplest way to auto-provide a tenant context when no auth is present? Options: hardcoded UUID, `TENANT_DEV_ID` env var, auto-create on first run. Leaning toward env var with auto-create fallback.

5. **Connection pool size defaults.** 200 for shared-cpu-1x feels right for Hobby density. For performance-8x running one Business tenant, maxOpenTenants=1. cc should verify these ranges are reasonable after benchmarking.

6. **Cookie scoping.** Per-subdomain (simpler, matches SaaS patterns) vs. shared across `*.trailmem.com` (enables user-across-tenants later). Recommend per-subdomain for Phase 2; add cross-tenant users in Phase 3 if there's demand.

7. **Registry access control.** The registry.db holds tenant plans, storage config, and other sensitive cross-tenant metadata. It's written-to by provisioning (admin) and read by request routing (every request). Is read-access to the full registry table acceptable, or do we need stricter boundaries? Probably acceptable for Phase 2; Phase 3 might require per-tenant-scoped reads.

## Acceptance criteria

- [ ] `@trail/db` package exports `TrailDatabase` interface and `libsqlAdapter` implementation
- [ ] Connection pool keeps ≥200 tenant DBs warm with LRU eviction
- [ ] Registry database routes authenticated requests to the right tenant DB
- [ ] All existing Phase 1 features work correctly in a per-tenant context
- [ ] Cross-tenant access attempts are rejected at the API layer (tested)
- [ ] Tenant provisioning creates a new .db file + migrations + registry row atomically
- [ ] Tenant deprovisioning has a 30-day grace period before file deletion
- [ ] Upgrade flow (shared Node → dedicated Node) completes in <15 minutes for a test tenant
- [ ] Dev-mode fallback keeps local development identical to Phase 1
- [ ] Integration test runs 10 tenants concurrently and verifies isolation

## Effort Estimate

**Large** — 10-15 days of focused work.

Breakdown:
- Package structure and interface: 1 day
- libSQL adapter + connection pool: 2 days
- Registry database + tenant service: 1 day
- Tenant-context middleware + routing: 1 day
- Schema migration runner: 1 day
- Dev-mode fallback: half a day
- Refactoring every handler to use `c.get('db')`: 2 days (mostly mechanical)
- Provisioning service: 1 day
- Deprovisioning with grace period: 1 day
- Upgrade flow: 2 days (and this is where surprises live)
- Tests (isolation + performance + regression): 2-3 days

The upgrade flow and the handler refactor are where estimates most likely slip. Budget accordingly.

## References

- [SAAS-SCALING-PLAN.md](../SAAS-SCALING-PLAN.md) — tenant architecture section
- F42 — Pluggable Storage (consumes storage_provider from registry)
- [libSQL multi-tenant patterns](https://turso.tech/multi-tenancy)
- F17 — Curation Queue API (reference for F-feature doc structure)
