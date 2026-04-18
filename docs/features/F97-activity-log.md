# F97 — Activity Log

> A central, append-only record of every meaningful action on a trail server. One table, one subscriber, one timeline UI. Answers "who did what when" for every surface the admin touches — uploads, ingests, candidate decisions, edits, archives, lint runs, logins — without retrofitting logging calls into every flow.

## Problem

Today activity is scattered:

- `wiki_events` captures document-lifecycle (created/edited/archived/restored) with actor, summary, content snapshot, and a link to the candidate that caused it — but only for `kind='wiki'` documents.
- `queue_candidates` captures candidate lifecycle (status, reviewedBy, resolvedAction) but you have to SELECT across the whole table to see "what happened today".
- `documents.createdAt/updatedAt` tells you a Source was uploaded but not BY whom or from which connector.
- The broadcaster (SSE bus) emits 7 event types (`candidate_created`, `candidate_approved`, `candidate_resolved`, `ingest_started/completed/failed`, `kb_created`) — these are **ephemeral**. When a client isn't listening, the event is lost. Post-mortem debugging, compliance audits, per-user activity summaries, credits-based billing, retroactive analytics — all are currently impossible.
- No central answer to:
  - "When did Sanne last edit anything?"
  - "How many candidates did buddy write this week?"
  - "Did we actually run lint on the Sanne KB overnight?"
  - "Why did this Neuron get archived — by whom, when, from where?"

Scattered signals are fine for a prototype; they're a liability for a product that promises "compounding knowledge" and will run credits-based billing.

**Not goals:**

- Full change-data-capture (`wiki_events.contentSnapshot` already handles per-Neuron version history — activity log references, does not duplicate).
- Security audit trail for failed auth attempts, rate-limit hits, etc. (separate concern — belongs in infra logs, not app DB).
- Real-time observability dashboards (Grafana/Loki territory, not this feature).
- User-analytics tracking ("what panels did they view") — can be layered later on top of the same table if ever needed, but not MVP.

**Goal:** one `activity_log` table + one timeline panel where a curator or developer can see every meaningful action in chronological order, with filters.

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
    // Who triggered this. null for pipeline/system events.
    actorId: text('actor_id').references(() => users.id),
    actorKind: text('actor_kind', { enum: ['user', 'llm', 'system', 'pipeline'] }).notNull(),
    // What happened. Narrow enum — adding a value = schema migration,
    // which is the right forcing function ("we added a new action that
    // should be audited, let's decide if it warrants a log entry").
    kind: text('kind', {
      enum: [
        // Authentication
        'auth.login', 'auth.logout',
        // Trail lifecycle
        'kb.created', 'kb.updated', 'kb.archived',
        // Source lifecycle
        'source.uploaded', 'source.archived', 'source.restored',
        // Ingest
        'ingest.started', 'ingest.completed', 'ingest.failed', 'ingest.retried',
        // Queue / candidates
        'candidate.created', 'candidate.approved', 'candidate.rejected',
        'candidate.reopened', 'candidate.acknowledged',
        // Neuron
        'neuron.edited', 'neuron.archived', 'neuron.restored',
        // Lint
        'lint.scheduled', 'lint.completed',
        // Connector (F95)
        'connector.recommendation_generated',
      ],
    }).notNull(),
    // Polymorphic subject — what thing was acted on.
    subjectType: text('subject_type', {
      enum: ['document', 'candidate', 'knowledge_base', 'user', 'session', 'none'],
    }).notNull(),
    subjectId: text('subject_id'),
    // One-line human-readable summary. Rendered verbatim on the timeline.
    summary: text('summary').notNull(),
    // Free-form JSON for kind-specific payload: tokens used, model,
    // byte count, fingerprint, connector id, etc.
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

Append-only by convention — no UPDATE, no DELETE (tenant deletion cascades handle the latter). Partitioning can come later if any tenant ever exceeds ~10M rows; today even a noisy tenant will sit in the low hundreds of thousands.

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

Fire-and-forget semantics from caller's POV — internally a simple INSERT, synchronous against the same DB the caller is already using. Wrap in a try/catch at call sites that can't tolerate log failures blocking the primary action (all of them should, actually — the log is secondary to the business action).

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

Maps each broadcaster event to a `logActivity()` call. Runs inside the process so latency is negligible. If the DB write fails, we log and swallow — the primary action already succeeded, the audit entry being missing is a follow-up cleanup task, not a user-facing failure.

### Explicit call sites (broadcaster gaps)

| Call site | Kind | Actor | Why broadcaster doesn't cover |
|---|---|---|---|
| `routes/auth.ts` success callback | `auth.login` | user | No auth event on the bus today |
| `routes/auth.ts` signout route | `auth.logout` | user | Same |
| `routes/knowledge-bases.ts` POST | `kb.created` | user | Broadcaster emits `kb_created` — subscriber handles; this row is a backup/clarifier with richer metadata |
| `routes/knowledge-bases.ts` PATCH | `kb.updated` | user | No event today |
| `routes/uploads.ts` after insert | `source.uploaded` | user | Ingest events fire but not "file arrived" |
| `services/lint-scheduler.ts` start | `lint.scheduled` | system | Scheduler only emits per-candidate |
| `services/lint-scheduler.ts` complete | `lint.completed` | system | Same |

### API

```
GET /api/v1/activity?kbId=...&kind=...&actorId=...&subjectType=...&subjectId=...&since=...&limit=50&cursor=...
```

Returns paginated chronological (DESC) entries. `cursor` is the `createdAt` of the oldest row in the previous page for stable paging across writes.

No `POST` — clients never write to this log directly. Only server-side code + the broadcaster subscriber.

### Admin UI — `/activity`

New panel. Reuses connector-chip-row pattern from the Queue, but for `kind` (grouped: Auth / Trail / Source / Ingest / Queue / Neuron / Lint / Connector).

Layout per row:

```
┌────────────────────────────────────────────────────────────────────────┐
│ 14:32 · Christian  SOURCE.UPLOADED  Uploaded NADA-protokollen.pdf     │
│                    [trail: Sanne]   [connector: upload]                │
└────────────────────────────────────────────────────────────────────────┘
┌────────────────────────────────────────────────────────────────────────┐
│ 14:33 · system     INGEST.STARTED  Compiling NADA-protokollen.pdf     │
│                    [trail: Sanne]   [doc: doc_3caeb6...]               │
└────────────────────────────────────────────────────────────────────────┘
```

Filters above the list (collapsible like KILDE:):
- **Actor:** dropdown (All / Me / each named user / system / llm / pipeline)
- **Kind group:** chip row (Auth, Trail, Source, Ingest, Queue, Neuron, Lint, Connector)
- **Trail:** current-KB / all
- **Subject:** free-text search on summary + subjectId
- **Timeframe:** Today / 7d / 30d / All / Custom range

Click a row → expands to show the full `metadata` JSON + links to the subject (e.g. clicking a `candidate.approved` row jumps to the resolved candidate, or to the resulting Neuron).

## Implementation Plan

1. **Schema migration** (`packages/db/src/schema.ts`, drizzle-kit generate) — add `activity_log` table, 5 indexes.
2. **Core helper** (`packages/core/src/activity.ts`) — `logActivity()` + `ActivityKind` union exported via shared.
3. **Subscriber service** (`apps/server/src/services/activity-logger.ts`) — maps 7 broadcaster events to log rows.
4. **Boot wire-up** (`apps/server/src/index.ts`) — start the subscriber before `Bun.serve`.
5. **Explicit logging** in 6 gap call-sites (auth login/logout, kb create/update, upload-received, lint scheduled/completed).
6. **Read API** (`apps/server/src/routes/activity.ts`) — paginated list endpoint with filter query params + Zod schema.
7. **Admin panel** (`apps/admin/src/panels/activity.tsx`) — timeline component + filter row; wire to SSE `candidate_*` events for live-prepending new rows as they arrive.
8. **Nav link** — add `/activity` to Settings menu (F-doc equivalent exists? yes — trail-neuron-editor's Settings panel). Or add as header link between Glossary and Language if that's more discoverable.
9. **i18n** sweep — kind labels + panel chrome in both en.json and da.json. Kind enum keys stay stable English; only labels translate.
10. **Backfill** (optional) — one-shot migration script that synthesises rows from existing `wiki_events` + `queue_candidates` history so the panel isn't empty on day one. Adds ~212 entries for today's KB; cheap. Tag each with `metadata.backfilled: true` so we know what's real vs synthesised.

## Testing

- Unit: `logActivity()` writes a row, rejects invalid kind.
- Integration: trigger each broadcaster event type, assert a corresponding row lands in `activity_log`.
- Manual: `/activity` panel loads 50 rows, filter-by-kind narrows correctly, timeframe custom-range picker works, clicking an `ingest.completed` row expands metadata + deep-links to the resulting Neuron.
- Regression: bulk-reject 40 candidates → exactly 40 `candidate.rejected` rows appear, one per candidate, within ~1s of the bulk completing.

## Unlocks

- **Credits / usage metering** (F95 successor): `metadata.tokens` on every `ingest.completed`, `connector.recommendation_generated`, `candidate.created` from LLM pipelines → per-tenant monthly rollup → billing.
- **Per-user activity summary** in Settings/Account panel: "You approved 12 candidates this week, compiled 3 Neurons, uploaded 2 Sources."
- **Debugging UX**: "Show me everything that happened to Neuron X" becomes a filtered query on `subjectId`.
- **Compliance**: append-only log + cascade-delete on tenant = GDPR-compatible "all activity for user Y" export.
- **Trail of thought**: Christian's original vision. Every action on a Trail server is now a trace; the activity panel IS a living record.

## Open questions

1. **Retention**: keep forever vs roll off after 2 years? Leaning: keep forever (rows are tiny, value-per-byte is high). Add a cron-based archival-to-cold-storage if any single tenant exceeds 100MB.
2. **Write load**: bulk operations currently emit 40 events in a tight loop. One INSERT per event is fine at 40 events, but a 10k-candidate migration would matter. Mitigation: `logActivityBatch()` that accepts an array + does one multi-row INSERT. Skip for MVP, add when a big migration comes up.
3. **LLM call logging granularity**: every MCP write? Every Haiku recommendation? Or only the user-facing outcomes? Leaning: user-facing outcomes in the log, raw LLM telemetry goes to a separate `llm_call_log` table (F-doc of its own when we implement credits).
4. **Subject deep-linking**: what if a subject's been archived/deleted by the time the curator clicks into the activity row? Leaning: resolve server-side, return `{available: true, href: ...}` or `{available: false, lastKnownTitle: '...'}`.

## Why this lives in its own F-doc

The activity log isn't just a feature — it's a foundation for credits billing (F95 successor), compliance exports, per-user analytics, and debugging UX. Getting the schema + logging contract right at the start means every feature that ships AFTER this one gets audit for free by calling one helper. Retrofitting is much harder than including from the start.
