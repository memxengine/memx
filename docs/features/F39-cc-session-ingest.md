# F39 — Claude Code Session → Trail Ingest

> Every productive Claude Code session generates architectural decisions, bug-fix reasoning, and domain insights that evaporate when the context window closes. This feature feeds session knowledge into Trail so it compounds instead of vanishing.

## Problem

A typical cc session produces 10-50k tokens of reasoning: why a design was chosen, what was tried and rejected, what conventions were established, how a bug was diagnosed. Today that knowledge lives in two places:

1. **Git commits** — capture *what* changed, not *why* or *what was considered and rejected*.
2. **Claude Code's conversation** — ephemeral; lost on `/exit` or context compaction. Even with `/compact`, the nuance is gone.

This is exactly the problem Trail solves for other knowledge domains (clinical notes, research papers). cc sessions are just another source type — high-signal, high-volume, already structured (turns with tool calls and reasoning).

The building blocks already exist:
- **Buddy** (`/webhousecode/buddy`) watches every cc session, sees diffs + responses, can extract structured data
- **Trail's ingest API** (F06) accepts sources via upload or POST
- **Curation Queue** (F17) routes candidates through approval (auto or manual)
- **MCP** (F11) — buddy and Trail both speak MCP; buddy can call Trail tools directly

What's missing is the extraction + routing pipeline that connects them.

## Solution

Buddy gains a **session summariser** that runs at natural breakpoints (session end, `/compact`, or on-demand via `/trail-save`). The summariser extracts knowledge artifacts from the session — decisions, patterns, rejected approaches, conventions established — and POST's them to Trail as source candidates. Trail's standard compile pipeline turns them into wiki pages that link to the codebase, the git history, and other sessions.

This is **not** verbatim chat logging (that's MemPalace's approach). This is compile-at-ingest: the summariser distills, Trail integrates.

## Technical Design

### Extraction pipeline (buddy-side)

Buddy already has session context (repo, turns, diffs, tool calls). At a trigger point, buddy:

1. **Collects session material**: full conversation or last N turns since last extraction.
2. **Runs a summariser prompt** (via Claude API or claude -p) that extracts structured artifacts:

```typescript
interface SessionArtifact {
  kind: 'decision' | 'convention' | 'bug-fix' | 'architecture' | 'rejected-approach' | 'discovery';
  title: string;          // e.g. "F17: Queue is the sole wiki write path"
  summary: string;        // 2-3 sentence distillation
  detail: string;         // full markdown with code snippets, file refs
  repo: string;           // e.g. "broberg-ai/trail"
  files: string[];        // affected file paths
  tags: string[];         // auto-extracted: feature numbers, package names, concepts
  sessionId: string;      // buddy session ID for provenance
  confidence: number;     // 0-1: how "knowledge-worthy" vs ephemeral
}
```

3. **Filters**: skip low-confidence artifacts (typo fixes, routine git ops, failed attempts that led nowhere). Keep decisions, conventions, non-obvious bug diagnoses, architecture choices.

### Routing to Trail (buddy → trail engine)

Trail exposes three transports. They look superficially similar but have distinct audiences — mixing them up leads to pipelines that work but in the wrong shape. Pick by **who is making the decision to write**:

| Transport | Audience | Right for |
|---|---|---|
| **HTTP API** (`POST /api/v1/queue/candidates`) | Deterministic code, services, webhooks, CLIs | Buddy's extractor, admin uploads, ingest pipelines |
| **MCP `write` tool** (`apps/mcp/src/index.ts`) | LLMs deciding mid-reasoning-turn | Trail's own ingest agent authoring compiled wiki pages; cc agents in the middle of a turn who *decide* to save an insight |
| **Buddy's peer MCP** (`ask_peer`, `announce`) | cc-session ↔ cc-session only | Coordination between agents ("I'm about to merge X, heads up"). **Never** a payload transport for ingest; never programmatic. |

For F39 specifically, buddy's session-end summariser is a deterministic Stop-hook pipeline — not an LLM making a call during reasoning. That makes **HTTP API the canonical path**. MCP would couple buddy's background runtime to an ephemeral cc-session lifecycle (the session is already dead when the hook fires), and peer is architecturally the wrong layer for a wiki-page-sized payload.

**The write surface (shared across transports):**
```
POST /api/v1/queue/candidates
Authorization: Bearer <TRAIL_INGEST_TOKEN>
{
  knowledgeBaseId: "<buddy-repo-kb>",
  kind: "external-feed",
  title: artifact.title,
  content: artifact.detail,
  metadata: JSON.stringify({
    op: "create",
    filename: slugify(artifact.title) + ".md",
    path: `/wiki/sessions/${artifact.repo}/`,
    tags: artifact.tags.join(","),
    source: "buddy",
    sessionId: artifact.sessionId,
  }),
  confidence: artifact.confidence,
}
```

The MCP `write` tool internally calls the same `createCandidate` core (`packages/core/src/queue/candidates.ts`), so the two surfaces converge at the same invariant — queue is the sole write path (F17). They differ only in auth and calling convention.

**READ vs WRITE split in v1**: buddy's cc-sessions *do* load Trail's MCP — but only for `guide` / `search` / `read`. They don't use MCP `write` for ingest. That keeps the write path programmatic, testable, and decoupled from cc lifecycles.

### Trigger points

| Trigger | How | When |
|---|---|---|
| Session end | Buddy's `on_session_close` hook | Every `/exit` or timeout |
| Context compaction | Buddy detects `/compact` event | Before context is lost |
| Manual | User types `/trail-save` | On demand during session |
| Periodic | Buddy's turn-counter (every N turns) | Background, configurable |

### Knowledge base structure

Dedicated KB per repo (or one shared "session-knowledge" KB):

```
KB: trail-sessions
  /wiki/sessions/broberg-ai/trail/
    f17-queue-sole-write-path.md
    svg-shortcode-tiptap-workaround.md
    trail-vs-notebooklm-positioning.md
  /wiki/sessions/webhousecode/cms/
    svg-embed-node-view.md
    shortcode-expander-api.md
  /wiki/conventions/
    trail-capitalization-in-prose.md
    browser-refresh-exception.md
```

### Relationship to existing memory

Today Claude Code has `~/.claude/projects/<path>/memory/` with markdown files. Trail session ingest is the **compiled, cross-referenced, searchable** version of that same information. The two coexist:

- **Memory files**: fast per-session recall, no compilation, no cross-referencing
- **Trail wiki**: compiled across sessions, cross-referenced, searchable, curated

Over time, Trail's wiki becomes the authoritative source and memory files become the "hot cache" that bootstraps new sessions before they query Trail.

### Integration with F36 (docs.trailmem.com)

Session artifacts for the trail repo itself feed into the `trailwiki` tenant at `docs.trailmem.com`. The docs brain doesn't just contain the markdown docs — it also contains the reasoning behind every decision, extracted from the sessions that built the engine. That's a unique selling point: "our docs include the why, not just the what."

## Impact Analysis

### Files affected

**In `webhousecode/buddy`:**
- New: `src/extractors/session-summariser.ts` — the extraction prompt + artifact parser
- New: `src/integrations/trail-ingest.ts` — HTTP client for Trail's candidate API
- Modify: `src/session-manager.ts` — add trigger hooks (on_close, on_compact, periodic)
- New: `src/commands/trail-save.ts` — `/trail-save` slash command

**In `broberg-ai/trail`:**
- No engine changes needed — F17's candidate API + auto-approve policy already handle external-feed candidates. May add `'cc-session'` to the candidate kind enum for better filtering.

### Downstream dependents

- Buddy's existing session-watch hooks are additive — no breaking changes to flag/review flow.
- Trail's queue handles new candidate kinds without migration (the 12-kind enum already includes `external-feed`).

### Blast radius

Low. Buddy's extraction is async and best-effort — if it fails, the session still works normally. Trail candidates enter the queue like any other source; curator reviews or auto-approve handles quality.

### Breaking changes

None. Pure addition.

### Test plan

- [ ] `/trail-save` during a session → candidate appears in Trail queue within 30s
- [ ] Session end → extraction runs, 1-5 artifacts posted depending on session length
- [ ] Artifact content includes file paths, feature numbers, code snippets where relevant
- [ ] Low-confidence artifacts (routine git ops) are filtered out
- [ ] Duplicate detection: re-running extraction on the same session doesn't create duplicates
- [ ] Trail wiki page compiled from session artifact cross-references related wiki pages
- [ ] Regression: buddy flag/review flow unaffected

## Implementation Steps

1. Add `'cc-session'` to `QueueCandidateKindEnum` in `@trail/shared` (optional — `external-feed` works today).
2. Write the summariser prompt in buddy (extracts SessionArtifact[] from conversation turns).
3. Write the Trail HTTP client in buddy (POST to /api/v1/queue/candidates with service token).
4. Wire trigger hooks in buddy's session manager.
5. Implement `/trail-save` command.
6. Test with a real session → verify artifacts appear in Trail queue.
7. Auto-approve policy: decide whether cc-session candidates auto-approve (trusted source) or require review.
8. Set up the `trail-sessions` KB in the trailwiki tenant.

## Dependencies

- F17 Curation Queue API (candidate endpoint — **done**)
- F33 Fly.io Deploy (Trail needs to be reachable for buddy to POST — OR buddy calls localhost during dev)
- Buddy's session-watch infrastructure (already exists)

Unlocks: F36 (docs brain gets session reasoning), F54 (curator analytics can show "what did cc sessions teach us this week"), and a compelling demo: "Trail doesn't just compile documents — it compiles the thinking behind your code."

## Effort Estimate

**Medium** — 5-7 days. Buddy extraction prompt tuning is the variable; the plumbing (HTTP client, trigger hooks) is straightforward.

## The MemPalace contrast

MemPalace stores conversations verbatim and retrieves via semantic search. Trail compiles sessions into integrated wiki pages with cross-references. The difference:

- MemPalace: "what did I say about X?" → retrieves the conversation fragment
- Trail: "what do we know about X?" → reads a compiled page that synthesizes insights from 12 sessions, 3 docs, and 2 bug reports into a coherent narrative

Both are valuable. They're not competitors — they're different layers of the same memory stack.
