# SAAS-SCALING-PLAN.md

**Status:** Draft — pricing proposals, not yet locked
**Author:** claude.ai (Opus 4.6) in conversation with Christian
**Date:** 2026-04-16
**Audience:** cc session for `broberg-ai/trail`
**Cross-references:** [ROADMAP.md](./ROADMAP.md), [FEATURES.md](./FEATURES.md), [PLAN-PATCH.md](./PLAN-PATCH.md)

---

## Purpose

This document defines the scaling architecture and SaaS pricing strategy for `trailmem.com` (the SaaS product built on the Trail engine). It answers three questions that the existing roadmap has left open:

1. How does Trail actually scale from a single-tenant deployment (Sanne) to an arbitrary number of tenants with arbitrary-sized Trails?
2. What are the hard architectural limits of a single-node deployment, and what triggers a tier upgrade?
3. What is the pricing structure that makes the SaaS a real business while remaining honest about infrastructure cost?

The pricing tiers here are proposals to inform F40-F44 (multi-tenancy, provisioning, storage, Stripe billing, usage metering). Final numbers should be validated with 2-3 prospective Business-tier customers before launch.

---

## Terminology — locking in the mental model

| Term | Meaning |
|------|---------|
| **Trail** | One knowledge base (one wiki, one "research area" or "team brain") |
| **Neuron** | One compiled wiki page within a Trail |
| **Node** | The infrastructure unit a Trail runs on — maps to a Fly.io Machine |
| **Connector** | An ingest source adapter (PDF, DOCX, Slack, Notion, Email…) |
| **Adapter** | An integration surface for external systems (CMS plugin, widget, SDK consumer) |

**Node = Fly.io Machine** is the core infrastructure abstraction. A shared Node runs multiple tenants on a single shared-cpu Machine; a single Node is a performance Machine running one tenant; multiple Nodes are multiple Machines across regions.

**Shared Node does NOT mean shared database.** Every tenant at every tier has an isolated libSQL database file. The difference between shared and dedicated Nodes is how many tenants share the underlying Fly.io Machine compute resources, not how tenant data is separated.

---

## Database layer: libSQL embedded on Fly Machine

### What we use

Trail uses **libSQL as an embedded library** inside the Trail server process, with database files living on Fly.io volumes. No network hop for queries. No external database service dependency for production traffic.

```
Fly.io Machine (Hobby shared Node)
├── Trail server process (Bun + Hono)
│   └── libSQL client (embedded, in-process)
│       ├── → /data/tenants/sanne.db
│       ├── → /data/tenants/acme.db
│       └── → /data/tenants/foo.db (200 more...)
└── Fly Volume (persistent, attached to this Machine)
    └── /data/tenants/*.db
```

libSQL is SQLite plus targeted improvements: native vector search, WAL enhancements, remote access protocol, encryption at rest, embedded replicas. Fully production-ready — 800K weekly npm downloads, running in production at scale for thousands of companies.

### Disambiguation: three things are called "Turso"

This matters because they have different production readiness:

1. **libSQL** (C fork of SQLite): production-ready, used here. Has all SQLite features (triggers, indexes, views, VACUUM) plus Turso extensions. Stable for years. This is what Trail embeds.

2. **Turso Database** (Rust rewrite, installed via `tur.so/install`): explicitly marked "not ready for production use" in its own GitHub README as of April 2026. Features like triggers, indexes, savepoints, views, and VACUUM are still under development. It is the future of Turso, but not deployable for Trail in Phase 2.

3. **Turso Cloud** (managed service): currently runs libSQL under the hood. Used here only for optional secondary services (off-site backup, optional Enterprise managed database), never for primary query path.

### Why libSQL embedded, not Turso Database yet

Trail's F10 relies heavily on triggers (FTS5 auto-sync on documents/chunks tables). Performance at 100K+ Neurons requires stable indexes on foreign keys and hot paths. Curator analytics (F54) will likely use views. Turso Database's current lack of stable triggers, indexes, and views means Trail can't run on it in production today.

When Turso Database reaches production-ready status (estimated 2027 based on current development pace), migration is designed to be straightforward — the Turso team has committed to file format backwards compatibility. Until then, libSQL is the right choice.

### Why libSQL and not plain SQLite

- Native vector search (matches spreading activation use case per the brain-vs-RAG article)
- Better concurrency story (WAL improvements) than vanilla SQLite
- Remote access protocol available (not used for production, but useful for admin tooling and Business+ tenants who want direct DB access)
- Encryption at rest extension available
- Active development; upgrades flow without architectural changes

### Secondary uses of Turso Cloud (optional)

Turso Cloud is a **secondary/optional service**, used only for specific scenarios:

1. **Emergency off-site backup:** Nightly cron pushes database snapshots from Fly volumes to Turso Cloud. Cheap disaster-recovery insurance; not on query path.

2. **Optional Enterprise managed database:** An Enterprise customer who wants managed SLA can opt for Turso Cloud as their libSQL hosting. Customer-choice, not default.

3. **Future multi-region read replicas:** If a Business+ tenant needs sub-100ms reads in distant regions, Turso Cloud's embedded-replica feature may be the simplest answer. Evaluate when F77 (multi-region) actually has customers driving it.

Default at all tiers for all tenants: **embedded libSQL on Fly Machine volume.** Turso Cloud is a capability ladder we can climb, not a dependency.

### Single-writer concurrency is not a blocker

libSQL inherits SQLite's single-writer-per-database model. Not a problem for Trail:

1. **Each tenant has own database** — writes in tenant A don't block tenant B
2. **Writes in a tenant are inherently sequential** — one curator approving candidates at a time, compile step batched, lint runs scheduled
3. **Reads scale through WAL mode** — many concurrent readers while one writer commits

Edge cases where it could matter:
- F76 (CRDT collab): multiple curators editing same Neuron simultaneously — solve via app-level coordination or wait for Turso Database
- Extreme ingest volumes (10K+ sources/day per tenant): use Postgres for that specific tenant via F84

Neither blocks Phase 2.

### Migration path to Postgres (F84)

If libSQL stops meeting our needs, Postgres migration path via Drizzle abstraction:

**Easy:** Drizzle schema ports with `sqliteTable` → `pgTable` edits. 2-3 days of mechanical work.

**Medium:** FTS5 → `tsvector`, sqlite-vec → pgvector, SQLite idioms → Postgres equivalents. ~1 day.

**Hard:** Per-tenant data migration (1-4 hours per tenant, scriptable and batchable).

**Recommended Postgres strategy: schema-per-tenant on Supabase.** Preserves isolation, works with Drizzle, native pgvector. Migration is scripted per-tenant.

The migration path's existence is what makes libSQL an acceptable bet. If libSQL stops working for us, we have 1-2 months of work to switch, not a full rewrite.

### `@trail/db` abstraction as architecture principle

```typescript
// packages/db/src/interface.ts
export interface TrailDatabase {
  db: DrizzleDatabase;
  close(): Promise<void>;
  health(): Promise<{ok: boolean, latencyMs: number}>;
}

// packages/db/src/libsql-adapter.ts
export function createLibsqlDatabase(tenantId: string): TrailDatabase { ... }

// packages/db/src/postgres-adapter.ts (Phase 3 / emergency)
export function createPostgresDatabase(tenantId: string): TrailDatabase { ... }
```

Every other package consumes `TrailDatabase`, never raw libSQL client. Same pattern as F14 (LLM adapter) and F13 (storage adapter).

---

## Tenant isolation architecture

### What shared means — shared infrastructure, isolated data

On a shared Node, tenants share:
- Same Fly.io Machine (CPU, RAM, network)
- Same Trail server process
- Same volume for database files (with per-tenant paths)
- Same object storage bucket (with per-tenant prefix)

But each tenant has:
- Its own libSQL database file (complete isolation at database level)
- Its own storage prefix
- Its own auth context in every request
- No way to reach other tenants' data through the API

Standard database-per-tenant SaaS pattern. Not "shared database with tenant_id columns" — that's explicitly rejected.

### Request routing

```typescript
app.use(async (c, next) => {
  const tenantId = c.get('auth').tenantId;

  // Open tenant-specific database (libSQL connection opens ~40μs)
  const db = getTenantDatabase(tenantId);

  // Pick tenant's configured storage adapter
  const storage = getTenantStorage(tenantId);

  c.set('db', db);
  c.set('storage', storage);

  await next();
});
```

### What changes at Business tier

Business tier gives the tenant a **dedicated Machine** — not for database isolation (they already have that), but for:

1. Guaranteed CPU and RAM — no noisy-neighbor effects during compile
2. Dedicated volume — per-tenant backup/restore is trivial
3. Higher resource ceiling — Business tenants have large Trails
4. Predictable latency — no resource contention

Upgrade path Pro → Business: copy database file, copy storage prefix, update DNS. Sub-5-minute cutover.

---

## Storage layer: Tigris AND Cloudflare R2, per-tenant choice

**Decision: Both storage providers supported via pluggable adapters, per-tenant configuration.**

Two storage backends are first-class citizens from day one:

- **Tigris** (Fly.io's native object storage) — default for most tenants
- **Cloudflare R2** — available per-tenant, for specific customer needs

Both speak S3-compatible APIs. Tenants can choose which backend to use; tenants can migrate between backends without downtime.

### Why both, not just one

**Data residency.** EU tenants default to Tigris in EU regions; hybrid-cloud strategy may prefer R2.

**Cost optimization.** R2's zero-egress model suits read-heavy tenants. Atypical for Trail (compile at ingest, queries read compiled Neurons) but some tenants will have this profile.

**Vendor redundancy.** Tigris outage → failover to R2 warm standby for Business+ tenants. And vice versa.

**Enterprise procurement.** Customers with existing AWS/Cloudflare relationships prefer R2. Trail supports it without architectural changes.

**Partner flexibility.** Solution Partners building white-label deployments may have storage vendor preferences.

### Adapter architecture

```typescript
// packages/storage/src/interface.ts
export interface Storage {
  put(key: string, data: Buffer, metadata?: Metadata): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  list(prefix: string): AsyncIterable<StorageObject>;
  signUrl(key: string, ttlSeconds: number): Promise<string>;
}

// packages/storage/src/tigris-adapter.ts
export function createTigrisStorage(config: TigrisConfig): Storage { ... }

// packages/storage/src/r2-adapter.ts
export function createR2Storage(config: R2Config): Storage { ... }

// packages/storage/src/local-adapter.ts (dev + single-tenant Fly deploy)
export function createLocalStorage(config: LocalConfig): Storage { ... }

// Tenant configuration selects adapter
// tenant.storage_provider = 'tigris' | 'r2' | 'local'
```

Every Trail handler consumes the `Storage` interface. Switching a tenant from Tigris to R2 is a config flip plus one-time data migration. No application code changes.

### Per-tenant storage migration

When a tenant switches storage providers:

1. Mark tenant as `storage_migrating` (read-only for sources; writes still accepted to libSQL)
2. Background job lists all objects with tenant's prefix on source provider
3. For each object: stream from source → upload to destination with same key
4. Verify counts and checksums
5. Update tenant record with new `storage_provider` and `storage_config`
6. Invalidate old signed URLs
7. Mark tenant as `storage_active`
8. After 30-day grace period, delete from old provider

1-4 hours for typical Starter/Pro tenant. Background job, no user-visible downtime.

### Default selection per tier

| Tier | Default storage | Alternative | Migration allowed |
|------|-----------------|-------------|-------------------|
| Hobby | Tigris | — | No |
| Starter | Tigris | — | No |
| Pro | Tigris | R2 (self-service in settings) | Yes, once per year |
| Business | Customer choice at signup | Either | Yes, as needed |
| Enterprise | Customer choice at contract | Either + custom S3-compatible | Yes, as needed |

### Tigris pricing (April 2026)

- Storage: $0.02/GB/month
- Egress: $0.01/GB (negligible for Trail)
- Operations: per 1000 requests

### R2 pricing (April 2026)

- Storage: $0.015/GB/month
- Egress: $0 (R2's key advantage)
- Operations: Class A $4.50/million, Class B $0.36/million

### Per-tenant storage cost

| Tier | Typical storage | Tigris cost/mo | R2 cost/mo |
|------|-----------------|----------------|------------|
| Hobby | <1GB | €0.02 | €0.02 |
| Starter | 5-20GB | €0.10-0.40 | €0.08-0.30 |
| Pro | 50-200GB | €1-4 | €0.75-3 |
| Business | 200GB-2TB | €4-40 | €3-30 |
| Enterprise | varies | contract | contract |

Storage is not meaningful cost driver at any tier regardless of provider.

### F42 rename and expansion

F42 changes from "Cloudflare R2 Storage Adapter" to **"Pluggable Storage (Tigris + R2 Adapters)"**. Adapter interface (F13) unchanged; ship with two production-ready implementations. Adding S3, B2, MinIO, Wasabi later is drop-in.

---

## Scaling constraints — what actually breaks at scale

Four dimensions scale non-linearly with Neuron count:

**Cross-reference density.** Links grow N^1.3 to N^1.5. At 100K Neurons → 1-5M links. Graph traversal becomes dominant query latency cost if not indexed correctly.

**Compile cascade size.** At 1K Neurons a source touches 5-15 pages. At 100K Neurons, 50-200 pages. Naive recompilation prohibitive. Fix: hierarchical compile (pre-filter → LLM rerank → full recompile). F28 pipeline interface supports this; scaling logic in compile orchestrator.

**Lint pass runtime.** Linear scan at 100K takes hours. Must be incremental and event-driven (F32, F56, F57).

**Query retrieval precision.** Multi-stage retrieval (recall → rerank → synthesize) mandatory at 100K Neurons.

All solvable within single-node architecture. No distributed systems needed until ~500K-1M Neurons per Trail or multi-region SLAs.

---

## Single-Node scaling limits

A tuned single-node Trail (libSQL + FTS5 + HNSW embeddings, multi-stage retrieval, incremental lint, Fly.io performance-4x Machine):

| Metric | Limit | Notes |
|--------|-------|-------|
| Neurons per Trail | ~500K | libSQL graph queries feel pressure |
| Sources per Trail | ~1M | Sources typically smaller |
| Trails per tenant | Unbounded | Each Trail is bounded database |
| Tenants per shared Node | 15-200 | Depends on tier density |
| Queries/day per Node | ~10K | With multi-stage retrieval + caching |
| Active curators per Node | ~100 | libSQL write contention beyond |

Crossing triggers tier upgrades.

---

## Tier architecture

### Hobby · Free · Shared Node

**Infrastructure:** Shared Fly.io Machine (shared-cpu-1x, 1GB RAM). Up to 200 Hobby tenants. Aggressive quotas.

**Limits:**
- 1 Trail per account, 500 Neurons max, 100 sources
- 1K queries/month, 2 connectors (PDF, Markdown)
- No widget, no API beyond MCP, no custom subdomain
- Community support

### Starter · €29/mo · Shared Node

**Infrastructure:** Shared Fly.io Machine (performance-2x, 4GB RAM). Up to 50 Starter tenants. Per-tenant quotas.

**Limits:**
- 3 Trails per account, 5K Neurons/Trail, 2K sources/Trail
- 10K queries/month, 5 connectors (PDF, MD, DOCX, Image, HTML)
- Widget on 1 domain, MCP access
- `<tenant>.trailmem.com` subdomain
- 48h email support

### Pro · €149/mo · Shared Node (Premium Pooling)

**Infrastructure:** Shared Fly.io Machine (performance-4x, 8GB RAM). Up to 15 Pro tenants. Reserved CPU per tenant.

**Limits:**
- 10 Trails per account, 25K Neurons/Trail, 10K sources/Trail
- 50K queries/month, 8 connectors (all Phase 1+2 except Slack/Notion)
- Widget on 5 domains + customization
- API (100 req/min), custom subdomain
- Reader feedback, priority 24h support

### Business · €499/mo · Single Node

**Infrastructure:** Dedicated Fly.io Machine (performance-8x, 16GB RAM). One tenant. Dedicated volume.

**Limits:**
- Unlimited Trails, 100K Neurons/Trail, 50K sources/Trail
- 500K queries/month, all connectors including Slack/Notion
- Unlimited widget domains, full API
- Custom subdomain + CNAME
- F54 analytics, F56 freshness scoring, F57 gap suggestions
- Dedicated Slack support, 99.5% SLA

### Enterprise · Contract · Multiple Nodes

**Two pricing models — customer chooses:**

**Model A: Flat contract** (€25K-150K/year)
- Predictable annual pricing, bundle of Machines + support + compliance
- For procurement-driven buyers

**Model B: Usage-based metered** (€2-5K/month base + metered)
- Per-Neuron: €0.0005/Neuron/month over 100K
- Per-query: €0.001/query over 1M/month
- Per-source ingest: €0.10/source compile
- Storage: €0.03/GB/month over 500GB
- For fast-growing customers

**Both include:**
- Multiple dedicated Machines (one per Trail or per region)
- Multi-region deployment (F77)
- SSO: SAML 2.0 + SCIM (F70)
- Audit logs + retention (F71)
- Per-KB encryption with customer keys (F81)
- On-prem Docker/Helm option (F72)
- Custom LLM adapters (F82)
- SOC 2 Type II (F73)
- Dedicated CSM, 24/7 named support
- Custom SLA (99.9% or 99.95%)
- Custom adapter development support

**When to recommend:**
- Flat: regulated industries, procurement-heavy, predictable volume
- Metered: startups, unpredictable volume, cost-conscious

Metered aligns incentives — Broberg.ai earns more when tenant uses Trail more.

---

## Pricing summary

| Tier | Price/mo | Credits/mo (F156) | Trails | Neurons/Trail | Sources/Trail | Queries/mo | Connectors | Node shape |
|------|----------|------:|--------|---------------|---------------|------------|------------|------------|
| **Hobby** | Free | 5 | 1 | 500 | 100 | 1K | 2 | Shared |
| **Starter** | €29 | 20 | 3 | 5K | 2K | 10K | 5 | Shared |
| **Pro** | €149 | 100 | 10 | 25K | 10K | 50K | 8 | Shared (premium) |
| **Business** | €499 | 500 | ∞ | 100K | 50K | 500K | All | Single dedicated |
| **Enterprise (flat)** | €25K-150K/yr | contract | ∞ | ∞ | ∞ | ∞ | All + custom | Multiple |
| **Enterprise (metered)** | €2-5K/mo + usage | metered | ∞ | metered | metered | metered | All + custom | Multiple |

**Annual discount:** 2 months free (17%) at Starter/Pro/Business.

**Credits = LLM-forbrug.** Hver tier inkluderer en månedlig grundkvote credits. Forbrug ud over baseline → tenant køber credit-pakker (10/20/50/100/200 credits, €0.30-0.50 per credit). En credit ≈ $0.10 LLM-cost. Model-valget bestemmer credit-burn-rate: Flash 1× / GLM 2× / Qwen 3× / Sonnet 10×. Se [F156 plan-doc](./features/F156-credits-based-llm-metering.md) for fuldt design.

---

## Infrastructure cost basis

### Fly.io compute

| Machine class | Cost/mo | Tenants typical |
|---------------|---------|------------------|
| shared-cpu-1x 1GB | ~€4 | 200 |
| performance-2x 4GB | ~€45 | 50 |
| performance-4x 8GB | ~€90 | 15 |
| performance-8x 16GB | ~€180 | 1 |
| performance-16x 32GB | ~€360 | 1 per region |

### LLM costs (Anthropic API)

| Operation | Cost per unit |
|-----------|---------------|
| Compile new source (avg PDF, 10 pages) | €0.15-0.40 |
| Compile cascade update (1 affected page) | €0.02-0.08 |
| Vision description per image | €0.003-0.01 |
| Query synthesis | €0.01-0.04 |
| Lint scan per Neuron | €0.001-0.003 |

### Monthly LLM cost per tier (typical, post-F156)

LLM-omkostninger splittes nu i to: hvad **vi** absorberer (lint, queries, glossary, translation — baggrunds-ydelser inkluderet i abonnementet) og hvad **tenant** betaler via credits (compile/ingest af kilder).

| Tier | Vores andel (lint + queries + glossary) | Tenant via credits (compile) | Net cost for os |
|------|------|------|------|
| Hobby | €1 | €1 (baseline kvote) | €2 |
| Starter | €5 | €2 (baseline) + 0-30 ekstra/mdr | €5 |
| Pro | €25 | €10 (baseline) + 30-200 ekstra/mdr | €25 |
| Business | €120 | €50 (baseline) + 100-1000 ekstra/mdr | €120 |
| Enterprise | variable | metered | variable |

Credit-pakke-revenue (markup over rene LLM-cost) lander oven på subscription. Pro-tenant der køber 200 ekstra credits/mdr (€60) vs cost €0.10/credit × 200 = €20 → **€40 ren credit-margin per måned ud over subscription**.

### Gross margin (post-F156, kalibreret 2026-04-25)

| Tier | Effective GM% | Kommentar |
|------|---------------|-----------|
| Hobby | loss leader | Acquisition cost; 5 credits er net-kost ~€0.50/mdr |
| Starter | 75-82% | Højere end pre-F156 (45-55%) fordi tenant betaler eget compile-overforbrug |
| Pro | 80-85% | Credit-pakke-margin øger top-line på heavy-users |
| Business | 82-88% | Stort baseline + stort credit-køb = højeste margin |
| Enterprise (flat) | 70-80% | Forhandlet kontrakt-credits; lavere markup men stort volumen |
| Enterprise (metered) | 75-85% | Direkte spejling af forbrug + markup |

---

## Connectors — tier gating

| Connector | F# | Hobby | Starter | Pro | Business | Enterprise |
|-----------|-----|-------|---------|-----|----------|------------|
| Markdown | F09 | ✓ | ✓ | ✓ | ✓ | ✓ |
| PDF + Vision | F08 | ✓ | ✓ | ✓ | ✓ | ✓ |
| DOCX | F24 | — | ✓ | ✓ | ✓ | ✓ |
| Image | F25 | — | ✓ | ✓ | ✓ | ✓ |
| HTML / Web clipper | F26 | — | ✓ | ✓ | ✓ | ✓ |
| Video | F46 | — | — | ✓ | ✓ | ✓ |
| Audio | F47 | — | — | ✓ | ✓ | ✓ |
| Email | F48 | — | — | ✓ | ✓ | ✓ |
| Slack | F49 | — | — | — | ✓ | ✓ |
| Notion | F60 | — | — | — | ✓ | ✓ |
| Browser extension | F50 | — | — | ✓ | ✓ | ✓ |
| Custom adapters (SDK) | F55 | — | — | — | ✓ | ✓ |
| On-prem connectors | — | — | — | — | — | ✓ |

## Adapters — tier gating

| Adapter | F# | Hobby | Starter | Pro | Business | Enterprise |
|---------|-----|-------|---------|-----|----------|------------|
| MCP stdio | F11 | ✓ | ✓ | ✓ | ✓ | ✓ |
| `<trail-chat>` widget | F29 | — | 1 dom | 5 dom | ∞ | ∞ |
| Widget customization | F51 | — | — | ✓ | ✓ | ✓ |
| Reader feedback | F31 | — | — | ✓ | ✓ | ✓ |
| REST API | — | read | read | full | full | full |
| `@webhouse/cms` | F45 | — | — | ✓ | ✓ | ✓ |
| WordPress | F58 | — | — | ✓ | ✓ | ✓ |
| Sanity | F59 | — | — | — | ✓ | ✓ |
| Notion | F60 | — | — | — | ✓ | ✓ |

---

## Upgrade paths

### Starter → Pro

Database: update plan record, refresh quotas. No migration.
Infrastructure: possibly moved to Pro-class Machine at density limit. Sub-minute, transparent.

### Pro → Business

Database: quotas uncapped. Schema unchanged.
Infrastructure: provision performance-8x, snapshot DB from shared Machine, restore to dedicated, DNS cutover. 5-15 minutes, brief read-only window.

### Business → Enterprise

Database: optionally libSQL (multi-region replicas via Turso Cloud opt-in) or Postgres (F84).
Infrastructure: multiple Machines per region, cross-region replication, customer-specific adapters. 1-4 weeks.

---

## Partner program

### Integration Partner
- Adapter SDK (F55) to build integrations with own products
- Examples: `@webhouse/cms` (F45), WordPress (F58), Sanity (F59), Notion (F60)
- No revenue share; co-marketing on integration ship

### Reseller Partner
- Sells Starter/Pro/Business tiers to customer base
- 20% margin on resold tiers
- Must bundle with own services
- Volume discounts after 10+ active customers
- First: `@webhouse/cms` bundling Trail as content-intelligence layer

### Solution Partner
- White-label Trail under partner's brand
- Custom instance on dedicated infrastructure
- 30% revenue share or flat licensing (partner chooses)
- Minimum €50K/year commitment
- Target: agencies, SIs, vertical SaaS

### Certified Implementer
- Trained individual consultants or small agencies
- No reseller share; lead referrals from Broberg.ai
- Badge + directory listing
- Quarterly roadmap preview
- Target: Sanne's healthcare IT peers, small Danish consultancies

### Why `@webhouse/cms` is reference partner

Three strategic functions:
1. Technical reference implementation for Adapter SDK (F55)
2. Revenue channel — every `@webhouse/cms` site is Trail tenant candidate
3. Dogfood case study — Christian's agency using both proves integration

Other agencies on `@webhouse/cms` get Trail integration free as part of CMS stack. Natural pull from their customers to upgrade Trail usage.

### Partner launch timing

- **Phase 2 early:** Integration Partner opens with `@webhouse/cms` reference (M4-6)
- **Phase 2 late:** Reseller opens with WebHouse ApS first (M7-9)
- **Phase 3:** Solution Partner with Enterprise launch (M10-12)
- **Year 2:** Certified Implementer first cohort

---

## Regional strategy

| Tier | Primary region | Additional |
|------|----------------|-----------|
| Hobby | arn (Stockholm) | — |
| Starter | arn | — |
| Pro | arn | opt-in lhr/fra +€30/mo |
| Business | customer choice | 1 included, extra +€80/mo |
| Enterprise | any | any, priced per region |

Default arn satisfies most EU data-residency.

---

## Usage metering (F44)

Meter per tenant:
1. **Neuron count** per Trail (hard cap at compile-time)
2. **Source count** per Trail (hard cap at upload)
3. **Query count** per month (soft cap → warning → hard cap 120%)
4. **Storage bytes** (soft cap with email)
5. **LLM tokens** (for Enterprise metered billing)

**Soft cap behavior:**
- 80% query cap: in-app banner
- 100%: email + 10% rate limit
- 120%: block, one-click upgrade

**Hard cap behavior:**
- Neuron/source: block compile/upload, show upgrade prompt
- Query: return 429 with upgrade URL

---

## Unit economics projection

| Period | Hobby | Starter | Pro | Business | Ent | MRR | ARR |
|--------|-------|---------|-----|----------|-----|-----|-----|
| Y1 Q1 | 50 | 5 | 1 | 0 | 0 | €294 | €3,528 |
| Y1 Q2 | 150 | 20 | 4 | 1 | 0 | €1,675 | €20,100 |
| Y1 Q3 | 300 | 40 | 8 | 3 | 1 incoming | €3,850 | €46,200 |
| Y1 Q4 | 500 | 60 | 15 | 5 | 1 | €8,464 | €101,568 |
| Y2 Q2 | 1200 | 150 | 40 | 15 | 3 | €24,700 | €296,400 |
| Y2 Q4 | 2500 | 300 | 80 | 35 | 8 | €56,945 | €683,340 |

**Target: €500K ARR by end Y2.** Achievable with organic growth, modest assumptions. Faster if HN post catches, `@webhouse/cms` brings customers, Enterprise closes.

Partner program adds leverage: single Reseller with 10+ customers = €300-1500 MRR at zero CAC.

---

## Risk analysis

**LLM cost rise.** If Sonnet 4 +20%, Pro/Business margins tighten. Mitigation: F14 multi-provider swap (Sonnet/Opus/Haiku mix), F82 (Azure/Bedrock/Ollama).

**libSQL stagnates or Turso pivots.** libSQL is open source; self-host continues. Worst case: Postgres migration via F84, 1-2 months given Drizzle abstraction. Not blocking.

**Pricing validation fails.** Sanne feedback says €29 too expensive → drop Starter to €19, raise Pro to €199. Don't touch Business.

**Competitor launches compile-time.** Mitigation: Trail's moat is architecture (event-sourcing, provenance, curator queue, adapter ecosystem, partner program), not feature list.

---

## Launch sequence

Phase 1 completes before any paid tier. Critical path:

1. **F17 + F18 + F33** → Sanne single-tenant (F37)
2. **F40** (multi-tenancy, libSQL per-tenant) → unlocks SaaS
3. **F41 + F42** (Tigris + R2 adapters) → Hobby/Starter signup
4. **F43 + F44** → Pro/Business paid conversion
5. **F45 + F52** → Business tier + first Reseller Partner (WebHouse)
6. **F70-F73, F81** → Enterprise tier

### Timeline

- **M1-3:** Phase 1, Sanne on Fly single-tenant
- **M4-6:** F40-F44, Hobby+Starter public, Pro by invite, Integration Partner opens
- **M7-9:** F45+F52, Business tier, Reseller Partner opens
- **M10-12:** F70-F73+F81, Enterprise motion, Solution Partner opens
- **Year 2:** SOC 2 certified, Enterprise launch, Certified Implementer opens

---

## Decisions locked

1. **F40 multi-tenancy:** libSQL embedded on Fly Machine per-tenant. Not Turso Database yet, not Turso Cloud as primary.
2. **F42 storage:** Tigris default + R2 alternative, per-tenant choice via adapter abstraction.
3. **Database abstraction:** `@trail/db` package exposes `TrailDatabase` interface. libSQL default, Postgres as Phase 3 / emergency path.
4. **Storage abstraction:** `@trail/storage` package exposes `Storage` interface. Tigris + R2 + Local adapters ship together.
5. **Enterprise pricing:** Both flat contract and usage-metered, customer chooses.
6. **Partner program:** Four tiers (Integration, Reseller, Solution, Certified). `@webhouse/cms` is reference Integration Partner and first Reseller.

## Decisions still owed

1. **Currency:** EUR primary vs USD vs dual-display. Recommend EUR primary with USD shown for international.
2. **Annual discount:** 17% vs 20%. Pick one, lock.
3. **Hobby limits:** 500 Neurons aggressive vs 1000 Neurons but no MCP. Pick based on signal value.
4. **Enterprise floor (flat):** €25K vs €30K vs €50K. Recommend €30K.
5. **Custom domain:** Recommend Pro=`<tenant>.trailmem.com`, Business=CNAME, Enterprise=wildcard.
6. **Reseller margin:** 20% default. Could be 25-30% for volume or Solution Partners.

---

## Appendix: implementation notes for cc

- **F17 (Queue API):** Pagination, filter by candidate_kind, impact×confidence sort. Needed at 100+ candidates.
- **F19 (Auto-approval):** Stateless, unit-testable. Policy changes without DB migrations.
- **F28 (Pipeline interface):** Pipelines emit candidates, never write wiki directly. Enforces queue invariant.
- **F32 (Lint):** Incremental, event-driven from day 1. No full scans at 100K+.
- **F40 (Multi-tenancy):** libSQL embedded per-tenant via `@trail/db`. No Turso Cloud specifics (multi-DB attach, embedded replicas) in query path.
- **F42 (Storage):** `@trail/storage` package ships with Tigris + R2 + Local adapters. Tenant config selects. AWS S3 SDK with provider-specific endpoint.
- **F43 (Stripe):** Plans reference tier limits from this doc. Plan changes propagate without deploy.
- **F44 (Metering):** Count Neurons, sources, queries, storage, LLM tokens per tenant per day. Aggregate monthly for billing; daily for dashboards. Required for Enterprise metered.
- **F55 (Adapter SDK):** Design assumes partner-built adapters. `@webhouse/cms` is reference. SDK sufficient for WordPress, Sanity, Notion without core engine changes.
- **F77 (Multi-region):** Business+ upsell, not default. Most tenants single-region.

Every F-feature runs under all five tiers. Tier-specific behavior is policy, not architecture.
