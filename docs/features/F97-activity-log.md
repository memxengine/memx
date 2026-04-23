# F97 — Activity Log

> A central, append-only record of every meaningful action on a trail server. One table, one subscriber, one timeline UI. Answers "who did what when" for every surface the admin touches. Tier: all. Effort: Medium (3-5 days). Status: Planned.

## Problem

Today activity is scattered across multiple tables and ephemeral events:

- `wiki_events` captures document-lifecycle (created/edited/archived/restored) with actor, summary, content snapshot, and a link to the candidate that caused it — but only for `kind='wiki'` documents.
- `queue_candidates` captures candidate lifecycle (status, reviewedBy, resolvedAction) but you have to SELECT across the whole table to see "what happened today".
- `documents.createdAt/updatedAt` tells you a Source was uploaded but not BY whom or from which connector.
- The broadcaster (SSE bus) emits 7 event types (`candidate_created`, `candidate_approved`, `candidate_resolved`, `ingest_started/completed/failed`, `kb_created`) — these are **ephemeral**. When a client isn't listening, the event is lost.
- No central answer to: "When did Sanne last edit anything?", "How many candidates did buddy write this week?", "Did we actually run lint on the Sanne KB overnight?", "Why did this Neuron get archived — by whom, when, from where?"

Post-mortem debugging, compliance audits, per-user activity summaries, credits-based billing, retroactive analytics — all are currently impossible.

## Secondary Pain Points

- No audit trail for compliance exports (GDPR "all activity for user Y").
- Credits-based billing has no data source for per-tenant monthly rollups.
- Debugging "what happened to Neuron X" requires querying 3+ tables manually.

## Solution

**One table, one subscriber, one panel.** The broadcaster already emits most of the events we care about; we subscribe, we persist, we render. Explicit `logActivity()` calls fill the gaps for events the broadcaster doesn't cover (KB creation, settings changes, upload received, lint-run-start).

```
┌────────────────┐      ┌──────────────────┐      ┌─────────────────┐
│  broadcaster   │─────▶│ activity-logger  │─────▶│   activity_log  │
│  (SSE events)  │      │    subscriber    │      │      table      │
└────────────────┘      └──────────────────┘      └─────────────────┘
         ▲                                                 │
         │                                                 │
┌────────┴────────┐                                        ▼
│ routes/uploads  │                              ┌──────────────────┐
│ routes/kbs      │ ──── logActivity() ────▶     │  /activity panel │
│ routes/auth     │       (direct call)          │   (timeline UI)  │
│ services/lint   │                              └──────────────────┘
└─────────────────┘
```

## Non-Goals

- Full change-data-capture (`wiki_events.contentSnapshot` already handles per-Neuron version history — activity log references, does not duplicate).
- Security audit trail for failed auth attempts, rate-limit hits, etc. (belongs in infra logs, not app DB).
- Real-time observability dashboards (Grafana/Loki territory).
- User-analytics tracking ("what panels did they view") — can be layered later if needed, but not MVP.

## Technical Design

### Schema — `activity_log`

```ts
// packages/db/src/schema.ts
export const activityLog = sqliteTable(
  'activity_log',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    knowledgeBaseId: text('knowledge_base_id').references(() => knowledgeBases.id, { onDelete: 'cascade' }),
    actorId: text('actor_id').references(() => users.id),
    actorKind: text('actor_kind', { enum: ['user', 'llm', 'system', 'pipeline'] }).notNull(),
    kind: text('kind', {
      enum: [
        'auth.login', 'auth.logout',
        'kb.created', 'kb.updated', 'kb.archived',
        'source.uploaded', 'source.archived', 'source.restored',
        'ingest.started', 'ingest.completed', 'ingest.failed', 'ingest.retried',
        'candidate.created', 'candidate.approved', 'candidate.rejected',
        'candidate.reopened', 'candidate.acknowledged',
        'neuron.edited', 'neuron.archived', 'neuron.restored',
        'lint.scheduled', 'lint.completed',
        'connector.recommendation_generated',
      ],
    }).notNull(),
    subjectType: text('subject_type', {
      enum: ['document', 'candidate', 'knowledge_base', 'user', 'session', 'none'],
    }).notNull(),
    subjectId: text('subject_id'),
    summary: text('summary').notNull(),
    metadata: text('metadata'),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index('idx_activity_tenant_time').on(table.tenantId, table.createdAt),
    index('idx_activity_kb_time').on(table.knowledgeBaseId, table.createdAt),
    index('idx_activity_actor').on(table.tenantId, table.actorId, table.createdAt),
    index('idx_activity_subject').on(table.tenantId, table.subjectType, table.subjectId),
    index('idx_activity_kind').on(table.tenantId, table.kind, table.createdAt),
  ],
);
```

Append-only by convention — no UPDATE, no DELETE (tenant deletion cascades handle the latter).

### Helper — `logActivity()`

```ts
// packages/core/src/activity.ts
export interface LogActivityInput {
  tenantId: string;
  knowledgeBaseId?: string | null;
  actorId?: string | null;
  actorKind: 'user' | 'llm' | 'system' | 'pipeline';
  kind: ActivityKind;
  subjectType: 'document' | 'candidate' | 'knowledge_base' | 'user' | 'session' | 'none';
  subjectId?: string | null;
  summary: string;
  metadata?: Record<string, unknown>;
}

export async function logActivity(
  trail: TrailDatabase,
  input: LogActivityInput,
): Promise<void>;
```

### Subscriber — `activity-logger` service

```ts
// apps/server/src/services/activity-logger.ts
export function startActivityLogger(trail: TrailDatabase): () => void {
  return broadcaster.subscribe((event) => {
    void logFromBroadcast(trail, event).catch((err) =>
      console.error('[activity-logger] drop:', err),
    );
  });
}
```

### Explicit call sites (broadcaster gaps)

| Call site | Kind | Actor | Why broadcaster doesn't cover |
|---|---|---|---|
| `routes/auth.ts` success callback | `auth.login` | user | No auth event on the bus today |
| `routes/auth.ts` signout route | `auth.logout` | user | Same |
| `routes/knowledge-bases.ts` PATCH | `kb.updated` | user | No event today |
| `routes/uploads.ts` after insert | `source.uploaded` | user | Ingest events fire but not "file arrived" |
| `services/lint-scheduler.ts` start | `lint.scheduled` | system | Scheduler only emits per-candidate |
| `services/lint-scheduler.ts` complete | `lint.completed` | system | Same |

## Interface

### Read API

```
GET /api/v1/activity?kbId=...&kind=...&actorId=...&subjectType=...&subjectId=...&since=...&limit=50&cursor=...
```

Returns paginated chronological (DESC) entries. `cursor` is the `createdAt` of the oldest row in the previous page for stable paging across writes.

No `POST` — clients never write to this log directly. Only server-side code + the broadcaster subscriber.

### Admin UI — `/activity`

New panel. Reuses connector-chip-row pattern from the Queue, but for `kind` (grouped: Auth / Trail / Source / Ingest / Queue / Neuron / Lint / Connector).

Layout per row:
```
14:32 · Christian  SOURCE.UPLOADED  Uploaded NADA-protokollen.pdf
                   [trail: Sanne]   [connector: upload]
```

Filters: Actor dropdown, Kind chip row, Trail selector, Subject free-text search, Timeframe (Today / 7d / 30d / All / Custom range).

Click a row → expands to show full `metadata` JSON + links to the subject.

## Rollout

**Single-phase deploy.** The activity log is new — no migration needed. Backfill from existing `wiki_events` + `queue_candidates` history is optional (one-shot migration script, ~212 entries for today's KB, tagged with `metadata.backfilled: true`).

## Success Criteria

- Every broadcaster event type produces a corresponding row in `activity_log` within 100ms.
- `GET /api/v1/activity` returns 50 rows in <50ms with cursor-based pagination.
- Bulk-reject 40 candidates → exactly 40 `candidate.rejected` rows appear, one per candidate, within ~1s.
- `/activity` panel loads, filters by kind narrow correctly, timeframe custom-range picker works.
- Clicking an `ingest.completed` row expands metadata and deep-links to the resulting Neuron.

## Impact Analysis

### Files created (new)

- `packages/core/src/activity.ts`
- `apps/server/src/services/activity-logger.ts`
- `apps/server/src/routes/activity.ts`
- `apps/admin/src/panels/activity.tsx`

### Files modified

- `packages/db/src/schema.ts` (add `activity_log` table with 5 indexes)
- `apps/server/src/index.ts` (start subscriber before `Bun.serve`)
- `apps/server/src/routes/auth.ts` (add login/logout logActivity calls)
- `apps/server/src/routes/knowledge-bases.ts` (add kb.create/update logActivity calls)
- `apps/server/src/routes/uploads.ts` (add source.uploaded logActivity call)
- `apps/server/src/services/lint-scheduler.ts` (add lint.scheduled/completed logActivity calls)

### Downstream dependents

`packages/db/src/schema.ts` — Central schema file. Adding `activity_log` table is purely additive; no downstream changes required. All existing queries are unaffected.

`apps/server/src/index.ts` — Boot entry point. Adding `startActivityLogger()` call is additive; no downstream changes.

`apps/server/src/routes/auth.ts` — Auth route handler. Adding `logActivity()` calls is additive; no downstream changes.

`apps/server/src/routes/knowledge-bases.ts` — KB route handler. Adding `logActivity()` calls is additive; no downstream changes.

`apps/server/src/routes/uploads.ts` — Upload route handler. Adding `logActivity()` call is additive; no downstream changes.

`apps/server/src/services/lint-scheduler.ts` — Lint scheduler. Adding `logActivity()` calls is additive; no downstream changes.

### Blast radius

- All changes are additive (new table, new helper, new subscriber, new call sites).
- `logActivity()` is fire-and-forget — wrapped in try/catch at all call sites so log failures don't block primary actions.
- Append-only by convention — no UPDATE/DELETE paths to break.
- Tenant cascade-delete handles cleanup automatically.

### Breaking changes

None — all changes are additive.

### Test plan

- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Unit: `logActivity()` writes a row, rejects invalid kind
- [ ] Integration: trigger each broadcaster event type, assert corresponding row lands in `activity_log`
- [ ] Integration: `GET /api/v1/activity` returns paginated entries with cursor stability
- [ ] Manual: `/activity` panel loads 50 rows, filter-by-kind narrows correctly, timeframe custom-range works
- [ ] Manual: clicking `ingest.completed` row expands metadata + deep-links to resulting Neuron
- [ ] Regression: bulk-reject 40 candidates → exactly 40 `candidate.rejected` rows appear within ~1s
- [ ] Regression: existing wiki_events and queue_candidates tables unaffected by new activity_log table

## Implementation Steps

1. Add `activity_log` table + 5 indexes to `packages/db/src/schema.ts`, run drizzle-kit generate.
2. Create `logActivity()` helper + `ActivityKind` union in `packages/core/src/activity.ts`, export via shared.
3. Implement subscriber service in `apps/server/src/services/activity-logger.ts` — maps 7 broadcaster events to log rows.
4. Wire subscriber in `apps/server/src/index.ts` — start before `Bun.serve`.
5. Add explicit `logActivity()` calls in 6 gap call-sites (auth login/logout, kb create/update, upload-received, lint scheduled/completed).
6. Implement read API in `apps/server/src/routes/activity.ts` — paginated list endpoint with filter query params + Zod schema.
7. Build admin panel in `apps/admin/src/panels/activity.tsx` — timeline component + filter row; wire to SSE events for live-prepending.
8. Add `/activity` nav link to Settings menu or header.
9. i18n sweep — kind labels + panel chrome in both en.json and da.json.
10. (Optional) Backfill one-shot migration script from existing `wiki_events` + `queue_candidates` history.

## Dependencies

- F95 (Connectors — connector attribution in metadata)
- F17 (Curation Queue API — candidate events to log)
- F16 (Wiki events — existing event source)

Unlocks: Credits/usage metering (F95 successor), per-user activity summary, compliance exports, debugging UX.

## Open Questions

1. **Retention**: keep forever vs roll off after 2 years? Leaning: keep forever (rows are tiny, value-per-byte is high). Add cron-based archival-to-cold-storage if any tenant exceeds 100MB.
2. **Write load**: bulk operations emit 40 events in a tight loop. One INSERT per event is fine at 40, but a 10k-candidate migration would matter. Mitigation: `logActivityBatch()` for multi-row INSERT. Skip for MVP.
3. **LLM call logging granularity**: every MCP write? Every Haiku recommendation? Or only user-facing outcomes? Leaning: user-facing outcomes in the log, raw LLM telemetry goes to a separate `llm_call_log` table (future F-doc).
4. **Subject deep-linking**: what if a subject's been archived/deleted by the time the curator clicks? Leaning: resolve server-side, return `{available: true, href: ...}` or `{available: false, lastKnownTitle: '...'}`.

## Related Features

- **F95** (Connectors) — connector attribution in metadata
- **F96** (Action Recommender) — candidate events to log
- **F98** (Orphan Connector-Awareness) — connector-aware lint events
- **F106** (Solo Mode) — activity log as audit trail for auto-approves

## Effort Estimate

**Medium** — 3-5 days.

- Schema + helper: 0.5 day
- Subscriber service: 0.5 day
- Explicit call sites (6): 0.5 day
- Read API: 0.5 day
- Admin panel + filters: 1-1.5 days
- i18n + nav link: 0.5 day
- Optional backfill script: 0.5 day
