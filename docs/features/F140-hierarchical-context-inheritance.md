# F140 — Hierarchical Context Inheritance

> En Neuron på `/neurons/concepts/akupunktur/nada.md` arver compile-kontekst fra parent-path'ens `_schema.md` (eller søskende-`README.md`) — eksempler, tone, struktur-konventioner, taxonomi. Komplementerer F104 (per-KB prompt profiles) med per-PATH profiles. Én KB kan dermed have flere domæner (Sannes akupunktur + coaching + business-delen) uden at de forurener hinandens compile-regler. Tier: alle. Effort: 1-1.5 days. Status: Planned.

## Problem

F104 per-KB prompt profiles lader en hel KB have sin egen compile-ton (dansk vs engelsk, medicinsk-formel vs casual, entities-vs-concepts-balance). Men Sannes KB er faktisk TRE domæner i ét:

- `/neurons/concepts/akupunktur/` — NADA, punkter, kontraindikationer → klinisk/medicinsk tone
- `/neurons/concepts/coaching/` — Box Breathing, samtaleteknikker, klient-refleksion → terapeutisk tone
- `/neurons/concepts/business/` — prispolitik, klient-booking → forretnings-tone

Én prompt-profile til alle tre er altid kompromis. Waykee Cortex's "strict hierarchical inheritance model" løser det: hver path-node i wiki'en kan have sit eget schema; compile-prompten assembles via inheritance-chain fra root → target.

## Secondary Pain Points

- Glossary-Neurons har ingen måde at specificere at entries SKAL indeholde fagterm-definition + max 3 sources
- Admin UI har ingen visuel indikator for hvilke paths der har aktive schema-regler
- Nye sub-mapper uden `_schema.md` arver ikke parent's schema (i dag)

## Solution

Konvention: enhver path kan have en `_schema.md`-fil der beskriver compile-regler for den undermappe:

```
/neurons/
├── _schema.md                              KB-wide default (linker til F104 profile)
├── concepts/
│   ├── _schema.md                          overrides for /concepts
│   ├── akupunktur/
│   │   ├── _schema.md                      klinisk/medicinsk tone, kræver kontraindikations-sektion
│   │   └── nada.md                         compile'es med: F104 + /_schema + /concepts/_schema + /concepts/akupunktur/_schema
│   └── coaching/
│       ├── _schema.md                      terapeutisk tone, første-person
│       └── box-breathing.md                compile'es med kombineret inheritance
```

`_schema.md` frontmatter beskriver hvad den overrider/udvider:

```yaml
---
type: schema
scope: /neurons/concepts/akupunktur/
tone: "Clinical, medical — use Danish fagtermer (NADA, abstinenser, ørepunkter); cite only peer-reviewed sources or clinical guidelines."
required_sections:
  - "Indikationer"
  - "Kontraindikationer"
  - "Referencer"
tags_canonical: [nada, akupunktur, behandling, kontraindikation]
---

## Structure
Each Neuron under this path should follow the medical-Neuron template:
- Starts with a 1-sentence definition
- Mandatory "Indikationer" section
- Mandatory "Kontraindikationer" section
- Sources listed under "Referencer"
```

Compile-pipelinen (F103 step 0) finder alle `_schema.md` på path'en fra root til target, flettes i ingest-prompten:

```
1. F104 KB-wide base profile
2. /_schema.md (if exists)
3. /concepts/_schema.md (if exists)
4. /concepts/akupunktur/_schema.md (if exists)
→ Combined into effective compile-instruction for NADA.md
```

Arve-reglen: child overrider parent's felter; ikke-overriden felter arver. Jordnært: `tone:` på child overstyrer parent; `tags_canonical:` unionerer.

## Non-Goals

- Erstatte F104 per-KB profiles — schema inheritance komplementerer, ikke erstatter
- Implementere schema-validation engine — `_schema.md` er compile-instruktioner, ikke validerings-regler
- Supportere cross-path inheritance (fx `/neurons/concepts/` arver fra `/sources/`) — kun parent-child i samme tree

## Technical Design

### Schema Inheritance Resolver

```typescript
// packages/core/src/schema-inheritance.ts
export interface SchemaProfile {
  tone?: string;
  requiredSections?: string[];
  tagsCanonical?: string[];
  // ... other schema fields
}

export async function resolveSchemaChain(
  db: Database,
  kbId: string,
  targetPath: string,
): Promise<SchemaProfile> {
  const segments = targetPath.split('/').filter(Boolean);
  const schemas: SchemaProfile[] = [];

  // Walk from root to target
  for (let i = 0; i <= segments.length; i++) {
    const schemaPath = segments.slice(0, i).join('/') + '/_schema.md';
    const schema = await loadSchema(db, kbId, schemaPath);
    if (schema) schemas.push(schema);
  }

  return mergeSchemas(schemas);
}

function mergeSchemas(schemas: SchemaProfile[]): SchemaProfile {
  // Child overrides parent; non-overridden fields inherit
  // tags_canonical unions
}
```

### Ingest Integration

```typescript
// In apps/server/src/services/ingest.ts
const schemaProfile = await resolveSchemaChain(db, kb.id, doc.path);
const prompt = buildPrompt({
  base: f104Profile,
  schemaChain: schemaProfile,
  // ...
});
```

## Interface

### _schema.md Frontmatter

```yaml
---
type: schema
scope: /neurons/concepts/akupunktur/
tone: "..."
required_sections: [...]
tags_canonical: [...]
---
```

### Admin UI

Path-browseren (wiki-tree) viser et lille schema-ikon på paths der har et aktiv schema + klik → quick-edit af scope-regler.

## Rollout

**Single-phase deploy.** Ny schema-inheritance resolver + prompt integration. Eksisterende KBs uden `_schema.md` filer er unaffected.

## Success Criteria

- Sannes KB kan have 3 `_schema.md` (akupunktur / coaching / business) med forskellig tone
- Ingest af en ny akupunktur-PDF compile'es med akupunktur-schema'ens sektions-krav; coaching-PDF compile'es med coaching-tonen
- Schema-fil på `/neurons/concepts/akupunktur/` ændrer hverken search-resultater eller graph for ikke-admin queries
- En tom sub-mappe uden `_schema.md` bruger nærmeste parent's schema (inheritance virker op gennem path-træet)

## Impact Analysis

### Files created (new)
- `packages/core/src/schema-inheritance.ts`

### Files modified
- `apps/server/src/services/ingest.ts` (resolve schema chain before prompt building)
- `apps/admin/src/components/wiki-tree.tsx` (show schema icon on paths with active schema)
- `packages/shared/src/types.ts` (add 'schema' to type enum)

### Downstream dependents
`packages/core/src/schema-inheritance.ts` — New file, no dependents yet.

`apps/server/src/services/ingest.ts` is imported by 4 files (see F132 analysis). Adding schema resolution is additive to prompt building.

### Blast radius
- Low — schema inheritance only affects compile prompt, not runtime behavior
- Edge case: dybe path-træer med mange `_schema.md` filer → merge kan blive kompleks
- Edge case: cirkulære schema-referencer (A arver fra B, B arver fra A) → detection nødvendig

### Breaking changes
None — all changes are additive. KBs without `_schema.md` files are unaffected.

### Test plan
- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] `resolveSchemaChain` for `/neurons/concepts/akupunktur/nada` loader 3 schemas
- [ ] Schema merge: child `tone` overrides parent, `tags_canonical` unions
- [ ] Ingest af PDF under akupunktur-path bruger akupunktur-schema
- [ ] Ingest af PDF under coaching-path bruger coaching-schema
- [ ] Sub-mappe uden `_schema.md` arver parent's schema
- [ ] Schema-fil påvirker ikke search eller graph results
- [ ] Regression: KBs uden `_schema.md` compile'es uændret

## Implementation Steps
1. Implementér `schema-inheritance.ts` med resolveSchemaChain + mergeSchemas
2. Tilføj 'schema' til type enum (udelukkes fra normale flows)
3. Integrér schema resolution i ingest prompt-building (F103 step 0)
4. Opdater wiki-tree med schema-ikon for paths med aktiv `_schema.md`
5. Implementér quick-edit af schema-regler fra wiki-tree
6. Test med Sannes KB (3 schemas: akupunktur / coaching / business)
7. Typecheck + test plan

## Dependencies
- F104 (per-KB prompt profiles — root af schema-chain)
- F103 (9-step ingest-workflow — prompt-assembly site for inheritance)
- F101 (type-frontmatter — schemas har `type: schema`, udelukkes fra normale flows)

## Open Questions
None — all decisions made.

## Related Features
- **F104** (Per-KB prompt profiles) — root af schema-chain
- **F103** (9-step ingest workflow) — prompt-assembly site
- **F101** (Type frontmatter) — schemas har `type: schema`
- **F102** (Glossary Neurons) — kan have `_schema.md` med fagterm-krav

## Effort Estimate
**Small** — 1-1.5 days
- 0.4 day: schema-inheritance resolver + merge logic
- 0.3 day: ingest integration
- 0.2 day: wiki-tree schema icon + quick-edit
- 0.1 day: type enum update
- 0.2 day: testing
