# F74 — Event-Sourcing: Time-Travel Queries

> "What did the wiki say in January?" Replay `wiki_events` (F16) up to a timestamp. Free feature given event-sourcing is already in place.

## Problem

Når en Neuron ændres, er den forrige version væk — medmindre man manuelt har gemt den. For compliance, debugging, og nysgerrighed vil curatorer kunne se hvad wiki'en sagde på et specifikt tidspunkt. F.eks. "hvad sagde vi om behandlingsretningslinjer før kilden blev opdateret i marts?"

## Solution

Da `wiki_events` (F16) allerede gemmer full-payload events med `prev_event_id` chain, kan vi replay'e events op til et givet timestamp og rekonstruere wiki-tilstanden på det tidspunkt. Ingen ny infrastruktur nødvendig — kun en query-layer ovenpå eksisterende data.

## Technical Design

### 1. Time-Travel Query

```typescript
// packages/core/src/events/time-travel.ts

import { wikiEvents, documents } from '@trail/db';
import { eq, and, lte, orderBy, desc } from 'drizzle-orm';

export interface TimeTravelResult {
  /** Document state at the given timestamp */
  content: string | null;
  title: string | null;
  version: number;
  /** The event that was current at this timestamp */
  lastEventId: string;
  /** Events that were applied to reach this state */
  eventCount: number;
}

export async function getDocumentAtTime(
  trail: TrailDatabase,
  docId: string,
  timestamp: string, // ISO 8601
): Promise<TimeTravelResult | null> {
  // Get all events for this document up to the timestamp
  const events = await trail.db
    .select()
    .from(wikiEvents)
    .where(and(
      eq(wikiEvents.documentId, docId),
      lte(wikiEvents.createdAt, timestamp),
    ))
    .orderBy(desc(wikiEvents.createdAt))
    .all();

  if (events.length === 0) {
    // Document didn't exist at this time
    return null;
  }

  // The most recent event before/at timestamp is the current state
  const latestEvent = events[0];
  const content = (latestEvent.payload as any)?.content ?? null;
  const title = (latestEvent.payload as any)?.title ?? null;
  const version = latestEvent.version;

  return {
    content,
    title,
    version,
    lastEventId: latestEvent.id,
    eventCount: events.length,
  };
}

export async function getDocumentChanges(
  trail: TrailDatabase,
  docId: string,
  fromTime: string,
  toTime: string,
): Promise<WikiEvent[]> {
  return trail.db
    .select()
    .from(wikiEvents)
    .where(and(
      eq(wikiEvents.documentId, docId),
      lte(wikiEvents.createdAt, toTime),
      // fromTime is exclusive
    ))
    .orderBy(wikiEvents.createdAt)
    .all();
}
```

### 2. Endpoint

```typescript
// apps/server/src/routes/time-travel.ts

export const timeTravelRoutes = new Hono();

timeTravelRoutes.get('/documents/:docId/at/:timestamp', async (c) => {
  const trail = getTrail(c);
  const docId = c.req.param('docId');
  const timestamp = c.req.param('timestamp');

  // Validate timestamp format
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(timestamp)) {
    return c.json({ error: 'Invalid timestamp format. Use ISO 8601.' }, 400);
  }

  const result = await getDocumentAtTime(trail, docId, timestamp);
  if (!result) {
    return c.json({ error: 'Document did not exist at this time' }, 404);
  }

  return c.json(result);
});

timeTravelRoutes.get('/documents/:docId/changes', async (c) => {
  const trail = getTrail(c);
  const docId = c.req.param('docId');
  const from = c.req.query('from');
  const to = c.req.query('to') ?? new Date().toISOString();

  if (!from) return c.json({ error: 'from parameter required' }, 400);

  const changes = await getDocumentChanges(trail, docId, from, to);
  return c.json({ changes, count: changes.length });
});
```

### 3. Admin UI: Version Timeline

```typescript
// apps/admin/src/components/version-timeline.tsx

import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';

export function VersionTimeline({ docId }: { docId: string }) {
  const [versions, setVersions] = useState([]);
  const [selectedVersion, setSelectedVersion] = useState(null);

  useEffect(() => {
    // Fetch document events
    fetch(`/api/v1/documents/${docId}/events`)
      .then(r => r.json())
      .then(setVersions);
  }, [docId]);

  return h('div', { class: 'version-timeline' }, [
    h('h3', {}, 'Version History'),
    h('div', { class: 'timeline' }, [
      ...versions.map((v) =>
        h('div', {
          class: `timeline-item ${selectedVersion?.id === v.id ? 'selected' : ''}`,
          onClick: () => loadVersion(v),
        }, [
          h('span', { class: 'timeline-date' }, new Date(v.createdAt).toLocaleString()),
          h('span', { class: 'timeline-version' }, `v${v.version}`),
          h('span', { class: 'timeline-author' }, v.actorEmail),
        ])
      ),
    ]),
    selectedVersion && h('div', { class: 'version-preview' }, [
      h('pre', {}, selectedVersion.content),
    ]),
  ]);
}
```

## Impact Analysis

### Files created (new)
- `packages/core/src/events/time-travel.ts` — time-travel query logic
- `apps/server/src/routes/time-travel.ts` — time-travel endpoints
- `apps/admin/src/components/version-timeline.tsx` — version history UI

### Files modified
- `apps/server/src/app.ts` — mount time-travel routes
- `apps/admin/src/components/document-view.tsx` — add version timeline tab

### Downstream dependents for modified files

All modifications are additive.

### Blast radius
- Time-travel queries read from `wiki_events` — no impact on write path
- Large documents with many events may be slow — consider pagination for event history
- Timestamps are ISO 8601 — timezone handling must be consistent

### Breaking changes
None.

### Test plan
- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Unit: `getDocumentAtTime` returns correct version for timestamp
- [ ] Unit: `getDocumentAtTime` returns null for timestamp before document existed
- [ ] Integration: GET /documents/:id/at/:timestamp returns historical content
- [ ] Integration: Version timeline shows all events for a document
- [ ] Integration: Clicking a version shows historical content
- [ ] Regression: Existing document view unchanged

## Implementation Steps

1. Create time-travel query module
2. Create time-travel endpoints
3. Add version timeline to document view
4. Integration test: query historical version → content matches
5. Test edge cases: before document existed, future timestamp

## Dependencies

- F16 (Wiki Events) — time-travel relies on wiki_events full-payload storage

## Effort Estimate

**Small** — 1-2 days

- Day 1: Time-travel query logic + endpoints + unit tests
- Day 2: Version timeline UI + integration testing
