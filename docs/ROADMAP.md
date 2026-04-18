# Trail — Roadmap

**Last updated:** 2026-04-18
**Source of truth for feature numbering:** [FEATURES.md](./FEATURES.md)

---

## Philosophy

Trail ships in three phases. Each phase is independently deployable; Phase 2 and Phase 3 build on Phase 1 without rewrites. The numbering scheme is stable — features keep their F-number across phases.

| Phase | Audience | Storage | Tenancy | Billing |
|-------|----------|---------|---------|---------|
| **1 — MVP** | Sanne Andersen (customer #1) | Local filesystem | Single-tenant (schema-aware) | Manual |
| **2 — Business SaaS** | FysioDK + open signups | R2 | Multi-tenant (LibSQL or Postgres RLS) | Stripe |
| **3 — Enterprise** | Healthcare / Legal / Financial | Customer-owned or dedicated | Hybrid (SaaS + on-prem) | Contract |

---

## Phase 1 — MVP · Done (20 features)

Everything needed to run an end-to-end ingest → wiki → chat flow for a single-tenant customer.

| # | Feature | Shipped |
|---|---------|---------|
| F01 | Monorepo + FSL-1.1-Apache-2.0 License | 2026-04 |
| F02 | Tenant-Aware Drizzle Schema + SQLite + FTS5 (9 tables) | 2026-04 |
| F03 | Google OAuth + Session Cookies | 2026-04 |
| F04 | Knowledge Bases CRUD | 2026-04 |
| F05 | Sources (Upload, List, Archive) | 2026-04 |
| F06 | Ingest Pipeline (Claude Code subprocess + MCP) | 2026-04 |
| F07 | Wiki Document Model + Cross-References | 2026-04 |
| F08 | PDF Pipeline (Text + Images + Anthropic Vision) | 2026-04 |
| F09 | Markdown Ingest Pipeline | 2026-04 |
| F10 | FTS5 Full-Text Search with Auto-Sync Triggers | 2026-04 |
| F11 | MCP Stdio Server (Guide/Search/Read/Write/Delete) | 2026-04 |
| F12 | Chat Endpoint (Synthesize + Cite) | 2026-04 |
| F13 | LocalStorage Adapter + Pluggable Storage Interface | 2026-04 |
| F14 | Multi-Provider LLM Adapter (`claude -p` + Anthropic API) | 2026-04 |
| F15 | Bidirectional `document_references` | 2026-04 |
| F16 | Wiki Events (Replay-Able Event Stream, Full Payloads) | 2026-04 |
| F87 | Typed Event Stream (SSE) + Live Badges + Per-Panel Reactivity | 2026-04 |
| F89 | Chat Tools — MCP-Backed Introspection for Structural Questions | 2026-04 |
| F90 | Dynamic Curator Actions + Per-Trail Lint Policy + Action Translation | 2026-04 |
| F91 | Neuron Editor (Markdown Split-View, Queue-Routed Save) | 2026-04 |

**End-to-end verified:** Markdown source → 6-8 cross-referenced wiki pages in ~60-100s. 8-page Danish PDF (NADA acupuncture) → 6 images extracted → vision-described → 7 wiki pages in ~155s.

---

## Phase 1 — MVP · In Progress

| # | Feature | Owner | Target |
|---|---------|-------|--------|
| F34 | Landing Site Deploy (`trail.broberg.ai`) — built, awaiting DNS + Fly.io | trail | 2026-04 |

---

## Phase 1 — MVP · Planned Next (sequenced)

The remaining Phase 1 scope, ordered by leverage and dependency.

### Unblockers — must land to call Phase 1 complete

| # | Feature | Depends On | Effort | Status |
|---|---------|------------|--------|--------|
| F17 | Curation Queue — HTTP Endpoints + sole wiki write path | F16 | Medium | ✅ Done |
| F18 | Curator UI Shell (Vite + Preact + shadcn) | F17 | Medium | 🏗 In progress (session 1 done) |
| F19 | Auto-Approval Policy Engine | F17 | Small | ✅ Done (stub + trusted-pipeline) |
| F40.1 | libSQL driver swap (still single-tenant) | F02 | Small | ⏭ Next |
| F33 | Fly.io Arn Deploy for `apps/server` | F40.1 | Small | ⏭ Planned |
| F35 | Google OAuth Production Credentials | F33 | Small | ⏭ Planned |
| F62 | demo.trailmem.com — public reference site | F17, F18 | Medium | ⏭ Planned |
| F37 | Sanne Customer Onboarding | F17, F18, F33, F35 | Medium | ⏭ Planned |

### Quality + UX — ship with Phase 1

| # | Feature | Depends On | Effort |
|---|---------|------------|--------|
| F20 | Curator Diff UI | F18, F16 | Small |
| F21 | Ingest Backpressure | F17 | Small |
| F22 | Stable `{#claim-xx}` Anchors | F07 | Small |
| F23 | Wiki-Link Parser (`[[]]`, `[[kb:]]`, `[[ext:]]`) | F07 | Small |
| F30 | Chat Citations Render | F12, F23 | Small |
| F32 | Lint Pass (Orphans/Gaps/Contradictions) | F15, F17 | Medium |
| F93 | Button Sound Feedback (Opt-In, Web Audio) | F18, F87 | Small |

### Pipelines + Adapters — widen the ingest surface

| # | Feature | Depends On | Effort |
|---|---------|------------|--------|
| F24 | DOCX Pipeline | F28 | Small |
| F25 | Image Pipeline (Standalone + SVG Passthrough) | F28, F27 | Small |
| F26 | HTML / Web Clipper Ingest | F28 | Small |
| F27 | Pluggable Vision Adapter | F08 | Small |
| F28 | Pluggable Pipeline Interface | F06 | Medium |

### Widget + Embed — let consumers integrate

| # | Feature | Depends On | Effort |
|---|---------|------------|--------|
| F29 | `<trail-chat>` Embeddable Widget (Lit) | F12 | Medium |
| F31 | Reader Feedback Button → Queue | F17, F29 | Small |

### Dogfooding

| # | Feature | Depends On | Effort |
|---|---------|------------|--------|
| F36 | `docs.trailmem.com` as a Trail Brain | F17, F28, F33, F40 | Medium |

---

## Phase 2 — Business SaaS · Planned (22 features)

Multi-tenant SaaS, billing, richer pipelines, first 3rd-party adapters.

### Infrastructure

| # | Feature | Priority |
|---|---------|----------|
| F40 | Multi-Tenancy on `app.trailmem.com` (LibSQL/Turso or Postgres RLS) | Must |
| F41 | Tenant Provisioning + Signup Flow | Must |
| F42 | Cloudflare R2 Storage Adapter | Must |
| F43 | Stripe Billing (Hobby / Pro / Business) | Must |
| F44 | Usage Metering | Must |
| F53 | Custom Subdomains per Tenant | Should |
| F61 | ~~SaaS Domain Pick~~ — **Done: `trailmem.com`** | — |

### SaaS Product UX

| # | Feature | Priority |
|---|---------|----------|
| F38 | Cross-Trail Search + Chat (Frontpage) | Must — this is the SaaS product |

### Strategic Adapter + Customer #2

| # | Feature | Priority |
|---|---------|----------|
| F45 | `@webhouse/cms` Adapter — the strategic integration | Must |
| F52 | FysioDK Aalborg Onboarding (Customer #2, via F45) | Must |

### Richer Pipelines

| # | Feature | Priority |
|---|---------|----------|
| F46 | Video Transcription Pipeline | Should |
| F47 | Audio Transcription Pipeline | Should |
| F48 | Email Ingest Pipeline | Could |
| F49 | Slack Ingest Pipeline | Could |
| F50 | Web Clipper Browser Extension | Could |

### Widget Growth

| # | Feature | Priority |
|---|---------|----------|
| F51 | Widget Customization (CSS Variables + Branding) | Should |

### Adapters (3rd-Party CMS/Knowledge Systems)

| # | Feature | Priority |
|---|---------|----------|
| F55 | Adapter SDK (`@trail/adapter-sdk`) | Must — gates F58-F60 |
| F58 | WordPress Adapter | Should |
| F59 | Sanity Adapter | Could |
| F60 | Notion Adapter + Sync | Could |

### Curator Tools

| # | Feature | Priority |
|---|---------|----------|
| F54 | Analytics Dashboard for Curators | Should |
| F56 | Wiki Freshness Scoring in Lint | Should |
| F57 | Gap Suggestions from Low-Confidence Queries | Should |
| F92 | Tags on Neurons (Filter + Facet + Auto-Suggest) | Should |

---

## Phase 3 — Enterprise · Planned (17 features)

Regulated industries, on-prem, compliance, advanced architecture.

### Identity + Compliance

| # | Feature | Priority |
|---|---------|----------|
| F70 | SSO: SAML 2.0 + SCIM | Must |
| F71 | Audit Logs + Retention | Must |
| F73 | SOC 2 Type II Preparation | Must |
| F81 | Per-KB Encryption at Rest | Must |

### Deployment Surface

| # | Feature | Priority |
|---|---------|----------|
| F72 | On-Prem Docker / Helm Deploy | Must |
| F77 | Multi-Region Deployments | Should |
| F84 | Dedicated PostgreSQL Option | Should |
| F86 | SLA Contracts + Monitoring | Should |

### Event-Sourcing Unlocks (free because F16 is already event-sourced)

| # | Feature | Priority |
|---|---------|----------|
| F74 | Time-Travel Queries | Should |
| F75 | Undo / Redo via Event Stream | Should |
| F76 | Real-Time Collaboration (CRDT) | Could |

### Knowledge Architecture

| # | Feature | Priority |
|---|---------|----------|
| F78 | Trust Tiers + Provenance Graph (Claims Table, joins F22 anchors) | Should |
| F79 | Scheduled Wiki Re-Compilation | Could |
| F80 | Federated Trail (`[[ext:…]]` Links) | Could |
| F85 | Continuous Lint (Real-Time, Not Periodic) | Could |

### Provider Flexibility

| # | Feature | Priority |
|---|---------|----------|
| F82 | Custom LLM Provider Adapters (Azure / Ollama / Bedrock) | Should |

### Curator Power Tools

| # | Feature | Priority |
|---|---------|----------|
| F83 | CLI for Curators (`trail queue approve …`) | Could |

---

## Critical path (top-down)

```
✅ F17    Queue API (sole wiki write path, two-session landed)
✅ F18.1  Curator UI — Session 1 (queue panel on apps/admin)

⏭ F40.1  libSQL driver swap (bun:sqlite → @libsql/client, still single-tenant, ~1 day)
⏭ F33    Fly.io server deploy (arn, volumes, healthchecks)
⏭ F35    OAuth production credentials (for F33's first real login)
⏭ F18.2  Curator UI — Session 2 (sources + wiki tree panels)
⏭ F62    demo.trailmem.com — polished public reference site ← forcing function for component polish
⏭ F37    Sanne live

F28 Pipeline interface ─┬─► F24 DOCX
                        ├─► F25 Image/SVG
                        └─► F26 HTML

F29 Widget + F31 Feedback ─► Phase 2-ready consumer story

F45 @webhouse/cms adapter + F40.2 Multi-tenancy ─► F52 FysioDK

F40.2 Multi-tenancy ─┬─► F38 Cross-Trail search/chat ─► app.trailmem.com
                     └─► F36 docs.trailmem.com (Trail brain of our docs)

Public-facing trailmem.com surfaces (all Phase 1-shippable):
  F34   trailmem.com + www + trail.broberg.ai (landing — built, awaiting deploy)
  F62   demo.trailmem.com (demo brain, public)
  F36   docs.trailmem.com (Trail brain of trail's own docs — depends on F40.2)
```

**Phase-1 shippable definition:** F17 ✓ + F18 (complete) + F40.1 + F33 + F35 + F62 + F37 = Sanne on a live single-tenant engine, with `trailmem.com` (landing), `demo.trailmem.com` (polished showcase), and `sanne.trail.broberg.ai` (Sanne's instance) all live. F40.2 unlocks SaaS; F36 unlocks the docs-brain.

---

## Decisions still owed

1. **F37 — Sanne deploy topology** — single-tenant on her own subdomain (`sanne.trail.broberg.ai`) vs. dedicated tenant on `app.trailmem.com` once F40.2 lands. Recommend single-tenant Fly.io app while F40.2 is still being designed, then migrate into the SaaS once multi-tenancy is real.
2. **Brand naming** — user-facing label for a knowledge-base/wiki container. F38's plan doc assumes **Trail** / **Neuron**. Flagged as still open on user's side; lock in before F38 copy ships.
3. **F62 demo content** — which clinical domain (if any) to include. Sanne's material with consent, or an anonymised public-licensed alternative.

## Decisions resolved

- **F61 — SaaS domain** — `trailmem.com` registered at Cloudflare (2026-04-16). Subdomain map: `trailmem.com` + `www.trailmem.com` = landing (F34), `demo.trailmem.com` = public reference (F62), `docs.trailmem.com` = docs-as-Trail (F36), `app.trailmem.com` = SaaS engine (F40.2/F41). `trail.broberg.ai` remains as the engine-facing mirror of the landing.
- **F36 — Dogfood hosting** — tenant on `app.trailmem.com` (`trailwiki` tenant). Not self-hosted. Justification: the dogfood is more credible when it runs on the same multi-tenant infrastructure customers do.
- **F40 — Multi-tenancy strategy** — **libSQL embedded per-tenant** (one `.db` file per tenant on Fly Volume). Not Turso Cloud. Not Postgres RLS. Postgres stays available as a Phase 3 emergency path via `@trail/db`'s adapter pattern. Locked in SAAS-SCALING-PLAN.md 2026-04-16.
- **F42 — Storage** — **Tigris default + R2 alternative** via pluggable adapters. Per-tenant choice, `AWS_*` env convention, per-tenant migration as a background job. Locked in SAAS-SCALING-PLAN.md 2026-04-16.

---

## How to read this roadmap

- **FEATURES.md** is the index — every F-number, plan-doc link, status.
- **This file** groups features by phase + priority; it's what to read to plan a sprint.
- **docs/features/F{nn}-*.md** is the plan doc for each feature. Detailed design, impact analysis, implementation steps.
- Run `/feature "<idea>"` to add a new feature — duplicate-checks, numbering, plan scaffold, index updates, commit.
