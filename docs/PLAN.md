# memx — Plan

> The next-generation knowledge infrastructure engine.
> Realizing Vannevar Bush's 1945 Memex vision with modern LLMs.

**Status:** Phase 1 (MVP) in progress
**License:** FSL-1.1-Apache-2.0 (converts to Apache 2.0 after 2 years)
**Organization:** [memxengine](https://github.com/memxengine)

---

## Vision

Knowledge accumulates. Questions compound answers. Every source makes the system smarter — not via retrieval of fragments at query time, but via a persistent, cross-referenced wiki that an LLM maintains on behalf of a human curator.

memx is the engine. It powers:

- **memxcloud** — our managed SaaS
- **Customer installations** — WebHouse customers (Sanne, FysioDK, etc.)
- **Self-hosted deployments** — any team wanting knowledge infrastructure
- **CMS modules** — embedded in @webhouse/cms and other platforms

---

## Core Concepts

### Three-Layer Architecture (Karpathy's LLM Wiki pattern)

1. **Sources** — immutable raw materials (PDFs, articles, transcripts, notes)
2. **Wiki** — LLM-compiled markdown with cross-references, entity pages, concept pages
3. **Schema** — conventions and workflows that guide the compiler

### The Four Operations

- **Ingest** — read source → extract → compile into wiki → touch 5-15 pages
- **Query** — search wiki → read pages → synthesize answer with citations
- **Curate** — review chat answers, suggestions, candidates → approve → feed back
- **Lint** — periodic health-check: contradictions, orphans, gaps, missing cross-refs

### What Makes memx Different from RAG

| | RAG | memx |
|---|---|---|
| Model | Search engine | Encyclopedia |
| Work happens | Query time | Ingest time |
| Knowledge | Fragmented chunks | Compiled wiki pages |
| Accumulates? | No | Yes |
| Cross-references | Implicit (embeddings) | Explicit ([[links]]) |
| Feedback loop | None | Curated answers → new sources |
| Skala sweet-spot | Millions of docs | Hundreds to low thousands |

---

## Product Strategy

### Three Phases

**Phase 1 — MVP (Single-tenant, file storage)**
First customer: Sanne Andersen. Goal: validate pattern end-to-end with real domain knowledge.

**Phase 2 — Business (Multi-tenant SaaS)**
Launch memxcloud.com. Onboard FysioDK Aalborg as customer #2. @webhouse/cms adapter. Stripe billing.

**Phase 3 — Enterprise/Scale**
SSO, audit logs, on-premises, SOC 2, event sourcing, real-time collaboration.

---

## Phase 1 — MVP Deliverables

### Customer target
Sanne Andersen. Single-tenant. Deployed on Fly.io arn as `sanne.memxcloud.com` (or similar).

### Features

- [x] Monorepo scaffolding (pnpm + Turbo)
- [x] FSL-1.1-Apache-2.0 license
- [ ] Server: Hono + SQLite + Drizzle with tenant-aware schema
- [ ] Auth: Google OAuth + session cookies
- [ ] Knowledge bases: multiple per tenant
- [ ] Sources: upload, list, delete, soft-archive
- [ ] PDF pipeline: text + image extraction + vision AI descriptions
- [ ] Ingest: auto-trigger, `claude -p` subprocess, MCP tools
- [ ] Wiki: compiled markdown with cross-refs, version history
- [ ] Chat: server-side retrieval + claude synthesis, multi-KB
- [ ] Citations: [[wiki-links]] that navigate correctly
- [ ] Image serving: authenticated `GET /images/:docId/:filename`
- [ ] Curation Queue: chat-answer → review → approve → compile back into wiki
- [ ] Admin UI: sidebar with wiki tree + sources, chat panel, curator queue
- [ ] MCP server: `guide`, `search`, `read`, `write`, `delete`, `queue` tools
- [ ] Embeddable widget: `<memx-chat tenant="..." kb="...">` web component
- [ ] Deploy: Fly.io arn, Google OAuth production credentials

### Tech Stack (Phase 1)

| Layer | Choice |
|---|---|
| Runtime | Bun (dev), Node 22 (prod) |
| API | Hono 4.6 |
| DB | SQLite via Drizzle ORM + FTS5 |
| Frontend (admin) | Vite + Preact + Tailwind v4 |
| Frontend (widget) | Lit + Tailwind (web component) |
| MCP | @modelcontextprotocol/sdk (stdio) |
| LLM | `claude -p` subprocess (default), Anthropic API (opt-in) |
| Storage | Local filesystem (R2 interface ready) |
| Auth | Google OAuth 2.0 + session cookies |
| Deployment | Fly.io (arn/Stockholm) |

### Non-goals for Phase 1

- Multi-tenancy (data model is tenant-aware, but only one tenant exists)
- R2/S3 storage (local FS is fine for single-tenant)
- Billing (manual for Sanne)
- SSO
- Real-time collaboration
- Vector search (FTS5 is enough for <1000 pages)
- Audit logs
- @webhouse/cms adapter (Phase 2)

---

## Phase 2 — Business (Multi-tenant SaaS)

### Customer targets
- memxcloud.com launches
- FysioDK Aalborg
- Open to signups for waitlist

### New features

- [ ] Multi-tenancy: LibSQL/Turso per-tenant DB, or Postgres RLS
- [ ] Tenant provisioning + signup flow
- [ ] Cloudflare R2 storage abstraction
- [ ] Stripe billing: Hobby (free), Pro ($29/mo), Business ($199/mo)
- [ ] Usage metering: queries, sources, storage
- [ ] @webhouse/cms adapter
- [ ] Web clipper pipeline (Obsidian-style)
- [ ] Video transcription pipeline
- [ ] Audio transcription pipeline
- [ ] Email/Slack ingest pipelines
- [ ] Advanced curation queue: auto-summary confidence, gap detection, contradiction alerts
- [ ] Widget customization: CSS variables, branding
- [ ] Analytics dashboard for curators
- [ ] Domain mapping: custom subdomains per tenant
- [ ] Adapter SDK for 3rd-party CMS integrations

### Tech additions

- LibSQL/Turso for per-tenant DBs
- Cloudflare R2 for storage
- Cloudflare Workers for edge chat (optional)
- Turbopuffer for vector search (dedup, contradictions)
- Stripe for billing
- BullMQ or Cloudflare Queues for background jobs

---

## Phase 3 — Enterprise/Scale

### Customer targets
- Compliance-sensitive industries (healthcare, legal, finance)
- Large organizations requiring SSO and audit
- On-premises deployments

### New features

- [ ] SSO: SAML 2.0 + SCIM
- [ ] Audit logs with retention policies
- [ ] On-premises Docker/Helm deployment
- [ ] SOC 2 Type II preparation
- [ ] Event sourcing for full wiki history
- [ ] Time-travel queries ("what did the wiki say in January?")
- [ ] Real-time collaboration (CRDT-based)
- [ ] Multi-region deployments
- [ ] Advanced analytics
- [ ] Custom LLM provider adapters (Azure OpenAI, Ollama, Bedrock)
- [ ] Dedicated PostgreSQL option for enterprises
- [ ] Trust tiers + provenance graph (claims → sources)
- [ ] Continuous lint (not periodic)
- [ ] SLA contracts

---

## Repository Structure

```
memx/
├── apps/
│   ├── server/              # Hono API (core engine)
│   ├── admin/               # Curator dashboard (Vite+Preact)
│   ├── mcp/                 # MCP server (stdio)
│   └── widget/              # Embeddable <memx-chat> web component (Lit)
├── packages/
│   ├── core/                # Engine: ingest, compile, query, lint
│   ├── db/                  # Drizzle + SQLite schema + migrations
│   ├── storage/             # Filesystem + R2 abstraction
│   ├── llm/                 # Multi-provider adapter
│   ├── pipelines/           # PDF, vision, web, video, audio
│   └── shared/              # Types + Zod schemas
├── adapters/                # (Phase 2+)
│   ├── webhouse-cms/        # @webhouse/cms adapter
│   ├── wordpress/           # WordPress plugin
│   ├── sanity/              # Sanity connector
│   └── notion/              # Notion sync
├── docs/                    # Living documentation
│   ├── PLAN.md              # This file
│   ├── ARCHITECTURE.md      # Tech decisions
│   ├── INGEST.md            # Ingest workflow spec
│   └── assets/              # Logos, diagrams
├── infra/
│   └── fly/                 # Fly.io deployment configs
└── scripts/                 # Dev/deploy scripts
```

### Related repositories

- `memxengine/memx` — this repo (FSL-1.1-Apache-2.0)
- `memxengine/memxcloud` — SaaS platform (private, proprietary)
- `memxengine/memx-enterprise` — Phase 3 enterprise features (private, proprietary)
- `memxengine/memx-docs` — memx.wiki docs site (Apache 2.0)

---

## Brand and Domains

- **memx.wiki** — flagship/docs site (our own dogfood wiki)
- **memxcloud.com** — SaaS
- **memxengine.com** — enterprise portal
- **memxdev.com** — developer docs + SDK downloads
- **mem3x.com** — defensive, redirect

---

## Naming Conventions

- Product: **memx** (lowercase, single word)
- Company/org: **memxengine** (on GitHub)
- Shell command: `memx` (future CLI)
- API prefix: `/api/v1/`
- Database: `memx.db` (SQLite default)

---

## Design Principles

1. **API-first** — every UI action maps to an API call, third-party integrations are first-class
2. **Curator, not dictator** — LLM proposes, human disposes; nothing reaches wiki without approval option
3. **Provenance always** — every claim traceable to source version
4. **Compound, don't chunk** — viden akkumuleres, ikke fragmenteres
5. **Embeddable by default** — widgets work on any site, any framework
6. **Multi-provider LLM** — no vendor lock-in on the AI layer
7. **Incremental complexity** — Phase 1 is deployable, Phase 2/3 builds without rewrites
