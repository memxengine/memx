# F118 — Contradiction-Scan Sampling

> Tier: core/infra. Effort: 1-2 days. Planned.

## Problem

Current contradiction-lint-scheduler i `services/lint-scheduler.ts` iterer ALLE ready Neurons sekventielt per KB. Ved 10s/Neuron × N Neurons overstiger total tid 24h-cyklus ved N ≈ 8k. Vi rammer arkitektonisk mur — se SCALING-ANALYSIS.md Del II.

## Secondary Pain Points

- No visibility into when a Neuron was last scanned for contradictions
- Tenants on lower tiers waste resources scanning KBs they rarely use
- No way to prioritize recently-edited Neurons over stale ones

## Solution

Schema-migration: `ALTER TABLE documents ADD COLUMN last_contradiction_scan_at TEXT`. Scheduler læser:

```sql
SELECT id FROM documents
WHERE kind='wiki' AND archived=false
ORDER BY last_contradiction_scan_at ASC NULLS FIRST
LIMIT ? -- sample-size baseret på tier + kb-config
```

Efter hver scan → `UPDATE documents SET last_contradiction_scan_at = NOW() WHERE id = ?`. "NULLS FIRST" sikrer nye/aldrig-scannede Neurons kommer forrest.

Sample-size per tier (jf. PRICING-PLAN.md):

| Tier | Sample/pass | Hyppighed |
|---|---:|---|
| Starter | 0 | manuel via "Run lint"-knap |
| Pro | 500 | ugentlig |
| Pro + daily-sampling tilkøb | 2.000 | daglig |
| Business | 2.000 | daglig |
| Enterprise | custom | custom |

## Non-Goals

- Priority-based sampling (recently-edited first) — simple round-robin via NULLS FIRST
- Per-Neuron scan frequency configuration (tier-level only)
- Real-time sampling adjustment mid-pass
- Sampling for other lint types (orphans, stale) — contradiction only

## Technical Design

### Schema Migration

```sql
ALTER TABLE documents ADD COLUMN last_contradiction_scan_at TEXT;
```

### Scheduler Query Change

```typescript
// apps/server/src/services/lint-scheduler.ts
// Before: .all() → iterates ALL documents
// After:
const sampleSize = getSampleSizeForTenant(tenant);
const docs = await db.all(
  `SELECT id FROM documents
   WHERE kind='wiki' AND archived=false
   ORDER BY last_contradiction_scan_at ASC NULLS FIRST
   LIMIT ?`,
  [sampleSize]
);

// After scan:
await db.run(
  `UPDATE documents SET last_contradiction_scan_at = ? WHERE id = ?`,
  [new Date().toISOString(), docId]
);
```

### Sample Size Resolution

Sample-size læses fra `tenants` / `knowledge_bases` plan-config (se F122):

```typescript
function getSampleSizeForTenant(tenant: Tenant): number {
  return tenant.sampling_size; // from F122 columns
}
```

## Interface

```typescript
// GET /api/v1/settings/lint/sampling → SamplingConfig
interface SamplingConfig {
  sampleSize: number;
  frequency: 'off' | 'manual' | 'weekly' | 'daily';
  nextFullCoverageDate: string; // estimated when all Neurons will have been scanned
  lastScanAt?: string;
}
```

## Rollout

**Single-phase deploy.** Migration is additive (NULL default). Existing scans continue to work — they just don't update the new column until the new scheduler code ships. Deploy migration + scheduler update in same PR.

## Success Criteria

- Ved N = 100k Neurons × 2.000 sample = pass tager ~5-6 t sekventielt (acceptabelt)
- Dækningsvindue = N / sampleSize dage — alle Neurons nås inden for SLA
- Admin Settings viser "Næste fuld-dækning: 42 dage" baseret på aktuelt sample-rate

## Impact Analysis

### Files created (new)
- None

### Files modified
- `packages/db/src/schema.ts` (add `last_contradiction_scan_at` column)
- `apps/server/src/services/lint-scheduler.ts` (change from `.all()` to `.limit()` with ordering)
- `apps/server/src/routes/lint.ts` (add sampling config endpoint)
- `apps/server/src/app.ts` (no change — lint route already mounted)

### Downstream dependents
`packages/db/src/schema.ts` is imported by 1 file:
- `packages/core/src/kb/resolve.ts` (1 ref) — reads document schema, unaffected by additive column

`apps/server/src/services/lint-scheduler.ts` is imported by 4 files:
- `apps/server/src/index.ts` (1 ref) — starts lint scheduler, unaffected
- `apps/server/src/services/access-tracker.ts` (1 ref) — references lint-scheduler types, unaffected
- `apps/server/src/services/access-rollup.ts` (1 ref) — references lint-scheduler types, unaffected
- `apps/server/src/services/lint-scheduler.ts` (12 self-refs) — internal, needs update

`apps/server/src/routes/lint.ts` is imported by 1 file:
- `apps/server/src/app.ts` (1 ref) — mounts route, unaffected

### Blast radius

- Existing contradiction scans that ran before migration will have NULL `last_contradiction_scan_at` — they will be prioritized (NULLS FIRST)
- Sample size change from "all" to "N" means some Neurons won't be scanned each pass — acceptable per design
- If sample_size is 0 (Starter tier), scheduled scans do nothing — manual "Run lint" still works
- Admin UI must show coverage estimate so users understand why their Neuron hasn't been scanned yet

### Breaking changes

None — all changes are additive.

### Test plan

- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Migration adds `last_contradiction_scan_at` column (nullable)
- [ ] Scheduler with sample_size=500 scans exactly 500 Neurons per pass
- [ ] NULLS FIRST ordering ensures new Neurons scanned before old ones
- [ ] After scan, `last_contradiction_scan_at` is updated for scanned Neurons
- [ ] Starter tier (sample_size=0) scheduled scan does nothing
- [ ] Admin Settings shows correct "next full coverage" estimate
- [ ] Regression: existing contradiction detection logic unchanged
- [ ] Regression: manual "Run lint" still scans all specified Neurons

## Implementation Steps

1. Add `last_contradiction_scan_at TEXT` column migration to `packages/db/src/schema.ts`.
2. Update `lint-scheduler.ts` to use `ORDER BY last_contradiction_scan_at ASC NULLS FIRST LIMIT ?` instead of `.all()`.
3. Add `UPDATE documents SET last_contradiction_scan_at = ?` after each scan.
4. Read sample_size from tenant config (F122 columns).
5. Add `GET /api/v1/settings/lint/sampling` endpoint in `routes/lint.ts`.
6. Add "Næste fuld-dækning" calculation to admin Settings UI.

## Dependencies

- F122 (plan limits på tenants table styrer sample-size)
- F119 (parallelism runner øger throughput inden for pass)

## Open Questions

None — all decisions made.

## Related Features

- **F122** (Plan Limits on Tenants) — provides `sampling_size` and `sampling_frequency` columns
- **F119** (Parallel Contradiction Runner) — increases throughput within each sampling pass
- **F113** (Auto-fix in Lint) — auto-fix must respect sampling budget

## Effort Estimate

**Small** — 1-2 days.
- Day 1: Migration + scheduler query change
- Day 2: Settings endpoint + UI coverage estimate
