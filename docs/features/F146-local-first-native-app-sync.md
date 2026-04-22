# F146 — Local-first native app + CRDT sync

> "Built on CRDTs. Your knowledge graph lives locally for zero-latency access, syncing securely to the cloud when connected."

Trail as a native desktop app (Mac / Windows / Linux) that runs the full engine locally, syncs to the cloud via CRDT, and — crucially — owns its own compute so `claude -p` subprocess ingest stays legal and cost-controlled at scale. The cloud remains the source of truth for retrieval + chat + cross-device sync; the local app is the power-user tier that lets a curator drop 500 PDFs on a Saturday and wake Monday to a compiled KB without blowing through API quotas.

## Why this matters

Two unrelated problems collapse into one solution.

**Problem 1 — the API ingest cost wall.** Post-cloud-launch, every ingest goes through the paid API path (no more `claude -p` subprocess since there's no user shell to spawn from). A 200-source batch at F137 chunked rates is ~$20-40 in API tokens, and the latency is always network-bound. For bulk initial imports (e.g. Sanne's 15-year case library, FysioDK's patient protocols), that's a business-model problem before it's an engineering problem.

**Problem 2 — the local-first UX gap.** Users who already use Obsidian / Logseq / Notion-offline expect instant reads, offline edits, and automatic merge. A pure SaaS with spinner on every query is a regression for that audience. F146 gives them a real local store without losing the "accessible from any device" value prop of the cloud product.

**The pattern**: run Trail's engine in a native shell on the user's machine. Ingest (compile) happens locally — user's `claude -p` licence, user's hardware, zero API tokens for the LLM step. Compiled Neurons + events stream to the cloud via CRDT sync. Retrieval and chat can hit either side (cloud for phone, local for desktop). The two stores converge via CRDT merge, no "which version wins" dialogs.

## Scope

### In — Phase 3 (enterprise / power-user tier)

- **Native shell**: the existing `apps/server` engine packaged into a native binary. Electron is the safe default (broad platform coverage, we already ship TypeScript); Tauri is the lightweight alternative (smaller binary, Rust runtime) if Electron's footprint becomes a problem post-MVP.
- **Local LLM subprocess ingest**: the `claude -p` codepath that already works today (F06) stays intact on native. On cloud-only accounts, ingest routes via API. The split is a per-tenant flag + per-KB default — a tenant can have both a local app installed and cloud retrieval.
- **CRDT sync layer**: one CRDT document per KB, containing wiki_events + queue_candidates + documents rollups. F16 already writes an event log — CRDT on top is largely a re-encoding + merge helper, not a new model. Yjs is the default candidate (mature, streaming-capable, existing bindings for SQLite-style backends).
- **Cloud as source of truth for retrieval**: chat / search / embed widget hit the cloud engine, which holds a merged view of every device's contributions. The local app can also serve retrieval when offline, using its own merged view.
- **Plan tiers**: Hobby + Pro = cloud-only (API ingest). Business + Enterprise = local app available (subprocess ingest). Nudge the "you have a big import" flow to mention the native app when it would save them money.

### User-side prerequisite: Anthropic Pro or Max subscription

The native app's subprocess ingest depends on `claude -p` being installed
and logged in on the user's machine. `claude -p` authenticates against the
user's **Anthropic Pro or Max subscription** — it is NOT a standalone tool
we can bundle.

**Verified via Anthropic pricing (2026-04-22):** Claude Code is explicitly
included in Pro (~$20/mo) and Max (~$100+/mo). The CLI surface — `claude`
and `claude -p` — is part of the Claude Code offering across all surfaces
(Terminal, VS Code, JetBrains, Desktop, Web). Rumors that Claude Code is
Max-only or API-only are not current — Pro is sufficient.

Tier guidance for Trail native users:

| Anthropic tier | Fit for Trail native ingest |
|---|---|
| **Pro** (~$20/mo) | Works for typical curator flow — a few sources per day, occasional 10-20-source batch. Hits Pro's usage ceiling (~5h rolling window) on genuinely large imports. |
| **Max** (~$100-200/mo) | Recommended for bulk-import users (Sanne's 15y case archive, FysioDK's full protocol library). 5-20× Pro's ceiling, comfortable for 200+ sources in a single weekend. |

A Business / Enterprise Trail user on the native tier needs TWO
subscriptions running in parallel:

1. **Trail** (our business + enterprise plan) — covers retrieval, chat,
   cloud sync, multi-device.
2. **Anthropic Pro or Max** (user's own subscription, separate billing
   from Trail) — covers the LLM compute for local ingest runs.

Trail's onboarding + docs must surface this upfront. The economic point
holds: a 200-source import that costs $30-40 via our API path costs $0
marginal against an already-paid Anthropic sub — that's the entire reason
native exists.

The install flow on native must detect missing `claude -p` / unauthenticated
state and link out to Anthropic's subscription page with a clear "why you
need this" explainer — not fail silently.

### Out (future phases)

- Real-time collaborative editing (CRDT enables it architecturally, but the UX is not the v1 story — F76 covers that).
- Peer-to-peer sync without the cloud relay. Cloud stays in the middle for consistency of the retrieval view.
- iOS / Android native. Mobile stays as the existing web client against the cloud.
- Plugin API for third-party tools reading the local CRDT directly. Revisit after the native shell ships.

## Architecture sketch

```
┌──────────────────── native app (Mac/Win/Linux) ────────────────────┐
│                                                                    │
│  ┌─ Preact UI (same as apps/admin) ─┐   ┌─ bun engine ───────────┐ │
│  │                                  │   │                        │ │
│  │  Queue / Neurons / Chat / ...    │◄──►  @libsql/client (SQLite)│ │
│  │                                  │   │                        │ │
│  └──────────────────────────────────┘   │  claude -p subprocess  │ │
│                                         │  (F06 ingest path)     │ │
│                                         └─────────┬──────────────┘ │
│                                                   │                │
│                                         ┌─────────▼──────────────┐ │
│                                         │  CRDT sync worker      │ │
│                                         │  (Yjs, streaming)      │ │
│                                         └─────────┬──────────────┘ │
└────────────────────────────────────────────────────┼───────────────┘
                                                     │
                                            TLS / WebSocket
                                                     │
┌────────────────────────────────────────────────────▼───────────────┐
│  cloud engine (Fly.io arn)                                         │
│                                                                    │
│  CRDT relay  ↔  libSQL per-tenant DB  ↔  chat / search / widget    │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

The engine code is unchanged between native and cloud — same bun process, same tables, same HTTP routes. The differences are:

1. **How ingest runs**: native spawns `claude -p` (F06 codepath); cloud calls the Anthropic Messages API (F14 adapter already supports both).
2. **How state syncs**: a sync-worker co-hosted with the engine pushes local wiki_events + queue_candidates through a CRDT encoder and streams it to the cloud relay over WSS. The cloud relay writes the CRDT state back into its own per-tenant libSQL + signals other devices.
3. **How retrieval runs**: native retrieval hits local SQLite; cloud retrieval hits cloud libSQL. Both see the same merged state (CRDT guarantee).

## CRDT choice: Yjs

- **Why Yjs over Automerge**: Yjs streams deltas instead of shipping full document snapshots — critical when wiki_events tables grow to 100k+ rows. Automerge is ergonomic for dev but the full-history-in-memory default breaks at the scale Trail operates at.
- **Granularity**: one Yjs document per KB. KBs are the natural sync boundary (tenant isolation + cross-tenant knowledge stays separate).
- **What lives in the CRDT**: `wiki_events` (the append-only log), `queue_candidates` (pending work), and a projection of `documents` derived from events. The FTS index (`documents_fts`) is local-only — rebuilt from the CRDT state on sync, not synced itself.
- **What does NOT live in the CRDT**: access tokens, tenant config, storage-adapter state. Those are cloud-authoritative. The native app reads them on login, caches for offline, never writes them.

## Dependencies + sequencing

Depends on:

- **F40.2** (multi-tenant cloud) — each tenant's CRDT relay needs its own per-tenant DB. No point building F146 until the cloud is multi-tenant.
- **F42** (pluggable storage) — native app uses local disk, cloud uses R2/Tigris, both behind the same adapter.
- **F14** (multi-provider LLM adapter) — already handles claude -p vs API, no new work.
- **F16** (wiki_events) — the CRDT substrate. Already built. The F146 encoder wraps it.

Enables:

- **F76** (real-time collaboration). CRDT is the foundation; UX on top is the feature.
- **F82** (custom LLM providers). Local app can point `claude -p` at Ollama / LM Studio for fully-offline ingest. Not day-1 scope but drops out naturally.
- **F74 / F75** (time-travel, undo-redo). CRDT provides the history; routes are small.

Blocked-by-decisions:

- **Electron vs Tauri** — decide before implementation starts. Tauri needs Rust knowledge in the team; Electron needs no new expertise but costs ~100MB more on user's disk.
- **Self-hosted sync relay vs managed** — Yjs has y-websocket as reference, but a production relay needs auth + multi-tenant routing. Cloud engine can embed the relay; that keeps ops simple but scales differently from the HTTP engine.

## Rollout plan

This is a Phase 3 feature — not landing before multi-tenant cloud, billing, and F37 (Sanne onboarding) are live. Rough ordering once the gate opens:

1. **Spike**: 2-3 day exploration — pick Electron vs Tauri by actually packaging the bun engine into both and comparing binary size + startup time. Deliverable: a spike PR (kept on a branch, not merged) that launches Trail admin in a native window on Mac.
2. **Sync protocol proof**: Yjs encoder around wiki_events + a minimal WSS relay on cloud. Two native instances converging on the same KB. Deliverable: a 10-line script that shows `wiki_events.count` matching on both sides after a disconnect+reconnect.
3. **Ingest mode routing**: per-tenant flag on the Settings panel. Local spawns claude -p; cloud routes via API. Deliverable: end-to-end ingest working in both modes, user toggling between them.
4. **CRDT-aware queue**: pending candidates need to converge. Two native instances approving the same candidate must land a single "ingested" event, not duplicate. Deliverable: concurrent-approve test passes.
5. **Ship to enterprise tier**: gated by plan, opt-in install. First user: FysioDK (large protocol library).

Estimated total effort: 3-4 weeks of focused work, distributed across a few months given dependencies.

## Non-goals / explicit decisions

- **Not replacing the cloud engine.** Cloud stays the default. Native is an add-on for tenants who want it.
- **Not a "download your KB" feature.** Users don't manually export/import — sync is continuous, automatic, conflict-free.
- **Not shipping a full mobile app via React Native / Capacitor.** Mobile uses the existing web UI against the cloud. Local-first on mobile is a separate F-number if it ever happens.
- **Not integrating Obsidian / Logseq.** F25 (image pipeline) + F26 (HTML clipper) cover import; the native app is a distinct product, not a plugin for existing apps.

## Related but distinct

- **F13** (LocalStorage adapter) — lets the browser admin UI cache state. Orthogonal to F146; the native app doesn't need F13 because it owns its whole SQLite.
- **F111** (web clipper) — ingestion connector, cloud-side. The native app happens to be a faster path for bulk clips, but the clipper itself is not native-specific.
- **F16** (wiki_events) — the event-sourced substrate that makes CRDT merge tractable. F146 is the sync layer on top.

## Open questions

- Should the native app also spawn its own MCP server for local `cc` sessions writing into it? (Probably yes — same behaviour as today's dev setup.)
- Tauri's WebView embedding on Linux is less mature than Electron's Chromium — are we OK with a reduced-platform launch (Mac + Win native, Linux via AppImage using Electron)?
- Plan-tier gating: should "bulk import" UX nudge cloud users toward the native app, or should we leave discovery organic?
