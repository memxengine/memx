# F108 — Chart & Visualization Generation

> Chat-LLM'en kan generere grafer og visualiseringer fra data i Neurons — matplotlib-style bar/line/scatter charts, comparison-tables, timelines. Leveres som SVG (embeddes i markdown) eller PNG (standalone). Matcher Karpathy's gist-hint om "charts (matplotlib), canvas" som første-klasses output-format. Tier: Pro+. Effort: Medium (3-4 days). Status: Planned.

## Problem

Neurons indeholder ofte strukturerede data — dosage-tables, version-historik, benchmarks — der ville være tydeligere som grafer. Karpathy nævner matplotlib-charts direkte som output-format. Trail har ingen vej til at bede LLM'en render visualisering; output er ren tekst.

## Secondary Pain Points

- Data-heavy Neurons are hard to scan visually without charts.
- Presentations (F107) can't include visual data without manual chart creation.
- Exported vaults (F100) are text-only — no visual data representation.

## Solution

Three approaches, ranked by complexity:

**MVP — SVG via LLM direct**: LLM-tool `render_chart(type, data, title)` that produces raw SVG markup. Relies on modern LLMs being able to generate SVG from numbers. No subprocess, no matplotlib-install. Limitation: complex charts (stacked bar, violin) are unreliable.

**V2 — Python subprocess with matplotlib**: Server runs `python3 -c 'import matplotlib; ...'` with sandboxed input. Requires Python + matplotlib in runtime image. More code to develop but much more precise output.

**V3 — Chart.js-compatible JSON + client render**: LLM generates Chart.js config, admin-UI renders interactively. Best UX if the target audience is web viewing.

Start with MVP (SVG). Add V2 if users request more complexity.

## Non-Goals

- Interactive charts (MVP is static SVG).
- Chart editing UI after generation (chart is generated, not editable).
- Chart templates or presets (LLM generates from scratch each time).
- Server-side PDF rendering of charts (deferred to V2).
- Support for all chart types (MVP: bar, line, scatter, pie only).

## Technical Design

### Chat tool: `render_chart`

```ts
interface RenderChartTool {
  name: 'render_chart';
  parameters: {
    type: 'bar' | 'line' | 'scatter' | 'pie';
    data: {
      labels: string[];
      datasets: { label: string; values: number[]; color?: string }[];
    };
    title: string;
    width?: number;  // default 600
    height?: number; // default 400
  };
}
```

Returns SVG markup:

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400">
  <!-- chart content -->
</svg>
```

### Chat API response extension

```ts
interface ChatResponse {
  answer: string;
  citations: ChatCitation[];
  chartsGenerated?: ChartOutput[];
}

interface ChartOutput {
  svg: string;
  title: string;
  chartType: string;
}
```

### Admin UI rendering

SVG is rendered directly in the chat panel (sanitized to prevent XSS):

```tsx
<div dangerouslySetInnerHTML={{ __html: sanitizeSVG(chart.svg) }} />
```

### Save as Neuron

When saving as Neuron, chart data is preserved + markdown includes `![chart](./assets/chart-1.svg)` reference.

## Interface

### Chat API response

```ts
// POST /api/v1/knowledge-bases/:kbId/chat
// Response (extended):
{
  answer: string;
  citations: ChatCitation[];
  chartsGenerated?: { svg: string; title: string; chartType: string }[];
}
```

## Rollout

**Single-phase deploy.** SVG generation is pure LLM output — no server-side dependencies. Admin UI renders SVG directly.

## Success Criteria

- "Lav en bar-chart af antal sources per måned" produces valid SVG.
- Chart is saved as part of Neuron when "Save as Neuron" is used.
- Export-ZIP includes `wiki/assets/` with all generated charts.
- SVG renders correctly in admin chat panel and in Obsidian after export.

## Impact Analysis

### Files created (new)

- `apps/server/src/services/chart-generator.ts`
- `apps/admin/src/components/chart-viewer.tsx`

### Files modified

- `apps/server/src/services/chat.ts` (add `render_chart` tool to LLM)
- `apps/admin/src/components/chat-panel.tsx` (render chart SVG below answer)
- `apps/server/src/routes/export.ts` (F100 — include charts in `wiki/assets/`)
- `packages/shared/src/schemas.ts` (add chart-related schemas)

### Downstream dependents

`apps/server/src/services/chat.ts` — Chat service. Adding `render_chart` tool changes available tools but not the API surface. Downstream consumers are unaffected.

`apps/admin/src/components/chat-panel.tsx` — Chat panel. Adding chart rendering is additive; users without chart requests see no change.

`apps/server/src/routes/export.ts` — Export route (F100). Adding chart asset inclusion changes export output but not the endpoint API.

`packages/shared/src/schemas.ts` — Central schema file. Adding chart schemas is additive; no downstream changes.

### Blast radius

- SVG from LLM must be sanitized to prevent XSS (strip `<script>`, `onerror`, etc.).
- Large charts (complex SVG) may increase response size significantly.
- Chart data in Neuron frontmatter may be large — consider storing as separate asset file.

### Breaking changes

None — all changes are additive.

### Test plan

- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Unit: `render_chart` tool produces valid SVG markup
- [ ] Unit: SVG sanitizer strips dangerous elements (<script>, onerror, etc.)
- [ ] Integration: chat API returns `chartsGenerated` with valid SVG
- [ ] Manual: admin ChartViewer renders SVG correctly in chat panel
- [ ] Manual: save chart as Neuron, verify `![chart](./assets/chart-1.svg)` reference
- [ ] Regression: existing chat answers (without charts) still work
- [ ] Regression: export via F100 includes charts in `wiki/assets/`

## Implementation Steps

1. Create chart-generator service in `apps/server/src/services/chart-generator.ts` — LLM prompt + SVG generation.
2. Add `render_chart` tool to chat LLM in `apps/server/src/services/chat.ts`.
3. Create ChartViewer component in `apps/admin/src/components/chart-viewer.tsx` — sanitized SVG rendering.
4. Update chat panel to render chart SVG below answer when `chartsGenerated` is present.
5. Update export route (F100) to include charts in `wiki/assets/` directory.
6. Add chart-related schemas to `packages/shared/src/schemas.ts`.
7. Test: generate bar/line/scatter/pie charts from test data, verify SVG validity, verify rendering.

## Dependencies

- F100 (eksport af charts som assets)
- F107 (slides kan inkludere charts)

## Open Questions

1. **SVG size limits.** Should we cap SVG output at 50KB? Leaning: yes, to prevent runaway LLM output.
2. **Chart data storage.** Should chart data be stored in Neuron frontmatter or as a separate asset file? Leaning: separate asset file for large charts, frontmatter for simple ones.
3. **V2 timeline.** When should we implement matplotlib subprocess? Leaning: when users request complex chart types (stacked bar, violin, heatmap).

## Related Features

- **F100** (Obsidian Vault Export) — charts exported as `.svg` files in `wiki/assets/`
- **F107** (Marp Slide Output) — slides can include charts
- **F105** (Proactive Save Suggestion) — LLM can suggest saving charts as Neuron

## Effort Estimate

**Medium** — 3-4 days.

- Chart-generator service: 1.5 days
- Chat tool integration: 30 min
- ChartViewer component: 1 day
- Export route update: 30 min
- Testing: 1 day
