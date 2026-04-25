# F159 — Pluggable Chat Backends

> Mirror F149's pluggable ingest pattern, applied to the chat route. Abstract `apps/server/src/routes/chat.ts` behind a `ChatBackend` interface with two live implementations — `ClaudeCLIBackend` (current behaviour, default for dev / Max-Plan-equipped Macs) and `OpenRouterBackend` (production path: Gemini Flash / GLM / Qwen / Claude Sonnet via API, no `claude` binary required). Per-tenant + per-KB backend selection, fallback chain on backend failure, F151 cost-tracking integration, and F156 credit-burn integration. Tier: all tenants. Effort: Medium — 4-6 days. Status: Planned.

## Problem

Chat is the user-facing complement to ingest. Both today share the same fundamental architecture: spawn `claude -p` as a subprocess, hand it a prompt + the trail MCP for tool use, parse the response. F149 fixed this for ingest by introducing pluggable backends — chat was left untouched. The cost is now visible: a chat route that breaks the moment the host environment lacks the `claude` CLI.

Two concrete failure modes already observed in this session (2026-04-25):

1. **Production is impossible.** F33 (Fly.io deploy) and any Docker/Kubernetes target has no `claude` binary on disk. The chat route would 500 on every request post-deploy. We literally cannot ship Trail to a production environment with chat working — `Failed to spawn claude: Executable not found in $PATH: 'claude'` is what every customer would see.
2. **Local PATH brittleness.** Caught earlier this session: when the trail server is restarted via Code Launcher API (or systemd, or any spawn that doesn't inherit the user's login shell), `claude` isn't on PATH and chat fails immediately. Workaround was hardcoding `CLAUDE_BIN=/Users/cb/.local/bin/claude` in `.env`. That's a bandage — the structural fix is to not need a CLI at all in production.

A third symptom — not user-facing yet but design-level — is **vendor lock-in**. Today every chat answer goes through Claude. Once F156 (credits-based billing) ships and customers pay for their LLM consumption, they should be able to choose: Gemini Flash for cheap-and-fast, Claude for premium reasoning, with the curator picking the trade-off per Trail. Hardcoding Claude removes the user's choice and leaves money on the table.

## Secondary Pain Points

- **No fallback when Claude rate-limits.** A single 429 from Anthropic kills the chat session. F149 already solved this for ingest with a chain-resolution mechanism that retries against the next backend mid-job; chat needs the same.
- **No cost visibility.** F151's Cost & Quality dashboard tracks ingest cost per Source. Chat questions cost real money too (especially with tool-use round-trips that spawn 5+ MCP calls per answer); right now they vanish into Claude Max's flat fee with no per-tenant attribution. F156 credit metering needs chat to be a cost-emitting backend, same as ingest.
- **Tool-use locked to Claude.** The trail MCP (`mcp__trail__{guide, search, read, count_neurons, ...}`) is exposed via `--mcp-config` to `claude -p`. OpenRouter-style models support OpenAI-compatible function calling but not the MCP wire protocol; we'd lose tool-use entirely on the OpenRouter path unless we wrap the MCP tools in a function-calling adapter.
- **Same-pattern duplication.** F149 already designed and shipped `IngestBackend` / `resolveIngestChain` / `runner.ts`. Chat re-implementing the same ideas from scratch would be waste; the cleanest path is to lift the pattern verbatim and parameterise it on the chat-specific concerns (response shape, max-turn budget, single-message vs. multi-turn-history input).
- **Multi-turn memory (F144) is now correct but stuck on the CLI path.** Earlier this session we fixed chat to replay `chat_turns` history into the prompt. Both backends need to consume that history — the API path takes it as a `messages: [...]` array (richer), the CLI path inlines it as a transcript. The pluggable design needs to express that cleanly.

## Solution

Lift F149's exact architecture — interface + factory + chain-resolution + runner — into a parallel `apps/server/src/services/chat/` directory. Two implementations:

- **`ClaudeCLIBackend`**: current `spawnClaude --mcp-config` behaviour, unchanged. Default in dev when `CLAUDE_BIN` resolves; default for tenants whose `chat_backend` column says `claude-cli`.
- **`OpenRouterBackend`**: HTTPS to OpenRouter (or directly to Anthropic / OpenAI / Google when we want to bypass), uses OpenAI-compatible function calling, exposes the trail MCP tools as `tools: [...]` array via a thin in-process adapter (`mcpToolsToFunctionSpecs()` already exists for ingest's OpenRouter path — reuse).

Per-KB column `chat_backend` + `chat_model` + `chat_fallback_chain` mirror F149's ingest columns (single migration adds them to `knowledge_bases`). Default chain: `[ClaudeCLI/sonnet, OpenRouter/Gemini-Flash, OpenRouter/Claude-Sonnet]` so a Claude rate-limit silently retries on Flash, with a final Claude-via-OpenRouter as ultimate fallback (Anthropic's quota is independent of the user's Max account when accessed through API). Cost stamping into `chat_turns.cost_cents` per turn lights up F151's chat-cost view; F156 credit-burn just queries the same column.

## Non-Goals

- **Streaming token-by-token responses to the admin.** Both backends today return a final answer; chat doesn't stream. Streaming is a separate feature — meaningful UX improvement, but orthogonal to "make chat work in prod." Defer.
- **Voice-mode integration with backend choice.** F157's iOS voice-chat hits the same `/api/v1/chat` endpoint; it just inherits whichever backend is configured. The iOS app does NOT need a backend picker.
- **Replacing the trail MCP server with a pure HTTP tool dispatcher.** OpenRouter backend will adapt MCP-tool-calls → in-process tool-call → MCP-result-back. The MCP server itself stays as a process that the CLI backend talks to. Rewriting MCP as HTTP is a bigger refactor; the in-process adapter is the smaller bridge.
- **Per-user backend selection.** Backend choice is per-KB (Trail-level) with tenant-level default. A user inside the same tenant's same KB always sees the same backend. Per-user override is unnecessary granularity.
- **Voting / consensus chat answers across backends.** Same call as F149: interesting but out of scope.
- **Auto-tuning the fallback chain based on observed quality.** F151's Cost & Quality dashboard gives the data; manual chain edits via F152's runtime model switcher (extended for chat in this feature) is the curator-controlled path. No autopilot.
- **Replacing the F89 `--mcp-config` chat-tools with their content-search-only equivalents in OpenRouter mode.** Both backends expose the same 8 trail tools; OpenRouter backend converts MCP tool-defs into OpenAI function-specs at runtime. Tool-use parity is the test.
- **Claude direct API as a separate backend (vs. via OpenRouter).** OpenRouter routes to Claude Sonnet at near-direct prices ($3/M in / $15/M out vs. Anthropic's $3/$15) and gives us one less SDK. If a Claude-API-direct path becomes valuable later, the interface already supports it — drop in a `ClaudeAPIBackend` class.

## Technical Design

### Interface

New file `apps/server/src/services/chat/backend.ts` — direct mirror of F149's `services/ingest/backend.ts`:

```typescript
export type ChatBackendId = 'claude-cli' | 'openrouter';

export interface ChatBackendInput {
  systemPrompt: string;
  userMessage: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>; // F144
  model: string;
  maxTurns: number;
  timeoutMs: number;
  tenantId: string;
  knowledgeBaseId: string;
  /** Path to the trail MCP server entrypoint (CLI backend) or
   *  the in-process tool dispatcher (OpenRouter backend). */
  mcpServerPath: string;
  toolNames: string[];
}

export interface ChatBackendResult {
  answer: string;
  /** Sub-cents tracked at OpenRouter granularity; null for Claude-CLI
   *  (Max-Plan flat fee — no per-call cost). */
  costCents: number | null;
  /** Which backend + model actually produced the answer (after any
   *  in-chain fallbacks). */
  backendUsed: ChatBackendId;
  modelUsed: string;
  /** How many backend steps were attempted before success. */
  stepsAttempted: number;
  /** Wall-clock from chat-route entry to answer-ready. */
  elapsedMs: number;
}

export interface ChatBackend {
  readonly id: ChatBackendId;
  run(input: ChatBackendInput): Promise<ChatBackendResult>;
}
```

### Factory + chain resolution

`apps/server/src/services/chat/index.ts`:

```typescript
export async function createChatBackend(id: ChatBackendId): Promise<ChatBackend> {
  switch (id) {
    case 'claude-cli': {
      const { ClaudeCLIChatBackend } = await import('./claude-cli-backend.js');
      return new ClaudeCLIChatBackend();
    }
    case 'openrouter': {
      const { OpenRouterChatBackend } = await import('./openrouter-backend.js');
      return new OpenRouterChatBackend();
    }
  }
}
```

`apps/server/src/services/chat/chain.ts` mirrors `ingest/chain.ts` exactly — `resolveChatChain(kb, env): ChainStep[]`. Precedence:

1. `knowledge_bases.chat_fallback_chain` JSON column (curator override via F152 UI).
2. Synthesized from `knowledge_bases.chat_backend` + `chat_model`.
3. `process.env.CHAT_BACKEND` + `CHAT_MODEL`.
4. Hardcoded defaults: `[{backend:'claude-cli', model:env.CHAT_MODEL ?? 'claude-haiku-4-5-20251001'}, {backend:'openrouter', model:'google/gemini-2.5-flash'}]`.

### Runner

`apps/server/src/services/chat/runner.ts` — direct lift of F149's `runner.ts` shape, simpler because chat is single-message-out-single-message-in:

```typescript
export async function runChat(input: Omit<ChatBackendInput, never>): Promise<ChatBackendResult> {
  const chain = resolveChatChain(input.kb, process.env);
  let lastError: unknown;
  for (let i = 0; i < chain.length; i++) {
    const step = chain[i]!;
    try {
      const backend = await createChatBackend(step.backend);
      const result = await backend.run({ ...input, model: step.model });
      return { ...result, stepsAttempted: i + 1 };
    } catch (err) {
      lastError = err;
      if (!isFallbackEligible(err)) throw err; // hard errors don't fall through
    }
  }
  throw new Error(`All ${chain.length} chat backends failed: ${stringifyErr(lastError)}`);
}
```

`isFallbackEligible(err)` returns true for: rate-limit (429), 5xx, network/connection errors, "claude binary not found", model-context-overflow. Returns false for: 4xx user-error (bad token, validation), refusal (content-policy), or the user-cancelled their request.

### `ClaudeCLIChatBackend`

Lift the existing `chat.ts:159-235` (the `spawnClaude` call + MCP config + stdin/stdout parsing) into the class verbatim. This is the safe move — the path that works today on dev becomes the first-step default with zero behaviour change.

```typescript
class ClaudeCLIChatBackend implements ChatBackend {
  readonly id = 'claude-cli';
  async run(input: ChatBackendInput): Promise<ChatBackendResult> {
    const prompt = buildCliPrompt(input.systemPrompt, input.history, input.userMessage);
    const args = ['-p', prompt, '--mcp-config', JSON.stringify(buildMcpConfig(input.mcpServerPath)),
                  '--allowedTools', input.toolNames.join(','), '--max-turns', String(input.maxTurns),
                  '--output-format', 'json', ...(input.model ? ['--model', input.model] : [])];
    const t0 = Date.now();
    const raw = await spawnClaude(args, { timeoutMs: input.timeoutMs, env: spawnEnv(input) });
    return { answer: extractAssistantText(raw), costCents: null,
             backendUsed: 'claude-cli', modelUsed: input.model,
             stepsAttempted: 1, elapsedMs: Date.now() - t0 };
  }
}
```

### `OpenRouterChatBackend`

The harder half. Reuses ingest's existing `apps/model-lab/src/server/openrouter.ts` (lifted to `apps/server/src/services/openrouter/` for ingest by F149). Key new piece: **MCP-tool-as-OpenAI-function adapter**.

```typescript
class OpenRouterChatBackend implements ChatBackend {
  readonly id = 'openrouter';
  async run(input: ChatBackendInput): Promise<ChatBackendResult> {
    const t0 = Date.now();
    const tools = await mcpToolsToFunctionSpecs(input.toolNames); // Trail MCP → OpenAI tools[] schema
    const messages: ChatMessage[] = [
      { role: 'system', content: input.systemPrompt },
      ...input.history,
      { role: 'user', content: input.userMessage },
    ];
    let cost = 0;
    for (let turn = 0; turn < input.maxTurns; turn++) {
      const response = await openrouterChat({
        model: input.model,
        messages,
        tools,
        apiKey: process.env.OPENROUTER_API_KEY!,
      });
      cost += dollarsToCents(response.usage.cost ?? 0);
      const choice = response.choices[0]!;
      if (choice.finish_reason === 'tool_calls') {
        // Dispatch each tool call against the in-process MCP equivalents.
        for (const toolCall of choice.message.tool_calls ?? []) {
          const result = await invokeTrailMcpTool(input.tenantId, input.knowledgeBaseId,
                                                  toolCall.function.name, JSON.parse(toolCall.function.arguments));
          messages.push({ role: 'assistant', tool_calls: [toolCall] });
          messages.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(result) });
        }
        continue;
      }
      // Final answer.
      return { answer: choice.message.content ?? '', costCents: cost,
               backendUsed: 'openrouter', modelUsed: input.model,
               stepsAttempted: 1, elapsedMs: Date.now() - t0 };
    }
    throw new Error(`OpenRouterChatBackend exceeded maxTurns=${input.maxTurns} without final answer`);
  }
}
```

`invokeTrailMcpTool()` is a thin in-process router that maps the 8 chat-allowed tool names (`mcp__trail__guide`, `mcp__trail__search`, etc.) to their handlers in `apps/mcp/src/`. We don't spawn the MCP subprocess from this backend — we call the same handler functions directly. Trail's MCP server is a thin Hono wrapper around per-tenant DB queries; lifting the handlers into a shared `packages/core/src/mcp-tools/` is a small refactor that benefits both this backend and any future cloud-LLM integration.

### Schema

Migration `0021_chat_backend_columns.sql` adds three columns to `knowledge_bases`:

```sql
ALTER TABLE knowledge_bases ADD COLUMN chat_backend TEXT;             -- 'claude-cli' | 'openrouter' | NULL (use env)
ALTER TABLE knowledge_bases ADD COLUMN chat_model TEXT;               -- model id, NULL = backend default
ALTER TABLE knowledge_bases ADD COLUMN chat_fallback_chain TEXT;      -- JSON: ChainStep[] | NULL
```

Plus one column on `chat_turns` (enables F151 chat-cost view + F156 credit-burn):

```sql
ALTER TABLE chat_turns ADD COLUMN cost_cents INTEGER;                 -- NULL for Claude-CLI (Max Plan)
ALTER TABLE chat_turns ADD COLUMN backend_used TEXT;                  -- 'claude-cli' | 'openrouter'
ALTER TABLE chat_turns ADD COLUMN model_used TEXT;                    -- actual model id
```

All additive; no breaking change.

### Route refactor

`apps/server/src/routes/chat.ts` shrinks dramatically — most of the LLM-spawning logic moves into the backends:

```typescript
chatRoutes.post('/chat', async (c) => {
  const trail = getTrail(c); const tenant = getTenant(c); const user = getUser(c);
  const body = ChatRequestSchema.parse(await c.req.json());
  const kbId = await resolveKbId(trail, tenant.id, body.knowledgeBaseId);
  const kb = await loadKb(trail, kbId, tenant.id);
  const { context, citations } = await retrieveContext(trail, body.message, [kbId], tenant.id);
  const priorTurns = body.sessionId
    ? await loadPriorTurns(trail, body.sessionId, tenant.id, CHAT_HISTORY_TURNS) : [];

  const result = await runChat({
    systemPrompt: buildSystemPrompt(kb, context),
    userMessage: body.message,
    history: priorTurns,
    kb,                                 // for chain resolution
    maxTurns: CHAT_MAX_TURNS,
    timeoutMs: CHAT_TIMEOUT_MS,
    tenantId: tenant.id,
    knowledgeBaseId: kbId,
    mcpServerPath: MCP_SERVER_PATH,
    toolNames: CHAT_ALLOWED_TOOL_LIST,
  });

  const sessionId = await persistTurnPair(/* ... */, result.costCents, result.backendUsed, result.modelUsed);
  return c.json({ answer: result.answer, citations, sessionId,
                  backend: result.backendUsed, model: result.modelUsed });
});
```

## Interface

**Public HTTP** — additive fields on existing `POST /api/v1/chat` response:

```jsonc
{
  "answer": "…",
  "citations": [/* unchanged */],
  "sessionId": "chs_…",
  "backend": "openrouter",                 // NEW — for transparency in the admin UI
  "model": "google/gemini-2.5-flash"       // NEW
}
```

Existing fields unchanged. Old admin clients that ignore `backend`/`model` continue to work.

**New PATCH route** for per-KB backend overrides (mirrors F149's `/ingest-settings`):

```
PATCH /api/v1/knowledge-bases/:kbId/chat-settings
Body: { chatBackend?: ChatBackendId | null, chatModel?: string | null,
        chatFallbackChain?: ChainStep[] | null }
Response: 200 with the updated effective chain.
```

**Env surface** (additive; no rename, no removal):

```
CHAT_BACKEND=claude-cli                   # default; override per-KB via PATCH route
CHAT_MODEL=claude-haiku-4-5-20251001      # already exists; meaning unchanged
OPENROUTER_API_KEY=sk-or-v1-...           # already in .env from F149
```

**Internal API** — exported from `@trail/core` (or a new `apps/server/src/services/chat/index.ts`):

```typescript
export interface ChatBackend { /* see above */ }
export function createChatBackend(id: ChatBackendId): Promise<ChatBackend>;
export function resolveChatChain(kb, env): ChainStep[];
export function runChat(input): Promise<ChatBackendResult>;
```

## Rollout

**Phase 1 — Interface + Claude-CLI lift (1 day)**. Extract `ClaudeCLIChatBackend` from `chat.ts` verbatim. `runChat()` returns the existing behaviour. `resolveChatChain()` returns a single-step chain matching today's defaults. Zero behaviour change visible to users; sets up the seam.

**Phase 2 — OpenRouter chat backend + MCP-tool adapter (2 days)**. Build `OpenRouterChatBackend` using lifted ingest plumbing + new `mcpToolsToFunctionSpecs()` adapter. End-to-end test: chat against Gemini Flash answers the same factual question with comparable correctness to Claude. **Verifiable kill-switch**: `CHAT_BACKEND=openrouter` env var routes 100% of chat through the new path.

**Phase 3 — Per-KB chain config + cost stamping (1 day)**. Migration 0021. PATCH `/chat-settings` route. `chat_turns.cost_cents` populated from OpenRouter `usage.cost` (Claude-CLI stays NULL for Max Plan). F151 chat-cost view becomes a SELECT on the new column.

**Phase 4 — Default chain flips (0.5 day, gated on Phase 2 quality verification)**. Default chain becomes `[claude-cli, openrouter:gemini-flash, openrouter:claude-sonnet]` so production deploys without `claude` CLI fall through to Gemini automatically. Christian's dev-machine still hits Claude CLI first. F33 (Fly.io deploy) becomes unblocked.

Each phase independently revertable: deleting the new files + restoring `chat.ts` returns to current behaviour. No DB migrations are destructive (only ADD COLUMN).

## Success Criteria

1. **Production parity**: a fresh server with `CLAUDE_BIN` deliberately unset answers a chat question successfully via OpenRouter Gemini Flash within 8 seconds. This is the F33-deploy-unblock criterion.
2. **Tool-use parity**: a structural question that requires the trail MCP (e.g. "how many Neurons in this Trail?") returns the correct numeric answer via BOTH backends. Asserts the `mcpToolsToFunctionSpecs` adapter is faithful.
3. **Fallback works mid-request**: with the chain `[openrouter:nonexistent-model, openrouter:gemini-flash]` configured, the runner advances to step 2 transparently and the user gets a working answer; the response includes `backend: 'openrouter', model: 'google/gemini-2.5-flash'` and `stepsAttempted: 2`.
4. **Cost stamping accuracy**: an OpenRouter chat turn writes a non-NULL `cost_cents` value within ±1 cent of the OpenRouter dashboard for the same turn. Validated against 3 sample turns.
5. **F144 multi-turn memory works on both backends**: the "Hvad er trail? → Ja det vil jeg gerne" two-turn flow (the bug we fixed earlier this session) produces the snapshot table in the second turn regardless of which backend is selected.
6. **No regression on Claude-CLI path**: every existing chat use case (single-turn, multi-turn, tool-use, no-context fallback) returns identical answers with identical citation arrays after the refactor. Side-by-side verified on 5 prepared questions.

## Impact Analysis

### Files created (new)

- `apps/server/src/services/chat/backend.ts` — interface + types.
- `apps/server/src/services/chat/index.ts` — factory `createChatBackend()`.
- `apps/server/src/services/chat/chain.ts` — `resolveChatChain()` pure function.
- `apps/server/src/services/chat/runner.ts` — orchestration + fallback loop.
- `apps/server/src/services/chat/claude-cli-backend.ts` — lifted from `chat.ts`.
- `apps/server/src/services/chat/openrouter-backend.ts` — new.
- `apps/server/src/services/chat/mcp-tool-adapter.ts` — `mcpToolsToFunctionSpecs()` + `invokeTrailMcpTool()` in-process router.
- `apps/server/src/services/chat/build-prompt.ts` — extracted `buildCliPrompt()` + `buildSystemPrompt()` helpers (currently inlined in `chat.ts`).
- `apps/server/src/routes/chat-settings.ts` — new PATCH route for per-KB backend overrides.
- `packages/db/drizzle/0021_chat_backend_columns.sql` — schema migration.
- `apps/server/scripts/verify-f159-chat-backends.ts` — end-to-end probe asserting both backends answer + tool-use parity.

### Files modified

- `apps/server/src/routes/chat.ts` — slim to ~80 lines; delegates to `runChat()`.
- `packages/db/src/schema.ts` — add `chatBackend`, `chatModel`, `chatFallbackChain` columns to `knowledgeBases`; `costCents`, `backendUsed`, `modelUsed` columns to `chatTurns`.
- `apps/server/src/app.ts` — mount the new `/chat-settings` route.
- `packages/shared/src/types.ts` — extend `ChatResponse` with `backend?: string` and `model?: string`.
- `apps/admin/src/api.ts` — type the new response fields.
- `.env.example` — note that `CHAT_BACKEND` and `OPENROUTER_API_KEY` participate in chain resolution.

### Downstream dependents

- **`apps/server/src/routes/chat.ts`** — downstream importers: `apps/server/src/app.ts` (1 ref, mounts route). Internal route handler shrinks; no external API contract changes (additive response fields only). Unaffected.
- **`packages/db/src/schema.ts`** — `rg "from.*@trail/db" --type ts -l` finds 61 importers. The schema additions are pure column-adds; every existing query against `knowledge_bases` and `chat_turns` continues to work. Adding columns is the safest possible Drizzle change. None of the 61 consumers need updates.
- **`apps/server/src/app.ts`** — 1 importer (`apps/server/src/index.ts`, mounts the app). New route mount is additive.
- **`packages/shared/src/types.ts`** — 30+ importers across admin + server. Adding optional `backend?: string` + `model?: string` to `ChatResponse` is additive; existing destructuring continues to work.
- **`apps/admin/src/api.ts`** — internal to admin; type extension is additive.
- **`.env.example`** — no code dependents.

### Blast radius

- **Chat semantic regression risk.** Refactoring `chat.ts` from ~250 lines to ~80 lines is the highest-risk change. Mitigation: regression test in the verify script that runs 5 prepared questions against the new code path and asserts identical answers + citations. Backend stays Claude-CLI by default so the old path is exercised even after refactor.
- **MCP adapter fidelity.** The OpenRouter backend hand-converts MCP tool definitions to OpenAI function-specs. If the adapter mishandles a tool's argument schema (wrong required fields, missing JSON-schema fragment), Gemini will pass nonsense args → the in-process MCP handler will throw → the user gets garbage. Mitigation: snapshot test that compares the converted tool-spec for each of the 8 chat-allowed tools against a reviewed-by-Christian fixture.
- **Cost-stamping write amplification.** Every chat turn now writes 3 extra columns to `chat_turns`. The write is in the same transaction as the existing turn-pair insert, so no new round-trip. Storage overhead negligible (<50 bytes per turn).
- **In-process MCP tool invocation security.** The OpenRouter backend calls `invokeTrailMcpTool()` directly, bypassing the MCP subprocess's own arg validation. The router MUST re-validate `tenantId` + `knowledgeBaseId` against the request context before dispatching, or a crafted tool-call could request data from another tenant. Mitigation: the router takes `tenantId`/`kbId` as required params (not from the tool args) and overrides any tool-arg attempts to set them.
- **Default-chain auto-fallback could mask Claude problems.** If we ship Phase 4's chain `[claude-cli, openrouter]` as default, a user whose Claude is slow but working will silently get Gemini answers and be confused about quality differences. Mitigation: response includes `backend` + `model`; admin UI shows a small chip on the assistant turn if backend != tenant's preferred.

### Breaking changes

**None — all changes are additive.** Existing chat clients that ignore the new `backend` + `model` response fields continue to work. The chain-resolution defaults match current behaviour (Claude-CLI single-step) until Phase 4 explicitly flips them, and that flip itself is reversible by setting `CHAT_BACKEND=claude-cli` env var.

### Test plan

- [ ] TypeScript compiles: `pnpm typecheck` (server + admin + shared + db packages).
- [ ] Unit (`packages/db`): the migration 0021 lands in `__drizzle_migrations` and adds the 6 columns; assert via `PRAGMA table_info`.
- [ ] Unit (`apps/server/src/services/chat/chain.ts`): `resolveChatChain()` returns the env-default single-step when KB has no overrides; respects `chat_fallback_chain` JSON when present; falls through precedence correctly.
- [ ] Unit (`apps/server/src/services/chat/mcp-tool-adapter.ts`): `mcpToolsToFunctionSpecs([...8 tool names...])` produces 8 OpenAI-shaped tool definitions whose `parameters.required` match the MCP tool's input schema; snapshot.
- [ ] Unit: `invokeTrailMcpTool()` rejects a tool call that tries to override `tenant_id` in its args.
- [ ] Integration (`scripts/verify-f159-chat-backends.ts`): both backends answer "what is 2+2?" with "4" (no MCP needed); both backends answer "how many Neurons in this Trail?" with the correct count (MCP needed via `count_neurons`); both backends answer a multi-turn follow-up correctly (F144 history replayed).
- [ ] Integration: forced fallback — chain `[openrouter:nonexistent-model, openrouter:gemini-flash]` returns a working answer with `stepsAttempted: 2`.
- [ ] Integration: forced cost — three OpenRouter chat turns produce non-NULL `cost_cents` rows whose sum is within 5% of the OpenRouter dashboard's shown cost for the same period.
- [ ] Manual: in dev, set `CHAT_BACKEND=openrouter` in `.env`, restart server, ask 5 prepared questions in admin chat, confirm answers feel comparable to Claude (subjective Christian-judgment).
- [ ] Manual: in dev, leave `CHAT_BACKEND` unset, confirm Claude-CLI still wins step 1 of the default chain (logs show `backendUsed: claude-cli`).
- [ ] Regression: F89 chat-tools (the 8 trail MCP tools) all return correct results when invoked via OpenRouter backend (covered by integration test).
- [ ] Regression: F144 chat-history (the bug fixed earlier this session) — the "Hvad er trail? → Ja det vil jeg gerne" flow works on BOTH backends.
- [ ] Regression: F30 chat citations render — citation extraction from the final answer text works regardless of backend.
- [ ] Regression: existing chat sessions in the sidebar continue to load + display past turns. (No schema change to existing columns; pure additive.)

## Implementation Steps

1. **Add migration 0021** with the 6 new columns. Run `db:generate`. Verify the migration applies cleanly to a snapshot of the prod DB.
2. **Lift `ClaudeCLIChatBackend`** from `chat.ts` into `services/chat/claude-cli-backend.ts`. Define the `ChatBackend` interface in `services/chat/backend.ts`. Refactor `chat.ts` to call `runChat()` (which initially supports only the CLI backend). End-to-end: every existing chat flow must produce identical answers. Cut a tag here so we can revert the refactor cleanly if needed.
3. **Build `mcpToolsToFunctionSpecs()` + `invokeTrailMcpTool()`** in `services/chat/mcp-tool-adapter.ts`. Snapshot-test the OpenAI tool-spec for each of the 8 chat-allowed tools.
4. **Build `OpenRouterChatBackend`** with the per-turn message/tool-call loop. Wire `usage.cost` into the result. Verify against a single trivial question (no tools needed).
5. **Add chain resolution + runner** in `services/chat/chain.ts` + `services/chat/runner.ts`. Lift the `isFallbackEligible()` predicate from F149's runner — error taxonomy is identical.
6. **Implement `/chat-settings` PATCH route** + admin client method. Trivial; mirrors F149's `/ingest-settings`.
7. **Cost stamping** — extend `persistTurnPair()` to write `cost_cents`/`backend_used`/`model_used`. Ensure NULL handling for Claude-CLI rows.
8. **Verify script** — `scripts/verify-f159-chat-backends.ts` running every Test Plan integration item against a freshly-seeded throwaway KB.
9. **Default chain flip (Phase 4)** — once Phase 3 is verified in dev for ~24h with Christian using both backends, change `resolveChatChain()`'s hardcoded default from `[claude-cli]` to `[claude-cli, openrouter:gemini-flash, openrouter:claude-sonnet]`. Document the flip in CHANGELOG-style commit. F33 deploy now possible.
10. **F151 + F156 hookups** — add a chat-cost line to the Cost dashboard (`apps/admin/src/panels/cost.tsx`); F156 credit-burn already queries `chat_turns.cost_cents` indirectly via the same SUM-by-tenant aggregation. No code change needed in F156 codepaths beyond a comment.

## Dependencies

- **F149 Pluggable Ingest Backends** — ✅ shipped. Provides the architectural pattern + the OpenRouter plumbing (`apps/server/src/services/openrouter/` lifted from model-lab) that this feature reuses.
- **F144 Chat History** — ✅ shipped + fixed this session. Required for both backends to consume `priorTurns` correctly.
- **F151 Cost & Quality Dashboard** — ✅ planned/landing. Becomes the surface where chat-cost shows up after `cost_cents` is populated.
- **F156 Credits-Based LLM Metering** — Planned. Feeds off `chat_turns.cost_cents`; no code dependency in F159 beyond the column existing.
- **F89 Chat Tools (MCP-backed)** — ✅ shipped. The 8 tool handlers live in `apps/mcp/src/`; the in-process adapter calls them directly.
- **F33 Fly.io Deploy** — Planned. F159 is a hard prerequisite for F33: without pluggable chat, prod deploy 500's on every `/chat` request.

## Open Questions

1. **In-process MCP handler co-location** — should we lift the 8 chat-tool handlers from `apps/mcp/src/` into `packages/core/src/mcp-tools/` so both the MCP subprocess (CLI backend) and the in-process router (OpenRouter backend) call the same code? Cleaner but adds a refactor scope. Proposal: yes, do it as part of Phase 2 — single source of truth prevents drift between paths.
2. **OpenRouter quota / budget limits** — at production load, what's the per-tenant cap before we refuse a chat request and return "credit balance exhausted"? F156 owns the answer but we need a concrete check in `runChat()` somewhere. Proposal: `runChat()` queries `tenant_credits.balance` before fanning out; if 0 or negative, return a structured "out of credits" error. Confirm with F156 author.
3. **Claude API direct backend** — worth shipping in v1, or wait? OpenRouter routes Anthropic at near-direct prices and we don't need both. Proposal: skip in v1; add only if a customer has a stronger reason than price (e.g. PHI compliance via Anthropic BAA).
4. **Streaming responses to the admin UI** — non-streaming today; do we want to ship streaming as part of F159 since we're touching the response shape anyway? Proposal: no, defer to its own feature. Streaming is a UI + protocol change orthogonal to backend choice.
5. **Per-conversation backend memory** — if a chat session starts on Claude and Claude fails on turn 3 → falls back to Gemini, do subsequent turns stick on Gemini or retry Claude every time? Proposal: per-turn re-resolution from chain (today); revisit if fall-flapping wastes obvious latency.
6. **Tool-call max-turns budget** — currently `CHAT_MAX_TURNS = 5`. OpenRouter loop is its own iteration count; should that match? Proposal: yes, use the same `CHAT_MAX_TURNS` value to cap both paths.

## Related Features

- **F149 Pluggable Ingest Backends** — direct architectural twin. F159 is "do the same thing, for chat." Reuses F149's OpenRouter SDK lift + chain pattern + error taxonomy.
- **F151 Cost & Quality Dashboard** — gains a chat-cost view as soon as F159 ships cost stamping. No new dashboard work needed; the existing per-day cost SQL just SUMs `chat_turns.cost_cents` alongside `ingest_jobs.cost_cents`.
- **F152 Runtime Model Switcher UI** — extends to chat: per-KB chat-backend dropdown lives in the same Settings panel as F152's ingest-backend dropdown. Same UX, parallel column.
- **F156 Credits-Based LLM Metering** — chat becomes a credit-burning operation alongside ingest. No code dependency in F156; `chat_turns.cost_cents` slots into the existing transaction-emit path.
- **F33 Fly.io Production Deploy** — UNBLOCKED by this feature. Production has no `claude` binary; F33 cannot land usefully until chat works without it.
- **F157 Trail iOS App** — voice-to-voice chat in the iOS app rides this same `/api/v1/chat` endpoint. iOS gets free OpenRouter routing as a side-effect.
- **F89 Chat Tools (MCP)** — F159 preserves all 8 chat tools across backends; the adapter is the bridge.
- **F144 Chat History** — both backends consume `priorTurns`; the multi-turn memory fix from this session works on both paths.

## Effort Estimate

**Medium** — **4-6 days** (full-time-equivalent), broken across 4 phases:

- Phase 1 (interface + Claude-CLI lift): **1 day**
- Phase 2 (OpenRouter backend + MCP-tool adapter): **2 days** (the adapter is the long pole)
- Phase 3 (per-KB chain config + cost stamping + PATCH route): **1 day**
- Phase 4 (default chain flip + verification soak): **0.5 day** (real time + 24h soak before flipping the prod default)
- Buffer for unknowns (OpenRouter tool-call quirks, MCP-handler co-location refactor, OpenRouter rate-limit handling): **0.5–1.5 days**

The flip enables F33 (Fly.io prod deploy) and unlocks F156's chat-cost dimension. High-leverage relative to its effort.
