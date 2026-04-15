# PLAN-PATCH — proposals on top of PLAN.md

> **Context:** Side document with proposals from a planning conversation on claude.ai. Intentionally separate from `PLAN.md` and `SESSION-START.md` so it does not pollute the active cc session. Treat it as a pitch deck for cc — adopt what's useful, reject what isn't, merge accepted parts into `PLAN.md` when ready.
>
> **Author:** claude.ai (Opus 4.6) in conversation with Christian
> **Date:** 2026-04-14
> **Status:** Draft proposals, not yet accepted

---

## TL;DR

1. **Curation Queue must land in Phase 1, not "planned ahead for".** If ingest→wiki is built as a direct path first and the queue gets bolted on later, we rewrite the ingest pipeline. The queue IS the write path. No exceptions, even for auto-approved candidates.
2. **Wiki versioning has a gap.** `wiki_events` exists in schema, but it needs to be a replay-able event stream from day 1, not just an audit log. Otherwise Phase 3 event-sourcing becomes a schema migration, not a feature.
3. **Stable claim anchors should ship in Phase 1**, even if claims-as-first-class entities wait for Phase 3. Wiki pages with stable `{#claim-id}` anchors now cost nothing and unlock provenance, trust tiers, and cascading invalidation later — no migration.
4. **~12 additional ideas** below, ordered by leverage. Several are cheap in Phase 1 but compound hard in Phase 2/3.

---

## 1. Curation Queue — land it ASAP (critical)

### Why this is urgent

`packages/db/src/schema.ts` already has `queue_candidates`. Good. But the risk is that the first version of `apps/server` ships with an ingest path that writes directly to `documents` (kind=wiki), and the queue gets bolted on in "Phase 1.5" as a second write path. The moment that happens, we have two code paths, two invariants, two sets of tests — and migrating later means rewriting ingest.

### The rule to enforce from commit #1

> **Nothing writes to a wiki document except the Curation Queue approval handler.**

Ingest does not write wiki pages. Ingest writes **candidates**. A candidate can be auto-approved (high confidence + trusted pipeline + no contradictions) and flow through the queue in milliseconds — but it still flows through the queue. The queue is the chokepoint, the audit surface, and the undo point.

### Candidate kinds to support on day 1

Even if the curator UI only shows a subset in Phase 1, the schema should accept all of these so we don't migrate later:

- `ingest_summary` — from a new source being compiled
- `ingest_page_update` — existing wiki page affected by new source
- `chat_answer` — Christian's original insight: save-to-wiki from chat
- `reader_feedback` — from embedded widget, "this answer was wrong/incomplete"
- `contradiction_alert` — new source conflicts with existing claim
- `gap_suggestion` — query had no good answer → suggest adding a source
- `cross_ref_suggestion` — lint found a missing `[[link]]`
- `source_retraction` — source deleted/updated → affected pages need review
- `scheduled_recompile` — periodic re-compilation of a page from its sources

In Phase 1, only the first four are likely to fire. But the enum, the `candidate_kind` column, and the dispatch logic should exist so Phase 2 is filling in handlers, not migrating.

### Auto-approval pathway

Auto-approval is not a separate code path — it's a queue policy. A candidate enters the queue, a policy evaluates it (confidence ≥ threshold, no contradictions, trusted pipeline), and if it passes, the approval handler fires automatically. Curator sees it in "recently auto-approved" with a 1-click undo. Same code path, same audit trail.

### Minimal Phase 1 scope

- **Schema:** verify `queue_candidates` has `kind`, `confidence`, `impact_score`, `status`, `payload_json`, `auto_approved_at`, `reviewed_by`, `reviewed_at`
- **Server:** `POST /api/v1/queue/candidates`, `POST /api/v1/queue/:id/approve`, `POST /api/v1/queue/:id/reject`. Approval handler is the only thing that writes to `documents` where `kind='wiki'`
- **Curator UI:** one page, list sorted by `impact × confidence`, approve/reject/edit buttons. Not fancy. Functional.
- **Policy engine:** a single function `shouldAutoApprove(candidate): boolean`. Starts as `return false`. Iterate later.

### Why this matters for Sanne specifically

Sanne is a healthcare-adjacent curator. She cannot have an LLM silently rewriting her wiki. The queue is not just a feature — it's the legal/professional boundary that makes her willing to use the system at all. Ship without queue = ship without Sanne.

---

## 2. Wiki versioning — close the event-sourcing gap in Phase 1

### Current state (inferred from SESSION-START.md)

- `wiki_events` table exists in schema
- PLAN.md Phase 1 says "Wiki: compiled markdown with cross-refs, version history"
- PLAN.md Phase 3 says "Event sourcing for full wiki history" and "Time-travel queries"

### The gap

If `wiki_events` in Phase 1 is just an audit log (timestamp + actor + action + message), Phase 3 event-sourcing becomes a schema migration, not a feature. To replay a wiki's history you need the **full payload** of every change — not just the fact that a change happened.

### The fix (cheap if done now)

Make `wiki_events` a replay-able event stream from day 1:

```typescript
wiki_events {
  id                   // ulid, monotonic
  tenant_id            // always
  kb_id                // always
  document_id          // target wiki page
  event_type           // created | updated | deleted | restored | reverted
  actor_type           // user | pipeline | auto_approval | curator
  actor_id
  payload_json         // FULL new content, not a diff (diffs are computed)
  prev_event_id        // chain pointer for fast replay
  source_candidate_id  // which queue candidate caused this
  created_at
}
```

With this in place:
- **Time-travel queries** are a matter of replaying events up to a timestamp. No migration.
- **Undo/redo** is free.
- **Diff UI** is free (compute diff between any two events).
- **Audit compliance** is free.
- **Real-time collab** (Phase 3) is broadcasting events over WebSocket. No migration.

Storage cost: ~2–5× wiki size for a year of active editing. For Sanne's single-tenant KB that's kilobytes to low megabytes. Irrelevant.

### Claim anchors — the other cheap Phase 1 win

Wiki pages should emit stable anchor IDs for claims, even though claims are not yet first-class entities:

```markdown
## Stressgrader

Grad 3 kendetegnes ved vedvarende kortisolforhøjelse og søvnforstyrrelser. {#claim-01}
Behandling i denne grad fokuserer på parasympatisk aktivering via... {#claim-02}
```

The `{#claim-xx}` anchors are generated by the compiler and are stable across re-compilations (by hashing claim text or position). They cost nothing now, and in Phase 3 they become the join key for the `claims` table — no schema migration, no re-parsing of wiki pages.

This is the single cheapest "prepare for Phase 3" move in the whole plan.

---

## 3. New ideas to pitch

Ordered by leverage. ★ = ship in Phase 1, ☆ = Phase 2+ but design for it now.

### ★ 3.1 Bidirectional provenance (wiki ↔ source)

Current plan: source → wiki (claim sourced from source-v5 §3.2).
Addition: wiki → source (this source affected these pages).

Why: when Sanne updates a source, she needs to see "these 7 pages are now stale." That's `SELECT wiki_pages WHERE source_id = X`, which requires the inverse index. Cost: one join table. Benefit: the cascading re-review feature in Phase 3 becomes a trivial query.

### ★ 3.2 Wiki diff UI in curator dashboard

When a curator reviews a candidate that updates an existing page, show a git-style diff of "before" vs "after proposed change". Three-pane: old version, new version, rendered preview. The curator approves/rejects/edits the *diff*, not the whole page.

Makes curation 10× faster than reviewing full pages. Costs a diff library. Requires event-sourced wiki (§2), which is another reason to do that in Phase 1.

### ★ 3.3 Reader feedback → queue (closes the embed loop)

The `<trail-chat>` widget in Phase 2 should have a 👎 button that opens a "tell us what was wrong" textbox. That submission becomes a `reader_feedback` candidate in the queue with the full chat context attached.

This completes Christian's original feedback-loop insight from PRIMER.md. Without it, embedded widgets are read-only — huge missed opportunity. Cost: one endpoint, one button. Benefit: every embed is a crowd-sourced quality improvement channel.

Phase 1 note: even though the widget is Phase 2, the `reader_feedback` candidate kind should exist in the Phase 1 schema. Zero cost, no migration.

### ★ 3.4 Dogfooding: trail.wiki is built from trail docs

Every commit to `trail/docs/**` triggers an ingest into a public trail.wiki instance. The trail homepage IS a trail wiki. We use our own product to document our own product.

Linear's trick, Vercel's trick, Cloudflare's trick. Gives us: live demo that's always up to date, stress test on real content, credibility, compounding SEO. Cost: a GitHub Action + a dedicated tenant. Benefit: marketing + QA + demo + docs site, all from one pipeline.

### ★ 3.5 Ingest backpressure — don't flood the queue

A curator uploads a 400-page PDF. The pipeline extracts 80 wiki updates. The queue now has 80 candidates and Sanne closes the tab in panic.

Fix: rate-limit candidates per-KB per-hour. Excess go into a `pending_ingestion` state and trickle in as older candidates are resolved. The curator sees "12 in queue, 68 waiting" and stays calm.

Cost: a counter + a cron. Benefit: Sanne actually uses the curator UI.

### ☆ 3.6 Canonical source flag (for healthcare/legal)

A curator can mark a source as "canonical" for a topic. Example: Sanne marks "Biopati Grundbog" as canonical for biopati content. When ingest encounters another source that contradicts a canonical source, it refuses to auto-approve and raises the candidate to the top of the queue with a red badge.

This is the trust-tier system in Phase 3, but the `is_canonical` boolean on sources is a 30-second addition to the Phase 1 schema. Ship it.

### ☆ 3.7 Wiki freshness scoring in lint

Each wiki page has `last_compiled_at` and `last_curated_at`. The lint pass surfaces pages untouched in N months as "possibly stale". Free feature once event sourcing is in place (§2). Becomes a killer feature on the Business tier where curators manage hundreds of pages.

### ☆ 3.8 Scheduled re-compilation

Every 90 days, re-compile each wiki page from its backing sources. LLM capabilities improve over time; a page compiled with Sonnet 4 in Phase 1 and re-compiled with a Phase 3 model may catch nuances the first pass missed. The re-compilation produces a `scheduled_recompile` candidate — if nothing changes, auto-dismissed; if meaningful differences, curator reviews.

This is how trail compounds not just with new sources but with better models. "Knowledge that gets smarter even without new input."

### ☆ 3.9 Federated trail (long-term, but design for it now)

A trail instance can subscribe to another instance's public wiki. Sanne's wiki can cite (via `[[ext:fysiodk/zoneterapi]]`) FysioDK's wiki page on the same topic. Sync via a public `/api/v1/wiki/public/:page` endpoint and ETags.

Why pitch now: it affects the wiki-link syntax. If `[[zoneterapi]]` is always intra-KB, we paint ourselves into a corner. Use `[[zoneterapi]]` (intra-KB), `[[kb:other-kb/zoneterapi]]` (cross-KB same tenant), `[[ext:tenant/kb/zoneterapi]]` (federated). Design the link parser once, forever.

### ☆ 3.10 CLI for curators

`trail queue list`, `trail queue approve <id>`, `trail source add <path>`. Thin wrapper around the MCP tools. Some curators prefer terminals (Christian certainly does). Cost: negligible once MCP server exists. Benefit: keyboard-driven curation for power users, and a way for Christian to curate Sanne's wiki from `cc` while working on the engine.

### ☆ 3.11 "Ask to ingest" — gap detection as a first-class loop

When a chat query returns poor results (low confidence, few citations), the system doesn't just say "I don't know." It creates a `gap_suggestion` candidate: "This query had no good answer. Suggested action: ingest a source on [topic]." The curator sees gaps sorted by frequency — the questions readers keep asking that Sanne hasn't answered yet.

Turns user queries into a content roadmap. Single most useful analytics feature a knowledge base can have. Falls out of the queue architecture for free.

### ☆ 3.12 Per-KB encryption at rest

For healthcare and legal tenants, offer a per-KB encryption key held by the tenant. trail stores ciphertext; decryption happens in-memory per-request with the tenant's key supplied at session start. Not SOC 2 by itself but a strong story for regulated industries.

Phase 1: design the storage interface so content passes through an `encrypt/decrypt` middleware, even if it's a no-op by default. Zero cost now, unlocks Phase 3 compliance story.

---

## 4. Deltas to PLAN.md

**Phase 1 — add to deliverables:**
- [ ] Curation Queue is the *only* write path to wiki documents (not "planned ahead")
- [ ] `wiki_events` is a replay-able event stream with full payloads
- [ ] Stable `{#claim-xx}` anchors in compiled wiki pages
- [ ] Bidirectional wiki ↔ source index
- [ ] `is_canonical` flag on sources
- [ ] `candidate_kind` enum supports all 9 types (handlers can be Phase 2)
- [ ] Wiki-link parser supports `[[kb:...]]` and `[[ext:...]]` prefixes
- [ ] Ingest backpressure (candidates-per-hour rate limit)

**Phase 1 — nice to have:**
- [ ] Diff UI in curator dashboard
- [ ] Gap suggestions from low-confidence queries

**Phase 2 — new:**
- [ ] Reader feedback button in `<trail-chat>` widget → queue
- [ ] Dogfooding pipeline: trail.wiki built from `trail/docs/**`
- [ ] Wiki freshness scoring in lint

**Phase 3 — clarified:**
- [ ] Event-sourcing becomes a feature (replay, time-travel, undo) because the stream already exists
- [ ] Claims table joins on the existing `{#claim-xx}` anchors — no re-parsing
- [ ] Federated trail via `[[ext:...]]` links
- [ ] Per-KB encryption at rest
- [ ] Scheduled wiki re-compilation

---

## 5. Open questions for cc and Christian

1. Is `wiki_events` currently shaped as audit log or event stream? If audit log, is a Phase 1 schema adjustment acceptable?
2. Does `queue_candidates` already have `kind`, `confidence`, `impact_score`? If not, add now.
3. Is the curator UI in Phase 1 scoped for queue-first workflow or traditional wiki editing? This patch argues for the former.
4. Dogfooding: do we want trail.wiki as a public tenant on trailcloud, or self-hosted on Fly.io? (Recommend: self-hosted so trailcloud has no single-tenant special cases.)
5. Canonical sources: does Sanne mark her own material as canonical explicitly, or should the curator role imply canonicality? (Recommend: explicit flag, because not all of Sanne's material is canonical for all topics.)

---

## 6. If cc only has time for 3 things

1. **CQ as sole write path** — prevents rewrite
2. **Event-sourced `wiki_events` with full payloads** — prevents rewrite and unlocks Phase 3 for free
3. **Stable claim anchors** — prevents rewrite

All three are anti-migration moves. Everything else is additive and can wait.
