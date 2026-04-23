# F30 — Chat Citations Render (`[[wiki-links]]` → `<a>`)

> Konverterer `[[wiki-link]]` citations i chat-svar til klikbare `<a>` tags der peger på in-app wiki view. Server-side transform så det virker identisk i widget, admin, og API consumers.

## Problem

Når chat-endpointet (F12) returnerer et svar med citations, er de i formatet `[[wiki-link]]` — ren tekst. Admin UI og widget viser dem som tekst, ikke som klikbare links. Brugeren kan ikke navigere til den citerede Neuron uden manuelt at kopiere linket.

Dette bryder med Trail's kernearkitektur: wiki-links skal være navigerbare. Chat-svar er en af de vigtigste consumer-flader — hvis citations ikke er klikbare, mister chat-svaret meget af sin værdi som opslag.

## Solution

En server-side transform funktion `renderChatCitations(text, kbId, tenantId)` der:
1. Finder alle `[[...]]` mønstre i chat-svaret
2. Resolverer dem til dokument-IDs via F23's link resolver
3. Erstatter med HTML `<a href="/neurons/:id">label</a>` tags

Transformen kører på serveren før response sendes — så både admin, widget, og API consumers får renderede links uden at skulle implementere parsing selv.

## Technical Design

### 1. Citation Render Function

```typescript
// packages/core/src/chat/citations.ts

import { parseWikiLinks, resolveWikiLinks } from '../links/index.js';

export interface ChatCitation {
  /** Original [[link]] text */
  raw: string;
  /** Resolved document ID */
  documentId: string | null;
  /** Display label */
  label: string;
  /** URL for the target */
  url: string | null;
  /** Whether target exists */
  exists: boolean;
}

/**
 * Transform chat response text: replace [[wiki-links]] with HTML <a> tags.
 * Runs server-side so all consumers get rendered links.
 */
export async function renderChatCitations(
  text: string,
  kbId: string,
  tenantId: string,
  trail: TrailDatabase,
): Promise<{ html: string; citations: ChatCitation[] }> {
  const links = parseWikiLinks(text);
  const resolved = await resolveWikiLinks(trail, links, kbId, tenantId);

  const citations: ChatCitation[] = resolved.map((r) => ({
    raw: r.link.raw,
    documentId: r.documentId,
    label: r.link.label ?? r.documentTitle ?? r.link.pagePath,
    url: r.url,
    exists: r.exists,
  }));

  // Replace links in text (longest first to avoid partial matches)
  let html = text;
  const sorted = [...resolved].sort((a, b) => b.link.raw.length - a.link.raw.length);

  for (const r of sorted) {
    const displayText = r.link.label ?? r.documentTitle ?? r.link.pagePath;

    if (r.exists && r.url) {
      html = html.replace(
        r.link.raw,
        `<a href="${r.url}" class="chat-citation">${displayText}</a>`,
      );
    } else {
      // Broken link — show as plain text with marker
      html = html.replace(
        r.link.raw,
        `<span class="chat-citation-broken" title="Not found">${displayText}</span>`,
      );
    }
  }

  return { html, citations };
}
```

### 2. Integration with Chat Endpoint

```typescript
// apps/server/src/routes/chat.ts

import { renderChatCitations } from '@trail/core';

// In the chat response handler:
const rawAnswer = llmResponse.content;

// Render citations
const { html, citations } = await renderChatCitations(rawAnswer, kbId, tenant.id, trail);

return c.json({
  answer: html,
  citations,
  sources: citationSources, // existing source list
  sessionId,
});
```

### 3. Chat Response Schema Update

```typescript
// packages/shared/src/chat.ts

export interface ChatResponse {
  /** Rendered answer with HTML citations */
  answer: string;
  /** Structured citation list */
  citations: ChatCitation[];
  /** Source documents referenced */
  sources: ChatSource[];
  /** Session ID for follow-up */
  sessionId: string;
}
```

### 4. Admin Chat Panel Rendering

```typescript
// apps/admin/src/components/chat-message.tsx

import { h } from 'preact';

interface ChatMessageProps {
  answer: string; // Already rendered HTML from server
  citations: ChatCitation[];
}

export function ChatMessage({ answer, citations }: ChatMessageProps) {
  return h('div', { class: 'chat-message' }, [
    h('div', {
      class: 'chat-answer',
      dangerouslySetInnerHTML: { __html: answer },
    }),
    citations.length > 0 && h('div', { class: 'chat-citations-list' }, [
      h('div', { class: 'citations-label' }, 'Kilder:'),
      ...citations.map((c) =>
        h('a', {
          class: `citation-chip ${c.exists ? '' : 'broken'}`,
          href: c.url ?? '#',
        }, c.label),
      ),
    ]),
  ]);
}
```

### 5. CSS for Chat Citations

```css
/* apps/admin/src/styles/chat.css */

.chat-citation {
  color: #e8a87c;
  text-decoration: none;
  border-bottom: 1px solid #e8a87c;
  font-weight: 500;
}

.chat-citation:hover {
  color: #d4956a;
}

.chat-citation-broken {
  color: #dc2626;
  text-decoration: underline wavy #dc2626;
  cursor: help;
}

.chat-citations-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 12px;
  padding-top: 8px;
  border-top: 1px solid var(--border);
}

.citations-label {
  font-size: 11px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  width: 100%;
}

.citation-chip {
  display: inline-block;
  padding: 2px 8px;
  font-size: 11px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text);
  text-decoration: none;
}

.citation-chip:hover {
  background: var(--border);
}

.citation-chip.broken {
  color: #dc2626;
  border-color: #fca5a5;
}
```

### 6. Widget Compatibility

```typescript
// apps/widget/src/trail-chat.ts — same rendering

// The widget receives the same { answer, citations } response from the API.
// Since citations are already rendered as HTML, the widget just needs:
// - dangerouslySetInnerHTML for the answer
// - Citation chips for the list

// No additional parsing needed in the widget — server does all the work.
```

## Impact Analysis

### Files created (new)
- `packages/core/src/chat/citations.ts` — citation rendering function
- `packages/core/src/chat/__tests__/citations.test.ts`
- `apps/admin/src/styles/chat.css` — chat citation styling (or extend existing)

### Files modified
- `apps/server/src/routes/chat.ts` — render citations before response
- `packages/shared/src/chat.ts` — update response schema
- `apps/admin/src/components/chat-message.tsx` — render HTML answer + citation chips
- `apps/widget/src/trail-chat.ts` — use rendered HTML (no parsing needed)

### Downstream dependents for modified files

**`apps/server/src/routes/chat.ts`** is imported by 2 files (2 refs):
- `apps/server/src/app.ts` (1 ref) — mounts route, unaffected
- `apps/server/src/routes/queue.ts` (1 ref) — references chat types, unaffected
Adding citation rendering changes the `answer` field from plain text to HTML — consumers need to use `dangerouslySetInnerHTML` instead of plain text display.

**`apps/admin/src/panels/chat.tsx`** is imported by 1 file (1 ref):
- `apps/admin/src/app.tsx` (1 ref) — renders chat panel, needs to handle HTML answer

### Blast radius
- Chat responses now contain HTML — consumers MUST use `dangerouslySetInnerHTML` or equivalent
- XSS risk: LLM-generated HTML should be sanitized. Consider using `dompurify` or similar
- Existing chat history (stored as plain text) won't have rendered citations — only new responses will
- Widget needs to be updated to handle HTML answers

### Breaking changes
**Minor**: The `answer` field changes from plain text to HTML. Consumers that display it as plain text will see raw HTML tags. This is a breaking change for any external API consumers.

Mitigation: Add `answerHtml` field alongside `answer` (plain text) for backward compatibility.

### Test plan
- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Unit: `renderChatCitations` replaces `[[page]]` with `<a>` tag
- [ ] Unit: `renderChatCitations` handles multiple citations in one response
- [ ] Unit: `renderChatCitations` handles broken links gracefully
- [ ] Unit: `renderChatCitations` preserves non-link text unchanged
- [ ] Integration: Chat endpoint returns HTML answer with citations
- [ ] Integration: Admin chat panel renders citations as clickable links
- [ ] Integration: Citation chips appear below answer with correct labels
- [ ] Integration: Widget renders HTML answer correctly
- [ ] Security: LLM-generated HTML is sanitized (no script injection)
- [ ] Regression: Chat without citations returns plain text answer

## Implementation Steps

1. Create `packages/core/src/chat/citations.ts` with render function + unit tests
2. Update `ChatResponse` schema to include `citations` array
3. Integrate citation rendering into chat endpoint
4. Update admin chat message component to render HTML + citation chips
5. Add chat CSS for citation styling
6. Update widget to handle HTML answers
7. Add HTML sanitization (dompurify or similar)
8. Integration test: chat with citations → rendered links → clickable navigation

## Dependencies

- F23 (Wiki-Link Parser) — reuses parseWikiLinks and resolveWikiLinks
- F12 (Chat Endpoint) — citations are rendered in chat responses

## Effort Estimate

**Small** — 1 day

- Morning: Citation render function + unit tests + chat endpoint integration
- Afternoon: Admin UI + widget update + CSS + sanitization + testing
