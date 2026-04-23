# F26 — HTML / Web Clipper Ingest

> Server-side HTML ingest pipeline: URL eller raw HTML → Readability cleanup → markdown → source document → auto-trigger wiki compile.

## Problem

I dag kan Trail kun ingest'e filer der uploades manuelt (PDF, DOCX, markdown, etc.). Der er ingen server-side sti til at ingest'e web content — brugeren skal selv kopiere HTML indhold, gemme som `.html` fil og uploade. Det er friktion der begrænser hvor ofte web content faktisk lander i Trail.

F111 (Web Clipper browser extension) løser dette for browser-brugere, men der er ingen API-endpoint for server-side HTML ingest — f.eks. fra scripts, CI pipelines, eller andre services der vil poste en URL eller raw HTML til Trail.

## Solution

Ny endpoint `POST /api/v1/knowledge-bases/:kbId/documents/ingest-html` der accepterer enten:
- En URL → serveren fetcher siden, kører Readability cleanup, konverterer til markdown
- Raw HTML → serveren kører Readability cleanup, konverterer til markdown

Resultatet er en `.md` source document der automatisk trigger ingest pipeline (samme flow som manuel upload).

## Technical Design

### 1. HTML Ingest Endpoint

```typescript
// apps/server/src/routes/html-ingest.ts

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';

const ingestHtmlSchema = z.object({
  url: z.string().url().optional(),
  html: z.string().optional(),
  title: z.string().optional(),
  path: z.string().default('/web/'),
  tags: z.array(z.string()).optional(),
}).refine((data) => data.url || data.html, {
  message: 'Either url or html must be provided',
});

export const htmlIngestRoutes = new Hono();

htmlIngestRoutes.post(
  '/knowledge-bases/:kbId/documents/ingest-html',
  zValidator('json', ingestHtmlSchema),
  async (c) => {
    const trail = getTrail(c);
    const user = getUser(c);
    const tenant = getTenant(c);
    const kbId = await resolveKbId(trail, tenant.id, c.req.param('kbId'));

    const { url, html, title, path, tags } = c.req.valid('json');

    let rawHtml: string;
    let sourceTitle: string;

    if (url) {
      // Fetch URL
      const response = await fetch(url, {
        headers: { 'User-Agent': 'TrailWebClipper/1.0' },
      });
      if (!response.ok) {
        return c.json({ error: `Failed to fetch URL: ${response.status}` }, 400);
      }
      rawHtml = await response.text();
      sourceTitle = title || extractTitleFromHtml(rawHtml) || url;
    } else {
      rawHtml = html!;
      sourceTitle = title || extractTitleFromHtml(rawHtml) || 'Untitled';
    }

    // Readability cleanup
    const cleaned = await runReadability(rawHtml);
    if (!cleaned) {
      return c.json({ error: 'Could not extract readable content' }, 400);
    }

    // Convert to markdown
    const markdown = htmlToMarkdown(cleaned.content);

    // Create source document (same flow as upload endpoint)
    const docId = crypto.randomUUID();
    const filename = `${slugify(sourceTitle)}.md`;
    const content = buildFrontmatter(sourceTitle, url, tags) + '\n\n' + markdown;

    // Store and trigger ingest (reuse upload logic)
    await storeAndIngest(trail, tenant.id, kbId, user.id, docId, filename, content, 'md', path);

    return c.json({ id: docId, title: sourceTitle, status: 'processing' }, 201);
  },
);
```

### 2. Readability Integration

```typescript
// apps/server/src/lib/readability.ts

import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';

export interface ReadabilityResult {
  title: string;
  content: string; // HTML
  textContent: string;
  length: number;
}

export async function runReadability(html: string): Promise<ReadabilityResult | null> {
  const dom = new JSDOM(html, { url: 'http://localhost' });
  const reader = new Readability(dom.window.document, {
    keepClasses: false,
    charThreshold: 0,
  });
  return reader.parse();
}
```

### 3. HTML to Markdown Conversion

```typescript
// apps/server/src/lib/html-to-markdown.ts

import TurndownService from 'turndown';

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
});

turndown.addRule('remove-scripts', {
  filter: ['script', 'style', 'noscript', 'iframe', 'nav', 'footer', 'header'],
  replacement: () => '',
});

export function htmlToMarkdown(html: string): string {
  return turndown.turndown(html);
}
```

### 4. Frontmatter Builder

```typescript
// apps/server/src/lib/frontmatter.ts

export function buildFrontmatter(
  title: string,
  sourceUrl: string | undefined,
  tags: string[] | undefined,
): string {
  const lines = ['---', `title: ${title}`, `clippedAt: ${new Date().toISOString()}`, `connector: web-clipper`];
  if (sourceUrl) lines.push(`source: ${sourceUrl}`);
  if (tags?.length) lines.push(`tags: [${tags.join(', ')}]`);
  lines.push('---');
  return lines.join('\n');
}
```

### 5. Reuse Upload Logic

```typescript
// apps/server/src/services/html-ingest.ts

import { documents } from '@trail/db';
import { eq, sql } from 'drizzle-orm';
import { storage, sourcePath } from '../lib/storage.js';
import { chunkText, storeChunks } from '../services/chunker.js';
import { triggerIngest } from '../services/ingest.js';

export async function storeAndIngest(
  trail: TrailDatabase,
  tenantId: string,
  kbId: string,
  userId: string,
  docId: string,
  filename: string,
  content: string,
  ext: string,
  path: string,
): Promise<void> {
  const buffer = Buffer.from(content, 'utf-8');
  await storage.put(sourcePath(tenantId, kbId, docId, ext), buffer, 'text/markdown');

  await trail.db.insert(documents).values({
    id: docId,
    tenantId,
    knowledgeBaseId: kbId,
    userId,
    kind: 'source',
    filename,
    path,
    fileType: ext,
    fileSize: buffer.length,
    status: 'processing',
    seq: sql<number>`COALESCE((SELECT MAX(${documents.seq}) FROM ${documents} WHERE ${documents.knowledgeBaseId} = ${kbId}), 0) + 1`,
  }).run();

  await trail.db.update(documents).set({
    content,
    title: filename.replace(/\.md$/, ''),
    version: 1,
  }).where(eq(documents.id, docId)).run();

  const chunks = chunkText(content);
  await storeChunks(trail, docId, tenantId, kbId, chunks);

  triggerIngest({ trail, docId, kbId, tenantId, userId });
}
```

## Impact Analysis

### Files created (new)
- `apps/server/src/routes/html-ingest.ts` — new endpoint
- `apps/server/src/lib/readability.ts` — Readability wrapper
- `apps/server/src/lib/html-to-markdown.ts` — Turndown wrapper
- `apps/server/src/lib/frontmatter.ts` — frontmatter builder
- `apps/server/src/services/html-ingest.ts` — store + ingest helper

### Files modified
- `apps/server/src/app.ts` — mount `htmlIngestRoutes`
- `apps/server/package.json` — add `@mozilla/readability`, `jsdom`, `turndown`

### Downstream dependents for modified files

**`apps/server/src/app.ts`** is imported by 4 files (see F20 analysis). Adding a new route mount is additive — no consumer changes needed.

### Blast radius
- New endpoint is additive — doesn't affect existing upload flow
- Readability + Turndown are server-side only — no client bundle impact
- `storeAndIngest` reuses existing `storage`, `chunkText`, `storeChunks`, `triggerIngest` — no changes to those
- Rate limiting: should consider adding rate limit for URL fetching to prevent abuse

### Breaking changes
None. All changes are additive.

### Test plan
- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Unit: `runReadability` extracts content from complex HTML (nav, footer, scripts stripped)
- [ ] Unit: `htmlToMarkdown` converts headings, lists, links, code blocks correctly
- [ ] Unit: `buildFrontmatter` produces valid YAML frontmatter with optional fields
- [ ] Integration: POST with URL → returns 201 with docId, source document created
- [ ] Integration: POST with raw HTML → returns 201, content matches expected markdown
- [ ] Integration: POST with invalid URL → returns 400
- [ ] Integration: POST with neither url nor html → returns 400
- [ ] Integration: Ingest is auto-triggered after HTML ingest (check queue for new candidate)
- [ ] Regression: Existing upload endpoint unchanged
- [ ] Regression: PDF/DOCX pipelines unaffected

## Implementation Steps

1. Add dependencies: `@mozilla/readability`, `jsdom`, `turndown` to `apps/server/package.json`
2. Create `lib/readability.ts` with `runReadability()` + unit tests
3. Create `lib/html-to-markdown.ts` with Turndown config + unit tests
4. Create `lib/frontmatter.ts` with `buildFrontmatter()` + unit tests
5. Create `services/html-ingest.ts` with `storeAndIngest()` helper
6. Create `routes/html-ingest.ts` with POST endpoint
7. Mount route in `app.ts`
8. Add integration tests for URL and raw HTML flows
9. Add rate limiting middleware for URL fetches

## Dependencies

- F111 (Web Clipper) — already shipped, shares same connector ID (`web-clipper`)
- Existing `storage`, `chunker`, `ingest` services — already exist
- No new database columns needed

## Effort Estimate

**Small** — 1-2 days

- Day 1: Dependencies + readability/turndown wrappers + frontmatter + store helper + endpoint
- Day 2: Tests + rate limiting + polish
