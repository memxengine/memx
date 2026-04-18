# F98 — Orphan-lint Connector-Awareness

> Orphan-Neuron detection today flags every Neuron without a `document_references` row, regardless of how the Neuron arrived. For Neurons whose provenance is external to the Trail (buddy cc-session artifacts, MCP-authored pages, chat-saved answers), "no Sources in KB" is the expected state — they were never meant to cite uploaded documents. Flagging them as orphans generates unsolvable queue work: the Auto-link-sources inferer can't find matches that don't exist, Link-manually points the curator at an editor where no relevant Source exists, and the curator ends up archiving Neurons that were perfectly valid. F98 teaches orphan-lint about connectors so it only flags Neurons for which Source citations are actually expected.

## Problem

Concrete flow today (broken):

1. Curator runs `mcp__buddy__trail_save` to persist a session insight. Buddy posts `external-feed` candidate; auto-approval commits a new Neuron at `/neurons/sessions/broberg-ai/trail/<slug>.md`. The Neuron's `frontmatter.sources: []` is empty because the reasoning came from the cc session, not an uploaded document.
2. Nightly lint runs. `detectOrphans()` in `packages/core/src/lint/orphans.ts` does a LEFT JOIN on `document_references`, finds `refCount=0` for the buddy-authored Neuron, emits a `cross-ref-suggestion` candidate tagged "Orphan Neuron: X".
3. Curator opens the queue, sees the orphan-finding with F96 Action Recommender's picked "Auto-link sources" action. Clicks Accept.
4. F90.1 inferer calls Haiku with the Neuron content + the KB's Source list. Zero Sources match because the Neuron is about buddy's internals, not Sanne's clinical material. Inferer returns `[]`. Server returns 422 `no_sources_inferred`.
5. Admin shows "Auto-link couldn't find a clear match" toast. Curator clicks Show options. Picks Link-manually. Admin opens Neuron editor. No relevant Sources in sidebar. Curator gives up, archives the Neuron, loses the session insight.

That's the **exact failure mode** Karpathy's wiki-rot thesis warns about: the system has generated maintenance work the human can't resolve except by deleting content. The orphan-lint contract is wrong for these Neurons.

**Not goals:**

- Removing orphan-lint entirely. Upload-originated Neurons SHOULD be flagged when their Sources go unlinked — that's the detector's real value.
- Auto-archiving external-originated Neurons without review. The curator may legitimately want to review them; we just shouldn't manufacture an orphan-warning as the trigger.
- Extending `document_references` to carry synthetic external-source rows. Possible long-term, but adds a DB semantics fork ("does `source_document_id=null` mean external, or missing, or…?") we don't need today.

**Goal**: orphan-lint treats "external-originated Neuron without local Sources" as the expected state, not an anomaly.

## Solution

Two-pass:

1. **Forward-fix** — `detectOrphans()` skips Neurons where the originating candidate's connector is external. The connector is already recorded at candidate-creation time (F95) and persisted on `queue_candidates.metadata`. `wiki_events.sourceCandidateId` links each Neuron-creation back to its originating candidate. We join through to pull `metadata.connector` and gate the flag.

2. **Backward-cleanup** — one-shot SQL pass: mark every currently-pending `cross-ref-suggestion` candidate whose target Neuron has an external connector as `status='rejected'` with `rejection_reason='F98 cleanup: external-originated Neuron, sources-less by design'`. The candidate clears from the queue without manual review. Re-runs of orphan-lint won't re-emit them because of rule #1.

## Technical Design

### External connector set

```ts
// packages/shared/src/connectors.ts (or a tiny extension there)
/**
 * Connectors whose originating content lives OUTSIDE Trail's Source
 * uploads — cc sessions, MCP tool calls, chat answers, generic API
 * feeds. Neurons they produce are expected to have no
 * `document_references` rows; orphan-lint should skip them.
 */
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

Registry-driven. Adding a new external-originated connector (future: GitHub-issues, Slack-messages via F95 roadmap) = one entry here.

### Orphan-detector change

`detectOrphans()` currently selects wiki docs + LEFT JOIN document_references. Extend to also resolve each Neuron's originating connector and skip when external:

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
3. Parse `queue_candidates.metadata` JSON, return `recommendation.recommendedActionId` — no wait, return `metadata.connector`.
4. Return null if any step fails (treat as "unknown provenance — default to flagging, same as today").

One extra query per wiki row. Tens of Neurons at most per KB; negligible. Could batch via subquery later if detect ever shows up in flamegraphs.

### Backward-cleanup script

Runs once at next engine boot after F98 lands. Wrapped in `apps/server/src/bootstrap/F98-cleanup-external-orphans.ts` — same idempotent bootstrap pattern as `rewrite-wiki-paths.ts` and `zombie-ingest.ts`:

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

Logs the affected count; one-liner, no follow-up needed.

### UI — no change

Orphan-lint stops emitting the false-positive findings. F96 Action Recommender stops seeing them. F90.1 Auto-link stops being asked to infer on impossible inputs. The Accept-failure state from F96's recent recommendationFailed flag becomes a genuinely-rare edge case (upload-originated Neurons whose Sources were archived or renamed).

### Data integrity

Orphan findings emitted for `upload` / `curator` connectors stay exactly as before — F98 narrows the detector's scope, doesn't change its behaviour for the cases it still flags. The `fingerprint` de-dup remains intact: `lint:orphan-neuron:<docId>:v<version>`.

If an external-originated Neuron is later rewritten to cite a real Source (curator edits frontmatter to add `sources: ["UploadedFile.pdf"]`), the reference-extractor writes a `document_references` row at save time, and `refCount>0` on the next lint pass — the detector's normal path. F98's skip only matters when `refCount=0`.

## Implementation Plan

1. **Shared export** — add `EXTERNAL_CONNECTORS` + `isExternalConnector()` to `packages/shared/src/connectors.ts`.
2. **Orphan-detector** — `packages/core/src/lint/orphans.ts` gets `resolveOriginatingConnector(trail, docId)` helper + connector-aware skip in the wiki-row loop. Tests updated so a buddy-authored Neuron with zero refs is skipped.
3. **Bootstrap cleanup** — `apps/server/src/bootstrap/F98-cleanup-external-orphans.ts` runs the SQL above, logs count. Wired into `apps/server/src/index.ts` alongside the other bootstrap routines.
4. **Smoke test** — `scripts/trail restart`; tail engine log for the cleanup count + subsequent lint run; confirm pending `cross-ref-suggestion` count in DB dropped.
5. **Doc** — update `docs/FEATURES.md` row for F98 and this feature's entry in the `Descriptions` section (Done).

## Testing

- Unit (orphans.test.ts): create buddy-authored Neuron with no refs → `detectOrphans` returns 0 findings for it; upload-authored Neuron with no refs → still flagged.
- Integration: bootstrap cleanup on seed DB with mixed candidates; assert only `cross-ref-suggestion` rows targeting external Neurons flip to rejected.
- Regression: orphan-lint still fires for upload-originated Neurons (existing behaviour unchanged for the 80% case).
- Manual: refresh the admin Queue on the live dev KB; verify the ~30-50 buddy/MCP orphan-findings from earlier in April 2026 no longer appear pending.

## Unlocks

- F96 Action Recommender's accuracy scores improve (false-positive orphans were skewing the "auto-link recommended but fails" rate).
- F97 Activity Log can surface "Lint skipped N external-originated Neurons this pass" as a health signal if we want visibility later.
- Future connectors (Slack, Discord, Notion, GitHub, Linear from F95's roadmap) inherit correct behaviour by default — add to `EXTERNAL_CONNECTORS` and orphan-lint already knows not to flag their Neurons.

## Open questions

1. **What about `source-retraction` candidates that target external-originated Neurons?** Those shouldn't exist in practice (retractions apply to uploaded Sources), but worth verifying there's no leak between the two paths. Not blocking; audit in step 4.
2. **Should curator be able to opt back INTO orphan-lint for their external Neurons?** Maybe a per-Trail setting later if anyone asks. Not in MVP.
3. **What about legacy Neurons with no connector in metadata at all?** (Pre-F95 data backfilled by heuristic to "upload"/"api"/etc.) Treated as today's default — still flagged when `refCount=0`. If the heuristic mislabeled some as `buddy`, they'll get the F98 skip — acceptable; worst case the curator re-runs orphan-lint after manually setting the right connector.

## Why this is its own F-doc

The fix is small (~20 LOC + SQL). But the *reasoning* is load-bearing: Trail's lint rules aren't universal — they're contract-specific to the pathway a Neuron came from. Writing that down means future lint detectors (staleness, gap-detection, contradiction) can consult the same connector-aware contract rather than re-litigating "should I flag this?" at each site. Makes F95 Connectors' payoff visible: attribution isn't just for UI chrome, it's a first-class input to validation logic.
