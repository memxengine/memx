# F79 — Scheduled Wiki Re-Compilation

> Every 90 days, re-compile each wiki page from its backing sources. Better models in the future catch nuances older compiles missed. Produces `scheduled_recompile` candidates.

## Problem

Når Trail compiler en Neuron i dag, er resultatet låst indtil næste source upload. Men LLM-modeller bliver bedre over tid, og kilder kan opdateres uden at der uploades en ny fil (f.eks. web-sources). En Neuron compileret med Claude Haiku i januar kan være væsentligt forbedret hvis den re-compiles med Sonnet i april.

Uden scheduled re-compilation akkumuleres "teknisk gæld" i wiki'en: gamle compiles med ældre modeller, manglende nuancer, og forældede formuleringer.

## Solution

En cron job der kører hver N dage (default: 90) og:
1. Finder alle Neurons der ikke er re-compileret i N dage
2. For hver Neuron: henter de originale sources
3. Re-compiler med current LLM model
4. Opretter en queue candidate med diff (F20) for curator review
5. Curatoren godkender/afviser den opdaterede version

## Technical Design

### 1. Recompile Scheduler

```typescript
// apps/server/src/services/recompile-scheduler.ts

import { documents, documentReferences } from '@trail/db';
import { and, eq, isNull, lt } from 'drizzle-orm';
import { runIngest } from '@trail/core';

const RECOMPILE_INTERVAL_DAYS = Number(process.env.TRAIL_RECOMPILE_INTERVAL_DAYS ?? 90);

export function startRecompileScheduler(trail: TrailDatabase): void {
  console.log(`[recompile] scheduler started — interval: ${RECOMPILE_INTERVAL_DAYS} days`);

  // Run immediately on boot, then on schedule
  runRecompilePass(trail);

  setInterval(() => runRecompilePass(trail), RECOMPILE_INTERVAL_DAYS * 24 * 60 * 60 * 1000);
}

async function runRecompilePass(trail: TrailDatabase): Promise<void> {
  const cutoff = new Date(Date.now() - RECOMPILE_INTERVAL_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // Find neurons not recompiled since cutoff
  const staleNeurons = await trail.db
    .select()
    .from(documents)
    .where(and(
      eq(documents.kind, 'wiki'),
      isNull(documents.archived),
      lt(documents.updatedAt, cutoff),
    ))
    .all();

  console.log(`[recompile] found ${staleNeurons.length} neurons to recompile`);

  for (const neuron of staleNeurons) {
    try {
      // Get source documents for this neuron
      const sourceRefs = await trail.db
        .select({ sourceDocumentId: documentReferences.sourceDocumentId })
        .from(documentReferences)
        .where(eq(documentReferences.targetDocumentId, neuron.id))
        .all();

      if (sourceRefs.length === 0) continue; // No sources to recompile from

      // Create recompile candidate
      await trail.db.insert(queueCandidates).values({
        id: crypto.randomUUID(),
        tenantId: neuron.tenantId,
        knowledgeBaseId: neuron.knowledgeBaseId,
        kind: 'scheduled_recompile',
        status: 'pending',
        neuronId: neuron.id,
        title: `Re-compile: ${neuron.title}`,
        body: `This Neuron was last compiled on ${neuron.updatedAt}. Re-compiling from ${sourceRefs.length} source(s) with current model.`,
        actions: JSON.stringify([
          { id: 'approve', label: 'Approve updated version', effect: 'approve' },
          { id: 'reject', label: 'Keep current version', effect: 'reject' },
          { id: 'edit', label: 'Edit before approving', effect: 'edit' },
        ]),
        metadata: JSON.stringify({
          connector: 'lint',
          lastCompiledAt: neuron.updatedAt,
          sourceCount: sourceRefs.length,
          sourceIds: sourceRefs.map((r) => r.sourceDocumentId),
          scheduledAt: new Date().toISOString(),
        }),
        autoApproved: false,
      }).run();

      // Trigger re-ingest (will create new candidate with updated content)
      for (const ref of sourceRefs) {
        runIngest({
          trail,
          docId: ref.sourceDocumentId,
          kbId: neuron.knowledgeBaseId,
          tenantId: neuron.tenantId,
          userId: neuron.userId,
          forceRecompile: true,
        });
      }
    } catch (err) {
      console.error(`[recompile] failed for neuron ${neuron.id}:`, err);
    }
  }
}
```

### 2. Force Recompile Flag

```typescript
// packages/core/src/ingest/trigger.ts

export interface IngestParams {
  // ... existing fields ...
  /** Force recompile even if content hasn't changed */
  forceRecompile?: boolean;
}

// In the ingest logic:
if (params.forceRecompile) {
  // Skip the "content unchanged" check and always recompile
  await compileSource(source, wikiState, { forceRecompile: true });
}
```

### 3. Per-KB Recompile Config

```typescript
// packages/db/src/schema.ts — extend knowledge_bases

recompileIntervalDays: integer('recompile_interval_days').default(90),
lastRecompileAt: text('last_recompile_at'),
```

## Impact Analysis

### Files created (new)
- `apps/server/src/services/recompile-scheduler.ts` — scheduled recompile job

### Files modified
- `apps/server/src/app.ts` — start recompile scheduler on boot
- `packages/core/src/ingest/trigger.ts` — add forceRecompile flag
- `packages/db/src/schema.ts` — per-KB recompile config

### Downstream dependents for modified files

All modifications are additive.

### Blast radius
- Recompile triggers ingest for ALL stale neurons — can be expensive for large KBs
- Each recompile creates a queue candidate — queue can fill up quickly
- Rate limiting needed: max N recompiles per hour per KB
- LLM cost: each recompile costs API tokens — should be tracked in usage metering (F44)

### Breaking changes
None.

### Test plan
- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Unit: Scheduler finds neurons older than interval
- [ ] Unit: Force recompile flag skips "unchanged" check
- [ ] Integration: Recompile pass creates queue candidates
- [ ] Integration: Curator approves recompiled version → neuron updated
- [ ] Integration: Curator rejects → original version preserved
- [ ] Regression: Normal ingest flow unchanged

## Implementation Steps

1. Create recompile scheduler with cron job
2. Add forceRecompile flag to ingest trigger
3. Add per-KB recompile config to schema
4. Integration test: scheduled recompile → candidate → approve → updated neuron
5. Add rate limiting for recompile batches
6. Test with large KB (100+ neurons)

## Dependencies

- F32 (Lint Pass) — recompile is a lint-triggered action
- F20 (Curator Diff UI) — curator reviews diff between old and recompiled version
- F44 (Usage Metering) — recompile costs should be tracked

## Effort Estimate

**Small** — 1-2 days

- Day 1: Recompile scheduler + force recompile flag
- Day 2: Per-KB config + integration testing + rate limiting
