# F56 — Wiki Freshness Scoring in Lint

> Lint overflader wiki-sider der ikke er blevet rørt i N måneder som "possibly stale". Killer feature på Business tier hvor én curator vedligeholder hundredvis af sider.

## Problem

Når en wiki vokser til hundredvis af Neurons, bliver det umuligt for curatoren at holde styr på hvilke sider der er forældede. En Neuron om "behandlingsretningslinjer 2023" kan være helt forkert i 2026, men uden nogen indikator ser den lige så gyldig ud som en nyligt opdateret side.

Karpathy's model har et freshness check via `git hash-object` — hver wiki-side gemmer SHA'en af de kilder den citerer, og et script checker om kilderne er ændret. Trail har ikke dette: vi ved ikke hvornår en Neuron sidst blev re-compileret fra sine kilder, eller om kilderne overhovedet er ændret siden.

## Solution

To freshness-signaler:

1. **Temporal freshness**: Neurons hvor `updatedAt` er ældre end N dage (configurable per KB, default 90 dage) flagges som "possibly stale" i lint pass (F32)
2. **Source freshness**: Hver Neuron gemmer en fingerprint af sine source documents (SHA-256 af content + updatedAt). Når en source ændres, flagges alle Neurons der citerer den som "source changed — recompile recommended"

Begge signaler emitteres som lint candidates til queue'en med action "Re-compile from sources".

## Technical Design

### 1. Source Fingerprint

```typescript
// packages/core/src/freshness/fingerprint.ts

import { createHash } from 'node:crypto';
import { documents, documentReferences } from '@trail/db';
import { eq, and, inArray } from 'drizzle-orm';

export interface SourceFingerprint {
  sourceId: string;
  contentHash: string;
  updatedAt: string;
}

export async function computeSourceFingerprints(
  trail: TrailDatabase,
  sourceIds: string[],
): Promise<SourceFingerprint[]> {
  const sources = await trail.db
    .select()
    .from(documents)
    .where(inArray(documents.id, sourceIds))
    .all();

  return sources.map((s) => ({
    sourceId: s.id,
    contentHash: createHash('sha256').update(s.content ?? '').digest('hex'),
    updatedAt: s.updatedAt,
  }));
}

export async function getNeuronSourceFingerprints(
  trail: TrailDatabase,
  neuronId: string,
): Promise<SourceFingerprint[]> {
  // Find all sources referenced by this neuron
  const refs = await trail.db
    .select({ sourceDocumentId: documentReferences.sourceDocumentId })
    .from(documentReferences)
    .where(eq(documentReferences.targetDocumentId, neuronId))
    .all();

  if (refs.length === 0) return [];

  return computeSourceFingerprints(
    trail,
    refs.map((r) => r.sourceDocumentId),
  );
}
```

### 2. Freshness Check

```typescript
// packages/core/src/freshness/check.ts

import { documents } from '@trail/db';
import { and, eq, isNull, lt } from 'drizzle-orm';
import { getNeuronSourceFingerprints } from './fingerprint.js';

export interface FreshnessResult {
  neuronId: string;
  neuronPath: string;
  neuronTitle: string;
  /** Days since last update */
  daysSinceUpdate: number;
  /** Whether sources have changed since last compile */
  sourcesChanged: boolean;
  /** Which sources changed */
  changedSources: string[];
  /** Overall freshness score (0-1, 1 = fresh) */
  score: number;
}

export async function checkFreshness(
  trail: TrailDatabase,
  kbId: string,
  thresholdDays: number = 90,
): Promise<FreshnessResult[]> {
  const cutoff = new Date(Date.now() - thresholdDays * 24 * 60 * 60 * 1000).toISOString();

  // Find stale neurons
  const staleNeurons = await trail.db
    .select()
    .from(documents)
    .where(and(
      eq(documents.knowledgeBaseId, kbId),
      eq(documents.kind, 'wiki'),
      isNull(documents.archived),
      lt(documents.updatedAt, cutoff),
    ))
    .all();

  const results: FreshnessResult[] = [];

  for (const neuron of staleNeurons) {
    const daysSinceUpdate = Math.floor(
      (Date.now() - new Date(neuron.updatedAt).getTime()) / (1000 * 60 * 60 * 24)
    );

    // Check if sources have changed
    const currentFingerprints = await getNeuronSourceFingerprints(trail, neuron.id);
    const storedFingerprints = (neuron.metadata as any)?.sourceFingerprints ?? [];

    const changedSources: string[] = [];
    for (const current of currentFingerprints) {
      const stored = storedFingerprints.find((s: any) => s.sourceId === current.sourceId);
      if (!stored || stored.contentHash !== current.contentHash) {
        changedSources.push(current.sourceId);
      }
    }

    // Calculate freshness score
    const temporalScore = Math.max(0, 1 - daysSinceUpdate / (thresholdDays * 2));
    const sourceScore = changedSources.length === 0 ? 1 : 0;
    const score = (temporalScore + sourceScore) / 2;

    results.push({
      neuronId: neuron.id,
      neuronPath: neuron.path,
      neuronTitle: neuron.title ?? neuron.path,
      daysSinceUpdate,
      sourcesChanged: changedSources.length > 0,
      changedSources,
      score,
    });
  }

  return results.sort((a, b) => a.score - b.score); // Least fresh first
}
```

### 3. Store Fingerprints on Compile

```typescript
// apps/server/src/services/ingest.ts — store fingerprints after compile

import { computeSourceFingerprints } from '@trail/core';

// After compiling a neuron, store source fingerprints in metadata:
const sourceIds = compiledResult.sourceReferences?.map((r) => r.sourceId) ?? [];
const fingerprints = await computeSourceFingerprints(trail, sourceIds);

await trail.db.update(documents).set({
  metadata: JSON.stringify({
    ...existingMetadata,
    sourceFingerprints: fingerprints,
  }),
}).where(eq(documents.id, docId)).run();
```

### 4. Integration with Lint Pass (F32)

```typescript
// packages/core/src/lint/freshness.ts — new lint detector

import { checkFreshness } from '../freshness/check.js';

export async function detectStaleNeurons(
  trail: TrailDatabase,
  kbId: string,
  tenantId: string,
  thresholdDays: number,
): Promise<LintFinding[]> {
  const results = await checkFreshness(trail, kbId, thresholdDays);

  return results
    .filter((r) => r.score < 0.5) // Only flag significantly stale neurons
    .map((r) => ({
      kind: 'stale' as const,
      neuronId: r.neuronId,
      neuronPath: r.neuronPath,
      severity: (r.score < 0.25 ? 'high' : 'medium') as 'high' | 'medium',
      message: r.sourcesChanged
        ? `Neuron "${r.neuronTitle}" sources have changed. ${r.changedSources.length} source(s) updated since last compile.`
        : `Neuron "${r.neuronTitle}" hasn't been updated in ${r.daysSinceUpdate} days.`,
    }));
}
```

### 5. Admin UI: Freshness Badge

```typescript
// apps/admin/src/components/freshness-badge.tsx

import { h } from 'preact';

interface FreshnessBadgeProps {
  score: number;
  daysSinceUpdate: number;
  sourcesChanged: boolean;
}

export function FreshnessBadge({ score, daysSinceUpdate, sourcesChanged }: FreshnessBadgeProps) {
  let color: string;
  let label: string;

  if (sourcesChanged) {
    color = '#f59e0b'; // amber
    label = 'Sources changed';
  } else if (score < 0.25) {
    color = '#ef4444'; // red
    label = `${daysSinceUpdate}d old`;
  } else if (score < 0.5) {
    color = '#f59e0b'; // amber
    label = `${daysSinceUpdate}d old`;
  } else {
    color = '#22c55e'; // green
    label = 'Fresh';
  }

  return h('span', {
    class: 'freshness-badge',
    style: { color, borderColor: color },
    title: `Freshness score: ${(score * 100).toFixed(0)}%`,
  }, label);
}
```

## Impact Analysis

### Files created (new)
- `packages/core/src/freshness/fingerprint.ts` — source fingerprint computation
- `packages/core/src/freshness/check.ts` — freshness evaluation
- `packages/core/src/lint/freshness.ts` — stale neuron lint detector
- `packages/core/src/freshness/__tests__/check.test.ts`
- `apps/admin/src/components/freshness-badge.tsx` — UI badge

### Files modified
- `apps/server/src/services/ingest.ts` — store source fingerprints after compile
- `packages/core/src/lint/runner.ts` — add freshness detection to lint pass
- `apps/admin/src/components/neuron-list.tsx` — show freshness badge
- `apps/admin/src/styles/freshness.css` — badge styling

### Downstream dependents for modified files

**`apps/server/src/services/ingest.ts`** — adding fingerprint storage is additive. Existing ingest flow unchanged.

**`packages/core/src/lint/runner.ts`** — adding freshness detection is additive. Existing lint checks (orphans, contradictions, stale) unchanged.

**`apps/admin/src/components/neuron-list.tsx`** — adding freshness badge is additive. Existing list rendering unchanged.

### Blast radius
- Freshness fingerprints add ~200 bytes per neuron to metadata — negligible
- Fingerprint computation on every compile adds one extra DB query per source — minimal overhead
- Lint pass now includes freshness check — may increase queue candidates for large KBs
- Business tier feature: freshness scoring is most valuable for KBs with 100+ neurons

### Breaking changes
None.

### Test plan
- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Unit: `computeSourceFingerprints` returns correct SHA-256 hashes
- [ ] Unit: `checkFreshness` identifies neurons older than threshold
- [ ] Unit: `checkFreshness` detects changed sources via fingerprint comparison
- [ ] Unit: Freshness score decreases with age and source changes
- [ ] Integration: Compile neuron → source fingerprints stored in metadata
- [ ] Integration: Update source → lint pass flags dependent neurons as stale
- [ ] Integration: Admin shows freshness badge on neuron list
- [ ] Regression: Existing lint pass (orphans, contradictions) unchanged
- [ ] Regression: Ingest flow unchanged

## Implementation Steps

1. Create `packages/core/src/freshness/fingerprint.ts` + unit tests
2. Create `packages/core/src/freshness/check.ts` + unit tests
3. Store source fingerprints in ingest service after compile
4. Create `packages/core/src/lint/freshness.ts` lint detector
5. Integrate freshness into lint runner (F32)
6. Create freshness badge component for admin UI
7. Add freshness badge to neuron list
8. Integration test: update source → lint detects → badge shows

## Dependencies

- F32 (Lint Pass) — freshness is a lint detector
- F15 (Bidirectional document_references) — used to find which neurons reference which sources
- F07 (Wiki Document Model) — freshness applies to wiki documents

## Effort Estimate

**Small** — 1-2 days

- Day 1: Fingerprint + freshness check + unit tests + ingest integration
- Day 2: Lint integration + admin UI badge + testing
