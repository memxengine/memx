# F158 — Idempotent Contradiction-Lint via Content-Signature Skip

> No-work-at-rest: lint scheduler skips LLM calls entirely when the (Neuron-version, peer-versions) signature hasn't changed since last scan. A brain at rest = 0 Haiku calls per pass. Tier: Phase 1 cost-efficiency · Effort: Small · Status: Planned.

## Problem

F118 (round-robin sampling) + F119 (parallelism) made the contradiction-scan **fast** — pre-fix 5.8h pass dropped to ~22 min at P=4. But every pass still fires **~1740 Haiku calls** (348 Neurons × TOP_K=5 peers) regardless of whether anything has changed.

On Christian's Claude Max Plan that's "free" but burns daily message-quota. On the future SaaS where tenants run on Anthropic API keys (F156 credits), it's pure cost waste — 1740 calls × ~$0.0003/call = ~$0.50 per pass for **zero new findings** when the brain hasn't been edited.

A brain at rest should not "drømme" — that's the principle. Christian's words: *"En hjerne der ikke får tilført nyt materiale skal ikke drømme om alt det nye"*.

The existing fingerprint-based dedup (F32) prevents alerts from re-emitting if `(docA.version, docB.version)` matches a previous candidate. So the queue stays clean. But the LLM calls still happen — we ask Haiku "do these contradict?", get an answer, then suppress the candidate because we already have one with this fingerprint. **Wasted call.**

## Secondary Pain Points

- Max-Plan users see daily message-quota burned on idle brains.
- F156 credit-paying tenants get charged for re-confirmation work that yields zero new info.
- Anthropic per-key rate-limit (50 RPM) is consumed by no-op scans, blocking legitimate ingest work.
- Lint passes scale with brain size, not change rate — wrong fundamental scaling axis.

## Solution

Add `documents.last_contradiction_scan_signature` (TEXT, nullable). Before each `scanDocForContradictions` call, compute a signature over `(neuron.id, neuron.version, [peer.id, peer.version, ...])` and compare against the stored one. **If they match: skip the LLM calls entirely.** Stamp signature + scan-time only after a real scan completes.

Signature derives from data that ONLY changes when a curator-or-policy-driven action occurs:

- `neuron.version` bumps via `approveUpdate()` (queue-approved updates) or `submitCuratorEdit()` (F91 inline edit). Never by passive reads, FTS reindex, or schema-internal changes.
- Peer set changes via Neuron creation, edit, or archive — same human/policy gates.
- FTS-re-ranking can technically shift top-K membership without content changes, but in practice the order is stable for unchanged content. F158 trades a small "stable peer-set" assumption for the no-LLM-at-rest property.

Signature shape:

```typescript
function computeContradictionSignature(
  neuron: { id: string; version: number },
  peers: Array<{ id: string; version: number }>,
): string {
  const peerSig = peers
    .map((p) => `${p.id}:v${p.version}`)
    .sort()
    .join('|');
  return sha256(`${neuron.id}:v${neuron.version}|${peerSig}`).slice(0, 16);
}
```

Skip logic in `scanDocForContradictions`:

```typescript
const sig = computeContradictionSignature(neuron, peers);
if (neuron.lastContradictionScanSignature === sig) {
  // No change since last scan — skip LLM calls entirely.
  return { skipped: true, callsSaved: peers.length };
}

// ... existing detectContradictions loop ...

await trail.db
  .update(documents)
  .set({
    lastContradictionScanAt: now,
    lastContradictionScanSignature: sig,
  })
  .where(eq(documents.id, neuron.id))
  .run();
```

**Result:** at-rest brain → 0 LLM calls per pass. Edited brain → only edited Neurons + their peers get re-scanned.

## Non-Goals

- **Capturing FTS-rank churn.** If FTS re-ranking shifts top-K membership without underlying edits, F158 may miss new pairings. The risk is real but small — Tantivy/FTS5 are deterministic for a given index state. A future F158b can add a peer-set-hash that captures rank-order if needed.
- **Skipping orphan/stale lint.** F158 only addresses contradiction-scan. Orphans and stale-detection are cheap (DB-only) and don't need this optimization.
- **Cross-KB contradictions.** Lint stays scoped per-KB (F32 design); signature is per-Neuron-within-KB.
- **Time-based forced re-scan.** Even if nothing has changed for 6 months, F158 still skips. If we ever want "re-scan all every quarter for safety", add a max-age check separately (env-knob `TRAIL_CONTRADICTION_MAX_SCAN_AGE_DAYS`). Not v1.
- **Signature versioning across model changes.** If we swap from Haiku-4.5 to Haiku-5 and want to invalidate old skips, a one-time migration zeroes out the column. Not auto-invalidated on model env change — too clever, too easy to break silently.

## Technical Design

### Schema migration 0020

```sql
ALTER TABLE `documents` ADD COLUMN `last_contradiction_scan_signature` text;
```

Nullable. Pre-F158 rows have `NULL` → first F158 pass treats them as "never scanned" → does the scan, stamps signature. After that, idempotent.

### Schema.ts

```typescript
// in documents table
lastContradictionScanSignature: text('last_contradiction_scan_signature'),
```

### Helper in contradiction-lint.ts

```typescript
import { createHash } from 'node:crypto';

export function computeContradictionSignature(
  neuronId: string,
  neuronVersion: number,
  peers: Array<{ id: string; version: number }>,
): string {
  const peerSig = peers
    .map((p) => `${p.id}:v${p.version}`)
    .sort()
    .join('|');
  const input = `${neuronId}:v${neuronVersion}|${peerSig}`;
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}
```

### scanDocForContradictions integration

Pull the current `lastContradictionScanSignature` along with the rest of the doc. Compute the new signature from the loaded peer set. Compare; bail early on match.

After successful scan, stamp both `lastContradictionScanAt` AND `lastContradictionScanSignature`. Stamp time-only on error (so flaky Neurons don't re-trigger via NULLS-FIRST F118 ordering, but signature stays empty until a successful pass).

### Logging

```
[contradiction-lint] foo.md: signature unchanged since last scan, skipping (saved 5 LLM calls)
```

Aggregate per-pass log line in scheduler:

```
[lint-scheduler] KB "Trail Research" — 98 Neurons evaluated, 12 scanned (86 skipped), 0 new findings, ~430 calls saved
```

So the operator can SEE the savings.

### Env-knob for kill-switch

`TRAIL_CONTRADICTION_FORCE_RESCAN=1` disables the skip and runs the full scan. Useful when:
- Debugging suspected false-positive skip
- Testing prompt changes (model emits different findings on same content)
- Manual sweep after a contradiction-prompt update

Default off.

## Interface

### Operator-visible

- New per-pass log line showing "calls saved"
- Env-knob `TRAIL_CONTRADICTION_FORCE_RESCAN` for opt-out

### Schema

- New column (additive, nullable). No breaking change.

## Rollout

**Single-phase deploy.** Migration is additive. First pass after deploy stamps signatures on every Neuron (still does the LLM work — like a pre-F158 pass). Second pass forward = idempotent at rest.

Christian re-enables contradiction-lint by removing `TRAIL_LINT_SKIP_CONTRADICTIONS=1` after Sanne reconciles her 39 alerts. First post-F158 pass runs the full ~22 min (P=4) scan once to populate signatures. Every subsequent pass on a quiet brain costs ~0 LLM calls.

## Success Criteria

1. **At-rest pass logs `0 calls` for unchanged Neurons.** Given a 24h period with no new candidates approved, the next lint-scheduler pass logs "0 LLM calls executed" or equivalent on the same fleet.
2. **One edit → exactly that Neuron + its TOP_K peers re-scanned.** Curator edits 1 Neuron via F91; next pass scans 1 + up to 5 peer-pairs (the Neuron's signature changed; peer-side signatures only change if THIS Neuron is in their top-K). Verified: ≤ 6 LLM calls for 1 edit.
3. **Force-rescan flag works.** `TRAIL_CONTRADICTION_FORCE_RESCAN=1 trail restart` → next pass logs full call count regardless of signatures.
4. **Existing F32 fingerprint-dedup still suppresses re-emits** when an edit triggers re-scan but produces same finding as before.
5. **Verifiable cost reduction:** measure pre/post F158 daily Haiku-call count via Anthropic dashboard or `[lint-scheduler]` log aggregation. Expect >95% reduction on quiet brains, ~20% reduction on actively-edited brains.

## Impact Analysis

### Files created (new)

- `packages/db/drizzle/0020_documents_lint_signature.sql`
- `apps/server/scripts/verify-f158-signature-skip.ts`
- `docs/features/F158-idempotent-contradiction-lint.md` (this document)

### Files modified

- `packages/db/src/schema.ts` — add `lastContradictionScanSignature` column
- `packages/db/drizzle/meta/_journal.json` — register migration 0020
- `apps/server/src/services/contradiction-lint.ts` — add `computeContradictionSignature` helper, skip logic in `scanDocForContradictions`
- `apps/server/src/services/lint-scheduler.ts` — pass through scan stats (skipped/scanned counts) for log aggregation
- `docs/FEATURES.md` + `docs/ROADMAP.md`

### Downstream dependents

- `apps/server/src/services/contradiction-lint.ts` is imported by `lint-scheduler.ts` (1 ref). Skip-logic is internal to the scan function; caller sees the same return-value shape.
- `packages/db/src/schema.ts` — additive nullable column, no breaking changes for any downstream consumer.

### Blast radius

- **False-skip risk.** If FTS re-ranks the top-K set without underlying edits (rare for SQLite FTS5 with stable index), we'd miss legitimate new pair-checks. Mitigation: TRAIL_CONTRADICTION_FORCE_RESCAN env-knob; a manual run flushes anytime the operator suspects skew.
- **Stale-signature corruption.** If a partial scan errors midway and stamps signature, we'd never re-scan that Neuron until next edit. Mitigation: only stamp signature on scan COMPLETION (success path), not error path. F118's `last_contradiction_scan_at` keeps stamping on error to prevent flaky-Neuron monopoly via NULLS-FIRST.
- **Migration cost.** Adding a TEXT column to documents is fast (instant in SQLite). No data backfill needed; NULL is treated as "never scanned" (correct semantically).

### Breaking changes

None. Additive column, additive helper, additive log line, additive env-knob.

### Test plan

- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Unit: `computeContradictionSignature` is stable for same input (same neuron-version + same peer-versions)
- [ ] Unit: `computeContradictionSignature` is order-independent in peer list (sort guarantee)
- [ ] Unit: signature differs when ANY peer's version bumps
- [ ] Integration: pass-1 scans + stamps; pass-2 with no changes skips entirely; assert 0 spawnClaude calls
- [ ] Integration: edit one Neuron's content (version bump) → its signature differs → next pass scans only it + up to 5 peer-pairs
- [ ] Integration: TRAIL_CONTRADICTION_FORCE_RESCAN=1 makes pass-2 do full scan
- [ ] Regression: F118 round-robin still works — Neurons with NULL signature come first
- [ ] Regression: F119 parallelism still applies; skip-decision is per-Neuron, not global
- [ ] Regression: F32 fingerprint-dedup still suppresses re-emits when scan does run

## Implementation Steps

1. Migration 0020 + schema.ts: add `lastContradictionScanSignature` column + journal entry
2. `apps/server/src/services/contradiction-lint.ts`: add `computeContradictionSignature` exported helper
3. `scanDocForContradictions`: load current signature alongside doc, compute new sig from loaded peers, bail early on match
4. After successful scan: stamp both `lastContradictionScanAt` AND `lastContradictionScanSignature` in the same UPDATE
5. `lint-scheduler.ts`: aggregate skipped/scanned count for log line
6. Verify-script: probe asserting at-rest pass = 0 LLM calls
7. Manual: re-enable `TRAIL_LINT_SKIP_CONTRADICTIONS=0` + restart, observe log

## Dependencies

- F32 (Lint Pass) — base contradiction-scan service
- F118 (Sampling) — round-robin column already exists; F158 adds sibling
- F119 (Parallelism) — orthogonal; F158 layers cleanly on top

## Open Questions

1. **Should the signature include `TOP_K`?** If we change `TRAIL_CONTRADICTION_TOPK` from 5 to 3, the peer set shrinks but a stale signature might still match. Recommendation: include TOP_K + model-name in the signature so any config change forces re-scan. Adds 8 bytes to the input string, no cost.
2. **Should we expose `last_contradiction_scan_signature` in admin UI?** Not for v1 — it's internal-only. Operator log-line is sufficient transparency.
3. **What about peer-set churn from FTS-rank shifts?** Accepting the small risk. Add F158b: hash of peer-set-rank as a second signature column if anyone reports false-skips.

## Related Features

- **Depends on:** F32, F118
- **Enables:** F156 (credits) — F158 dramatically reduces the credit cost of lint at idle, making "lint is free" a true claim for most brains.
- **Cross-cuts:** F119 (parallelism — F158's skip happens before pLimit, so skipped Neurons don't take a parallelism slot)

## Effort Estimate

**Small** — 0.5 day.

- Schema + helper + skip logic: 1.5 hours
- Verify-script + log aggregation: 1 hour
- Manual smoke + regression check: 1 hour
