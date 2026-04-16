# F87 — Event Stream

> Trail emits typed events when queue candidates are created, approved, or rejected, and when ingest jobs start/complete/fail. One SSE endpoint, one schema, same contract for admin, embed widgets, buddy, and any future consumer.

## Problem

The admin needs to show a live pending-count badge on the Queue tab. Buddy wants a feedback signal when curators reject its F39 candidates. Downstream integrations (a CMS, a Slack bot, a monitoring dashboard) need to react to trail state changes without polling.

Polling works for simple cases but fragments the contract: every consumer re-implements pagination + change detection. A broker-free event stream with a stable schema solves this once.

## Solution

Engine exposes `GET /api/v1/stream` — a Server-Sent Events connection that delivers domain events plus control frames (`hello`, `ping`). The schema lives in `@trail/shared/events.ts` and is importable by any TypeScript client.

The event catalog is **additive-evolution**: adding a new `type` is safe; renaming or reshaping an existing one is breaking and needs a versioned stream (`/api/v2/stream` when we get there).

## Event catalog

### Queue events

| Type | Emitted when | Payload |
|---|---|---|
| `candidate_created` | `POST /queue/candidates` | `{ tenantId, kbId, candidateId, kind, title, status: 'pending' \| 'approved', autoApproved, confidence, createdBy }` |
| `candidate_approved` | Candidate reaches `approved` status (curator click or policy auto-approve) | `{ tenantId, kbId, candidateId, documentId, autoApproved }` |
| `candidate_rejected` | Curator clicks Reject | `{ tenantId, kbId, candidateId, reason }` |

### Ingest events

| Type | Emitted when | Payload |
|---|---|---|
| `ingest_started` | LLM compile pipeline starts on a source doc | `{ tenantId, kbId, docId, filename }` |
| `ingest_completed` | Compile finishes successfully | `{ tenantId, kbId, docId, filename }` |
| `ingest_failed` | Compile throws | `{ tenantId, kbId, docId, filename, error }` |

### Control frames

| Type | Purpose |
|---|---|
| `hello` | First frame after connection accepted. Carries `tenantId` so the client can verify its auth scope. |
| `ping` | Heartbeat every 30 s to keep intermediaries from closing the connection. Clients can safely ignore. |

## Transport

- **URL**: `GET /api/v1/stream`
- **Auth**: session cookie (admin) or `Authorization: Bearer <TRAIL_INGEST_TOKEN>` (service).
- **Scope**: events are filtered by the connection's tenant. A consumer never sees events from a tenant other than its own.
- **Keepalive**: 30 s server-side pings. The browser's native `EventSource` auto-reconnects on transient failures; service clients should implement the same behaviour.

## Client example (TypeScript)

```ts
import { isDomainEvent, type DomainEvent } from '@trail/shared';

const es = new EventSource('/api/v1/stream', { withCredentials: true });

es.onmessage = (e) => {
  const frame = JSON.parse(e.data);
  if (!isDomainEvent(frame)) return;
  handle(frame);
};

function handle(event: DomainEvent): void {
  switch (event.type) {
    case 'candidate_created':
      if (event.status === 'pending') incrementPending(event.kbId);
      break;
    case 'candidate_approved':
    case 'candidate_rejected':
      decrementPending(event.kbId);
      break;
    // ingest_* events etc.
  }
}
```

The admin's `apps/admin/src/lib/event-stream.ts` is the in-repo reference consumer — it wraps the EventSource in a shared pub/sub so any component can subscribe without opening its own connection.

## Client example (curl)

```bash
curl -N -H "Authorization: Bearer $TRAIL_INGEST_TOKEN" \
  http://127.0.0.1:58021/api/v1/stream
```

Use `-N` to disable curl's output buffering — SSE streams are line-based and want to flush as messages arrive.

## Webhook delivery (future)

F87 covers the *pull* model: consumers open a persistent connection and receive events. A *push* model — outgoing HTTPS POSTs to subscriber URLs with signed payloads + retry-on-failure — is a separate feature (to be numbered later). That feature will reuse the same event catalog: the event body that arrives over SSE is the same body that will arrive in the webhook POST. Consumers writing against `@trail/shared/events.ts` today will work with either transport.

## Impact Analysis

### Files affected

- `packages/shared/src/events.ts` — event type catalog (new)
- `apps/server/src/services/broadcast.ts` — type the emit signature against the catalog
- `apps/server/src/routes/queue.ts` — emit `candidate_created / approved / rejected`
- `apps/server/src/services/ingest.ts` — already emits `ingest_*`; no change
- `apps/admin/src/lib/event-stream.ts` — typed client + `usePendingCount` hook (new)
- `apps/admin/src/components/trail-nav.tsx` — badge on Queue tab
- `docs/features/F87-event-stream.md` — this document

### Blast radius

Low. Adding emit calls to existing routes is additive — the SSE endpoint was already live. No schema migrations, no behaviour change for clients that ignore the stream.

### Breaking changes

None. The existing `ingest_*` events were untyped but shaped the same way; typing them is a contract tightening that no correct consumer would notice.

## Implementation Steps

1. Define the event catalog in `@trail/shared/events.ts`.
2. Tighten `broadcaster.emit` signature to `StreamFrame`.
3. Emit from queue routes (create/approve/reject).
4. Admin: add `event-stream.ts` with shared EventSource + `usePendingCount`.
5. TrailNav renders the badge on Queue.
6. Document the contract (this file).

## Dependencies

- F17 Curation Queue API — provides the candidate rows that emit events.
- F19 Auto-Approval Policy — differentiates `autoApproved: true/false` on approval events.
- F06 Ingest pipeline — emits the ingest lifecycle events.

## Unlocks

- Live admin badges everywhere a count matters (Sources during processing, Neurons during compile).
- Buddy's F39 feedback loop: watches `candidate_rejected` on its own candidates to tune the summariser.
- A future webhook feature reuses this catalog end-to-end.
