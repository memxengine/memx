# F17 — Curation Queue API

> HTTP endpoints over the `queue_candidates` table. Every write into a wiki document flows through this queue — no exceptions.

## Problem

`packages/db/src/schema.ts` already defines `queue_candidates` with `kind`, `confidence`, `impact_score`, `status`, `payload_json`, `auto_approved_at`, `reviewed_by`, `reviewed_at`. What's missing is the HTTP surface that turns that schema into a usable curation system. Today the ingest pipeline (F06) calls into the engine via MCP and writes directly — the queue is not in the critical path.

That's the wrong order. The moment we ship an ingest path that writes to `documents` directly, Phase 2 has two write paths, two sets of invariants, and two test surfaces. Migrating later means rewriting ingest.

## Secondary Pain Points
- No audit trail for who approved what and when
- No way to batch-approve low-risk candidates
- MCP `write` tool bypasses human review entirely

## Solution

Land the Curation Queue as the **only** write path into wiki documents, starting from commit #1 of this feature. Ingest writes candidates. Auto-approval is a queue policy (F19), not a parallel path. All nine candidate kinds (ingest_summary, ingest_page_update, chat_answer, reader_feedback, contradiction_alert, gap_suggestion, cross_ref_suggestion, source_retraction, scheduled_recompile) are accepted by the schema from day 1 even if only the first four fire in Phase 1.

## Non-Goals
- Real-time collaboration on queue items
- Bulk operations beyond simple approve/reject
- AI-assisted candidate scoring (that's F96)
- Queue persistence across server restarts (that's F143)

## Technical Design

### Endpoints

```
POST   /api/v1/queue/candidates
          body: { kb_id, kind, confidence, impact_score, payload_json, source_candidate_id? }
          → 201 { id, status: "pending" }

GET    /api/v1/queue?kb_id=…&status=pending|auto_approved|rejected&kind=…&limit=50
          → 200 { items: [...], total }

GET    /api/v1/queue/:id
          → 200 { candidate, affected_pages: [...] }

POST   /api/v1/queue/:id/approve
          body: { reviewed_by, notes?, edits? }   // edits patch the payload before commit
          → 200 { wiki_event_id, affected_pages }

POST   /api/v1/queue/:id/reject
          body: { reviewed_by, reason }
          → 200 { candidate }
```

### The write-path rule

Only one function in the codebase is allowed to INSERT/UPDATE `documents` where `kind='wiki'`: the approval handler in `apps/server/src/queue/approve.ts`. Every other code path MUST create a candidate and dispatch to approval (auto or manual). Enforced by a lint rule (grep `db.insert(documents)` or Drizzle equivalent) and by convention.

### Approval handler sketch

```typescript
// apps/server/src/queue/approve.ts
export async function approveCandidate(
  candidateId: string,
  reviewer: Actor,
  edits?: PayloadPatch,
): Promise<{ wikiEventId: string; affectedPages: string[] }> {
  const c = await db.select(...).where(eq(queueCandidates.id, candidateId)).one();
  assert(c.status === "pending" || c.status === "auto_approved");
  const payload = applyEdits(c.payload_json, edits);
  const affected = resolveAffectedPages(payload);
  const event = await db.transaction(async (tx) => {
    for (const page of affected) {
      await tx.update(documents).set({ content: page.content, version: page.version + 1 }).where(...);
      await tx.insert(wikiEvents).values({
        documentId: page.id, eventType: page.existed ? "updated" : "created",
        actorType: reviewer.type, actorId: reviewer.id,
        payloadJson: page.content, prevEventId: page.lastEventId,
        sourceCandidateId: candidateId,
      });
    }
    await tx.update(queueCandidates).set({ status: "approved", reviewedBy: reviewer.id, reviewedAt: new Date() }).where(eq(queueCandidates.id, candidateId));
  });
  return { wikiEventId: event.id, affectedPages: affected.map(p => p.slug) };
}
```

### Policy dispatch

`POST /candidates` calls `shouldAutoApprove(candidate)` (F19). If true, marks `auto_approved_at` and calls `approveCandidate` immediately. Otherwise status stays `pending` and the curator UI (F18) picks it up.

## Interface

### Request/Response Contracts

```typescript
// POST /api/v1/queue/candidates
interface CreateCandidateRequest {
  knowledgeBaseId: string;
  kind: CandidateKind;
  confidence: number; // 0-1
  impactScore: number; // 0-1
  payloadJson: Record<string, unknown>;
  sourceCandidateId?: string;
}

// GET /api/v1/queue
interface QueueListResponse {
  items: QueueCandidate[];
  total: number;
  cursor?: string;
}
```

### Events
- `candidate_created` — SSE event when new candidate lands
- `candidate_approved` — SSE event on approval
- `candidate_rejected` — SSE event on rejection

## Rollout

**Single-phase deploy.** The queue API is new — no migration needed. Ingest rewire (step 4 of implementation) should happen in the same PR to avoid a window where writes bypass the queue.

## Success Criteria
- `POST /queue/candidates` → 201, row in `queue_candidates` within 50ms
- `POST /:id/approve` → wiki page updated, wiki_events row created, candidate marked approved — all in one transaction
- Zero direct writes to `documents` where `kind='wiki'` outside the approve handler (verified by grep)
- Markdown ingest end-to-end still produces 6-8 wiki pages in ~60-100s
- PDF ingest with vision still works (8-page Danish PDF → 6 images → 7 wiki pages in ~155s)

## Impact Analysis

### Files created (new)
- `apps/server/src/routes/queue.ts`
- `apps/server/src/queue/approve.ts`
- `apps/server/src/queue/policy.ts`
- `apps/server/src/queue/resolve.ts`

### Files modified
- `apps/server/src/app.ts` (mount queue routes)
- `apps/server/src/services/ingest.ts` (emit candidates instead of writing directly)
- `packages/shared/src/contracts.ts` (Zod schemas for candidate payloads)

### Downstream dependents
`apps/server/src/app.ts` is imported by 4 files (4 refs):
- `apps/server/src/index.ts` (1 ref) — creates app via `createApp(trail)`, unaffected
- `apps/server/src/routes/auth.ts` (1 ref) — uses `createApp` for dev mode, unaffected
- `apps/server/src/routes/health.ts` (1 ref) — uses `createApp` for health check, unaffected
- `apps/server/src/routes/api-keys.ts` (1 ref) — uses `createApp` for API key routes, unaffected
Adding queue route mount is additive.

`apps/server/src/services/ingest.ts` is imported by 9 files (see F21 analysis). Changing from direct write to candidate emission is a behavior change but API surface is unchanged.

`packages/shared/src/contracts.ts` — imported by server routes and admin API client. Adding candidate schemas is additive.

### Blast radius
All current wiki writes flow through MCP → service layer. If the service layer is refactored to emit candidates, every ingest run during development flows through the queue. A missing `shouldAutoApprove` implementation (F19) means candidates stack up — acceptable for dev but must ship together for Sanne.

### Breaking changes
None to external API (the queue endpoints are new). Internal ingest behaviour changes: wiki updates are now asynchronous relative to `POST /sources/upload`. Clients polling for wiki completion must poll candidates, not documents.

### Test plan
- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] `POST /candidates` with valid payload → 201, row in `queue_candidates`
- [ ] `POST /:id/approve` from a reviewer → `documents` row updated, `wiki_events` row created, candidate marked approved
- [ ] `POST /:id/reject` → candidate status "rejected", no document change
- [ ] Concurrent approvals on same candidate: second returns 409
- [ ] Auto-approve policy returning true → candidate reaches `approved` without human step
- [ ] Regression: markdown ingest flow end-to-end still produces 6-8 wiki pages in ~60-100s
- [ ] Regression: PDF ingest with vision still works
- [ ] Regression: MCP `write` tool still functions (now emits candidates internally)

## Implementation Steps
1. Add Zod schemas for each of the 9 candidate `kind` payloads in `packages/shared`.
2. Implement `approveCandidate` helper (the only allowed wiki-write function).
3. Wire `POST /candidates`, `GET /queue`, `GET /:id`, `POST /:id/approve`, `POST /:id/reject`.
4. Refactor `apps/server/src/services/ingest.ts` to emit candidates rather than write directly.
5. Update `apps/mcp/src/tools/write.ts` to call the candidate-emit path internally.
6. Add the dummy `shouldAutoApprove` → `false` (F19 replaces this).
7. End-to-end smoke test: upload Markdown, observe candidates, manually approve via HTTP, verify wiki pages materialise.

## Dependencies
- F06 Ingest pipeline (rewire required)
- F07 Wiki document model
- F11 MCP stdio server (`write` tool rewire)
- F16 Wiki events (already in place)

Blocks: F18, F19, F20, F21, F32, F37.

## Open Questions
None — all decisions made.

## Related Features
- **F18** (Curator UI) — consumes queue API
- **F19** (Auto-Approval Policy) — policy dispatch in candidate creation
- **F20** (Diff UI) — uses queue candidate data
- **F96** (Action Recommender) — extends candidate with LLM recommendations
- **F143** (Persistent Ingest Queue) — queue survives server restarts

## Effort Estimate
**Medium** — 5-7 days including refactor of current ingest write path.
