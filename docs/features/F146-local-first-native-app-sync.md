# F146 — Local-first native app + CRDT sync

> "Built on CRDTs. Your knowledge graph lives locally for zero-latency access, syncing securely to the cloud when connected."

Trail as a native desktop app (Mac / Windows / Linux) that runs the full engine locally, syncs to the cloud via CRDT, and — crucially — owns its own compute so `claude -p` subprocess ingest stays legal and cost-controlled at scale. The cloud remains the source of truth for retrieval + chat + cross-device sync; the local app is the power-user tier that lets a curator drop 500 PDFs on a Saturday and wake Monday to a compiled KB without blowing through API quotas. Tier: Enterprise. Effort: 3-4 weeks.

## Why this matters

Two unrelated problems collapse into one solution.

**Problem 1 — the API ingest cost wall.** Post-cloud-launch, every ingest goes through the paid API path (no more `claude -p` subprocess since there's no user shell to spawn from). A 200-source batch at F137 chunked rates is ~$20-40 in API tokens, and the latency is always network-bound. For bulk initial imports (e.g. Sanne's 15-year case library, FysioDK's patient protocols), that's a business-model problem before it's an engineering problem.

**Problem 2 — the local-first UX gap.** Users who already use Obsidian / Logseq / Notion-offline expect instant reads, offline edits, and automatic merge. A pure SaaS with spinner on every query is a regression for that audience. F146 gives them a real local store without losing the "accessible from any device" value prop of the cloud product.

**The pattern**: run Trail's engine in a native shell on the user's machine. Ingest (compile) happens locally — user's `claude -p` licence, user's hardware, zero API tokens for the LLM step. Compiled Neurons + events stream to the cloud via CRDT sync. Retrieval and chat can hit either side (cloud for phone, local for desktop). The two stores converge via CRDT merge, no "which version wins" dialogs.

## Secondary Pain Points

- No offline access to KB content
- API rate limits block large batch imports
- No local compute for users with existing Anthropic subscriptions

## Solution / Scope

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

## Non-Goals

- **Replacing the cloud engine.** Cloud stays the default. Native is an add-on for tenants who want it.
- **"Download your KB" feature.** Users don't manually export/import — sync is continuous, automatic, conflict-free.
- **Full mobile app via React Native / Capacitor.** Mobile uses the existing web UI against the cloud. Local-first on mobile is a separate F-number if it ever happens.
- **Integrating Obsidian / Logseq.** F25 (image pipeline) + F26 (HTML clipper) cover import; the native app is a distinct product, not a plugin for existing apps.

## Technical Design

### Architecture sketch

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

### CRDT choice: Yjs

- **Why Yjs over Automerge**: Yjs streams deltas instead of shipping full document snapshots — critical when wiki_events tables grow to 100k+ rows. Automerge is ergonomic for dev but the full-history-in-memory default breaks at the scale Trail operates at.
- **Granularity**: one Yjs document per KB. KBs are the natural sync boundary (tenant isolation + cross-tenant knowledge stays separate).
- **What lives in the CRDT**: `wiki_events` (the append-only log), `queue_candidates` (pending work), and a projection of `documents` derived from events. The FTS index (`documents_fts`) is local-only — rebuilt from the CRDT state on sync, not synced itself.
- **What does NOT live in the CRDT**: access tokens, tenant config, storage-adapter state. Those are cloud-authoritative. The native app reads them on login, caches for offline, never writes them.

## Interface

### Native app surface

- Same Preact UI as `apps/admin` — shared components
- Local SQLite via `@libsql/client`
- `claude -p` subprocess for ingest
- CRDT sync worker (Yjs, WSS to cloud relay)

### Cloud relay

- WSS endpoint for CRDT sync
- Per-tenant DB (libSQL)
- Merged view of all devices' contributions

### Install flow

1. Detect `claude -p` availability
2. If missing/unauthenticated → link to Anthropic subscription page
3. On first launch → login to Trail cloud → sync existing KBs
4. Ready for local ingest

## Rollout

This is a Phase 3 feature — not landing before multi-tenant cloud, billing, and F37 (Sanne onboarding) are live. Rough ordering once the gate opens:

1. **Spike**: 2-3 day exploration — pick Electron vs Tauri by actually packaging the bun engine into both and comparing binary size + startup time. Deliverable: a spike PR (kept on a branch, not merged) that launches Trail admin in a native window on Mac.
2. **Sync protocol proof**: Yjs encoder around wiki_events + a minimal WSS relay on cloud. Two native instances converging on the same KB. Deliverable: a 10-line script that shows `wiki_events.count` matching on both sides after a disconnect+reconnect.
3. **Ingest mode routing**: per-tenant flag on the Settings panel. Local spawns claude -p; cloud routes via API. Deliverable: end-to-end ingest working in both modes, user toggling between them.
4. **CRDT-aware queue**: pending candidates need to converge. Two native instances approving the same candidate must land a single "ingested" event, not duplicate. Deliverable: concurrent-approve test passes.
5. **Ship to enterprise tier**: gated by plan, opt-in install. First user: FysioDK (large protocol library).

Estimated total effort: 3-4 weeks of focused work, distributed across a few months given dependencies.

## Success Criteria

- Native app launches on Mac with full Trail admin UI in a window
- Local ingest via `claude -p` compiles a 10-source batch without API calls
- CRDT sync: two native instances editing same KB converge without conflicts
- Cloud retrieval sees merged state from all devices
- Install flow detects missing `claude -p` and guides user to Anthropic subscription
- Enterprise plan gating: native app only available to Business/Enterprise tenants

## Impact Analysis

### Files created (new)
- `apps/native/package.json` (Electron/Tauri shell)
- `apps/native/src/main.ts` (native entry point)
- `apps/native/src/crdt-sync.ts` (Yjs sync worker)
- `apps/server/src/services/crdt-encoder.ts` (wiki_events → Yjs encoding)
- `apps/server/src/routes/crdt-relay.ts` (WSS relay endpoint)
- Spike branch: packaging proof for Electron + Tauri

### Files modified
- `apps/server/src/services/ingest.ts` — ingest mode routing (local vs API)
- `apps/server/src/index.ts` — CRDT relay wiring
- `apps/admin/src/panels/settings-trail.tsx` — ingest mode toggle
- `packages/shared/src/types.ts` — native app feature flags

### Downstream dependents
`apps/server/src/services/ingest.ts` is imported by 7 files:
- `apps/server/src/routes/uploads.ts` (1 ref) — calls triggerIngest, unaffected
- `apps/server/src/routes/documents.ts` (1 ref) — calls triggerIngest for reingest, unaffected
- `apps/server/src/routes/ingest.ts` (1 ref) — calls triggerIngest, unaffected
- `apps/server/src/app.ts` (1 ref) — mounts ingest routes, unaffected
- `apps/server/src/index.ts` (2 refs) — imports recoverIngestJobs + zombie-ingest, unaffected
- `docs/features/F26-html-web-clipper-ingest.md` (1 ref) — documentation, no code impact

### Blast radius

High. This is a new product tier with its own binary, sync protocol, and deployment model. However:
- Cloud engine is unchanged — native is additive
- CRDT sync is isolated to native ↔ cloud path
- Plan-tier gating ensures only opted-in tenants use native

### Breaking changes

None — all changes are additive. Cloud-only tenants are unaffected.

### Test plan

- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Native app launches on Mac with Trail admin UI
- [ ] Local ingest via `claude -p` compiles 10 sources
- [ ] CRDT sync: two instances converge after disconnect+reconnect
- [ ] `wiki_events.count` matches on both sides after sync
- [ ] Cloud retrieval sees merged state
- [ ] Install flow detects missing `claude -p` → shows guide
- [ ] Concurrent approve: two instances → single "ingested" event
- [ ] Enterprise plan gating: native app unavailable to Hobby/Pro tenants
- [ ] Regression: cloud-only ingest works unchanged

## Implementation Steps

1. **Spike**: Package bun engine into Electron + Tauri. Compare binary size + startup time. Decide on shell.
2. **Native shell setup**: `apps/native/` with Preact UI, local SQLite, `claude -p` subprocess.
3. **CRDT encoder**: Yjs wrapper around wiki_events + queue_candidates.
4. **WSS relay**: Cloud endpoint for CRDT sync streaming.
5. **Ingest mode routing**: per-tenant flag, local vs API path.
6. **CRDT-aware queue**: concurrent-approve convergence.
7. **Install flow**: `claude -p` detection + Anthropic subscription guide.
8. **Plan-tier gating**: Business/Enterprise only.
9. **Testing**: two-instance convergence, bulk ingest, offline access.
10. **Ship**: opt-in for FysioDK (first enterprise user).

## Dependencies

- **F40.2** (multi-tenant cloud) — each tenant's CRDT relay needs its own per-tenant DB. No point building F146 until the cloud is multi-tenant.
- **F42** (pluggable storage) — native app uses local disk, cloud uses R2/Tigris, both behind the same adapter.
- **F14** (multi-provider LLM adapter) — already handles claude -p vs API, no new work.
- **F16** (wiki_events) — the CRDT substrate. Already built. The F146 encoder wraps it.

## Open Questions

- Should the native app also spawn its own MCP server for local `cc` sessions writing into it? (Probably yes — same behaviour as today's dev setup.)
- Tauri's WebView embedding on Linux is less mature than Electron's Chromium — are we OK with a reduced-platform launch (Mac + Win native, Linux via AppImage using Electron)?
- Plan-tier gating: should "bulk import" UX nudge cloud users toward the native app, or should we leave discovery organic?

## Related Features

- **F40** — Multi-tenancy (prerequisite for CRDT relay)
- **F42** — Pluggable storage (local disk vs cloud adapter)
- **F14** — Multi-provider LLM adapter (claude -p vs API routing)
- **F16** — Wiki events (CRDT substrate)
- **F76** — Real-time collaboration (CRDT enables it architecturally)
- **F82** — Custom LLM providers (local app can point at Ollama/LM Studio)
- **F74/F75** — Time-travel / undo-redo (CRDT provides history)
- **F13** — LocalStorage adapter (orthogonal — native owns full SQLite)
- **F111** — Web clipper (ingestion connector, cloud-side)

## Effort Estimate

**Large** — 3-4 weeks of focused work, distributed across months given dependencies.
- 2-3 days: spike (Electron vs Tauri packaging)
- 1 week: sync protocol proof (Yjs encoder + WSS relay)
- 1 week: ingest mode routing + CRDT-aware queue
- 1 week: install flow + plan-tier gating + testing
- 1 week: polish + enterprise ship
