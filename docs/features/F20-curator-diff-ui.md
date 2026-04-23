# F20 — Curator Diff UI (Before/After)

> Tre-pane view i curator dashboard: gammel version, ny version, rendered preview. Curatorer godkender/afviser **diffen**, ikke hele siden. Wired ind i wiki_events (F16) som allerede gemmer full-payload events.

## Problem

Når en curator skal reviewe en queue candidate der ændrer en eksisterende Neuron, ser de i dag kun den nye version. De skal manuelt huske eller slå op hvad den gamle version sagde for at vurdere om ændringen er korrekt. Det er kognitiv belastning der fører til fejl: curatoren godkender en ændring der overskriver vigtig eksisterende information.

For store Neurons (500+ ord) er det næsten umuligt at spotte hvad der er ændret uden et diff-værktøj.

## Solution

Når en candidate ændrer en eksisterende Neuron (command="str_replace" eller command="update"), henter vi den forrige version fra `wiki_events` (F16's `prev_event_id` chain) og viser et tre-pane diff:

```
┌─────────────────┬─────────────────┬─────────────────┐
│   BEFORE        │     DIFF        │    AFTER        │
│ (old version)   │  (highlighted)  │ (new version)   │
│                 │                 │                 │
│ # Stress        │ # Stress        │ # Stress        │
│                 │                 │                 │
│ Grad 1: ...     │ Grad 1: ...     │ Grad 1: ...     │
│                 │                 │                 │
│ Grad 2: ...     │ Grad 2: RED     │ Grad 2: RED     │
│                 │       GREEN     │       + new     │
│                 │                 │       text      │
│ Grad 3: ...     │ Grad 3: ...     │ Grad 3: ...     │
└─────────────────┴─────────────────┴─────────────────┘
```

Diff-pane bruger et standard diff-algoritme ( Myers diff) med inline highlighting: rød for fjernet tekst, grøn for tilføjet tekst.

## Technical Design

### 1. Diff Computation

```typescript
// packages/core/src/diff/compute.ts

export interface DiffLine {
  type: 'unchanged' | 'added' | 'removed';
  text: string;
  lineNumber: number;
}

export interface DiffResult {
  before: DiffLine[];
  after: DiffLine[];
  inline: DiffLine[];
  stats: {
    added: number;
    removed: number;
    unchanged: number;
  };
}

/**
 * Compute line-by-line diff between two markdown strings.
 * Uses Myers diff algorithm for optimal edit distance.
 */
export function computeDiff(before: string, after: string): DiffResult {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');

  // Simple LCS-based diff (good enough for markdown)
  const lcs = computeLCS(beforeLines, afterLines);

  const beforeDiff: DiffLine[] = [];
  const afterDiff: DiffLine[] = [];
  const inlineDiff: DiffLine[] = [];

  let bi = 0; // before index
  let ai = 0; // after index
  let li = 0; // lcs index
  let lineNum = 0;

  while (bi < beforeLines.length || ai < afterLines.length) {
    if (li < lcs.length && bi < beforeLines.length && beforeLines[bi] === lcs[li]) {
      // Unchanged line
      const line: DiffLine = { type: 'unchanged', text: beforeLines[bi], lineNumber: lineNum++ };
      beforeDiff.push(line);
      afterDiff.push({ ...line });
      inlineDiff.push(line);
      bi++; ai++; li++;
    } else if (bi < beforeLines.length && (li >= lcs.length || beforeLines[bi] !== lcs[li])) {
      // Removed line
      const line: DiffLine = { type: 'removed', text: beforeLines[bi], lineNumber: lineNum++ };
      beforeDiff.push(line);
      inlineDiff.push(line);
      bi++;
    } else if (ai < afterLines.length) {
      // Added line
      const line: DiffLine = { type: 'added', text: afterLines[ai], lineNumber: lineNum++ };
      afterDiff.push(line);
      inlineDiff.push(line);
      ai++;
    }
  }

  return {
    before: beforeDiff,
    after: afterDiff,
    inline: inlineDiff,
    stats: {
      added: inlineDiff.filter((l) => l.type === 'added').length,
      removed: inlineDiff.filter((l) => l.type === 'removed').length,
      unchanged: inlineDiff.filter((l) => l.type === 'unchanged').length,
    },
  };
}

function computeLCS<T>(a: T[], b: T[]): T[] {
  // Standard LCS dynamic programming
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to find LCS
  const result: T[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      result.unshift(a[i - 1]);
      i--; j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  return result;
}
```

### 2. Fetch Previous Version from wiki_events

```typescript
// packages/core/src/diff/history.ts

import { wikiEvents, documents } from '@trail/db';
import { eq, and } from 'drizzle-orm';

export async function getPreviousVersion(
  trail: TrailDatabase,
  neuronId: string,
  currentVersion: number,
): Promise<string | null> {
  if (currentVersion <= 1) return null; // No previous version

  // Walk back through wiki_events to find the previous version's content
  const events = await trail.db
    .select()
    .from(wikiEvents)
    .where(and(
      eq(wikiEvents.documentId, neuronId),
      eq(wikiEvents.version, currentVersion - 1),
    ))
    .orderBy(wikiEvents.createdAt)
    .all();

  if (events.length === 0) return null;

  // The last event for this version contains the full content
  const lastEvent = events[events.length - 1];
  return (lastEvent.payload as any)?.content ?? null;
}
```

### 3. Server Endpoint

```typescript
// apps/server/src/routes/diff.ts

import { Hono } from 'hono';
import { computeDiff } from '@trail/core';
import { getPreviousVersion } from '@trail/core';

export const diffRoutes = new Hono();

diffRoutes.get('/documents/:docId/diff', async (c) => {
  const trail = getTrail(c);
  const docId = c.req.param('docId');
  const version = parseInt(c.req.query('version') ?? '1');

  // Get current version content
  const doc = await trail.db
    .select()
    .from(documents)
    .where(eq(documents.id, docId))
    .get();

  if (!doc) return c.json({ error: 'Document not found' }, 404);

  const currentContent = doc.content ?? '';
  const previousContent = await getPreviousVersion(trail, docId, version);

  if (!previousContent) {
    return c.json({
      diff: null,
      message: 'No previous version available',
      current: currentContent,
    });
  }

  const diff = computeDiff(previousContent, currentContent);

  return c.json({
    diff,
    before: previousContent,
    after: currentContent,
    version,
  });
});
```

### 4. Admin UI Component

```typescript
// apps/admin/src/components/diff-view.tsx

import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';

interface DiffViewProps {
  docId: string;
  version: number;
}

export function DiffView({ docId, version }: DiffViewProps) {
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/v1/documents/${docId}/diff?version=${version}`)
      .then((r) => r.json())
      .then((data) => {
        setDiff(data.diff);
        setLoading(false);
      });
  }, [docId, version]);

  if (loading) return h('div', { class: 'diff-loading' }, 'Loading diff...');
  if (!diff) return h('div', { class: 'diff-empty' }, 'No diff available');

  return h('div', { class: 'diff-container' }, [
    h('div', { class: 'diff-stats' }, [
      h('span', { class: 'diff-added' }, `+${diff.stats.added} lines`),
      h('span', { class: 'diff-removed' }, `-${diff.stats.removed} lines`),
    ]),
    h('div', { class: 'diff-panes' }, [
      h('div', { class: 'diff-pane before' }, [
        h('h4', {}, 'Before'),
        diff.before.map((line) =>
          h('pre', { class: `diff-line ${line.type}` }, line.text)
        ),
      ]),
      h('div', { class: 'diff-pane inline' }, [
        h('h4', {}, 'Changes'),
        diff.inline.map((line) =>
          h('pre', { class: `diff-line ${line.type}` }, line.text)
        ),
      ]),
      h('div', { class: 'diff-pane after' }, [
        h('h4', {}, 'After'),
        diff.after.map((line) =>
          h('pre', { class: `diff-line ${line.type}` }, line.text)
        ),
      ]),
    ]),
  ]);
}
```

### 5. CSS Styling

```css
/* apps/admin/src/styles/diff.css */

.diff-container {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.diff-stats {
  display: flex;
  gap: 16px;
  font-size: 12px;
  font-weight: 500;
}

.diff-added { color: #16a34a; }
.diff-removed { color: #dc2626; }

.diff-panes {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 1px;
  background: var(--border);
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
}

.diff-pane {
  background: var(--bg);
  padding: 12px;
  overflow: auto;
  max-height: 400px;
}

.diff-pane h4 {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
  margin-bottom: 8px;
  position: sticky;
  top: 0;
  background: var(--bg);
  padding-bottom: 4px;
}

.diff-line {
  margin: 0;
  padding: 2px 8px;
  font-size: 12px;
  font-family: 'SF Mono', 'Fira Code', monospace;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.diff-line.added {
  background: #f0fdf4;
  color: #166534;
}

.diff-line.removed {
  background: #fef2f2;
  color: #991b1b;
}

.diff-line.unchanged {
  color: var(--text-muted);
}

@media (prefers-color-scheme: dark) {
  .diff-line.added {
    background: #14532d;
    color: #86efac;
  }
  .diff-line.removed {
    background: #450a0a;
    color: #fca5a5;
  }
}
```

### 6. Integration with Queue Card

```typescript
// apps/admin/src/components/queue-card.tsx — add diff view

// When candidate kind is 'user-correction' or 'auto-summary' that modifies existing Neuron:
// Show "View Diff" button that opens the DiffView component

{candidate.neuronId && candidate.actions?.some((a) => a.effect === 'edit') && (
  h('button', {
    class: 'btn btn-secondary btn-sm',
    onClick: () => setShowDiff(!showDiff),
  }, showDiff ? 'Hide Diff' : 'View Diff')
)}

{showDiff && candidate.neuronId && (
  h(DiffView, { docId: candidate.neuronId, version: candidate.version })
)}
```

## Impact Analysis

### Files created (new)
- `packages/core/src/diff/compute.ts` — Myers diff algorithm
- `packages/core/src/diff/history.ts` — fetch previous version from wiki_events
- `packages/core/src/diff/__tests__/compute.test.ts`
- `apps/admin/src/components/diff-view.tsx` — three-pane diff UI
- `apps/admin/src/styles/diff.css` — diff styling

### Files modified
- `packages/core/src/index.ts` — export diff module
- `apps/server/src/routes/diff.ts` — new diff endpoint (or add to documents.ts)
- `apps/server/src/app.ts` — mount diff route
- `apps/admin/src/components/queue-card.tsx` — add "View Diff" button
- `apps/admin/src/styles/main.css` — import diff.css

### Downstream dependents for modified files

**`apps/server/src/app.ts`** is imported by 4 files (4 refs):
- `apps/server/src/index.ts` (1 ref) — creates app via `createApp(trail)`, unaffected
- `apps/server/src/routes/auth.ts` (1 ref) — uses `createApp` for dev mode, unaffected
- `apps/server/src/routes/health.ts` (1 ref) — uses `createApp` for health check, unaffected
- `apps/server/src/routes/api-keys.ts` (1 ref) — uses `createApp` for API key routes, unaffected
Adding a new route mount is additive — no consumer changes needed.

**`apps/admin/src/panels/queue.tsx`** is imported by 1 file (1 ref):
- `apps/admin/src/app.tsx` (1 ref) — renders queue panel, unaffected by adding diff button

### Blast radius
- Diff computation is CPU-bound but fast for typical Neuron sizes (<500 lines)
- Three-pane layout requires minimum ~900px width — may need responsive fallback for narrow screens
- `wiki_events` must contain full payload content for diff to work — already guaranteed by F16

### Breaking changes
None.

### Test plan
- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Unit: `computeDiff` correctly identifies added/removed/unchanged lines
- [ ] Unit: `computeDiff` handles empty before/after strings
- [ ] Unit: `computeDiff` handles identical strings (all unchanged)
- [ ] Unit: `getPreviousVersion` walks wiki_events chain correctly
- [ ] Integration: GET /documents/:id/diff returns correct diff for modified Neuron
- [ ] Integration: GET /documents/:id/diff returns null for new Neuron (version 1)
- [ ] Manual: Queue card shows "View Diff" button for edit candidates
- [ ] Manual: Three-pane diff renders correctly with highlighted changes
- [ ] Manual: Dark mode diff colors are readable
- [ ] Regression: Queue approve/reject flow unchanged

## Implementation Steps

1. Create `packages/core/src/diff/compute.ts` with LCS-based diff + unit tests
2. Create `packages/core/src/diff/history.ts` to fetch previous version from wiki_events
3. Create server endpoint `GET /documents/:docId/diff`
4. Create `DiffView` component with three-pane layout
5. Add diff CSS with dark mode support
6. Integrate "View Diff" button into queue card for edit candidates
7. Manual testing with real Neuron diffs
8. Responsive fallback for narrow screens (stack panes vertically)

## Dependencies

- F16 (Wiki Events) — diff relies on wiki_events storing full-payload content
- F91 (Neuron Editor) — diff view complements the editor's before/after comparison

## Effort Estimate

**Small** — 1-2 days

- Day 1: Diff algorithm + history fetcher + server endpoint + unit tests
- Day 2: Admin UI component + CSS + queue card integration + manual testing
