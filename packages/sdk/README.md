# @trailmem/sdk

TypeScript client for the [Trail](https://trailmem.com) HTTP API.

Three methods, one per integration layer (F160 three-tier contract):

| Method | Layer | LLM on Trail | Use case |
|---|---|---|---|
| `search()` | Lag 1 retrieval | 0 | Discover what the KB has on a topic |
| `retrieve()` | Lag 1 retrieval | 0 | Get focused chunks + pre-formatted context for site-LLM stuffing |
| `chat()` | Lag 2/3 | 1 | Get an LLM-synthesized answer (curator/tool/public audience) |

## Install

```bash
npm install @trailmem/sdk
# or
pnpm add @trailmem/sdk
# or
bun add @trailmem/sdk
```

## Quick start

```ts
import { TrailClient } from '@trailmem/sdk';

const trail = new TrailClient({
  baseUrl: process.env.TRAIL_API_BASE!, // e.g. http://127.0.0.1:58021
  apiKey: process.env.TRAIL_API_KEY!,   // trail_<64hex>
});

// Lag 1 — focused retrieval for site-LLM context-stuffing
const { formattedContext, chunks } = await trail.retrieve(
  process.env.TRAIL_KB_ID!,
  { query: 'klienten klager over dårlig søvn', maxChars: 2000, topK: 5 },
);

// Drop formattedContext into your own LLM's prompt as background
console.log(formattedContext);
```

## Picking the right layer

Use the decision tree from `docs/INTEGRATION-API.md`:

- Building a chat-widget that embeds Trail's answer 1:1 in a simple page? → **Lag 3** (`chat()` with `audience: 'public'`).
- Already have an LLM on your site (booking-bot, FAQ-bot, e-commerce assistant)? → **Lag 1** (`retrieve()`) — Trail is one tool among many.
- In between — want prose but don't want to write your own tone-prompt? → **Lag 2** (`chat()` with `audience: 'tool'`).

**Default recommendation for modern sites: Lag 1.** You pay for ONE LLM call (your own), Trail's value is KB curation (compile, lint, search-index), and you keep full control over tone + how Trail's knowledge mixes with your other tool data.

## Authentication

Get a key from your Trail admin: **Settings → API Keys → Generate new API key**. Keys inherit the user's tenant scope. The raw key is shown exactly once — store it in your password manager or your integration's secret store immediately.

## CORS

If you call from a browser: the operator must whitelist your origin via `TRAIL_ALLOWED_ORIGINS=https://your-site.com` on the Trail engine. Server-side (Node, Bun, Deno, Cloudflare Workers) calls are unaffected.

## Examples

### Lag 1 — retrieve + site-LLM orchestration

```ts
import { TrailClient } from '@trailmem/sdk';
import OpenAI from 'openai';

const trail = new TrailClient({ baseUrl: TRAIL_BASE, apiKey: TRAIL_KEY });
const llm = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1',
});

const tools = [{
  type: 'function' as const,
  function: {
    name: 'trail_retrieve',
    description: 'Hent relevant viden fra Sanne\'s videnbase.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
}];

async function chat(userMessage: string) {
  const completion = await llm.chat.completions.create({
    model: 'google/gemini-2.5-flash',
    messages: [
      { role: 'system', content: SANNE_SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ],
    tools,
  });

  const msg = completion.choices[0]!.message;
  if (msg.tool_calls?.length) {
    for (const call of msg.tool_calls) {
      if (call.function.name === 'trail_retrieve') {
        const { query } = JSON.parse(call.function.arguments);
        const { formattedContext } = await trail.retrieve(KB_ID, { query });
        // Send formattedContext back as tool_result for the next turn
      }
    }
  }
}
```

### Lag 3 — direct chat widget

```ts
import { TrailClient, TrailApiError } from '@trailmem/sdk';

const trail = new TrailClient({ baseUrl: TRAIL_BASE, apiKey: TRAIL_KEY });

let sessionId: string | undefined;

async function ask(message: string) {
  try {
    const res = await trail.chat({
      message,
      knowledgeBaseId: 'sanne-andersen',
      sessionId,
      audience: 'public',
    });
    sessionId = res.sessionId ?? sessionId;
    return res.answer;
  } catch (err) {
    if (err instanceof TrailApiError && err.code === 'session_turn_cap_reached') {
      sessionId = undefined; // start fresh next turn
      return 'Chat-grænse nået. Start en ny samtale.';
    }
    throw err;
  }
}
```

### Search with audience filter

```ts
const { documents, chunks } = await trail.search('sanne-andersen', {
  query: 'søvnløshed',
  audience: 'tool', // strips heuristic + internal-tagged Neurons
  limit: 10,
});
```

## Audiences

Audience controls which Neurons are visible (Lag 1) and which prose tone the LLM uses (Lag 2/3):

| audience | Visibility | Tone (chat only) |
|---|---|---|
| `curator` | All Neurons (incl. heuristics, internal-tagged) | Detailed, references inline, admin-style |
| `tool` | Excludes heuristics + `internal`-tagged | Factual, neutral, no tone-skin, no CTAs |
| `public` | Same as tool | Warm du-form, max 4 sentences, action-prompts when natural |

Bearer tokens default to `tool`. Pass `audience: 'public'` explicitly for end-user-facing chat.

## Errors

The client throws `TrailApiError` on any non-2xx response:

```ts
import { TrailApiError } from '@trailmem/sdk';

try {
  await trail.chat({ message: 'hej', knowledgeBaseId: 'x' });
} catch (err) {
  if (err instanceof TrailApiError) {
    console.log(err.status); // 401, 404, 429, 500…
    console.log(err.code);   // e.g. 'session_turn_cap_reached'
    console.log(err.body);   // full parsed JSON body for { turnsUsed, turnsLimit, ... }
  }
}
```

## Versioning + stability

Endpoints under `/api/v1` are stable; breaking changes get `/api/v2` with overlap during deprecation. Field additions to existing responses are non-breaking — write your client to ignore unknown fields.

## License

FSL-1.1-Apache-2.0 (Functional Source License, converts to Apache 2.0 after 2 years).

## See also

- [`docs/INTEGRATION-API.md`](https://github.com/broberg-ai/trail/blob/main/docs/INTEGRATION-API.md) — full HTTP API reference (raw curl)
- [`docs/features/F160-three-tier-integration-contract.md`](https://github.com/broberg-ai/trail/blob/main/docs/features/F160-three-tier-integration-contract.md) — architectural rationale
