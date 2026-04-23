# F28 — Pluggable Pipeline Interface

> One narrow contract every ingest pipeline implements. Markdown, PDF, DOCX, HTML, image, SVG, audio, video all plug into the same orchestration layer.

## Problem

The current ingest code is entangled: `apps/server/src/services/ingest.ts` dispatches on MIME type inline, and adding a new source format (DOCX, HTML, image-only) would grow the function. `packages/pipelines` has the PDF extractor but no shared contract. Every new format costs a refactor.

## Secondary Pain Points
- No way to test pipelines in isolation (tightly coupled to ingest service)
- No visibility into which pipeline processed a source
- Adding a new format requires modifying core ingest logic

## Solution

Extract a `Pipeline` interface. Each format is a module that implements `handle(source: SourceFile): Promise<PipelineResult>`. The orchestrator picks a pipeline by MIME type + extension + content heuristics, runs it, and feeds the result into the candidate-emitter (F17).

## Non-Goals
- Pipeline versioning or A/B testing
- Hot-reloading pipelines without server restart
- Pipeline marketplace or plugin system
- Streaming pipeline output (batch-only in Phase 1)

## Technical Design

### Interface

```typescript
// packages/pipelines/src/interface.ts
export interface SourceFile {
  id: string;
  kbId: string;
  mimeType: string;
  filename: string;
  bytes: () => Promise<ArrayBuffer>;
  text: () => Promise<string>;              // UTF-8 decode helper
  storagePath: string;                      // via F13 Storage adapter
  tenantId: string;
}

export interface ExtractedFragment {
  kind: "text" | "image" | "svg" | "table" | "code";
  content: string;                          // markdown text, or SVG markup, etc.
  mediaId?: string;                         // for images stored via Storage
  meta?: Record<string, unknown>;
}

export interface PipelineResult {
  fragments: ExtractedFragment[];           // ordered, compilable material
  coverImage?: { mediaId: string; alt: string };
  warnings: string[];
}

export interface Pipeline {
  name: string;                             // "markdown", "pdf", "docx", ...
  accepts: (source: SourceFile) => number;  // 0 = no, 0-1 = confidence
  handle: (source: SourceFile) => Promise<PipelineResult>;
}
```

### Registry + dispatch

```typescript
// packages/pipelines/src/registry.ts
export const registry: Pipeline[] = [
  markdownPipeline,
  pdfPipeline,
  docxPipeline,      // F24
  htmlPipeline,      // F26
  imagePipeline,     // F25
  svgPipeline,       // F25
];

export async function dispatch(source: SourceFile): Promise<PipelineResult> {
  const scored = registry
    .map(p => ({ p, score: p.accepts(source) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) throw new Error(`No pipeline for ${source.mimeType}`);
  return scored[0].p.handle(source);
}
```

### Fragment → candidate

After a pipeline returns fragments, the ingest orchestrator pipes them into Claude Code via MCP and emits queue candidates (F17). The pipeline itself never writes to `documents`.

### Vision + LLM are separate

Pipelines call into the Vision adapter (F27) for image descriptions and the LLM adapter (F14) for any summarisation. These are passed in as dependencies, not imported directly, so pipelines stay testable.

## Interface

### Pipeline Contract
```typescript
interface Pipeline {
  name: string;
  accepts: (source: SourceFile) => number;
  handle: (source: SourceFile) => Promise<PipelineResult>;
}
```

### Registry API
```typescript
function register(pipeline: Pipeline): void;
function dispatch(source: SourceFile): Promise<PipelineResult>;
function listPipelines(): Pipeline[];
```

## Rollout

**Single-phase refactor.** The pipeline interface replaces inline MIME dispatch. Existing PDF and Markdown pipelines are wrapped into the new interface — output is identical.

## Success Criteria
- `dispatch(source)` picks correct pipeline with score > 0.9 for known formats
- Markdown ingest end-to-end still produces 6-8 wiki pages (same as before refactor)
- 8-page Danish PDF still extracts 6 images + generates descriptions + compiles 7 wiki pages in ~155s
- Adding a new pipeline requires zero changes to `ingest.ts`
- Pipeline unit tests run in < 1 second each (no DB, no network)

## Impact Analysis

### Files created (new)
- `packages/pipelines/src/interface.ts`
- `packages/pipelines/src/registry.ts`
- `packages/pipelines/src/dispatch.ts`

### Files modified
- `packages/pipelines/src/pdf.ts` (wrap existing PDF code into Pipeline instance)
- `apps/server/src/services/ingest.ts` (replace inline MIME dispatch with `dispatch(source)`)

### Downstream dependents
`apps/server/src/services/ingest.ts` is imported by 9 files (see F21 analysis). Changing from inline dispatch to `dispatch()` is a refactor — callers see same behavior.

`packages/pipelines/src/pdf.ts` is imported by:
- `apps/server/src/routes/uploads.ts` (1 ref) — calls `processPdf()`, signature unchanged after wrap

### Blast radius
Existing PDF pipeline is the only production consumer — wrapping it into the new interface is a pure refactor with identical output.

### Breaking changes
None externally. `packages/pipelines` public API changes (shared only internally).

### Test plan
- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Unit: `registry.dispatch` picks `markdownPipeline` for `.md` sources with score > 0.9
- [ ] Unit: `registry.dispatch` picks `pdfPipeline` for `application/pdf`
- [ ] Unit: `registry.dispatch` throws for unknown MIME types
- [ ] Unit: Pipeline `accepts()` returns 0 for non-matching sources
- [ ] Regression: Markdown ingest end-to-end still produces 6-8 wiki pages
- [ ] Regression: 8-page Danish PDF still extracts 6 images + generates descriptions + compiles 7 wiki pages
- [ ] Regression: DOCX pipeline (when added) integrates without ingest.ts changes

## Implementation Steps
1. Write the `Pipeline` / `SourceFile` / `PipelineResult` interfaces.
2. Extract the PDF extractor into `pdfPipeline` with `accepts: s => s.mimeType === "application/pdf" ? 1 : 0`.
3. Write `markdownPipeline` by moving the current markdown-passthrough logic.
4. Build the registry + dispatch helpers.
5. Rewire `ingest.ts` to call `dispatch(source)` and forward fragments to the candidate emitter.
6. Remove the old MIME-type branching.

## Dependencies
- F06 Ingest pipeline (rewires into this)
- F13 Storage adapter (provides `storagePath` + `bytes()` resolution)
- F17 Curation Queue API (candidate emitter)

Unlocks: F24 DOCX, F25 Image/SVG, F26 HTML, F46 Video, F47 Audio, F48 Email, F49 Slack.

## Open Questions
None — all decisions made.

## Related Features
- **F24** (DOCX Pipeline) — implements Pipeline interface
- **F25** (Image Source Pipeline) — implements Pipeline interface
- **F26** (HTML/Web Clipper Ingest) — implements Pipeline interface
- **F27** (Pluggable Vision Adapter) — dependency for image pipelines
- **F14** (Multi-Provider LLM Adapter) — dependency for summarisation

## Effort Estimate
**Medium** — 4-5 days including refactor of the current PDF + Markdown paths.
