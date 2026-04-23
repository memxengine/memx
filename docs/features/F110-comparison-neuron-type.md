# F110 — Comparison Neuron Type

> Tier: all. Effort: Small (1 day). Status: Planned.
> New `/neurons/comparisons/` hierarchy that explicitly compares two or more competing approaches side-by-side. Positive framing of what our contradiction-alerts cover as "disagreement" — not every difference is a bug; sometimes it's two valid alternatives.

## Problem

Our contradiction-lint flags when two Neurons contradict each other (negative framing: something is wrong). But often it's not a contradiction — it's two approaches that legitimately compete. Karpathy's gist: *"Comparison pages put related ideas side by side. If two papers propose competing approaches to the same problem, the LLM writes a comparison that draws out the differences."* That's positive framing.

## Secondary Pain Points

- Contradiction alerts create anxiety when the "contradiction" is actually a valid alternative approach.
- No structured way to present "when should I choose A vs B" to users.
- Chat Q&A can't find a primary citation for comparison questions.

## Solution

The ingest prompt (via F104 researcher profile) adds:

> "If this source describes an approach/method that competes with another existing Neuron's approach (without factually contradicting it), create a comparison page in `/neurons/comparisons/<topic-a-vs-topic-b>.md` that:
> - Has `type: comparison` in frontmatter
> - Starts with a one-sentence formulation of the choice (What should be chosen?)
> - Has a three-column table: Aspect | A | B
> - Links to both via `[[wiki-links]]`
> - Ends with a 'Tradeoffs' section"

## Non-Goals

- Replacing contradiction-alerts (comparisons are designed Neurons, contradictions are flags).
- Auto-generating comparisons for every pair of related Neurons (LLM decides if the difference is a comparison or contradiction).
- Comparison editing UI beyond the Neuron editor.
- Multi-way comparisons (A vs B vs C) — MVP is two-way only.

## Technical Design

### Path convention

`/neurons/comparisons/<slug>.md`

### F101 deriveType

Path prefix `/neurons/comparisons/` → `type: comparison`

### Ingest prompt addition

Added to the ingest prompt in F104 researcher profile. LLM decides whether the difference is a comparison or contradiction based on whether both can be valid simultaneously.

### Markdown structure

```markdown
---
title: "Acupuncture vs Dry Needling"
type: comparison
---

## Choice
When treating myofascial pain, should you use traditional acupuncture or dry needling?

## Comparison

| Aspect | Acupuncture | Dry Needling |
|---|---|---|
| Origin | Traditional Chinese Medicine | Western anatomy |
| Evidence | Mixed | Moderate |
| ... | ... | ... |

## Tradeoffs

- Acupuncture: holistic approach, but requires TCM training
- Dry Needling: targeted, but limited to trigger points

## Sources
- [[concept:acupuncture]]
- [[concept:dry-needling]]
```

## Interface

Internal only — no new API endpoints. Comparison pages are regular Neurons created via the existing ingest pipeline.

## Rollout

**Single-phase deploy.** Prompt change only. Existing KBs get comparison pages on next ingest. No migration needed.

## Success Criteria

- Ingest of a source suggesting an alternative to an existing concept produces a comparison page (not just a contradiction-alert).
- Comparisons have consistent markdown-table structure in frontmatter + body.
- Chat Q&A "when should I choose A vs B?" finds the comparison page as the primary citation.

## Impact Analysis

### Files created (new)

None.

### Files modified

- `apps/server/src/services/ingest.ts` (add comparison evaluation step to prompt)
- `apps/server/src/services/ingest-profiles/researcher.md` (F104 — include comparison prompt)
- `packages/shared/src/neuron-types.ts` (F101 — add 'comparison' to NeuronType union)

### Downstream dependents

`apps/server/src/services/ingest.ts` is imported by 5 files:
- `apps/server/src/routes/uploads.ts` (1 ref) — triggers ingest, prompt change is internal
- `apps/server/src/routes/knowledge-bases.ts` (1 ref) — re-ingest, prompt change is internal
- `apps/server/src/mcp/tools/ingest.ts` (1 ref) — MCP tool, prompt change is internal
- `apps/server/src/services/ingest-profiles.ts` (1 ref) — profile loading, may need comparison prompt
- `apps/server/test/ingest.test.ts` (1 ref) — test file, may need comparison fixture

`packages/shared/src/neuron-types.ts` — New file (F101). Adding 'comparison' to the union is additive.

### Blast radius

- Comparison page creation adds extra LLM work per ingest — may increase token usage slightly.
- The LLM must correctly distinguish between a comparison (both valid) and a contradiction (one is wrong). Prompt guidance is critical.
- Edge case: if a comparison page with the same slug already exists, the LLM should update it rather than create a duplicate.

### Breaking changes

None — all changes are additive.

### Test plan

- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Unit: ingest prompt includes comparison evaluation step
- [ ] Integration: ingest a source suggesting an alternative → comparison page created
- [ ] Integration: ingest a source that factually contradicts → contradiction-alert (not comparison)
- [ ] Manual: comparison page has consistent markdown-table structure
- [ ] Manual: chat Q&A "when should I choose A vs B?" finds comparison page as primary citation
- [ ] Regression: existing ingest flow completes without errors
- [ ] Regression: F101 type-frontmatter shows `type: comparison` for comparison pages

## Implementation Steps

1. **Prompt addition** — add comparison evaluation step to ingest prompt in F104 researcher profile.
2. **Type registration** — ensure 'comparison' is in the NeuronType union (F101).
3. **Test** — ingest a source suggesting an alternative, verify comparison page is created.
4. **Verify** — check chat Q&A finds comparison page as primary citation.

## Dependencies

- F101 (type-frontmatter)
- F104 (prompt profiles — comparison prompt in researcher profile)

## Open Questions

1. **Comparison slug generation.** How does the LLM decide the slug? `<topic-a>-vs-<topic-b>` format? Prompt guidance needed.
2. **Comparison vs contradiction decision.** What criteria should the LLM use? Leaning: if both approaches have valid use cases → comparison; if one is factually wrong → contradiction.
3. **Multi-way comparisons.** Should we support A vs B vs C? Defer to post-MVP.

## Related Features

- **F101** (type-frontmatter) — comparison type
- **F104** (Per-KB Prompt Profiles) — comparison prompt in researcher profile
- **F109** (Synthesis Neuron Type) — related but distinct (synthesis is thematic, comparison is side-by-side)
- **F96** (Action Recommender) — may recommend creating a comparison page

## Effort Estimate

**Small** — 1 day.

- Prompt addition: 30 min
- Type registration: 15 min
- Testing: 2 hours
- Verification: 1 hour
