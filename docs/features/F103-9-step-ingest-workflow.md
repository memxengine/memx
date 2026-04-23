# F103 — 9-step Ingest Workflow Formalization

> Trail's ingest-prompt is rewritten as a strict numbered 9-step checklist matching Balu's CLAUDE.md. No code-logic change — better LLM-adherence through clearer structure. Tier: core. Effort: Small (30 minutes). Status: Planned.

## Problem

`apps/server/src/services/ingest.ts` has an ingest-prompt with ~8 steps, but mixed prose + numbered instructions. LLM output varies more than necessary — sometimes source-summary is created, sometimes it drops directly to concept-pages. Balu's 9-step-formulation produces more consistent ingests.

## Secondary Pain Points

- Inconsistent frontmatter completeness across ingests (~70% currently).
- Log entries don't follow a greppable format.
- No explicit step for glossary updates (relies on implicit LLM behavior).

## Solution

Restructure the prompt as an explicit 1-9 list:

```
1. Read the source file from raw/
2. Discuss key takeaways; ask 1-3 clarifying questions
3. Create a summary page in /neurons/sources/ named after the source
4. Identify and update affected existing wiki pages
5. Create new entity pages (concepts, entities, personas, etc.) as warranted
6. Update /neurons/glossary.md with new or refined terms
7. Update /neurons/overview.md if the source shifts the big picture
8. Append entry to /neurons/log.md with format:
   ## [YYYY-MM-DD] ingest | <source title>
   - Pages created: ...
   - Pages updated: ...
   - Key additions: ...
9. Confirm all frontmatter includes: title, type, sources, tags, date
```

## Non-Goals

- Changing the ingest pipeline's code logic (only the prompt template changes).
- Adding new ingest steps beyond the 9 (extensibility comes via F104 prompt profiles).
- A/B testing framework infrastructure (manual A/B test is sufficient for this change).
- Per-KB prompt customization (that's F104).

## Technical Design

### Prompt template change

The prompt string in `apps/server/src/services/ingest.ts` is replaced with the 9-step format. The rest of the ingest pipeline (file reading, candidate creation, approval) is unchanged.

### A/B test methodology

Run 3 test sources through the old prompt, count Neurons created + verify frontmatter completeness. Run the same 3 sources through the new prompt. Compare results.

## Interface

Internal only — no API changes. The ingest endpoint (`POST /api/v1/knowledge-bases/:kbId/sources/upload`) behavior is unchanged; only the LLM prompt inside the ingest pipeline changes.

## Rollout

**Single-phase deploy.** Prompt change takes effect immediately on next ingest. A/B test should be run before and after to verify improvement.

## Success Criteria

- Prompt is maximum 9 numbered steps with consistent format.
- A/B test shows ≥90% frontmatter completeness after ingest (before: ~70%).
- Log entries follow unix-greppable `## [YYYY-MM-DD] ingest |` format.
- All 3 test sources produce source-summary, concept-pages, and glossary updates consistently.

## Impact Analysis

### Files created (new)

None.

### Files modified

- `apps/server/src/services/ingest.ts` (replace prompt template with 9-step format)

### Downstream dependents

`apps/server/src/services/ingest.ts` — Ingest service. Changing the prompt is a behavioral change but doesn't change the API surface. Downstream consumers (ingest route, MCP ingest tool, admin upload UI) are unaffected.

### Blast radius

- All ingests after deploy use the new prompt format.
- LLM output structure changes — existing Neurons are unaffected, only new ingests change.
- If the new prompt causes regressions (fewer Neurons created, missing pages), the change is easily reversible (git revert).

### Breaking changes

None — all changes are internal to the prompt template.

### Test plan

- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Manual: run 3 test sources through old prompt, record Neuron count + frontmatter completeness
- [ ] Manual: run same 3 test sources through new prompt, record Neuron count + frontmatter completeness
- [ ] Manual: verify log entries follow `## [YYYY-MM-DD] ingest |` format
- [ ] Manual: verify glossary.md is updated after ingest (step 6)
- [ ] Regression: existing ingest pipeline (file reading, candidate creation, approval) still works
- [ ] Regression: markdown ingest end-to-end still produces wiki pages

## Implementation Steps

1. Edit `apps/server/src/services/ingest.ts` prompt template — replace with 9-step format.
2. Run A/B test on 3 test sources: count Neurons created before/after + verify frontmatter completeness.
3. Commit with A/B results in the commit message.

## Dependencies

- F102 (glossary exists) — step 6 assumes glossary-Neuron exists
- F101 (type-frontmatter) — step 9 requires type field

## Open Questions

None — all decisions made.

## Related Features

- **F101** (type-frontmatter) — step 9 requires type field
- **F102** (Auto-maintained Glossary) — step 6 updates glossary.md
- **F104** (Per-KB Prompt Profiles) — 9-step structure becomes the base for all profiles

## Effort Estimate

**Small** — 30 minutes.

- Prompt template edit: 15 min
- A/B test: 15 min
