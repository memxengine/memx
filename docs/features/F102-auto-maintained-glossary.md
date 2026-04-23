# F102 — Auto-maintained Glossary Neuron

> Hver KB får en `/neurons/glossary.md` Neuron som LLM vedligeholder. Nye termer tilføjes ved hver ingest, tvetydige definitioner revideres, gamle termer ryger ikke tabt. Udskifter dagens statiske `glossary.json`-fil som aldrig har fulgt med det faktiske indhold. Tier: alle. Effort: Small (4-6 hours). Status: Planned.

## Problem

`apps/server/src/data/glossary.json` er hardcoded med 20 EN/DA-termer. Den er seed-data fra F94 og har ikke ændret sig siden. Når en KB vokser og udvikler eget vokabular (Sanne's akupunktur-termer, webhouse-CMS-feature-navne), står glossary.json stille. Karpathy's pattern + Balu's implementation har glossary.md som living artifact.

## Secondary Pain Points

- Admin UI's Glossary panel reads from a static JSON file that doesn't reflect actual KB content.
- No glossary for new KBs until manually populated.
- Glossary terms have no source attribution — can't trace which Source introduced a term.

## Solution

At KB-creation, a seed-Neuron `/neurons/glossary.md` is created with content from glossary.json (translated to DA/EN depending on `kb.language`). The ingest-prompt (step 6, F103) updates glossary.md when it encounters new or ambiguous terms. The admin UI's existing Glossary panel reads from the glossary-Neuron via the normal neuron-load path (no special-case).

```yaml
---
title: Glossary
type: glossary
---

## Akupunktur
**EN:** Traditional Chinese medicine technique inserting fine needles at specific body points.
**DA:** Traditionel kinesisk medicinsk teknik...
_Sources: [Øreakupunktur_DIFZT_2025.pdf, intro-to-tcm.pdf]_
```

## Non-Goals

- Glossary term approval workflow (terms are auto-added by LLM during ingest).
- Glossary diff/version history (glossary.md is a regular Neuron, so wiki_events handles this).
- Multi-language glossary in a single KB (glossary is in the KB's language, with EN translations as secondary).
- Glossary search across all KBs (per-KB only for MVP).

## Technical Design

### KB-creation migration

When a new KB is created, a glossary-Neuron is inserted:

```ts
// kind='wiki', path='/neurons/', filename='glossary.md'
// Content seeded from glossary.json, translated to KB language
```

For existing KBs, a one-shot migration iterates all KBs and creates `/neurons/glossary.md` as a Neuron.

### Ingest-prompt extension (step 6 of F103)

The ingest-prompt is extended with:

> "Review glossary.md — tilføj nye termer fra denne kilde, revider tvetydige definitioner baseret på denne kildes brug"

The LLM reads the current glossary.md, identifies new terms in the source, and updates the glossary accordingly.

### Glossary panel

The admin UI's existing Glossary panel reads from the glossary-Neuron via the normal neuron-load path. No special-case API needed.

### glossary.json retention

`glossary.json` is kept as a seed-content file, used ONLY at new KB-creation. After that, the glossary-Neuron is the source of truth.

## Interface

Internal only — no new API endpoints. The glossary-Neuron is loaded via the existing neuron-read endpoint (`GET /api/v1/knowledge-bases/:kbId/documents/:docId`).

## Rollout

**Single-phase deploy.** One-shot migration for existing KBs creates glossary.md Neurons. New KBs get glossary.md at creation. No feature flag needed.

## Success Criteria

- New KB gets glossary.md as a visible Neuron in wiki-tree.
- Ingest of a source that introduces a new term adds an entry to glossary.md.
- Old glossary.json terms are migrated as seed content.
- Export via F100 includes glossary.md in `wiki/`.
- Admin Glossary panel loads from glossary-Neuron (not JSON file).

## Impact Analysis

### Files created (new)

- `apps/server/src/bootstrap/F102-create-glossary-neurons.ts` (one-shot migration for existing KBs)

### Files modified

- `apps/server/src/services/ingest.ts` (extend ingest-prompt step 6 to update glossary.md)
- `apps/server/src/routes/knowledge-bases.ts` (create glossary-Neuron at KB creation)
- `apps/admin/src/panels/glossary.tsx` (read from glossary-Neuron instead of JSON file)
- `apps/server/src/index.ts` (wire bootstrap migration)

### Downstream dependents

`apps/server/src/services/ingest.ts` — Ingest service. Extending the prompt is a behavioral change but doesn't change the API surface. Downstream consumers (ingest route, MCP ingest tool) are unaffected.

`apps/server/src/routes/knowledge-bases.ts` — KB route handler. Adding glossary-Neuron creation at KB creation is additive; no downstream changes.

`apps/admin/src/panels/glossary.tsx` — Admin glossary panel. Switching from JSON file to Neuron load path changes the data source but not the UI contract. No downstream changes.

### Blast radius

- `glossary.json` is no longer the source of truth after KB creation — only seed data.
- Existing KBs without a glossary-Neuron get one created via bootstrap migration.
- Ingest-prompt change affects all future ingests — LLM will now update glossary.md.
- Admin panel switch from JSON to Neuron is transparent to the user.

### Breaking changes

None — all changes are additive. The only behavioral change is that `glossary.json` is no longer updated after KB creation.

### Test plan

- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Unit: KB creation includes glossary-Neuron with seed content
- [ ] Unit: ingest-prompt step 6 includes glossary-update instruction
- [ ] Integration: bootstrap migration creates glossary.md for all existing KBs
- [ ] Manual: ingest a source with new terms, verify glossary.md is updated
- [ ] Manual: admin Glossary panel loads from glossary-Neuron (not JSON)
- [ ] Regression: existing KB creation flow still works
- [ ] Regression: export via F100 includes glossary.md in `wiki/`

## Implementation Steps

1. Create one-shot migration `apps/server/src/bootstrap/F102-create-glossary-neurons.ts` — iterates all existing KBs, creates `/neurons/glossary.md` Neuron with seed content from glossary.json.
2. Update `apps/server/src/routes/knowledge-bases.ts` to create glossary-Neuron at KB creation.
3. Update `apps/server/src/services/ingest.ts` prompt — extend step 6 to include glossary-update instruction.
4. Update `apps/admin/src/panels/glossary.tsx` to read from glossary-Neuron via normal neuron-load path.
5. Wire bootstrap migration in `apps/server/src/index.ts`.
6. Test: create new KB, verify glossary.md appears; ingest source with new term, verify glossary.md updated.

## Dependencies

- F103 (9-step ingest workflow) — glossary-update is step 6

## Open Questions

1. **Glossary term conflicts.** What if two sources define the same term differently? Leaning: LLM merges definitions, cites both sources. Acceptable for MVP.
2. **Glossary size limits.** A very large KB could have a 500-term glossary.md. Should we paginate or split by letter? Probably not needed for MVP — Obsidian handles large files fine.
3. **Term deletion.** Should the LLM ever remove terms from the glossary? Leaning: no — terms are additive, old terms stay even if no longer referenced.

## Related Features

- **F100** (Obsidian Vault Export) — glossary.md included in `wiki/`
- **F101** (type-frontmatter) — glossary Neuron gets `type: glossary`
- **F103** (9-step ingest workflow) — glossary-update is step 6

## Effort Estimate

**Small** — 4-6 hours.

- Bootstrap migration: 1 hour
- KB creation update: 30 min
- Ingest-prompt extension: 30 min
- Admin panel update: 1 hour
- Testing: 1-2 hours
