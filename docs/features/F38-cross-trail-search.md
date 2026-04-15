# F38 — Cross-Trail Search + Chat (Frontpage)

> `app.trailmem.com`'s frontpage lets a logged-in user search and chat across **all their Trails at once**. The moment they drill into a specific Trail, search and chat become scoped to just that Trail's content.

## Problem

The Trail metaphor is one brain per focus area — a user might have separate Trails for "clinical practice", "personal notes", "research archive", each with its own sources and compiled wiki. That isolation is exactly right inside a Trail. But on the frontpage, users want to ask "did I ever write about X?" without caring which Trail the answer lives in. Today the engine is scoped per knowledge_base at the API level; there's no cross-KB query path.

Also — this is the single most visible SaaS UX decision. The app landing after login is either "a list of your Trails" (boring) or "a search bar that knows everything you've ever ingested" (the product).

## Solution

Two scopes, one interface:

1. **Frontpage (`app.trailmem.com/`)** — search and chat operate across every Trail owned by the signed-in user, with each result / citation clearly tagged by its source Trail. Results are filterable by Trail.
2. **Inside a Trail (`app.trailmem.com/trails/:slug`)** — same UI, but the query is scoped to that Trail only. No cross-contamination.

The search component is shared; only the scope parameter changes.

Also resolves a long-standing naming problem: user-facing the concept is **Trail** (a brain, a focus area), schema-facing it's still `knowledge_base`. The SaaS UX finalises "Trail" as the public label, per the brand direction decided alongside this feature.

## Technical Design

### Scope parameter

Extend chat + search endpoints with an explicit scope:

```typescript
// packages/shared/src/contracts.ts
export const SearchScope = z.union([
  z.object({ type: z.literal("tenant"), tenantId: z.string() }),           // all Trails for a tenant
  z.object({ type: z.literal("user"),   userId: z.string() }),             // all Trails for a user (per-user filter inside the tenant)
  z.object({ type: z.literal("trail"),  kbId: z.string() }),               // single Trail
  z.object({ type: z.literal("trails"), kbIds: z.array(z.string()).min(1) }), // explicit multi-select
]);
```

### Endpoint changes

```
POST /api/v1/search
body: { scope, query, limit, cursor? }
→ 200 { items: [{ docId, kbId, trailName, excerpt, highlight, score }], ... }

POST /api/v1/chat
body: { scope, message, history }
→ SSE stream with:
  - token events
  - citation events with { kbId, trailName, docSlug, excerpt }
  - done
```

The server iterates over the in-scope KB ids and runs FTS5 per KB, merging by score. For chat, the retrieval step walks the scoped KB list, pulls top-K wiki pages per KB, ranks globally by relevance, and passes the aggregate context to the LLM along with per-result `trailName` annotations so the model cites correctly.

### Frontpage UX

```
┌─────────────────────────────────────────────────┐
│  [Your Trails ▾]        ⌕ Search everything…    │
├─────────────────────────────────────────────────┤
│                                                 │
│  Recent activity across all Trails              │
│  ▸ Clinical Notes   3 new candidates            │
│  ▸ Research         Wiki page updated           │
│                                                 │
│  Start a chat  ────────────────────────────     │
│  [ Ask anything across all your Trails… ]       │
│                                                 │
└─────────────────────────────────────────────────┘
```

"Your Trails ▾" opens a multi-select filter so users can narrow cross-Trail search (e.g. "search only Clinical Notes and Research").

### Scoped Trail view

```
app.trailmem.com/trails/clinical-notes
```

Same search + chat components, `scope = { type: "trail", kbId }` hardcoded. Visually the chrome changes — Trail-specific sidebar (wiki tree, sources, queue) + scoped search input.

### Retrieval cost

Cross-Trail chat must be bounded: if a user has 50 Trails, naive retrieval scans 50 × top-K = 500 candidate pages per query. Cap: top-K from each of the top-M Trails (M=5) chosen by a cheap per-Trail relevance signal (e.g. FTS5 `bm25()` on the query). Surface the cap in the UI so users know "I searched your 5 most relevant Trails".

### "Initialize Trail" / Create New Trail

Frontpage CTA. Creates a new KB for the signed-in user. The existing "Initialize Node" button on the landing site becomes "Create Trail" inside the SaaS — and the naming decision (Trail vs Node vs Brain vs Neurons) is resolved in favour of Trail in F38 copy.

## Impact Analysis

### Files affected

- **Modify:** `apps/server/src/routes/search.ts` — accept new scope type
- **Modify:** `apps/server/src/routes/chat.ts` — accept new scope type, multi-KB retrieval
- **Modify:** `packages/shared/src/contracts.ts` — scope union type
- **Create (SaaS app, likely `apps/saas/`):** frontpage, Trail list, search component, per-Trail view
- **Modify:** landing nav from "Initialize Node" → "Create Trail" (copy) pointing at `app.trailmem.com/signup`

### Downstream dependents

- `apps/mcp/src/tools/search.ts` — extend to support scope. External MCP clients currently pass `kbId` — keep backwards compat.
- `<trail-chat>` widget (F29) — accept `scope` attribute; default is still per-KB.

### Blast radius

Scope union with backwards-compat default (if no scope, treat as single KB using `kbId` path param) keeps every existing caller working. Multi-KB chat needs thought: LLM context window may blow past 200k if a user has many large Trails — the top-M bounding above is load-bearing.

### Breaking changes

None if backwards-compat is kept. The API evolves additively: new `scope` body field supersedes the path-param `kbId` but both remain supported.

### Test plan

- [ ] `POST /search` with `scope: { type: "tenant", tenantId }` returns hits from multiple KBs with `trailName` annotations
- [ ] `POST /chat` same scope: streamed answer includes citations from ≥2 Trails
- [ ] Frontpage chat: signed-in user with 3 Trails asks a question answerable from Trail #2 — response correctly cites Trail #2
- [ ] Scoped Trail view: same question scoped to Trail #1 returns "no answer" if Trail #1 has no relevant content
- [ ] Top-M bounding kicks in when tenant has >5 Trails; UI surfaces the cap
- [ ] Regression: existing per-KB chat and search via path-param kbId still work unchanged
- [ ] Regression: MCP `search` tool still works with existing `kbId` arg

## Implementation Steps

1. Extend `packages/shared` contracts with the `SearchScope` type.
2. Refactor search endpoint to accept scope; add tenant/user/multi-KB branches.
3. Refactor chat retrieval step to walk a KB list, rank globally, cap to top-M Trails.
4. Add per-result `trailName` enrichment in responses (join to `knowledge_bases` for name).
5. Scaffold `apps/saas/` frontpage and per-Trail view (reuses F18 curator components where sensible).
6. Wire the "Create Trail" flow via existing KB-create endpoint.
7. Integrate the `<trail-chat>` widget with the new scope attribute.
8. Finalise naming: update UI copy to use "Trail" consistently; update brand/marketing docs accordingly.

## Dependencies

- F04 Knowledge Bases (the per-Trail data model)
- F10 FTS5 search (per-KB search already works)
- F12 Chat endpoint (per-KB chat already works)
- F17 Curation Queue API (queue notifications in frontpage activity feed)
- F29 `<trail-chat>` widget (reused for frontpage + per-Trail chat)
- F40 Multi-tenancy (multi-user SaaS is the audience for this)
- F41 Tenant provisioning + signup (users arrive here after signup)

Unlocks: SaaS product feel. This is the feature that makes `app.trailmem.com` not-just-another-RAG-tool.

## Effort Estimate

**Medium** — 7-10 days including retrieval tuning, UX polish, and naming rollout.

## Open: Naming

User flagged this is still unsettled ("Nodes (stadig i mangel på et bedre ord — Initialize Trail/Node/Brain/Neurons)"). This plan assumes:

| Concept | Brand | Schema |
|---|---|---|
| A user's knowledge base | **Trail** | `knowledge_base` |
| A compiled wiki page inside it | **Neuron** | `documents.kind='wiki'` |
| The act of creating a new one | **Create Trail** | `POST /api/v1/knowledge-bases` |

Change here before F38 ships if the naming lands differently.
