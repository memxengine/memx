# Trail HTTP API for Integrators

The stable, integration-facing contract for the Trail HTTP API. This is what
a third-party site, mobile app, or script written in another repo should
read — it documents only the endpoints we will support across versions.
The internal admin API (queue mutations, KB CRUD, lint internals) is not
listed here because it is not a stable contract.

> Engine version: any post-F156 build. Auth, conversation, and turn-cap
> behaviour are stable from the F156 Phase 1 release onward.

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

For a public-facing integration: assume a Hobby-tier tenant has
~100 credits/month and a default-Flash chat costs ~0.1 credits/turn.
That's ~1 000 chats per month before top-up. If your integration is
latency-sensitive, cache the previous turn's answer client-side so
you can show stale-but-relevant content during the LLM round-trip.

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
