# F143 — Persistent ingest queue across server restarts

> Today's ingest scheduler lives in two in-memory Maps inside `services/ingest.ts` — `activeIngests` (one-per-KB lock) + `ingestQueue` (waiting jobs). Any server restart loses the whole queue. A curator who uploads 65 sources and steps away for coffee comes back to a server that may have crashed, rebooted, or redeployed — with half the queue silently dropped. Persist the queue in SQLite so the engine re-hydrates it at boot and resumes from where it left off. Tier: alle. Effort: 1-1.5 days.

## Problem

When a curator uploads N text sources at once, each file's `triggerIngest()` call enqueues a job and the per-KB serialiser dispatches them one by one. The queue shape looks like:

```
activeIngests: { 'kb-1': true }
ingestQueue:   { 'kb-1': [job2, job3, …, job65] }
```

Both Maps are module-scoped, JS-heap-only state. On server exit (SIGTERM, crash, deploy) everything but the in-flight job's `status='processing'` DB row disappears.

The existing `recoverZombieIngests` bootstrap partially mitigates: any source stuck at `status='processing'` for >15 min is flipped to `status='failed'` with a "Ingest interrupted — re-upload to retry" message. But:

1. **Queue jobs that never started** never touched `status='processing'` — they sit at whatever status the upload set them to (text: `processing` after F-upload-fix; pending before).
2. **No auto-resume** — the curator has to find every `failed` row and click re-ingest manually. With a 65-file batch that's 65 clicks.
3. **No visibility** — while queued, the UI doesn't show "waiting behind 12 others". The compile-log-card (F136) streams events for the ACTIVE ingest only.

## Secondary Pain Points

- No way to cancel a queued job
- No queue-level progress indicator
- No priority mechanism for urgent uploads

## Solution

Move the queue from JS heap to SQLite. One new table, one new bootstrap, minimal changes to `triggerIngest()`.

- **Enqueue** = INSERT row into `ingest_jobs` with `status='queued'`.
- **Dispatch** = the scheduler's inner loop SELECTs the oldest `queued` job for the KB, flips it to `running`, calls into `runIngest`, flips to `done` / `failed` at end.
- **Boot recovery** = at server start, re-hydrate the scheduler by reading all `running` jobs (zombies from last run → back to `queued`) + existing `queued` jobs. Scheduler restarts from the first job per KB.

End state: hard-kill the server mid-55-file batch → reboot → the remaining 10 jobs are still there, scheduler picks them up, curator sees the progress bar continue.

### v1 (this feature)

**New table** (migration `0006_ingest_jobs.sql`):

```sql
CREATE TABLE ingest_jobs (
  id TEXT PRIMARY KEY,                       -- `ing_<uuid-12>`
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK(status IN ('queued','running','done','failed')) DEFAULT 'queued',
  priority INTEGER NOT NULL DEFAULT 0,         -- higher = sooner; default FIFO
  attempt INTEGER NOT NULL DEFAULT 0,           -- retry counter
  last_error TEXT,
  enqueued_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  finished_at TEXT
);

CREATE INDEX idx_ingest_jobs_kb_status ON ingest_jobs(knowledge_base_id, status, priority DESC, enqueued_at);
CREATE INDEX idx_ingest_jobs_doc ON ingest_jobs(document_id);
```

**Scheduler rewrite** (`services/ingest-scheduler.ts`, replacing the in-memory maps in `ingest.ts`):

```ts
interface Scheduler {
  enqueue(job: IngestJob, opts?: { priority?: number }): Promise<string>; // returns ingest_jobs.id
  tick(kbId: string): Promise<void>;                                       // dispatch next queued job for KB
  cancel(jobId: string): Promise<void>;                                     // move queued → cancelled (admin use)
  progressForKb(kbId: string): Promise<{ running: number; queued: number; done: number; failed: number }>;
}
```

- `enqueue` writes a row and calls `tick(kbId)` — if no `running` job for this KB, the tick picks it up immediately.
- `tick(kbId)` runs a SELECT for the oldest queued job, flips it `running`, calls into `runIngest` via the existing flow. On return, flips to `done`/`failed`, recurses `tick(kbId)` for the next job.
- Cancellation: queued → a new `cancelled` status (optional — could be handled by DELETE instead).
- Progress: one SELECT-with-GROUP-BY powers the per-source UI "3 / 12 queued" badge.

**Boot recovery** (`services/ingest-scheduler.ts` exports `recoverIngestQueue()`):

- Any `running` row → flipped to `queued` (zombie from last server), `attempt` incremented.
- For every KB with at least one `queued` job, call `tick(kbId)` to kick the dispatcher.
- Hook wired in `index.ts` next to `recoverZombieIngests`.

**Per-source UI (`apps/admin/src/panels/sources.tsx`):**

- When a source has a `queued` or `running` `ingest_jobs` row, show queue position: "Queued 4/12 in this Trail".
- When `status='processing'` + an `ingest_jobs` row is `running`, the existing `ProcessingIndicator` + F136 compile-log continue working unchanged.
- Retry button flips the source back through `enqueue` instead of calling `triggerIngest` directly.

**API** (extends existing `/api/v1/knowledge-bases/:kbId/documents` query):

- Include `ingestJobStatus: 'queued' | 'running' | null` per doc + queue position (if queued).
- New `GET /api/v1/knowledge-bases/:kbId/ingest-queue` returns the flat queue for a KB — for a future "queue" view panel.

**`zombie-ingest.ts` bootstrap sunset:**

- Old 15-minute-timeout heuristic becomes redundant once every active ingest has an `ingest_jobs.running` row. Keep the zombie check as a belt-and-suspenders until F143 has soaked for a week, then remove.

### Out of scope for v1

- **Cross-KB concurrency limits.** Today we run at most N-KBs in parallel (one each). Future knob: global max concurrency for API-cost control. F143.1.
- **Priority levels beyond default FIFO.** The `priority` column is there for when a curator wants to jump a specific upload ahead — UI hook-up is F143.2.
- **Distributed scheduler.** Phase 2 multi-tenant SaaS with multiple engine replicas will need a leader-election + lock table on top of this. F40.2 territory.
- **Retry-with-backoff on failed jobs.** For now one attempt → done or failed; curator retries manually. F143.3.

## Non-Goals

- Distributed/clustered scheduler (v1)
- Priority queue UI (v1 — column exists, no UI)
- Retry-with-backoff on failed jobs (v1)
- Cross-KB concurrency limits (v1)

## Technical Design

### Queue semantics

- **Per-KB serialisation preserved.** The scheduler's inner loop picks only ONE `running` job per KB at a time — same invariant as today's in-memory `activeIngests` Map.
- **FIFO within KB** via `priority DESC, enqueued_at ASC`. Ties break on enqueue time.
- **At-least-once execution.** A crash after `running` is set but before the subprocess finished: boot recovery re-enqueues as `queued` + `attempt+=1`. Same LLM compile runs twice. Acceptable because ingest is idempotent (candidates dedupe via `documents` path+filename uniqueness — our `storeChunks` fix + F92 canonicalisation ensure no ghost rows).

### Scheduler state machine

```
  enqueue
     │
     ▼
  ┌──────┐  tick   ┌────────┐  ok   ┌──────┐
  │queued│───────▶│ running │──────▶│ done │
  └──────┘         └────────┘       └──────┘
      ▲                │
      │                │ crash/error
      │                ▼
      │            ┌────────┐
      └────────────│ failed │  ← boot recovery flips running→queued
                   └────────┘
```

### Concurrency rules

- `tick(kbId)` acquires SQLite's write lock during the `running` transition. Two concurrent `enqueue`s that both see zero-running race benignly: SQLite serialises the UPDATE, second one becomes a no-op.
- No global mutex needed — per-KB serialisation is enforced by "at most one `running` per KB" as a SELECT-COUNT-THEN-UPDATE pattern inside the tx.

### Recovery formal guarantees

- No job is "lost" across reboots. Every enqueue → persistent row → survives crash.
- No job runs fewer than once (the at-least-once).
- A job MAY run twice if the server died AFTER the compile succeeded but BEFORE the `done` UPDATE — uncommon (narrow window) but not impossible. We accept it because:
  - `createCandidate` path is idempotent on the (kb, path, filename) triple
  - A second compile emitting "already exists" via the dedup guard from `ae56430` is a no-op
  - Worst case: a second set of candidates that duplicate the first — visible to curator, dismissible

### Bootstrap ordering in `index.ts`

```
1. runMigrations
2. initFTS
3. ensureIngestUser
4. recoverZombieIngests       (legacy, kept as belt-and-suspenders)
5. rewriteWikiToNeurons
6. cleanupExternalOrphans
7. seedMissingGlossaryNeurons
8. recoverPendingSources
9. recoverIngestQueue          ← NEW
10. backfillReferences
11. backfillBacklinks
...
```

## Interface

### API Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/knowledge-bases/:kbId/ingest-queue` | Flat queue for a KB |
| GET | `/knowledge-bases/:kbId/documents` | Extended with `ingestJobStatus` + `queuePosition` |

### DB Table

`ingest_jobs` — persistent queue with status, priority, attempt tracking.

## Rollout

**Single-phase deploy:**
1. Migration + schema
2. Scheduler module
3. Upload/reingest call-site swaps
4. Bootstrap recovery
5. Queue endpoint
6. Admin sources panel queue-position display
7. i18n pass
8. Manual soak test

## Success Criteria

- Enqueue 5 jobs for one KB → scheduler runs them sequentially → all land `done`.
- Kill server after job #2 finishes, mid-job #3 → reboot → `recoverIngestQueue` picks up job #3 (zombie, moves to queued, reruns) and continues through #4, #5.
- Enqueue 3 jobs each to 2 different KBs → both KBs' jobs run in parallel (one per KB); within each KB serial.
- Upload 65 text sources in rapid succession → queue fills with 65 entries → UI shows "Queued N/65" per row → all complete over ~90 minutes at ~90 s per job (Haiku compile).
- Retry on a `failed` source → re-enqueues with `attempt=2`.
- Typecheck green across workspaces.
- `recoverZombieIngests` + `recoverIngestQueue` both run at boot, no interference.

## Impact Analysis

### Files created (new)
- `apps/server/src/services/ingest-scheduler.ts`
- `packages/db/drizzle/migrations/0006_ingest_jobs.sql`

### Files modified
- `packages/db/src/schema.ts` — add `ingestJobs` table.
- `apps/server/src/services/ingest.ts` — `triggerIngest` delegates to scheduler instead of in-memory Map; `runIngest` remains the actual compile worker.
- `apps/server/src/index.ts` — wire `recoverIngestQueue` bootstrap.
- `apps/server/src/routes/documents.ts` — `/reingest` + `/reprocess` enqueue via scheduler.
- `apps/server/src/routes/uploads.ts` — text-upload path enqueues via scheduler.
- `apps/server/src/routes/knowledge-bases.ts` — new `/ingest-queue` endpoint.
- `apps/server/src/bootstrap/zombie-ingest.ts` — kept as belt-and-suspenders; becomes no-op when scheduler is fully live.
- `apps/admin/src/api.ts` — `IngestQueueItem` type + `fetchIngestQueue`.
- `apps/admin/src/panels/sources.tsx` — queue-position indicator on queued rows.
- i18n `queue.position` + `queue.waiting` keys.

### Downstream dependents
`apps/server/src/services/ingest.ts` is imported by 7 files:
- `apps/server/src/routes/uploads.ts` (1 ref) — calls triggerIngest, will delegate to scheduler
- `apps/server/src/routes/documents.ts` (1 ref) — calls triggerIngest for reingest, will delegate to scheduler
- `apps/server/src/routes/ingest.ts` (1 ref) — calls triggerIngest, will delegate to scheduler
- `apps/server/src/app.ts` (1 ref) — mounts ingest routes, unaffected
- `apps/server/src/index.ts` (2 refs) — imports recoverIngestJobs + zombie-ingest, will add recoverIngestQueue
- `docs/features/F26-html-web-clipper-ingest.md` (1 ref) — documentation, no code impact

`apps/server/src/routes/uploads.ts` is imported by 2 files:
- `apps/server/src/app.ts` (1 ref) — mounts route, unaffected
- `apps/server/src/bootstrap/recover-pending-sources.ts` (1 ref) — imports processPdfAsync/processDocxAsync, unaffected

### Blast radius

Medium. The scheduler is the critical path for every ingest; a bug stops all compile work. Mitigations:
- Scheduler unit-tested against the state machine before wiring to upload paths.
- Legacy `zombie-ingest` kept until soak period clears.
- Rollback is a revert of one service file + keeping the DB table (unused). No data loss.

### Breaking changes

None to API contracts. The documents endpoint gains optional `ingestJobStatus` + `queuePosition` fields that clients can ignore.

### Test plan

- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Enqueue 5 jobs → sequential execution → all done
- [ ] Kill server mid-job #3 → reboot → recovery picks up #3, continues through #5
- [ ] 3 jobs each to 2 KBs → parallel across KBs, serial within
- [ ] Upload 65 sources → queue fills → UI shows "Queued N/65" → all complete
- [ ] Retry on failed source → re-enqueues with attempt=2
- [ ] `recoverZombieIngests` + `recoverIngestQueue` both run at boot, no interference
- [ ] F136 compile-log-card: unchanged for running job
- [ ] F142 chunked ingest: per-chunk dispatch stays inside runIngest, queue at document level

## Implementation Steps

1. Migration: add `ingest_jobs` table + indices.
2. Drizzle schema declarations.
3. `services/ingest-scheduler.ts` — enqueue / tick / recover / cancel / progress helpers.
4. `services/ingest.ts` — refactor `triggerIngest` to delegate to scheduler; keep `runIngest` intact.
5. Upload paths (`uploads.ts`, `documents.ts`) — swap `triggerIngest(jobShape)` call sites for `scheduler.enqueue(jobShape)`.
6. `recoverIngestQueue` bootstrap + `index.ts` wiring.
7. `GET /api/v1/knowledge-bases/:kbId/ingest-queue` endpoint.
8. Admin sources panel — queue-position display per row.
9. i18n pass.
10. Manual soak: upload a 20-file batch, kill server mid-run, boot, verify resumption.

## Dependencies

- F15/F17 queue + candidate invariants (done — our candidates remain the write-path).
- F136 compile-log-card (in flight — integrates with per-job events).
- Existing `recoverZombieIngests` (done — coexists until sunset).

## Open Questions

1. **`cancelled` status** — worth adding for curator-cancel-queued-job UX, or start with DELETE-only? V1: DELETE. Promote to `cancelled` when we add bulk-queue-management UI.
2. **Scheduler coupling to KB** — we keep per-KB serialisation. F40.2 may want global-per-tenant concurrency limits; leave a clean seam (pass kbId explicitly to the scheduler's tick path).
3. **Priority queue API** — expose to curators or keep internal for now? V1 is internal with `priority=0` default.

## Related Features

- **F136** — Compile log card (per-job event streaming)
- **F142** — Chunked ingest (queues at document level, not chunk level)
- **F15** — Document references (candidate invariants)
- **F17** — Curation Queue API (write-path invariant)
- **F40** — Multi-tenancy (future distributed scheduler)

## Effort Estimate

**Medium** — 1-1.5 days.
- 0.25 day: migration + Drizzle schema.
- 0.5 day: scheduler + recovery bootstrap + state-machine tests.
- 0.25 day: upload / reingest / reprocess call-site swaps.
- 0.25 day: sources-panel queue-position UI + i18n.
- 0.25 day: soak + test plan walkthrough.
