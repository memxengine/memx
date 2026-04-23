# F21 — Ingest Backpressure

> Per-KB candidate-per-hour rate limit. Overskydende candidates enters `pending_ingestion` state og trickler ind som ældre ones resolves. Forhindrer panic når en 400-siders PDF eller 65-file batch lander.

## Problem

Når en bruger uploader mange kilder på én gang (f.eks. Sanne's 15 års kliniske materiale, eller en 400-siders PDF), trigger hver kilde sin egen ingest pipeline. Med 65 filer der hver tager 60-100 sekunder at compile, står der 65+ Claude Code subprocesser i kø — serveren bliver overbelastet, memory stiger, og curatoren ser "ready" på dokument #65 mens dets compile stadig er 30 minutter væk.

Uden backpressure:
- Server memory kan løbe tør (hver ingest subprocess bruger ~200MB)
- Claude API rate limits kan ramme (hvis API backend bruges)
- Curatoren får misleading status ("ready" men compile er ikke færdig)
- Queue bliver fyldt med hundredvis af pending candidates

## Solution

En per-KB rate limiter der begrænser antallet af aktive ingests til N pr. time (default: 10). Når grænsen er nået, sættes nye candidates i `pending_ingestion` status. En scheduler checker hvert minut om der er kapacitet og promoverer `pending_ingestion` → `pending` → trigger ingest.

## Technical Design

### 1. Backpressure Config

```typescript
// packages/shared/src/backpressure.ts

export interface BackpressureConfig {
  /** Max concurrent ingests per KB (default: 10) */
  maxConcurrentPerKb: number;
  /** Max ingests per hour per KB (default: 20) */
  maxPerHourPerKb: number;
  /** Status for candidates waiting for backpressure */
  pendingIngestionStatus: 'pending_ingestion';
}

export const DEFAULT_BACKPRESSURE: BackpressureConfig = {
  maxConcurrentPerKb: 10,
  maxPerHourPerKb: 20,
  pendingIngestionStatus: 'pending_ingestion',
};
```

### 2. Backpressure Check

```typescript
// packages/core/src/ingest/backpressure.ts

import { documents, queueCandidates } from '@trail/db';
import { and, eq, inArray, gt, count } from 'drizzle-orm';

export async function checkBackpressure(
  trail: TrailDatabase,
  kbId: string,
  config: BackpressureConfig = DEFAULT_BACKPRESSURE,
): Promise<{ allowed: boolean; reason?: string }> {
  // Check concurrent ingests
  const activeIngests = await trail.db
    .select({ count: count() })
    .from(documents)
    .where(and(
      eq(documents.knowledgeBaseId, kbId),
      eq(documents.status, 'processing'),
    ))
    .get();

  if ((activeIngests?.count ?? 0) >= config.maxConcurrentPerKb) {
    return { allowed: false, reason: `Max ${config.maxConcurrentPerKb} concurrent ingests reached for this KB` };
  }

  // Check hourly rate
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const hourlyIngests = await trail.db
    .select({ count: count() })
    .from(documents)
    .where(and(
      eq(documents.knowledgeBaseId, kbId),
      eq(documents.status, 'ready'),
      gt(documents.updatedAt, hourAgo),
    ))
    .get();

  if ((hourlyIngests?.count ?? 0) >= config.maxPerHourPerKb) {
    return { allowed: false, reason: `Max ${config.maxPerHourPerKb} ingests per hour reached for this KB` };
  }

  return { allowed: true };
}
```

### 3. Apply Backpressure on Ingest Trigger

```typescript
// apps/server/src/services/ingest.ts — modify triggerIngest

import { checkBackpressure } from '@trail/core';

export async function triggerIngest(params: IngestParams): Promise<void> {
  const { trail, docId, kbId, tenantId, userId } = params;

  // Check backpressure
  const bp = await checkBackpressure(trail, kbId);
  if (!bp.allowed) {
    // Put document in pending_ingestion state
    await trail.db
      .update(documents)
      .set({ status: 'pending_ingestion' })
      .where(eq(documents.id, docId))
      .run();

    console.log(`[ingest] backpressure: ${docId} queued for ${kbId} — ${bp.reason}`);
    return;
  }

  // Normal ingest flow
  // ... existing code ...
}
```

### 4. Backpressure Scheduler

```typescript
// apps/server/src/services/backpressure-scheduler.ts

import { documents } from '@trail/db';
import { and, eq, orderBy, limit, asc } from 'drizzle-orm';
import { checkBackpressure, triggerIngest } from '@trail/core';

const BACKPRESSURE_CHECK_INTERVAL_MS = 60_000; // 1 minute

export function startBackpressureScheduler(trail: TrailDatabase): void {
  console.log('[backpressure] scheduler started');

  setInterval(async () => {
    try {
      // Get all KBs with pending_ingestion documents
      const kbs = await trail.db
        .select({ kbId: documents.knowledgeBaseId })
        .from(documents)
        .where(eq(documents.status, 'pending_ingestion'))
        .groupBy(documents.knowledgeBaseId);

      for (const { kbId } of kbs) {
        const bp = await checkBackpressure(trail, kbId);
        if (bp.allowed) {
          // Promote oldest pending_ingestion document
          const next = await trail.db
            .select()
            .from(documents)
            .where(and(
              eq(documents.knowledgeBaseId, kbId),
              eq(documents.status, 'pending_ingestion'),
            ))
            .orderBy(asc(documents.createdAt))
            .limit(1)
            .get();

          if (next) {
            await trail.db
              .update(documents)
              .set({ status: 'processing' })
              .where(eq(documents.id, next.id))
              .run();

            triggerIngest({
              trail,
              docId: next.id,
              kbId,
              tenantId: next.tenantId,
              userId: next.userId,
            });

            console.log(`[backpressure] promoted ${next.id} for ${kbId}`);
          }
        }
      }
    } catch (err) {
      console.error('[backpressure] scheduler error:', err);
    }
  }, BACKPRESSURE_CHECK_INTERVAL_MS);
}
```

### 5. DB Schema Extension

```typescript
// packages/db/src/schema.ts

// Add 'pending_ingestion' to document status enum
// Current: status: text('status').default('pending')
// New values: 'pending' | 'processing' | 'ready' | 'failed' | 'archived' | 'pending_ingestion'
```

### 6. Admin UI Indicator

```typescript
// apps/admin/src/components/document-status.tsx

// Add pending_ingestion status with informative tooltip:
// "Waiting for ingest capacity. Estimated wait: ~5 minutes"

const STATUS_LABELS = {
  pending: 'Pending',
  processing: 'Processing',
  ready: 'Ready',
  failed: 'Failed',
  archived: 'Archived',
  pending_ingestion: 'Queued', // Short label for UI
};

const STATUS_TOOLTIPS = {
  pending_ingestion: 'Ingest queue is full. This document will be processed when capacity is available.',
};
```

## Impact Analysis

### Files created (new)
- `packages/shared/src/backpressure.ts` — config + types
- `packages/core/src/ingest/backpressure.ts` — backpressure check logic
- `apps/server/src/services/backpressure-scheduler.ts` — cron scheduler
- `packages/core/src/ingest/__tests__/backpressure.test.ts`

### Files modified
- `apps/server/src/services/ingest.ts` — add backpressure check before trigger
- `packages/db/src/schema.ts` — add `pending_ingestion` status
- `packages/db/drizzle/` — migration for new status value
- `apps/admin/src/components/document-status.tsx` — add pending_ingestion display
- `apps/server/src/app.ts` — start backpressure scheduler on boot

### Downstream dependents for modified files

**`apps/server/src/services/ingest.ts`** — imported by `routes/uploads.ts` and `routes/documents.ts`. Adding backpressure check is additive — existing callers don't need changes.

**`packages/db/src/schema.ts`** — adding status value is additive. All existing queries using `eq(documents.status, 'processing')` etc. are unaffected.

**`apps/admin/src/components/document-status.tsx`** — used by document listing. Adding new status is additive.

### Blast radius
- Documents in `pending_ingestion` state are visible in admin UI with clear messaging
- Scheduler runs every minute — low overhead
- Backpressure is per-KB — one KB's heavy upload doesn't block another KB
- If server restarts, `pending_ingestion` documents are picked up by scheduler on boot

### Breaking changes
None. New status value is additive.

### Test plan
- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Unit: `checkBackpressure` returns false when concurrent limit reached
- [ ] Unit: `checkBackpressure` returns false when hourly limit reached
- [ ] Unit: `checkBackpressure` returns true when under limits
- [ ] Integration: Upload 15 files at once → first 10 process immediately, rest go to pending_ingestion
- [ ] Integration: Scheduler promotes pending_ingestion documents when capacity frees up
- [ ] Integration: Admin UI shows "Queued" status with tooltip for pending_ingestion documents
- [ ] Regression: Normal single-file upload flow unchanged
- [ ] Regression: Document status lifecycle (pending → processing → ready) unchanged

## Implementation Steps

1. Add `pending_ingestion` to document status enum in schema + migration
2. Create `packages/shared/src/backpressure.ts` with config
3. Create `packages/core/src/ingest/backpressure.ts` with check logic + unit tests
4. Modify `triggerIngest` to check backpressure before proceeding
5. Create `backpressure-scheduler.ts` with 1-minute interval checker
6. Start scheduler in `app.ts` boot sequence
7. Add pending_ingestion status display in admin UI
8. Integration test: bulk upload → backpressure → gradual processing

## Dependencies

- F05 (Sources) — backpressure applies to source uploads
- F06 (Ingest Pipeline) — backpressure gates ingest triggers

## Effort Estimate

**Small** — 1 day

- Morning: Backpressure logic + schema migration + unit tests
- Afternoon: Scheduler + admin UI + integration test
