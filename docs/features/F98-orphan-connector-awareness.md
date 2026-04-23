# F98 — Orphan-lint Connector-Awareness

> Orphan-Neuron detection skips Neurons whose originating candidate's connector is external (buddy, mcp, chat, api). These Neurons are expected to have no Source citations — flagging them as orphans generates unsolvable queue work. Tier: all. Effort: Small (2-4 hours). Status: Planned.

## Problem

Concrete broken flow today:

1. Curator runs `mcp__buddy__trail_save` to persist a session insight. Buddy posts `external-feed` candidate; auto-approval commits a new Neuron at `/neurons/sessions/broberg-ai/trail/<slug>.md`. The Neuron's `frontmatter.sources: []` is empty because the reasoning came from the cc session, not an uploaded document.
2. Nightly lint runs. `detectOrphans()` in `packages/core/src/lint/orphans.ts` does a LEFT JOIN on `document_references`, finds `refCount=0` for the buddy-authored Neuron, emits a `cross-ref-suggestion` candidate tagged "Orphan Neuron: X".
3. Curator opens the queue, sees the orphan-finding with F96 Action Recommender's picked "Auto-link sources" action. Clicks Accept.
4. F90.1 inferer calls Haiku with the Neuron content + the KB's Source list. Zero Sources match because the Neuron is about buddy's internals, not Sanne's clinical material. Inferer returns `[]`. Server returns 422 `no_sources_inferred`.
5. Admin shows "Auto-link couldn't find a clear match" toast. Curator clicks Show options. Picks Link-manually. Admin opens Neuron editor. No relevant Sources in sidebar. Curator gives up, archives the Neuron, loses the session insight.

That's the exact failure mode Karpathy's wiki-rot thesis warns about: the system generates maintenance work the human can't resolve except by deleting content.

## Secondary Pain Points

- F96 Action Recommender's accuracy scores are skewed by false-positive orphans ("auto-link recommended but fails" rate).
- Curator wastes time reviewing and archiving perfectly valid external-originated Neurons.
- Queue fills with ~30-50 buddy/MCP orphan-findings that can never be resolved.

## Solution

Two-pass approach:

1. **Forward-fix** — `detectOrphans()` skips Neurons where the originating candidate's connector is external. The connector is already recorded at candidate-creation time (F95) and persisted on `queue_candidates.metadata`. `wiki_events.sourceCandidateId` links each Neuron-creation back to its originating candidate. We join through to pull `metadata.connector` and gate the flag.

2. **Backward-cleanup** — one-shot SQL pass: mark every currently-pending `cross-ref-suggestion` candidate whose target Neuron has an external connector as `status='rejected'` with `rejection_reason='F98 cleanup: external-originated Neuron, sources-less by design'`.

## Non-Goals

- Removing orphan-lint entirely. Upload-originated Neurons SHOULD be flagged when their Sources go unlinked.
- Auto-archiving external-originated Neurons without review.
- Extending `document_references` to carry synthetic external-source rows (adds a DB semantics fork we don't need today).
- Per-Trail opt-in to orphan-lint for external Neurons (possible future setting, not MVP).

## Technical Design

### External connector set

```ts
// packages/shared/src/connectors.ts
export const EXTERNAL_CONNECTORS: readonly ConnectorId[] = [
  'buddy',
  'mcp',
  'mcp:claude-code',
  'mcp:cursor',
  'chat',
  'api',
];

export function isExternalConnector(id: string | null | undefined): boolean {
  return !!id && (EXTERNAL_CONNECTORS as readonly string[]).includes(id);
}
```

Registry-driven. Adding a new external-originated connector (future: GitHub-issues, Slack-messages) = one entry here.

### Orphan-detector change

`detectOrphans()` extends to resolve each Neuron's originating connector and skip when external:

```ts
// Pseudocode — real change is a single JOIN + filter
for (const wiki of wikiRows) {
  if (wiki.refCount > 0) continue;
  const connector = await resolveOriginatingConnector(trail, wiki.id);
  if (isExternalConnector(connector)) continue; // F98: not an anomaly
  findings.push({...});
}
```

`resolveOriginatingConnector()`:
1. Find earliest `wiki_events` row for the doc where `event_type = 'created'`.
2. Read `source_candidate_id`.
3. Parse `queue_candidates.metadata` JSON, return `metadata.connector`.
4. Return null if any step fails (treat as "unknown provenance — default to flagging, same as today").

One extra query per wiki row. Tens of Neurons at most per KB; negligible.

### Backward-cleanup script

Runs once at next engine boot after F98 lands. Wrapped in `apps/server/src/bootstrap/F98-cleanup-external-orphans.ts`:

```sql
UPDATE queue_candidates
SET status = 'rejected',
    rejection_reason = 'F98 cleanup: external-originated Neuron, sources-less by design',
    resolved_action = 'dismiss',
    reviewed_at = datetime('now'),
    reviewed_by = 'system:f98-cleanup'
WHERE status = 'pending'
  AND kind = 'cross-ref-suggestion'
  AND metadata LIKE '%"documentId":%'
  AND json_extract(metadata, '$.documentId') IN (
    SELECT we.document_id
    FROM wiki_events we
    JOIN queue_candidates src ON src.id = we.source_candidate_id
    WHERE we.event_type = 'created'
      AND json_extract(src.metadata, '$.connector') IN
          ('buddy', 'mcp', 'mcp:claude-code', 'mcp:cursor', 'chat', 'api')
  );
```

## Interface

Internal only — no public API changes. The orphan-detector's output (findings) is the only observable difference: fewer `cross-ref-suggestion` candidates for external-originated Neurons.

## Rollout

**Single-phase deploy.** The orphan-detector change is additive (skip condition). The bootstrap cleanup runs once at boot and is idempotent. No feature flag needed.

## Success Criteria

- Buddy-authored Neuron with zero refs → `detectOrphans` returns 0 findings for it.
- Upload-authored Neuron with zero refs → still flagged (existing behavior unchanged).
- Bootstrap cleanup on seed DB with mixed candidates: only `cross-ref-suggestion` rows targeting external Neurons flip to rejected.
- Pending `cross-ref-suggestion` count in DB drops by ~30-50 entries after cleanup on live dev KB.

## Impact Analysis

### Files created (new)

- `apps/server/src/bootstrap/F98-cleanup-external-orphans.ts`

### Files modified

- `packages/shared/src/connectors.ts` (add `EXTERNAL_CONNECTORS` + `isExternalConnector()`)
- `packages/core/src/lint/orphans.ts` (add `resolveOriginatingConnector` helper + connector-aware skip)
- `apps/server/src/index.ts` (wire bootstrap cleanup alongside existing routines)

### Downstream dependents

`packages/shared/src/connectors.ts` — Central connector registry. Adding `EXTERNAL_CONNECTORS` and `isExternalConnector()` is purely additive export. Existing consumers of `CONNECTORS` are unaffected.

`packages/core/src/lint/orphans.ts` — Orphan detection module. The `detectOrphans()` function is called by the lint scheduler. Adding a skip condition changes output (fewer findings) but not the function signature. Downstream consumers (queue candidate creation, F96 Action Recommender) see fewer false-positive findings — this is the intended behavior.

`apps/server/src/index.ts` — Boot entry point. Adding bootstrap cleanup call is additive; no downstream changes.

### Blast radius

- Orphan-lint stops emitting false-positive findings for external Neurons. F96 Action Recommender stops seeing them. F90.1 Auto-link stops being asked to infer on impossible inputs.
- The `fingerprint` de-dup remains intact: `lint:orphan-neuron:<docId>:v<version>`.
- If an external-originated Neuron is later rewritten to cite a real Source, `refCount>0` on the next lint pass — the detector's normal path. F98's skip only matters when `refCount=0`.
- Legacy Neurons with no connector in metadata (pre-F95 data) are treated as today's default — still flagged when `refCount=0`.

### Breaking changes

None — all changes are additive. The only behavioral change is fewer orphan findings, which is the intended fix.

### Test plan

- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Unit: create buddy-authored Neuron with no refs → `detectOrphans` returns 0 findings for it
- [ ] Unit: upload-authored Neuron with no refs → still flagged
- [ ] Unit: `isExternalConnector()` returns true for 'buddy', 'mcp:claude-code', 'chat', 'api'; false for 'upload', 'curator'
- [ ] Integration: bootstrap cleanup on seed DB with mixed candidates; assert only `cross-ref-suggestion` rows targeting external Neurons flip to rejected
- [ ] Regression: orphan-lint still fires for upload-originated Neurons (existing behaviour unchanged for the 80% case)
- [ ] Manual: refresh the admin Queue on the live dev KB; verify the ~30-50 buddy/MCP orphan-findings no longer appear pending

## Implementation Steps

1. Add `EXTERNAL_CONNECTORS` + `isExternalConnector()` to `packages/shared/src/connectors.ts`.
2. Add `resolveOriginatingConnector(trail, docId)` helper to `packages/core/src/lint/orphans.ts` + connector-aware skip in the wiki-row loop. Update tests.
3. Create `apps/server/src/bootstrap/F98-cleanup-external-orphans.ts` with the SQL cleanup, wired into `apps/server/src/index.ts` alongside other bootstrap routines.
4. Smoke test — `scripts/trail restart`; tail engine log for cleanup count + subsequent lint run; confirm pending `cross-ref-suggestion` count dropped.
5. Update `docs/FEATURES.md` row for F98 and feature entry in Descriptions section (Done).

## Dependencies

- F95 (Connectors — connector attribution on candidates, already live)

## Open Questions

1. **What about `source-retraction` candidates that target external-originated Neurons?** Those shouldn't exist in practice (retractions apply to uploaded Sources), but worth verifying there's no leak between the two paths. Not blocking; audit in step 4.
2. **Should curator be able to opt back INTO orphan-lint for their external Neurons?** Maybe a per-Trail setting later if anyone asks. Not in MVP.
3. **What about legacy Neurons with no connector in metadata at all?** (Pre-F95 data backfilled by heuristic.) Treated as today's default — still flagged when `refCount=0`. If the heuristic mislabeled some as `buddy`, they'll get the F98 skip — acceptable.

## Related Features

- **F95** (Connectors) — prerequisite, connector attribution on candidates
- **F96** (Action Recommender) — accuracy scores improve when false-positive orphans are removed
- **F97** (Activity Log) — can surface "Lint skipped N external-originated Neurons this pass" as a health signal
- **F90.1** (Auto-link Sources) — stops being asked to infer on impossible inputs

## Effort Estimate

**Small** — 2-4 hours.

- Shared export + helper: 30 min
- Orphan-detector change + tests: 1 hour
- Bootstrap cleanup script: 30 min
- Smoke test + verification: 30 min
