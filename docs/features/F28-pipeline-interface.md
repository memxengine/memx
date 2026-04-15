# F28 — Pluggable Pipeline Interface

> One narrow contract every ingest pipeline implements. Markdown, PDF, DOCX, HTML, image, SVG, audio, video all plug into the same orchestration layer.

## Problem

The current ingest code is entangled: `apps/server/src/services/ingest.ts` dispatches on MIME type inline, and adding a new source format (DOCX, HTML, image-only) would grow the function. `packages/pipelines` has the PDF extractor but no shared contract. Every new format costs a refactor.

## Solution

Extract a `Pipeline` interface. Each format is a module that implements `handle(source: SourceFile): Promise<PipelineResult>`. The orchestrator picks a pipeline by MIME type + extension + content heuristics, runs it, and feeds the result into the candidate-emitter (F17).

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

## Impact Analysis

### Files affected

- **Create:** `packages/pipelines/src/{interface.ts, registry.ts, dispatch.ts}`
- **Refactor:** `packages/pipelines/src/pdf.ts` (existing PDF code wraps into a Pipeline instance)
- **Refactor:** `apps/server/src/services/ingest.ts` (replace inline MIME dispatch with `dispatch(source)`)

### Downstream dependents

- `apps/server/src/services/ingest.ts` — sole caller of existing pipeline code; change is local.
- `apps/mcp/src/tools/*` — unchanged; pipelines sit below MCP.

### Blast radius

Existing PDF pipeline is the only production consumer — wrapping it into the new interface is a pure refactor with identical output.

### Breaking changes

None externally. `packages/pipelines` public API changes (shared only internally).

### Test plan

- [ ] TypeScript compiles: `bun run typecheck`
- [ ] Unit: `registry.dispatch` picks `markdownPipeline` for `.md` sources with score > 0.9
- [ ] Unit: `registry.dispatch` picks `pdfPipeline` for `application/pdf`
- [ ] Regression: Markdown ingest end-to-end still produces 6-8 wiki pages
- [ ] Regression: 8-page Danish PDF still extracts 6 images + generates descriptions + compiles 7 wiki pages

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

## Effort Estimate

**Medium** — 4-5 days including refactor of the current PDF + Markdown paths.
