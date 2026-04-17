# F89 — Chat Tools

> The chat LLM can only answer from retrieved wiki context today. It can't count, it can't enumerate, it can't introspect the Trail's own state — so simple factual questions like "Hvor mange Neurons har jeg?" fail with "Jeg kan ikke besvare det…". Give the chat a small tool kit that exposes the Trail's structure directly so it can answer metadata questions without hallucinating.

## Problem

Current chat flow (F13):

1. Retrieve via FTS5 against document content.
2. Stuff the top-N chunks into a system prompt.
3. Ask Claude to answer from ONLY that context.

This is a pure RAG shape. It works for "What is NADA?" because the answer is in a source. It *fails* by design for:

- **Counting** — "How many Neurons do I have?" FTS doesn't retrieve structure.
- **Enumeration** — "List all concept pages I have on stress." FTS retrieves fragments, not the list.
- **Queue introspection** — "How many candidates are pending review?"
- **Source-level questions** — "Which PDF did the NADA claim come from?"
- **Coverage gaps** — "Do I have anything on fermentation process timing?"
- **Navigation** — "Which Neuron cites this source?"

When the LLM is told "answer only from context" and the context doesn't contain the answer, it refuses honestly (correct per the system prompt). But the user is asking a question the *system* could answer if it had access to the right tool.

Concrete example from today's testing — a user asked *"Hvor mange neuroner er det i min trail?"* and got:

> Jeg kan ikke besvare det spørgsmål ud fra det wiki-indhold, der er leveret. Det wiki-materiale, som jeg har adgang til, handler udelukkende om øreakupunktur og gamle nordiske fermenteringsopskrifter…

The answer is 18. The LLM couldn't produce it because the number doesn't live in any Neuron's body — it lives in the database, as the COUNT(\*) of a specific query.

## Solution

Add a small set of **typed chat tools** that the engine binds to the chat LLM as Anthropic-style tool definitions. When the user's question is answerable via a tool call (counting, listing, searching structure), the LLM decides to call the tool, the engine runs it against the DB, and the LLM composes a natural answer from the structured result.

This sits at the boundary between *content retrieval* (existing RAG) and *structural retrieval* (new tools). Both flow into the same chat turn; the LLM picks which to use based on the question.

## Proposed tool set (v1)

| Tool | Signature | What it returns |
|---|---|---|
| `count_neurons` | `(path_prefix?, tag?)` | integer count, with optional filter by path like `/neurons/concepts/` or tag like `stress` |
| `count_sources` | `(file_type?)` | integer count, optional filter by extension (`pdf`, `docx`) |
| `list_neurons` | `(path_prefix?, limit?, tag?)` | array of `{title, filename, path, updatedAt, tags[]}` |
| `list_sources` | `(file_type?, limit?)` | array of `{title, filename, fileType, pageCount, fileSize, status}` |
| `get_neuron` | `(slug)` | full content + metadata of a named Neuron |
| `search_neurons` | `(query, limit?)` | FTS5 hits as title + snippet + path — same engine as the `/search` route, wrapped as a tool |
| `queue_summary` | `()` | `{pending, approved, rejected, byKind: {…}}` for the current Trail |
| `recent_activity` | `(limit?)` | last N wiki_events (create/edit/archive) with timestamps — "what's been happening?" |
| `neuron_citations` | `(slug)` | which Sources this Neuron cites, and which other Neurons cite it |
| `trail_stats` | `()` | `{neuronCount, sourceCount, claimCount, contradictionCount, oldestNeuron, newestNeuron, totalWords}` — one-shot overview |
| `find_orphans` | `()` | runs F32.1 orphan detector on demand, returns structured findings |
| `gap_scan` | `(topic)` | LLM-aided: "Do I have anything on <topic>?" — combines FTS + an explicit "not found" path when nothing meaningful hits |

All tools are **read-only**. Write operations go through the Curation Queue (F17) via the existing MCP `write` tool, not via chat — the separation between "interrogate the Trail" and "modify the Trail" is worth preserving.

## Transport

Use Anthropic's native tool-use API. Each tool becomes a tool definition in the request:

```ts
{
  name: 'count_neurons',
  description: 'Count wiki pages (Neurons) in the current Trail...',
  input_schema: { type: 'object', properties: { path_prefix: { type: 'string' }, tag: { type: 'string' } } },
}
```

Claude decides when to call a tool, the engine runs it, the result loops back as a tool_result content block, and Claude produces the final answer. Standard agentic pattern, well-supported by the SDK and the `-p` CLI.

The existing `TRAIL_CHAT_BACKEND=api` path hits the Anthropic API directly — tool use fits there. The `claude -p` CLI path also supports tools via `--allowedTools` + MCP bindings, so chat can fall back on Max-plan subscription like everything else.

## Impact Analysis

### Files affected

- New: `apps/server/src/services/chat-tools/` — one file per tool, each exporting a typed handler + JSON schema.
- New: `apps/server/src/services/chat-tools/index.ts` — registers the tools and dispatches calls.
- Modify: `apps/server/src/routes/chat.ts` — include tool definitions in the request, loop on `tool_use` stop-reason, feed `tool_result` blocks back.
- No admin changes. The existing ChatPanel just sends the question; the richer answers come through naturally.

### Downstream dependents

- Buddy F39: new tool `neuron_citations` unlocks the contradiction-alert follow-up — "which Neurons reference this retracted source?"
- F32.2 future: when the LLM asks `find_orphans`, we get automation-friendly structured output of lint findings, not just markdown.
- Future embed-widget (F27): the same tool kit makes a website chat widget answer questions about the Trail's structure, not just its text.

### Blast radius

Low. Adding tools is additive. The LLM gracefully degrades if a tool fails (returns error in tool_result, Claude composes around it). Existing answers that don't need tools behave identically.

### Breaking changes

None.

### Test plan

- "Hvor mange Neurons?" → calls `count_neurons`, answers with real number.
- "List all concept pages" → calls `list_neurons(path_prefix="/neurons/concepts/")`, renders titles.
- "Which source did X claim come from?" → calls `neuron_citations(slug=X)`, answers with source filename.
- "How many candidates pending?" → calls `queue_summary`, answers with count.
- "What's new this week?" → calls `recent_activity`, narrates last N events.
- Content question ("What is NADA?") → no tool call, pure RAG as today.

## Implementation Steps

1. Define the tool contract in `@trail/shared` — `ChatToolDefinition`, input/output schemas per tool.
2. Implement handlers in `apps/server/src/services/chat-tools/` — one file per tool, each handler `(trail, tenantId, kbId, args) => result`.
3. Hook into the Anthropic API call in `routes/chat.ts`: send tool definitions, loop on `tool_use`, execute, feed `tool_result` back.
4. Claude CLI path: wire same tools as MCP-exposed tools so `claude -p --allowedTools` can reach them.
5. Smoke test against the examples above.
6. Add a "show tool calls" toggle in ChatPanel that reveals which tools were used — helpful for curator trust + debugging.

## Dependencies

- F13 Chat (done — extends the existing chat route).
- F10 FTS5 + F87 event stream (leverage existing data surfaces).

## Effort Estimate

**Medium** — 2-3 days to ship the full v1 tool set with tests. Per-tool work is ~30-60 min once the dispatch loop is in place.

## Unlocks

- Chat goes from "RAG over content" to "agent over the Trail" — lets the user interrogate metadata, coverage, structure, history.
- Future F90 "reports" — scheduled digests powered by the same tools ("your weekly Trail summary: 4 new Neurons, 12 candidates reviewed, 1 contradiction…").
- Makes the chat a plausible first-class product surface, not just a reader.

## Design principles

- **Read-only**: no tool mutates state. Writes go through the Curation Queue via existing paths.
- **Tenant-scoped**: every tool handler receives `(tenantId, kbId)` from the auth context and filters accordingly.
- **Typed I/O**: all args and results are JSON-schema validated so the LLM can't send garbage and we can't leak raw DB rows.
- **Stable contracts**: adding a tool is safe; renaming or reshaping one breaks clients and needs versioning.
- **Cheap by default**: every tool is a single indexed SQL query or an FTS5 lookup. No tool takes seconds to run.
