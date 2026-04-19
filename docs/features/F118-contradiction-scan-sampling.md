# F118 — Contradiction-Scan Sampling

*Planned. Tier: core/infra. Effort: 1-2 days.*

> Scheduled contradiction-lint scanner ikke alle Neurons hver 24h (som bryder ved N > 8k) — i stedet scannes en delmængde hver pass, og Neurons tourer rundt over tid via `last_contradiction_scan_at`-kolonnen. Detaljeret i SCALING-ANALYSIS.md § 6.

## Problem

Current contradiction-lint-scheduler i `services/lint-scheduler.ts` iterer ALLE ready Neurons sekventielt per KB. Ved 10s/Neuron × N Neurons overstiger total tid 24h-cyklus ved N ≈ 8k. Vi rammer arkitektonisk mur — se SCALING-ANALYSIS.md Del II.

## Solution

Schema-migration:

```sql
ALTER TABLE documents ADD COLUMN last_contradiction_scan_at TEXT;
```

Scheduler læser:

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

## How

- Migration tilføjer kolonne (NULL default)
- `lint-scheduler.ts` skifter fra `.all()` til `.limit(sampleSize)` med explicit ordering
- Sample-size læses fra `tenants` / `knowledge_bases` plan-config (se F122)
- Scheduled-pass kan nu køre i forudsigelig tid uanset N

## Dependencies

- F122 (plan limits på tenants table styrer sample-size)
- F119 (parallelism runner øger throughput inden for pass)

## Success criteria

- Ved N = 100k Neurons × 2.000 sample = pass tager ~5-6 t sekventielt (acceptabelt)
- Dækningsvindue = N / sampleSize dage — alle Neurons nås inden for SLA
- Admin Settings viser "Næste fuld-dækning: 42 dage" baseret på aktuelt sample-rate
