# Session Start — Read This First

You are continuing work on **trail**, a knowledge infrastructure engine. This document gets a fresh CC session up to speed in two minutes.

---

## The Project

**trail** compiles sources into a persistent, cross-referenced wiki maintained by an LLM. Unlike RAG (fragments retrieved at query time), trail does its work at ingest time — every source enriches a structured knowledge graph of **Nodes** (knowledge bases) and **Neurons** (compiled wiki pages).

Based on Andrej Karpathy's LLM Wiki pattern (Oct 2025), itself a realisation of Vannevar Bush's 1945 Memex vision. The name is from Bush's term "associative trails" — the core mechanism of the Memex.

- **License:** FSL-1.1-Apache-2.0 (converts to Apache 2.0 after 2 years)
- **GitHub:** https://github.com/broberg-ai/trail
- **Local:** `/Users/cb/Apps/broberg/trail`
- **Org:** broberg-ai (domain: broberg.ai)
- **Owner:** Christian Broberg (WebHouse ApS)

### Naming convention (important)

- **Engine/schema:** uses `knowledge_base` and `documents.kind='source'|'wiki'` — internal, stable contract for all consumers
- **Brand/UX:** "Nodes" (= knowledge bases) and "Neurons" (= compiled wiki pages) — use these in landing, memxcloud successor, demo site, and public copy
- **"Memex":** always refers to Vannevar Bush's 1945 device — historical reference, kept intact across docs
- **"trail":** the product/repo name — pivoted from "memx" (trademark conflict) on 2026-04-15. Preserved the inspirational lineage; changed the trademarked label

---

## Who is Christian

- Founder & Chief Software Architect, WebHouse ApS (Aalborg, since 1995)
- Also Chief Software Architect at Senti.Cloud (IoT)
- Mac M1, Homebrew bash, VS Code, Claude Max plan (NOT API — avoid API-heavy solutions during dev)
- Communicates primarily in Danish. Uses "cc" for Claude Code.
- Prefers automation: run commands directly, never ask for copy-paste.

**Working style:**
- Prefer `claude -p` subprocess over Anthropic API during development; flip to API once stable (per-route opt-in via `TRAIL_CHAT_BACKEND=api`)
- All Fly.io/Supabase deployments use `arn` (Stockholm) region — never US, never Amsterdam
- Monorepo pattern: pnpm workspaces + Turbo
- Stack B: Bun + Hono + Drizzle + SQLite + Vite + Preact + Tailwind v4 + shadcn/ui

---

## Product Phases

### Phase 1 — MVP (Phase 1 server-stack complete as of 2026-04-15)
**Customer:** Sanne Andersen (healing/zoneterapi practice, Aalborg, 25 years of clinical material)
**Storage:** Local filesystem (R2 interface ready)
**Tenancy:** Single-tenant (schema is tenant-aware from day 1; auth auto-creates a tenant on first OAuth signup)
**Deploy target:** Fly.io arn

### Phase 2 — Business SaaS
**Domain:** TBD (trademark-cleared replacement for memxcloud)
**Customer #2:** FysioDK Aalborg (sport.fdaalborg.dk's "Digital Univers")
**Storage:** Cloudflare R2
**Multi-tenant:** LibSQL/Turso per-tenant OR Postgres RLS
**Billing:** Stripe (Hobby free / Pro $29 / Business $199)
**CMS Adapter:** `@webhouse/cms` (at `/Users/cb/Apps/webhouse/cms`) — strategically the most important adapter

### Phase 3 — Enterprise/Scale
SSO (SAML), audit logs, on-prem, SOC 2, event-sourcing, real-time collab, trust tiers, provenance graph

---

## Current State of the Repo

**Done — Phase 1 server stack is feature-complete and runs end-to-end:**

```
trail/
├── apps/
│   ├── server/             ✓ Hono API on :3031 (auth, KBs, docs, uploads, chat, ingest, search, stream, images, user)
│   ├── mcp/                ✓ stdio MCP server with guide/search/read/write/delete
│   ├── admin/              (empty — see Open Questions below)
│   └── widget/             (empty — Phase 2: <trail-chat> Lit web component)
├── packages/
│   ├── shared/             ✓ Zod contracts
│   ├── db/                 ✓ Drizzle schema (9 tables) + FTS5 with auto-sync triggers
│   ├── storage/            ✓ LocalStorage + pluggable interface (R2 coming Phase 2)
│   ├── pipelines/          ✓ PDF extraction (pdfjs-dist) + pluggable vision AI
│   ├── core/               (empty — optional, can live in apps/server)
│   └── llm/                (empty — claude-p lives in apps/server/services/claude.ts for now)
├── docs/
│   ├── PLAN.md             Phase 1/2/3 roadmap
│   ├── PRIMER.md           Christian's original vision message
│   ├── PLAN-PATCH.md       Schema additions accepted from planning session
│   ├── as-we-may-think.md  Long-form essay on Bush → trail lineage
│   ├── crdt-local-first.md Future sync model (not Phase 1)
│   ├── SESSION-START.md    ← This file
│   └── assets/             Logos + Bush illustrations
└── infra/                  (Fly.io configs — TBD)
```

**Schema (9 tables):** tenants, users, sessions, knowledge_bases, documents (kind: source|wiki, is_canonical), document_chunks, queue_candidates (12 kinds + auto_approved_at), document_references (bidirectional), wiki_events (replay-able with prev_event_id + content_snapshot)

**FTS:** documents_fts + chunks_fts as contentless FTS5 with AFTER INSERT/UPDATE/DELETE triggers — always in sync.

**Verified end-to-end:**
- Markdown source upload → `claude -p` + MCP ingest → 6-8 cross-referenced wiki pages in ~60-100s
- 8-page Danish PDF (NADA acupuncture) → pipeline extracts text + 6 images → ingest compiles 7 wiki pages in ~155s total
- Vision skipped when no `ANTHROPIC_API_KEY`; runs via Anthropic vision API when set

**Not yet done (next natural work):**
- Curation queue endpoints (schema exists, no HTTP routes yet)
- Demo consumer (Vite+Preact reference implementation of `<trail-chat>`)
- Fly.io deploy config (`infra/fly/`)
- Landing site (first target: `trail.broberg.ai`)

---

## Predecessor: llmwiki-ts

Original prototype at `/Users/cb/Apps/cbroberg/llmwiki-ts`. **Migration is complete** — don't re-port anything. Keep it around as a historical reference if a specific behaviour needs cross-checking.

---

## Tech Stack (Phase 1)

| Layer | Choice |
|---|---|
| Runtime | Bun (dev), Node 22 (prod) |
| API | Hono 4.6 |
| DB | SQLite via Drizzle + FTS5 |
| Frontend (demo/widget) | Vite + Preact + Tailwind v4 + shadcn/ui (not yet scaffolded) |
| MCP | @modelcontextprotocol/sdk (stdio) |
| LLM (dev) | `claude -p` subprocess |
| LLM (prod, later) | Anthropic API via `TRAIL_CHAT_BACKEND=api` |
| Vision (optional) | Anthropic vision API (haiku) for PDF image descriptions |
| Storage | LocalStorage (packages/storage) — R2 drop-in Phase 2 |
| Auth | Google OAuth 2.0 + session cookies |
| Deployment | Fly.io (arn/Stockholm) |
| Observability (later) | OpenTelemetry + Sentry + Logfire |

---

## Environment Variables

| Var | Default | Notes |
|---|---|---|
| `PORT` | 3031 | Server port |
| `APP_URL` | `http://localhost:3030` | CORS origin |
| `API_URL` | `http://localhost:3031` | OAuth callback base |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | — | Required for auth |
| `TRAIL_DATA_DIR` | `./data` | SQLite DB + uploads root |
| `TRAIL_DB_PATH` | `{DATA_DIR}/trail.db` | |
| `TRAIL_UPLOADS_DIR` | `{DATA_DIR}/uploads` | |
| `TRAIL_MCP_ENTRY` | `../mcp/src/index.ts` | Absolute path baked into `data/mcp.json` |
| `CLAUDE_BIN` | `claude` | CLI binary |
| `CHAT_MODEL` | `claude-haiku-4-5-20251001` | |
| `INGEST_MODEL` | (empty = plan default) | |
| `INGEST_TIMEOUT_MS` | 180000 | |
| `CHAT_TIMEOUT_MS` | 30000 | |
| `VISION_MODEL` | `claude-haiku-4-5-20251001` | |
| `ANTHROPIC_API_KEY` | — | Enables vision + direct-API chat |
| `TRAIL_CHAT_BACKEND` | (unset → CLI) | Set to `api` to flip chat to Anthropic API |

---

## Ports

- `apps/server` → **3031**
- Demo / admin (when scaffolded) → **3030**
- Second dev copy → Code Launcher API (https://cl.broberg.dk/api/vacant-port)

---

## Git + Deployment Flow

- Main branch: `main`
- Remote: `https://github.com/broberg-ai/trail.git`
- All commits co-authored with `Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>`
- Never force-push, never skip hooks (`--no-verify`) unless explicitly requested
- Phase 1 deploy: `fly deploy` from `apps/server`; landing/demo as static to Fly or Cloudflare Pages
- First subdomain target: **trail.broberg.ai** (landing)

---

## Key Principles

1. **Curator, not dictator** — LLM proposes, human disposes. Curation queue is first-class.
2. **Provenance always** — every claim traceable to source version (schema has `document_references`; Phase 3 gets formal claims table).
3. **Compound, don't chunk** — knowledge accumulates, not fragments.
4. **Engine is UI-less** — every UI is a consumer. Demo site ≠ the engine.
5. **Multi-provider LLM** — no vendor lock-in.
6. **Incremental complexity** — Phase 1 is deployable, Phase 2/3 build without rewrites.
7. **API-first** — every UI action maps to an API call.
8. **Tenant-aware from day 1** — schema ready even if only one tenant exists.
9. **Historical lineage preserved** — "Memex" stays as Bush's term throughout the docs, even after the trail rebrand.

---

## Quick-Start for a Fresh Session

```bash
# 1. Boot the engine
cd /Users/cb/Apps/broberg/trail
pnpm install                 # already up to date in most cases
cd apps/server && bun run src/index.ts    # → http://localhost:3031

# 2. Seed a tenant+user+session (dev shortcut — Google OAuth is the real flow)
bun -e "
const {Database}=require('bun:sqlite');
const d=new Database('./data/trail.db');
const now=new Date().toISOString();
const exp=new Date(Date.now()+86400000).toISOString();
d.run(\"INSERT INTO tenants(id,slug,name,plan,created_at) VALUES('t1','me','Me','hobby',?)\",[now]);
d.run(\"INSERT INTO users(id,tenant_id,email,display_name,role,onboarded,created_at,updated_at) VALUES('u1','t1','me@x.com','Me','owner',0,?,?)\",[now,now]);
d.run(\"INSERT INTO sessions(id,user_id,expires_at,created_at) VALUES('s1','u1',?,?)\",[exp,now]);
"

# 3. Upload a source (auto-triggers ingest)
curl -H "Cookie: session=s1" -H "Content-Type: application/json" \
  -d '{"name":"Test"}' http://localhost:3031/api/v1/knowledge-bases
# → use returned id as KB_ID
curl -H "Cookie: session=s1" -F "file=@some-source.md" \
  http://localhost:3031/api/v1/knowledge-bases/$KB_ID/documents/upload
# wait ~60-100s, check wiki pages:
sqlite3 ./data/trail.db "SELECT path,filename,version FROM documents WHERE kind='wiki' ORDER BY path"
```

---

## Don'ts

- Don't rename or delete `llmwiki-ts` (historical reference)
- Don't use deprecated APIs or symptom fixes
- Don't commit `.env`, `.mcp.json`, `data/`, or database files
- Don't hard-code "memx" anywhere — the rebrand is complete (2026-04-15). "Memex" (capital M) stays; "memx" (lowercase, product) is gone
- Don't mix engine schema with brand vocabulary — the DB speaks `knowledge_base`/`documents.kind='wiki'`; the UI/docs speak Nodes/Neurons

---

## Open Questions the User Is Still Thinking About

- SaaS domain (former memxcloud — needs a trademark-cleared replacement)
- Admin/demo site framing: pure reference demo in this repo vs. separate `broberg-ai/trail-demo` repo
- Whether to start on the curation queue endpoints or the landing site next

When in doubt: ask before building a UI layer; the engine contract is the stable part.
