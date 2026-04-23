# F107 — Marp Slide Output

> Brugeren beder chat-LLM'en om "make me slides about X" og får en Marp-formateret markdown-fil der renderes som slide-deck. Alt indhold genereres fra Neurons — slides er endnu et output-format oveni markdown. Tier: Pro+. Effort: Medium (2-3 days). Status: Planned.

## Problem

Trail's chat-API returnerer kun markdown-body. Karpathy's gist nævner eksplicit slide-decks (Marp) som output-format der feeder tilbage til wiki som kompaktet præsentation. Brugere der arbejder med Trail som research-platform har ingen vej til præsentationsklar output — de skal manuelt klippe/klistre til PowerPoint eller Keynote.

## Secondary Pain Points

- No way to share KB insights as presentations with non-Trail users.
- Meeting prep requires manual copy-paste from Neurons to slide tools.
- Exported Obsidian vaults (F100) don't include presentation-ready content.

## Solution

New endpoint `POST /api/v1/knowledge-bases/:kbId/render/slides`:

```json
{
  "prompt": "Lav 8-10 slides om akupunktur-contraindications",
  "sources": ["concept:contraindications", "concept:needling-safety"],
  "style": "marp-default"
}
```

Returns Marp-markdown:

```markdown
---
marp: true
theme: default
---

# Akupunktur Contraindications
*Fra Trail KB, 2026-04-20*

---

## 1. Bleeding disorders
- Vermeiden hos patienter med hæmofili
- Kilde: [[concept:contraindications]]

---
```

User can save back as Neuron (type='slides'), export as .md, or — in future — render to PDF via serverside Marp-CLI.

## Non-Goals

- Server-side PDF rendering (deferred to next iteration).
- PowerPoint/Keynote export format (Marp markdown only for MVP).
- Slide template customization beyond built-in Marp themes.
- Real-time collaborative slide editing.
- Animation/transitions in slides (Marp supports these, but not in MVP scope).

## Technical Design

### Chat tool: `generate_slides`

New tool available to the chat LLM:

```ts
interface GenerateSlidesTool {
  name: 'generate_slides';
  parameters: {
    prompt: string;        // user's slide request
    kbScope: string[];     // Neuron references to include
    style: string;         // Marp theme name
  };
}
```

The tool calls the slide-render endpoint and returns Marp-markdown.

### Slide-render endpoint

```ts
// apps/server/src/routes/render.ts
POST /api/v1/knowledge-bases/:kbId/render/slides

1. Parse request (prompt, sources, style)
2. Fetch referenced Neurons from KB
3. Call LLM with slide-generation prompt + Neuron content
4. Return Marp-markdown response
```

### Client-side rendering

Admin-UI renders slides as a deck using a Marp web component (e.g., `@marp-team/marp-web`):

```tsx
<MarpViewer markdown={marpMarkdown} theme="default" />
```

### Save as Neuron

User can save slides back as a Neuron with `type: slides` (new type in F101):

```yaml
---
title: Akupunktur Contraindications
type: slides
---
```

## Interface

### Slide-render endpoint

```
POST /api/v1/knowledge-bases/:kbId/render/slides
Body: { prompt: string; sources: string[]; style: string }
  → 200 { markdown: string }
```

### Chat API response (extended)

```ts
interface ChatResponse {
  answer: string;
  citations: ChatCitation[];
  slidesGenerated?: { markdown: string; slideCount: number } | null;
}
```

## Rollout

**Single-phase deploy.** New endpoint, new chat tool. Marp rendering is client-side — no server-side dependencies beyond the LLM call.

## Success Criteria

- "Generate slides om X" i chat returns valid Marp-markdown.
- Admin-UI can preview slides as a deck in browser.
- Export via F100 includes slides as `.md` with `marp: true` frontmatter → opens as slide-deck in Obsidian.
- Slide generation completes in <15 seconds for 10-slide deck.

## Impact Analysis

### Files created (new)

- `apps/server/src/routes/render.ts`
- `apps/server/src/services/slide-generator.ts`
- `apps/admin/src/components/marp-viewer.tsx`

### Files modified

- `apps/server/src/services/chat.ts` (add `generate_slides` tool to LLM)
- `apps/admin/src/components/chat-panel.tsx` (render slides preview + save button)
- `packages/shared/src/schemas.ts` (add slide-related schemas)

### Downstream dependents

`apps/server/src/services/chat.ts` — Chat service. Adding `generate_slides` tool changes available tools but not the API surface. Downstream consumers are unaffected.

`apps/admin/src/components/chat-panel.tsx` — Chat panel. Adding slides preview is additive; users without slide requests see no change.

`packages/shared/src/schemas.ts` — Central schema file. Adding slide schemas is additive; no downstream changes.

### Blast radius

- New LLM tool increases token usage when slides are requested.
- Marp-markdown is a new Neuron type (`slides`) — must be added to F101's `deriveType()`.
- Client-side Marp rendering adds a new dependency (`@marp-team/marp-web`) to admin bundle.

### Breaking changes

None — all changes are additive.

### Test plan

- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Unit: slide-generator produces valid Marp-markdown with `marp: true` frontmatter
- [ ] Unit: `generate_slides` tool returns correct parameters to LLM
- [ ] Integration: slide-render endpoint returns 200 with valid Marp-markdown
- [ ] Manual: admin MarpViewer renders slides as deck in browser
- [ ] Manual: save slides as Neuron, verify `type: slides` in frontmatter
- [ ] Regression: existing chat answers (without slides) still work
- [ ] Regression: export via F100 includes slides as `.md` with correct frontmatter

## Implementation Steps

1. Create slide-generator service in `apps/server/src/services/slide-generator.ts` — LLM prompt + Marp-markdown generation.
2. Create slide-render endpoint in `apps/server/src/routes/render.ts`.
3. Add `generate_slides` tool to chat LLM in `apps/server/src/services/chat.ts`.
4. Create MarpViewer component in `apps/admin/src/components/marp-viewer.tsx` using `@marp-team/marp-web`.
5. Update chat panel to render slides preview + save button.
6. Add `slides` to F101's `deriveType()` path mapping (`/neurons/slides/` → `type: slides`).
7. Test: generate slides from test KB, verify Marp rendering, verify save as Neuron.

## Dependencies

- F100 (Obsidian-export — Marp-filer virker direkte i Obsidian med Marp-plugin)
- F105 (proactive save-suggest — LLM kan foreslå "Skal jeg gemme slides som Neuron?")

## Open Questions

1. **Slide count limits.** Should we cap slides at 15-20 per request? Leaning: yes, to prevent runaway LLM output.
2. **Theme customization.** Should users be able to choose from multiple Marp themes? Leaning: yes, but only built-in themes for MVP.
3. **PDF export.** Server-side Marp-CLI for PDF export — should this be part of F107 or a separate feature? Leaning: separate feature (requires Python/Node subprocess management).

## Related Features

- **F100** (Obsidian Vault Export) — Marp files work directly in Obsidian with Marp plugin
- **F101** (type-frontmatter) — slides get `type: slides`
- **F105** (Proactive Save Suggestion) — LLM can suggest saving slides as Neuron
- **F108** (Chart Generation) — slides can include charts

## Effort Estimate

**Medium** — 2-3 days.

- Slide-generator service: 1 day
- Render endpoint: 30 min
- MarpViewer component: 1 day
- Chat tool integration: 30 min
- Testing: 2 hours
