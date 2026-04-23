# F75 — Undo / Redo via Event Stream

> One-click revert of any approved change. Emits a new event, doesn't mutate history. Wired into the curator UI.

## Problem

Når en curator godkender en ændring der viser sig at være forkert, er der ingen "fortryd" knap. Den eneste mulighed er manuelt at edit'e Neuron'en tilbage — men det efterlader ingen spor af hvad der blev fortrudt, og det er besværligt for store ændringer.

## Solution

Da `wiki_events` (F16) allerede gemmer full-payload events, kan undo implementeres som en **ny event** der genopretter den forrige tilstand. Historien muteres ikke — der tilføjes blot en "undo" event der peger på den event der fortrydes.

Redo er den inverse: en ny event der genopretter tilstanden efter undo'en.

## Technical Design

### 1. Undo Operation

```typescript
// packages/core/src/events/undo.ts

import { wikiEvents, documents } from '@trail/db';
import { eq, and, lte, orderBy, desc } from 'drizzle-orm';

export interface UndoResult {
  /** The new event created for the undo */
  undoEventId: string;
  /** The version restored to */
  restoredVersion: number;
  /** The content that was restored */
  restoredContent: string;
}

export async function undoEvent(
  trail: TrailDatabase,
  docId: string,
  targetEventId: string,
  actorId: string,
): Promise<UndoResult> {
  // Get the target event
  const targetEvent = await trail.db
    .select()
    .from(wikiEvents)
    .where(eq(wikiEvents.id, targetEventId))
    .get();

  if (!targetEvent) {
    throw new Error('Event not found');
  }

  // Get the state BEFORE the target event (the previous event's payload)
  const previousEvents = await trail.db
    .select()
    .from(wikiEvents)
    .where(and(
      eq(wikiEvents.documentId, docId),
      lte(wikiEvents.createdAt, targetEvent.createdAt),
    ))
    .orderBy(desc(wikiEvents.createdAt))
    .all();

  // The event before the target is what we want to restore to
  const targetIndex = previousEvents.findIndex((e) => e.id === targetEventId);
  const restoreEvent = previousEvents[targetIndex + 1]; // Event before target

  const restoredContent = restoreEvent
    ? (restoreEvent.payload as any)?.content
    : null;
  const restoredVersion = restoreEvent ? restoreEvent.version : 0;

  // Create a new "undo" event that restores the previous state
  const undoEventId = crypto.randomUUID();
  await trail.db.insert(wikiEvents).values({
    id: undoEventId,
    documentId: docId,
    version: targetEvent.version + 1,
    type: 'undo',
    payload: JSON.stringify({
      content: restoredContent,
      title: (restoreEvent?.payload as any)?.title,
      undoneEventId: targetEventId,
      reason: 'Curator undo',
    }),
    actorId,
    prevEventId: previousEvents[0]?.id ?? null, // Link to current latest event
    createdAt: new Date().toISOString(),
  }).run();

  // Update document to restored state
  await trail.db
    .update(documents)
    .set({
      content: restoredContent,
      title: (restoreEvent?.payload as any)?.title,
      version: targetEvent.version + 1,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(documents.id, docId))
    .run();

  return {
    undoEventId,
    restoredVersion,
    restoredContent: restoredContent ?? '',
  };
}
```

### 2. Redo Operation

```typescript
// packages/core/src/events/redo.ts

export async function redoEvent(
  trail: TrailDatabase,
  docId: string,
  undoEventId: string,
  actorId: string,
): Promise<UndoResult> {
  const undoEvent = await trail.db
    .select()
    .from(wikiEvents)
    .where(eq(wikiEvents.id, undoEventId))
    .get();

  if (!undoEvent || undoEvent.type !== 'undo') {
    throw new Error('Not an undo event');
  }

  // The undone event ID is stored in the undo event's payload
  const undoneEventId = (undoEvent.payload as any)?.undoneEventId;
  const undoneEvent = await trail.db
    .select()
    .from(wikiEvents)
    .where(eq(wikiEvents.id, undoneEventId))
    .get();

  if (!undoneEvent) {
    throw new Error('Undone event not found');
  }

  // Redo = re-apply the undone event's content
  const redoneContent = (undoneEvent.payload as any)?.content;

  const redoEventId = crypto.randomUUID();
  await trail.db.insert(wikiEvents).values({
    id: redoEventId,
    documentId: docId,
    version: undoEvent.version + 1,
    type: 'redo',
    payload: JSON.stringify({
      content: redoneContent,
      title: (undoneEvent.payload as any)?.title,
      redoneEventId: undoneEventId,
      reason: 'Curator redo',
    }),
    actorId,
    prevEventId: undoEvent.id,
    createdAt: new Date().toISOString(),
  }).run();

  await trail.db
    .update(documents)
    .set({
      content: redoneContent,
      title: (undoneEvent.payload as any)?.title,
      version: undoEvent.version + 1,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(documents.id, docId))
    .run();

  return {
    undoEventId: redoEventId,
    restoredVersion: undoEvent.version + 1,
    restoredContent: redoneContent ?? '',
  };
}
```

### 3. Endpoint

```typescript
// apps/server/src/routes/undo.ts

export const undoRoutes = new Hono();

undoRoutes.post('/documents/:docId/undo/:eventId', async (c) => {
  const trail = getTrail(c);
  const user = getUser(c);
  const docId = c.req.param('docId');
  const eventId = c.req.param('eventId');

  const result = await undoEvent(trail, docId, eventId, user.id);
  return c.json(result);
});

undoRoutes.post('/documents/:docId/redo/:undoEventId', async (c) => {
  const trail = getTrail(c);
  const user = getUser(c);
  const docId = c.req.param('docId');
  const undoEventId = c.req.param('undoEventId');

  const result = await redoEvent(trail, docId, undoEventId, user.id);
  return c.json(result);
});
```

### 4. Admin UI: Undo/Redo Buttons

```typescript
// apps/admin/src/components/document-actions.tsx

// In the document view, show undo/redo buttons for each event:
h('div', { class: 'event-actions' }, [
  h('button', {
    class: 'btn btn-sm',
    onClick: () => handleUndo(event.id),
    title: 'Undo this change',
  }, '↩ Undo'),
  canRedo && h('button', {
    class: 'btn btn-sm',
    onClick: () => handleRedo(undoEventId),
    title: 'Redo this change',
  }, '↪ Redo'),
]);
```

## Impact Analysis

### Files created (new)
- `packages/core/src/events/undo.ts` — undo logic
- `packages/core/src/events/redo.ts` — redo logic
- `apps/server/src/routes/undo.ts` — undo/redo endpoints
- `apps/admin/src/components/document-actions.tsx` — undo/redo UI

### Files modified
- `apps/server/src/app.ts` — mount undo routes
- `apps/admin/src/components/version-timeline.tsx` — add undo/redo buttons per event

### Downstream dependents for modified files

**`apps/server/src/app.ts`** is imported by 4 files (see F20 analysis). Adding undo routes is additive.

**`apps/admin/src/panels/neuron-editor.tsx`** is imported by 1 file (1 ref):
- `apps/admin/src/app.tsx` (1 ref) — renders editor panel, unaffected by adding undo/redo buttons

### Blast radius
- Undo creates a new event — history is never mutated
- Redo only works on undo events (type='undo')
- Multiple undos are supported (each creates a new event)

### Breaking changes
None.

### Test plan
- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Unit: `undoEvent` restores previous version correctly
- [ ] Unit: `undoEvent` creates new event with type='undo'
- [ ] Unit: `redoEvent` re-applies undone event's content
- [ ] Integration: Undo → document content restored → new event created
- [ ] Integration: Redo → document content re-applied → new event created
- [ ] Integration: Undo button appears in version timeline
- [ ] Regression: Existing event history unchanged

## Implementation Steps

1. Create undo module + unit tests
2. Create redo module + unit tests
3. Create undo/redo endpoints
4. Add undo/redo buttons to version timeline
5. Integration test: undo → verify content restored → verify new event
6. Test multiple undos in sequence

## Dependencies

- F16 (Wiki Events) — undo/redo relies on wiki_events full-payload storage
- F74 (Time-Travel Queries) — shares event replay logic

## Effort Estimate

**Small** — 1-2 days

- Day 1: Undo + redo logic + unit tests
- Day 2: Endpoints + UI + integration testing
