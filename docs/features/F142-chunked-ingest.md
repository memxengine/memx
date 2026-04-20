# F137 — Chunked ingest for large sources

> A 120-page clinical textbook compiled in one `spawnClaude -p` call is architecturally wrong. Today's pipeline crams the entire source into a single prompt and asks the LLM to emit every Neuron in one session — a flow that hit the 25-turn limit and the 180-second timeout on sources as small as 14 pages. Ship three ingest strategies — **monolith** (current), **chained per-page**, **parallel per-concept** — with an auto-selector that picks the right one per source size + shape, plus a user override at upload time.

## Problem

The ingest pipeline at `apps/server/src/services/ingest.ts` currently does:

1. Read full source text (already extracted).
2. Spawn one `claude -p` subprocess with the entire text in the prompt.
3. Ask the LLM to emit summary + all concepts + all entities + overview + log in ≤25 turns, within 180 seconds.
4. If any of that fails, the whole run is lost.

Observed failure modes on real customer PDFs:

- `error_max_turns / num_turns:26`: 14-page article with ~10 concepts + 4 entities + overview + log + glossary crosses the 25-turn budget. Nothing ships.
- `claude timed out after 180s`: 22-page article never reaches DONE before the timeout fires.
- No progress signal: curator sees "Processing…" for 3 minutes with no intermediate feedback.

Raising the budget ceilings (done as interim fix: 30 min / 200 turns) moves the ceiling higher but doesn't fix the underlying shape. Sanne's next sources are 80-120 page clinical books. The architecture has to change.

## Solution

Introduce three ingest strategies and an auto-selector.

- **Monolith** (`monolith`) — one `spawnClaude -p` with the entire source inline. *Current behaviour.* Maximum brain-coherence: the LLM sees the full document in one context window and can synthesise across every page. Best for small or mid-size sources where the whole PDF fits comfortably in the LLM's turn/token budget.
- **Chained per-page** (`chained`) — split into per-page markdown, compile sequentially. Each page's compile sees a running `IngestState` summarising what previous pages contributed, so concepts accumulate and refine instead of duplicating. Preserves argumentative continuity at cost of some whole-doc synthesis. Best for books and long articles with an internal argument structure.
- **Parallel per-concept** (`parallel`) — outline the source once, then compile one Neuron per concept in independent parallel calls. Fastest wall-time for huge disconnected content (reference manuals, sitemaps, scattered articles). Weakest on cross-concept coherence.

An `ingest_strategy` column on `documents` records which strategy ran; a `default_ingest_strategy` column on `knowledge_bases` provides a KB-wide preference; an auto-selector chooses based on source size when neither is set.

## Scope

### v1 — ship all three strategies + auto-selector

**Extraction changes:**
- PDF / DOCX / PPTX / XLSX pipelines emit `pages: string[]` alongside the current flat `markdown` — one entry per source page / slide / spreadsheet sheet.
- Text-only sources (md, txt, html, csv) stay single-chunk — their natural shape.
- New DB column `documents.page_chunks` (nullable JSON array) persists the split so `/reingest` doesn't re-extract.

**Strategy selection:**
- New DB columns:
  - `documents.ingest_strategy` (nullable enum, `'monolith' | 'chained' | 'parallel'`) — what was used for the last ingest. Records history.
  - `knowledge_bases.default_ingest_strategy` (nullable enum, same values or `null = auto`) — curator preference set in KB settings.
- Upload-dialog dropdown ("Compile as"):
  - "Auto (recommended)" — default
  - "Book / sustained argument (chained)"
  - "Reference / scattered articles (parallel)"
  - "Small document (monolith)"
- Auto-selector rule:
  - ≤ 15 pages → `monolith`
  - 16–80 pages → `chained`
  - \> 80 pages → `chained` (default) unless KB default says otherwise
  - KB default always wins over size heuristic when set explicitly
  - Explicit upload override always wins over auto + KB default

**Strategy 1 — monolith (unchanged):**
- The current `runIngest` codepath runs as today with the tight budgets (`INGEST_MAX_TURNS = 25`, `INGEST_TIMEOUT_MS = 120_000`). Safety-net bumps revert once the other strategies land.

**Strategy 2 — chained per-page (new, `services/chained-ingest.ts`):**
- Iterates `page_chunks` in document order.
- Maintains an `IngestState` between chunks:
  ```ts
  interface IngestState {
    conceptsSoFar: Array<{ slug: string; title: string; summary: string }>;
    entitiesSoFar: Array<{ slug: string; kind: 'person' | 'org' | 'tool' | 'other'; note: string }>;
    glossaryTermsSoFar: string[];
    pagesProcessed: number[];
    lastError: string | null;
  }
  ```
- Per-chunk prompt assembles:
  - This page's markdown
  - "Progress so far" block from state
  - KB's existing tag vocabulary (F92.1)
  - Constrained step list ("only emit a NEW Neuron if this page introduces a concept/entity NOT in progress so far; else update existing; keep under 25 turns")
- Each chunk runs `--max-turns 25`, `timeout 120_000` — tight budget, fits comfortably.
- Per-chunk state merges into cumulative state after each completion.

**Strategy 3 — parallel per-concept (new, `services/parallel-ingest.ts`):**
- Pass 1 — outline: one LLM call with the full source (or summary if > context limit), emits `Concept[]` and `Entity[]` list. `--max-turns 10`.
- Pass 2 — per-concept compiles, fan out with a concurrency cap of 3 (avoid CLI subprocess thrash): each call has the full source + "you are compiling Neuron for concept X; ignore others". `--max-turns 15` each.
- Pass 3 — finalize: update `overview.md` + `log.md` + `glossary.md` once, `--max-turns 15`.
- Dedup collision guard: if two concept-compiles both try to create `/neurons/concepts/the-same-slug.md`, the second becomes an update via `createCandidate` with `op: 'update'`.

**Failure + resume (all strategies):**
- New column `documents.ingest_progress` (JSON) tracks `{ strategy, pagesDone, pagesTotal, state, lastError }`.
- Server crashes mid-ingest → bootstrap recovery reads `ingest_progress` and resumes from the right point with persisted state (chained picks up at `pagesDone + 1`; parallel picks up whichever concept-compiles didn't finish).
- Per-chunk / per-concept error doesn't fail the document — the orchestrator logs it, moves on. Document lands `failed` only after configurable consecutive failures (`TRAIL_INGEST_MAX_CONSECUTIVE_FAILS`, default 5).

**UI integration:**
- Source card's `CompileLogCard` (F136) renders chunk / concept events live — curator sees `chunk 3/120: 2 concepts, 1 entity, 0 glossary updates` scrolling past.
- Progress bar on the source card reflects `pagesDone / pagesTotal` (chained) or `conceptsDone / conceptsTotal` (parallel).
- Status badge shows strategy (`CHAINED • 3/120`) so the curator knows what's running.

### Out of scope for v1 — follow-ups

- **Hybrid strategies** (F137.1): run chained on the first pass for coherence, then one finalize monolith-esque call for thematic synthesis.
- **Cross-source chaining** (F137.2): ingest of book B knows what book A contributed for better KB-wide dedup. Currently cross-chunk dedup within one source only.
- **Per-chunk model override** (F137.3): use Opus for outline chunks and Haiku for per-page. Wait for cost data before optimising.
- **Summary compression** (F137.4): at 500-page books the `conceptsSoFar` block could grow to ~10 KB; compress it between chunks. Not needed until we see the problem.
- **Image-rich chunks**: a page that is mostly a vision-described image gets compiled the same as a text page. Richer per-page treatment later.

## Technical design

### Strategy selector

```ts
// apps/server/src/services/ingest-strategy.ts
export type IngestStrategy = 'monolith' | 'chained' | 'parallel';

export function pickIngestStrategy(opts: {
  pageCount: number;
  explicitOverride?: IngestStrategy;
  kbDefault?: IngestStrategy | null;
}): IngestStrategy {
  if (opts.explicitOverride) return opts.explicitOverride;
  if (opts.kbDefault) return opts.kbDefault;
  if (opts.pageCount <= 15) return 'monolith';
  return 'chained'; // safe default for everything above monolith-range
}
```

`runIngest` reads `document.ingest_strategy` (explicit upload choice), falls back to `knowledge_base.default_ingest_strategy`, then to auto. Routes to the right orchestrator file.

### Chained prompt skeleton

```
You are the wiki compiler, continuing an ingest of {filename}.
This is page {pageNum} of {pagesTotal}.

PROGRESS SO FAR
  Concepts already compiled:
    - {slug}: {summary}
    - ...
  Entities already compiled:
    - {slug} ({kind}): {note}
  Glossary terms already added:
    - {term}, ...

EXISTING TAG VOCABULARY IN THIS KB (prefer reusing):
  - {tag}, ...

THIS PAGE:

{pageMd}

Rules:
- Only emit a NEW Neuron for a concept / entity NOT already in the list above.
- If this page expands on an existing item, update it (str_replace / append) — don't create a duplicate.
- Update /neurons/glossary.md only for genuinely new domain-specific terms.
- Keep this compile under 25 turns. If the page is sparse, zero writes is fine.
```

Prompt grows linearly with state; at page 80 of a 120-page book the prefix is maybe ~2-5 KB. Trivial against 200 K context.

### Parallel orchestrator outline

```ts
async function runParallelIngest(job: IngestJob) {
  const outline = await spawnClaude(outlinePrompt(job), { maxTurns: 10, timeoutMs: 60_000 });
  const concepts = parseOutline(outline);
  const pool = new ConcurrencyPool(3);
  await Promise.all(concepts.map((c) => pool.run(() =>
    spawnClaude(conceptPrompt(job, c), { maxTurns: 15, timeoutMs: 90_000 }),
  )));
  await spawnClaude(finalizePrompt(job, concepts), { maxTurns: 15, timeoutMs: 60_000 });
}
```

### Migration shape

- `documents.page_chunks TEXT NULL` (JSON array)
- `documents.ingest_strategy TEXT NULL CHECK(ingest_strategy IN ('monolith','chained','parallel'))`
- `documents.ingest_progress TEXT NULL` (JSON)
- `knowledge_bases.default_ingest_strategy TEXT NULL CHECK(default_ingest_strategy IN ('monolith','chained','parallel'))`

All nullable — old rows behave as today (`strategy=NULL` → auto-select at next `/reingest`).

### Coherence trade-off table

Documented for curator reference (surfaced in KB settings hover text):

| Capability | Monolith | Chained | Parallel |
|---|---|---|---|
| Cross-document thematic synthesis | ✅ | ❌ | ❌ |
| Argumentative continuity page→page | ✅ | 🟡 (via state) | ❌ |
| Redundancy elimination across pages | ✅ | 🟡 | ❌ |
| Tolerance for mid-ingest failure | ❌ | ✅ | ✅ |
| Progress visibility | ❌ | ✅ | ✅ |
| Robust at 100+ pages | ❌ | ✅ | ✅ |
| Token-cost efficiency at scale | ❌ | 🟡 | ✅ |

## Impact analysis

### Files affected

**New:**
- `apps/server/src/services/ingest-strategy.ts` — selector + routing.
- `apps/server/src/services/chained-ingest.ts` — per-page orchestrator.
- `apps/server/src/services/parallel-ingest.ts` — outline + per-concept orchestrator.
- `apps/server/src/services/ingest-state.ts` — shared `IngestState` type + merge helpers.
- Migration: add `page_chunks`, `ingest_strategy`, `ingest_progress` to `documents`; add `default_ingest_strategy` to `knowledge_bases`.

**Modified:**
- `apps/server/src/services/ingest.ts` — dispatcher, no longer contains the actual compile logic.
- `apps/server/src/routes/uploads.ts` — PDF / PPTX / XLSX extractors emit `pages[]` and persist to `documents.page_chunks`; upload dialog accepts `ingest_strategy` form field.
- `apps/server/src/routes/documents.ts` — `/reingest` accepts optional `strategy` override.
- `apps/server/src/routes/knowledge-bases.ts` — PATCH accepts `default_ingest_strategy`.
- `packages/pipelines/src/pdf/index.ts` / `pptx/index.ts` / `xlsx/index.ts` — expose per-page output.
- `apps/admin/src/components/upload-dropzone.tsx` — strategy dropdown in upload dialog.
- `apps/admin/src/panels/settings-trail.tsx` — default-strategy setting per KB.
- `apps/admin/src/panels/sources.tsx` — source card shows strategy badge + progress bar.
- i18n: all new labels in `en.json` + `da.json`.

**Unchanged:**
- Queue write path — every strategy funnels candidates through `createCandidate`.
- MCP server — tool contracts stable.

### Downstream dependents

- F136 (compile-log-card) gets granular events — per-chunk / per-concept logging.
- Queue bulk actions — nothing about chunking changes candidate shape.
- F92 tag aggregator — still fed from all candidates regardless of strategy.

### Blast radius

Medium. The DB migration is additive + backwards-compatible: old rows behave as monolith. The dispatcher is a clean branch so a bug in chained/parallel never breaks monolith. Two weeks of real-world ingests across all three strategies before we consider deprecating monolith for large sources.

### Breaking changes

None.

### Test plan

**Selector:**
- ≤ 15 pages + no override + no KB default → `monolith`.
- 16 pages + no override → `chained`.
- 100 pages + KB default `parallel` → `parallel`.
- 100 pages + upload override `monolith` → `monolith` (engine tries anyway, logs warning if it fails).

**Monolith (regression):**
- Sanne's existing 3–8 page PDFs compile identically to today.

**Chained:**
- 22-page PDF compiles without failure. 22 chunk events in log.
- 120-page PDF compiles end-to-end. `conceptsSoFar` grows sensibly; no duplicate `/neurons/concepts/shen-men.md`; book's cross-page references resolve.
- Kill server at page 50 → restart → resumes at page 51 with state intact.
- Inject compile-error at page 10 → orchestrator continues to page 11 → doc lands `ready` with `lastError` preserved for the failed chunk.

**Parallel:**
- 40-page reference doc: outline pass emits ~12 concepts; per-concept fan-out compiles each in ≤90 s; finalize merges to overview.
- Concurrency=3 cap holds; we don't spawn 10 `claude` subprocesses simultaneously.
- Dedup: two concept compiles targeting the same slug → second becomes an update candidate, not a collision.

**UX:**
- Upload dialog dropdown reflects the selector default on page count.
- Status badge on source card shows strategy.
- Compile-log-card (F136) renders chunk / concept events live.

## Implementation steps

1. **Migration** — add columns, run boot-time default-init for existing rows.
2. **Per-page extraction** — refactor pipelines to emit `pages[]`; persist at upload time.
3. **Strategy selector** — `pickIngestStrategy` + tests + wiring in `runIngest`.
4. **Chained orchestrator** — prompt builder, state merger, per-chunk dispatch, failure handling, resume-from-crash.
5. **Parallel orchestrator** — outline pass, concurrency-capped fan-out, finalize pass, dedup collision guard.
6. **UI** — upload-dialog dropdown, KB settings, source-card strategy badge, progress bar.
7. **Integration with F136 compile-log events** — emit per-chunk / per-concept events.
8. **Revert interim budget bumps** — restore `INGEST_MAX_TURNS=25`, `INGEST_TIMEOUT_MS=120_000` for monolith once the other strategies are live; chained/parallel each use their own tight per-call budgets.
9. **Typecheck + test plan above**.
10. **Docs** — env knobs (`TRAIL_INGEST_CHUNK_TIMEOUT_MS`, `TRAIL_INGEST_MAX_CONSECUTIVE_FAILS`, `TRAIL_INGEST_PARALLEL_CONCURRENCY`).

## Dependencies

- F136 (compile-log-card) — not strictly required but dramatically improves the UX payoff. Build in parallel, land together if possible.
- PPTX + XLSX pipelines (done) — their per-chunk shape feeds directly.
- F98 orphan-lint awareness — continues to work; per-chunk candidates flow through the same queue.
- F92 tag vocabulary injection — used by all three strategy prompts.

## Unlocks

- Sanne can upload a 120-page clinical textbook. Today impossible; post-F137 it ingests in ~90 minutes with every page accounted for.
- User chooses strategy at upload based on document shape (or lets auto pick).
- Curator can set a KB-wide default so Sanne's clinical-book KB always uses chained, and a future reference-manual KB defaults to parallel.
- F136's progress log becomes genuinely informative with chunk-level events.
- Future F137.x (hybrids, cross-source chaining, per-chunk models, summary compression) all plug in.

## Open decisions

1. **Chunk granularity beyond per-page**: aggregate 3 pages per chunk when slides are sparse? V1 is one-page-one-chunk.
2. **Parallel concurrency cap**: 3 feels right (CPU + LLM subprocess memory); tune if LLM provider rate-limits bite.
3. **Strategy change mid-document**: if a chained ingest fails halfway, should `/reingest` retry chained from the crash point, or can the curator switch to monolith for the remaining pages? V1 is retry-same-strategy. Follow-up for hybrid.
4. **KB default vs. upload override precedence**: upload always wins. No conflict, documented for clarity.

## Effort estimate

**Medium — 3 days focused.** Breakdown:
- 0.5 day: migration + per-page extraction refactor.
- 0.5 day: selector + dispatcher.
- 0.75 day: chained orchestrator (prompt, state, resume).
- 0.5 day: parallel orchestrator (outline, fan-out, dedup).
- 0.5 day: UI (upload dropdown, KB settings, progress bar).
- 0.25 day: F136 integration + test plan walkthrough + i18n.

Parallel is cheaper to build than chained because it has no cross-call state merge; chained's state-propagation is the most subtle part.

## Effort if we ship sequentially instead of all-at-once

1. Chained + selector (mandatory for > 15-page ingests) = ~1.75 days.
2. Parallel alternative = ~0.75 days added.
3. Monolith-preservation (just dispatcher routing, no new code) = free.

Sequential shipping lets us learn from real Sanne ingests before finalising parallel's outline prompt.
