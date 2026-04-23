# F137 — Typed Neuron Relationships

> Wiki-links er i dag én-dimensionelle: `[[wiki-link]]` siger "der er en forbindelse" men ikke HVAD forbindelsen er. Typed edges giver Neuroner første-klasses semantiske relationer — `is-a`, `contradicts`, `supersedes`, `example-of`, `caused-by`, `part-of` — så graph-visualiseringen kan farve/vægte edges, compile-prompten kan udtrække mere struktureret information, og queries som "hvad modsiger denne Neuron?" bliver mulige uden LLM-kald. Tier: alle. Effort: 1.5-2 days. Status: Planned.

## Problem

F99 Neuron-graphen (lige shippet) tegner hver `[[wiki-link]]` som en neutral edge. Det er bedre end en flad liste, men én farve / én vægt på alle kanter efterlader et stort signal på gulvet: hvilke Neuroner modsiger hinanden? Hvilke er specialiseringer af hvilke? Hvilken udskifter hvilken?

F92 tags kan ikke bære den type relation — tags er per-Neuron metadata, ikke mellem-Neuron-relationer. Mehmet Zaim's kommentar på evoailabs-artiklen fangede det præcist: "plain Wiki has a taxonomical structure but a Wiki with an ontological structure (like Semantic MediaWiki) may be more helpful — knowledge evolves from static text into a dynamic Knowledge Graph."

Sage-Wiki (xoai) demonstrerer gevinsten: typed-entity-system med `is-a` / `contradicts` forhindrer LLM'en i at oprette duplikater af samme koncept under forskellige navne, fordi pipeline kan tjekke om et nyt koncept er en specialisering af et eksisterende.

## Secondary Pain Points

- Ingen måde at query "find alle modsigelser i KB'en" uden LLM-kald
- Compile-prompten kan ikke instruere LLM'en i at producere strukturerede relationer
- Graph-visualiseringen har ingen semantisk information at farve/vægte efter

## Solution

Udvid wiki-link-syntax med en valgfri type-annotation:

```markdown
# NADA-protokol

[[akupunktur|is-a]] — bredere felt
[[batterimetoden|contradicts]] — alternativ model, uforenelige antagelser
[[grundlæggende-nada|supersedes]] — ældre version
[[ørepunkt-lunge|part-of]] — NADA består af 5 punkter, dette er ét
```

Parse-regel: `[[target|edge-type]]` hvor `edge-type` er én af et lukket sæt:

| Type | Betydning |
|---|---|
| `is-a` | Hierarkisk specialisering (NADA er-en akupunktur-protokol) |
| `part-of` | Kompositions-relation (ørepunkt-lunge er-del-af NADA) |
| `contradicts` | Eksplicit modsigelse (alternative hypoteser, uforenelige) |
| `supersedes` | Versionerings-relation (erstatter ældre Neuron) |
| `example-of` | Konkret instans af et abstrakt koncept |
| `caused-by` | Kausal-relation |
| `cites` | Kildestøtte (default hvis ingen type angives) |

Mangler type-annotation → default `cites` (bagud-kompatibelt — alle eksisterende `[[link]]`s holder).

Ny tabel `document_links`:

```sql
CREATE TABLE document_links (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  knowledge_base_id TEXT NOT NULL,
  from_document_id TEXT NOT NULL,
  to_document_id TEXT NOT NULL,
  edge_type TEXT NOT NULL DEFAULT 'cites',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (from_document_id, to_document_id, edge_type),
  FOREIGN KEY (knowledge_base_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE
);
```

Opdatér backlink-extractor til at parse `|edge-type`-suffix og populate edge_type-kolonnen.

## Non-Goals

- Erstatte eksisterende `wiki_backlinks` tabellen — `document_links` er et supplement, ikke en erstatning
- Implementere full Semantic MediaWiki — kun de 7 edge-typer defineret her
- Auto-infer edge-typer via LLM — LLM'en instrueres i compile-prompten, men typerne er eksplicit i syntaksen
- Graph-editing UI — typer sættes i markdown, ikke via UI

## Technical Design

### Backlink Extractor Update

```typescript
// apps/server/src/services/backlink-extractor.ts
const WIKI_LINK_RE = /\[\[([^|\]]+)(?:\|([a-z-]+))?\]\]/g;

export function extractLinks(content: string): Link[] {
  const links: Link[] = [];
  for (const match of content.matchAll(WIKI_LINK_RE)) {
    links.push({
      target: match[1],
      edgeType: match[2] || 'cites',
    });
  }
  return links;
}
```

### Graph API Response

```typescript
// apps/server/src/routes/graph.ts
interface GraphEdge {
  from: string;
  to: string;
  edgeType: 'is-a' | 'part-of' | 'contradicts' | 'supersedes' | 'example-of' | 'caused-by' | 'cites';
}
```

### Graph Rendering

- `contradicts` → rød stiplet linje
- `supersedes` → grå pil med "⇐"
- `is-a`/`part-of` → tykkere linje, farve per type
- default `cites` → tynd neutral linje (som i dag)

### Relationships API

```
GET /knowledge-bases/:kbId/relationships?type=contradicts
→ { edges: [{ from, to, edgeType }] }
```

## Interface

### Wiki Link Syntax

```markdown
[[target-slug|edge-type]]
```

### GET /knowledge-bases/:kbId/relationships

**Query params:** `type` (optional) — filter by edge type

**Response:**
```json
{
  "edges": [
    { "from": "doc-uuid-1", "to": "doc-uuid-2", "edgeType": "contradicts" }
  ]
}
```

## Rollout

**Single-phase deploy.** Ny tabel + backlink-extractor opdatering. Eksisterende `[[plain-link]]`s uden type fortsætter med at virke (default `cites`).

## Success Criteria

- Compile-prompt producerer `[[link|edge-type]]`-syntaks for mindst 30% af links på nye ingests (målt via backlink-extractor-statistik)
- F99-graphen viser visuelle forskelle mellem edge-typer
- `GET /relationships?type=contradicts` på Sanne's KB finder ægte modsigelser (manuelt validerede)
- Eksisterende `[[plain-link]]`s uden type fortsætter med at virke (backward-kompatibel)

## Impact Analysis

### Files created (new)
- `packages/db/drizzle/migrations/` (migration for `document_links` table)
- `apps/server/src/routes/relationships.ts`

### Files modified
- `packages/db/src/schema.ts` (add `documentLinks` table)
- `apps/server/src/services/backlink-extractor.ts` (parse `|edge-type` suffix)
- `apps/server/src/routes/graph.ts` (return `edge_type` per edge)
- `apps/admin/src/components/graph.tsx` (render edges by type)
- `apps/server/src/services/ingest.ts` (update compile prompt with edge-type examples)

### Downstream dependents
`apps/server/src/services/backlink-extractor.ts` is imported by 3 files:
- `apps/server/src/services/ingest.ts` (1 ref) — calls extractLinks during compile, needs edge-type support
- `apps/server/src/routes/documents.ts` (1 ref) — uses for backlink display, unaffected (edgeType is additive)
- `apps/server/src/services/search.ts` (1 ref) — uses for link-based ranking, unaffected

`apps/server/src/routes/graph.ts` is imported by 2 files:
- `apps/server/src/app.ts` (1 ref) — mounts route, unaffected
- `apps/admin/src/api.ts` (1 ref) — fetches graph data, picks up edgeType field

### Blast radius
- Medium — backlink-extractor ændring påvirker alle ingest flows
- Graph rendering ændring påvirker admin UI
- Edge case: malformed `[[link|invalid-type]]` → fallback til `cites`
- Concurrent writes til `document_links` med UNIQUE constraint → graceful handling

### Breaking changes
None — all changes are additive. Existing `[[plain-link]]`s default to `cites`.

### Test plan
- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] `extractLinks('[[foo|contradicts]]')` → `{ target: 'foo', edgeType: 'contradicts' }`
- [ ] `extractLinks('[[bar]]')` → `{ target: 'bar', edgeType: 'cites' }`
- [ ] Migration kører og opretter `document_links` tabel
- [ ] `GET /relationships?type=contradicts` returnerer kun contradicts edges
- [ ] F99 graph renderer forskellige edge-typer visuelt
- [ ] Regression: eksisterende plain wiki-links virker uændret
- [ ] Regression: backlink-display i Neuron-editor virker uændret

## Implementation Steps
1. Skriv migration for `document_links` tabel med UNIQUE constraint
2. Tilføj `documentLinks` til `packages/db/src/schema.ts`
3. Opdater backlink-extractor regex til at parse `|edge-type` suffix
4. Implementér `GET /relationships` endpoint
5. Opdater graph API til at returnere `edge_type` per kant
6. Opdater graph.tsx rendering med type-baseret styling
7. Opdater compile-prompt (F103 step 5+6) med edge-type liste og eksempler
8. Typecheck + test plan

## Dependencies
- F99 (graph render-surface — bruger edge_type til styling)
- F101 (type-frontmatter — nogle edge-types giver kun mening mellem bestemte Neuron-typer)

## Open Questions
None — all decisions made.

## Related Features
- **F99** (Neuron graph) — consumer af edge_type til visuel styling
- **F101** (Type frontmatter) — edge-types kan valideres mod Neuron-typer
- **F103** (Ingest prompt) — step 5+6 udvides med edge-type instruktioner
- **F138** (Work layer) — Work-items kan have typed edges (`blocks`, `duplicates-of`, `relates-to`)
- **F137** (Chunked ingest) — not related despite F-number collision; this is typed relationships

## Effort Estimate
**Medium** — 1.5-2 days
- 0.25 day: migration + schema
- 0.25 day: backlink-extractor update
- 0.25 day: relationships API endpoint
- 0.5 day: graph rendering with type-based styling
- 0.25 day: compile-prompt update + testing
