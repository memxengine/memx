# F138 — Work Layer: Tasks, Bugs, Milestones

*Planned. Tier: Pro+. Effort: 3-4 days.*

> Ved siden af Knowledge-Neuroner indføres et "Work-layer" af trackbare items — tasks, bugs, milestones — der automatisk arver kontekst fra Knowledge-layer via mention-relationer. En bug-ticket til Sannes akupunktur-praksis der nævner `[[nada-protokol]]` arver dual-context (det den HANDLER om + den viden den ER knyttet til). Trail bridges fra "knowledge vault" → "vault + tracker der ved hvad den tracker om."

## Problem

Trail er i dag en ren knowledge-vault. Men reel videnspraksis — en tax-accountant's klient-portfolio, en forskers eksperimenter, et konsulenthus's engagementer — består af to lag: VIDEN der akkumulerer langsomt (fagtermer, protokoller, cases) og ARBEJDE der sker hurtigt (tasks, bugs, milestones).

De skal være samme-steds: et bug-ticket for "NADA-session dag 4 giver uventet hovedpine" har værdi PRÆCIS fordi det er koblet til Neuronerne om NADA-protokollen, abstinensbehandling og kontraindikationer. Hvis tickets lever i Linear eller Notion og Neuroner i Trail, mister begge siden af relationen halvdelen af konteksten.

Waykee Cortex løser det med "dual-context inheritance": et Work-item arver automatisk kontekst fra de Knowledge-Neuroner det nævner. Det er en arkitektonisk indsigt, ikke bare en UI-feature.

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

## How

- `packages/db/src/schema.ts` — udvid documents med `work_*`-kolonner; migration
- `apps/server/src/routes/work.ts` (ny) — CRUD for Work-items, opdaterer via Queue-flow (samme invariant som Neurons)
- `apps/admin/src/panels/work.tsx` (ny) — Kanban-view med status-kolonner, filtre på assignee + kind
- Wiki-link-parser behandler `[[work-item]]`-refs ens med Neuron-refs
- F99 graph farver Work-items anderledes end Knowledge-Neuroner (fx firkantede noder vs. cirkler)
- F138 samkompatibel med F137: Work-items kan have typed edges (`blocks`, `duplicates-of`, `relates-to`)
- F130 llms.txt inkluderer en ny `## Work` sektion med åbne items grupperet på kind

## Dependencies

- F15 (document_references — allerede brugt til backlinks, genbruges til dual-context)
- F101 (type-frontmatter — Work-items får `type: task` / `type: bug` / etc.)
- F137 (typed relationships — nyttigt men ikke blocker)

## Success criteria

- Sannes KB kan indeholde 10 Work-items (fx "opdater NADA-protokol med nye 2026-reviews") der navigerer til relevante Neuroner via automatiske backlinks
- Kanban-view render ≤200ms for 1000 Work-items
- Chat-spørgsmål "hvilke åbne tasks handler om NADA?" returnerer Work-items der nævner NADA uden eksplicit tag-søgning
- Work-items flows gennem samme Curation Queue som Neurons — ingen bypass af write-invariant
