# F22 — Stable `{#claim-xx}` Anchors

> Compileren emitterer hash-baserede anchors på hvert claim i hver compiled wiki-side. Hashed så de overlever re-compilation. Zero-cost i Phase 1; bliver join key for Phase 3 claims table (F78) uden re-parsing.

## Problem

Når en Neuron re-compiles fra sine kilder, kan indholdet ændre sig — nye oplysninger tilføjes, formuleringer justeres. Hvis eksterne systemer (CMS widget, federated Trail, API consumers) linker til specifikke dele af en Neuron via URL fragments (`#section-1`), går disse links i stykker ved re-compilation.

Karpathy's model har ikke dette problem fordi hans wiki er file-baseret med Git — hvert commit har en SHA. Men Trail's wiki er database-baseret med version numbers, og der er ingen stabil måde at referere til et specifikt claim på tværs af versioner.

## Solution

Under compile fasen parser compileren hver produceret wiki-side og identificerer individuelle claims (typisk: hvert afsnit, hver liste-item, hver definition). Hvert claim får en stabil anchor baseret på en hash af claim-indholdets **kerne** (første 50 chars normalized) — ikke den fulde tekst, så små formulæringsændringer ikke ændrer hashen.

Anchors embeddes i markdown som `{#claim-abc123}` og renderes som HTML `id="claim-abc123"`. Eksterne links kan pege på `#claim-abc123` og vil stadig virke efter re-compilation så længe claim-kernen er den samme.

## Technical Design

### 1. Claim Anchor Generation

```typescript
// packages/core/src/compile/claim-anchors.ts

import { createHash } from 'node:crypto';

/**
 * Generate a stable anchor ID for a claim.
 * Uses the first 50 chars of normalized content so minor
 * rephrasing doesn't change the anchor.
 */
export function generateClaimAnchor(content: string): string {
  // Normalize: lowercase, strip whitespace, take first 50 chars
  const normalized = content
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 50);

  // Hash to 8-char hex
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, 8);
  return `claim-${hash}`;
}

/**
 * Inject claim anchors into markdown content.
 * Processes headings, list items, and paragraph blocks.
 */
export function injectClaimAnchors(markdown: string): string {
  const lines = markdown.split('\n');
  const result: string[] = [];

  for (const line of lines) {
    // Headings: # Title → # Title {#claim-xxx}
    if (/^#{1,6}\s+/.test(line)) {
      const anchor = generateClaimAnchor(line.replace(/^#+\s+/, ''));
      result.push(`${line} {#${anchor}}`);
      continue;
    }

    // List items: - Item → - Item {#claim-xxx}
    if (/^\s*[-*+]\s+/.test(line)) {
      const content = line.replace(/^\s*[-*+]\s+/, '');
      const anchor = generateClaimAnchor(content);
      result.push(`${line} {#${anchor}}`);
      continue;
    }

    // Definition-style: **Term**: Description → {#claim-xxx}
    if (/^\*\*[^*]+\*\*:/.test(line)) {
      const anchor = generateClaimAnchor(line);
      result.push(`{#${anchor}}\n${line}`);
      continue;
    }

    // Regular paragraphs: inject anchor at start
    if (line.trim() && !line.startsWith('---') && !line.startsWith('```')) {
      const anchor = generateClaimAnchor(line);
      result.push(`{#${anchor}}\n${line}`);
      continue;
    }

    result.push(line);
  }

  return result.join('\n');
}

/**
 * Extract claim anchors from markdown content.
 * Returns map of anchor ID → claim text.
 */
export function extractClaimAnchors(markdown: string): Map<string, string> {
  const anchors = new Map<string, string>();
  const lines = markdown.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/\{#(claim-[a-f0-9]{8})\}/);
    if (match) {
      const anchorId = match[1];
      // Claim text is the next non-empty line (or the rest of current line after anchor)
      const anchorOnLine = lines[i].replace(/\{#claim-[a-f0-9]{8}\}/, '').trim();
      const claimText = anchorOnLine || (lines[i + 1] ?? '');
      anchors.set(anchorId, claimText);
    }
  }

  return anchors;
}
```

### 2. Integration with Compiler

```typescript
// packages/core/src/compile/compiler.ts — modify compile step

import { injectClaimAnchors } from './claim-anchors.js';

// In the compile pipeline, after LLM generates markdown:
async function compileSource(source: Source, existingWiki: WikiState): Promise<CompiledResult> {
  // ... existing LLM compile logic ...

  const rawMarkdown = llmResponse.content;

  // Inject stable claim anchors
  const anchoredMarkdown = injectClaimAnchors(rawMarkdown);

  // Extract anchors for metadata
  const anchors = extractClaimAnchors(anchoredMarkdown);

  return {
    markdown: anchoredMarkdown,
    claimAnchors: Array.from(anchors.entries()).map(([id, text]) => ({ id, text })),
    // ... rest of result ...
  };
}
```

### 3. Store Anchors in Document Metadata

```typescript
// apps/server/src/services/ingest.ts — store anchors

// When saving compiled wiki page, store claim anchors in metadata:
await trail.db.update(documents).set({
  content: compiledResult.markdown,
  metadata: JSON.stringify({
    claimAnchors: compiledResult.claimAnchors,
    // ... existing metadata ...
  }),
}).where(eq(documents.id, docId)).run();
```

### 4. HTML Rendering with Anchors

```typescript
// apps/admin/src/lib/markdown-renderer.ts

import { marked } from 'marked';

// Configure marked to render {#claim-xxx} as HTML id attributes
const renderer = new marked.Renderer();

renderer.heading = (text, level, raw) => {
  // Extract anchor from heading: "# Title {#claim-xxx}"
  const anchorMatch = raw.match(/\{#(claim-[a-f0-9]{8})\}/);
  const id = anchorMatch ? ` id="${anchorMatch[1]}"` : '';
  const cleanText = text.replace(/\s*\{#claim-[a-f0-9]{8}\}\s*$/, '');
  return `<h${level}${id}>${cleanText}</h${level}>`;
};

renderer.paragraph = (text) => {
  // Extract anchor from paragraph start: "{#claim-xxx}\nText"
  const anchorMatch = text.match(/^\{#(claim-[a-f0-9]{8})\}\n/);
  const id = anchorMatch ? ` id="${anchorMatch[1]}"` : '';
  const cleanText = text.replace(/^\{#claim-[a-f0-9]{8}\}\n/, '');
  return `<p${id}>${cleanText}</p>`;
};

renderer.listitem = (text) => {
  const anchorMatch = text.match(/\{#(claim-[a-f0-9]{8})\}/);
  const id = anchorMatch ? ` id="${anchorMatch[1]}"` : '';
  const cleanText = text.replace(/\s*\{#claim-[a-f0-9]{8}\}\s*$/, '');
  return `<li${id}>${cleanText}</li>`;
};

marked.setOptions({ renderer });
```

## Impact Analysis

### Files created (new)
- `packages/core/src/compile/claim-anchors.ts` — anchor generation + injection + extraction
- `packages/core/src/compile/__tests__/claim-anchors.test.ts`

### Files modified
- `packages/core/src/compile/compiler.ts` — inject anchors after LLM compile
- `apps/server/src/services/ingest.ts` — store anchors in document metadata
- `apps/admin/src/lib/markdown-renderer.ts` — render anchors as HTML ids

### Downstream dependents for modified files

**`packages/core/src/compile/compiler.ts`** is NOT directly imported by any file — it's an internal module called by `apps/server/src/services/ingest.ts` (which imports `@trail/core` barrel). Adding anchor injection is additive.

**`apps/server/src/services/ingest.ts`** is imported by 9 files (see F21 analysis above). All callers use `triggerIngest()` — adding anchor storage in metadata is invisible to them.

**`apps/admin/src/panels/neuron-editor.tsx`** is imported by 1 file (1 ref):
- `apps/admin/src/app.tsx` (1 ref) — renders editor panel, unaffected by anchor rendering

### Blast radius
- Anchors add ~20 chars per claim to markdown — negligible storage impact
- Hash is based on first 50 chars normalized — small rephrasing won't change anchor
- Major content changes WILL change anchor — this is correct behavior (the claim is different)
- HTML rendering adds `id` attributes — no visual change, just enables URL fragment linking

### Breaking changes
None. Anchors are additive metadata.

### Test plan
- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Unit: `generateClaimAnchor` produces same hash for same content
- [ ] Unit: `generateClaimAnchor` produces different hash for different content
- [ ] Unit: `generateClaimAnchor` produces same hash for minor rephrasing (first 50 chars match)
- [ ] Unit: `injectClaimAnchors` adds anchors to headings, lists, paragraphs
- [ ] Unit: `extractClaimAnchors` correctly parses injected anchors
- [ ] Integration: Compile a source → markdown contains `{#claim-xxx}` anchors
- [ ] Integration: Render anchored markdown → HTML has `id="claim-xxx"` attributes
- [ ] Integration: Re-compile same source → anchors are stable (same IDs)
- [ ] Regression: Markdown rendering unchanged for content without anchors

## Implementation Steps

1. Create `packages/core/src/compile/claim-anchors.ts` with generation + injection + extraction
2. Write unit tests for anchor stability and injection
3. Integrate anchor injection into compiler pipeline
4. Store anchors in document metadata during ingest
5. Update markdown renderer to output HTML id attributes
6. Manual test: compile source → verify anchors in markdown → verify HTML ids
7. Test anchor stability across re-compilation

## Dependencies

- F06 (Ingest Pipeline) — anchors are injected during compile
- F78 (Trust Tiers + Provenance Graph) — anchors become join keys for claims table in Phase 3

## Effort Estimate

**Small** — 1 day

- Morning: Anchor generation + injection + unit tests
- Afternoon: Compiler integration + markdown renderer + manual testing
