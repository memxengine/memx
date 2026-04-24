# Trail — Feature Index

**Last updated:** 2026-04-21

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
| F19 | [Auto-Approval Policy Engine](#f19-auto-approval-policy) | Planned | 1 | [plan](features/F19-auto-approval-policy.md) |
| F20 | [Curator Diff UI (Before/After)](#f20-diff-ui) | Done | 1 | [plan](features/F20-curator-diff-ui.md) |
| F21 | [Ingest Backpressure](#f21-ingest-backpressure) | Planned | 1 | [plan](features/F21-ingest-backpressure.md) |
| F22 | [Stable `{#claim-xx}` Anchors](#f22-claim-anchors) | Planned | 1 | [plan](features/F22-stable-claim-anchors.md) |
| F23 | [Wiki-Link Parser (`[[]]`, `[[kb:]]`, `[[ext:]]`)](#f23-wiki-link-parser) | Done | 1 | [plan](features/F23-wiki-link-parser.md) |
| F24 | [DOCX Pipeline](#f24-docx-pipeline) | Planned | 1 | [plan](features/F24-docx-pipeline.md) |
| F25 | [Image Source Pipeline (Standalone Images + SVG Passthrough)](#f25-image-pipeline) | Planned | 1 | [plan](features/F25-image-source-pipeline.md) |
| F26 | [HTML / Web Clipper Ingest](#f26-web-clipper) | Planned | 1 | [plan](features/F26-html-web-clipper-ingest.md) |
| F27 | [Pluggable Vision Adapter](#f27-vision-adapter) | Planned | 1 | [plan](features/F27-pluggable-vision-adapter.md) |
| F28 | [Pluggable Pipeline Interface](#f28-pipeline-interface) | Planned | 1 | [features/F28-pipeline-interface.md](features/F28-pipeline-interface.md) |
| F29 | [`<trail-chat>` Embeddable Widget (Lit)](#f29-trail-chat-widget) | Planned | 1 | [features/F29-trail-chat-widget.md](features/F29-trail-chat-widget.md) |
| F30 | [Chat Citations Render (`[[wiki-links]]` → `<a>`)](#f30-chat-citations) | Done | 1 | [plan](features/F30-chat-citations-render.md) |
| F31 | [Reader Feedback Button → Queue](#f31-reader-feedback) | Planned | 1 | [plan](features/F31-reader-feedback.md) |
| F32 | [Lint Pass (Orphans / Gaps / Contradictions)](#f32-lint-pass) | Planned | 1 | [plan](features/F32-lint-pass.md) |
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
| F87 | [Typed Event Stream (SSE) + Live Badges](#f87-event-stream) | Done | 1 | [features/F87-event-stream.md](features/F87-event-stream.md) |
| F89 | [Chat Tools — MCP-Backed Introspection](#f89-chat-tools) | Done | 1 | [features/F89-chat-tools.md](features/F89-chat-tools.md) |
| F90 | [Dynamic Curator Actions + Per-Trail Lint Policy](#f90-curator-actions) | Done | 1 | — |
| F91 | [Neuron Editor (Markdown Split-View)](#f91-neuron-editor) | Done | 1 | [features/F91-neuron-editor.md](features/F91-neuron-editor.md) |
| F92 | [Tags on Neurons (Filter + Facet + Auto-Suggest)](#f92-tags-on-neurons) | Planned | 2 | [features/F92-tags-on-neurons.md](features/F92-tags-on-neurons.md) |
| F93 | ~~Button Sound Feedback~~ — superseded, kept for reference | Dropped | — | [features/F93-button-sound-feedback.md](features/F93-button-sound-feedback.md) |
| F94 | [Ambient Audio System](#f94-ambient-audio) | Planned | 1 | [features/F94-ambient-audio.md](features/F94-ambient-audio.md) |
| F95 | [Ingestion Connectors (Attribution + Filter)](#f95-connectors) | Done | 1 | — |
| F96 | [LLM Action Recommender](#f96-action-recommender) | Done | 1 | — |
| F97 | [Activity Log (Audit Timeline)](#f97-activity-log) | Planned | 2 | [features/F97-activity-log.md](features/F97-activity-log.md) |
| F98 | [Orphan-lint Connector-Awareness](#f98-orphan-connector-awareness) | Done | 1 | [features/F98-orphan-connector-awareness.md](features/F98-orphan-connector-awareness.md) |
| F99 | [Obsidian-style Neuron Graph](features/F99-neuron-graph.md) | Planned | 1 | [features/F99-neuron-graph.md](features/F99-neuron-graph.md) |

### F100-F133 — Karpathy-parity + commercialization batch

Ship'er Trail til "markedets bedste Karpathy-LLM-Wiki-killer" via ~34 features fra `docs/KARPATHY-ALIGNMENT.md`, `docs/KARPATHY-REPO-ADOPT.md`, `docs/SCALING-ANALYSIS.md`, `docs/PRICING-PLAN.md`, `docs/CMS-CONNECTOR.md`, `docs/TRAIL-AS-DOCS-BACKEND.md`. Alle planned. Grupperet efter tema.

**Karpathy core-parity:**

| # | Feature | Status | Phase | Plan |
|---|---------|--------|-------|------|
| F100 | [Obsidian Vault Export](features/F100-obsidian-vault-export.md) | Planned | 2 | [plan](features/F100-obsidian-vault-export.md) |
| F101 | [`type:` Frontmatter Field](features/F101-type-frontmatter.md) | Planned | 2 | [plan](features/F101-type-frontmatter.md) |
| F102 | [Auto-maintained Glossary Neuron](features/F102-auto-maintained-glossary.md) | Planned | 2 | [plan](features/F102-auto-maintained-glossary.md) |
| F103 | [9-step Ingest Workflow Formalization](features/F103-9-step-ingest-workflow.md) | Planned | 2 | [plan](features/F103-9-step-ingest-workflow.md) |
| F104 | [Per-KB Prompt Profiles](features/F104-per-kb-prompt-profiles.md) | Planned | 2 | [plan](features/F104-per-kb-prompt-profiles.md) |
| F105 | [Proactive Save Suggestions in Chat](features/F105-proactive-save-suggestion.md) | Planned | 2 | [plan](features/F105-proactive-save-suggestion.md) |
| F106 | [Solo Mode](features/F106-solo-mode.md) | Planned | 2 | [plan](features/F106-solo-mode.md) |

**Output generation & new Neuron types:**

| # | Feature | Status | Phase | Plan |
|---|---------|--------|-------|------|
| F107 | [Marp Slide Output](features/F107-marp-slide-output.md) | Planned | 2 | [plan](features/F107-marp-slide-output.md) |
| F108 | [Chart & Visualization Generation](features/F108-chart-generation.md) | Planned | 2 | [plan](features/F108-chart-generation.md) |
| F109 | [Synthesis Neuron Type](features/F109-synthesis-neuron-type.md) | Planned | 2 | [plan](features/F109-synthesis-neuron-type.md) |
| F110 | [Comparison Neuron Type](features/F110-comparison-neuron-type.md) | Planned | 2 | [plan](features/F110-comparison-neuron-type.md) |

**Input + UX:**

| # | Feature | Status | Phase | Plan |
|---|---------|--------|-------|------|
| F111 | [Trail Web Clipper (Browser Extension)](features/F111-trail-web-clipper.md) | Planned | 2 | [plan](features/F111-trail-web-clipper.md) |
| F112 | [User Notes / "Your Take" Field (Luhmann friction)](features/F112-user-notes-your-take.md) | Planned | 2 | [plan](features/F112-user-notes-your-take.md) |
| F113 | [Auto-fix in Lint](features/F113-auto-fix-lint.md) | Planned | 2 | [plan](features/F113-auto-fix-lint.md) |
| F114 | [Image Archiving for Web Content](features/F114-image-archiving.md) | Planned | 2 | [plan](features/F114-image-archiving.md) |

**Marketing + data ownership:**

| # | Feature | Status | Phase | Plan |
|---|---------|--------|-------|------|
| F115 | [Trail "Idea File" as Public Shareable Gist](features/F115-trail-idea-file-gist.md) | Planned | 2 | [plan](features/F115-trail-idea-file-gist.md) |
| F116 | [Synthetic Training Data Export](features/F116-synthetic-training-data-export.md) | Planned | 3 | [plan](features/F116-synthetic-training-data-export.md) |
| F117 | [Git-Versioning Export](features/F117-git-versioning-export.md) | Planned | 3 | [plan](features/F117-git-versioning-export.md) |

**Scalability (contradiction-scan + LLM transport):**

| # | Feature | Status | Phase | Plan |
|---|---------|--------|-------|------|
| F118 | [Contradiction-Scan Sampling](features/F118-contradiction-scan-sampling.md) | Planned | 2 | [plan](features/F118-contradiction-scan-sampling.md) |
| F119 | [Parallel Contradiction-Scan Runner](features/F119-parallel-contradiction-runner.md) | Planned | 2 | [plan](features/F119-parallel-contradiction-runner.md) |
| F120 | [Anthropic API Migration](features/F120-anthropic-api-migration.md) | Planned | 2 | [plan](features/F120-anthropic-api-migration.md) |

**Commercialization (billing + plan limits):**

| # | Feature | Status | Phase | Plan |
|---|---------|--------|-------|------|
| F121 | [Per-Tenant LLM Budget Tracking + Soft-cap](features/F121-per-tenant-budget-tracking.md) | Planned | 2 | [plan](features/F121-per-tenant-budget-tracking.md) |
| F122 | [Plan Limits on `tenants` Table](features/F122-plan-limits-on-tenants.md) | Planned | 2 | [plan](features/F122-plan-limits-on-tenants.md) |
| F123 | [Pro Modular Add-ons + Metered Billing (Stripe)](features/F123-pro-modular-addons-metered-billing.md) | Planned | 2 | [plan](features/F123-pro-modular-addons-metered-billing.md) |

**CMS-connector (B2B infrastructure):**

| # | Feature | Status | Phase | Plan |
|---|---------|--------|-------|------|
| F124 | [CMS Content-Sync Endpoint](features/F124-cms-content-sync-endpoint.md) | Planned | 2 | [plan](features/F124-cms-content-sync-endpoint.md) |
| F125 | [CMS Chat-Proxy with Citation-Enriched Response](features/F125-cms-chat-proxy.md) | Planned | 2 | [plan](features/F125-cms-chat-proxy.md) |
| F126 | [Contradiction Webhook to CMS](features/F126-contradiction-webhook-to-cms.md) | Planned | 2 | [plan](features/F126-contradiction-webhook-to-cms.md) |
| F127 | [@trail/cms-connector-sdk NPM Package](features/F127-cms-connector-sdk.md) | Planned | 2 | [plan](features/F127-cms-connector-sdk.md) |
| F128 | [Signed Webhook Payloads (HMAC-SHA256)](features/F128-signed-webhook-payloads.md) | Planned | 2 | [plan](features/F128-signed-webhook-payloads.md) |
| F129 | [CMS Connector Registry Entries](features/F129-cms-connector-registry.md) | Planned | 2 | [plan](features/F129-cms-connector-registry.md) |

**LLM-agent accessibility + schema:**

| # | Feature | Status | Phase | Plan |
|---|---------|--------|-------|------|
| F130 | [llms.txt + llms-full.txt Authenticated Endpoints](features/F130-llms-txt-endpoints.md) | Planned | 2 | [plan](features/F130-llms-txt-endpoints.md) |
| F131 | [`documents.public_visibility` Column](features/F131-public-visibility-column.md) | Planned | 2 | [plan](features/F131-public-visibility-column.md) |
| F132 | [`source-kind` Variants for Ingest-Compile Tuning](features/F132-source-kind-variants.md) | Planned | 2 | [plan](features/F132-source-kind-variants.md) |
| F133 | [Schema Integrity Improvements](features/F133-schema-integrity-improvements.md) | Planned | 2 | [plan](features/F133-schema-integrity-improvements.md) |

**Stand-alone Phase 1 refactors:**

| # | Feature | Status | Phase | Plan |
|---|---------|--------|-------|------|
| F135 | [Slug-based KB URLs](features/F135-slug-based-kb-urls.md) | Done | 1 | [plan](features/F135-slug-based-kb-urls.md) |

### F137-F141 — Ecosystem-inspired semantic + telemetry extensions

Batch drawn from evoailabs Medium survey of LLM Wiki ecosystem (Waykee Cortex, Sage-Wiki, Thinking-MCP) plus Christian's own read-telemetry idea. Each is net-new against the F100-F133 Karpathy-parity batch and orthogonal to current ship work.

| # | Feature | Status | Phase | Plan |
|---|---------|--------|-------|------|
| F137 | [Typed Neuron Relationships](features/F137-typed-neuron-relationships.md) | Shipped | 2 | [plan](features/F137-typed-neuron-relationships.md) |
| F138 | [Work Layer: Tasks, Bugs, Milestones](features/F138-work-layer-tasks-milestones.md) | Shipped | 2 | [plan](features/F138-work-layer-tasks-milestones.md) |
| F139 | [Heuristic Neurons with Temporal Decay](features/F139-heuristic-neurons-with-decay.md) | Shipped | 2 | [plan](features/F139-heuristic-neurons-with-decay.md) |
| F140 | [Hierarchical Context Inheritance](features/F140-hierarchical-context-inheritance.md) | Shipped | 2 | [plan](features/F140-hierarchical-context-inheritance.md) |
| F141 | [Neuron Access Telemetry + Usage Weighting](features/F141-neuron-access-telemetry.md) | Shipped | 2 | [plan](features/F141-neuron-access-telemetry.md) |

### F142-F145 — Durability + cross-session handles (2026-04-21 batch)

Queue + chat state now outlive process crashes, and Neurons carry a stable per-KB id so other sessions (buddy, cc, Discord) can reference them by handle instead of UUID.

| # | Feature | Status | Phase | Plan |
|---|---------|--------|-------|------|
| F142 | [New Neuron modal (curator-initiated create) + chunked-ingest plan](features/F142-chunked-ingest.md) | Shipped (modal) / Plan (chunked ingest) | 2 | [plan](features/F142-chunked-ingest.md) |
| F143 | [Persistent ingest queue](features/F143-persistent-ingest-queue.md) | Shipped | 2 | [plan](features/F143-persistent-ingest-queue.md) |
| F144 | [Chat history persistence](features/F144-chat-history.md) | Shipped | 2 | [plan](features/F144-chat-history.md) |
| F145 | Per-KB seq IDs (`<kbPrefix>_<seq:8>` canonical handle) | Shipped | 2 | — |

### F146 — Local-first native app + CRDT sync

Phase 3 power-user tier: native Mac / Win / Linux shell around the existing bun engine, syncing to cloud via Yjs CRDT. Keeps `claude -p` subprocess ingest legal on user hardware (no API quota for bulk imports), while cloud stays source of truth for retrieval + cross-device.

| # | Feature | Status | Phase | Plan |
|---|---------|--------|-------|------|
| F146 | [Local-first native app + CRDT sync](features/F146-local-first-native-app-sync.md) | Planned | 3 | [plan](features/F146-local-first-native-app-sync.md) |

### F147 — Share Extension (iOS + Android)

Mobile share targets: "Del til Trail" fra Fotos, Safari, Instagram og alle andre apps. Tekst, links og billeder uploades med ét tap. Billeder sendes gennem vision AI for beskrivelse + OCR.

| # | Feature | Status | Phase | Plan |
|---|---------|--------|-------|------|
| F147 | [Share Extension (iOS + Android)](features/F147-share-extension.md) | Idea | 2 | [plan](features/F147-share-extension.md) |

### F148 — Link Integrity (ingen 404 i hjernen)

Tre-lags-forsvar mod broken wiki-links: ingest-prompten lærer LLM'en slug-konventionen (filnavn = slugify(title) = slugify(link-tekst), KB-sprog-korrekt, entity-navne altid `[[wrapped]]`), URL-resolveren folder bilingual-drift (`og↔and`, `i↔of`, parens-strippes), og en ny link-checker-service + `broken_links`-tabel fanger mismatches der slipper igennem. Auto-fix ved entydig fold-match, ellers queue-finding til curator. Hard rule: 0 × 404 på enhver brain, fremadrettet.

| # | Feature | Status | Phase | Plan |
|---|---------|--------|-------|------|
| F148 | [Link Integrity](features/F148-link-integrity.md) | Planned | 1 | [plan](features/F148-link-integrity.md) |

### F149 — Pluggable Ingest Backends

Factor `apps/server/src/services/ingest.ts` bag et `IngestBackend`-interface med to live implementeringer — `ClaudeCLIBackend` (claude-CLI-subprocess, nuværende default) og `OpenRouterBackend` (Gemini 2.5 Flash / GLM 4.6 / Qwen 3.6 Plus / Anthropic API). **Live runtime fallback-chain**: når en model fejler (rate-limit, context-limit, refusal) skifter runneren til næste model i chain'en mid-job mens allerede skrevne Neuroner bevares. Per-KB model-valg + per-tenant billing-keys (encrypted `tenant_secrets`-tabel). Migration `0014` tilføjer `ingest_jobs.cost_cents` + `knowledge_bases.ingest_backend/ingest_model/ingest_fallback_chain`. Runtime-UI-switch er out of v1 — plan-doc'en lægger pure-function-chain-resolution klar til UI-followup. Christian kører fortsat claude-cli (Max Plan) som default indtil han eksplicit flipper.

| # | Feature | Status | Phase | Plan |
|---|---------|--------|-------|------|
| F149 | [Pluggable Ingest Backends](features/F149-pluggable-ingest-backends.md) | Planned | 1/2 | [plan](features/F149-pluggable-ingest-backends.md) |

### F150 — Admin Link-Report Panel

Curator-facing UI for F148's `broken_links`-findings. Ny route `/kb/:kbId/link-check` der viser åbne findings med source-Neuron + link-text + suggested_fix + reported_at. Actions: [Accept] (anvender `suggested_fix` via str_replace på doc.content + version-bump + flipper status til `auto_fixed`), [Dismiss], [Reopen]. Footer-knap "Kør scan nu" kalder `/link-check/rescan`. Live-opdatering via F87 SSE — panel re-fetcher findings når `candidate_approved` fyrer efter en ingest. Ny server-route `POST /link-check/:id/accept` lukker det manglende accept-hul fra F148. Sidebar får "Link Check"-nav-item med badge-count. Depends on F148, F87, F17/F18.

| # | Feature | Status | Phase | Plan |
|---|---------|--------|-------|------|
| F150 | [Admin Link-Report Panel](features/F150-admin-link-report-panel.md) | Planned | 1 | [plan](features/F150-admin-link-report-panel.md) |

### F151 — Cost & Quality Dashboard

Admin-panel der gør F149's `cost_cents` + `model_trail`-data synligt. **Cost-tab** (`/kb/:kbId/cost`): line-chart af running total over 30/90/365d + top-10 dyreste sources + per-Neuron avg. + CSV-eksport. **Quality-tab** (`/kb/:kbId/sources/:sourceId/compare`): tabel-view af alle ingest-runs mod en kilde (model, cost, turns, wall-clock, neurons-skabt, wiki-links, entity-refs) + full-wiki-preview pr. row. Max Plan-kørsler vises som "gratis (Max)"-badge, aldrig som estimat. Data-backend: SQL-aggregering over `ingest_jobs` + `documents` + `wiki_backlinks` + `broken_links`; ingen nye tabeller, kun migration `0015` med date-index. Leverer grundlag for F152-recommendations og F43/F44 pricing-modellering.

| # | Feature | Status | Phase | Plan |
|---|---------|--------|-------|------|
| F151 | [Cost & Quality Dashboard](features/F151-cost-quality-dashboard.md) | Planned | 1/2 | [plan](features/F151-cost-quality-dashboard.md) |

### F152 — Runtime Model Switcher UI

Admin-dropdown pr. KB der lader curator flippe `ingest_backend` + `ingest_model` live uden env-ændring eller redeploy. Kalder F149's `resolveIngestChain`-pure-function og viser preview af hvilken fallback-chain der ville blive brugt. Bygger på F151's quality-data så recommendation-badge kan vises ("Baseret på dine 12 ingests anbefales `gemini-2.5-flash`"). Inkluderer key-warning hvis valgt backend kræver API-key der ikke er sat i tenant_secrets. Integreres i eksisterende `settings-trail.tsx`-panel. Ingen nye migrations; 2 små nye endpoints (`/tenant-secrets/status`, `/knowledge-bases/:kbId/model-recommendation`). Depends on F149, F151 (for recommendation).

| # | Feature | Status | Phase | Plan |
|---|---------|--------|-------|------|
| F152 | [Runtime Model Switcher UI](features/F152-runtime-model-switcher-ui.md) | Planned | 1/2 | [plan](features/F152-runtime-model-switcher-ui.md) |

### F153 — Continuous online backup of `trail.db` to Cloudflare R2

Scheduled WAL-safe online snapshots of the master Trail SQLite DB, compressed and uploaded to a self-hosted R2 bucket (`trail-backups`) while the engine keeps running. Uses SQLite's `VACUUM INTO` primitive via the existing libSQL client — produces a single self-contained `.db` file with no `-wal`/`-shm` companions, safe to take while writers are active. Gzip → `@aws-sdk/client-s3` multipart upload. Manifest at `data/backups/manifest.json` tracks status + retention. New `backup-scheduler` service (pattern-matches `lint-scheduler`) fires every `TRAIL_BACKUP_INTERVAL_HOURS` (default 6h). 5 admin-only routes at `/api/admin/backups` (list / manual-trigger / download / delete / test-connection) + a Settings tab in `apps/admin`. Restore is a stopped-server CLI (`scripts/restore-backup.ts`) — one-click restore is an explicit non-goal. Reuses `BackupProvider` interface shape from `@webhouse/cms/packages/cms-admin/src/lib/backup/providers/*`. Depends on: none (F40.1 compatible). Extends: F40.2 (per-tenant DBs → loop scheduler), F33 (Fly deploy relies on off-site backup before Sanne onboarding). Small effort (1.5–2 days). Status: Planned.

| # | Feature | Status | Phase | Plan |
|---|---------|--------|-------|------|
| F153 | [Continuous DB backup to R2](features/F153-continuous-db-backup-to-r2.md) | Planned | 1 | [plan](features/F153-continuous-db-backup-to-r2.md) |

### F154 — Trail Control Plane (remote management & deployment center)

Separate admin app (`ops.trailmem.com`) der styrer hele Trail-produktionsfleeten uden Fly CLI. Fleet-dashboard (alle Fly-apps, Machines, tenant-placering pr. pool), tenant-provisioning-wizard (form → Fly API + Cloudflare DNS + engine endpoint), Pro→Business cutover-wizard (DB-snapshot + SCP-transfer + DNS flip med rollback-vindue), alert-inbox (engine emitter kapacitets/cost/health-alerts via POST /alerts), cost-view (Fly GraphQL daily spend sammenlignet med Stripe MRR), impersonate-read-only til support, GDPR-export, audit-log (append-only, alle mutations logges). Kritisk ved Stadie 2 (10-20 tenants), operationelt nødvendig ved Stadie 3 (200-500). Læs [DEPLOYMENT-STAGES.md](./DEPLOYMENT-STAGES.md) for stadie-oversigten, [SAAS-SCALING-PLAN.md](./SAAS-SCALING-PLAN.md) for arkitektur-baggrund. Depends on F33, F40, F41, F42, F43, F44, F151, F153. Enables F155 (auto-scaling policy lever i Control Plane UI). Large effort (10-14 dage fordelt over 4 phases). Status: Planned.

| # | Feature | Status | Phase | Plan |
|---|---------|--------|-------|------|
| F154 | [Trail Control Plane](features/F154-trail-control-plane.md) | Planned | 2 | [plan](features/F154-trail-control-plane.md) |

### F155 — Auto-scaling Policy

Rule-drevet automatisk spawn/resize/decommission af Fly-Machines baseret på policy-yaml (`config/auto-scale-policy.yaml`, hot-reloadable). Policy-engine evaluerer hver 60s, foreslår handlinger til en kø med `auto` eller `require_confirm` approval-flags, udfører godkendte via F154's Fly-client, audit-logger alt. Safety rails: rate-limit (3/5min), daily soft-cap €50 + monthly hard-cap €500 ekstra cost, oscillation-detektor (kontradiktoriske regler pauser automatisk), panic-button der øjeblikkeligt disabler auto-approve. Seks default regler: `pro-pool-scaleup`, `business-machine-vertical-scale`, `starter-pool-shrink`, `noisy-neighbor-isolation`, `hobby-quota-abuse`, `pool-selection-on-signup`. Phased rollout: dry-run først (2-4 uger validering), derefter conservative auto-approve (pool-selection + pro-scaleup), slutteligt full auto. Lever i F154 Control Plane's UI som "Auto-scale"-tab med pending-actions, history, dry-run-simulator. Depends on F154, F44, F151, F43. Medium effort (5-7 dage over 4 phases). Status: Planned.

| # | Feature | Status | Phase | Plan |
|---|---------|--------|-------|------|
| F155 | [Auto-scaling Policy](features/F155-auto-scaling-policy.md) | Planned | 2 | [plan](features/F155-auto-scaling-policy.md) |

### F156 — Credits-Based LLM Metering

User-paid LLM-omkostninger via credits-valuta. Hver tier inkluderer en generøs månedlig grundkvote (Hobby 100 / Starter 400 / Pro 2 000 / Business 10 000); ekstra forbrug købes som one-time credit-pakker (100/200/500/1000/2000 credits, €0.030-0.050 per credit). **1 credit = $0.01 LLM-cost**, målt direkte fra OpenRouter `usage.cost` — ingen separat multiplier-tabel, credits ER cost. Model-valget afgør credit-burn-rate implicit: typisk Flash-ingest af 10-siders PDF = ~1 credit, samme PDF på Sonnet = ~30 credits (fordi Sonnet faktisk er 30× dyrere per token). Giver F149 Pluggable Backends ægte kommerciel betydning. Schema: `tenant_credits` (balance, monthly_included) + `credit_transactions` (append-only audit). Phased rollout: M5 schema + tracking → M6 monthly top-up + Stripe Checkout → M7 soft alerts → M8 hard enforcement med 10% overdraft-buffer. Chat, lint, tag-extraction, glossary forbruger IKKE credits — kun ingest/compile af kilder. Erstatter F121's intern USD-tracking med kunde-vendt model. Markup på pakker = 3-5× over LLM-cost. Token-til-credit konverteringstabeller publiceret for transparens (8 credits per 1M Flash input tokens, 300 per 1M Sonnet input tokens, etc). Depends on F43, F44, F122, F149, F151. Medium effort (6-9 dage over 4 phases). Status: Planned.

| # | Feature | Status | Phase | Plan |
|---|---------|--------|-------|------|
| F156 | [Credits-Based LLM Metering](features/F156-credits-based-llm-metering.md) | Planned | 2 | [plan](features/F156-credits-based-llm-metering.md) |

---

**Se også:** [`NON-GOALS.md`](./NON-GOALS.md) — kuratert register over bevidst fravalg pr. F-plan (parked / declined / promoted / covered-by).

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

### F87 — Event Stream
Server-Sent Events broadcaster (`GET /api/v1/stream`) emits typed events — `candidate_created`, `candidate_approved`, `candidate_rejected`, `candidate_resolved`, `badge_count` — that admin panels subscribe to. The queue panel refreshes without polling, the nav badge shows the true pending count (server-side truth, not client-side cache), and panels across the admin react live to each other's writes. Debounced reload absorbs bulk-action bursts so 22 rejects in a row coalesce into one re-fetch. Also used by F91 for tag-aggregate cache busting and by the contradiction-lint subscriber to react to `candidate_approved`.

### F89 — Chat Tools
The chat endpoint used to answer every question by RAG-retrieving snippets and asking the LLM to cite — which worked for "what does X say about Y" but failed for structural questions like "how many Neurons do we have tagged ops?" or "which sources haven't been re-compiled in the last month?" F89 adds MCP-backed introspection tools the chat LLM can invoke mid-turn (list Neurons, count by tag, inspect source status). The LLM decides when to use RAG vs. structural — giving chat a "second brain" that knows the shape of the Trail, not just its content.

### F90 — Dynamic Curator Actions
Pre-F90, every queue candidate got the same Approve/Reject pair. F90 makes actions per-candidate: contradiction-alerts offer "Retire this Neuron / Flag the source / Reconcile manually", orphan-neurons offer "Link to sources / Retire / Still relevant", etc. Each action carries its own `effect` (approve, reject, acknowledge, retire-neuron, flag-source, mark-still-relevant, …) that the core dispatcher executes. Action labels + explanations are LLM-translated on first non-EN view and cached on the candidate row. Also introduces per-Trail `lint_policy` (trusting vs strict) and versioned lint fingerprints so rejected findings don't re-fire against the same Neuron version. Bulk operations work by effect-match (every kind has a reject-effect action, even when its string label differs).

### F91 — Neuron Editor
Split-view markdown editor on the reader route (`?edit=1`). Saves route through a new `submitCuratorEdit` core helper that inserts a `user-correction` candidate and resolves it as approve in one tx — same audit trail as a manual queue click, no F19 policy surgery, no broken `createdBy`/`autoApprovedAt` semantics. Includes optimistic-concurrency guard (409 on version drift), beforeunload dirty-state guard, editable tag chips, and deep-links from F90 action cards so "reconcile manually" / "link to sources" / "still relevant" land in the editor instead of dead-ending.

### F92 — Tags on Neurons
Tag chips already render in F91's reader and editor, but no aggregate surface exists. F92 adds a per-KB tag-aggregate endpoint, a filter bar on the Neuron listing, a tag facet on search, and an LLM auto-suggest pass during chat-save so new Neurons arrive pre-tagged. Also introduces a canonicaliser (`lowercase`, `kebab-case`, `[a-z0-9-]` only) + a one-shot backfill for existing tag strings. Colour coding per tag deliberately out of scope.

### F93 — ~~Button Sound Feedback~~ (Dropped)
Drafted then dropped — Christian's intent for sound was ambient route loops, not action-feedback bips ("Not goals: notification sounds, action feedback" — see F94). Plan doc kept at `features/F93-button-sound-feedback.md` for historical reference; nothing implemented.

### F94 — Ambient Audio
Discreet ambient background loops, one per top-level admin route (`landing`/`neurons`/`queue`/`chat`/`search`/`sources` + an `idle` fallback). Web Audio API engine with hard-cut transitions on route change and per-route buffer caching (decode once, reuse). Opt-in toggle in the admin header; preference persists in `localStorage.trailmem.ambient.{enabled,volume}`, device-local. Source MP3s in `docs/assets/sound/` get loudnorm-normalized to -18 LUFS and Opus-encoded at 96 kbps into `apps/admin/public/ambient/` via `scripts/process-ambient.sh`. Lazy-load — only the active route's buffer is fetched on enable; others load on first visit.

### F95 — Connectors
Every candidate carries `metadata.connector: ConnectorId` identifying the ingestion pathway that produced it. Central registry in `packages/shared/src/connectors.ts` lists 9 live ids (`upload`, `mcp:claude-code`, `mcp:cursor`, `mcp`, `buddy`, `chat`, `lint`, `curator`, `api`) and 5 roadmap ids matching the landing-page promise (`slack`, `discord`, `notion`, `github`, `linear`). Admin Queue has a collapsible connector-chip filter row + a per-card badge; the Neuron reader shows a "Skabt via" panel with connector attribution + confidence pill. Core's `stampConnector()` runs at candidate-create — caller-supplied ids win, otherwise it infers from `kind` + legacy `metadata.source` hints. MCP subprocess reads `TRAIL_CONNECTOR` env; ingest pipeline sets `TRAIL_CONNECTOR=upload`; each client (Claude Code, Cursor, buddy) sets its own in their `.mcp.json` env. Adding a new connector = one entry in the registry; no schema migration.

### F96 — Action Recommender
One Haiku call per pending candidate analyzing its content + available actions, returning `{recommendedActionId, confidence, reasoning}` stamped into `metadata.recommendation`. Admin renders a "💡 Anbefalet" card between the candidate body and action column with the suggested action's label, a colour-graduated confidence pill, 1-3 sentences of plain-language reasoning, and an `[Accepter]` button that one-clicks the recommended action. Bulk mode: "💡 Accepter N anbefalinger" dispatches each candidate's own recommended action via `POST /queue/bulk-accept-recommendations`. Reject-effect recommendations are skipped in bulk (they need a reason-modal). Subscriber fires on `candidate_created`; boot-time backfill covers pre-existing candidates. Hallucination guard: the LLM's returned actionId must match one of the candidate's stored action ids verbatim, or the recommendation is dropped. Cost: ~$0.003 per candidate on Haiku, cached forever unless content changes.

### F97 — Activity Log
Central append-only `activity_log` table capturing every meaningful action on a trail server — auth, uploads, ingests, candidate lifecycle, Neuron edits, lint runs, connector events. One subscriber bridges the broadcaster's ephemeral SSE events into persisted rows; explicit `logActivity()` calls in 6 gap sites (auth, kb-create/update, upload-received, lint-scheduled/completed) cover what the broadcaster doesn't emit. Admin timeline panel at `/activity` with connector-chip-style filters (actor / kind-group / Trail / timeframe), expandable rows showing full `metadata` JSON, and deep-links to the subject. Unlocks credits/usage metering (tokens live in `metadata`), per-user activity summaries, compliance exports, and "show me everything that happened to Neuron X". Schema + subscriber + helper is MVP; timeline UI ships after.

### F98 — Orphan-lint Connector-Awareness
Orphan-Neuron detection now skips Neurons whose originating candidate came from an external connector (`buddy`, `mcp`, `mcp:claude-code`, `mcp:cursor`, `chat`, `api`, `share-extension`). Their "source" lives outside Trail's KB — a cc session, a git commit, a conversation context, or a mobile share — so "zero `document_references` rows" is the expected state, not an anomaly. Before F98 the orphan detector flagged them anyway, Auto-link-sources could never succeed (the sources literally don't exist as Trail documents), and the curator was stuck with unsolvable queue work. F98 adds `EXTERNAL_CONNECTORS` to `packages/shared/src/connectors.ts` + a connector-resolution helper in `detectOrphans()` that walks wiki_events → sourceCandidateId → metadata.connector and skips flagging when external. One-shot bootstrap `cleanupExternalOrphans()` dismisses pending false-positive findings retroactively. Idempotent — zero rows affected on steady-state boots. Validation logic is now contract-specific to the ingestion pathway; future lint detectors (stale, gap-detection, contradiction) can consult the same connector-aware contract.

### F147 — Share Extension (iOS + Android)
Native share targets for iOS og Android der lader brugeren sende tekst, links og billeder direkte fra andre apps til Trail. iOS Share Extension (Swift/SwiftUI) dukker op i share sheet som "Trail Clipper" og deler credentials med hoved-appen via App Group. Android Share Extension (Kotlin) gør det samme. Billeder sendes gennem den eksisterende vision backend for beskrivelse + OCR. Connector: `share-extension`.

### F152 — Runtime Model Switcher UI
Admin-dropdown i eksisterende `settings-trail.tsx` pr. KB der lader curator flippe `ingest_backend` + `ingest_model` live uden env-ændring eller redeploy. Viser preview af fallback-chain som `resolveIngestChain` ville returnere (Flash → GLM → Qwen → Claude API osv.). Recommendation-badge baseret på F151's quality-data ("Baseret på dine 12 ingests anbefales `gemini-2.5-flash`") — kræver ≥3 runs + ≥20% kvalitets-delta. Key-warning hvis valgt backend kræver API-key der ikke er sat i tenant_secrets; save-knap disabled indtil key konfigureret. Chain-konstanter flyttes til `packages/shared/src/ingest-chains.ts` så client + server deler én sandhed. To nye read-only endpoints: `GET /tenant-secrets/status` (kun boolean, aldrig secrets) og `GET /knowledge-bases/:kbId/model-recommendation`. Lille feature (1-1.5 dage); ingen migrations, ingen nye tabeller.

### F151 — Cost & Quality Dashboard
Admin-panel der gør F149's `cost_cents` + `model_trail`-data synligt for curator og ejer. **Cost-tab** (`/kb/:kbId/cost`): line-chart af running total cost over 30/90/365 dage, top-10 dyreste sources, per-Neuron avg-estimat, CSV-eksport. **Quality-tab** (`/kb/:kbId/sources/:sourceId/compare`): tabel-view af alle ingest-runs mod en given kilde med kolonner: model, cost, turns, wall-clock, neurons-skabt, wiki-links, entity-refs, open broken_links. Klik en række → full-wiki-preview af netop det `ingest_job_id`'s compiled neurons (embedded WikiReaderPanel read-only). Max Plan-kørsler (`cost_cents=0 && backend='claude-cli'`) rendres som "gratis (Max)"-badge, aldrig som estimat. Aggregering via SQL over eksisterende `ingest_jobs` + `documents` + `wiki_backlinks` + `document_references` + `broken_links` — ingen nye tabeller, kun migration `0015` der tilføjer date-index på `ingest_jobs`. Cache 60s med bust på `candidate_approved`-event. Leverer data-grundlag for F152-recommendations og backtesting af F43 pricing-tier-thresholds. Medium effort (2-3 dage).

### F150 — Admin Link-Report Panel
Curator-facing UI til F148's `broken_links`-findings. Route `/kb/:kbId/link-check` renderer åbne findings i en tabel (source-Neuron, link-text, suggested_fix, reported_at) med [Accept] / [Dismiss] / [Reopen]-knapper pr. række + "Kør scan nu"-footer-knap. Accept-action anvender `suggested_fix` på Neuron'ens content via `str_replace(oldLink, suggestedFix)` + version-bump + flipper `broken_links.status='auto_fixed'` + setter `fixed_at`. Server-route-tilføjelsen `POST /link-check/:id/accept` lukker hullet fra F148 (som havde dismiss/reopen men ikke accept). Panel subscriber på SSE `candidate_approved`-events for live re-fetch. Sidebar "Link Check"-nav-item viser badge med antal åbne findings for aktiv KB. Empty-state: stort tjek-ikon + "Ingen broken links — din brain er intakt."

### F149 — Pluggable Ingest Backends
Ingest-pipelinen factoreret bag et `IngestBackend`-interface. To implementeringer: `ClaudeCLIBackend` (nuværende `spawnClaude`-subprocess, Max Plan, default) og `OpenRouterBackend` (Gemini 2.5 Flash, GLM 4.6, Qwen 3.6 Plus, Claude Sonnet via API). **Live runtime fallback-chain** — på model-fejl skifter runneren til næste model i chain'en mid-job og bevarer allerede-skrevne Neuroner; chain stoppes kun når jobbet lykkes eller listen tømmes. Default chains: claude-cli → Flash → GLM → Qwen, eller openrouter → Flash → GLM → Qwen → Claude-API. Per-KB kolonne `ingest_backend`/`ingest_model`/`ingest_fallback_chain` overstyrer env. Per-tenant encrypted API-keys i `tenant_secrets` (libsodium seal, master-key fra `TRAIL_SECRETS_MASTER_KEY`). Cost-tracking pr. job via ny `ingest_jobs.cost_cents`-kolonne (migration 0014); `model_trail` JSON-kolonne logger hvilke modeller der faktisk kørte hvilke turns. Model-lab's OpenRouter-kode (`apps/model-lab/src/server/{openrouter,runner,two-pass,tools}.ts`) løftes ind i server-lag og bindes til Trail's MCP-write-tool så F111.2-stamping, F137 edge-types, F140 schemas og F148 link-checker virker identisk uanset backend. Runtime-UI-switch er separat F-feature (ikke v1); F149's chain-resolution er pure function klar til det kald. Christian kører fortsat claude-cli (Max Plan) som default indtil han eksplicit flipper.

### F148 — Link Integrity
Tre-lags-forsvar mod 404-fejl i en trail-brain. **Lag 1 (prompt):** `ingest.ts`-prompten udvides med `kb.language`-direktiv, en ENTITY VOCABULARY-blok (ny `listKbEntities()` aggregator), eksplicitte slug-konsistens-regler med eksempler (`yin-og-yang.md` ✓ / `yin-and-yang.md` ✗), og krav om at alle navngivne personer/organisationer/tools wrappes i `[[...]]`. **Lag 2 (URL-fallback):** ny `normalizedSlug(slug, language)` + `foldBilingual()` i `packages/shared/` folder bilingual-drift (`og↔and`, `i↔of`, `til↔to`, `med↔with`, `æøå↔ae/oe/aa`) og fjerner parens-kvalifikatorer. Anvendt symmetrisk i `wiki-reader.tsx` URL matcher, `backlink-extractor.ts resolveLink()`, og `wiki-links.ts`. **Lag 3 (link-checker):** ny `broken_links`-tabel (migration `0013`) + `link-checker.ts`-service spejler `contradiction-lint.ts`-mønsteret. Subscriber på `candidate_approved` + daglig sweep via `lint-scheduler`. Auto-fix ved entydig fold-match; flertydighed eller uløselige mismatches lander som `queue_candidates` med `kind='broken-link-alert'`. Ingen LLM i checkeren — ren text-parsing + in-memory pool + Levenshtein ≤ 2 for forslag. Hard rule Christian 2026-04-24: **der må være 0,0000000 404-fejl i en hjerne**.
