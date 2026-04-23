# F120 — Anthropic API Migration

> Tier: infrastruktur (prerequisite for multi-tenant commercialization). Effort: 2-3 days core + 3-5 days polish. Planned.

## Problem

Alle LLM-stier bruger i dag `services/claude.ts` der spawn'er claude CLI-subprocess på Max-subscription. Det har tre dealbreakere for commercialization:

1. **TOS-brud** — Max-subscription er individual-seat, SaaS-videresalg er ikke tilladt
2. **Rate-limit deling** — alle tenants trækker fra samme subscription-kvota
3. **Perf-overhead** — hver CLI-spawn er 500MB-2GB RAM + 1s cold-start, vs. API-direct HTTP-roundtrip <100ms

## Secondary Pain Points

- No per-tenant API key isolation
- CLI subprocess makes it impossible to track token usage per tenant (F121)
- Debugging LLM responses requires reading subprocess stdout/stderr logs
- No support for streaming responses from CLI (all-or-nothing)

## Solution

Refactor `services/claude.ts` til `services/llm-client.ts` med transport-abstraktion:

```ts
interface LlmTransport {
  complete(args: { prompt: string; model: string; maxTokens: number }): Promise<string>;
  completeWithTools(args: { prompt: string; model: string; maxTokens: number; tools: Tool[]; maxTurns: number }): Promise<ConversationResult>;
}

class AnthropicApiTransport implements LlmTransport { /* SDK */ }
class ClaudeCliTransport implements LlmTransport { /* backward-compat */ }
```

Env-flag: `TRAIL_LLM_TRANSPORT=api|cli` (default: `api` i prod, `cli` i dev). Per-tenant API-key: `tenants.llm_api_key_encrypted` (encrypted at rest, decrypted on-use). Standard Anthropic-key i `.env` fallback for single-tenant dev.

## Non-Goals

- Multi-provider support (OpenAI, Gemini, etc.) — Anthropic only for now
- Model selection UI for end users (admin-configured only)
- Caching LLM responses (that's F134)
- Fine-tuned model support (that's F116)

## Technical Design

### Transport Interface

```typescript
// apps/server/src/services/llm-client.ts
interface LlmTransport {
  complete(args: LlmCompleteArgs): Promise<string>;
  completeWithTools(args: LlmCompleteWithToolsArgs): Promise<ConversationResult>;
}

interface LlmCompleteArgs {
  prompt: string;
  model: string;
  maxTokens: number;
  system?: string;
  temperature?: number;
}

interface LlmCompleteWithToolsArgs extends LlmCompleteArgs {
  tools: Tool[];
  maxTurns: number;
}

interface ConversationResult {
  text: string;
  toolCalls: ToolCall[];
  usage: { inputTokens: number; outputTokens: number; };
}
```

### Anthropic API Transport

```typescript
class AnthropicApiTransport implements LlmTransport {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async complete(args: LlmCompleteArgs): Promise<string> {
    const msg = await this.client.messages.create({
      model: args.model,
      max_tokens: args.maxTokens,
      system: args.system,
      messages: [{ role: 'user', content: args.prompt }],
      temperature: args.temperature ?? 0.7,
    });
    return extractText(msg);
  }

  async completeWithTools(args: LlmCompleteWithToolsArgs): Promise<ConversationResult> {
    const msg = await this.client.messages.create({
      model: args.model,
      max_tokens: args.maxTokens,
      system: args.system,
      messages: [{ role: 'user', content: args.prompt }],
      tools: args.tools.map(toolsToAnthropicFormat),
      max_turns: args.maxTurns,
    });
    return parseConversationResult(msg);
  }
}
```

### CLI Transport (Backward Compat)

```typescript
class ClaudeCliTransport implements LlmTransport {
  async complete(args: LlmCompleteArgs): Promise<string> {
    return spawnClaude(args.prompt, { model: args.model, maxTokens: args.maxTokens });
  }
  // completeWithTools: map MCP-tools to CLI --tools flag
}
```

### Client Factory

```typescript
export function getLlmClient(tenant?: Tenant): LlmTransport {
  const transport = process.env.TRAIL_LLM_TRANSPORT ?? 'api';
  if (transport === 'cli') return new ClaudeCliTransport();
  const apiKey = tenant?.llmApiKeyEncrypted
    ? decrypt(tenant.llmApiKeyEncrypted)
    : process.env.ANTHROPIC_API_KEY;
  return new AnthropicApiTransport(apiKey!);
}
```

### MCP Tool Mapping

Anthropic API understøtter tools direkte via `messages.create({..., tools: [...]})`. Mapping af MCP-tools til Anthropic-tool-format i chat-service.

## Interface

```typescript
// Env vars
interface LlmEnvConfig {
  TRAIL_LLM_TRANSPORT: 'api' | 'cli'; // default 'api'
  ANTHROPIC_API_KEY: string; // fallback for single-tenant
}

// Tenant schema extension (from F122)
interface TenantLlmConfig {
  llmApiKeyEncrypted: string | null;
  defaultModel: string; // default 'claude-sonnet-4-20250514'
  maxTokensPerCall: number; // from F122 plan limits
}
```

## Rollout

**Phased deploy:**
1. Ship `llm-client.ts` with both transports behind feature flag
2. Migrate ingest pipeline to use new client (highest volume, easiest to verify)
3. Migrate chat service
4. Migrate translation, source-inferer, contradiction-lint, action-recommender
5. Default to `api` in prod, keep `cli` for dev

## Success Criteria

- Alle LLM-stier virker via API-transport (ikke CLI)
- Per-tenant API-key respekteres (ellers fallback til system-key for single-tenant)
- CLI-transport bevares for dev-mode
- Latency-nedgang målt: ingest-compile 10-30 % hurtigere (CLI-spawn-overhead elimineret)
- Perf: én claude-subprocess-instance er ikke længere ~2GB RAM per concurrent ingest

## Impact Analysis

### Files created (new)
- `apps/server/src/services/llm-client.ts`
- `apps/server/src/services/llm-client.test.ts`

### Files modified
- `apps/server/src/services/claude.ts` (deprecate, keep for dev fallback)
- `apps/server/src/services/ingest.ts` (switch from spawnClaude to getLlmClient)
- `apps/server/src/routes/chat.ts` (switch from spawnClaude to getLlmClient)
- `apps/server/src/services/translation.ts` (switch to getLlmClient)
- `apps/server/src/services/source-inferer.ts` (switch to getLlmClient)
- `apps/server/src/services/contradiction-lint.ts` (switch to getLlmClient)
- `apps/server/src/services/action-recommender.ts` (switch to getLlmClient)
- `packages/db/src/schema.ts` (add `llm_api_key_encrypted` + `default_model` to tenants)
- `package.json` (add `@anthropic-ai/sdk` dependency)

### Downstream dependents
`apps/server/src/services/claude.ts` is imported by 1 file:
- `apps/server/src/routes/chat.ts` (1 ref) — will be updated to use llm-client.ts

`apps/server/src/services/ingest.ts` is imported by 5 files:
- `apps/server/src/routes/ingest.ts` (1 ref) — triggers ingest, unaffected
- `apps/server/src/index.ts` (1 ref) — recovers ingest jobs, unaffected
- `apps/server/src/routes/uploads.ts` (1 ref) — triggers ingest after upload, unaffected
- `apps/server/src/routes/documents.ts` (1 ref) — triggers ingest, unaffected
- `apps/server/src/bootstrap/zombie-ingest.ts` (1 ref comment) — documentation only

`apps/server/src/routes/chat.ts` is imported by 1 file:
- `apps/server/src/app.ts` (1 ref) — mounts route, unaffected

`apps/server/src/services/translation.ts` is imported by 1 file:
- `apps/server/src/routes/queue.ts` (1 ref) — uses ensureCandidateInLocale, unaffected

`apps/server/src/services/source-inferer.ts` is imported by 1 file:
- `apps/server/src/routes/queue.ts` (1 ref) — uses proposeSourcesForOrphan, unaffected

`apps/server/src/services/contradiction-lint.ts` is imported by 4 files:
- `apps/server/src/index.ts` (1 ref) — starts contradiction lint, unaffected
- `apps/server/src/services/source-inferer.ts` (2 refs) — uses contradiction types, unaffected
- `apps/server/src/services/lint-scheduler.ts` (2 refs) — subscribes to events, unaffected
- `apps/server/src/services/contradiction-lint.ts` (7 self-refs) — internal

`apps/server/src/services/action-recommender.ts` is imported by 1 file:
- `apps/server/src/index.ts` (1 ref) — starts action recommender, unaffected

`packages/db/src/schema.ts` is imported by 1 file:
- `packages/core/src/kb/resolve.ts` (1 ref) — reads document schema, unaffected by additive columns

### Blast radius

- All LLM-dependent features (ingest, chat, translation, contradiction, action-recommender) depend on correct API key configuration
- Wrong API key → all LLM calls fail → ingest stalls, chat broken, lint stops
- CLI transport kept as fallback means dev-mode still works if API is misconfigured
- Token usage tracking (F121) depends on `ConversationResult.usage` being correctly populated
- Anthropic SDK version pinning required — breaking changes in SDK could affect all paths

### Breaking changes

None to external API. Internal behavior change: LLM calls go through HTTP instead of subprocess.

### Test plan

- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] `TRAIL_LLM_TRANSPORT=api` → AnthropicApiTransport used
- [ ] `TRAIL_LLM_TRANSPORT=cli` → ClaudeCliTransport used
- [ ] Per-tenant API key decrypted and used correctly
- [ ] Fallback to system ANTHROPIC_API_KEY when tenant has no key
- [ ] Ingest compile via API produces same output as CLI (within temperature variance)
- [ ] Chat with tools via API returns correct tool calls
- [ ] Rate-limit error (429) handled gracefully with retry
- [ ] Regression: ingest end-to-end still produces wiki pages
- [ ] Regression: chat still works in dev mode with CLI transport

## Implementation Steps

1. Add `@anthropic-ai/sdk` to `package.json`.
2. Create `apps/server/src/services/llm-client.ts` with `LlmTransport` interface + both implementations.
3. Add `llm_api_key_encrypted` + `default_model` columns to tenants schema.
4. Migrate `services/ingest.ts` to use `getLlmClient()`.
5. Migrate `routes/chat.ts` to use `getLlmClient()` with tool mapping.
6. Migrate `services/translation.ts`, `source-inferer.ts`, `contradiction-lint.ts`, `action-recommender.ts`.
7. Add `TRAIL_LLM_TRANSPORT` env flag handling.
8. Test both transports end-to-end.

## Dependencies

- F121 (budget tracking — API costs must be limited per tenant)
- F122 (plan limits — controls max-tokens per call per tier)

## Open Questions

None — all decisions made.

## Related Features

- **F121** (Per-Tenant Budget Tracking) — tracks API token costs
- **F122** (Plan Limits on Tenants) — controls max tokens and model selection
- **F119** (Parallel Contradiction Runner) — higher parallelism with API transport
- **F116** (Synthetic Training Data Export) — uses API for Strategy 3 Q&A generation

## Effort Estimate

**Medium** — 5-8 days total.
- Day 1-2: Core transport interface + AnthropicApiTransport
- Day 3: ClaudeCliTransport backward compat + env flag
- Day 4-5: Migrate all call sites (ingest, chat, translation, source-inferer, contradiction, action-recommender)
- Day 6-7: Tool mapping for chat + testing
- Day 8: Polish + rate-limit handling
