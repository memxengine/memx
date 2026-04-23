# F25 — Image Source Pipeline (Standalone Images + SVG Passthrough)

> Accepter standalone billeder (.png, .jpg, .webp, .gif, .svg) som sources. Billeder sendes gennem vision AI for beskrivelse → wiki page. SVG filer pass-through deres markup så diagrammer forbliver stylable og accessible.

## Problem

I dag kan billeder kun uploades som del af en PDF (F08 ekstraherer billeder fra PDF'er). Men mange kilder ER billeder: screenshots, diagrammer, fotos, infografik. Brugeren kan ikke uploade et enkelt billede og få det beskrevet af AI.

SVG er et specialtilfælde — det er både et billede OG tekst (XML markup). Hvis vi behandler SVG som et almindeligt billede, mister vi muligheden for at vise det som et interaktivt diagram i wiki'en. SVG bør pass-through som markup.

## Solution

To stier i upload-routen:

1. **Raster billeder** (PNG, JPG, WebP, GIF) → upload til storage → send til vision AI → beskrivelse bliver source content → trigger ingest
2. **SVG filer** → upload til storage → SVG markup ekstraheres som text content → vises inline i wiki → trigger ingest (uden vision, SVG er allerede tekst)

## Technical Design

### 1. Image Processing Function

```typescript
// packages/pipelines/src/image.ts

import { VisionAdapter } from '@trail/core';

export interface ImageProcessOptions {
  imageBytes: Buffer;
  filename: string;
  visionAdapter: VisionAdapter | null;
}

export interface ImageProcessResult {
  /** Vision description (for raster images) */
  description: string | null;
  /** SVG markup (for SVG files) */
  svgMarkup: string | null;
  /** Image dimensions (if determinable) */
  dimensions: { width: number; height: number } | null;
  /** File type */
  fileType: string;
}

export async function processImage(options: ImageProcessOptions): Promise<ImageProcessResult> {
  const ext = options.filename.split('.').pop()?.toLowerCase() ?? '';

  // SVG: extract markup, no vision needed
  if (ext === 'svg') {
    return {
      description: null,
      svgMarkup: options.imageBytes.toString('utf-8'),
      dimensions: null,
      fileType: 'svg',
    };
  }

  // Raster images: vision description
  let description: string | null = null;
  if (options.visionAdapter) {
    const result = await options.visionAdapter.describe(options.imageBytes, {
      prompt: 'Describe this image in detail. Include any text, objects, people, colors, layout, charts, diagrams, or notable features. If it appears to be a screenshot, describe the UI elements.',
    });
    description = result.description;
  }

  // Try to get dimensions
  const dimensions = getImageDimensions(options.imageBytes, ext);

  return {
    description,
    svgMarkup: null,
    dimensions,
    fileType: ext,
  };
}

function getImageDimensions(buffer: Buffer, ext: string): { width: number; height: number } | null {
  try {
    if (ext === 'png') {
      // PNG: width at offset 16-19, height at 20-23 (big-endian)
      if (buffer.length >= 24) {
        return {
          width: buffer.readUInt32BE(16),
          height: buffer.readUInt32BE(20),
        };
      }
    } else if (ext === 'jpg' || ext === 'jpeg') {
      // JPEG: parse SOF marker for dimensions
      // Simplified — just return null for now
    } else if (ext === 'webp') {
      // WebP: dimensions at offset 26-29 (little-endian)
      if (buffer.length >= 30) {
        return {
          width: buffer.readUInt16LE(26),
          height: buffer.readUInt16LE(28),
        };
      }
    }
  } catch {
    // Ignore dimension parsing errors
  }
  return null;
}
```

### 2. Async Processing in Upload Route

```typescript
// apps/server/src/routes/uploads.ts

import { processImage } from '@trail/pipelines';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg']);

// In upload handler:
if (IMAGE_EXTENSIONS.has(ext)) {
  processImageAsync(trail, docId, tenant.id, kbId, user.id, file.name, buffer, ext).catch(async (err) => {
    console.error(`[image] pipeline failed for ${file.name}:`, err);
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

export async function processImageAsync(
  trail: TrailDatabase,
  docId: string,
  tenantId: string,
  kbId: string,
  userId: string,
  filename: string,
  buffer: Buffer,
  ext: string,
): Promise<void> {
  await trail.db
    .update(documents)
    .set({ status: 'processing', updatedAt: new Date().toISOString() })
    .where(eq(documents.id, docId))
    .run();

  console.log(`[image] processing ${filename}...`);
  const vision = createVisionBackendFromEnv();
  const result = await processImage({
    imageBytes: buffer,
    filename,
    visionAdapter: vision,
  });

  let content: string;
  let title: string;

  if (ext === 'svg') {
    // SVG: embed markup in markdown
    content = `---\ntitle: ${filename}\nsource: uploaded image\nfileType: svg\n---\n\n${result.svgMarkup}`;
    title = filename.replace(/\.svg$/i, '');
  } else {
    // Raster: vision description as content
    content = `---\ntitle: ${filename}\nsource: uploaded image\nfileType: ${ext}\n${result.dimensions ? `dimensions: ${result.dimensions.width}x${result.dimensions.height}\n` : ''}---\n\n${result.description ?? '(No description available — vision backend not configured)'}`;
    title = filename.replace(/\.[^.]+$/, '');
  }

  await trail.db
    .update(documents)
    .set({
      content,
      title,
      status: 'ready',
      version: 1,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(documents.id, docId))
    .run();

  if (content.trim()) {
    const chunks = chunkText(content);
    await storeChunks(trail, docId, tenantId, kbId, chunks);
  }

  triggerIngest({ trail, docId, kbId, tenantId, userId });
}
```

### 3. SVG Rendering in Admin

```typescript
// apps/admin/src/components/image-renderer.tsx

import { h } from 'preact';

interface ImageRendererProps {
  content: string;
  fileType: string;
  docId: string;
}

export function ImageRenderer({ content, fileType, docId }: ImageRendererProps) {
  if (fileType === 'svg') {
    // Extract SVG markup from content (between frontmatter and end)
    const svgMatch = content.match(/---\n[\s\S]*?\n---\n\n([\s\S]*)/);
    const svgMarkup = svgMatch?.[1] ?? '';

    return h('div', { class: 'svg-container', dangerouslySetInnerHTML: { __html: svgMarkup } });
  }

  // Raster image: show via image endpoint
  return h('img', {
    src: `/api/v1/images/${docId}/${encodeURIComponent(filename)}`,
    alt: filename,
    class: 'raster-image',
  });
}
```

### 4. CSS for Image Display

```css
/* apps/admin/src/styles/images.css */

.svg-container {
  background: white;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 16px;
  overflow: auto;
}

.svg-container svg {
  max-width: 100%;
  height: auto;
}

.raster-image {
  max-width: 100%;
  height: auto;
  border-radius: 6px;
  border: 1px solid var(--border);
}
```

## Impact Analysis

### Files created (new)
- `packages/pipelines/src/image.ts` — image processing with vision + SVG passthrough
- `packages/pipelines/src/__tests__/image.test.ts`
- `apps/admin/src/components/image-renderer.tsx` — SVG/raster display
- `apps/admin/src/styles/images.css` — image display styling

### Files modified
- `apps/server/src/routes/uploads.ts` — add image extensions to allowed list + async processing
- `packages/shared/src/connectors.ts` — `upload` connector already covers images

### Downstream dependents for modified files

**`apps/server/src/routes/uploads.ts`** is imported by 7 files (see F24 analysis). Adding image processing is additive — no consumer changes needed.

### Blast radius
- Image files already land with `status: 'pending'` — this makes them actually process
- Vision API calls cost ~$0.02-0.05 per image — should be noted in docs
- SVG files are stored as-is — no transformation, no security sanitization (SVG can contain scripts — consider sanitization for Phase 2)
- Large images (>10MB) may hit vision API limits — Anthropic supports up to 5MB per image

### Breaking changes
None.

### Test plan
- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Unit: `processImage` returns SVG markup for .svg files
- [ ] Unit: `processImage` calls vision adapter for .png files
- [ ] Unit: `getImageDimensions` extracts dimensions from PNG header
- [ ] Integration: Upload PNG → vision description appears in source content
- [ ] Integration: Upload SVG → SVG markup embedded in source content
- [ ] Integration: Admin renders SVG inline, raster via image endpoint
- [ ] Integration: Ingest triggers after image processing
- [ ] Regression: PDF/DOCX upload flow unchanged
- [ ] Regression: Existing pending image files get processed

## Implementation Steps

1. Create `packages/pipelines/src/image.ts` with processImage function
2. Write unit tests with sample image fixtures
3. Add image extensions to upload route's allowed list
4. Implement `processImageAsync` in upload route
5. Create `ImageRenderer` component for SVG/raster display
6. Add image CSS styling
7. Integration test: upload real PNG/SVG → verify processing → verify rendering
8. Test vision API integration with real images

## Dependencies

- F27 (Pluggable Vision Adapter) — uses vision adapter for image descriptions
- F08 (PDF Pipeline) — shares vision backend pattern

## Effort Estimate

**Small** — 1-2 days

- Day 1: Image processing function + unit tests + upload route integration
- Day 2: Admin rendering + CSS + integration testing with real images
