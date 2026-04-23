# F24 — DOCX Pipeline

> `.docx` filer ekstraheres via Mammoth.js → markdown → samme chunk-og-ingest flow som PDF. Ingen billeder eller page count i v1 — ren tekstekstraktion.

## Problem

Mange kunder (især Sanne) har eksisterende dokumentation i Word-format (.docx). I dag kan de ikke uploade disse direkte — de skal konvertere til PDF eller markdown manuelt. Det er friktion der begrænser hvor meget eksisterende materiale der faktisk lander i Trail.

PDF-pipelinen (F08) håndterer allerede kompleks extraction (tekst + billeder + vision). DOCX er simplere — det er primært tekst med struktur (headings, lists, tables). Mammoth.js er et veletableret library der konverterer docx → markdown uden at kræve Office installation.

## Solution

Ny async pipeline i upload-routen der:
1. Modtager `.docx` fil
2. Ekstraher tekst via Mammoth.js
3. Gemmer markdown som document content
4. Chunker og trigger ingest (samme flow som PDF)

Ingen billeder, ingen page count — ren tekst i v1.

## Technical Design

### 1. DOCX Processing Function

```typescript
// packages/pipelines/src/docx.ts

import mammoth from 'mammoth';

export interface DocxProcessOptions {
  docxBytes: Buffer;
}

export interface DocxProcessResult {
  /** Extracted markdown */
  markdown: string;
  /** Document title (from first heading or filename) */
  title: string | null;
  /** Conversion warnings from Mammoth */
  warnings: string[];
}

export async function processDocx(options: DocxProcessOptions): Promise<DocxProcessResult> {
  const result = await mammoth.extractRawText({ buffer: options.docxBytes });

  // Mammoth's extractRawText gives plain text. For markdown, use extractToMarkdown:
  const mdResult = await mammoth.convertToMarkdown({ buffer: options.docxBytes });

  // Extract title from first heading
  const titleMatch = mdResult.value.match(/^#\s+(.+)$/m);
  const title = titleMatch?.[1]?.trim() ?? null;

  return {
    markdown: mdResult.value,
    title,
    warnings: mdResult.messages.map((m) => m.message),
  };
}
```

### 2. Integration with Upload Route

```typescript
// apps/server/src/routes/uploads.ts — add docx handling

import { processDocx } from '@trail/pipelines';

// In the upload handler, after the existing pdf/docx/pptx/xlsx blocks:
if (ext === 'docx') {
  processDocxAsync(trail, docId, tenant.id, kbId, user.id, file.name, buffer).catch(async (err) => {
    console.error(`[docx] pipeline failed for ${file.name}:`, err);
    await trail.db
      .update(documents)
      .set({
        status: 'failed',
        errorMessage: String(err).slice(0, 1000),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(documents.id, docId))
      .run();
  });
}

// Async processing function:
export async function processDocxAsync(
  trail: TrailDatabase,
  docId: string,
  tenantId: string,
  kbId: string,
  userId: string,
  filename: string,
  buffer: Buffer,
): Promise<void> {
  await trail.db
    .update(documents)
    .set({ status: 'processing', updatedAt: new Date().toISOString() })
    .where(eq(documents.id, docId))
    .run();

  console.log(`[docx] processing ${filename}...`);
  const result = await withTimeout(
    processDocx({ docxBytes: buffer }),
    DOCX_TIMEOUT_MS,
    `docx extract "${filename}"`,
  );

  if (result.warnings.length) {
    console.log(`[docx] ${filename}: ${result.warnings.length} conversion warnings`);
  }

  const title = result.title ?? filename.replace(/\.docx$/i, '');
  await trail.db
    .update(documents)
    .set({
      content: result.markdown,
      title,
      status: 'ready',
      version: 1,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(documents.id, docId))
    .run();

  if (result.markdown.trim()) {
    const chunks = chunkText(result.markdown);
    await storeChunks(trail, docId, tenantId, kbId, chunks);
  }

  triggerIngest({ trail, docId, kbId, tenantId, userId });
}
```

### 3. Timeout Configuration

```typescript
// apps/server/src/routes/uploads.ts

const DOCX_TIMEOUT_MS = Number(process.env.TRAIL_DOCX_TIMEOUT_MS ?? 60_000); // 60 seconds
```

### 4. Mammoth Style Map (Optional Enhancement)

```typescript
// packages/pipelines/src/docx.ts — custom style mapping

const STYLE_MAP = [
  'p[style-name="Title"] => h1',
  'p[style-name="Heading 1"] => h1',
  'p[style-name="Heading 2"] => h2',
  'p[style-name="Heading 3"] => h3',
  'r[style-name="Strong"] => strong',
  'r[style-name="Emphasis"] => em',
];

const result = await mammoth.convertToMarkdown({ buffer: options.docxBytes }, {
  styleMap: STYLE_MAP,
});
```

## Impact Analysis

### Files created (new)
- `packages/pipelines/src/docx.ts` — DOCX processing with Mammoth
- `packages/pipelines/src/__tests__/docx.test.ts`

### Files modified
- `apps/server/src/routes/uploads.ts` — add docx async processing (already partially exists — just needs the actual `processDocx` implementation)
- `packages/pipelines/package.json` — add `mammoth` dependency

### Downstream dependents for modified files

**`apps/server/src/routes/uploads.ts`** — no downstream dependents. Adding docx processing is additive.

### Blast radius
- DOCX files already land with `status: 'pending'` — this change makes them actually process
- Mammoth is a pure JS library — no native dependencies, no install issues
- Large DOCX files (>50MB) may hit timeout — configurable via env var
- Conversion warnings are logged but don't block processing

### Breaking changes
None.

### Test plan
- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Unit: `processDocx` extracts markdown from simple .docx file
- [ ] Unit: `processDocx` extracts title from first heading
- [ ] Unit: `processDocx` returns warnings for unsupported elements
- [ ] Integration: Upload .docx file → status goes pending → processing → ready
- [ ] Integration: DOCX content appears in document and triggers ingest
- [ ] Integration: Large DOCX (>10MB) processes within timeout
- [ ] Regression: PDF/Markdown upload flow unchanged
- [ ] Regression: Existing pending DOCX files get processed on next upload

## Implementation Steps

1. Add `mammoth` dependency to `packages/pipelines/package.json`
2. Create `packages/pipelines/src/docx.ts` with `processDocx()` function
3. Write unit tests with sample .docx fixtures
4. Implement `processDocxAsync` in upload route (or verify existing stub is complete)
5. Add timeout configuration
6. Integration test: upload real .docx → verify markdown extraction → verify ingest triggers
7. Test with complex .docx (tables, images, footnotes) — verify warnings are logged

## Dependencies

- F06 (Ingest Pipeline) — DOCX triggers same ingest flow as other sources
- F28 (Pluggable Pipeline Interface) — DOCX follows same pipeline pattern

## Effort Estimate

**Small** — 1 day

- Morning: Mammoth integration + processDocx function + unit tests
- Afternoon: Upload route integration + timeout config + integration testing with real DOCX files
