# F120 — Anthropic API Migration

*Planned. Tier: infrastruktur (prerequisite for multi-tenant commercialization). Effort: 2-3 days core + 3-5 days polish.*

> Trail flytter fra `claude -p` CLI-subprocess til direkte Anthropic SDK-kald i alle LLM-stier (ingest, chat, translation, source-inferer, contradiction-lint, action-recommender). Forudsætning for at sælge Pro+ tier lovligt — Claude Max TOS tillader ikke SaaS-videresalg.

## Problem

Alle LLM-stier bruger i dag `services/claude.ts` der spawn'er claude CLI-subprocess på Max-subscription. Det har tre dealbreakere for commercialization:

1. **TOS-brud** — Max-subscription er individual-seat, SaaS-videresalg er ikke tilladt
2. **Rate-limit deling** — alle tenants trækker fra samme subscription-kvota
3. **Perf-overhead** — hver CLI-spawn er 500MB-2GB RAM + 1s cold-start, vs. API-direct HTTP-roundtrip <100ms

## Solution

Refactor `services/claude.ts` til `services/llm-client.ts` med transport-abstraktion:

```ts
interface LlmTransport {
  complete(args: { prompt: string; model: string; maxTokens: number; }): Promise<string>;
  completeWithTools(args: { ..., tools: Tool[], maxTurns: number }): Promise<ConversationResult>;
}

class AnthropicApiTransport implements LlmTransport { /* SDK */ }
class ClaudeCliTransport implements LlmTransport { /* backward-compat */ }
```

Env-flag: `TRAIL_LLM_TRANSPORT=api|cli` (default: `api` i prod, `cli` i dev).

Per-tenant API-key: tenants.llm_api_key_encrypted (encrypted at rest, decrypted on-use). Standard Anthropic-key i `.env` fallback for single-tenant dev.

## How

- Ny fil `apps/server/src/services/llm-client.ts` med interface + AnthropicApiTransport
- Alle call-sites (ingest, chat, translation, source-inferer, contradiction-lint, action-recommender) skifter fra `spawnClaude` til `getLlmClient(tenant).complete(...)`
- MCP-tool-brug i chat skal håndteres — Anthropic API understøtter tools direkte via `messages.create({..., tools: [...]})`. Mapping af MCP-tools til Anthropic-tool-format i chat-service
- Behold `ClaudeCliTransport` bag feature-flag for dev-fleksibilitet

## Dependencies

- F121 (budget tracking — API-costs skal limiteres per tenant)
- F122 (plan limits — styrer max-tokens per kald per tier)

## Success criteria

- Alle LLM-stier virker via API-transport (ikke CLI)
- Per-tenant API-key respekteres (ellers fallback til system-key for single-tenant)
- CLI-transport bevares for dev-mode
- Latency-nedgang målt: ingest-compile 10-30 % hurtigere (CLI-spawn-overhead elimineret)
- Perf: én claude-subprocess-instance er ikke længere ~2GB RAM per concurrent ingest
