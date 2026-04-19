# F99 — Obsidian-style Neuron Graph

> Curators need spatial intuition about the trail. List views and queue cards show individual findings; they don't show how a Neuron sits in the web of other Neurons. Ship a pan/zoom/drag graph view that renders the entire trail at any scale, with positions computed at compile time so the render cost at runtime is ~0.

## Problem

Sanne (and every future customer) is building a graph by curating Neurons, but the admin only exposes the graph one node at a time. "What's connected to what?" is invisible unless you read every Neuron's frontmatter. The single most-linked-to visualization in the PKM space — Obsidian's graph view — exists for exactly this reason: it makes the *shape* of your knowledge legible at a glance.

Trail already has the data: `document_references` from F15, wiki-link backlinks from F15 iter 2, orphan status from F98. We just haven't drawn it.

Secondary problem: **we don't want to pay for this at runtime.** Running a force-directed simulation in the browser at 100K nodes freezes the tab. Compile-time layout fits trail's architecture (the wiki_events stream already represents "changes happened at compile time") and keeps per-open render cost ~0.

## Scope

**In scope (v1):**
- New route `/kb/:kbId/graph` — full-trail graph view.
- Sigma.js + graphology rendering, WebGL backend.
- Compile-time ForceAtlas2 layout: positions computed when the compile pipeline emits wiki_events, stored per-document.
- Client-side incremental FA2 (graphology's worker supervisor) only for the subset of nodes not yet positioned — converges in-place without re-laying-out the world.
- Pan / zoom / drag / click.
- Click Neuron → deep-link to `/kb/:kbId/neurons/:slug` (reader); back button restores the graph's camera state.
- Hover → tooltip with title, tag list, backlink count.
- Search box: type-to-focus; matches stay full-opacity, rest dim to ~20%.
- Node size = `sqrt(backlinkCount)`, clamped 4..20.
- Node color:
  - Orphans (F98) → amber warning color.
  - Default → theme-accent purple (trailMEM brand).
- Edges rendered undirected (direction stays in DB — undirected looks cleaner at scale).
- Empty state: if fewer than 2 Neurons, show "Add more Neurons to see your graph take shape" with link to queue.
- Dark-mode only (admin is dark-mode only).

**Out of scope (v1 — follow-ups):**
- Color by tag (F92 integration) → F99.1.
- Neighborhood / 1-hop subgraph widget on the reader page → F99.2.
- Time-slider playing back `wiki_events` → F99.3.
- Community detection / cluster coloring (graphology-communities-louvain) → F99.4.
- Per-tag or per-subtree filtered views → F99.5.
- Export as PNG / SVG → F99.6.
- 3D view — probably never; 2D is sufficient.
- Edit-from-graph right-click menus — click → reader → edit is two clicks, good enough.

## Why Sigma.js + graphology

Three serious candidates were evaluated:

1. **Sigma.js + graphology** — WebGL, handles 100K+ nodes, TS-first, MIT, graphology is a clean separable data model with a large plugin ecosystem (centrality, communities, layout). **Chosen.**
2. **react-force-graph-2d** — Canvas, pretty defaults, ~5–10K node ceiling before it stutters. Rules itself out at the 100K scaling target.
3. **Cytoscape.js** — More features than we need, not WebGL by default, "enterprise" aesthetic. Wrong vibe for trailMEM.

Explicitly rejected:
- D3 from scratch — we're not writing a graph toolkit.
- Cosmograph — GPU force-simulation is overkill when we pre-compute at compile time.
- matplotlib / Python — the graph lives in the admin, not a notebook. (Karpathy-style static plots are a different problem.)

Graphology is worth calling out separately: it's a pure-TS graph data model with serialization, layout plugins, centrality algorithms, and community detection — all of which we'll want in F99.x follow-ups. Sigma renders a graphology instance directly, no adapter layer.

## Design

### Data

Source of truth already exists:
- `documents` — one row per Neuron.
- `document_references` — outgoing links from frontmatter `sources:` (F15).
- Wiki-link backlinks table (F15 iter 2) — add to the graph as edges.
- F98's orphan detection — used for node color.

Edges are de-duplicated at query time: a Neuron linking to another via both an explicit `sources:` ref and a `[[wiki-link]]` is one edge, not two.

### Layout: compile-time is canonical, client does incremental only

**Compile-time path** (sits beside the normal compile step):

- New table `graph_layouts(tenant_id, document_id, view_id, x REAL, y REAL, computed_at)`. `view_id` is a string so future F99.x views (per-tag subgraphs, neighborhood views) each get their own position set. v1 uses `view_id = 'global'`.
- After a compile batch commits its `wiki_events`, a post-commit hook walks the changed-nodes set and runs FA2 on the subgraph consisting of changed-nodes ∪ their 1-hop neighbors, with neighbors pinned:
  - Existing neighbors are marked `fixed: true` (FA2 respects it) — their positions don't drift.
  - Iteration count: N=50 for incremental batches, N=500 only on cold start (first-ever compile in a trail).
  - This is what makes the graph feel *stable* across compiles. Obsidian does exactly this.
- Runs on the compile worker (not the request thread). Pure JS, no native dep — `graphology-layout-forceatlas2` runs fine inside Bun.
- Log `layoutMs` alongside `compileMs`. If `layoutMs > 500ms` on Sanne's trail, lower N or batch smaller.

**Client-side incremental path:**

- When the graph view loads, the server serves stored positions plus any Neurons with `x IS NULL` (edge case: a compile is in flight, or the layout job is queued).
- Un-positioned nodes get seeded at the centroid of their positioned neighbors, then run through a short FA2 pass in a Web Worker (via graphology's worker supervisor). UI stays 60fps because the main thread never touches the simulation.
- Result: graph is instantly interactive; new nodes animate into place over ~1s without freezing anything.

### Worker wiring

graphology-layout-forceatlas2 ships a supervisor (`/worker` entry) that bridges to a Web Worker internally — we don't author the worker file ourselves.

```ts
// apps/admin/src/graph/useIncrementalLayout.ts
import { useEffect } from 'preact/hooks'
import FA2Layout from 'graphology-layout-forceatlas2/worker'
import type Graph from 'graphology'

export function useIncrementalLayout(graph: Graph, unpositionedIds: string[]) {
  useEffect(() => {
    if (!unpositionedIds.length) return

    // Pin already-positioned nodes so they don't drift during the incremental pass.
    graph.forEachNode((id) => {
      if (!unpositionedIds.includes(id)) {
        graph.setNodeAttribute(id, 'fixed', true)
      }
    })

    const layout = new FA2Layout(graph, {
      settings: { gravity: 1, scalingRatio: 10, slowDown: 2 },
    })
    layout.start()
    const stopTimer = setTimeout(() => layout.stop(), 1500)

    return () => {
      clearTimeout(stopTimer)
      layout.kill()
      graph.updateEachNodeAttributes((_, attrs) => {
        delete attrs.fixed
        return attrs
      })
    }
  }, [unpositionedIds.join(',')])
}
```

### Route & UI

`/kb/:kbId/graph` — sibling to the existing `/kb/:kbId/neurons/:slug` reader.

Layout:
- Full-viewport `<canvas>` rendered by Sigma, minus the admin sidebar width.
- Top-right floating panel: search box, node count, legend (orphan swatch + default swatch).
- Bottom-right: zoom-to-fit and reset-view buttons.
- Click node → `preact-iso` `pushState` to the reader route; keep the camera state in the history entry so back returns to the same zoom/pan.
- Hover → Sigma's `enterNode` / `leaveNode` events show a positioned tooltip div (Tailwind, matches admin theme).

Search uses Sigma's `nodeReducer` setting to control opacity without mutating node attributes on every keystroke — important for smooth typing at 100K nodes.

### Fetch path

New endpoint: `GET /api/v1/kb/:kbId/graph?view=global`

```ts
// response shape
{
  nodes: Array<{
    id: string            // document_id
    label: string         // documents.title ?? filename
    x: number | null      // null = needs layout client-side
    y: number | null
    size: number          // sqrt(backlinkCount), clamped 4..20
    orphan: boolean       // from F98
    tags: string[]        // from F92 (used for tooltip now; color in F99.1)
  }>
  edges: Array<{ source: string; target: string }>
  meta: {
    layoutComputedAt: string | null
  }
}
```

Payload size at 100K nodes with ~3 edges/node: ~10–15 MB JSON, ~2–3 MB gzipped. Acceptable for a view the user explicitly opens. Binary MessagePack is a follow-up if profiling demands it.

## Impact Analysis

### Files affected

- New: `apps/admin/src/panels/graph.tsx` — Sigma-hosting component.
- New: `apps/admin/src/graph/useIncrementalLayout.ts` — worker hook.
- New: `apps/admin/src/graph/buildGraphology.ts` — API payload → `Graph` instance.
- New: `apps/server/src/routes/graph.ts` — `GET /api/v1/kb/:kbId/graph`.
- New: `packages/core/src/graph/compile-layout.ts` — server-side FA2 runner, invoked by the compile post-commit hook.
- New migration: `graph_layouts` table.
- Modify: `packages/core/src/compile/*` — post-commit hook calls `compile-layout.ts` with the touched-nodes set.
- Modify: `apps/admin/src/router.tsx` (or wherever routes are registered) — add `/kb/:kbId/graph`.
- Modify: `apps/admin/src/panels/wiki-reader.tsx` — add a "View in graph" link in the reader header that deep-links to `/kb/:kbId/graph?focus=:slug`.
- Modify: `apps/admin/src/api.ts` — `fetchGraph(kbId)` helper.
- Modify: `apps/admin/package.json` — add `sigma`, `graphology`, `graphology-layout-forceatlas2`.
- i18n: keys for search placeholder, empty state, legend, tooltip labels — both `en.json` and `da.json`.

### Downstream dependents

None. Additive feature.

### Blast radius

Low-to-medium. The new compile post-commit hook runs on every compile batch; a pathological subgraph could extend compile latency. Mitigations:
- Hard-cap iteration count (N=50 incremental, N=500 cold start).
- Log `layoutMs` alongside `compileMs`.
- Post-commit hook can be made async-fire-and-forget if it becomes a hot path — the graph view tolerates `layoutComputedAt < latest compile` by falling back to client-side FA2 for un-positioned nodes.

### Breaking changes

None.

### Test plan

- TypeScript compiles: `pnpm -w tsc --noEmit`.
- Open `/kb/:kbId/graph` on Sanne's current trail → all Neurons + edges visible, FPS >40 on pan/zoom.
- Click a Neuron → lands in reader; browser back → graph restored with same camera state.
- Add a new Neuron via the queue → refresh graph → new node appears at a sensible position, existing nodes unmoved (check by screenshot diff of the viewport).
- Kill network mid-load → loading state renders, no broken canvas.
- Delete a document row in DB → next compile's layout step skips it cleanly, server response omits it, graph renders fine.
- Orphan (F98 finding) → renders in amber, not purple.
- Search "whale" → matching Neurons stay full-opacity, rest dim to ~20%.
- Synthetic 5-digit trail (seeded): cold-start layout completes server-side in <10s; client render on first open is instant.
- Regression: existing compile latency on Sanne's trail doesn't regress >100ms (measure before/after).

## Implementation Steps

1. Add `graph_layouts` migration.
2. Add `compile-layout.ts`: given a tenant + a changed-nodes set, loads subgraph (changed ∪ 1-hop), pins existing positions, runs FA2, writes results. Cold-start branch runs full-graph FA2 at N=500.
3. Wire the post-commit hook in the compile pipeline. Measure `layoutMs`; tune iteration count if >500ms.
4. Add `GET /api/v1/kb/:kbId/graph` route assembling nodes + edges + stored positions. Ensure Hono gzip middleware covers the route.
5. Add `sigma`, `graphology`, `graphology-layout-forceatlas2` to `apps/admin`.
6. Build `buildGraphology.ts` — walks the API payload, populates a `Graph` instance, attaches x/y when present.
7. Build `useIncrementalLayout` — the supervisor-based worker hook above.
8. Build `graph.tsx` — Sigma setup, hover tooltip, click handler (pushState + camera-in-history), search box wired via `nodeReducer`, legend.
9. Register the route in the admin router; add nav link in the admin sidebar.
10. Add "View in graph" link on the reader with `?focus=:slug` handling (camera centers + brief pulse on the focused node; no auto-zoom — disorients).
11. i18n pass: `en.json` + `da.json`.
12. Manual walkthrough of the test plan above. No unit tests in v1 (visual feature; covered by manual plan + smoke run through `scripts/trail restart`).

## Dependencies

- F15 references + iter 2 backlinks (done — provide the edges).
- F87 event stream (done — graph is stateless against it; relies only on the compiled state the stream produced).
- F92 tags on Neurons (done — used for tooltip; color-by-tag deferred to F99.1).
- F98 orphan awareness (done — provides the orphan flag for node color).
- No new external services. No MCP changes.

## Effort Estimate

**Medium — 2–3 days focused.** Roughly half a day each for: compile-time layout + migration, graph API endpoint, Sigma component (hover/click/search/legend), worker + incremental layout. Plus a half-day of polish (iteration count tuning, visual tokens, i18n, test plan walkthrough).

## Unlocks

- The trail is legible at a glance — screenshot-ready for the landing page at trailmem.com.
- Orphans are visually obvious (not just a queue finding).
- Foundation for F99.x follow-ups (tag coloring, per-neuron neighborhood widgets, time-slider, cluster detection).
- Demo calls with future customers become dramatically more compelling with a live graph to show.

## Handoff notes for the cc session picking this up

- Start server-side: migration → `compile-layout.ts` → API endpoint. Get `/api/v1/kb/:kbId/graph` returning sensible JSON for Sanne's trail *before* touching `apps/admin`.
- `graphology-layout-forceatlas2` has both a synchronous `assign()` and a worker supervisor (`/worker` entry). Use `assign()` on the server (single-threaded is fine inside the compile worker); use the supervisor on the client.
- Do **not** try to SSR or server-render Sigma. It is client-only; the server just ships data.
- Pin existing node positions during incremental FA2 by setting the `fixed: true` attribute on them — FA2 respects it. Don't forget to clean up the attribute when the pass ends, or the next incremental run will refuse to move them.
- Use Sigma's `setSetting('nodeReducer', ...)` for the search-dim behaviour — do *not* mutate node attributes on every keystroke at 100K scale.
- When the reader deep-links with `?focus=:slug`, center the camera on that node and briefly pulse it. Do **not** auto-zoom — it disorients.
- Match admin's dark theme tokens: nodes `#a78bfa` (purple-400), orphans `#f59e0b` (amber-500), edges `#3f3f4688` (zinc-700 with alpha). Adjust to whatever tokens the admin actually defines; don't hardcode if a token exists.
- Admin is Preact; don't reach for React hooks libraries that lack preact-compat.
- Follow the i18n pattern in `apps/admin/src/lib/i18n.ts` — every new string gets keys in both `en.json` and `da.json`.
- Test with `scripts/trail restart` + open the admin at `http://127.0.0.1:58031`.
- Announce the start via buddy (`mcp__buddy__announce`) so the main trail session doesn't touch the same files.
