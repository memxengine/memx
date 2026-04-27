# F161 — Inline media in retrieval responses (image-database approach)

> Selvstændig `document_images`-tabel der gør PDF-extracted billeder til førsteklasses media-objekter med Vision-genereret beskrivelse, content-hash, dimensioner, sidetal, og audit-trail. Bagved-kulisserne lever billed-bytes stadig i samme storage-struktur de altid har gjort, men strukturen omkring dem persisteres nu så vi kan: (1) returnere `images[]`-array i `/retrieve` for site-LLM-orchestratorer, (2) eksponere image-search via `GET /knowledge-bases/:kbId/images?q=`, (3) re-run Vision på alle billeder med ny model uden re-ingest, (4) deduplikere identiske bytes på tværs af PDFs (samme mønster som F162 source-dedup), (5) audience-filter så `tool`/`public` keys ikke kan hente billeder fra heuristic/internal-tagged Neurons via direkte URL-gæt. Tier: alle tenants. Effort: Medium — ~4-5 timer. Status: Planned.

## Problem

Trail har **ingen struktureret persistering** af PDF-extracted billeder. PDF-pipelinen (`packages/pipelines/src/pdf/index.ts`) gør tre ting:

1. Læser bytes fra hver indlejret billede i PDF'en
2. Skriver dem til `{tenant}/{kb}/{docId}/images/page1-fig1.png` via `storage.put()`
3. Kører Vision-callback (Anthropic Claude eller OpenRouter Gemini-Vision) for billeder ≥100×100px og får 1-2 sætningers beskrivelse
4. **Embedder beskrivelsen som alt-tekst i compiled wiki-Neurons markdown:** `![{vision-description}](url)`

Det fungerer for prose-rendering — admin-UI render Neurons og ser billederne. Men der er **fem konkrete behov vi ikke kan dække i dag**:

### 1. Sanne kan ikke se sine billeder

Når Sanne uploader en PDF med 12 indlejrede behandlings-fotos, ender alt info om dem som alt-tekst spredt i forskellige wiki-Neurons. Hun har ingen "billede-galleri-view" der viser alle fotos i KB'en. Eir-chatten kan vise dem inline i et svar (efter F161 v1's markdown-parse), men hun kan ikke browse dem.

### 2. Retrieve-API kan kun parse markdown

For at returnere `images[]`-array i `/retrieve` skal vi parse `![alt](url)`-syntaksen ud af hver chunk-text. Det er fragile (formattering ændrer sig, alt-tekst kan blive trimmet i midtvejs-recompile, image-URLs kan blive omformede til admin-paths via F30 `rewriteWikiLinks`). En struktureret tabel-lookup er deterministisk.

### 3. Vision kan ikke re-køres på bedre model

Når Anthropic udgiver Claude Vision 5 om 6 måneder vil vi gerne gen-generere alle billed-beskrivelser. I dag kræver det fuld re-ingest af PDF'en (re-extract → re-Vision → re-compile → ny wiki-Neuron-version). Med en tabel-baseret tilgang er det `UPDATE document_images SET vision_description = newVision(blob) WHERE …`.

### 4. Image-dedup er umulig

Samme PNG indlejret i to PDFs (fx Sanne's "logo.png" der optræder i alle hendes hand-outs) gemmes som to separate blobs. F162 løste source-dedup; image-dedup er det samme mønster én lag dybere.

### 5. Audience-bypass via image-URL

`GET /api/v1/documents/:docId/images/:filename` (`apps/server/src/routes/images.ts`) tjekker kun tenant-scope, ikke audience. Et `tool`-Bearer key kan i dag GET'e et billede tilknyttet en `/neurons/heuristics/`-Neuron eller en `internal`-tagged Neuron hvis URL'en gættes. Lille men reel attack-vector.

## Secondary Pain Points

- **Vision-cost ikke synligt**. Vi kører Vision automatisk under PDF-ingest men har ingen audit-trail for "denne beskrivelse koster X tokens med model Y, kørt på dato Z". Når vi senere vil prissætte Vision-credits separat (F156-extension) skal vi vide hvor meget Vision-arbejde der er udført historisk.
- **Image-pipeline (F25) lider af samme problem**. Standalone PNG/JPG-uploads (`packages/pipelines/src/image/pipeline.ts`) går igennem `describeImageAsSource` som producerer en hel Source-Neuron med beskrivelsen — men selve image-metadata (dim, EXIF, GPS, dato) gemmes ikke. F161's `document_images` skal også dække dette case.
- **Audio (F47)** vil få samme behov: når audio-Neurons skal kunne afspilles inline med transcript-segmenter, skal der være en `document_audio_clips`-tabel. F161 sætter mønstret nu så F47-audio-version bare kopierer.
- **`![alt](url)` i markdown er ikke tabellen, det er en VIEW**. Når vi ændrer Vision-beskrivelsen i tabellen, skal compiled wiki-Neurons enten (a) recompile'es, eller (b) markdown skal stoppe være kanonisk og kun bruges til admin-rendering. v1 går med (a) — recompile er den eksisterende mekaniske vej for at få ny content ud i Neurons.

## Solution

### Schema — ny `document_images`-tabel

Migration 0025:

```sql
CREATE TABLE document_images (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,

  -- Storage identity
  filename TEXT NOT NULL,            -- "page1-fig1.png"
  storage_path TEXT NOT NULL,        -- "{tenant}/{kb}/{docId}/images/page1-fig1.png"
  content_hash TEXT NOT NULL,        -- SHA-256 hex of PNG bytes (F162-style dedup)
  size_bytes INTEGER NOT NULL,

  -- Image metadata
  page INTEGER,                      -- PDF page-number, NULL for standalone uploads
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,

  -- Vision metadata
  vision_description TEXT,           -- 1-2 sentences from Vision-backend, NULL if too small or skipped
  vision_model TEXT,                 -- "claude-3-5-sonnet" / "google/gemini-2.5-flash" — for re-run audit
  vision_at TEXT,                    -- ISO timestamp of when description was generated
  vision_cost_cents INTEGER,         -- Optional: token-cost for the Vision call (future F156 extension)

  -- Audit
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_doc_images_document ON document_images(document_id);
CREATE INDEX idx_doc_images_kb ON document_images(tenant_id, knowledge_base_id);
CREATE INDEX idx_doc_images_hash ON document_images(tenant_id, knowledge_base_id, content_hash);

-- FTS5 virtual table for image-search (vision_description searchable per KB).
-- Uses contentless mode so we don't double-store the description text.
CREATE VIRTUAL TABLE document_images_fts USING fts5(
  vision_description,
  content='document_images',
  content_rowid='rowid'
);

-- Triggers keep FTS in sync with the base table.
CREATE TRIGGER document_images_fts_insert AFTER INSERT ON document_images BEGIN
  INSERT INTO document_images_fts(rowid, vision_description)
  VALUES (new.rowid, new.vision_description);
END;
CREATE TRIGGER document_images_fts_delete AFTER DELETE ON document_images BEGIN
  INSERT INTO document_images_fts(document_images_fts, rowid, vision_description)
  VALUES ('delete', old.rowid, old.vision_description);
END;
CREATE TRIGGER document_images_fts_update AFTER UPDATE ON document_images BEGIN
  INSERT INTO document_images_fts(document_images_fts, rowid, vision_description)
  VALUES ('delete', old.rowid, old.vision_description);
  INSERT INTO document_images_fts(rowid, vision_description)
  VALUES (new.rowid, new.vision_description);
END;
```

### Persistering ved upload

`apps/server/src/services/document-images.ts`:

```typescript
import { createHash } from 'node:crypto';
import { documentImages, type TrailDatabase } from '@trail/db';
import type { ExtractedImage } from '@trail/pipelines';

export async function persistImagesFromExtraction(
  trail: TrailDatabase,
  docId: string,
  tenantId: string,
  kbId: string,
  extracted: ExtractedImage[],
  storage: Storage,
  visionModel: string | null,
): Promise<void> {
  for (const img of extracted) {
    // Re-read bytes for hash. Could also be passed through from
    // pipeline if profiling shows this matters; for v1 the read is
    // sub-ms on local disk.
    const bytes = await storage.get(img.storagePath);
    if (!bytes) continue;
    const contentHash = createHash('sha256')
      .update(new Uint8Array(bytes))
      .digest('hex');

    await trail.db
      .insert(documentImages)
      .values({
        id: `dim_${crypto.randomUUID().slice(0, 12)}`,
        documentId: docId,
        tenantId,
        knowledgeBaseId: kbId,
        filename: img.filename,
        storagePath: img.storagePath,
        contentHash,
        sizeBytes: bytes.length,
        page: img.page,
        width: img.width,
        height: img.height,
        visionDescription: img.description ?? null,
        visionModel: img.description ? visionModel : null,
        visionAt: img.description ? new Date().toISOString() : null,
      })
      .run();
  }
}
```

Hookes ind i `apps/server/src/routes/uploads.ts` efter PDF/image-pipeline-resultat med `result.images[]`.

### Backfill — populate fra existing storage

`apps/server/src/bootstrap/backfill-document-images.ts`:

For hver `documents.kind='source'` row der ikke har nogen `document_images`-rows endnu:
1. List storage-prefix `{tenant}/{kb}/{docId}/images/` for at finde alle billed-blobs
2. For hver blob: hent bytes, compute SHA-256, læs dim via `image-size`-lib (eller `sharp` hvis pakket), INSERT row
3. Vision-description hentes fra parent wiki-Neuron's compiled markdown ved at parse `![alt](this-blob's-url)`-syntaksen — backfill bevarer eksisterende beskrivelser uden at re-køre Vision

Idempotent — re-run finder ingen "missing"-rows og er en no-op.

### Audience-filter på image-route

`apps/server/src/routes/images.ts` — tilføj F160's audience-mønster:

```typescript
import { defaultAudienceForAuth, isVisibleToAudience } from '../services/audience.js';

imageRoutes.get('/documents/:docId/images/:filename', async (c) => {
  // ... eksisterende auth + filename-validation ...

  const doc = await trail.db
    .select({
      id: documents.id,
      knowledgeBaseId: documents.knowledgeBaseId,
      path: documents.path,
      tags: documents.tags,
    })
    .from(documents)
    .where(and(eq(documents.id, docId), eq(documents.tenantId, tenant.id)))
    .get();
  if (!doc) return c.json({ error: 'Not found' }, 404);

  // F161 — audience-aware visibility check.
  const audience = defaultAudienceForAuth(c.get('authType'));
  if (!isVisibleToAudience(audience, doc.path, doc.tags)) {
    return c.json({ error: 'Not found' }, 404);
  }

  // ... eksisterende storage.get + Response ...
});
```

### `/retrieve` returnerer `images[]`

I `apps/server/src/routes/retrieve.ts`:

```typescript
// Efter chunks-filtrering, før response-build:
const docIds = Array.from(new Set(includedChunks.map((c) => c.documentId)));
const imageRows = await trail.db
  .select({
    id: documentImages.id,
    documentId: documentImages.documentId,
    filename: documentImages.filename,
    storagePath: documentImages.storagePath,
    page: documentImages.page,
    width: documentImages.width,
    height: documentImages.height,
    visionDescription: documentImages.visionDescription,
  })
  .from(documentImages)
  .where(
    and(
      eq(documentImages.tenantId, tenant.id),
      inArray(documentImages.documentId, docIds),
    ),
  )
  .limit(maxImages)
  .all();

const baseUrl = new URL(c.req.url).origin;
const images = imageRows.map((row) => ({
  documentId: row.documentId,
  filename: row.filename,
  url: `${baseUrl}/api/v1/documents/${row.documentId}/images/${row.filename}`,
  alt: row.visionDescription ?? '',
  page: row.page,
  width: row.width,
  height: row.height,
}));

return c.json({
  chunks: includedChunks,
  formattedContext,
  totalChars,
  hitCount: includedChunks.length,
  images,
});
```

### Image-search endpoint

`GET /api/v1/knowledge-bases/:kbId/images?q=&limit=`:

FTS over `document_images_fts.vision_description`, returnerer image-rows med absolutte URLs. Audience-filter ved at JOIN'e parent `documents` og bruge `isVisibleToAudience`. Bonus-feature for image-galleri-view + "find-images-about-X" use cases.

### SDK type-extension

`packages/sdk/src/types.ts`:

```typescript
export interface RetrieveImage {
  documentId: string;
  filename: string;
  url: string;
  alt: string;
  page: number | null;
  width: number;
  height: number;
}

export interface RetrieveResponse {
  // ... existing ...
  images: RetrieveImage[];
}

export interface ImageSearchOptions {
  query: string;
  audience?: Audience;
  limit?: number;
}

export interface ImageSearchHit {
  id: string;
  documentId: string;
  filename: string;
  url: string;
  alt: string;
  page: number | null;
  width: number;
  height: number;
  visionModel: string | null;
}

export interface ImageSearchResponse {
  hits: ImageSearchHit[];
}
```

`TrailClient.searchImages(kbId, opts)` tilføjes til client.ts.

### `INTEGRATION-API.md` — proxy-mønster

Ny sektion: **Rendering images**. Forklarer hvorfor `<img src="...">` med Bearer ikke virker (browser sender ikke headers), hvordan consumer bygger en server-side proxy-route, og at `/retrieve`'s `images[]`-array er den anbefalede måde at få URLs på (struktureret data fremfor markdown-parse).

```ts
// app/api/trail-image/[docId]/[filename]/route.ts (Next.js)
export async function GET(req, { params }) {
  const url = `${process.env.TRAIL_API_BASE}/api/v1/documents/${params.docId}/images/${params.filename}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.TRAIL_API_KEY}` },
  });
  if (!res.ok) return new Response('Not found', { status: res.status });
  return new Response(res.body, {
    headers: {
      'Content-Type': res.headers.get('content-type') ?? 'application/octet-stream',
      'Cache-Control': 'public, max-age=86400, immutable',
    },
  });
}
```

## Non-Goals

- **Trail leverer ikke client-side billed-rendering ud af boksen.** Det er consumer's ansvar at proxy + render.
- **Ingen public/anonym image-URLs.** Selv `audience: public` keys kræver Bearer for image-bytes.
- **Ingen image-resize / -optimization.** Trail serverer original bytes.
- **Ingen video.** F46 video-pipeline er separat.
- **Ingen breaking changes på markdown-image-syntaks.** Compile-pipeline fortsætter at skrive `![alt](url)` ind i wiki-Neurons. `images[]` er parallel struktureret view — markdown bevarer prose-rendering for admin og chat-mode-public-renderers.
- **Force=true bypass på image-dedup**. F162's force-mønster gælder ikke for embedded billeder — to PDFs der har samme logo-PNG får samme `content_hash` men IKKE samme storage-blob i v1 (vi gemmer dem separat). Lossy-dedup-via-shared-blob er Phase 2-territorium hvis storage-pressure bliver et problem.
- **Backfill kører ikke Vision på tom-description-billeder.** Hvis en eksisterende PDF har 12 billeder og kun 8 har beskrivelser (de 4 var <100px), bliver de 4 stadig NULL efter backfill. Operator kan trigge re-Vision via en manuel admin-kommando hvis ønsket.
- **Ingen UI til at se "alle billeder i denne KB"** i v1. Image-search-endpoint'et er der; admin-UI-galleri kommer som follow-up.

## Technical Design

(Detalje-snippets ovenfor — se sections "Schema", "Persistering ved upload", "Backfill", "Audience-filter på image-route", "/retrieve returnerer images[]", "Image-search endpoint", "SDK type-extension", "INTEGRATION-API.md proxy-mønster".)

## Rollout

Single-phase commit:

- [ ] Plan-doc landing
- [ ] Migration 0025 — table + indexes + FTS triggers
- [ ] Schema.ts + journal entry
- [ ] `services/document-images.ts` + persistImagesFromExtraction()
- [ ] uploads.ts — call persistImagesFromExtraction after pipeline.handle returns
- [ ] backfill-document-images bootstrap + wired into createApp
- [ ] images.ts route — audience-filter
- [ ] retrieve.ts — query images + return in response
- [ ] knowledge-bases.ts — new GET /images?q= endpoint (or new images-search.ts route)
- [ ] SDK types + searchImages method
- [ ] INTEGRATION-API.md "Rendering images" section
- [ ] verify-f161 script
- [ ] FEATURES.md + ROADMAP.md updated (already indexed in F162's commit)

## Dependencies

- F08 ✅ PDF Pipeline (extract bytes + Vision callback)
- F25 ✅ Image Pipeline (standalone uploads — same persistImagesFromExtraction call)
- F160 ✅ Audience-filter pattern + `/retrieve` endpoint
- F162 ✅ Content-hash mønster (we copy SHA-256 dedup approach)
- Vision backend (Anthropic Claude / OpenRouter Gemini-Vision) — already wired in `services/vision.ts`

## Verify plan

`apps/server/scripts/verify-f161.ts`:

1. **Schema present**: `document_images` table + 3 indexes + FTS virtual table + 3 triggers.
2. **Backfill ran**: `SELECT COUNT(*) FROM document_images` > 0 (assumes there's at least one PDF with embedded images in dev DB).
3. **Audience-filter on image-route**: probe-Neuron under `/neurons/heuristics/` with synthetic image-row → curator key gets 200, tool key gets 404.
4. **`/retrieve` returns images[]**: query targeting a chunk from a PDF with images returns `images[]` with absolute URLs + `alt` populated from `vision_description`.
5. **Image-search endpoint**: query for term that appears in any `vision_description` returns matching hit.
6. **maxImages cap**: synthetic doc with 100 images + maxImages=10 → exactly 10 in response.
7. **Cross-tenant isolation**: image-row from tenant-A not visible to tenant-B's Bearer key.
8. **Content-hash populated**: every image-row has SHA-256 hash matching the storage bytes.

## Open Questions

- **Should we deduplicate images at storage level too?** Today: same logo in two PDFs = two storage-blobs. We'd save disk if we content-addressed images by hash. **Decision for v1**: keep separate blobs. Saves the implementation complexity (storage-level CAS, garbage-collection on image-row delete). Disk-pressure isn't a real problem yet at 12MB total content.

- **Should Vision auto-fire on backfill for missing descriptions?** A legacy PDF with 5 images but only 3 descriptions (2 were too small at upload-time) — should backfill bootstrap try Vision again on the 2? **Decision**: no. Operator-triggered batch-Vision is Phase 2.

- **Should the image-search endpoint support cross-KB?** A user logged in to admin might want to search ALL their images. **Decision for v1**: per-KB (matches `/search`). Cross-KB is F38 territory.

- **Should `/retrieve` `images[]` only include images for chunks that actually returned?** Or all images for all returned `documentIds`? **Decision**: latter (simpler) — site-LLM can match by `documentId` if they want strict chunk-binding.

## Effort Estimate

~4-5 timer:
- Plan-doc: 30 min ✓ (this)
- Migration + schema: 30 min
- persistImagesFromExtraction service + upload-route hook: 45 min
- Backfill bootstrap: 45 min
- Audience-filter on image-route: 15 min
- /retrieve images[]: 30 min
- Image-search endpoint: 20 min
- SDK extension: 15 min
- INTEGRATION-API doc: 20 min
- Verify-script: 30 min
- Commit + push: 15 min

## Related Features

- **F08** PDF Pipeline (Vision-described embedded images — source data for the new table)
- **F25** Image Pipeline (Standalone uploads — same persistImagesFromExtraction call)
- **F47** Audio Transcription — sets the precedent for `document_audio_clips` table (next iteration of this pattern)
- **F160** Three-tier integration contract (Lag 1 `/retrieve` is what we extend)
- **F162** Source dedup via SHA-256 (image-dedup uses same pattern at media-level)
- **F44** Usage Metering — when Vision-cost-per-image becomes a billed dimension, `vision_cost_cents` is the audit trail
