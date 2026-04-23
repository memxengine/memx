# F29 — `<trail-chat>` Embeddable Widget

> One-attribute embed — `<trail-chat tenant="…" kb="…">` — that any site on any framework can drop in. Single ESM bundle, no build step required by the host.

## Problem

The engine has a chat endpoint (F12) but nothing consumer-facing. Every customer integration today would be a custom React/Vue/Svelte component against our API. That's friction for adoption and fragmented on our side.

## Secondary Pain Points
- No standardized way for CMS customers to embed Trail chat
- Each integration reinvents streaming, citations, and error handling
- No versioning strategy for widget updates

## Solution

Build a Lit-based web component. Ships as one minified ESM bundle (target: <50kb gzipped). Any HTML page, any CMS template, any static site can embed it:

```html
<script type="module" src="https://widget.trail.broberg.ai/v1/trail-chat.js"></script>
<trail-chat
  tenant="sanne"
  kb="clinical"
  api="https://api.trail.broberg.ai"
  theme="light"></trail-chat>
```

The widget talks to the existing chat endpoint, renders citations as clickable `[[wiki-links]]` pointing at the public reading URL, and closes the loop with a reader-feedback button (F31).

## Non-Goals
- Custom theming beyond light/dark (that's F51)
- Chat history persistence in the widget (server-side only)
- File upload in chat (text-only in Phase 1)
- Multi-language i18n (English/Danish only, hardcoded)

## Technical Design

### Stack

- Lit 3.x — small runtime, true web-component, no shadow-DOM surprises.
- Tailwind v4 CSS compiled into the bundle (scoped by shadow DOM).
- Marked (same dependency as server) for rendering markdown answers.
- No auth dependency in Phase 1 — reads a public KB. Phase 2 adds optional `auth-token` attribute for authed KBs.

### Attributes

| Attr | Default | Purpose |
|------|---------|---------|
| `tenant` | — (required) | Tenant slug |
| `kb` | — (required) | KB slug |
| `api` | `https://api.trail.broberg.ai` | Override for self-hosted |
| `theme` | `light` | `light`, `dark`, or `auto` (prefers-color-scheme) |
| `height` | `600px` | CSS height |
| `placeholder` | `Ask anything…` | Input placeholder |
| `cite-format` | `inline` | `inline`, `footnote`, or `off` |

### API calls

```
POST {api}/api/v1/chat
body: { tenant, kb, message, history: [{ role, content }] }
streaming: Server-Sent Events
→ stream: { type: "token" | "citation" | "done", payload }
```

SSE for streaming tokens. Citations emit as separate events with `{ slug, title, excerpt }` so the widget can render them as hover cards without a second fetch.

### Reader feedback (F31)

Below each answer, a small 👎 button. Click opens an inline textarea + submit. Fires:

```
POST {api}/api/v1/queue/candidates
body: { kb_id, kind: "reader_feedback", payload_json: { message, answer, citations, note } }
```

Which enters the curator queue. This is the full feedback loop closing.

### Build + publish

- `apps/widget/` package — Lit + Vite.
- `bun run build` → `dist/trail-chat.js` (ESM) + `dist/trail-chat.min.js` (minified).
- Publish to `widget.trail.broberg.ai/v1/trail-chat.js` via Cloudflare Pages or Fly.io static.
- Versioned URLs (`/v1/`, `/v2/`) so breaking changes don't break embedded sites.

## Interface

### Widget Attributes
```html
<trail-chat tenant="sanne" kb="clinical" api="https://api.trail.broberg.ai" theme="light" height="600px" placeholder="Ask anything…" cite-format="inline"></trail-chat>
```

### SSE Stream Format
```typescript
interface SSEEvent {
  type: 'token' | 'citation' | 'done';
  payload: string | { slug: string; title: string; excerpt: string };
}
```

### Custom Events
- `trail-chat:ready` — widget initialized
- `trail-chat:answer` — answer complete with citations
- `trail-chat:error` — error occurred

## Rollout

**Phase 1:** Widget bundle + basic chat + citations. Deploy to `widget.trail.broberg.ai/v1/`.
**Phase 2:** Auth support + F31 feedback button + F51 customization.
**Phase 3:** CMS adapter integration (F45) with auto-embed.

## Success Criteria
- Widget bundle builds to <50kb gzipped
- Embedded in a minimal HTML file, renders input box within 1 second
- Question produces streamed answer with at least one citation within 5 seconds
- Citation click navigates to wiki page
- Feedback button submits candidate, shown in curator queue
- Theme `dark` applies correct palette via `prefers-color-scheme`
- Widget works in Chrome, Firefox, Safari (no framework required)

## Impact Analysis

### Files created (new)
- `apps/widget/package.json`
- `apps/widget/vite.config.ts`
- `apps/widget/src/trail-chat.ts`
- `apps/widget/src/styles/**`

### Files modified
- `pnpm-workspace.yaml` (add widget to workspace)
- `apps/server/src/routes/chat.ts` (add SSE streaming support)

### Downstream dependents
`apps/server/src/routes/chat.ts` is imported by 2 files (see F30 analysis). Adding SSE support is additive — existing non-streaming callers use `Accept: application/json` header.

New widget app has no internal dependents.

### Blast radius
Server SSE change has to work for both streaming clients and non-streaming (the widget streams; existing chat tests may use non-streaming). Support both Accept headers.

### Breaking changes
New app — no breakage. SSE on `/api/v1/chat` is an addition, not a replacement.

### Test plan
- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Widget bundle builds to <50kb gzipped
- [ ] Embedded in a minimal HTML file, `<trail-chat tenant="demo" kb="test">` renders input box
- [ ] Question produces streamed answer with at least one citation
- [ ] Citation click opens wiki page
- [ ] Feedback button submits candidate, shown in curator queue
- [ ] Theme `dark` applies correct palette
- [ ] Widget renders correctly in Chrome, Firefox, Safari
- [ ] Regression: non-streaming `POST /api/v1/chat` still works for existing callers

## Implementation Steps
1. Scaffold `apps/widget` with Lit + Vite.
2. Build basic input + answer area + streaming SSE client.
3. Add citation rendering (F30 contributes the server-side link format).
4. Add feedback button wired to F17 + F31.
5. Theme system via CSS custom properties.
6. Cloudflare Pages or Fly.io static deploy pipeline with `/v1/` versioning.

## Dependencies
- F12 Chat endpoint (hard)
- F17 Queue API (for F31 feedback)
- F30 Chat citations render (server formats `[[wiki-link]]` → anchor)

Unlocks: F31 Reader feedback, F51 Widget customization (Phase 2), F52 FysioDK onboarding (Phase 2).

## Open Questions
None — all decisions made.

## Related Features
- **F12** (Chat Endpoint) — backend API
- **F30** (Chat Citations Render) — server-side link formatting
- **F31** (Reader Feedback) — feedback button integration
- **F51** (Widget Customization) — CSS variable theming
- **F45** (@webhouse/cms Adapter) — auto-embed in CMS

## Effort Estimate
**Medium** — 5-7 days including SSE plumbing and publish pipeline.
