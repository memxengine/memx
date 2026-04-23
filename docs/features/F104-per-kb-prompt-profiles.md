# F104 — Per-KB Prompt Profiles

> Hver KB vælger en **ingest-profil** (Researcher / Technical-Writer / Book-Reader / Business-Ops / Custom) der bestemmer hvilke Neuron-typer der produceres + hvordan compile-prompten struktureres. Trail går fra "én prompt passer alle" til "pattern matcher dit domæne". Tier: alle (default Researcher), custom er Business+. Effort: Medium (1 day). Status: Planned.

## Problem

I dag er ingest-prompten global server-side. Samme prompt bruges til Sanne's medicinske KB, webhouse-docs-KB, og en hypotetisk book-reading-KB. Balu specialiserede hans CLAUDE.md til technical writers (personas, features, products, style-rules). Karpathy's gist lister fem andre use-cases (research, book-reading, business, competitive analysis, trip planning) — hver med egne Neuron-typer.

## Secondary Pain Points

- No way to tune ingest behavior for domain-specific needs without code changes.
- Enterprise customers with specialized content (legal, medical, engineering) can't customize ingest.
- Prompt maintenance is a single point of failure — one bad change affects all KBs.

## Solution

New DB column on `knowledge_bases`:

```sql
ALTER TABLE knowledge_bases ADD COLUMN ingest_profile TEXT
  CHECK (ingest_profile IN ('researcher', 'technical-writer', 'book-reader', 'business-ops', 'custom'))
  NOT NULL DEFAULT 'researcher';
```

Plus optional `ingest_prompt_override TEXT` for the Custom profile.

Each profile name points to a template file:

```
apps/server/src/services/ingest-profiles/
├── researcher.md        nuværende prompt — concepts, entities, sources
├── technical-writer.md  + features, products, personas, style
├── book-reader.md       + characters, themes, plot-threads
├── business-ops.md      + slack-threads, meetings, decisions
└── _base.md             fælles 9-step-struktur fra F103
```

Runtime: `loadProfile(kb.ingest_profile)` fetches template + substitutes base blocks.

## Non-Goals

- Per-user prompt profiles (profiles are per-KB, not per-user).
- Real-time profile switching mid-ingest (profile is read at ingest start).
- Profile versioning or audit trail (profile changes affect only future ingests).
- LLM-based profile auto-selection (user chooses manually).
- Profile sharing between KBs (each KB has its own profile setting).

## Technical Design

### Schema migration

```sql
ALTER TABLE knowledge_bases ADD COLUMN ingest_profile TEXT
  CHECK (ingest_profile IN ('researcher', 'technical-writer', 'book-reader', 'business-ops', 'custom'))
  NOT NULL DEFAULT 'researcher';
ALTER TABLE knowledge_bases ADD COLUMN ingest_prompt_override TEXT;
```

### Profile loading

```ts
// apps/server/src/services/ingest-profiles/loader.ts
export async function loadProfile(profile: string, override?: string): Promise<string> {
  if (profile === 'custom' && override) return override;
  const base = await readFile(resolve(__dirname, '_base.md'), 'utf-8');
  const specific = await readFile(resolve(__dirname, `${profile}.md`), 'utf-8');
  return specific.replace('{{BASE}}', base);
}
```

### Profile templates

Each profile template extends the `_base.md` (9-step structure from F103) with domain-specific steps:

- **researcher.md**: adds synthesis-pages (F109), comparison-pages (F110)
- **technical-writer.md**: adds feature-pages, product-pages, persona-pages, style-rules
- **book-reader.md**: adds character-pages, theme-pages, plot-thread-pages
- **business-ops.md**: adds meeting-notes, decision-logs, slack-thread-summaries
- **custom.md**: free-form text editor in admin UI

### Admin UI

Settings > Trail adds profile-selector dropdown + "Avanceret" toggle that exposes Custom editor (Business+ only).

## Interface

### DB schema

```ts
interface KnowledgeBase {
  // ... existing fields
  ingestProfile: 'researcher' | 'technical-writer' | 'book-reader' | 'business-ops' | 'custom';
  ingestPromptOverride?: string; // only for custom profile
}
```

### Admin Settings API

```
PATCH /api/v1/knowledge-bases/:kbId/settings
Body: { ingestProfile: 'technical-writer' }
  or { ingestProfile: 'custom', ingestPromptOverride: '...' }
```

## Rollout

**Single-phase deploy.** Schema migration adds columns with defaults. Existing KBs default to 'researcher' (current behavior). Profile change affects only future ingests — existing Neurons are preserved.

## Success Criteria

- 4 built-in profiles with distinct output shapes tested on the same 3 test sources.
- Custom-profile (Business+) allows text editor in admin with live preview of prompt.
- Profile switch is reversible via audit-log (can see which profile produced which Neuron).
- Default 'researcher' profile produces identical output to current global prompt.

## Impact Analysis

### Files created (new)

- `apps/server/src/services/ingest-profiles/_base.md`
- `apps/server/src/services/ingest-profiles/researcher.md`
- `apps/server/src/services/ingest-profiles/technical-writer.md`
- `apps/server/src/services/ingest-profiles/book-reader.md`
- `apps/server/src/services/ingest-profiles/business-ops.md`
- `apps/server/src/services/ingest-profiles/loader.ts`

### Files modified

- `packages/db/src/schema.ts` (add `ingest_profile` + `ingest_prompt_override` columns)
- `apps/server/src/services/ingest.ts` (use `loadProfile()` instead of hardcoded prompt)
- `apps/admin/src/panels/settings.tsx` (add profile selector + custom editor)

### Downstream dependents

`packages/db/src/schema.ts` — Central schema file. Adding columns to `knowledge_bases` is additive (NOT NULL with DEFAULT); no downstream changes required.

`apps/server/src/services/ingest.ts` — Ingest service. Switching from hardcoded prompt to `loadProfile()` changes internal behavior but not the API surface. Downstream consumers (ingest route, MCP ingest tool) are unaffected.

`apps/admin/src/panels/settings.tsx` — Admin settings panel. Adding profile selector is additive; no downstream changes.

### Blast radius

- All changes are additive (new columns, new template files, new loader).
- Profile change affects only future ingests — existing Neurons are preserved.
- Custom profile with `ingest_prompt_override` allows arbitrary prompt text — must validate/sanitize to prevent prompt injection.
- Business+ gating for custom profile is a tier enforcement, not a technical constraint.

### Breaking changes

None — all changes are additive.

### Test plan

- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Unit: `loadProfile()` returns correct template for each built-in profile
- [ ] Unit: `loadProfile()` returns override for custom profile with override text
- [ ] Unit: default 'researcher' profile produces identical output to current global prompt
- [ ] Integration: ingest with each profile on same test source, verify distinct output shapes
- [ ] Manual: admin Settings profile selector works, custom editor saves and loads
- [ ] Regression: existing ingest flow still works with default 'researcher' profile
- [ ] Regression: existing KBs without `ingest_profile` column default to 'researcher'

## Implementation Steps

1. Add `ingest_profile` + `ingest_prompt_override` columns to `knowledge_bases` table via Drizzle migration.
2. Create profile template files in `apps/server/src/services/ingest-profiles/` (_base.md + 4 profile-specific files).
3. Implement `loadProfile()` loader in `apps/server/src/services/ingest-profiles/loader.ts`.
4. Update `apps/server/src/services/ingest.ts` to use `loadProfile(kb.ingestProfile, kb.ingestPromptOverride)` instead of hardcoded prompt.
5. Add profile selector + custom editor to admin Settings panel (Business+ gating for custom).
6. Test: ingest with each profile on same 3 test sources, verify distinct output shapes.

## Dependencies

- F103 (9-step workflow as base for all profiles)

## Open Questions

1. **Profile versioning.** If we update `researcher.md`, should existing KBs get the update or keep their version? Leaning: always use latest template (profiles are not versioned).
2. **Custom profile security.** Arbitrary prompt text in `ingest_prompt_override` — should we sanitize or limit length? Leaning: limit to 10KB, no sanitization (user is trusted admin).
3. **Profile export/import.** Should KBs be able to export their profile settings for reuse? Out of scope for MVP.

## Related Features

- **F103** (9-step ingest workflow) — base structure for all profiles
- **F109** (Synthesis Neuron Type) — synthesis-prompt in researcher.md
- **F110** (Comparison Neuron Type) — comparison-prompt in researcher.md
- **F106** (Solo Mode) — profile choice is independent of mode

## Effort Estimate

**Medium** — 1 day.

- Schema migration: 30 min
- Profile templates (4 + base): 2 hours
- Loader implementation: 30 min
- Ingest.ts update: 30 min
- Admin UI profile selector + custom editor: 2 hours
- Testing: 1 hour
