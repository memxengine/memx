# F32 — Lint Pass (Orphans / Gaps / Contradictions / Stale)

> Periodic background job der scanner hele wiki'en for health issues: orphaned Neurons, missing cross-refs, contradictions mellem kilder, og stale pages der ikke er blevet re-compiled i N måneder.

## Problem

Når wiki'en vokser til hundredvis af Neurons, bliver det umuligt for en curator at manuelt holde styr på:
- **Orphans**: Neurons uden source citations (kan være fejl eller eksterne connectors)
- **Gaps**: Spørgsmål der ikke kunne besvares fordi wiki'en mangler dækning
- **Contradictions**: To Neurons der siger modstridende ting om samme emne
- **Stale**: Neurons der ikke er blevet re-compiled i lang tid — kilder kan være ændret

Uden systematisk linting akkumuleres teknisk gæld i wiki'en: modstridende information, forældede sider, og manglende cross-refs der gør wiki'en mindre nyttig over tid.

Karpathy's model inkluderer lint som en af de tre kernoperationer (Ingest / Query / Lint). Trail har allerede F98 (orphan-lint connector-awareness) som håndterer orphans — men der er ingen samlet lint pass der kører periodisk og emitterer findings til queue'en.

## Solution

En `runLintPass(kbId)` funktion der kører som cron job (default: hver 6. time) og scanner hele KB'en i fire faser:

1. **Orphan detection** (F98 allerede implementeret) — find Neurons uden `document_references`, skip eksterne connectors
2. **Contradiction scan** — pairwise comparison af Neurons med overlappende emner, brug LLM til at detektere modstrid
3. **Gap detection** — analyser low-confidence chat queries (fra F57) og emitter gap suggestions
4. **Stale detection** — find Neurons hvor `updatedAt` er ældre end N dage (configurable per KB)

Hver finding bliver en queue candidate med den relevante action (F90): "Link to sources", "Retire Neuron", "Reconcile manually", "Re-compile", etc.

## Technical Design

### 1. Lint Runner

```typescript
// packages/core/src/lint/runner.ts

export interface LintConfig {
  /** Run orphan detection (default: true) */
  orphans: boolean;
  /** Run contradiction scan (default: true) */
  contradictions: boolean;
  /** Run stale detection (default: true) */
  stale: boolean;
  /** Days before a Neuron is considered stale (default: 90) */
  staleThresholdDays: number;
  /** Max Neurons to compare pairwise for contradictions (default: 500) */
  contradictionMaxNeurons: number;
  /** LLM model for contradiction detection (default: haiku) */
  contradictionModel: string;
}

export interface LintResult {
  orphanCount: number;
  contradictionCount: number;
  staleCount: number;
  findings: LintFinding[];
  durationMs: number;
}

export interface LintFinding {
  kind: 'orphan' | 'contradiction' | 'stale' | 'gap';
  neuronId: string;
  neuronPath: string;
  severity: 'low' | 'medium' | 'high';
  message: string;
  /** The candidate ID if this finding was already queued (for dedup) */
  existingCandidateId?: string;
}

export async function runLintPass(
  trail: TrailDatabase,
  kbId: string,
  tenantId: string,
  config: LintConfig = defaultLintConfig,
): Promise<LintResult> {
  const start = Date.now();
  const findings: LintFinding[] = [];

  if (config.orphans) {
    findings.push(...await detectOrphans(trail, kbId, tenantId));
  }
  if (config.contradictions) {
    findings.push(...await detectContradictions(trail, kbId, tenantId, config));
  }
  if (config.stale) {
    findings.push(...await detectStale(trail, kbId, tenantId, config.staleThresholdDays));
  }

  // Emit findings as queue candidates
  for (const finding of findings) {
    await emitLintFinding(trail, kbId, tenantId, finding);
  }

  return {
    orphanCount: findings.filter((f) => f.kind === 'orphan').length,
    contradictionCount: findings.filter((f) => f.kind === 'contradiction').length,
    staleCount: findings.filter((f) => f.kind === 'stale').length,
    findings,
    durationMs: Date.now() - start,
  };
}
```

### 2. Orphan Detection (F98 — already exists, wrap it)

```typescript
// packages/core/src/lint/orphans.ts — wrapper around existing F98 logic

import { detectOrphans as existingDetectOrphans } from '../lint/detect-orphans.js';

export async function detectOrphans(
  trail: TrailDatabase,
  kbId: string,
  tenantId: string,
): Promise<LintFinding[]> {
  const orphans = await existingDetectOrphans(trail, kbId);
  return orphans.map((neuron) => ({
    kind: 'orphan' as const,
    neuronId: neuron.id,
    neuronPath: neuron.path,
    severity: 'medium' as const,
    message: `Neuron "${neuron.title}" has no source citations. Consider linking it to sources or retiring it.`,
  }));
}
```

### 3. Contradiction Detection

```typescript
// packages/core/src/lint/contradictions.ts

import { documents } from '@trail/db';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { createLLMBackend } from '../llm/adapter.js';

const CONTRADICTION_PROMPT = `You are checking whether two passages from a knowledge wiki contradict each other.

Return ONLY a single line of valid JSON matching this TypeScript shape:
{ "contradicts": boolean, "newQuote"?: string, "existingQuote"?: string, "summary"?: string }

Rules:
- A contradiction means the two passages make claims that cannot both be true given standard reading.
- Differences in focus, phrasing, or coverage are NOT contradictions.
- If contradicts is true, include short direct quotes from each passage (max 200 chars each) showing the conflict.
- If contradicts is false, return {"contradicts": false}.

Passage A:
{passageA}

Passage B:
{passageB}
`;

export async function detectContradictions(
  trail: TrailDatabase,
  kbId: string,
  tenantId: string,
  config: LintConfig,
): Promise<LintFinding[]> {
  const llm = createLLMBackend(config.contradictionModel);

  // Get all wiki pages, sorted by updated date (newest first)
  const neurons = await trail.db
    .select()
    .from(documents)
    .where(and(
      eq(documents.knowledgeBaseId, kbId),
      eq(documents.kind, 'wiki'),
      isNull(documents.archived),
    ))
    .orderBy(gt(documents.updatedAt, new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()))
    .limit(config.contradictionMaxNeurons)
    .all();

  const findings: LintFinding[] = [];

  // Pairwise comparison: only compare neurons updated in the last 7 days against all others
  // This keeps the N^2 problem manageable
  const recentNeurons = neurons.filter(
    (n) => new Date(n.updatedAt) > new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  );

  for (const recent of recentNeurons) {
    for (const other of neurons) {
      if (recent.id === other.id) continue;

      // Quick filter: skip if no overlapping tags or similar titles
      if (!mightContradict(recent, other)) continue;

      const result = await llm.complete({
        system: CONTRADICTION_PROMPT
          .replace('{passageA}', truncate(recent.content, 2000))
          .replace('{passageB}', truncate(other.content, 2000)),
        maxTokens: 200,
      });

      try {
        const parsed = JSON.parse(result.text);
        if (parsed.contradicts) {
          findings.push({
            kind: 'contradiction',
            neuronId: recent.id,
            neuronPath: recent.path,
            severity: 'high',
            message: `Potential contradiction with "${other.title}": ${parsed.summary}`,
          });
        }
      } catch {
        // Skip malformed responses
      }
    }
  }

  return findings;
}

function mightContradict(a: Document, b: Document): boolean {
  // Quick heuristic: check for overlapping tags or similar title words
  const tagsA = (a.tags || '').split(',').map((t) => t.trim().toLowerCase());
  const tagsB = (b.tags || '').split(',').map((t) => t.trim().toLowerCase());
  const overlap = tagsA.filter((t) => t && tagsB.includes(t));
  if (overlap.length > 0) return true;

  // Check title similarity (share 2+ words)
  const wordsA = new Set(a.title?.toLowerCase().split(/\s+/) || []);
  const wordsB = new Set(b.title?.toLowerCase().split(/\s+/) || []);
  const sharedWords = [...wordsA].filter((w) => w.length > 3 && wordsB.has(w));
  return sharedWords.length >= 2;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '...';
}
```

### 4. Stale Detection

```typescript
// packages/core/src/lint/stale.ts

import { documents } from '@trail/db';
import { and, eq, isNull, lt } from 'drizzle-orm';

export async function detectStale(
  trail: TrailDatabase,
  kbId: string,
  tenantId: string,
  thresholdDays: number,
): Promise<LintFinding[]> {
  const cutoff = new Date(Date.now() - thresholdDays * 24 * 60 * 60 * 1000).toISOString();

  const stale = await trail.db
    .select()
    .from(documents)
    .where(and(
      eq(documents.knowledgeBaseId, kbId),
      eq(documents.kind, 'wiki'),
      isNull(documents.archived),
      lt(documents.updatedAt, cutoff),
    ))
    .all();

  return stale.map((neuron) => ({
    kind: 'stale' as const,
    neuronId: neuron.id,
    neuronPath: neuron.path,
    severity: 'low' as const,
    message: `Neuron "${neuron.title}" hasn't been updated in ${thresholdDays} days. Consider re-compiling from sources.`,
  }));
}
```

### 5. Emit Findings as Queue Candidates

```typescript
// packages/core/src/lint/emit.ts

import { queueCandidates } from '@trail/db';

const LINT_ACTIONS: Record<LintFinding['kind'], any> = {
  orphan: {
    actions: [
      { id: 'link-sources', label: 'Link to sources', effect: 'acknowledge' },
      { id: 'retire-neuron', label: 'Retire Neuron', effect: 'retire' },
      { id: 'still-relevant', label: 'Still relevant', effect: 'dismiss' },
    ],
  },
  contradiction: {
    actions: [
      { id: 'reconcile', label: 'Reconcile manually', effect: 'edit' },
      { id: 'retire-one', label: 'Retire one Neuron', effect: 'retire' },
      { id: 'both-valid', label: 'Both valid (different contexts)', effect: 'dismiss' },
    ],
  },
  stale: {
    actions: [
      { id: 'recompile', label: 'Re-compile from sources', effect: 'reingest' },
      { id: 'still-current', label: 'Still current', effect: 'dismiss' },
      { id: 'retire', label: 'Retire Neuron', effect: 'retire' },
    ],
  },
  gap: {
    actions: [
      { id: 'add-source', label: 'Add source on this topic', effect: 'acknowledge' },
      { id: 'dismiss', label: 'Not needed', effect: 'dismiss' },
    ],
  },
};

export async function emitLintFinding(
  trail: TrailDatabase,
  kbId: string,
  tenantId: string,
  finding: LintFinding,
): Promise<void> {
  // Check if this finding already exists (dedup by neuronId + kind + fingerprint)
  const fingerprint = `${finding.kind}:${finding.neuronId}`;
  const existing = await trail.db
    .select()
    .from(queueCandidates)
    .where(and(
      eq(queueCandidates.knowledgeBaseId, kbId),
      eq(queueCandidates.kind, `lint:${finding.kind}`),
    ))
    .get();

  if (existing) {
    // Update existing finding's message if changed
    // (skip for now — simple dedup by not re-emitting)
    return;
  }

  const actions = LINT_ACTIONS[finding.kind];

  await trail.db.insert(queueCandidates).values({
    id: crypto.randomUUID(),
    tenantId,
    knowledgeBaseId: kbId,
    kind: `lint:${finding.kind}`,
    status: 'pending',
    neuronId: finding.neuronId,
    title: `Lint: ${finding.kind} — ${finding.neuronPath}`,
    body: finding.message,
    actions: JSON.stringify(actions.actions),
    metadata: JSON.stringify({
      connector: 'lint',
      severity: finding.severity,
      fingerprint,
      detectedAt: new Date().toISOString(),
    }),
    autoApproved: false,
  }).run();
}
```

### 6. Cron Scheduler

```typescript
// apps/server/src/services/lint-scheduler.ts

import { runLintPass } from '@trail/core';

const LINT_INTERVAL_MS = Number(process.env.TRAIL_LINT_INTERVAL_MS ?? 6 * 60 * 60 * 1000); // 6 hours

export function startLintScheduler(trail: TrailDatabase): void {
  console.log(`[lint] scheduler started — interval: ${LINT_INTERVAL_MS / 1000 / 60} minutes`);

  setInterval(async () => {
    try {
      // Get all KBs
      const kbs = await trail.db.select().from(knowledgeBases).all();

      for (const kb of kbs) {
        console.log(`[lint] running pass for KB ${kb.name} (${kb.id})`);
        const result = await runLintPass(trail, kb.id, kb.tenantId);
        console.log(
          `[lint] ${kb.name}: ${result.orphanCount} orphans, ` +
          `${result.contradictionCount} contradictions, ` +
          `${result.staleCount} stale — ${result.durationMs}ms`,
        );
      }
    } catch (err) {
      console.error('[lint] scheduler error:', err);
    }
  }, LINT_INTERVAL_MS);
}
```

### 7. Lint Policy per KB (F90 extension)

```typescript
// packages/db/src/schema.ts — extend lint_policy

// Existing: lintPolicy: text('lint_policy').default('trusting')
// Extend to support per-KB lint config:

export interface LintPolicy {
  mode: 'trusting' | 'strict';
  /** Auto-dismiss findings below this severity */
  minSeverity: 'low' | 'medium' | 'high';
  /** Which lint checks to run */
  checks: {
    orphans: boolean;
    contradictions: boolean;
    stale: boolean;
  };
  /** Days before Neuron is considered stale */
  staleThresholdDays: number;
  /** Fingerprint of last lint run (for dedup) */
  lastLintFingerprint?: string;
}
```

## Impact Analysis

### Files created (new)
- `packages/core/src/lint/runner.ts` — main lint orchestrator
- `packages/core/src/lint/orphans.ts` — orphan detection wrapper
- `packages/core/src/lint/contradictions.ts` — pairwise contradiction scan
- `packages/core/src/lint/stale.ts` — stale Neuron detection
- `packages/core/src/lint/emit.ts` — emit findings as queue candidates
- `apps/server/src/services/lint-scheduler.ts` — cron scheduler
- `packages/core/src/lint/__tests__/runner.test.ts`
- `packages/core/src/lint/__tests__/contradictions.test.ts`

### Files modified
- `packages/core/src/index.ts` — export lint module
- `apps/server/src/app.ts` — start lint scheduler on boot
- `packages/shared/src/connectors.ts` — `lint` connector already exists (F95)
- `apps/server/src/routes/lint.ts` — extend existing lint route with runLintPass endpoint

### Downstream dependents for modified files

**`packages/core/src/index.ts`** — imported by `apps/server/src/app.ts` and `apps/mcp/src/tools.ts`. Adding lint export is additive — no breaking changes.

**`apps/server/src/app.ts`** — no downstream dependents. It's the app root.

**`apps/server/src/routes/lint.ts`** — imported by `app.ts` only. Adding new endpoint is additive.

### Blast radius
- Lint scheduler runs on boot — adds ~100ms to server startup for initial pass
- Contradiction scan is O(N*M) where N = recent neurons, M = all neurons — capped at 500 neurons max
- LLM calls for contradiction detection cost ~$0.003 per pair on Haiku — with 500 neurons and ~10% overlap rate, ~250 pairs = ~$0.75 per lint pass
- Queue can accumulate lint findings — need to ensure auto-dismiss for low-severity in trusting mode
- Existing F98 orphan detection is wrapped, not replaced — backward compatible

### Breaking changes
None. All changes are additive.

### Test plan
- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Unit: `detectStale` returns Neurons older than threshold, excludes archived
- [ ] Unit: `mightContradict` returns true for overlapping tags, false for unrelated
- [ ] Unit: `emitLintFinding` deduplicates by fingerprint
- [ ] Unit: `runLintPass` runs all configured checks, returns counts
- [ ] Integration: Lint scheduler starts on boot, runs pass after interval
- [ ] Integration: Lint findings appear in queue with correct actions (F90)
- [ ] Integration: Orphan findings respect F98 external connector exclusion
- [ ] Manual: Run lint pass on KB with known orphans → findings appear in queue
- [ ] Manual: Run lint pass on KB with known contradictions → findings appear with "Reconcile" action
- [ ] Regression: Existing F98 orphan detection still works
- [ ] Regression: Queue candidate lifecycle unchanged

## Implementation Steps

1. Create `packages/core/src/lint/` directory with runner, orphans, stale, emit modules
2. Write unit tests for each module
3. Create `contradictions.ts` with LLM-based pairwise comparison
4. Create `lint-scheduler.ts` with cron job
5. Extend existing `apps/server/src/routes/lint.ts` with `POST /lint/run` endpoint
6. Start scheduler in `app.ts` boot sequence
7. Add lint policy config to KB settings UI (F90 extension)
8. Integration tests: full lint pass → queue findings → curator resolves

## Dependencies

- F90 (Dynamic Curator Actions) — lint findings use F90's action system
- F98 (Orphan-lint Connector-Awareness) — already implemented, wrapped
- F95 (Connectors) — `lint` connector already exists
- F14 (Multi-Provider LLM Adapter) — for contradiction detection LLM calls
- F57 (Gap Suggestions) — gap detection feeds into lint findings

## Effort Estimate

**Medium** — 3-4 days

- Day 1: Core lint modules (runner, orphans wrapper, stale, emit) + unit tests
- Day 2: Contradiction detection with LLM + optimization (tag/title filtering)
- Day 3: Scheduler + endpoint + integration with queue
- Day 4: KB settings UI for lint policy + polish + integration tests
