# F132 — `source-kind` Variants for Ingest-Compile Tuning

> Sources får en `sourceKind`-metadata-hint (fx 'pdf-academic', 'docs-md', 'web-article', 'meeting-transcript', 'codebase-file') der styrer hvilken compile-prompt-variant ingest-servicen bruger. Tillader at forskellige input-typer behandles med tilpassede instruktioner uden at fragmentere kernen. Tier: alle. Effort: 1 day.

## Problem

I dag har alle sources samme compile-prompt, uanset om det er et academic paper, et docs-markdown-fil, et meeting-transcript, eller en kodebase-fil. Ingest-prompten giver samme instruktioner til alle — men et meeting-transcript har anden struktur (speakers, timestamps, decisions) end et academic paper, og docs-markdown har allerede headers der skal bevares som struktur.

## Secondary Pain Points

- Codebase-filer compile's til concept-Neuroner i stedet for entity-Neuroner med API-signaturer
- Meeting-transcripts mister speaker-attribution og action items
- Academic papers mister citation-struktur og abstract-first layout

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

## Non-Goals

- Auto-detektion af sourceKind med LLM — rule-based på file-extension + eksplicit upload-valg
- Per-source custom prompts — kun de 6 predefined variants
- Ændre på F103's 9-step workflow — source-kind er et prompt-prefix, ikke en workflow-ændring

## Technical Design

### Source kind resolution

```typescript
// apps/server/src/services/source-kind.ts
export type SourceKind = 'generic' | 'pdf-academic' | 'docs-md' | 'web-article' | 'transcript' | 'codebase';

export function inferSourceKind(filename: string, mimeType?: string): SourceKind {
  const ext = filename.split('.').pop()?.toLowerCase();
  if (ext === 'md' || ext === 'markdown') return 'docs-md';
  if (ext === 'pdf') return 'pdf-academic'; // default for PDF
  if (ext === 'txt') return 'web-article';
  if (['ts', 'tsx', 'js', 'py', 'go', 'rs'].includes(ext || '')) return 'codebase';
  return 'generic';
}

export async function loadSourceKindPrompt(kind: SourceKind): Promise<string> {
  const path = `./ingest-profiles/source-kinds/${kind}.md`;
  return await fs.readFile(path, 'utf-8');
}
```

### Prompt composition

```typescript
// In ingest.ts, before compile:
const basePrompt = await loadBasePrompt(); // F103 9-step
const kbProfile = await loadKBProfile(kbId); // F104
const sourceKindPrompt = await loadSourceKindPrompt(resolvedKind); // F132

const finalPrompt = `${basePrompt}\n\n${kbProfile}\n\n${sourceKindPrompt}`;
```

### Upload dialog

Upload-route + CMS-connector (F124) kan sætte sourceKind eksplicit via form-felt. Fallback til 'generic' hvis ikke sat.

## Interface

### Upload form field

```typescript
// POST /api/v1/knowledge-bases/:kbId/upload
interface UploadRequest {
  files: File[];
  sourceKind?: SourceKind; // optional override
  // ... other fields
}
```

### Prompt files

Hver `source-kinds/*.md` fil indeholder markdown med specifikke instruktioner for den pågældende kilde-type.

## Rollout

**Single-phase deploy:**
1. Tilføj source-kinds/ directory med 6 prompt-filer
2. Implementer `inferSourceKind` + `loadSourceKindPrompt`
3. Integrer i ingest-pipeline
4. Upload dialog viser sourceKind-dropdown (optional)

## Success Criteria

- docs-md source ingested → Neurons bevarer original markdown-struktur + code-blocks intakt
- Meeting-transcript → separate Neurons for decisions + action-items
- Codebase-fil → entity-Neurons per function/class
- Prompt-variations A/B-tested på 3 test-sources per kind

## Impact Analysis

### Files created (new)
- `apps/server/src/services/source-kind.ts`
- `apps/server/src/services/ingest-profiles/source-kinds/generic.md`
- `apps/server/src/services/ingest-profiles/source-kinds/pdf-academic.md`
- `apps/server/src/services/ingest-profiles/source-kinds/docs-md.md`
- `apps/server/src/services/ingest-profiles/source-kinds/web-article.md`
- `apps/server/src/services/ingest-profiles/source-kinds/transcript.md`
- `apps/server/src/services/ingest-profiles/source-kinds/codebase.md`

### Files modified
- `apps/server/src/services/ingest.ts` — load + merge source-kind prompt
- `apps/server/src/routes/uploads.ts` — accept sourceKind form field
- `apps/admin/src/components/upload-dropzone.tsx` — sourceKind dropdown

### Downstream dependents
`apps/server/src/services/ingest.ts` is imported by 7 files:
- `apps/server/src/routes/uploads.ts` (1 ref) — calls triggerIngest, unaffected (API unchanged)
- `apps/server/src/routes/documents.ts` (1 ref) — calls triggerIngest for reingest, unaffected
- `apps/server/src/routes/ingest.ts` (1 ref) — calls triggerIngest, unaffected
- `apps/server/src/app.ts` (1 ref) — mounts ingest routes, unaffected
- `apps/server/src/index.ts` (2 refs) — imports recoverIngestJobs + zombie-ingest, unaffected
- `docs/features/F26-html-web-clipper-ingest.md` (1 ref) — documentation, no code impact

`apps/server/src/routes/uploads.ts` is imported by 2 files:
- `apps/server/src/app.ts` (1 ref) — mounts route, unaffected
- `apps/server/src/bootstrap/recover-pending-sources.ts` (1 ref) — imports processPdfAsync/processDocxAsync, unaffected

### Blast radius

Low. Prompt-ændringer påvirker kun compile-output, ikke datastrukturer eller API'er.

### Breaking changes

None — all changes are additive.

### Test plan

- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] `inferSourceKind('notes.md')` → 'docs-md'
- [ ] `inferSourceKind('paper.pdf')` → 'pdf-academic'
- [ ] `inferSourceKind('app.ts')` → 'codebase'
- [ ] docs-md ingest bevarer markdown headers + code blocks
- [ ] transcript ingest producerer decision + action-item Neurons
- [ ] codebase ingest producerer entity-Neurons for functions/classes
- [ ] Regression: generic ingest (no sourceKind) fungerer som før

## Implementation Steps

1. Opret `apps/server/src/services/source-kind.ts` med `inferSourceKind` + `loadSourceKindPrompt`.
2. Opret 6 prompt-filer i `ingest-profiles/source-kinds/`.
3. Integrer source-kind loading i `ingest.ts` før prompt-build.
4. Tilføj sourceKind-dropdown i upload dialog.
5. A/B test på 3 sources per kind.

## Dependencies

- F103 (base prompt-struktur — source-kind flettes som prefix)
- F104 (kb-profiles — combineres: KB-profile × source-kind)

## Open Questions

None — all decisions made.

## Related Features

- **F103** — 9-step ingest workflow (prompt assembly site)
- **F104** — Per-KB prompt profiles (combined with source-kind)
- **F124** — CMS connector (can set sourceKind explicitly)
- **F142** — Chunked ingest (source-kind applies per chunk in chained mode)

## Effort Estimate

**Small** — 1 day.
- 0.25 day: source-kind resolver + loader
- 0.5 day: 6 prompt-filer (skrivning + tuning)
- 0.15 day: upload dialog integration
- 0.1 day: A/B testing
