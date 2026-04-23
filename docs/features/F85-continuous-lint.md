# F85 — Continuous Lint (Real-Time, Not Periodic)

> Lint runs per-commit, not per-cron. Enables "pending contradiction" warnings in the editor rather than after the fact.

## Problem

F32's lint pass kører periodisk (hver 6. time). Det betyder at contradictions, orphans, og gaps ikke opdages før næste lint cycle. For en curator der lige har godkendt en ændring der introducerer en contradiction, er 6 timer for lang ventetid.

## Solution

Lint detectors køres også **real-time** ved specifikke events:
1. **On candidate approve** — check for contradictions with existing Neurons before applying
2. **On source upload** — check for gaps (does this source fill any known gaps?)
3. **On neuron edit** — check for broken links (do `[[wiki-links]]` still resolve?)

Resultaterne vises som inline warnings i editoren og som "pending" lint findings i queue'en.

## Technical Design

### 1. Real-Time Lint Triggers

```typescript
// packages/core/src/lint/realtime.ts

import { detectContradictions } from './contradictions.js';
import { detectOrphans } from './orphans.js';
import { detectStale } from './stale.js';

export interface RealTimeLintResult {
  warnings: LintWarning[];
  blocking: LintWarning[]; // Must be resolved before proceeding
}

export interface LintWarning {
  type: 'contradiction' | 'broken-link' | 'orphan' | 'gap-filled';
  severity: 'info' | 'warning' | 'error';
  message: string;
  /** If blocking, the action required to proceed */
  requiredAction?: string;
}

/**
 * Run lint checks when a candidate is about to be approved.
 * Returns warnings (info) and blocking issues (must resolve first).
 */
export async function lintOnApprove(
  trail: TrailDatabase,
  candidate: QueueCandidate,
  kbId: string,
): Promise<RealTimeLintResult> {
  const warnings: LintWarning[] = [];
  const blocking: LintWarning[] = [];

  // Check for contradictions with existing Neurons
  if (candidate.neuronId) {
    const contradictions = await detectContradictionsForNeuron(trail, candidate.neuronId, kbId);
    for (const c of contradictions) {
      warnings.push({
        type: 'contradiction',
        severity: 'warning',
        message: `Potential contradiction with "${c.conflictingNeuronTitle}"`,
      });
    }
  }

  // Check for broken wiki-links in the candidate content
  if (candidate.body) {
    const links = parseWikiLinks(candidate.body);
    const resolved = await resolveWikiLinks(trail, links, kbId, candidate.tenantId);
    for (const r of resolved) {
      if (!r.exists) {
        warnings.push({
          type: 'broken-link',
          severity: 'info',
          message: `Link to "${r.link.pagePath}" not found`,
        });
      }
    }
  }

  return { warnings, blocking };
}

/**
 * Run lint checks when a source is uploaded.
 */
export async function lintOnUpload(
  trail: TrailDatabase,
  sourceId: string,
  kbId: string,
): Promise<RealTimeLintResult> {
  const warnings: LintWarning[] = [];

  // Check if this source fills any known gaps
  const gaps = await trail.db
    .select()
    .from(queueCandidates)
    .where(and(
      eq(queueCandidates.knowledgeBaseId, kbId),
      eq(queueCandidates.kind, 'gap_suggestion'),
      eq(queueCandidates.status, 'pending'),
    ))
    .all();

  for (const gap of gaps) {
    const topic = (gap.metadata as any)?.topic;
    // Simple check: does source content mention the gap topic?
    const source = await trail.db.select().from(documents).where(eq(documents.id, sourceId)).get();
    if (source?.content?.toLowerCase().includes(topic?.toLowerCase())) {
      warnings.push({
        type: 'gap-filled',
        severity: 'info',
        message: `This source may address the gap: "${topic}"`,
      });
    }
  }

  return { warnings, blocking: [] };
}
```

### 2. Integration with Queue Approve

```typescript
// apps/server/src/routes/queue.ts — add pre-approve lint

import { lintOnApprove } from '@trail/core';

// In the approve handler:
const lintResult = await lintOnApprove(trail, candidate, kbId);

if (lintResult.blocking.length > 0) {
  return c.json({
    error: 'Approval blocked',
    blocking: lintResult.blocking,
    warnings: lintResult.warnings,
  }, 409);
}

// Proceed with approval (warnings are logged but don't block)
if (lintResult.warnings.length > 0) {
  console.log(`[lint] warnings for candidate ${candidate.id}:`, lintResult.warnings);
}
```

### 3. Editor Warnings

```typescript
// apps/admin/src/components/editor-warnings.tsx

import { h } from 'preact';

export function EditorWarnings({ warnings }: { warnings: LintWarning[] }) {
  if (warnings.length === 0) return null;

  return h('div', { class: 'editor-warnings' }, [
    h('div', { class: 'warnings-header' }, '⚠ Lint Warnings'),
    ...warnings.map((w) =>
      h('div', { class: `warning-item ${w.severity}` }, [
        h('span', { class: 'warning-type' }, w.type),
        h('span', { class: 'warning-message' }, w.message),
      ])
    ),
  ]);
}
```

## Impact Analysis

### Files created (new)
- `packages/core/src/lint/realtime.ts` — real-time lint triggers
- `apps/admin/src/components/editor-warnings.tsx` — inline warnings UI

### Files modified
- `apps/server/src/routes/queue.ts` — pre-approve lint check
- `apps/server/src/routes/uploads.ts` — post-upload lint check
- `apps/admin/src/components/neuron-editor.tsx` — show warnings

### Downstream dependents for modified files

**`apps/server/src/routes/queue.ts`** — adding pre-approve lint is additive. Existing approve flow gets an extra check.

### Blast radius
- Real-time lint adds latency to approve/upload operations — should be async where possible
- Contradiction detection on approve may be slow for large KBs — consider sampling
- Warnings are non-blocking by default — only `blocking` issues prevent approval

### Breaking changes
None.

### Test plan
- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Unit: `lintOnApprove` detects contradictions
- [ ] Unit: `lintOnApprove` detects broken links
- [ ] Unit: `lintOnUpload` detects gap-filled sources
- [ ] Integration: Approve candidate with contradiction → warning shown
- [ ] Integration: Approve candidate with blocking issue → approval blocked
- [ ] Integration: Upload source that fills gap → info warning shown
- [ ] Regression: Approve without issues works unchanged

## Implementation Steps

1. Create real-time lint module
2. Integrate pre-approve lint into queue route
3. Integrate post-upload lint into upload route
4. Create editor warnings component
5. Integration test: approve with warnings → warnings shown
6. Test blocking issues prevent approval

## Dependencies

- F32 (Lint Pass) — reuses lint detectors
- F23 (Wiki-Link Parser) — broken link detection
- F57 (Gap Suggestions) — gap-filled detection

## Effort Estimate

**Small** — 1-2 days

- Day 1: Real-time lint module + integration
- Day 2: Editor warnings UI + testing
