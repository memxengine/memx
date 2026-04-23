# F114 — Image Archiving for Web Content

> Tier: Pro+ (som del af connector-pack). Effort: 1-2 days. Planned.

## Problem

Webartikler refererer images via URLs på eksterne CDNs der kan bryde over tid. PDF-pipeline extraherer images (vi har det), men markdown-sources med `![](https://example.com/img.png)` refs gemmer kun URL-strengen. Hvis URLen dør forsvinder billedet — og dermed konteksten for LLM-compilen der refererer det.

## Secondary Pain Points

- Eksport af KB inkluderer ikke archived images — export er markdown-only
- Ingen rate-limiting på image downloads — kan ramme eksterne servere hårdt ved bulk-ingest
- Ingen size-validation — kan downloade meget store images der fylder storage

## Solution

Under ingest af markdown-sources (både upload og web-clip):

1. Parse alle `![alt](url)` + `<img src="url">` references
2. Download hvert image via fetch med 10s timeout, max 10MB per asset
3. Gem i storage under `<tenantId>/<kbId>/<docId>/images/<filename>`
4. Rewrite markdown-content til at pege på lokal URL: `![](/api/v1/documents/<docId>/images/<filename>)`
5. Log failures som warnings, bevar original URL som fallback

## Non-Goals

- Image optimization/resizing (keep original files as-is)
- OCR on images (that's F107 vision pipeline)
- CDN distribution of archived images (local storage only)
- Video/audio archiving (images only)

## Technical Design

### Image Archiver Service

```typescript
// apps/server/src/services/image-archiver.ts
interface ImageArchiveResult {
  originalUrl: string;
  localPath: string;
  size: number;
  mimeType: string;
  status: 'archived' | 'failed' | 'skipped';
  error?: string;
}

export async function archiveImagesFromMarkdown(
  tenantId: string,
  kbId: string,
  docId: string,
  markdown: string,
  options?: { timeoutMs?: number; maxBytes?: number }
): Promise<{ rewrittenMarkdown: string; results: ImageArchiveResult[] }> {
  const imageUrls = extractImageUrls(markdown);
  const results: ImageArchiveResult[] = [];
  let rewritten = markdown;

  for (const url of imageUrls) {
    const result = await downloadAndStore(url, tenantId, kbId, docId, options);
    results.push(result);
    if (result.status === 'archived') {
      const localRef = `/api/v1/documents/${docId}/images/${result.localPath}`;
      rewritten = rewritten.replace(url, localRef);
    }
  }

  return { rewrittenMarkdown: rewritten, results };
}
```

### Integration Point

Hookes ind i ingest-pipeline umiddelbart efter markdown parses, før content gemmes i documents table.

### Storage Path

Matcher eksisterende PDF-image-pattern:
```
storage/<tenantId>/<kbId>/sources/<sourceId>/images/<filename>
```

### Existing Image Route

Admin image-route (`apps/server/src/routes/images.ts`) serves allerede lokale images med auth — ingen ny route nødvendig.

## Interface

```typescript
// Configuration via env vars
interface ImageArchiverConfig {
  timeoutMs: number;     // default 10000
  maxBytes: number;      // default 10 * 1024 * 1024 (10MB)
  maxImagesPerDoc: number; // default 50
}

// Telemetry: logged per ingest run
interface ImageArchiverStats {
  totalImages: number;
  archived: number;
  failed: number;
  skipped: number;
  totalBytes: number;
}
```

## Rollout

**Single-phase deploy.** Feature er additive — eksisterende ingest flow unaffected for sources uden images. Deploy service → hook into ingest pipeline → verify.

## Success Criteria

- Web-clipped artikel viser alle inline images også efter oprindelig URL er død
- Eksport (F100) inkluderer `wiki/assets/`-folder med alle archived images
- Failure-rate logges + telemetry viser hvor ofte vi rammer timeout/size-limit
- Ingest latency impact <10% for image-heavy articles (<50 images)

## Impact Analysis

### Files created (new)
- `apps/server/src/services/image-archiver.ts`

### Files modified
- `apps/server/src/services/ingest.ts` (call image archiver after markdown parse)
- `apps/server/src/routes/images.ts` (serve archived web images alongside PDF images)
- `packages/shared/src/schemas.ts` (add image archiver config schema)

### Downstream dependents
`apps/server/src/services/ingest.ts` is imported by 5 files:
- `apps/server/src/routes/ingest.ts` (1 ref) — triggers ingest, unaffected
- `apps/server/src/index.ts` (1 ref) — recovers ingest jobs, unaffected
- `apps/server/src/routes/uploads.ts` (1 ref) — triggers ingest after upload, unaffected
- `apps/server/src/routes/documents.ts` (1 ref) — triggers ingest, unaffected
- `apps/server/src/bootstrap/zombie-ingest.ts` (1 ref comment) — documentation only, unaffected

`apps/server/src/routes/images.ts` is imported by 1 file:
- `apps/server/src/app.ts` (1 ref) — mounts route, unaffected

`packages/shared/src/schemas.ts` — imported by server routes. Additive change.

### Blast radius

- Ingest pipeline timing: image downloads add latency proportional to image count
- Storage growth: each image-heavy article adds 1-50MB to storage
- External servers: rate-limiting needed to avoid hammering CDNs during bulk ingest
- Existing PDF image serving in images.ts route must not conflict with new web image paths

### Breaking changes

None — all changes are additive.

### Test plan

- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Markdown with 3 image URLs → all 3 downloaded, markdown rewritten with local paths
- [ ] Image >10MB → skipped, original URL preserved, warning logged
- [ ] Image URL returns 404 → failed status logged, original URL preserved
- [ ] Timeout after 10s → failed status logged, original URL preserved
- [ ] Archived image served via `/api/v1/documents/:docId/images/:filename` with auth
- [ ] Regression: PDF image extraction still works
- [ ] Regression: ingest without images completes at same speed as before

## Implementation Steps

1. Create `apps/server/src/services/image-archiver.ts` with `archiveImagesFromMarkdown()` function.
2. Implement URL extraction (markdown `![alt](url)` + HTML `<img src="url">`).
3. Implement download + storage with timeout/size limits.
4. Hook image archiver into ingest pipeline in `services/ingest.ts` (after markdown parse, before document save).
5. Update `routes/images.ts` to serve archived web images alongside existing PDF images.
6. Add telemetry logging for archive stats.
7. Update F100 export to include `wiki/assets/` folder with archived images.

## Dependencies

- F111 (primary use-case: web-clipper downloads images)
- F100 (export includes archived images)

## Open Questions

None — all decisions made.

## Related Features

- **F111** (Web Clipper) — primary consumer of image archiving
- **F100** (Export) — export includes archived images in assets folder
- **F107** (Vision Pipeline) — separate image processing (OCR), not affected

## Effort Estimate

**Small** — 1-2 days.
- Day 1: Image archiver service + download logic
- Day 2: Ingest integration + image route update + export
