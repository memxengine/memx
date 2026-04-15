# F18 — Curator UI Shell

> First admin surface for trail. Vite + Preact + Tailwind v4 + shadcn/ui (new-york / neutral). Queue-first workflow — the point of the app is not editing wiki pages, it's approving what the engine proposes.

## Problem

F17 ships the Curation Queue HTTP API. Without a UI, a curator has no way to see candidates, approve, reject, or edit. curl-driven curation is not what Sanne will use.

## Solution

Ship a minimal single-page admin at `apps/admin`. Three panels:

1. **Queue** — sorted by `impact × confidence`, filterable by `kb`, `kind`, `status`. One-click approve, reject, or "edit then approve" via the diff view (F20).
2. **Sources** — upload, list, archive. Dropping a PDF here triggers ingest and queues candidates.
3. **Wiki tree** — read-only tree of compiled pages per KB. Click a page → render the latest version.

No WYSIWYG editor in Phase 1. Curators approve what the LLM proposed; they don't rewrite pages from scratch.

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

## Impact Analysis

### Files affected

- **Create:** `apps/admin/{package.json, vite.config.ts, tsconfig.json, index.html, src/**}`
- **Modify:** `package.json` root (add admin to workspace globs)
- **Modify:** `apps/server/src/routes/queue.ts` (CORS + cookie session for admin origin)

### Downstream dependents

- New app; no existing dependents.
- Server CORS already handles `APP_URL` origin — admin mounts on `APP_URL` (e.g. `admin.trail.broberg.ai` or dev localhost:3030).

### Blast radius

Server CORS change is the only server-side touch; if misconfigured, admin calls fail with a clear 403. No risk to the engine runtime.

### Breaking changes

None — new app.

### Test plan

- [ ] Build produces static bundle under `apps/admin/dist/`
- [ ] Login via Google (redirect from engine) lands on queue panel
- [ ] Approve a candidate → row strikes, `GET /queue` no longer returns it as pending
- [ ] Reject a candidate → moves to rejected filter
- [ ] Upload a PDF on sources panel → see candidates appear within ~155s
- [ ] Regression: engine `/api/v1/*` endpoints unaffected by CORS changes

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

## Effort Estimate

**Medium** — 6-8 days including polish + keyboard-first UX.
