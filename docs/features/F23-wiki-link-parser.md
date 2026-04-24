# F23 — Wiki-Link Parser (`[[]]`, `[[kb:]]`, `[[ext:]]`)

> **Status: Shipped 2026-04-24.** Canonical parser + renderer i `packages/shared/src/wiki-links/`, shared mellem server (backlink-extractor + link-checker + chat) og admin (wiki-reader, queue, neuron-editor, chat). Intra + cross-KB (tenant-scoped kb-slug resolver) + external placeholder. Display-label vs edge-type pipe disambigueres via closed-set check (F137 compat). Verification: `packages/shared/scripts/verify-wiki-links.ts` — 30+ asserts grønne.
>
> Parser der genkender tre wiki-link prefixes i markdown: `[[page]]` (intra-KB), `[[kb:other-kb/page]]` (cross-KB, same tenant), `[[ext:tenant/kb/page]]` (federated, Phase 3). Resolveres til klikbare links i admin UI og widget.

## Problem

Trail's wiki-sider indeholder cross-references mellem Neurons — f.eks. `[[zoneterapi-historie]]` eller `[[kb:sanne-andersen/akutte-tilstande]]`. I dag renderes disse som ren tekst fordi der ingen parser er der konverterer dem til klikbare links. Curatoren kan ikke navigere mellem relaterede Neurons, og chat-svar med wiki-links viser ikke links.

Karpathy's model bruger `[[backlinks]]` som en central mekanisme — hver Neuron linker til relaterede Neurons, og backlinks viser "hvem linker til mig". Uden en parser er dette mønster ikke muligt i Trail.

## Solution

En `parseWikiLinks(markdown)` funktion der finder alle `[[...]]` mønstre og resolverer dem til `{ type, target, label }` objekter. Resolveringen afhænger af prefix:

- `[[page]]` → lookup i samme KB
- `[[kb:slug/page]]` → lookup i anden KB, samme tenant
- `[[ext:tenant/kb/page]]` → placeholder for Phase 3 federation

Parseren kører som en transform på markdown content før rendering, og som en separat step under ingest for at bygge `document_references` rows.

## Technical Design

### 1. Link Pattern Regex

```typescript
// packages/core/src/links/parser.ts

export interface WikiLink {
  /** Full match including brackets */
  raw: string;
  /** Type of link */
  type: 'intra' | 'cross-kb' | 'external';
  /** Target KB slug (null for intra) */
  kbSlug: string | null;
  /** Target tenant slug (null for intra/cross-kb) */
  tenantSlug: string | null;
  /** Target page path/slug */
  pagePath: string;
  /** Optional display label (after |) */
  label: string | null;
}

// Matches: [[page]], [[kb:slug/page]], [[ext:tenant/kb/page]], [[page|label]]
const WIKI_LINK_REGEX = /\[\[(?:ext:([^/]+)\/([^/]+)\/)?(?:kb:([^/]+)\/)?([^\]|]+)(?:\|([^\]]+))?\]\]/g;

export function parseWikiLinks(markdown: string): WikiLink[] {
  const links: WikiLink[] = [];
  let match;

  while ((match = WIKI_LINK_REGEX.exec(markdown)) !== null) {
    const [, extTenant, extKb, kbSlug, pagePath, label] = match;

    let type: WikiLink['type'];
    if (extTenant) {
      type = 'external';
    } else if (kbSlug) {
      type = 'cross-kb';
    } else {
      type = 'intra';
    }

    links.push({
      raw: match[0],
      type,
      tenantSlug: extTenant ?? null,
      kbSlug: kbSlug ?? extKb ?? null,
      pagePath: pagePath.trim(),
      label: label?.trim() ?? null,
    });
  }

  return links;
}
```

### 2. Link Resolver

```typescript
// packages/core/src/links/resolver.ts

import { documents, knowledgeBases, tenants } from '@trail/db';
import { eq, and, or } from 'drizzle-orm';

export interface ResolvedLink {
  link: WikiLink;
  /** Resolved document ID (null if not found) */
  documentId: string | null;
  /** Resolved document title */
  documentTitle: string | null;
  /** Whether the target exists */
  exists: boolean;
  /** Public URL for the target (if resolvable) */
  url: string | null;
}

export async function resolveWikiLinks(
  trail: TrailDatabase,
  links: WikiLink[],
  sourceKbId: string,
  sourceTenantId: string,
): Promise<ResolvedLink[]> {
  const results: ResolvedLink[] = [];

  for (const link of links) {
    let doc = null;

    if (link.type === 'intra') {
      // Lookup in same KB
      doc = await trail.db
        .select()
        .from(documents)
        .where(and(
          eq(documents.knowledgeBaseId, sourceKbId),
          or(
            eq(documents.path, `/neurons/${link.pagePath}.md`),
            eq(documents.path, `/neurons/${link.pagePath}/index.md`),
          ),
          eq(documents.kind, 'wiki'),
        ))
        .get();
    } else if (link.type === 'cross-kb') {
      // Lookup in other KB, same tenant
      const targetKb = await trail.db
        .select()
        .from(knowledgeBases)
        .where(and(
          eq(knowledgeBases.tenantId, sourceTenantId),
          eq(knowledgeBases.slug, link.kbSlug!),
        ))
        .get();

      if (targetKb) {
        doc = await trail.db
          .select()
          .from(documents)
          .where(and(
            eq(documents.knowledgeBaseId, targetKb.id),
            or(
              eq(documents.path, `/neurons/${link.pagePath}.md`),
              eq(documents.path, `/neurons/${link.pagePath}/index.md`),
            ),
            eq(documents.kind, 'wiki'),
          ))
          .get();
      }
    } else {
      // External — not resolvable in Phase 1
      doc = null;
    }

    results.push({
      link,
      documentId: doc?.id ?? null,
      documentTitle: doc?.title ?? null,
      exists: !!doc,
      url: doc ? `/neurons/${doc.id}` : null,
    });
  }

  return results;
}
```

### 3. Markdown Transform (for rendering)

```typescript
// packages/core/src/links/render.ts

export function renderWikiLinks(
  markdown: string,
  resolvedLinks: ResolvedLink[],
): string {
  let result = markdown;

  // Sort by raw length descending to avoid partial replacements
  const sorted = [...resolvedLinks].sort((a, b) => b.link.raw.length - a.link.raw.length);

  for (const resolved of sorted) {
    const { link, exists, url, documentTitle } = resolved;
    const displayText = link.label ?? documentTitle ?? link.pagePath;

    if (exists && url) {
      result = result.replace(
        link.raw,
        `[${displayText}](${url})`,
      );
    } else if (link.type === 'external') {
      // External links render as plain text with indicator
      result = result.replace(
        link.raw,
        `<span class="wiki-link-external" title="Federated link (not yet available)">${displayText}</span>`,
      );
    } else {
      // Broken link — render with warning style
      result = result.replace(
        link.raw,
        `<span class="wiki-link-broken" title="Target not found: ${link.pagePath}">${displayText}?</span>`,
      );
    }
  }

  return result;
}
```

### 4. Build document_references from Links

```typescript
// packages/core/src/links/references.ts

import { documentReferences } from '@trail/db';

export async function buildDocumentReferences(
  trail: TrailDatabase,
  sourceDocId: string,
  resolvedLinks: ResolvedLink[],
): Promise<void> {
  // Delete existing references from this source
  await trail.db
    .delete(documentReferences)
    .where(eq(documentReferences.sourceDocumentId, sourceDocId))
    .run();

  // Insert new references for resolved links
  for (const resolved of resolvedLinks) {
    if (resolved.exists && resolved.documentId) {
      await trail.db.insert(documentReferences).values({
        id: crypto.randomUUID(),
        sourceDocumentId: sourceDocId,
        targetDocumentId: resolved.documentId,
        edgeType: 'wiki-link',
      }).run();
    }
  }
}
```

### 5. Integration with Ingest

```typescript
// apps/server/src/services/ingest.ts — add link processing

import { parseWikiLinks, resolveWikiLinks, buildDocumentReferences } from '@trail/core';

// After compiling wiki page:
const links = parseWikiLinks(compiledResult.markdown);
const resolved = await resolveWikiLinks(trail, links, kbId, tenantId);
await buildDocumentReferences(trail, docId, resolved);

// Store rendered markdown with links
const renderedMarkdown = renderWikiLinks(compiledResult.markdown, resolved);
```

### 6. Admin UI Rendering

```typescript
// apps/admin/src/lib/markdown-renderer.ts — integrate wiki links

import { parseWikiLinks, resolveWikiLinks, renderWikiLinks } from '@trail/core';

// In the render function:
export async function renderMarkdown(content: string, kbId: string, tenantId: string): Promise<string> {
  const links = parseWikiLinks(content);
  const resolved = await resolveWikiLinks(getTrail(), links, kbId, tenantId);
  const withLinks = renderWikiLinks(content, resolved);
  return marked(withLinks);
}
```

### 7. CSS for Link States

```css
/* apps/admin/src/styles/wiki-links.css */

.wiki-link-broken {
  color: #dc2626;
  text-decoration: underline wavy #dc2626;
  cursor: help;
}

.wiki-link-external {
  color: #6b6560;
  font-style: italic;
  cursor: not-allowed;
}

a.wiki-link {
  color: #e8a87c;
  text-decoration: none;
  border-bottom: 1px solid #e8a87c;
}

a.wiki-link:hover {
  color: #d4956a;
  border-bottom-color: #d4956a;
}
```

## Impact Analysis

### Files created (new)
- `packages/core/src/links/parser.ts` — regex parser for wiki links
- `packages/core/src/links/resolver.ts` — resolve links to documents
- `packages/core/src/links/render.ts` — transform markdown with resolved links
- `packages/core/src/links/references.ts` — build document_references from links
- `packages/core/src/links/__tests__/parser.test.ts`
- `packages/core/src/links/__tests__/resolver.test.ts`
- `apps/admin/src/styles/wiki-links.css` — link state styling

### Files modified
- `packages/core/src/index.ts` — export links module
- `apps/server/src/services/ingest.ts` — parse links, build references after compile
- `apps/admin/src/lib/markdown-renderer.ts` — render wiki links as clickable
- `apps/admin/src/styles/main.css` — import wiki-links.css

### Downstream dependents for modified files

**`apps/server/src/services/ingest.ts`** is imported by 9 files (see F21 analysis). Adding link parsing is additive — existing callers get document_references populated automatically.

**`apps/admin/src/panels/neuron-editor.tsx`** is imported by 1 file (1 ref):
- `apps/admin/src/app.tsx` (1 ref) — renders editor panel, unaffected by link rendering

### Blast radius
- Wiki links are opt-in — content without `[[...]]` patterns is unaffected
- Broken links render with visual indicator (red wavy underline) — curator can fix
- External links (`[[ext:...]]`) render as disabled text until Phase 3 federation
- `document_references` table gets new rows with `edgeType: 'wiki-link'` — existing references (source→wiki) are unaffected

### Breaking changes
None. Wiki links are additive.

### Test plan
- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Unit: `parseWikiLinks` extracts intra, cross-kb, and external links
- [ ] Unit: `parseWikiLinks` handles `[[page|label]]` syntax
- [ ] Unit: `parseWikiLinks` ignores non-link `[[text]]` that doesn't match patterns
- [ ] Unit: `resolveWikiLinks` finds intra-KB documents by path
- [ ] Unit: `resolveWikiLinks` returns exists=false for missing targets
- [ ] Integration: Compile source with `[[other-page]]` → document_references row created
- [ ] Integration: Admin renders wiki link as clickable `<a>` tag
- [ ] Integration: Broken wiki link renders with red wavy underline
- [ ] Regression: Markdown without wiki links renders unchanged
- [ ] Regression: Existing document_references (source→wiki) unaffected

## Implementation Steps

1. Create `packages/core/src/links/parser.ts` with regex + unit tests
2. Create `packages/core/src/links/resolver.ts` with DB lookup logic + unit tests
3. Create `packages/core/src/links/render.ts` for markdown transform
4. Create `packages/core/src/links/references.ts` for document_references building
5. Integrate link parsing into ingest pipeline
6. Update markdown renderer to resolve and render wiki links
7. Add CSS for link states (valid, broken, external)
8. Manual test: create Neuron with `[[link]]` → verify reference + rendering

## Dependencies

- F15 (Bidirectional document_references) — wiki links populate this table
- F07 (Wiki Document Model) — links reference wiki documents

## Effort Estimate

**Small** — 1-2 days

- Day 1: Parser + resolver + references builder + unit tests
- Day 2: Ingest integration + markdown renderer + CSS + manual testing
