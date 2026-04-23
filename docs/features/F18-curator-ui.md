# F18 — Curator UI Shell

> First admin surface for trail. Vite + Preact + Tailwind v4 + shadcn/ui (new-york / neutral). Queue-first workflow — the point of the app is not editing wiki pages, it's approving what the engine proposes.

## Problem

F17 ships the Curation Queue HTTP API. Without a UI, a curator has no way to see candidates, approve, reject, or edit. curl-driven curation is not what Sanne will use.

## Secondary Pain Points
- No visibility into what the LLM is proposing before it hits the wiki
- No way to filter by candidate kind (contradictions vs summaries vs gaps)
- No keyboard-first workflow for power curators

## Solution

Ship a minimal single-page admin at `apps/admin`. Three panels:

1. **Queue** — sorted by `impact × confidence`, filterable by `kb`, `kind`, `status`. One-click approve, reject, or "edit then approve" via the diff view (F20).
2. **Sources** — upload, list, archive. Dropping a PDF here triggers ingest and queues candidates.
3. **Wiki tree** — read-only tree of compiled pages per KB. Click a page → render the latest version.

No WYSIWYG editor in Phase 1. Curators approve what the LLM proposed; they don't rewrite pages from scratch.

## Non-Goals
- WYSIWYG editing of wiki pages (Phase 2+)
- Multi-user collaboration on the same queue
- Mobile-responsive design (desktop-only in Phase 1)
- Analytics dashboard (that's F54)

## Technical Design

### Stack

| Layer | Choice |
|---|---|
| Build | Vite 5.4 |
| Framework | Preact 10.23 |
| Styling | Tailwind v4 (CSS-first) |
| Components | shadcn/ui (new-york / neutral theme — matches landing site) |
| Icons | Lucide |
| Data | TanStack Query + Zod-validated responses |
| Auth | Session cookie set by the engine's OAuth flow (F03) |

### Routing

```
/                     → redirect to first KB's queue
/kb/:kbId/queue       → queue panel (default)
/kb/:kbId/sources     → source list + upload
/kb/:kbId/wiki        → wiki tree + selected page
/kb/:kbId/wiki/:slug  → single wiki page view
```

Preact-router. No server-side rendering — the admin is a private SPA talking to `apps/server`.

### Queue panel

Scrollable list, virtualised above ~200 items. Each row:

```
┌─────────────────────────────────────────────────────────────┐
│ ▸ Contradiction alert · conf 0.72 · impact 0.9              │
│   "Grad 3 stressrespons kontra..."                          │
│   Affects: stressgrader.md, behandling.md · 2 minutes ago   │
│   [Approve]  [Reject]  [Open diff]                          │
└─────────────────────────────────────────────────────────────┘
```

"Open diff" launches F20. "Approve" fires `POST /queue/:id/approve` with the reviewer id; optimistic UI strikes the row, toast confirms.

### Filter + search

Top bar: status pills (pending, auto_approved today, rejected), kind filter, free text search (LIKE on payload_json title/excerpt). Sort toggles impact, confidence, recency.

### Auto-approved feed

Separate sub-panel. Lists recently auto-approved candidates with 1-click undo (creates a `source_retraction`-style reversal candidate). Curator skims the auto-approved feed as reassurance.

## Interface

### API Calls
- `GET /api/v1/queue?kbId=&status=&kind=&limit=50` — list candidates
- `POST /api/v1/queue/:id/approve` — approve with optional edits
- `POST /api/v1/queue/:id/reject` — reject with reason
- `POST /api/v1/knowledge-bases/:id/documents/upload` — upload source
- `GET /api/v1/knowledge-bases/:id/documents?kind=wiki` — list wiki pages

### Events (SSE)
- `candidate_created` — new candidate lands
- `candidate_approved` — candidate approved
- `candidate_rejected` — candidate rejected
- `badge_count` — pending count update

## Rollout

**Single-phase deploy.** The admin is a new app — no migration needed. Server CORS change is the only backend touch.

## Success Criteria
- Admin loads within 2 seconds on first paint
- Queue list renders 200 candidates without jank (virtualised)
- Approve action completes within 500ms (optimistic UI)
- Keyboard shortcuts work: `a` approve, `r` reject, `j`/`k` next/prev
- Upload a PDF → candidates appear within ~155s
- Zero console errors on Chrome, Firefox, Safari

## Impact Analysis

### Files created (new)
- `apps/admin/package.json`
- `apps/admin/vite.config.ts`
- `apps/admin/tsconfig.json`
- `apps/admin/index.html`
- `apps/admin/src/**` (all admin source files)

### Files modified
- `package.json` root (add admin to workspace globs)
- `apps/server/src/app.ts` (CORS origin for admin)

### Downstream dependents
`apps/server/src/app.ts` is imported by 4 files (see F17 analysis). Adding CORS origin is additive.

New admin app has no internal dependents — it's a consumer of the API.

### Blast radius
Server CORS change is the only server-side touch; if misconfigured, admin calls fail with a clear 403. No risk to the engine runtime.

### Breaking changes
None — new app.

### Test plan
- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Build produces static bundle under `apps/admin/dist/`
- [ ] Login via Google (redirect from engine) lands on queue panel
- [ ] Approve a candidate → row strikes, `GET /queue` no longer returns it as pending
- [ ] Reject a candidate → moves to rejected filter
- [ ] Upload a PDF on sources panel → see candidates appear within ~155s
- [ ] Keyboard shortcuts work: `a` approve, `r` reject, `j`/`k` navigate
- [ ] Regression: engine `/api/v1/*` endpoints unaffected by CORS changes
- [ ] Regression: existing API consumers (MCP, CLI) unaffected

## Implementation Steps
1. Scaffold Vite+Preact+Tailwind v4 app at `apps/admin`.
2. Install shadcn/ui new-york / neutral. Pick components: Button, Card, Badge, Toast, Dialog, Tabs, ScrollArea, Input, Select.
3. Wire OAuth redirect (engine sets session cookie on `trail.broberg.ai`, admin sits on same root domain or accepts cookie via CORS credentials).
4. Queue panel with infinite scroll + filters.
5. Sources panel with drag-drop upload (multipart/form-data to `/api/v1/knowledge-bases/:id/documents/upload`).
6. Wiki tree panel (read-only).
7. Keyboard shortcuts: `a` approve, `r` reject, `j`/`k` next/prev, `/` focus search.

## Dependencies
- F17 Curation Queue API (hard)
- F03 Google OAuth (reuse)
- F05 Sources upload endpoint (for upload panel)

Unlocks: F20 Diff UI, F37 Sanne onboarding, F54 curator analytics (Phase 2).

## Open Questions
None — all decisions made.

## Related Features
- **F17** (Curation Queue API) — data source
- **F20** (Diff UI) — integrated into queue panel
- **F37** (Sanne Onboarding) — first user of admin UI
- **F54** (Curator Analytics) — future panel in admin
- **F91** (Neuron Editor) — extends wiki tree with editing

## Effort Estimate
**Medium** — 6-8 days including polish + keyboard-first UX.
