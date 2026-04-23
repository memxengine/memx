# F134 — Onboarding Site (`apps/onboarding/`)

> Seven-step wizard that takes a new tenant from "never heard of trail" to "KB online, first Neurons compiled, chat verified". Linked from the `trail.webhouse.dk` landing page. Phase 1 — ported from Claude Design handoff, functional standalone. Tier: alle. Effort: 1.5 days to wire real APIs. Status: Phase 1 complete.

## Problem

Nye brugere møder Trail uden guidet introduktion. Uden onboarding skal de selv finde ud af: hvad er en KB, hvordan uploader man kilder, hvad sker der under ingest, hvordan virker chat. Høj friction for nye brugere der ikke allerede kender konceptet.

## Secondary Pain Points

- Ingen struktureret måde at præsentere Trail's value proposition (Vannevar Bush / memex framing)
- Template-valg (Blank, Personal Memex, Clinic, Engineering, Research, Legal) er ikke tilgængeligt uden onboarding
- Team-invite flow er ikke integreret i nogen eksisterende flow

## Solution

A seven-step wizard (DA + EN) linked from the `trail.webhouse.dk` landing page:

| # | Screen | Purpose |
|---|--------|---------|
| 01 | Concept | Vannevar Bush / memex framing; three bullets on what makes trail different from RAG |
| 02 | KB | Name + slug + description for the first Knowledge Base |
| 03 | Template | Pick a schema template (Blank, Personal Memex, Clinic, Engineering, Research, Legal) or opt into custom |
| 04 | Sources | Drop PDFs/MD/web-clips; enable connectors (MCP, Web clipper, GitHub, Notion) |
| 05 | Team | Invite collaborators with RBAC (Admin / Curator / Reader) |
| 06 | Ingest | Animated replay of first compilation (read → extract → compile → link) |
| 07 | Query | Scripted chat demo with `[[wiki-link]]` citations |
| — | Done | Checklist + "Open admin dashboard" CTA |

## Non-Goals

- Erstatte admin UI — onboarding er en engangs-guide, ikke en permanent interface
- Real-time compile streaming i Phase 1 — hardcoded animation, reel SSE i Phase 2
- Multi-tenant support i Phase 1 — single-user flow
- Custom template editor — kun pre-defined templates

## Technical Design

### Stack

| Layer | Choice |
|---|---|
| Runtime | Browser (static build) |
| Framework | Preact 10 + `@preact/preset-vite` |
| Language | TypeScript (strict, `verbatimModuleSyntax`) |
| Styles | Custom CSS with `--accent`/`--fg`/etc. tokens (shared with admin + landing) |
| Fonts | Fraunces (serif) + JetBrains Mono + Inter via Google Fonts |
| State | Local-only: `useState` + `localStorage` (`trail.onboarding.v1`, `trail.onboarding.theme`) |
| Dev port | 3040 (admin=3030, server=3031) |

### File Map

```
apps/onboarding/
├── package.json
├── tsconfig.json
├── vite.config.ts
├── index.html
├── public/trail-logo.svg
└── src/
    ├── main.tsx          # Preact mount
    ├── app.tsx           # Shell: topbar, progress rail, footer, router-by-step-index
    ├── copy.tsx          # Typed COPY constant (DA + EN, includes JSX fragments)
    ├── diagrams.tsx      # Bauhaus SVG schematics (one per step)
    ├── screens.tsx       # S1–S7 + Done
    └── styles.css        # Custom CSS tokens + component styles
```

### API Integration (TODO — Phase 2)

1. Step 02 → `POST /api/v1/kbs` with `{ name, slug, description }`
2. Step 03 → attach `template: TemplateKey` to the KB record
3. Step 04 → use the existing file-upload ingest pipeline (already F95-connector-stamped)
4. Step 05 → `POST /api/v1/kbs/:id/invites` with email + role
5. Step 06 → stream the real first-compile log via SSE instead of the hardcoded script
6. Step 07 → hit the real `/api/v1/chat` endpoint against the new KB

## Interface

### Dev Commands

```sh
pnpm --filter @trail/onboarding dev          # → http://localhost:3040
pnpm --filter @trail/onboarding typecheck
pnpm --filter @trail/onboarding build        # → dist/
```

### Deployment Options

- **Subpath under landing**: CMS build copies `apps/onboarding/dist/` under `/onboarding/` in the landing's static output — `trail.webhouse.dk/onboarding/`
- **Standalone subdomain**: `onboarding.trail.webhouse.dk` pointing at a dedicated Fly.io static service

Phase 1 recommendation: subpath. Smaller surface area, shared origin with `/admin`, no extra DNS.

## Rollout

**Phase 1 (done):** Standalone app with localStorage state, hardcoded flows, navigates to `/admin` on completion.

**Phase 2 (TODO):** Wire real API endpoints for KB creation, template selection, file upload, team invites, SSE compile streaming, and real chat.

## Success Criteria

- Ny bruger kan gennemføre alle 7 steps på <5 minutter
- Onboarding er tilgængelig på både dansk og engelsk
- "Open admin dashboard" CTA navigerer til korrekt KB efter oprettelse
- Build output deployes som statisk fil under landing site

## Impact Analysis

### Files created (new)
- `apps/onboarding/` (entire directory — already exists from Phase 1 port)

### Files modified
- `pnpm-workspace.yaml` (exclude onboarding from workspace — uses @webhouse/cms dependency from CMS monorepo)
- `apps/landing/cms.config.ts` (config path for landing CMS admin)
- `apps/landing/content/` (content directory for landing)

### Downstream dependents
Onboarding is a standalone static app — no downstream dependents. It links TO admin (`/admin`) and landing (`trail.webhouse.dk`), but nothing imports FROM it.

`apps/landing/cms.config.ts` — config file, no downstream dependents.

### Blast radius
- Very low — standalone static app, no shared state with admin or server
- Landing migration (rsync fra CMS repo) er en engangs-operation
- Edge case: onboarding state i localStorage kan blive stale ved schema changes

### Breaking changes
None — entirely new app, no existing interfaces modified.

### Test plan
- [ ] TypeScript compiles: `pnpm --filter @trail/onboarding typecheck`
- [ ] `pnpm --filter @trail/onboarding build` → dist/ output
- [ ] All 7 steps render correctly in both DA and EN
- [ ] localStorage persists state across page reload
- [ ] "Save & exit" navigates back without losing state
- [ ] "Open admin dashboard" CTA navigates to `/admin`
- [ ] Regression: landing site (apps/landing/) builds independently
- [ ] Regression: admin UI (apps/admin/) unaffected

## Implementation Steps
1. **Phase 1 (done):** Port Claude Design handoff → Preact + Vite + TS
2. **Phase 1 (done):** Replace CDN React with Preact, strip TWEAKS sidecar, replace window.confirm/alert with real navigation
3. **Phase 1 (done):** Keep Bauhaus/styles.css verbatim (700 lines of custom tokens)
4. **Phase 2:** Wire Step 02 → `POST /api/v1/kbs`
5. **Phase 2:** Wire Step 03 → template attachment
6. **Phase 2:** Wire Step 04 → file-upload ingest pipeline
7. **Phase 2:** Wire Step 05 → team invites
8. **Phase 2:** Wire Step 06 → SSE compile streaming
9. **Phase 2:** Wire Step 07 → real chat endpoint
10. Deploy under landing site as `/onboarding/` subpath

## Dependencies
- F95 (file-upload ingest pipeline — Step 04)
- F10 (KB creation API — Step 02)
- F40 (multi-tenancy / team invites — Step 05)
- F143 (persistent ingest queue — Step 06 SSE streaming)

## Open Questions
1. **Deployment target:** Subpath under landing (`trail.webhouse.dk/onboarding/`) eller standalone subdomain (`onboarding.trail.webhouse.dk`)? Phase 1 recommendation: subpath.
2. **Template persistence:** Should templates be stored in DB or as static JSON? Phase 1: static. Phase 2: DB-backed for curator customization.
3. **Landing CMS admin repointing:** `@webhouse/cms` admin (localhost:3010, org BROBERG-AI) skal repointes til trail repo's landing content.

## Related Features
- **F95** (Connectors / file upload) — Step 04 uses existing ingest pipeline
- **F143** (Persistent ingest queue) — Step 06 SSE streaming benefits from persistent queue state
- **F130** (llms.txt) — Trail's own KB llms.txt can be used as a demo in Step 07
- **F138** (Work layer) — templates could include work-layer setup (tasks, milestones)

## Effort Estimate
**Medium** — 1.5 days for Phase 2 API wiring
- 0.25 day: Step 02 → KB creation API
- 0.25 day: Step 03 → template attachment
- 0.25 day: Step 04 → file-upload integration
- 0.25 day: Step 05 → team invites
- 0.25 day: Step 06 → SSE compile streaming
- 0.25 day: Step 07 → real chat + testing

Phase 1 (already done): ~2 days for the Preact port from Claude Design handoff.
