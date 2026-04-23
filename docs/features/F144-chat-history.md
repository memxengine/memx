# F144 — Chat history persistence

> Today the Chat tab lives only in a React `useState` hook. Any route-change, reload, tab-close, or server redeploy wipes the entire conversation. A curator who asks "what does my KB say about X?", gets a 14-second LLM answer with citations, clicks one of the citation links to verify — and clicks back, only to find the chat blank. Every valuable Q&A is one misclick from oblivion. Persist chat turns server-side so the conversation survives navigation, reload, device-switch, and server-restart. Tier: alle. Effort: ~1.5 day.

## Problem

`apps/admin/src/panels/chat.tsx:37` — `const [turns, setTurns] = useState<Turn[]>([]);`. That's the whole chat history. Component unmount → GC → gone.

Concrete breakage path:

1. Curator opens `/kb/trail-research/chat`, asks "sammenlign Karpathy's gist med vores Trail-compile-at-ingest". Waits 14 s. Gets good answer with 5 citations.
2. Clicks `[[As We May Think]]` citation. Router navigates to `/kb/trail-research/neurons/as-we-may-think-the-1945-vision-that-became-trail`. Neuron-reader shows **Neuron not found** (slug drifted — orthogonal bug, tracked separately).
3. Curator clicks browser-back. Router re-mounts `ChatPanel`. `useState([])` → feed is blank.

Secondary pain points:

- **No cross-device continuity**. Desktop curator's chats aren't visible on mobile, and vice versa.
- **No "go back to that answer from Tuesday"**. The save-to-queue button exists, but not every chat-turn is Neuron-worthy — sometimes you just want to re-read the answer.
- **No LLM-budget visibility across the day**. Every turn's token-spend is lost, so the F121 per-tenant budget tracking has no audit trail for ad-hoc chat (only for ingest).

## Secondary Pain Points

- No way to reference a previous chat answer when formulating a follow-up question
- Token spend per chat session is invisible (F121 budget tracking gap)
- No search across past conversations

## Solution

Two small SQLite tables + a REST endpoint + a sidebar list in the Chat panel. Scoped per-KB (matches URL structure `/kb/:kbId/chat`).

### Schema — migration 0008_chat_history.sql

```sql
CREATE TABLE chat_sessions (
  id TEXT PRIMARY KEY,
  knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  title TEXT,                      -- auto-derived from first user turn, editable
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_chat_sessions_kb ON chat_sessions(knowledge_base_id, archived, updated_at DESC);

CREATE TABLE chat_turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  citations TEXT,                  -- JSON [{ title, slug, neuronId }]
  tokens_in INTEGER,
  tokens_out INTEGER,
  latency_ms INTEGER,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_chat_turns_session ON chat_turns(session_id, created_at);
```

No separate `chat_citations` table — citations are a JSON column on the turn. Cardinality is bounded (typically 3–10 per turn), and we never query them relationally.

### API

- `GET /api/v1/knowledge-bases/:kbId/chat/sessions?archived=<bool|all>` → list sessions (title, last-turn-preview, turn count, updated_at)
- `POST /api/v1/knowledge-bases/:kbId/chat/sessions` → create new session (returns id)
- `GET /api/v1/chat/sessions/:sessionId` → full session with all turns
- `POST /api/v1/chat/sessions/:sessionId/turns` → append a turn (both user-send and assistant-response write turns)
- `PATCH /api/v1/chat/sessions/:sessionId` → rename / archive
- `DELETE /api/v1/chat/sessions/:sessionId` → hard delete (for user-requested purge)

The existing `POST /api/v1/chat` answer-endpoint keeps its shape; the client adds a `sessionId` parameter and calls the turns-endpoint before+after.

### UX — `panels/chat.tsx`

Layout grows from one-column-feed to **two columns on desktop, collapsible drawer on mobile**:

```
+------------------+----------------------------+
| Sessions         | Active session             |
|                  |                            |
| > Today          | turn 1 (user)              |
|   Karpathy diff  | turn 2 (assistant)         |
|   14:22 · 3 turns|                            |
| > Yesterday      | turn 3 (user) ...          |
|   F143 design    |                            |
|                  |                            |
| [+ New chat]     | [input ____________] [Ask] |
+------------------+----------------------------+
```

- Sessions grouped by day (Today / Yesterday / This week / Earlier) — matches Claude.ai / ChatGPT idiom.
- Click a session → loads turns into the feed. Keeps the current save-to-queue button on each assistant turn.
- `[+ New chat]` clears the feed and creates a fresh session on first `Ask`.
- Right-click / hover-menu per session → **Rename**, **Archive**, **Delete** (custom modal, not `window.confirm`).
- Title is auto-derived from the first user-turn on session-creation: truncate to ≤60 chars, strip trailing punctuation. Editable via Rename.

### Token/cost visibility (ties into F121)

`tokens_in` / `tokens_out` / `latency_ms` come from the existing chat-LLM wrapper — currently discarded. Capture them on turn-write. Surface in the session-list as a subtle monospace number ("3 turns · 12k tok") and in a per-session footer. Same wrapper already feeds F121 budget-tracking; this just gives chat its own cost ledger.

## Non-Goals

- **Cross-KB search across chats** — out of scope. Sessions are per-KB; if the user needs multi-KB, they switch KB and see that KB's sessions.
- **Sharing a chat via URL** — not needed for solo curator. Revisit if team mode (F40 multi-tenancy) surfaces it.
- **Real-time collab (multiple curators in same session)** — no.
- **Streaming turn-persistence** — the turn is written when the answer completes, not token-by-token. If the server crashes mid-answer, the turn is lost; user re-asks. Good enough for MVP.

## Technical Design

### Session management

```typescript
// apps/server/src/routes/chat-sessions.ts
export const chatSessionRoutes = new Hono();

chatSessionRoutes.get('/knowledge-bases/:kbId/chat/sessions', async (c) => {
  const sessions = await db.select()
    .from(chatSessions)
    .where(and(
      eq(chatSessions.knowledgeBaseId, c.req.param('kbId')),
      eq(chatSessions.archived, 0),
    ))
    .orderBy(desc(chatSessions.updatedAt));
  return c.json({ sessions });
});

chatSessionRoutes.post('/knowledge-bases/:kbId/chat/sessions', async (c) => {
  const session = await db.insert(chatSessions).values({
    id: generateId(),
    knowledgeBaseId: c.req.param('kbId'),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).returning().get();
  return c.json(session, 201);
});
```

### Turn append

```typescript
chatSessionRoutes.post('/chat/sessions/:sessionId/turns', async (c) => {
  const { role, content, citations, tokensIn, tokensOut, latencyMs } = await c.req.json();
  const turn = await db.insert(chatTurns).values({
    id: generateId(),
    sessionId: c.req.param('sessionId'),
    role, content,
    citations: citations ? JSON.stringify(citations) : null,
    tokensIn, tokensOut, latencyMs,
    createdAt: new Date().toISOString(),
  }).returning().get();

  // Update session's updated_at
  await db.update(chatSessions)
    .set({ updatedAt: new Date().toISOString() })
    .where(eq(chatSessions.id, c.req.param('sessionId')));

  // Auto-derive title from first user turn
  if (role === 'user') {
    const session = await db.select().from(chatSessions)
      .where(eq(chatSessions.id, c.req.param('sessionId'))).get();
    if (!session.title) {
      await db.update(chatSessions)
        .set({ title: content.slice(0, 60).replace(/[.!?]+$/, '') })
        .where(eq(chatSessions.id, c.req.param('sessionId')));
    }
  }

  return c.json(turn, 201);
});
```

### Client hook

```typescript
// apps/admin/src/hooks/useChatSession.ts
function useChatSession(kbId: string, sessionId: string | null) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!sessionId) return;
    setLoading(true);
    fetch(`/api/v1/chat/sessions/${sessionId}`)
      .then(r => r.json())
      .then(data => { setTurns(data.turns); setLoading(false); });
  }, [sessionId]);

  const appendTurn = async (turn: Turn) => {
    await fetch(`/api/v1/chat/sessions/${sessionId}/turns`, {
      method: 'POST',
      body: JSON.stringify(turn),
    });
    setTurns(prev => [...prev, turn]);
  };

  return { turns, loading, appendTurn };
}
```

### Citation resilience

When a cited Neuron's slug changes (rename, delete), the stored citation still links to the old slug and breaks. **Store `neuronId` as the primary key in citations JSON, title+slug as display-only**. Captures the lesson from the As-We-May-Think dead-end.

## Interface

### API Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/knowledge-bases/:kbId/chat/sessions` | List sessions (grouped by day) |
| POST | `/knowledge-bases/:kbId/chat/sessions` | Create new session |
| GET | `/chat/sessions/:sessionId` | Full session with all turns |
| POST | `/chat/sessions/:sessionId/turns` | Append a turn |
| PATCH | `/chat/sessions/:sessionId` | Rename / archive |
| DELETE | `/chat/sessions/:sessionId` | Hard delete |

### DB Tables

`chat_sessions` — session metadata (title, created_at, updated_at, archived)
`chat_turns` — individual turns (role, content, citations, tokens, latency)

### Admin UI

- Two-column layout on desktop (sidebar + feed)
- Collapsible drawer on mobile (< 768px)
- Session grouping: Today / Yesterday / This week / Earlier
- Hover menu: Rename, Archive, Delete (custom modal)
- Token count display: "3 turns · 12k tok"

## Rollout

1. **Migration + server routes** (half day). Add `chat_sessions` + `chat_turns` tables, REST endpoints, wire the existing `/chat` answer-path to write turns.
2. **Client rewrite of `panels/chat.tsx`** (half day). Sidebar list + active-session feed + new-chat / rename / archive / delete modals. Replace `useState<Turn[]>` with `useSession(sessionId)` hook that fetches from server + caches.
3. **Mobile drawer** (quarter day). Collapse sidebar into a slide-in drawer below 768px.
4. **Token ledger** (quarter day). Capture tokens on the answer-endpoint, display in sidebar + footer.

## Success Criteria

- Navigation away from chat tab → return → conversation persists
- Browser reload → same session restored
- New chat creates session on first `Ask`
- Session title auto-derived from first user turn (≤60 chars)
- Rename / Archive / Delete work via custom modal (no `window.confirm`)
- Token counts captured and displayed in sidebar
- Cross-device: same KB's sessions visible from any device

## Impact Analysis

### Files created (new)
- `apps/server/src/routes/chat-sessions.ts`
- `apps/admin/src/hooks/useChatSession.ts`
- `packages/db/drizzle/migrations/0008_chat_history.sql`

### Files modified
- `packages/db/src/schema.ts` — add `chatSessions` + `chatTurns` tables
- `apps/admin/src/panels/chat.tsx` — sidebar list + session management
- `apps/server/src/routes/chat.ts` (F89) — capture tokens on answer, write turns
- `apps/admin/src/api.ts` — chat session API functions

### Downstream dependents
`apps/admin/src/panels/chat.tsx` is imported by 1 file:
- `apps/admin/src/main.tsx` (1 ref) — mounts ChatPanel, unaffected

`apps/server/src/routes/chat.ts` is imported by 1 file:
- `apps/server/src/app.ts` (1 ref) — mounts route, unaffected

### Blast radius

Low. Chat is isolated feature. No other features depend on chat state.

### Breaking changes

None — all changes are additive.

### Test plan

- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Migration kører uden fejl
- [ ] POST /chat/sessions → new session created
- [ ] POST /chat/sessions/:id/turns → turn appended, session updated_at refreshed
- [ ] First user turn → session title auto-derived
- [ ] Navigate away → return → turns persist
- [ ] Browser reload → same session restored
- [ ] Rename session → title updates
- [ ] Archive session → disappears from list (but not deleted)
- [ ] Delete session → hard delete, turns cascade
- [ ] Token counts captured and displayed
- [ ] Mobile: sidebar collapses to drawer below 768px
- [ ] Regression: existing chat answer endpoint still works

## Implementation Steps

1. Migration: `chat_sessions` + `chat_turns` tables.
2. Schema updates in `packages/db/src/schema.ts`.
3. Chat session routes (CRUD + turns append).
4. Wire existing `/chat` answer-path to write turns.
5. Client rewrite of `panels/chat.tsx` with sidebar + session hook.
6. New chat / rename / archive / delete modals.
7. Mobile drawer (collapsible sidebar).
8. Token capture + display.
9. i18n pass.

## Dependencies

- F121 (Per-Tenant LLM Budget Tracking — token ledger feeds budget)
- F89 (Chat Tools — orthogonal; chat-tool invocations persist as turn metadata)
- F105 (Proactive Save Suggestions in Chat — triggers on assistant turns)
- F143 (Persistent ingest queue — same architectural pattern)

## Open Questions

- **Retention** — forever, or auto-archive after N days? Default: forever, archive only on explicit user action. SQLite can hold millions of turns on a laptop.
- **Citation resilience** — when a cited Neuron's slug changes (rename, delete), the stored citation still links to the old slug and breaks. Should the citation resolve by `neuronId` (stable UUID) with title drawn live, so rename survives? **Yes — store `neuronId` as the primary key in citations JSON, title+slug as display-only**. Captures the lesson from the As-We-May-Think dead-end.

## Related Features

- **F121** — Per-Tenant LLM Budget Tracking (token ledger feeds F121)
- **F89** — Chat Tools (chat-tool invocations persist as turn metadata)
- **F105** — Proactive Save Suggestions in Chat (triggers on assistant turns)
- **F143** — Persistent ingest queue (same architectural pattern: ephemeral → SQLite)

## Effort Estimate

**Medium** — ~1.5 days.
- 0.5 day: migration + server routes
- 0.5 day: client rewrite (sidebar + session hook + modals)
- 0.25 day: mobile drawer
- 0.25 day: token ledger + display
