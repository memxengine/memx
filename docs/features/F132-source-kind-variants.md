# F132 — `source-kind` Variants for Ingest-Compile Tuning

*Planned. Tier: alle. Effort: 1 day.*

> Sources får en `source-kind`-metadata-hint (fx 'pdf-academic', 'docs-md', 'web-article', 'meeting-transcript', 'codebase-file') der styrer hvilken compile-prompt-variant ingest-servicen bruger. Tillader at forskellige input-typer behandles med tilpassede instruktioner uden at fragmentere kernen.

## Problem

I dag har alle sources samme compile-prompt, uanset om det er et academic paper, et docs-markdown-fil, et meeting-transcript, eller en kodebase-fil. Ingest-prompten giver samme instruktioner til alle — men et meeting-transcript har anden struktur (speakers, timestamps, decisions) end et academic paper, og docs-markdown har allerede headers der skal bevares som struktur.

## Solution

Tilføj `sourceKind` som metadata-hint (ikke schema-kolonne — kan udledes fra filetype eller eksplicit sættes ved upload):

```json
{
  "id": "doc_abc",
  "metadata": {
    "sourceKind": "docs-md" // eller: pdf-academic, web-article, transcript, codebase, generic
  }
}
```

Ingest-service (`services/ingest.ts`) læser `sourceKind`, loader matching prompt-variant fra `services/ingest-profiles/source-kinds/`:

```
source-kinds/
├── generic.md          current default prompt
├── pdf-academic.md     bevar citations, abstract-first
├── docs-md.md          bevar headers + code-blocks eksakt, < 1-2 Neurons output
├── web-article.md      fokus på key claims, less structure
├── transcript.md       identify speakers + decisions + action items
└── codebase.md         extract functions, classes, API-surfaces som entities
```

Kombineres med F104 per-KB-profile: `KB-profile × source-kind = finale prompt`.

## How

- Ingest-service læser `metadata.sourceKind` eller udleder fra file-extension
- Upload-route + CMS-connector (F124) kan sætte sourceKind eksplicit
- Fallback til 'generic' hvis ikke sat
- Prompt-compositeren flettes fra base (F103 9-step) + kb-profile (F104) + source-kind (denne)

## Dependencies

- F103 (base prompt-struktur)
- F104 (kb-profiles)

## Success criteria

- docs-md source ingested → Neurons bevarer original markdown-struktur + code-blocks intakt
- Meeting-transcript → separate Neurons for decisions + action-items
- Codebase-fil → entity-Neurons per function/class
- Prompt-variations A/B-tested på 3 test-sources per kind
