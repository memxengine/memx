# F92 — Tags on Neurons

> Tags are stored on every Neuron but currently only surfaced inside the editor (and as readonly chips in the reader, shipped with F91). Make them useful: filter the Neuron listing, facet the search, and have the LLM suggest them at chat-save time.

## Problem

`documents.tags` has been a real column since the ingest pipeline shipped, and F91 added a chip editor + readonly render in the reader. But there's no aggregate surface:

- The Neuron listing (`/kb/:kbId/neurons`) doesn't show tags or let you filter by them.
- Search (`/kb/:kbId/search`) doesn't include tags as a facet.
- When the chat-save flow creates a new Neuron candidate, it never populates tags — so any tag set has to be typed manually in the editor afterward.

The result: curators who tag diligently still get no navigation or retrieval benefit, so most Neurons stay untagged. F92 closes the loop.

## Scope

**In scope (v1):**
- Neuron listing shows per-Neuron tag chips + a tag-filter bar at the top. Click a tag → list narrows to Neurons with that tag. AND-semantics when multiple tags are selected.
- Search page accepts tag filters alongside free text (`?q=sanne&tag=incident&tag=ops`).
- The chat-save candidate producer (the flow that turns a chat answer into a Neuron via the queue) asks the LLM for 0-5 tags and writes them into `op.tags`. They land on the Neuron automatically when the candidate approves.
- A tenant-scoped tag-aggregate endpoint (`GET /api/v1/knowledge-bases/:kbId/tags`) returns every distinct tag + its Neuron count, so the listing filter bar can render all tags even before the first filter is applied.

**Out of scope (v1):**
- Tag rename / merge tools — defer until we see tag duplication in practice (e.g. "ops" vs "operations").
- Global (cross-KB) tag navigation — F38 cross-Trail search might cover that later.
- Per-tag RSS / export feeds — speculative.
- Colour coding per tag — every tag renders in the same accent colour via the shared TagChips component. Colour-by-tag adds a styling dimension with no clear payoff.
- Source-document tags — `documents.tags` exists on sources too but this feature is Neuron-only; the source listing can follow if we see demand.

## Design

### Aggregate endpoint

```
GET /api/v1/knowledge-bases/:kbId/tags
→ [{ tag: "ops", count: 12 }, { tag: "incident", count: 4 }, …]
```

SQL: `SELECT tags FROM documents WHERE knowledge_base_id = ? AND kind = 'wiki' AND archived = 0` then split-and-count in app code (SQLite's string tokenising is awkward enough that a 100-line loop is cleaner than a trigger-maintained tag table for the current volume; revisit if a KB exceeds ~10k Neurons).

Result cached per-KB with a 60s TTL + busted on `candidate_approved` events for the KB. The existing event-stream plumbing (F87) already lets the admin react — reuse that.

### Listing filter

`apps/admin/src/panels/wiki-tree.tsx` gets a filter bar: all tags from the aggregate endpoint rendered as togglable chips. Selected tags narrow the visible list to Neurons whose `parseTags(doc.tags)` contains ALL selected tags. No server round-trip — the full Neuron list is already loaded for the tree render.

### Search facet

`apps/admin/src/panels/search.tsx` + the `GET /api/v1/search` endpoint:
- Client sends `?tag=` params.
- Server filters results to docs whose `tags` column contains each tag (LIKE-based match is fine; canonical separator is `, ` so the match is `tags LIKE '%' || ? || '%'` with the tag wrapped in its delimiters).
- Hits are returned in the same shape with `tags` populated so the search UI can render chips per hit.

### Chat-save tag suggestion

`apps/server/src/routes/chat.ts` (or wherever the chat-save-to-candidate handler lives) currently builds a `CreateQueueCandidate` with title + content. After the LLM drafts the Neuron but before the candidate is created, add one more LLM pass with a prompt like:

> "Given this Neuron title + body and the existing tags in this knowledge base (list attached), return 0–5 tags (existing or new, comma-separated, lowercase, kebab-case, no more than 20 chars each) that would help a curator find this Neuron later. Return empty string if no tag is obviously useful."

The response gets sanitised with `parseTags()` (same helper the UI uses) and written into `op.tags` on the candidate. Existing tags in the KB come from the aggregate endpoint cache.

Toggle: `TRAIL_AUTO_TAG_CHAT_SAVES=1` (default on) — one env switch to disable if the suggestions turn out noisy.

### Sanitisation + canonical form

`parseTags()` in `components/tag-chips.tsx` already dedupes case-insensitively and trims. Extend (same module, no new file) with a canonicaliser applied at write time:

```ts
export function canonicaliseTag(raw: string): string | null {
  const t = raw.trim().toLowerCase().replace(/\s+/g, '-');
  if (!t || t.length > 40) return null;
  if (!/^[a-z0-9-]+$/.test(t)) return null; // no punctuation, no unicode
  return t;
}
```

Server-side `submitCuratorEdit` + `approveUpdate` + create-candidate paths call this on every incoming tag. Rejected tags get silently dropped — the UI can surface warnings in a follow-up.

## Impact Analysis

### Files affected

- New: `apps/server/src/routes/tags.ts` (aggregate endpoint) — or extend an existing `knowledge-bases.ts` route.
- Modify: `apps/admin/src/components/tag-chips.tsx` — add `canonicaliseTag` helper.
- Modify: `apps/admin/src/panels/wiki-tree.tsx` — filter bar + per-row chip render.
- Modify: `apps/admin/src/panels/search.tsx` + `apps/server/src/routes/search.ts` — tag facet.
- Modify: `apps/admin/src/api.ts` — `listTags(kbId)` helper, extend `search(query, { tags })`.
- Modify: `apps/server/src/routes/chat.ts` — LLM tag-suggest step before candidate creation.
- Modify: i18n keys for filter bar ("All Neurons", "Filter by tag", "Clear filters").

### Downstream dependents

- **F91 Neuron editor** — already uses `TagChips` + `parseTags` + `serializeTags`. Extending the module with `canonicaliseTag` is additive; call sites in the editor adopt it on save.
- **F15 reference-extractor** — doesn't read tags. Unchanged.
- **F32 lint** — doesn't read tags. Unchanged. (Future: could lint "orphan tag" Neurons with just one tag.)
- **F87 event stream** — the tag-aggregate cache busts on `candidate_approved` which is already emitted. No new event kinds.
- **F12 chat endpoint** — the save-to-queue branch picks up the new tag-suggest pass. Current behaviour (no tags) becomes the degraded path if `TRAIL_AUTO_TAG_CHAT_SAVES=0`.

### Blast radius

Medium-low. Additive feature; no schema change (still one string column). The search facet and listing filter are new UI surfaces with no backwards-compatibility debt. The chat-save LLM call adds one short prompt per Neuron — cost negligible.

Risk areas:
- Tag canonicalisation. If we canonicalise aggressively, existing tags entered by hand (`Sanne Jensen`) become invalid and get dropped silently. Migration: on first load of the `tags` endpoint, run a one-shot backfill that rewrites existing tag strings through the canonicaliser — logged, not silent.
- LLM tag noise. Mitigation: env toggle + a length/count cap. If Sanne says "stop suggesting tags", flip the env var and the suggestion step is a no-op.

### Breaking changes

None for existing flows. The canonicaliser changes what's accepted on write, but not what's stored — existing non-canonical tags stay readable and render as-is in chips.

### Test plan

- TypeScript compiles: `pnpm -r --filter "@trail/*" exec tsc --noEmit`
- `GET /api/v1/knowledge-bases/:kbId/tags` returns tag+count rows.
- Listing filter: add a Neuron with tags `[ops, incident]`, filter by `ops` → visible; filter by `ops, incident` → visible; filter by `ops, security` → hidden.
- Search with `?q=foo&tag=ops` → results narrowed.
- Chat-save with auto-tag on → candidate metadata carries `op.tags` populated.
- Chat-save with `TRAIL_AUTO_TAG_CHAT_SAVES=0` → candidate metadata has `op.tags` null/undefined.
- Regression: editor save still round-trips tags via `TagChips`.
- Regression: reader still renders readonly chips.
- Canonicaliser: `"Incident Response"` → `"incident-response"`; `"øl"` → rejected (unicode); `"a".repeat(50)` → rejected (length).

## Implementation Steps

1. Add `canonicaliseTag` to `components/tag-chips.tsx` and call it from editor save + `submitCuratorEdit` server-side.
2. One-shot backfill script that canonicalises existing `documents.tags` values, logged.
3. `GET /api/v1/knowledge-bases/:kbId/tags` endpoint + in-memory cache + bust-on-event.
4. Admin listing filter bar + per-row chip render.
5. Search facet (server + client).
6. Chat-save tag-suggest LLM pass + env toggle.
7. i18n sweep (en + da).
8. Manual test plan above.

## Dependencies

- F91 Neuron editor (done — ships `TagChips`, `parseTags`, `serializeTags`).
- F12 Chat endpoint (done — needs the save-to-candidate branch to hook into).
- F87 Event stream (done — used for cache busting).

## Effort Estimate

**Medium** — 2-3 days focused. Listing + search facet is UI work (~1 day), aggregate endpoint + cache is half a day, chat-save LLM pass + backfill script is a day.

## Unlocks

- Curators who tag get retrieval + navigation benefit → tagging adoption compounds.
- Auto-tagging makes chat-save Neurons searchable on day one without manual follow-up.
- Foundation for F38 cross-Trail search: a tag vocabulary is the lightest cross-tenant facet.

## Handoff notes

- Read `apps/admin/src/components/tag-chips.tsx` first — `parseTags` + `serializeTags` are the canonical wire format.
- The chat-save branch: find it from `apps/server/src/routes/chat.ts` → `createCandidate` call site.
- Aggregate endpoint: hang it off `GET /api/v1/knowledge-bases/:kbId/tags` rather than `/api/v1/tags` so it's naturally KB-scoped and auth flows through the existing `requireAuth` middleware.
- The backfill script goes under `scripts/` + gets invoked from `scripts/trail` (or as a one-shot admin action).
