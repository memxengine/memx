# F78 — Trust Tiers + Provenance Graph (Claims Table)

> First-class `claims` table joining on F22 anchors. Per-claim trust score derived from source canonicality + curator approvals. Enables "show me only high-trust claims" filters.

## Problem

Når Trail compiler en Neuron fra flere kilder, blandes information fra forskellige trust levels: Tier 1 (forfatterens eget materiale), Tier 2 (akademisk), Tier 3 (web-klippet), Tier 4 (chat-genereret). Brugerne har ingen måde at filtrere på trust level — et claim fra en web-klippet artikel vejer lige så meget som et claim fra en peer-reviewed kilde.

For sundhedsdomæner (Sanne) er dette kritisk: et behandlingsclaim skal kunne spores til sin kilde og vurderes på troværdighed.

## Solution

En `claims` tabel der ekstraheres under compile: hvert claim i en Neuron får en row med:
- Reference til Neuron + F22 claim anchor
- Reference til source document
- Trust score beregnet fra source tier + curator approvals
- Provenance chain: claim → source → source's sources

## Technical Design

### 1. Claims Schema

```typescript
// packages/db/src/schema.ts

export const claims = sqliteTable('claims', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull().references(() => tenants.id),
  knowledgeBaseId: text('knowledge_base_id').notNull().references(() => knowledgeBases.id),
  /** The neuron this claim belongs to */
  neuronId: text('neuron_id').notNull().references(() => documents.id),
  /** F22 anchor ID for this claim */
  anchorId: text('anchor_id').notNull(),
  /** The claim text */
  text: text('text').notNull(),
  /** Source document this claim is derived from */
  sourceId: text('source_id').references(() => documents.id),
  /** Trust tier of the source (1=highest, 4=lowest) */
  trustTier: integer('trust_tier').notNull(),
  /** Computed trust score (0-1) */
  trustScore: real('trust_score').notNull(),
  /** Number of curator approvals this claim has received */
  approvalCount: integer('approval_count').default(0),
  /** Whether this claim has been flagged for contradiction */
  flagged: integer('flagged').default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});
```

### 2. Trust Score Calculation

```typescript
// packages/core/src/trust/scorer.ts

export interface TrustConfig {
  tierWeights: Record<number, number>;
  approvalBonus: number;
  contradictionPenalty: number;
}

const DEFAULT_TRUST_CONFIG: TrustConfig = {
  tierWeights: { 1: 1.0, 2: 0.8, 3: 0.5, 4: 0.2 },
  approvalBonus: 0.1,
  contradictionPenalty: 0.3,
};

export function calculateTrustScore(
  sourceTier: number,
  approvalCount: number,
  flagged: boolean,
  config: TrustConfig = DEFAULT_TRUST_CONFIG,
): number {
  let score = config.tierWeights[sourceTier] ?? 0.2;

  // Bonus for curator approvals (max 3 approvals = +0.3)
  score += Math.min(approvalCount, 3) * config.approvalBonus;

  // Penalty for contradictions
  if (flagged) score -= config.contradictionPenalty;

  return Math.max(0, Math.min(1, score));
}
```

### 3. Claim Extraction During Compile

```typescript
// packages/core/src/compile/claims.ts

import { claims } from '@trail/db';

export async function extractClaims(
  trail: TrailDatabase,
  neuronId: string,
  kbId: string,
  tenantId: string,
  content: string,
  anchors: { id: string; text: string }[],
  sourceId: string,
  sourceTier: number,
): Promise<void> {
  // Delete existing claims for this neuron
  await trail.db.delete(claims).where(eq(claims.neuronId, neuronId)).run();

  // Insert new claims from anchors
  for (const anchor of anchors) {
    const trustScore = calculateTrustScore(sourceTier, 0, false);

    await trail.db.insert(claims).values({
      id: crypto.randomUUID(),
      tenantId,
      knowledgeBaseId: kbId,
      neuronId,
      anchorId: anchor.id,
      text: anchor.text,
      sourceId,
      trustTier: sourceTier,
      trustScore,
      approvalCount: 0,
      flagged: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).run();
  }
}
```

### 4. Provenance Query

```typescript
// packages/core/src/trust/provenance.ts

export async function getClaimProvenance(
  trail: TrailDatabase,
  claimId: string,
): Promise<ProvenanceChain> {
  const claim = await trail.db.select().from(claims).where(eq(claims.id, claimId)).get();
  if (!claim) throw new Error('Claim not found');

  // Get source document
  const source = await trail.db.select().from(documents).where(eq(documents.id, claim.sourceId)).get();

  // Get source's sources (if any)
  const sourceRefs = await trail.db
    .select()
    .from(documentReferences)
    .where(eq(documentReferences.targetDocumentId, claim.sourceId))
    .all();

  return {
    claim,
    source,
    upstreamSources: sourceRefs,
  };
}
```

## Impact Analysis

### Files created (new)
- `packages/db/src/schema.ts` — claims table
- `packages/core/src/trust/scorer.ts` — trust score calculation
- `packages/core/src/trust/provenance.ts` — provenance chain query
- `packages/core/src/compile/claims.ts` — claim extraction during compile
- `packages/core/src/trust/__tests__/scorer.test.ts`

### Files modified
- `apps/server/src/services/ingest.ts` — extract claims after compile
- `apps/admin/src/components/neuron-view.tsx` — show trust score per claim
- `apps/admin/src/styles/trust.css` — trust tier styling

### Downstream dependents for modified files

**`apps/server/src/services/ingest.ts`** — adding claim extraction is additive.

### Blast radius
- Claims table grows with each compile — needs indexing on neuronId, anchorId
- Trust scores are recomputed on each compile — source tier changes propagate
- Contradiction flags update trust scores — needs trigger from F32 lint

### Breaking changes
None.

### Test plan
- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Unit: `calculateTrustScore` returns correct scores for each tier
- [ ] Unit: Approval bonus and contradiction penalty work correctly
- [ ] Integration: Compile → claims extracted with correct trust scores
- [ ] Integration: Provenance query returns full chain
- [ ] Regression: Existing ingest flow unchanged

## Implementation Steps

1. Create claims table + migration
2. Create trust scorer + unit tests
3. Create claim extraction in compile pipeline
4. Create provenance query
5. Add trust score display to neuron view
6. Integration test: compile → claims → trust scores → provenance

## Dependencies

- F22 (Stable Claim Anchors) — claims reference F22 anchors
- F32 (Lint Pass) — contradiction flags affect trust scores
- F15 (Bidirectional document_references) — provenance chain

## Effort Estimate

**Medium** — 2-3 days

- Day 1: Claims schema + trust scorer + unit tests
- Day 2: Claim extraction + provenance query
- Day 3: Admin UI + integration testing
