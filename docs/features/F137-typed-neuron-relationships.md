# F137 — Typed Neuron Relationships

*Planned. Tier: alle. Effort: 1.5-2 days.*

> Wiki-links er i dag én-dimensionelle: `[[nada-protokol]]` siger "der er en forbindelse" men ikke HVAD forbindelsen er. Typed edges giver Neuroner første-klasses semantiske relationer — `is-a`, `contradicts`, `supersedes`, `example-of`, `caused-by`, `part-of` — så graph-visualiseringen kan farve/vægte edges, compile-prompten kan udtrække mere struktureret information, og queries som "hvad modsiger denne Neuron?" bliver mulige uden LLM-kald.

## Problem

F99 Neuron-graphen (lige shippet) tegner hver `[[wiki-link]]` som en neutral edge. Det er bedre end en flad liste, men én farve / én vægt på alle kanter efterlader et stort signal på gulvet: hvilke Neuroner modsiger hinanden? Hvilke er specialiseringer af hvilke? Hvilken udskifter hvilken?

F92 tags kan ikke bære den type relation — tags er per-Neuron metadata, ikke mellem-Neuron-relationer. Mehmet Zaim's kommentar på evoailabs-artiklen fangede det præcist: "plain Wiki has a taxonomical structure but a Wiki with an ontological structure (like Semantic MediaWiki) may be more helpful — knowledge evolves from static text into a dynamic Knowledge Graph."

Sage-Wiki (xoai) demonstrerer gevinsten: typed-entity-system med `is-a` / `contradicts` forhindrer LLM'en i at oprette duplikater af samme koncept under forskellige navne, fordi pipeline kan tjekke om et nyt koncept er en specialisering af et eksisterende.

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

## How

- `packages/db/src/schema.ts` — ny `documentLinks`-tabel + migration
- `apps/server/src/services/backlink-extractor.ts` — regex-udvidelse: `/\[\[([^|\]]+)(?:\|([a-z-]+))?\]\]/`
- F99 graph.ts API returnerer `edge_type` per kant; `graph.tsx` renderer:
  - `contradicts` → rød stiplet linje
  - `supersedes` → grå pil med "⇐"
  - `is-a`/`part-of` → tykkere linje, farve per type
  - default `cites` → tynd neutral linje (som i dag)
- Compile-prompt (F103 step 5+6) udvides med en liste over edge-types og eksempler
- Nyt API-endpoint `GET /knowledge-bases/:kbId/relationships?type=contradicts` → returnerer alle typed edges af given type. Nyttigt for "find alle modsigelser"-views og for Karpathy-autoresearch-flows der vil se kontroverser i en KB.

## Dependencies

- F99 (graph render-surface — bruger edge_type til styling)
- F101 (type-frontmatter — nogle edge-types giver kun mening mellem bestemte Neuron-typer, fx `is-a` mellem to `concept`-Neuroner)

## Success criteria

- Compile-prompt producerer `[[link|edge-type]]`-syntaks for mindst 30% af links på nye ingests (målt via backlink-extractor-statistik)
- F99-graphen viser visuelle forskelle mellem edge-typer
- `GET /relationships?type=contradicts` på Sanne's KB finder ægte modsigelser (manuelt validerede)
- Eksisterende `[[plain-link]]`s uden type fortsætter med at virke (backward-kompatibel)
