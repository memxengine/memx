# trail

## Peer intercom (buddy)

This workspace runs alongside other cc sessions in other repos (monitored by buddy).

**To reach Christian on his iPhone**: just answer naturally. Your reply
becomes a turn that lands in YOUR session's Chat tab on his phone via the
Stop hook → SSE pipe. No special tool needed. If Christian asks you to
"send X to my mobile", that means: write X as your normal response — he
will see it on the Chat tab for your session.

**To reach another cc session** (cc-to-cc — NOT visible on mobile), use
the buddy peer tools:

- `mcp__buddy__ask_peer({ to, message, reply_to? })` — direct 1:1 message to a named session (supports threading via `reply_to`)
- `mcp__buddy__announce({ message, severity?, affects? })` — broadcast FYI to same-repo peers

Use peer tools before disruptive changes, to delegate work the user asks
you to hand off, or to ask a peer that owns a different domain. Incoming
peer messages arrive as `<channel type="intercom" from="..." announcement_id="N">`
and live ONLY in the receiving cc's context — they are never auto-forwarded
to Christian's phone.

## Dogfooding — save Trail development into Trail

Trail is used to store Trail's own development knowledge. Every non-trivial
decision, bug diagnosis, convention, or rejected approach you make in this
session should land as a Neuron in the Trail admin KB for this repo — so
future cc sessions can search/chat over past reasoning instead of re-
deriving it.

**Three transports, pick by who's making the decision to write** (from F39):

| Transport | When cc uses it |
|---|---|
| `mcp__buddy__trail_save(...)` | Call at natural milestones: feature ship, bug diagnosed, architectural choice made. Buddy does the summarising + routes to Trail. **Preferred when buddy is live.** |
| `mcp__trail__write(command="create", ...)` | When you want to author the Neuron yourself mid-turn (e.g. a specific design note that needs a particular shape). Only available when Trail's MCP is configured in the cc session's `.mcp.json`. |
| `POST /api/v1/queue/candidates` with `Authorization: Bearer $TRAIL_INGEST_TOKEN` | Scripts, CI hooks, anything non-interactive. `kind: "external-feed"`, path `/neurons/sessions/broberg-ai/trail/`. |

**What deserves a Neuron** (not every turn):
- "Why X over Y" — architectural choices + the alternatives rejected and why.
- Bug fixes where the root cause is non-obvious (the commit message covers what; the Neuron covers why it's subtle).
- Conventions established mid-session ("all new LLM calls must go through spawnClaude, not fetch — see F90.1 ingest.ts").
- Interop quirks with peer sessions (trail-sound, cms-core).

**What doesn't**:
- Typo fixes, routine git ops, `pnpm typecheck` runs.
- Things already documented in F-docs or ROADMAP.md.
- Code-behaviour that well-named identifiers already explain.

**Target path**: `/neurons/sessions/broberg-ai/trail/` under the Trail KB
Christian uses for this repo. Tags: feature number if applicable (F90, F91),
area (ingest, queue, ui), kind (decision, bug-fix, convention).

**If none of these tools are live in your session**, say so explicitly to
Christian at the top of the session — he'll decide whether to wire up
bearer-token + POST or wait for the MCP/buddy path to land. Silent
"I don't have a tool for that" is the wrong answer; dogfooding is an
explicit project value.

## F95 — Connectors (ingestion attribution)

Every candidate carries `metadata.connector` — one of the ids defined in
`packages/shared/src/connectors.ts`. The Queue UI filters on it and the
Neuron reader shows "Created via <connector>" attribution.

**Connector ids that matter for cc sessions:**

| id | When it's set |
|---|---|
| `mcp:claude-code` | A Claude Code cc session writes via trail MCP. Set in `.mcp.json` env. |
| `mcp:cursor` | Cursor writes via trail MCP. Set in its MCP config. |
| `buddy` | A `mcp__buddy__trail_save` call routes through buddy's external-feed transport. |
| `upload` | The file-upload ingest pipeline compiles Neurons. |
| `chat` | Curator saves a chat answer. |
| `curator` | Direct edit via the Neuron editor. |
| `lint` | Orphan / contradiction / stale detector emits a finding. |

**How to make sure your session identifies correctly**:

1. This repo's `.mcp.json` already sets `TRAIL_CONNECTOR=mcp:claude-code`
   so every Neuron written via `mcp__trail__write` gets attributed to
   Claude Code. Don't change it unless you know why.
2. If you write via `mcp__buddy__trail_save`, buddy stamps
   `metadata.source=buddy` and the engine's `stampConnector()` in
   `packages/core/src/queue/candidates.ts` infers `connector=buddy`.
   Nothing for you to do.
3. If you're writing via `POST /api/v1/queue/candidates` (script or CI),
   include `"connector": "api"` or a more specific id in the metadata
   JSON so attribution is explicit rather than heuristic-inferred.

**Adding a new connector** (e.g. when the Slack ingest ships):

1. Add entry to `CONNECTORS` in `packages/shared/src/connectors.ts`
   with `status: 'live'`.
2. At the write site that emits candidates from that connector, set
   `metadata.connector` to the id.
3. The admin Queue filter picks it up automatically on next build.

Roadmap ids (`slack`, `discord`, `notion`, `github`, `linear`) are
already stubbed out as `status: 'roadmap'` — flip them to `'live'` when
the implementation lands.

## Verification before "this works"

Typecheck is not verification. `pnpm typecheck` only proves the code
compiles — it proves nothing about runtime behaviour, env-var plumbing,
DB-column presence, migration side-effects, or MCP-subprocess env
forwarding. Confirmations like "shipped, working" require runtime proof.

**Before claiming a fix works, write a local TypeScript script that
exercises the exact code path end-to-end** and prints the observable
effect. Put the script under `apps/server/scripts/verify-<feature>.ts`
and run it with `bun run`.

Examples of what the script must prove, NOT infer:

- **DB column** — `SELECT name FROM pragma_table_info('…') WHERE name='…'`
  returns the column AND a subsequent `INSERT … VALUES (…)` / `SELECT`
  round-trips a real value through it.
- **Migration** — both `__drizzle_migrations` has the hash AND the DDL
  effect (column / index / constraint) is present. Drizzle recording a
  migration is not the same as the DDL landing. Verify both.
- **Env to subprocess** — don't assume child processes inherit. Spawn
  the exact subprocess you care about and read back its `process.env`.
  For MCP specifically: claude CLI does NOT forward parent env to the
  MCP subprocess it spawns; env must be written into the mcp-config
  file's `env` block. See `writeIngestMcpConfig` in
  `apps/server/src/lib/mcp-config.ts`.
- **Cross-table effect** — if a write is supposed to produce a row in
  table B, `SELECT COUNT(*) FROM B WHERE …` after the write and assert
  the delta is what you expected.

Avoid burning LLM tokens on "let me try a real ingest and see" when a
30-line script + direct SQL would answer the question. A real ingest
costs tokens + 1-10 min of wall-clock; the script costs milliseconds
and you can run it a hundred times.

**The rule**: if you say "shipped" or "verified" without having run a
scripted end-to-end probe, you are making a claim about something you
haven't checked. Don't do it.
