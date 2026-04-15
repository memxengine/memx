# Session Start — Read This First

You are continuing work on **trail**, a mission-critical knowledge infrastructure engine. This document brings you up to speed. Read it fully before doing anything else.

---

## The Project

**trail** is the next-generation knowledge infrastructure engine. It turns sources into a persistent, compounding wiki maintained by an LLM. Unlike traditional RAG (fragments retrieved at query time), trail compiles knowledge into a structured wiki at ingest time.

Based on Andrej Karpathy's LLM Wiki pattern (Oct 2025), which in turn realizes Vannevar Bush's Memex vision from 1945.

**License:** FSL-1.1-Apache-2.0 (converts to Apache 2.0 after 2 years)
**GitHub:** https://github.com/broberg-ai/trail
**Local:** `/Users/cb/Apps/broberg-ai/trail`
**Owner:** Christian Broberg (WebHouse ApS)

---

## Who is Christian

- Founder & Chief Software Architect, WebHouse ApS (Aalborg, since 1995)
- Also Chief Software Architect at Senti.Cloud (IoT)
- Mac M1, Homebrew bash, VS Code, Claude Max plan (NOT API — avoid API-heavy solutions during dev)
- Communicates primarily in Danish. Uses "cc" for Claude Code.
- Prefers automation: run commands directly, never ask for copy-paste.

**Working style:**
- Prefer `claude -p` subprocess over Anthropic API during development
- All Fly.io/Supabase deployments use `arn` (Stockholm) region — never US, never Amsterdam
- Monorepo pattern: pnpm workspaces + Turbo
- Stack B: Bun + Hono + Drizzle + SQLite + Vite + Preact + Tailwind v4 + shadcn/ui

---

## Product Phases

### Phase 1 — MVP (current)
**Customer:** Sanne Andersen (healing/zoneterapi practice, Aalborg, 25 years of clinical material)
**Storage:** Local filesystem
**Tenancy:** Single-tenant (schema is tenant-aware from day 1, but only one tenant exists)
**Deploy:** Fly.io arn as `sanne.trailcloud.com` or similar

### Phase 2 — Business SaaS
**Domain:** trailcloud.com
**Customer #2:** FysioDK Aalborg (sport.fdaalborg.dk's "Digital Univers")
**Storage:** Cloudflare R2
**Multi-tenant:** LibSQL/Turso per-tenant OR Postgres RLS
**Billing:** Stripe (Hobby free / Pro $29 / Business $199)
**CMS Adapter:** @webhouse/cms (at `/Users/cb/Apps/webhouse/cms`) — strategically the most important

### Phase 3 — Enterprise/Scale
SSO (SAML), audit logs, on-prem, SOC 2, event-sourcing, real-time collab, trust tiers, provenance graph

---

## Predecessor: llmwiki-ts

A working prototype at `/Users/cb/Apps/cbroberg/llmwiki-ts` (GitHub: cbroberg/llmwiki-ts).

**Use it as reference, not to rename.** We copy what works, leave what doesn't.

What works in llmwiki-ts (migrate or port to trail):
- Hono API with Google OAuth + session cookies
- PDF pipeline (pdfjs-dist text + image extraction, custom PNG encoder, no heavy deps)
- MCP server (stdio, 5 tools: guide/search/read/write/delete)
- Chat endpoint with server-side retrieval + claude-p synthesis
- Ingest service spawning claude-p with MCP tools
- Markdown renderer with `[[wiki-links]]` and `[text|display]` pipe support
- ChatPanel with Save-to-wiki + KB picker dropdown
- FTS5 search
- Drizzle + SQLite schema (llmwiki-ts has older schema — trail has new tenant-aware one)

What's broken or needs improvement (do NOT copy blindly):
- Model default hardcoded to Sonnet-4-5 which isn't on Max plan → now empty default
- SSE for real-time updates flaky — we fall back to 3s polling during ingest
- Drizzle `sql` template with subqueries returns 0 → always use `rawDb.prepare()` for those
- No curation queue yet (was planned, never built)
- No vision AI for PDF images yet

---

## Current State of trail Repo

Already done (commits: `b256b04`, `0e11795`, `d8e6112`):

```
trail/
├── LICENSE                 ✓ FSL-1.1-Apache-2.0
├── README.md               ✓ With logo, overview, architecture
├── package.json            ✓ pnpm + Turbo root
├── pnpm-workspace.yaml     ✓
├── turbo.json              ✓
├── tsconfig.base.json      ✓
├── .env.example            ✓
├── .gitignore              ✓ With data/, *.db, .env, .mcp.json
├── docs/
│   ├── PLAN.md             ✓ Complete roadmap
│   ├── PRIMER.md           ✓ Historical: Christian's original vision message
│   ├── SESSION-START.md    ← This file
│   └── assets/
│       └── logo.svg        ✓ Final Recraft design
└── packages/
    ├── shared/             ✓ Zod schemas: tenant, user, KB, docs, queue, chat
    ├── db/                 ✓ Drizzle + SQLite schema (7 tables)
    │                         - tenants, users, sessions
    │                         - knowledge_bases
    │                         - documents (kind: source|wiki unified)
    │                         - document_chunks
    │                         - queue_candidates (curation queue!)
    │                         - wiki_events (history)
    └── storage/            ✓ Pluggable interface + LocalStorage implementation
                              - R2 implementation coming in Phase 2
```

What's NOT yet done:
- `packages/core/` — empty (needs: ingest, query, lint orchestration)
- `packages/llm/` — empty (needs: claude-p adapter + Anthropic API + Ollama)
- `packages/pipelines/` — empty (needs: PDF with vision AI, web, video)
- `apps/server/` — empty (migrate Hono API from llmwiki-ts with new schema)
- `apps/admin/` — empty (curator dashboard with queue UI)
- `apps/mcp/` — empty (MCP server — can port from llmwiki-ts)
- `apps/widget/` — empty (Phase 2: embeddable `<trail-chat>` Lit web component)
- `pnpm install` never run → no node_modules
- No `drizzle generate` run → no migrations
- No tests
- No Fly.io config

---

## Agreed Next Steps (in order)

1. **Migrate core from llmwiki-ts to `apps/server`** with tenant-aware schema. Port auth, KB routes, docs, uploads, chat, ingest, search. Single-tenant for Phase 1 (use a hardcoded tenant ID or auto-create on first user signup).

2. **Port PDF pipeline to `packages/pipelines/`** + **add vision AI** for image descriptions. Currently llmwiki-ts extracts images as PNGs but doesn't describe them. Use Claude vision (via claude-p or API) to describe each image during ingest. Store description as `{image}.txt` next to PNG.

3. **Build Curation Queue** — backend + UI. This is the new feature that distinguishes trail from llmwiki-ts:
   - Chat answer → candidate in queue
   - Auto-summaries with confidence score
   - Contradiction alerts (LLM detects when a new source conflicts with existing wiki)
   - Gap detection (queries with poor results → suggest new sources)
   - Curator dashboard: review, approve, edit, reject
   - Approved candidates compile back into wiki

---

## Tech Stack (Phase 1)

| Layer | Choice |
|---|---|
| Runtime | Bun (dev), Node 22 (prod) |
| API | Hono 4.6 |
| DB | SQLite via Drizzle + FTS5 |
| Frontend (admin) | Vite + Preact + Tailwind v4 + shadcn/ui |
| Frontend (widget, Phase 2) | Lit + Tailwind |
| MCP | @modelcontextprotocol/sdk (stdio) |
| LLM (dev) | `claude -p` subprocess |
| LLM (SaaS, Phase 2) | Anthropic API |
| Storage | Local filesystem (R2 interface ready) |
| Auth | Google OAuth 2.0 + session cookies |
| Deployment | Fly.io (arn/Stockholm) |
| Observability (later) | OpenTelemetry + Sentry + Logfire |

---

## Ports

Following the pattern from llmwiki-ts (3020/3021):

- `apps/server` → **3031**
- `apps/admin` → **3030**
- When second dev copy is needed, use Code Launcher API (https://cl.broberg.dk/api/vacant-port)

---

## Git + Deployment Flow

- Main branch: `main`
- All commits co-authored with `Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>`
- Never force-push, never skip hooks (--no-verify) unless explicitly requested
- trailcloud (private repo) will live at `broberg-ai/trailcloud` for SaaS platform layer
- Deploy flow (Phase 1): `fly deploy` from `apps/server`, static web from `apps/admin` to Fly or Cloudflare Pages

---

## Key Principles

1. **Curator, not dictator** — LLM proposes, human disposes. Curation queue is first-class.
2. **Provenance always** — every claim traceable to source version (Phase 3 formal, Phase 1 basic).
3. **Compound, don't chunk** — knowledge accumulates, not fragments.
4. **Embeddable by default** — widgets work on any site.
5. **Multi-provider LLM** — no vendor lock-in.
6. **Incremental complexity** — Phase 1 is deployable, Phase 2/3 build without rewrites.
7. **API-first** — every UI action maps to API.
8. **Tenant-aware from day 1** — schema ready even if only one tenant exists.

---

## Start Here

Your job: execute Step 1 from "Agreed Next Steps" — migrate the core of llmwiki-ts into `apps/server` with the new tenant-aware schema.

**Before coding:**
1. Read `docs/PLAN.md` in full
2. Read `packages/db/src/schema.ts` to understand the new schema
3. Read `packages/shared/src/schemas.ts` for Zod contracts
4. Skim `/Users/cb/Apps/cbroberg/llmwiki-ts/apps/server/` to see what's being migrated

**Then:**
1. Run `pnpm install` in trail repo root
2. Generate Drizzle migrations: `cd packages/db && npx drizzle-kit generate`
3. Create `apps/server/` with package.json, tsconfig.json, src/index.ts, src/app.ts
4. Port routes from llmwiki-ts, adapting to new schema (add tenantId everywhere, use documents.kind column for source/wiki distinction)
5. Test with `bun run apps/server/src/index.ts` on port 3031
6. Commit in logical chunks

**Don't:**
- Don't rename or delete llmwiki-ts (it's the reference + test bed)
- Don't skip the curation queue — it's the big new feature (plan ahead for it even in the server routes)
- Don't use deprecated APIs, don't write symptom fixes, don't use API-heavy solutions (use claude -p)
- Don't commit `.env`, `.mcp.json`, `data/`, or database files

Good luck. You're building the Memex.
