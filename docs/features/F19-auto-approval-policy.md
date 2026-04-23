# F19 — Auto-Approval Policy Engine

> En regelbaseret policy engine der automatisk godkender queue candidates der opfylder bestemte kriterier — trusted pipeline + høj confidence + ingen contradictions — uden at springe queue'en over (audit trail bevares).

## Problem

I dag skal hver eneste queue candidate manuelt godkendes af en curator. For en KB med 50+ kilder der ingestes dagligt, bliver det en flaskehals. Mange candidates er lav-risiko: Markdown-filer fra trusted upload, høj confidence auto-summaries, eller kandidater der ikke strider mod eksisterende wiki.

Manuel godkendelse af alt er ikke skalerbart. Men helt at fjerne queue'en ødelægger audit trail og curatorens kontrol. Løsningen er en policy engine der auto-godkender lav-risiko candidates — men stadig logerer dem i queue'en så curatoren kan se hvad der skete.

## Solution

En `shouldAutoApprove(candidate)` funktion der evaluerer hver pending candidate mod en konfigurerbar policy. Hvis policyen matcher, bliver candidate auto-godkendt — men den går stadig gennem queue-flowet (status → `approved`, `autoApprovedAt` sættes, `approvedBy` = `system`). Curatoren kan stadig se auto-approved candidates i queue-historikken og fortryde (reopen).

Policyen er per-KB og konfigureres via `lint_policy` kolonnen (udvides fra F90's simple `trusting`/`strict` til en JSON policy).

## Technical Design

### 1. Policy Schema

```typescript
// packages/shared/src/auto-approval-policy.ts

export interface AutoApprovalPolicy {
  /** Enable auto-approval (default: false) */
  enabled: boolean;

  /** Minimum confidence score for auto-approval (0-1, default: 0.8) */
  minConfidence: number;

  /** Auto-approve candidates from these connectors (default: ['upload', 'mcp:claude-code']) */
  trustedConnectors: string[];

  /** Auto-approve candidates of these kinds (default: ['auto-summary']) */
  trustedKinds: string[];

  /** Never auto-approve if candidate contradicts existing Neurons (default: true) */
  blockOnContradiction: boolean;

  /** Max candidates auto-approved per hour per KB (default: 50, 0 = unlimited) */
  rateLimitPerHour: number;

  /** Auto-dismiss lint findings below this severity (default: 'low') */
  autoDismissLintBelow: 'low' | 'medium' | 'high';
}

export const DEFAULT_POLICY: AutoApprovalPolicy = {
  enabled: false,
  minConfidence: 0.8,
  trustedConnectors: ['upload', 'mcp:claude-code', 'mcp:cursor'],
  trustedKinds: ['auto-summary'],
  blockOnContradiction: true,
  rateLimitPerHour: 50,
  autoDismissLintBelow: 'low',
};
```

### 2. Policy Evaluation

```typescript
// packages/core/src/queue/auto-approve.ts

import { DEFAULT_POLICY, type AutoApprovalPolicy } from '@trail/shared';
import { queueCandidates, documents } from '@trail/db';
import { and, eq, gt, lt } from 'drizzle-orm';

export async function shouldAutoApprove(
  trail: TrailDatabase,
  candidate: QueueCandidate,
  policy: AutoApprovalPolicy = DEFAULT_POLICY,
): Promise<boolean> {
  if (!policy.enabled) return false;

  // Check connector trust
  const connector = (candidate.metadata as any)?.connector;
  if (!policy.trustedConnectors.includes(connector)) return false;

  // Check kind trust
  if (!policy.trustedKinds.includes(candidate.kind)) return false;

  // Check confidence
  const confidence = (candidate.metadata as any)?.recommendation?.confidence;
  if (confidence !== undefined && confidence < policy.minConfidence) return false;

  // Check contradictions
  if (policy.blockOnContradiction) {
    const hasContradiction = await hasActiveContradictions(trail, candidate);
    if (hasContradiction) return false;
  }

  // Check rate limit
  if (policy.rateLimitPerHour > 0) {
    const recentCount = await countRecentAutoApprovals(trail, candidate.knowledgeBaseId, 60);
    if (recentCount >= policy.rateLimitPerHour) return false;
  }

  return true;
}

async function hasActiveContradictions(
  trail: TrailDatabase,
  candidate: QueueCandidate,
): Promise<boolean> {
  // Check if there are any pending contradiction lint findings for this KB
  const contradictions = await trail.db
    .select()
    .from(queueCandidates)
    .where(and(
      eq(queueCandidates.knowledgeBaseId, candidate.knowledgeBaseId),
      eq(queueCandidates.kind, 'lint:contradiction'),
      eq(queueCandidates.status, 'pending'),
    ))
    .all();

  return contradictions.length > 0;
}

async function countRecentAutoApprovals(
  trail: TrailDatabase,
  kbId: string,
  minutes: number,
): Promise<number> {
  const cutoff = new Date(Date.now() - minutes * 60 * 1000).toISOString();

  const result = await trail.db
    .select({ count: sql<number>`count(*)` })
    .from(queueCandidates)
    .where(and(
      eq(queueCandidates.knowledgeBaseId, kbId),
      eq(queueCandidates.status, 'approved'),
      eq(queueCandidates.autoApproved, true),
      gt(queueCandidates.autoApprovedAt, cutoff),
    ))
    .get();

  return result?.count ?? 0;
}
```

### 3. Integration with Queue Resolve

```typescript
// apps/server/src/routes/queue.ts — modify resolve handler

import { shouldAutoApprove } from '@trail/core';

// In the candidate creation handler (POST /queue/candidates):
async function createCandidate(c: Context) {
  // ... existing candidate creation logic ...

  // Check auto-approval policy
  const kb = await trail.db.select().from(knowledgeBases).where(eq(knowledgeBases.id, kbId)).get();
  const policy = kb?.lintPolicy ? JSON.parse(kb.lintPolicy) : DEFAULT_POLICY;

  if (await shouldAutoApprove(trail, candidate, policy)) {
    // Auto-approve: resolve as approved with system as approver
    await trail.db
      .update(queueCandidates)
      .set({
        status: 'approved',
        autoApproved: true,
        autoApprovedAt: new Date().toISOString(),
        resolvedAt: new Date().toISOString(),
      })
      .where(eq(queueCandidates.id, candidate.id))
      .run();

    // Still trigger the approval effect (compile to wiki)
    await resolveCandidate(trail, candidate, 'approve');

    return c.json({ ...candidate, status: 'approved', autoApproved: true }, 201);
  }

  // Normal flow: candidate stays pending
  return c.json(candidate, 201);
}
```

### 4. Lint Policy JSON Storage

```typescript
// packages/db/src/schema.ts — extend lint_policy column

// Current: lintPolicy: text('lint_policy').default('trusting')
// New: store full AutoApprovalPolicy as JSON

// Migration: convert existing 'trusting'/'strict' to policy JSON
// trusting → { enabled: true, minConfidence: 0.7, ... }
// strict → { enabled: false, ... }
```

### 5. Auto-Dismiss for Lint Findings

```typescript
// packages/core/src/queue/auto-approve.ts

export async function autoDismissLintFindings(
  trail: TrailDatabase,
  kbId: string,
  policy: AutoApprovalPolicy,
): Promise<number> {
  if (policy.autoDismissLintBelow === 'high') return 0; // Nothing to dismiss

  const severityOrder = { low: 0, medium: 1, high: 2 };
  const threshold = severityOrder[policy.autoDismissLintBelow];

  const findings = await trail.db
    .select()
    .from(queueCandidates)
    .where(and(
      eq(queueCandidates.knowledgeBaseId, kbId),
      eq(queueCandidates.status, 'pending'),
      like(queueCandidates.kind, 'lint:%'),
    ))
    .all();

  let dismissed = 0;
  for (const finding of findings) {
    const severity = (finding.metadata as any)?.severity;
    if (severity && severityOrder[severity] <= threshold) {
      await trail.db
        .update(queueCandidates)
        .set({
          status: 'dismissed',
          resolvedAt: new Date().toISOString(),
          autoApproved: true,
          autoApprovedAt: new Date().toISOString(),
        })
        .where(eq(queueCandidates.id, finding.id))
        .run();
      dismissed++;
    }
  }

  return dismissed;
}
```

## Impact Analysis

### Files created (new)
- `packages/shared/src/auto-approval-policy.ts` — policy schema + defaults
- `packages/core/src/queue/auto-approve.ts` — policy evaluation logic
- `packages/core/src/queue/__tests__/auto-approve.test.ts`

### Files modified
- `apps/server/src/routes/queue.ts` — integrate auto-approval in candidate creation
- `packages/db/src/schema.ts` — extend `lint_policy` to store full policy JSON
- `packages/db/drizzle/` — migration for lint_policy column
- `apps/admin/src/` — add policy config UI to KB settings (small addition)

### Downstream dependents for modified files

**`apps/server/src/routes/queue.ts`** — imported by `app.ts` only. Adding auto-approval check is additive — existing manual approve/reject flow unchanged.

**`packages/db/src/schema.ts`** — imported by all DB consumers. Changing `lint_policy` from simple text to JSON is backward compatible if we handle legacy values (`trusting`/`strict`) in the policy parser.

**`apps/admin/src/`** — KB settings page reads `lintPolicy`. Adding policy config UI is additive — existing display of trusting/strict still works.

### Blast radius
- Auto-approval is opt-in (default: `enabled: false`) — no change for existing KBs
- Rate limiting prevents runaway auto-approval (max 50/hour default)
- Contradiction blocking prevents auto-approval when KB has active contradictions
- Lint findings auto-dismiss only affects low/medium severity — high severity still requires curator review
- Migration from legacy `trusting`/`strict` to JSON policy must be handled carefully

### Breaking changes
None if migration handles legacy values. The `lint_policy` column changes from simple string to JSON, but we can parse both formats.

### Test plan
- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Unit: `shouldAutoApprove` returns false when policy disabled
- [ ] Unit: `shouldAutoApprove` returns true for trusted connector + high confidence
- [ ] Unit: `shouldAutoApprove` returns false when contradiction exists
- [ ] Unit: `shouldAutoApprove` respects rate limit
- [ ] Unit: `autoDismissLintFindings` dismisses low-severity, keeps high-severity
- [ ] Integration: Candidate created with trusted connector → auto-approved → appears in queue as approved
- [ ] Integration: Candidate created with untrusted connector → stays pending
- [ ] Integration: Migration from `trusting` → JSON policy works
- [ ] Regression: Manual approve/reject flow unchanged
- [ ] Regression: Queue candidate lifecycle (pending → approved/rejected/dismissed) unchanged

## Implementation Steps

1. Create `packages/shared/src/auto-approval-policy.ts` with schema + defaults
2. Create `packages/core/src/queue/auto-approve.ts` with `shouldAutoApprove()` + unit tests
3. Add `autoDismissLintFindings()` function
4. Integrate auto-approval in `apps/server/src/routes/queue.ts` candidate creation
5. Create DB migration for `lint_policy` JSON column
6. Add policy config UI to KB settings page
7. Integration tests for auto-approval flow
8. Docs: explain policy configuration

## Dependencies

- F90 (Dynamic Curator Actions) — auto-approved candidates still use F90's action system
- F95 (Connectors) — policy uses connector IDs for trust evaluation
- F98 (Orphan-lint Connector-Awareness) — lint findings use connector awareness

## Effort Estimate

**Small** — 1-2 days

- Day 1: Policy schema + evaluation logic + unit tests + queue integration
- Day 2: Migration + settings UI + integration tests
