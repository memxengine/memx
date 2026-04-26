# Trail HTTP API for Integrators

The stable, integration-facing contract for the Trail HTTP API. This is what
a third-party site, mobile app, or script written in another repo should
read — it documents only the endpoints we will support across versions.
The internal admin API (queue mutations, KB CRUD, lint internals) is not
listed here because it is not a stable contract.

> Engine version: any post-F160 Phase 1 build (commit 17c14af onwards).

## Pick your integration layer

Trail eksponerer KB-content i tre lag, hver med sin egen LLM-cost-profil.
Læs dette først — valg af lag bestemmer cost, latency, og hvor meget
arbejde du skal gøre selv.

| Lag | Endpoint | LLM på Trail | Hvad du får | Bedst når |
|---|---|---|---|---|
| **1. Retrieval** | `GET /search`, `POST /retrieve` | **0** (gratis) | Top-K Neurons + chunks som rå data + en pre-formatteret context-blok | Du har egen site-LLM (eller orchestrator) der vil have facts ind som baggrund |
| **2. Knowledge-prose** | `POST /chat` (`audience: "tool"`) | 1 | Faktuel prosa + strukturerede citations | Du har LLM, men vil have prose-grundlag fremfor rå chunks |
| **3. Render-ready** | `POST /chat` (`audience: "public"`) | 1 | Varm slutbruger-tone, du-form, action-orienteret | Direct widget — ingen orchestrator, prose embeddes direkte |

**Beslutningstræ**:

- Bygger du en chat-widget der embedder Trail's svar 1:1 i en simpel side? → **Lag 3**.
- Har du allerede en LLM på dit site (booking, FAQ, e-commerce-bot)? → **Lag 1**, kald Trail som ét tool i din orchestration.
- Imellem — vil du have prosa men ikke skrive din egen tone-prompt? → **Lag 2**.

**Standard-anbefaling for moderne sites: Lag 1.** Det giver dig fuld kontrol
over tonen, lader dig kombinere KB-viden med booking/shop/anden data, og du
betaler kun for ÉN LLM-call (din egen) per brugerprompt. Trail's value er
KB-pleje (compile, lint, search-index), ikke per-request-syntese.

## Authentication

All API endpoints require a `trail_<64hex>` Bearer token:

```
Authorization: Bearer trail_<64 hex characters>
```

Get a key from **Admin → Settings → API Keys → Generate new API key**.
Keys are per-user and inherit the user's tenant + role. The raw key is
shown exactly once — store it in your password manager or your
integration's secret store immediately. We only persist a SHA-256 hash,
so a lost key cannot be recovered; you must revoke and mint a new one.

A request with an invalid or revoked key returns:

```http
HTTP/1.1 401 Unauthorized
Content-Type: application/json

{ "error": "Invalid or revoked API key" }
```

Revoke at any time from the same admin panel — existing connections
using the revoked key will get 401 on their next request. There is no
session-level expiry; keys live until you revoke them.

## CORS

By default the engine only allows requests from its admin UI origin
(`APP_URL`, default `http://localhost:3030`) and browser extensions.
To call the API from another origin (e.g. an integration site running
on `localhost:3001`), the operator sets:

```bash
TRAIL_ALLOWED_ORIGINS=http://localhost:3001,https://sanne-andersen.dk
```

Multiple comma-separated origins are accepted. Each entry must be a
valid `scheme://host[:port]` — invalid entries log a warning at boot
and are dropped, but the engine still starts on the rest.

## Endpoints

## Lag 1 — Retrieval (anbefalet for site-LLM-orchestratorer)

### `GET /api/v1/knowledge-bases/:kbId/search`

FTS5-search over en KB. Returnerer både matchende hele documents og
matchende chunks. Brug det når site-LLM'en vil "hvad er der i KB'en
om dette emne" som en discovery-query — typisk efterfulgt af en
`/retrieve`-call på den specifikke query.

**Query parameters**

| Param | Type | Default | Notes |
|---|---|---|---|
| `q` | string | required | FTS5-tokens (sanitised server-side; `[`, `]`, etc. neutraliseres). `#kbprefix_00000042` er en seqId-direktelookup. |
| `audience` | `curator` \| `tool` \| `public` | `tool` for Bearer auth | F160 audience-filter. `tool` og `public` ekskluderer Neurons under `/neurons/heuristics/` og dem tagged `internal`. `curator` returnerer alt — kun for admin-UI. |
| `limit` | int | `10` | Max 50. |
| `tag` | string (gentaget) | — | Repeated `?tag=foo&tag=bar` filter (AND-semantics). |

**Response (200)**

```json
{
  "documents": [
    {
      "id": "doc_...",
      "knowledgeBaseId": "kb_...",
      "filename": "zoneterapi.md",
      "title": "Zoneterapi",
      "path": "/neurons/zoneterapi.md",
      "kind": "wiki",
      "highlight": "...zoneterapi <mark>søvn</mark>...",
      "rank": 0.92,
      "seq": 17,
      "tags": "behandling,grundlag"
    }
  ],
  "chunks": [
    {
      "id": "chk_...",
      "documentId": "doc_...",
      "knowledgeBaseId": "kb_...",
      "chunkIndex": 0,
      "content": "Zoneterapi arbejder med...",
      "headerBreadcrumb": "Zoneterapi > Effekt og virkning",
      "highlight": "...",
      "rank": 0.84
    }
  ]
}
```

### `POST /api/v1/knowledge-bases/:kbId/retrieve`

Det primære integrations-endpoint for site-LLM-orchestratorer.
Returnerer top-K chunks med fuld content + en pre-formatteret
`formattedContext`-streng der kan stuffes direkte ind i din site-LLM's
prompt — ingen second-pass `read`-kald nødvendigt.

**Request body**

```json
{
  "query": "klienten klager over dårlig søvn",
  "audience": "tool",
  "maxChars": 2000,
  "topK": 5,
  "tagFilter": ["sleep"]
}
```

| Field | Type | Default | Notes |
|---|---|---|---|
| `query` | string | required | Brugerens spørgsmål eller tematisk kerne. |
| `audience` | enum | `tool` for Bearer | Samme semantik som `/search`. |
| `maxChars` | int | `2000` | Hard upper-bound på `formattedContext.length`. Caps ved 8000. |
| `topK` | int | `5` | Max chunks før truncation. Caps ved 25. |
| `tagFilter` | string[] | `[]` | AND-filter på Neuron-tags. |

**Response (200)**

```json
{
  "chunks": [
    {
      "documentId": "doc_...",
      "seqId": "sanne_00000017",
      "title": "Zoneterapi",
      "neuronPath": "/neurons/zoneterapi.md",
      "content": "Zoneterapi arbejder med...",
      "headerBreadcrumb": "Zoneterapi > Effekt og virkning",
      "rank": 0.84
    }
  ],
  "formattedContext": "## Zoneterapi — Effekt og virkning\n\nZoneterapi arbejder med...\n\n## Jing — grundlæggende energi\n\n...",
  "totalChars": 1843,
  "hitCount": 3
}
```

**Tre vigtige garantier:**

1. **`formattedContext.length === totalChars`** — du kan budgettere uden at parse.
2. **Højere-rank chunks først** — vi tilføjer indtil næste chunk ville sprænge `maxChars`, så du får de mest relevante chunks fremfor mange laverelevant ones.
3. **Audience-filter er hård** — heuristic-Neurons og `internal`-tagged docs er aldrig i `tool`/`public`-resultater, end ikke ved direkte seqId-lookup.

**Quickstart eksempel — site-LLM-orchestrator (Anthropic SDK):**

```ts
async function trailRetrieve(query: string): Promise<string> {
  const res = await fetch(
    `${process.env.TRAIL_API_BASE}/api/v1/knowledge-bases/${process.env.TRAIL_KB_ID}/retrieve`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.TRAIL_API_KEY}`,
      },
      body: JSON.stringify({ query, audience: 'tool', maxChars: 2000, topK: 5 }),
    },
  );
  if (!res.ok) throw new Error(`Trail ${res.status}`);
  const data = await res.json();
  return data.formattedContext;  // klar til at stuffe ind i prompt
}

// I din orchestrator's tool-definition:
const tools = [{
  name: 'trail_retrieve',
  description: 'Hent relevant viden fra KB om brugerens spørgsmål.',
  input_schema: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
  },
}];

// Når LLM kalder værktøjet:
if (toolUse.name === 'trail_retrieve') {
  const ctx = await trailRetrieve(toolUse.input.query);
  // Send tilbage som tool_result; LLM bruger ctx som baggrund.
}
```

## Lag 2/3 — Chat (LLM på Trail-siden)

### `POST /api/v1/chat`

Ask a question scoped to one of the caller's Knowledge Bases. The
engine retrieves context, runs the configured chat backend (per-KB
chain or default), persists the turn pair, and returns the answer
plus citations.

**Request body**

```json
{
  "message": "Hvad anbefaler I før første behandling?",
  "knowledgeBaseId": "sanne-andersen",
  "sessionId": "chs_abc123…"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `message` | string | yes | The user's question. No length limit enforced server-side, but very long messages eat into the context budget. |
| `knowledgeBaseId` | string | yes | Either the canonical UUID **or** the slug. Slug-resolution is tenant-scoped, so you can hard-code `sanne-andersen` in your integration without leaking other tenants' KBs. |
| `sessionId` | string | optional | Omit on the first turn; the server creates a new session and returns its id. Echo the returned id on subsequent turns to maintain multi-turn memory. |

**Response (200)**

```json
{
  "answer": "Vi anbefaler at du …",
  "renderedAnswer": "Vi anbefaler at du …",
  "citations": [
    { "documentId": "doc_…", "path": "neurons/…", "filename": "Anbefalinger.md" }
  ],
  "sessionId": "chs_abc123…",
  "backend": "openrouter",
  "model": "google/gemini-2.5-flash",
  "turnsUsed": 3,
  "turnsLimit": 6
}
```

| Field | Notes |
|---|---|
| `answer` | Raw markdown with `[[wiki-links]]` left in place. Useful when your renderer wants to handle the links itself. |
| `renderedAnswer` | Same content with `[[…]]` rewritten to standard markdown links resolved against the tenant's KBs (cross-KB links work). Prefer this if you don't have your own wiki-link parser. |
| `citations[]` | The Neurons the answer drew from. `documentId` is the stable UUID; `path` and `filename` are display hints. |
| `sessionId` | Pin this on the next request to continue the conversation. |
| `backend`, `model` | The backend + model that actually answered (a fallback chain may have moved off your default). |
| `turnsUsed`, `turnsLimit` | F156 Phase 1 — the conversation turn budget after this turn. When `turnsUsed >= turnsLimit`, the next request returns 429; start a new chat by omitting `sessionId`. |

**Error responses**

```http
HTTP/1.1 429 Too Many Requests
Content-Type: application/json

{
  "error": "Session turn limit reached",
  "code": "session_turn_cap_reached",
  "turnsUsed": 6,
  "turnsLimit": 6
}
```

When you see `code: "session_turn_cap_reached"`: drop the current
`sessionId` from your client state and ask the user to start a new
chat. The next request without `sessionId` creates a fresh session.

```http
HTTP/1.1 500 Internal Server Error
Content-Type: application/json

{ "error": "<provider message>" }
```

The chat chain ran out of fallbacks. Surface a friendly message to your
user and offer a retry; the chain may succeed on the next attempt
(model-side rate-limit, transient outage).

### `GET /api/v1/knowledge-bases`

List the caller's Knowledge Bases. Useful when your integration lets
the user pick which Trail to chat with.

**Response (200)**

```json
[
  {
    "id": "kb_…",
    "slug": "sanne-andersen",
    "name": "Sanne Andersen",
    "description": "…",
    "createdAt": "2026-01-…"
  }
]
```

### `GET /api/v1/api-keys`

List your own non-revoked API keys (raw key never included). Useful
for an integration that wants to audit-display which key it's using.

**Response (200)**

```json
[
  { "id": "…", "name": "sanne-andersen.dk-prod", "lastUsedAt": "2026-04-26T…", "createdAt": "2026-04-…" }
]
```

## Conversation lifecycle

1. First turn — POST `/api/v1/chat` **without** `sessionId`. The server
   creates a session, returns its id.
2. Subsequent turns — POST with `sessionId` set. The server replays
   the last 10 turn-pairs into the LLM context so short follow-ups
   ("ja det vil jeg gerne") resolve correctly.
3. Hit the cap — when the response carries `turnsUsed === turnsLimit`,
   the next call with the same `sessionId` returns 429. Drop the id
   client-side and start a new chat.
4. Resume later — sessions persist forever. Pinning a known
   `sessionId` resumes the conversation as long as the cap hasn't
   been hit.

## Rate limits + quotas

There is no per-key rate limit in v1. The economic control is the
tenant's credit balance (F156): every chat turn deducts the measured
LLM cost from the tenant's credits. When the balance is exhausted,
chat continues on the soft buffer; ingest jobs gate harder. Future
versions (F44 Usage Metering) will add per-key telemetry and
opt-in rate limits.

**Lag 1 retrieval (`/search`, `/retrieve`) bruger ingen credits** —
det er ren DB-lookup. Det er hovedgrunden til at site-LLM-pattern
er billigere at drive end direct chat-embed.

**Cost-eksempel** for ~1000 brugerprompts/måned:

| Lag | Trail-side cost | Din site-side cost | Total per chat-turn |
|---|---|---|---|
| Lag 1 | 0 credits (DB-lookup) | 1× site-LLM-call (Flash ≈ $0.001) | ~$1/måned |
| Lag 2 | ~0.1 credits (Trail-LLM) | 1× site-LLM-call | ~$1/måned + 100 Trail-credits |
| Lag 3 | ~0.1 credits | 0 | ~100 Trail-credits |

Lag 1 og Lag 3 er omtrent ens i total cost — forskellen er hvor LLM-
syntesen sker. Lag 2 er den dyreste (begge sider kører LLM) og er
typisk kun værd det hvis du SKAL have prose-grounding men ikke vil
bygge en orchestrator.

## Quickstart

`.env` for your integration:

```bash
TRAIL_API_BASE=http://localhost:3000
TRAIL_API_KEY=trail_xxx
TRAIL_KB_ID=sanne-andersen
```

Operator sets on the Trail engine:

```bash
TRAIL_ALLOWED_ORIGINS=http://localhost:3001  # your integration's origin
```

Minimal client (TypeScript):

```ts
type ChatResponse = {
  answer: string;
  renderedAnswer: string;
  citations: { documentId: string; path: string; filename: string }[];
  sessionId: string;
  backend: string | null;
  model: string | null;
  turnsUsed: number;
  turnsLimit: number;
};

let sessionId: string | undefined;

async function ask(message: string): Promise<ChatResponse> {
  const res = await fetch(`${process.env.TRAIL_API_BASE}/api/v1/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.TRAIL_API_KEY}`,
    },
    body: JSON.stringify({
      message,
      knowledgeBaseId: process.env.TRAIL_KB_ID,
      sessionId,
    }),
  });

  if (res.status === 429) {
    const body = await res.json();
    if (body.code === 'session_turn_cap_reached') {
      sessionId = undefined; // start a new chat next time
      throw new Error('Chat limit reached — start a new conversation.');
    }
  }
  if (!res.ok) throw new Error(`Trail ${res.status}: ${await res.text()}`);

  const data = (await res.json()) as ChatResponse;
  sessionId = data.sessionId; // pin for next turn
  return data;
}
```

curl smoke test:

```bash
curl -sS -X POST "$TRAIL_API_BASE/api/v1/chat" \
  -H "Authorization: Bearer $TRAIL_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"message\":\"hej\",\"knowledgeBaseId\":\"$TRAIL_KB_ID\"}" \
  | jq .
```

## Versioning

Endpoints under `/api/v1` are stable; breaking changes get a `/api/v2`
namespace with overlap during deprecation. Field additions to existing
responses are non-breaking — write your client to ignore unknown
fields. F156 Phase 1's `turnsUsed`/`turnsLimit` are an example: they
arrived without a `v2` bump and clients that ignored them kept
working.
