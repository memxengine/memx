# F136 — Compile-log card (terminal-style progress in source rows)

> Processing sources currently show a spinner + a vague "Drafting the diff…" label. Curators can't tell if the ingest is *actually* working or hung. Replace the spinner with a live terminal-style log that streams every pipeline step (READ, PARSE, EXTRACT, COMPILE, LINK, CANDIDATE, DONE) directly inside the source card. Inspired by the onboarding site's animation — the same affordance that lets a first-time visitor *see* how Trail turns a source into Neurons.

## Problem

The source panel's current ProcessingIndicator is a one-line "Drafting the diff for review… 7m 1s" with a pulsing dot. It provides:

- A pulse (proof that time is passing)
- An elapsed counter

It does NOT provide:

- *Which* pipeline step is running (extract? compile? ref-extract? vision?)
- *How far* the run has progressed (page 3 of 18? neuron 2 of 5?)
- *Whether* anything has failed silently (a step hung, no error emitted yet)
- *What* the compile is actually producing (candidate titles? linked Neurons?)

At 7 minutes with no signal, curators legitimately suspect the ingest is stuck. The onboarding site hero shows what GOOD feedback looks like — a rolling log of named steps, tokens, entity counts, neuron IDs — and customers implicitly expect the same experience inside the app they just signed up for.

## Solution

Ship a **CompileLogCard** that subscribes to per-document compile events via SSE and renders them as a monospace, line-numbered log that pins to the bottom of the source card (or collapses into a side-drawer when Christian enables a "scroll all the way right"-style panel).

Each event is stamped with an `t+<ms>` relative-time prefix and colour-coded by kind. The card auto-scrolls on new events; users can scroll up to read history, and auto-scroll resumes when they scroll back to the bottom.

Events emitted over the lifetime of one ingest:

```
t+0000 READ  source.pdf · 18 pages · 412kb
t+0123 PARSE ok · 4,218 tokens extracted
t+0412 EXTRACT entities → 6 candidates
t+0508      · Frozen Shoulder (diagnosis) · conf 0.94
t+0521      · Codman's Pendulum (exercise) · conf 0.88
t+0712 COMPILE neuron N-01 · diagnosis/frozen-shoulder
t+0840 COMPILE neuron N-02 · exercise/codmans-pendulum
t+0914 COMPILE neuron N-03 · protocol/shoulder-week-1
t+1112 LINK N-01 ↔ N-02 · mentioned_in
t+1118 LINK N-01 ↔ N-03 · treated_by
t+1240 CANDIDATE queued → curator review
t+1244 DONE · 4 neurons · 3 trails · queue=1
```

## Scope

### v1 (this feature)

**Events wired to the existing pipelines:**
- `READ` — emit at start of `processPdfAsync` / `processDocxAsync` / `processPptxAsync` / `processXlsxAsync` with page/slide/sheet count + byte size.
- `PARSE` — emit after the extractor returns; carries `tokensExtracted` (estimated via existing chunker's token-counter).
- `COMPILE` — emit from the MCP `write` tool's `ingest-summary`/`ingest-page-update` paths, one per Neuron written.
- `CANDIDATE` — emit per candidate entering the queue with status (pending/auto-approved).
- `DONE` — emit at `triggerIngest`'s end-of-pipeline moment with summary counts.
- `ERROR` — emit on caught failures with a short message.

**Events deferred to v2:**
- `EXTRACT entities → N candidates` — requires a separate LLM pass before compile; out of scope for v1, compile-itself already creates candidates so the signal partially exists.
- `LINK` — backlink-extractor already runs on `candidate_approved`; wiring it as a log line is a follow-up (F136.1).

**Admin surface:**
- Source card (in `apps/admin/src/panels/sources.tsx`) renders a collapsible log strip below the row when `doc.status === 'processing'`. Default expanded.
- New component `apps/admin/src/components/compile-log-card.tsx` hosts the log rendering + auto-scroll + event subscription.
- Events stream via the existing SSE endpoint (`/api/v1/stream`), filtered client-side to `docId === this.doc.id`.
- Monospace + dark-theme-friendly colours: `t+NNNN` in fg-subtle, step name in accent, payload in fg-muted.

**Out of scope for v1:**
- Side-drawer "scroll all the way right" layout (could be F136.2 — v1 fits in the card).
- Retry-from-log interactions (tap a step to re-run).
- Downloadable log export.
- Cross-session persistence of logs (logs live only in-memory on the client; a refresh mid-ingest picks up from the next event).

## Technical Design

### Event shape (add to `@trail/shared`)

```ts
export type CompileLogStep =
  | 'read' | 'parse' | 'extract'
  | 'compile' | 'link' | 'candidate'
  | 'done' | 'error';

export interface CompileLogEvent {
  type: 'compile_log';
  tenantId: string;
  kbId: string;
  docId: string;          // source doc being ingested
  step: CompileLogStep;
  at: number;              // unix-ms, client computes `t+NNNN` = at − firstAt
  message: string;         // 1-line human-readable payload
  meta?: Record<string, unknown>; // optional structured fields
}
```

Added to the existing `TrailEvent` union in `packages/shared/src/events.ts`.

### Server — emit at each pipeline stage

`apps/server/src/services/broadcast.ts` is the existing SSE bus. Each pipeline call-site grows a small emit-wrapper:

```ts
function logStep(docId: string, step: CompileLogStep, message: string, meta?: Record<string, unknown>) {
  broadcaster.emit({
    type: 'compile_log',
    tenantId, kbId, docId,
    step, message, meta,
    at: Date.now(),
  });
}
```

Wired at:
- `apps/server/src/routes/uploads.ts` → start of each `process{Pdf,Docx,Pptx,Xlsx}Async` (READ, PARSE, DONE or ERROR).
- `apps/server/src/services/ingest.ts` → start + at candidate_created subscription (COMPILE, CANDIDATE, DONE).
- `apps/server/src/services/reference-extractor.ts` + `backlink-extractor.ts` — only if we include LINK in v1; likely deferred.

### Client — CompileLogCard component

```tsx
interface Props {
  docId: string;
  open: boolean;
  onToggle?: () => void;
}

export function CompileLogCard({ docId, open, onToggle }: Props) {
  const [events, setEvents] = useState<CompileLogEvent[]>([]);
  const [firstAt, setFirstAt] = useState<number | null>(null);
  useEvents((e) => {
    if (e.type !== 'compile_log' || e.docId !== docId) return;
    setEvents(prev => [...prev, e]);
    if (firstAt === null) setFirstAt(e.at);
  });
  // auto-scroll-to-bottom unless user scrolled up mid-stream
  const listRef = useRef<HTMLDivElement>(null);
  // ... render monospace list of events, colour-coded per step
}
```

Sits in `sources.tsx` row-body when `doc.status === 'processing'`, replacing or augmenting the current `<ProcessingIndicator>`. Collapsible via a `▼`/`▶` toggle; remembers state per-docId in a component-local Map (no URL / localStorage persistence).

### Visual tokens

- `t+NNNN` prefix: `font-mono text-[10px] text-[color:var(--color-fg-subtle)]`
- Step name: `font-mono uppercase tracking-wider text-[10px]` with per-step colours:
  - `READ` / `PARSE`: accent (peach)
  - `EXTRACT`: cyan
  - `COMPILE`: violet (matches F99 hub colour — same "structural" mental category)
  - `LINK`: fg-muted
  - `CANDIDATE`: success green
  - `DONE`: bright success
  - `ERROR`: danger
- Payload: `text-xs text-[color:var(--color-fg-muted)]` with selective bolding on IDs (`N-01`, `doc_abc123`)

Card bg slightly darker than row bg for visual nesting (`bg-[color:var(--color-bg)]/60` if existing tokens allow, otherwise a token addition).

### Accessibility

- Log list is a `<ul role="log" aria-live="polite">` — screen readers announce new entries as they stream.
- Step name is not colour-only; the text prefix (READ/PARSE/COMPILE) carries the semantic.

## Impact Analysis

### Files affected

**New:**
- `apps/admin/src/components/compile-log-card.tsx` — the hosting component.
- `packages/shared/src/compile-log.ts` — event type + step enum.

**Modified:**
- `packages/shared/src/events.ts` — union extension.
- `packages/shared/src/index.ts` — re-export new types.
- `apps/server/src/routes/uploads.ts` — emit READ/PARSE/DONE per pipeline.
- `apps/server/src/services/ingest.ts` — emit COMPILE per MCP write + DONE at end.
- `apps/server/src/routes/queue.ts` — emit CANDIDATE when `ingest-*` kind candidates land.
- `apps/admin/src/panels/sources.tsx` — swap `<ProcessingIndicator>` with `<CompileLogCard>` when status=processing.
- `apps/admin/src/locales/{en,da}.json` — step labels, toggle hints.

**No change:**
- DB schema. Events are ephemeral SSE — not persisted.
- MCP server. Compile happens client-side of MCP (the subprocess's writes trigger existing handlers).

### Downstream dependents

- Chat widget / CMS connector: unaffected (they don't consume compile_log events).
- Mobile hooks, Peer intercom: unaffected.
- The new event type in the union means any exhaustive switch on `TrailEvent` needs a new case — TypeScript flags those at compile time.

### Blast radius

Low. The event is additive; SSE consumers that don't know about it just see an unknown `type` field and skip. The pipelines still run unchanged if event-emission fails silently (we wrap each emit in try-catch so a broken SSE doesn't break ingest).

### Breaking changes

None.

### Test plan

- Upload a PDF → log shows READ → PARSE → COMPILE (×N) → CANDIDATE (×N) → DONE.
- Upload a DOCX → same flow with docx labels.
- Upload a PPTX (new) → confirm pipeline emits READ + PARSE with slide count.
- Upload an XLSX (new) → confirm PARSE includes sheet count.
- Upload a file where compile fails mid-flow → last entry is `ERROR` with message; card stays open.
- Two parallel uploads → each card shows its own events, no cross-contamination.
- Hard refresh mid-ingest → new events picked up from the next emit (log history is lost but the subsequent events continue to stream).
- Collapse/expand toggle preserves state across SSE event arrivals.
- Auto-scroll: new events scroll to bottom; scrolling up pauses auto-scroll; scrolling back to bottom re-enables it.
- Screen reader: `aria-live="polite"` announces new entries.

## Implementation Steps

1. Add `CompileLogEvent` type to `@trail/shared`.
2. Add `broadcastCompileLog()` helper in `apps/server/src/services/broadcast.ts` wrapping broadcaster.emit with try-catch.
3. Wire emits into the four `processXAsync` helpers in uploads.ts + the ingest service at relevant points.
4. Emit CANDIDATE events from queue.ts when `ingest-summary` / `ingest-page-update` kinds land.
5. Build `CompileLogCard` component with useEvents subscription + auto-scroll + step-colour rendering.
6. Integrate into `sources.tsx` — replace `<ProcessingIndicator>` for `status === 'processing'` rows.
7. Add i18n keys for step labels in en + da.
8. Typecheck pass across workspaces.
9. Manual walk-through of test plan above; record a demo upload that shows the full log sequence (useful for README / landing-site demo).

## Dependencies

- F87 SSE event stream (done — provides the transport).
- PPTX + XLSX pipelines (done in the preceding feature batch — the log reflects what they emit).
- F99 graph (done — same tenant-scoped event bus; no conflict).

## Unlocks

- Onboarding's hero-animation truth: "look, we showed this in your signup — here's the same thing happening to YOUR source right now."
- Debug path for stuck ingests: the last event tells curator exactly where pipeline hung.
- F136.1 (LINK event emission) becomes trivial once the transport is live.
- F136.2 (side-drawer layout) is a CSS-only refactor of the same component.

## Effort Estimate

**Medium — 1.5 days focused.** Breakdown:
- 3 hours: event type + SSE emit wiring (server-side, 4 pipelines + ingest + candidate emits).
- 4 hours: CompileLogCard component (subscription, render, auto-scroll, colour mapping, i18n, aria).
- 2 hours: sources.tsx integration + tests + visual polish.
- 2 hours: manual walk-through + screen recording for the demo/landing reference.

## Open decisions (to resolve before implementation)

1. **v1 vs side-drawer layout:** Christian's idea was "a frække scroll helt til højre" as an alternative to in-card placement. In-card is simpler and fits existing source-panel affordances; drawer is prettier but adds a second panel state to manage. Recommend v1 in-card; bump drawer to F136.2.
2. **Event persistence:** A reload mid-ingest drops the log history. Acceptable for v1 (the ingest continues and new events stream). If it becomes a real pain point, add a small `compile_log_events` table (ephemeral, TTL'd after DONE) — F136.3.
3. **LINK event timing:** emit from the backlink-extractor's finish or per-link? Per-link reads like the onboarding animation but floods the log on high-connectivity docs. Default: one LINK line per doc ("3 backlinks written"), detail in meta.
