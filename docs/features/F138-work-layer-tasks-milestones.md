# F138 — Work Layer: Tasks, Bugs, Milestones

> Ved siden af Knowledge-Neuroner indføres et "Work-layer" af trackbare items — tasks, bugs, milestones — der automatisk arver kontekst fra Knowledge-layer via mention-relationer. En bug-ticket til Sannes akupunktur-praksis der nævner `[[nada-protokol]]` arver dual-context (det den HANDLER om + den viden den ER knyttet til). Trail bridges fra "knowledge vault" → "vault + tracker der ved hvad den tracker om." Tier: Pro+. Effort: 3-4 days. Status: Planned.

## Problem

Trail er i dag en ren knowledge-vault. Men reel videnspraksis — en tax-accountant's klient-portfolio, en forskers eksperimenter, et konsulenthus's engagementer — består af to lag: VIDEN der akkumulerer langsomt (fagtermer, protokoller, cases) og ARBEJDE der sker hurtigt (tasks, bugs, milestones).

De skal være samme-steds: et bug-ticket for "NADA-session dag 4 giver uventet hovedpine" har værdi PRÆCIS fordi det er koblet til Neuronerne om NADA-protokollen, abstinensbehandling og kontraindikationer. Hvis tickets lever i Linear eller Notion og Neuroner i Trail, mister begge siden af relationen halvdelen af konteksten.

Waykee Cortex løser det med "dual-context inheritance": et Work-item arver automatisk kontekst fra de Knowledge-Neuroner det nævner. Det er en arkitektonisk indsigt, ikke bare en UI-feature.

## Secondary Pain Points

- Ingen måde at tracke "opdater NADA-protokol med nye 2026-reviews" som en task i Trail
- Work-items i eksterne systemer (Linear, Notion) mister automatisk backlink til relevante Neuroner
- Chat kan ikke svare på "hvilke åbne bugs handler om NADA?" uden Work-layer

## Solution

Ny `kind='work'`-variant af documents med udvidet metadata:

```sql
-- New columns on documents (or separate table, TBD during impl)
ALTER TABLE documents ADD COLUMN work_status TEXT;   -- 'open' | 'in-progress' | 'done' | 'blocked'
ALTER TABLE documents ADD COLUMN work_assignee TEXT; -- user id or free-form
ALTER TABLE documents ADD COLUMN work_due_at TEXT;   -- ISO date
ALTER TABLE documents ADD COLUMN work_kind TEXT;     -- 'task' | 'bug' | 'milestone' | 'decision'
```

Work-items render i admin som en ny "Work"-tab under KB (siden af Neurons/Sources/Queue/etc.) med Kanban-view grupperet på status. Hver Work-item er en normal Neuron (markdown + frontmatter) så kompileringen / search / chat / F99 graph behandler dem som almindelige documents.

**Dual-context inheritance:**

Når compile-prompten eller chat behandler et Work-item, løser den konteksten i to pas:
1. Items mentioned via `[[neuron-links]]` → pull deres indhold som kontekst
2. Items under samme path (`/work/sanne/` under samme parent som `/neurons/concepts/akupunktur/`) → hvis parent-Neuron ligger tæt, medtag dens overview

Chat-endpoint kan svare "hvilke åbne bugs handler om NADA?" fordi Work-items der nævner `[[nada-protokol]]` automatisk er indexeret mod den Neuron via F15 document_references (allerede i place).

## Non-Goals

- Erstatte Linear, Jira, eller andre dedikerede tracker-systemer — Trail's Work-layer er for items der er tæt koblet til KB'ens viden
- Real-time collaboration på Work-items — ingen live-edit, kun async
- Gantt charts, time-tracking, eller andre projektledelses-features — ren Kanban
- Cross-KB Work-items — hvert Work-item tilhører én KB

## Technical Design

### Schema Extension

```sql
ALTER TABLE documents ADD COLUMN work_status TEXT;
ALTER TABLE documents ADD COLUMN work_assignee TEXT;
ALTER TABLE documents ADD COLUMN work_due_at TEXT;
ALTER TABLE documents ADD COLUMN work_kind TEXT;
```

### Work Routes

```typescript
// apps/server/src/routes/work.ts
// CRUD for Work-items, opdaterer via Queue-flow (samme invariant som Neurons)
```

### Kanban View

```typescript
// apps/admin/src/panels/work.tsx
// Kanban-view med status-kolonner, filtre på assignee + kind
```

### Dual-Context Resolution

```typescript
// apps/server/src/services/work-context.ts
export async function resolveWorkContext(workItem: Document): Promise<Context> {
  const mentionedNeurons = await resolveWikiLinks(workItem.content);
  const parentContext = await resolveParentPath(workItem.path);
  return { mentionedNeurons, parentContext };
}
```

## Interface

### Work Item Frontmatter

```yaml
---
title: "Opdater NADA-protokol med nye 2026-reviews"
type: task
work_status: open
work_kind: task
work_assignee: user-uuid
work_due_at: 2026-06-01
---
```

### Work API Endpoints

```
GET    /api/v1/knowledge-bases/:kbId/work?status=open&kind=task&assignee=...
POST   /api/v1/knowledge-bases/:kbId/work
PATCH  /api/v1/knowledge-bases/:kbId/work/:id
DELETE /api/v1/knowledge-bases/:kbId/work/:id
```

### Kanban View Layout

```
+---------+-------------+-----------+--------+
| Open    | In Progress | Done      | Blocked|
|         |             |           |        |
| Task 1  | Task 3      | Task 5    | Task 7 |
| Bug 2   |             |           |        |
|         |             |           |        |
| [+ New] |             |           |        |
+---------+-------------+-----------+--------+
```

## Rollout

**Single-phase deploy.** Nye kolonner på documents + ny Work-tab i admin. Eksisterende documents uden work_* kolonner er unaffected (nullable columns).

## Success Criteria

- Sannes KB kan indeholde 10 Work-items (fx "opdater NADA-protokol med nye 2026-reviews") der navigerer til relevante Neuroner via automatiske backlinks
- Kanban-view render ≤200ms for 1000 Work-items
- Chat-spørgsmål "hvilke åbne tasks handler om NADA?" returnerer Work-items der nævner NADA uden eksplicit tag-søgning
- Work-items flows gennem samme Curation Queue som Neurons — ingen bypass af write-invariant

## Impact Analysis

### Files created (new)
- `apps/server/src/routes/work.ts`
- `apps/server/src/services/work-context.ts`
- `apps/admin/src/panels/work.tsx`

### Files modified
- `packages/db/src/schema.ts` (add `work_status`, `work_assignee`, `work_due_at`, `work_kind` columns)
- `apps/server/src/app.ts` (mount work routes)
- `apps/admin/src/components/kb-nav.tsx` (add "Work" tab)
- `apps/server/src/services/chat.ts` (dual-context resolution for Work-items)
- `apps/server/src/services/ingest.ts` (compile-prompt update for Work-items)

### Downstream dependents
`packages/db/src/schema.ts` is imported by 22 files (see F131 analysis). Adding nullable columns is additive.

`apps/server/src/app.ts` is imported by 4 files (see F128 analysis). Adding route mount is additive.

### Blast radius
- Medium — nye kolonner på documents tabellen påvirker alle document-queries
- Kanban-view med 1000+ items kræver virtualisering for performance
- Edge case: Work-items med cirkulære wiki-links → infinite loop i context resolution

### Breaking changes
None — all changes are additive. Nullable columns don't affect existing rows.

### Test plan
- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Migration kører og tilføjer work_* kolonner
- [ ] POST /work opretter Work-item med work_status='open'
- [ ] Kanban-view viser Work-items grupperet efter status
- [ ] Work-item med `[[nada-protokol]]` link viser backlink til NADA Neuron
- [ ] Chat "hvilke åbne bugs handler om NADA?" returnerer relevante Work-items
- [ ] Work-item flows gennem Curation Queue (samme invariant som Neurons)
- [ ] Regression: eksisterende Neuron CRUD virker uændret

## Implementation Steps
1. Migration: tilføj work_* kolonner til documents
2. Opdater schema.ts med nye kolonner
3. Implementér work routes (CRUD via Queue-flow)
4. Implementér work-context service (dual-context resolution)
5. Byg Kanban-view i admin (work.tsx panel)
6. Tilføj "Work" tab i KB navigation
7. Opdater compile-prompt for Work-items
8. Integrér med F99 graph (Work-items farves anderledes)
9. Opdater chat endpoint med Work-item query support
10. Typecheck + test plan

## Dependencies
- F15 (document_references — allerede brugt til backlinks, genbruges til dual-context)
- F101 (type-frontmatter — Work-items får `type: task` / `type: bug` / etc.)
- F137 (typed relationships — nyttigt men ikke blocker)

## Open Questions
1. **Separate table vs. columns on documents:** Skal Work-items have deres egen tabel eller udvide documents? Fordel ved columns: samme flow (search, chat, graph). Fordel ved separate table: renere schema, ingen nullable columns på documents.
2. **Assignee model:** User ID eller free-form text? User ID giver RBAC integration, free-form er simplere for solo-brugere.

## Related Features
- **F15** (Document references) — genbruges til dual-context inheritance
- **F101** (Type frontmatter) — Work-items får type: task/bug/milestone/decision
- **F137** (Typed relationships) — Work-items kan have typed edges (blocks, duplicates-of)
- **F130** (llms.txt) — inkluderer ny `## Work` sektion med åbne items
- **F99** (Neuron graph) — Work-items farves anderledes end Knowledge-Neuroner

## Effort Estimate
**Medium** — 3-4 days
- 0.5 day: migration + schema
- 0.75 day: work routes + CRUD via Queue
- 0.5 day: work-context service (dual-context)
- 0.75 day: Kanban-view panel
- 0.25 day: KB nav tab + UI integration
- 0.25 day: compile-prompt update
- 0.25 day: chat integration + testing
