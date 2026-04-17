# Trail — Feature Index

**Last updated:** 2026-04-16

---

## Legend

- **Done** — shipped and working end-to-end
- **In progress** — actively being built
- **Planned** — designed, plan-doc exists, ready to build
- **Idea** — scope understood, plan-doc not yet written

Status reflects the engine (this repo). Landing-site and CMS-adapter work lives in the `@webhouse/cms` repo but is cross-referenced where relevant.

---

## Features

| # | Feature | Status | Phase | Plan |
|---|---------|--------|-------|------|
| F01 | [Monorepo + FSL License](#f01-monorepo--fsl-license) | Done | 1 | — |
| F02 | [Tenant-Aware Schema + SQLite FTS5](#f02-tenant-schema--fts5) | Done | 1 | — |
| F03 | [Google OAuth + Sessions](#f03-google-oauth) | Done | 1 | — |
| F04 | [Knowledge Bases (CRUD)](#f04-knowledge-bases) | Done | 1 | — |
| F05 | [Sources (Upload, List, Archive)](#f05-sources) | Done | 1 | — |
| F06 | [Ingest Pipeline (Claude Code + MCP)](#f06-ingest-pipeline) | Done | 1 | — |
| F07 | [Wiki Document Model + Cross-Refs](#f07-wiki-document-model) | Done | 1 | — |
| F08 | [PDF Pipeline (Text + Images + Vision)](#f08-pdf-pipeline) | Done | 1 | — |
| F09 | [Markdown Ingest Pipeline](#f09-markdown-ingest) | Done | 1 | — |
| F10 | [FTS5 Full-Text Search](#f10-fts5-search) | Done | 1 | — |
| F11 | [MCP Stdio Server (Guide / Search / Read / Write / Delete)](#f11-mcp-stdio-server) | Done | 1 | — |
| F12 | [Chat Endpoint (Synthesize + Cite)](#f12-chat-endpoint) | Done | 1 | — |
| F13 | [LocalStorage Adapter + Storage Interface](#f13-storage-adapter) | Done | 1 | — |
| F14 | [Multi-Provider LLM Adapter](#f14-llm-adapter) | Done | 1 | — |
| F15 | [Bidirectional `document_references`](#f15-bidirectional-refs) | Done | 1 | — |
| F16 | [Wiki Events (Replay-Able Event Stream)](#f16-wiki-events) | Done | 1 | — |
| F17 | [Curation Queue — HTTP Endpoints](#f17-curation-queue-api) | Planned | 1 | [features/F17-curation-queue-api.md](features/F17-curation-queue-api.md) |
| F18 | [Curator UI Shell (Vite + Preact + shadcn)](#f18-curator-ui) | Planned | 1 | [features/F18-curator-ui.md](features/F18-curator-ui.md) |
| F19 | [Auto-Approval Policy Engine](#f19-auto-approval-policy) | Planned | 1 | — |
| F20 | [Curator Diff UI (Before/After)](#f20-diff-ui) | Planned | 1 | — |
| F21 | [Ingest Backpressure](#f21-ingest-backpressure) | Planned | 1 | — |
| F22 | [Stable `{#claim-xx}` Anchors](#f22-claim-anchors) | Planned | 1 | — |
| F23 | [Wiki-Link Parser (`[[]]`, `[[kb:]]`, `[[ext:]]`)](#f23-wiki-link-parser) | Planned | 1 | — |
| F24 | [DOCX Pipeline](#f24-docx-pipeline) | Planned | 1 | — |
| F25 | [Image Source Pipeline (Standalone Images + SVG Passthrough)](#f25-image-pipeline) | Planned | 1 | — |
| F26 | [HTML / Web Clipper Ingest](#f26-web-clipper) | Planned | 1 | — |
| F27 | [Pluggable Vision Adapter](#f27-vision-adapter) | Planned | 1 | — |
| F28 | [Pluggable Pipeline Interface](#f28-pipeline-interface) | Planned | 1 | [features/F28-pipeline-interface.md](features/F28-pipeline-interface.md) |
| F29 | [`<trail-chat>` Embeddable Widget (Lit)](#f29-trail-chat-widget) | Planned | 1 | [features/F29-trail-chat-widget.md](features/F29-trail-chat-widget.md) |
| F30 | [Chat Citations Render (`[[wiki-links]]` → `<a>`)](#f30-chat-citations) | Planned | 1 | — |
| F31 | [Reader Feedback Button → Queue](#f31-reader-feedback) | Planned | 1 | — |
| F32 | [Lint Pass (Orphans / Gaps / Contradictions)](#f32-lint-pass) | Planned | 1 | — |
| F33 | [Fly.io Arn Deploy for `apps/server`](#f33-fly-server-deploy) | Planned | 1 | [features/F33-fly-server-deploy.md](features/F33-fly-server-deploy.md) |
| F34 | [Landing Site Deploy (`trailmem.com` + `trail.broberg.ai`)](#f34-landing-deploy) | In progress | 1 | [features/F34-landing-deploy.md](features/F34-landing-deploy.md) |
| F35 | [Google OAuth Production Credentials](#f35-oauth-production) | Planned | 1 | — |
| F36 | [`docs.trailmem.com` as a Trail Brain](#f36-dogfooding-wiki) | Planned | 1 | [features/F36-dogfooding-wiki.md](features/F36-dogfooding-wiki.md) |
| F37 | [Sanne Customer Onboarding (Customer #1)](#f37-sanne-onboarding) | Planned | 1 | — |
| F38 | [Cross-Trail Search + Chat (Frontpage)](#f38-cross-trail-search) | Planned | 2 | [features/F38-cross-trail-search.md](features/F38-cross-trail-search.md) |
| F39 | [Claude Code Session → Trail Ingest](#f39-cc-session-ingest) | Planned | 1 | [features/F39-cc-session-ingest.md](features/F39-cc-session-ingest.md) |
| F40 | [Multi-Tenancy on `app.trailmem.com` (libSQL embedded per-tenant)](#f40-multi-tenancy) | Planned | 1/2 | [features/F40-multi-tenancy.md](features/F40-multi-tenancy.md) |
| F41 | [Tenant Provisioning + Signup Flow](#f41-tenant-provisioning) | Idea | 2 | — |
| F42 | [Pluggable Storage (Tigris default + R2 alternative)](#f42-r2-storage) | Planned | 2 | [features/F42-pluggable-storage.md](features/F42-pluggable-storage.md) |
| F43 | [Stripe Billing (Hobby / Pro / Business)](#f43-stripe-billing) | Idea | 2 | — |
| F44 | [Usage Metering](#f44-usage-metering) | Idea | 2 | — |
| F45 | [@webhouse/cms Adapter (Strategic)](#f45-webhouse-cms-adapter) | Idea | 2 | [features/F45-webhouse-cms-adapter.md](features/F45-webhouse-cms-adapter.md) |
| F46 | [Video Transcription Pipeline](#f46-video-pipeline) | Idea | 2 | — |
| F47 | [Audio Transcription Pipeline](#f47-audio-pipeline) | Idea | 2 | — |
| F48 | [Email Ingest Pipeline](#f48-email-pipeline) | Idea | 2 | — |
| F49 | [Slack Ingest Pipeline](#f49-slack-pipeline) | Idea | 2 | — |
| F50 | [Web Clipper Browser Extension](#f50-web-clipper-extension) | Idea | 2 | — |
| F51 | [Widget Customization (CSS Variables + Branding)](#f51-widget-customization) | Idea | 2 | — |
| F52 | [FysioDK Aalborg Onboarding (Customer #2)](#f52-fysiodk-onboarding) | Idea | 2 | — |
| F53 | [Custom Subdomains per Tenant](#f53-custom-subdomains) | Idea | 2 | — |
| F54 | [Analytics Dashboard for Curators](#f54-curator-analytics) | Idea | 2 | — |
| F55 | [Adapter SDK (3rd-Party CMS Integrations)](#f55-adapter-sdk) | Idea | 2 | — |
| F56 | [Wiki Freshness Scoring in Lint](#f56-freshness-scoring) | Idea | 2 | — |
| F57 | [Gap Suggestions from Low-Confidence Queries](#f57-gap-suggestions) | Idea | 2 | — |
| F58 | [WordPress Adapter](#f58-wordpress-adapter) | Idea | 2 | — |
| F59 | [Sanity Adapter](#f59-sanity-adapter) | Idea | 2 | — |
| F60 | [Notion Adapter + Sync](#f60-notion-adapter) | Idea | 2 | — |
| F61 | [SaaS Domain — `trailmem.com`](#f61-saas-domain) | Done | 2 | — |
| F62 | [`demo.trailmem.com` — Polished Public Reference Site](#f62-demo-site) | Planned | 1 | [features/F62-demo-site.md](features/F62-demo-site.md) |
| F70 | [SSO: SAML 2.0 + SCIM](#f70-sso-saml) | Idea | 3 | — |
| F71 | [Audit Logs + Retention](#f71-audit-logs) | Idea | 3 | — |
| F72 | [On-Prem Docker / Helm Deploy](#f72-on-prem-deploy) | Idea | 3 | — |
| F73 | [SOC 2 Type II Preparation](#f73-soc2-prep) | Idea | 3 | — |
| F74 | [Event-Sourcing: Time-Travel Queries](#f74-time-travel-queries) | Idea | 3 | — |
| F75 | [Undo / Redo via Event Stream](#f75-undo-redo) | Idea | 3 | — |
| F76 | [Real-Time Collaboration (CRDT)](#f76-crdt-collab) | Idea | 3 | — |
| F77 | [Multi-Region Deployments](#f77-multi-region) | Idea | 3 | — |
| F78 | [Trust Tiers + Provenance Graph (Claims Table)](#f78-trust-tiers) | Idea | 3 | — |
| F79 | [Scheduled Wiki Re-Compilation](#f79-scheduled-recompile) | Idea | 3 | — |
| F80 | [Federated Trail (`[[ext:…]]` Links)](#f80-federated-trail) | Idea | 3 | — |
| F81 | [Per-KB Encryption at Rest](#f81-per-kb-encryption) | Idea | 3 | — |
| F82 | [Custom LLM Provider Adapters (Azure / Ollama / Bedrock)](#f82-custom-llm-adapters) | Idea | 3 | — |
| F83 | [CLI for Curators (`trail queue approve …`)](#f83-cli-curators) | Idea | 3 | — |
| F84 | [Dedicated PostgreSQL Option](#f84-dedicated-postgres) | Idea | 3 | — |
| F85 | [Continuous Lint (Real-Time, Not Periodic)](#f85-continuous-lint) | Idea | 3 | — |
| F86 | [SLA Contracts + Monitoring](#f86-sla-monitoring) | Idea | 3 | — |
| F91 | [Neuron Editor (Markdown Split-View)](#f91-neuron-editor) | Done | 2 | [features/F91-neuron-editor.md](features/F91-neuron-editor.md) |
| F92 | [Tags on Neurons (Filter + Facet + Auto-Suggest)](#f92-tags-on-neurons) | Planned | 2 | [features/F92-tags-on-neurons.md](features/F92-tags-on-neurons.md) |

---

## Descriptions

### F01 — Monorepo + FSL License
pnpm workspaces + Turbo monorepo with FSL-1.1-Apache-2.0 license. Repository structure per PLAN.md: `apps/`, `packages/`, `docs/`, `infra/`, `scripts/`. Shipped as part of the initial Phase 1 scaffold.

### F02 — Tenant-Aware Schema + SQLite FTS5
Drizzle-ORM schema with 9 tables (tenants, users, sessions, knowledge_bases, documents, document_chunks, queue_candidates, document_references, wiki_events). Single-tenant today but schema is multi-tenant from day 1. FTS5 contentless tables with AFTER INSERT/UPDATE/DELETE triggers keep search always in sync.

### F03 — Google OAuth + Sessions
Google OAuth 2.0 login with session cookies. First OAuth signup auto-creates a tenant. Deferred Phase 3 work: SSO (F70), additional providers.

### F04 — Knowledge Bases
Multiple Knowledge Bases (Nodes) per tenant. CRUD endpoints with owner-scoped access control. Each KB contains its own sources and compiled wiki pages.

### F05 — Sources
Upload, list, delete, soft-archive source documents (sources = raw inputs; wiki pages = synthesized Neurons). Triggers ingest on upload.

### F06 — Ingest Pipeline (Claude Code + MCP)
Source upload triggers Claude Code subprocess with MCP access to the engine. The subprocess reads the source and compiles wiki pages via the MCP `write` tool. Single successful run over an 8-page Danish PDF in ~155s end-to-end.

### F07 — Wiki Document Model + Cross-Refs
`documents` table with `kind='source'|'wiki'`, `is_canonical`, version history. Wiki pages are markdown with cross-references both via markdown links and structural `document_references` rows. Forms the substrate for F15 (bidirectional) and F22 (claim anchors).

### F08 — PDF Pipeline (Text + Images + Vision)
Extracts text via pdfjs-dist, pulls embedded images out, and generates per-image vision descriptions via Anthropic's haiku (gated behind `ANTHROPIC_API_KEY`). Skipped gracefully when no API key — the text-only path still works.

### F09 — Markdown Ingest Pipeline
Simplest pipeline — markdown sources pass through with minimal pre-processing. Proves the compile path end-to-end on low-effort content.

### F10 — FTS5 Full-Text Search
`documents_fts` + `chunks_fts` as contentless FTS5 tables with AFTER INSERT/UPDATE/DELETE triggers. Search endpoint filters by tenant + KB + `kind` so curators can search across sources, wiki, or both.

### F11 — MCP Stdio Server
stdio MCP server with five tools: `guide`, `search`, `read`, `write`, `delete`. Drives the ingest compile loop (F06) and is the integration surface for external agents (Claude Code, Cursor, …).

### F12 — Chat Endpoint
Server-side retrieval + Claude synthesis. Reads relevant wiki pages, assembles context, calls the LLM, returns an answer with `[[wiki-link]]` citations. Pluggable backend (`claude -p` subprocess by default, Anthropic API via `TRAIL_CHAT_BACKEND=api`).

### F13 — Storage Adapter
`packages/storage` with `LocalStorage` implementation and a narrow `Storage` interface designed for drop-in replacement. R2 (F42) and any future object store plug in here.

### F14 — LLM Adapter
Multi-provider LLM layer. Dev defaults to `claude -p` subprocess (no API cost during development). Opt-in Anthropic API via `TRAIL_CHAT_BACKEND=api`. Phase 3 adds Azure OpenAI / Ollama / Bedrock (F82).

### F15 — Bidirectional `document_references`
`document_references` join table stored in both directions — source → wiki and wiki → source. Enables "which wiki pages are affected if this source is updated?" as a single SELECT, no inference.

### F16 — Wiki Events
`wiki_events` table storing full-payload events (not deltas) with `prev_event_id` chain pointers. Makes F74 (time-travel) and F75 (undo/redo) features rather than schema migrations in Phase 3.

### F17 — Curation Queue API
**CRITICAL Phase 1 unblocker.** HTTP routes over the existing `queue_candidates` schema: `POST /candidates`, `POST /:id/approve`, `POST /:id/reject`, `GET /queue?status=…`. The approval handler must be the **only** write path into `documents` where `kind='wiki'`. Auto-approval (F19) is a queue policy, not a parallel path.

### F18 — Curator UI
First Admin UI surface. Shell in `apps/admin` with Vite + Preact + Tailwind v4 + shadcn/ui (new-york/neutral). Queue panel sorted by `impact × confidence`, one-click approve/reject/edit, diff view (F20).

### F19 — Auto-Approval Policy
Single function `shouldAutoApprove(candidate): boolean`, called by the queue approval handler. Starts as `return false`; iterates over time. Trusted-pipeline + high-confidence + no-contradictions candidates pass through automatically but still flow through the queue so the audit trail is intact.

### F20 — Diff UI
Three-pane view in the curator dashboard: old version, new version, rendered preview. Curators approve/reject the **diff**, not the whole page. Requires event-sourced `wiki_events` (F16) which is already in place.

### F21 — Ingest Backpressure
Per-KB candidate-per-hour rate limit. Excess candidates enter `pending_ingestion` state and trickle in as older ones are resolved. Prevents panic-closing the tab when a 400-page PDF lands.

### F22 — Claim Anchors
Compiler emits stable `{#claim-xx}` anchors on every claim in every compiled wiki page. Hashed so they survive re-compilation. Zero-cost in Phase 1; becomes the join key for the Phase 3 claims table (F78) without re-parsing.

### F23 — Wiki-Link Parser
Supports three prefixes: `[[page]]` (intra-KB), `[[kb:other-kb/page]]` (cross-KB, same tenant), `[[ext:tenant/kb/page]]` (federated, Phase 3 / F80). Designed once in Phase 1 so later phases don't repaint the corner.

### F24 — DOCX Pipeline
Extract text + embedded images from `.docx` files via Mammoth. Run the same image-extract → vision-description path as F08. Same candidate-generation surface on the other side.

### F25 — Image Pipeline (Standalone + SVG Passthrough)
Accept standalone images as sources. Generate vision description → wiki page. Inline SVG sources pass through their markup so diagrams authored as SVG (timelines, schematics, data viz) remain stylable and accessible on the wiki.

### F26 — Web Clipper Ingest
HTML URL → extract main article → ingest as markdown source. Starts as a POST endpoint; browser extension (F50) comes in Phase 2.

### F27 — Pluggable Vision Adapter
Narrow interface `VisionAdapter.describe(imageBuffer, { model, prompt }): Promise<string>`. Default: Anthropic haiku. Drop-in: GPT-4V, Gemini, local Llava. Same surface the LLM adapter uses.

### F28 — Pluggable Pipeline Interface
`Pipeline.handle(source: SourceFile): Promise<PipelineResult>` — every ingest pipeline (markdown, PDF, DOCX, HTML, image, SVG, audio, video) implements the same contract. Orchestration layer picks a pipeline by MIME type + file extension + heuristics.

### F29 — `<trail-chat>` Widget
Lit-based web component. One-attribute embed: `<trail-chat tenant="…" kb="…" theme="light|dark">`. Ships as a single ESM bundle. Runs on any site, any framework. Reader feedback button (F31) closes the loop.

### F30 — Chat Citations Render
Convert `[[wiki-link]]` citations in chat responses into clickable anchor tags pointing at the in-app wiki view or the public reading URL. Server-side transform so it works identically in the widget, admin, and API consumers.

### F31 — Reader Feedback → Queue
`<trail-chat>` widget 👎 button opens a "what was wrong?" textarea. Submission becomes a `reader_feedback` candidate with the full chat context attached. Closes the embed → curation loop.

### F32 — Lint Pass
Periodic background job. Surfaces orphaned pages, missing cross-refs, contradictions across sources, pages that haven't been touched in N months. Emits `gap_suggestion` / `cross_ref_suggestion` / `contradiction_alert` candidates into the queue.

### F33 — Fly.io Server Deploy
Fly.io arn (Stockholm) deploy config for `apps/server` under `infra/fly/`. Volumes for SQLite + uploads. Secrets via `fly secrets set`.

### F34 — Landing Deploy
Deploy the `@webhouse/cms examples/static/trail` site to three hostnames that all serve the same content: `trailmem.com`, `www.trailmem.com`, `trail.broberg.ai`. CNAME both zones on Cloudflare to the Fly.io static target. Content evolves over time from pure landing to concept + tech + data + posts as we approach the `app.trailmem.com` SaaS launch (F41).

### F35 — OAuth Production Credentials
Google OAuth production client + consent screen. Domain-verified `app.trailmem.com` (SaaS) and `trail.broberg.ai` (engine). Separate from dev credentials.

### F36 — `docs.trailmem.com` as a Trail Brain
The Trail documentation site is itself a Trail brain. GitHub Action watches `broberg-ai/trail/docs/**`, ingests every push into a dedicated `trailwiki` tenant on `app.trailmem.com`, compiles via standard markdown pipeline (F09), renders at `docs.trailmem.com` via a read-only Trail frontend. Dogfooding the product while producing the docs.

### F37 — Sanne Onboarding
Customer #1 — Sanne Andersen (healing/zoneterapi, Aalborg). Migrate 25 years of clinical material into a single Sanne-owned Trail. Onboarding script, support, and feedback channel. Initially single-tenant on Fly.io; migrates to a tenant on `app.trailmem.com` when F40 lands.

### F38 — Cross-Trail Search + Chat (Frontpage)
`app.trailmem.com`'s frontpage lets a signed-in user search and chat across every Trail they own. Results tagged by source Trail, bounded retrieval (top-M Trails × top-K pages) for scalability. Drill into a specific Trail and the same UI becomes scoped to just that Trail. Finalises user-facing naming: **Trail** = the user's knowledge base, **Neuron** = a compiled wiki page inside it.

### F39 — Claude Code Session → Trail Ingest
Buddy watches every cc session. At session end (or `/trail-save`), a summariser extracts knowledge artifacts (decisions, conventions, bug-fix reasoning, rejected approaches) and POST's them to Trail as queue candidates. Trail compiles them into wiki pages cross-referenced with the codebase, git history, and other sessions. Not verbatim logging (that's MemPalace); this is compile-at-ingest. Building blocks: buddy's session monitor + Trail's candidate API (F17) + auto-approve for trusted sources. Feeds into F36 (docs.trailmem.com) so the docs brain includes the *why*, not just the *what*.

### F40 — Multi-Tenancy on `app.trailmem.com`
**Decision locked:** libSQL embedded per-tenant, one `.db` file per tenant on Fly Volume, connection pool with LRU eviction, per-Machine `registry.db` for tenant routing. Ships in two phases:
- **F40.1 (Phase 1, ~1 day):** swap driver from `bun:sqlite` to `@libsql/client`. Still single-tenant. Precedes F33 so Sanne's deploy is born on libSQL.
- **F40.2 (Phase 2, 10-15 days):** `@trail/db` TrailDatabase interface, connection pool, registry, tenant-context middleware, provisioning + deprovisioning + tier-upgrade flows, dev-mode fallback.

### F41 — Tenant Provisioning + Signup
Public signup flow creates a tenant + first user. Email verification, OAuth provider picker. Hooks to Stripe (F43) for plan selection.

### F42 — Pluggable Storage (Tigris + R2 Adapters)
**Decision locked:** Two production adapters ship together — **Tigris** (Fly.io native, default) and **Cloudflare R2** (alternative). Both S3-compatible, same `Storage` interface as F13 LocalStorage. Tenant config selects; Pro+ tenants can migrate between providers via a background job. Adapter interface gains `stat` + `copy` to enable etag-verified migration without materialising payloads in memory.

### F43 — Stripe Billing
Plans: Hobby (free, 1 KB / 100 sources / 1k queries), Pro ($29/mo, 5 KBs / 2k sources / 50k queries), Business ($199/mo, unlimited / metered). Stripe-hosted checkout + customer portal.

### F44 — Usage Metering
Count ingests, queries, tokens, storage per tenant. Surfaces in customer dashboard, enforces plan quotas (soft then hard), feeds Stripe invoices on Business tier.

### F45 — @webhouse/cms Adapter
**Strategic Phase 2 adapter.** Lets every @webhouse/cms site become a trail consumer with zero per-site glue. The CMS admin embeds trail panels; the trail engine reads/writes through the CMS content layer. Tight integration with `@webhouse/cms` (separate repo).

### F46 — Video Pipeline
Upload video → extract frames + audio track → transcribe audio (F47) + describe keyframes (F27) → compile wiki summary. Thumbnail extraction via ffmpeg.

### F47 — Audio Pipeline
Upload audio → Whisper-style transcription → markdown pipeline (F09). Supports lectures, podcasts, dictated notes.

### F48 — Email Pipeline
IMAP fetch or forwarding address. Each email becomes a source. Useful for newsletter synthesis and customer-communication knowledge bases.

### F49 — Slack Pipeline
Slack bot + channel-level opt-in. Threads become sources. Knowledge distilled from team discussion.

### F50 — Web Clipper Extension
Chrome / Firefox / Safari extension. "Clip to trail" button sends the current page's main content to a chosen KB. Layers on F26 (HTML ingest).

### F51 — Widget Customization
CSS variable set on `<trail-chat>` for colors, fonts, border radius. Per-tenant brand defaults served from the widget's `GET /config` endpoint.

### F52 — FysioDK Onboarding
Customer #2 — FysioDK Aalborg. Their "Digital Univers" consumes trail via the @webhouse/cms adapter (F45). Proves the Phase 2 multi-tenant + CMS-embed path end-to-end.

### F53 — Custom Subdomains
`<tenant>.trailcloud.com` (or the post-rebrand domain from F61) with per-tenant branding. Routes into the same multi-tenant server.

### F54 — Curator Analytics
Dashboard for curators: queue depth over time, approval rate, auto-approval rate, gap queries, reader feedback trends. Drives what to ingest next.

### F55 — Adapter SDK
Published `@trail/adapter-sdk` npm package for 3rd-party CMS/DMS integrations. Defines the expected content model, ingest hooks, and rendering hooks.

### F56 — Wiki Freshness Scoring
Lint surfaces wiki pages untouched for N months as "possibly stale". Killer feature on the Business tier where one curator maintains hundreds of pages.

### F57 — Gap Suggestions
Low-confidence chat queries create `gap_suggestion` candidates: "This query had no good answer. Consider adding a source on X." Curator sees gaps sorted by query frequency — user questions become the content roadmap.

### F58 — WordPress Adapter
Plugin that makes a WordPress install act as a trail source (pages/posts flow in) and a trail consumer (render `[trail-chat]` shortcode). Plays in the F55 adapter-SDK pattern.

### F59 — Sanity Adapter
Same idea as F58 but for Sanity — GROQ queries feed sources, Studio embeds a trail panel.

### F60 — Notion Adapter
Notion integration with two-way sync. Databases / pages in Notion become sources; approved wiki pages can mirror back as Notion blocks for team use.

### F61 — SaaS Domain — `trailmem.com`
**Resolved 2026-04-16.** Registered at Cloudflare. Three subdomains in play: `trailmem.com` / `www.trailmem.com` (landing, see F34), `docs.trailmem.com` (docs-as-a-Trail, see F36), `app.trailmem.com` (multi-tenant SaaS, see F40/F41). `trail.broberg.ai` continues as the engine-facing identity and mirrors the landing.

### F62 — `demo.trailmem.com` — Polished Public Reference Site
Public zero-login showcase of a Trail brain. Seeded with ~4 curated Trails (Bush/Memex essays, compile-vs-retrieve arguments, memory-neuroscience, optionally a public clinical domain). Reader browses Neurons, chats with the content, and sees a "recently approved" queue feed that visualises the compile-at-ingest loop. Deploys to `demo.trailmem.com`, shares F18 components, uses an `X-Demo-Token` read-only auth bypass against the `trail-demo` tenant. Inspired by Karpathy's LLM Wiki but "more lækker" — scholarly serif body, amber accents, provenance trails under each claim.

### F70 — SSO: SAML 2.0 + SCIM
Identity federation for enterprise tenants. Provision/deprovision users via SCIM. Enterprise-tier feature gated by plan.

### F71 — Audit Logs
Immutable log of every change, with configurable retention. Required for SOC 2 (F73) and regulated industries.

### F72 — On-Prem Docker / Helm
Packaged deploy for customers who can't use SaaS. Docker Compose reference + Helm chart. Supports air-gapped environments with offline LLM (F82).

### F73 — SOC 2 Type II Prep
Policy work + evidence collection + auditor engagement. Usually a 6-12 month process.

### F74 — Time-Travel Queries
"What did the wiki say in January?" Replay `wiki_events` (F16) up to a timestamp. Free feature given event-sourcing is already in place.

### F75 — Undo / Redo
One-click revert of any approved change. Emits a new event, doesn't mutate history. Wired into the curator UI.

### F76 — CRDT Collab
Real-time multi-curator editing on the same wiki page via CRDT. Yjs most likely. Phase 3 scope — compile-at-ingest model means live editing is less critical than for traditional wikis.

### F77 — Multi-Region
Read replicas + geo-DNS. Sub-100ms query latency for global customers.

### F78 — Trust Tiers + Provenance Graph
First-class `claims` table joining on F22 anchors. Per-claim trust score derived from source canonicality (F53's `is_canonical` foundation) + curator approvals. Enables "show me only high-trust claims" filters.

### F79 — Scheduled Re-Compilation
Every 90 days, re-compile each wiki page from its backing sources. Better models in the future catch nuances older compiles missed. Produces `scheduled_recompile` candidates.

### F80 — Federated Trail
One trail instance can subscribe to another's public wiki. Cross-tenant citations via `[[ext:tenant/kb/page]]`. Link parser (F23) was designed for this from Phase 1.

### F81 — Per-KB Encryption
Optional per-KB encryption key held by the tenant. trail stores ciphertext; decryption happens in-memory per-request. Strong story for regulated industries.

### F82 — Custom LLM Adapters
Azure OpenAI, Ollama (local), AWS Bedrock, whatever ships next. Same LLM adapter surface as F14.

### F83 — CLI for Curators
`trail queue list|approve|reject`, `trail source add <path>`, `trail wiki search <query>`. Thin wrapper over MCP tools. Keyboard-driven curation for power users.

### F84 — Dedicated PostgreSQL
Enterprise option for customers with strict data-residency or existing Postgres. Same Drizzle schema, different storage adapter.

### F85 — Continuous Lint
Lint runs per-commit, not per-cron. Enables "pending contradiction" warnings in the editor rather than after the fact.

### F86 — SLA Monitoring
Uptime SLA, latency SLA, and a public status page. Integrated with F77 multi-region for failover.

### F91 — Neuron Editor
Split-view markdown editor on the reader route (`?edit=1`). Saves route through a new `submitCuratorEdit` core helper that inserts a `user-correction` candidate and resolves it as approve in one tx — same audit trail as a manual queue click, no F19 policy surgery, no broken `createdBy`/`autoApprovedAt` semantics. Includes optimistic-concurrency guard (409 on version drift), beforeunload dirty-state guard, editable tag chips, and deep-links from F90 action cards so "reconcile manually" / "link to sources" / "still relevant" land in the editor instead of dead-ending.

### F92 — Tags on Neurons
Tag chips already render in F91's reader and editor, but no aggregate surface exists. F92 adds a per-KB tag-aggregate endpoint, a filter bar on the Neuron listing, a tag facet on search, and an LLM auto-suggest pass during chat-save so new Neurons arrive pre-tagged. Also introduces a canonicaliser (`lowercase`, `kebab-case`, `[a-z0-9-]` only) + a one-shot backfill for existing tag strings. Colour coding per tag deliberately out of scope.
