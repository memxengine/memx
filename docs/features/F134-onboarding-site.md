# F134 — Onboarding site (`apps/onboarding/`)

**Status**: Phase 1 — ported from Claude Design handoff, functional standalone.
Next: wire the final `SDone → /admin` step to the real KB-creation API.

## What it is

A seven-step wizard that takes a new tenant from "never heard of trail" to
"KB online, first Neurons compiled, chat verified". Linked from the
`trail.webhouse.dk` landing page (managed by `@webhouse/cms` — see note
below).

Steps (DA + EN):

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

## Origin

Ported from a Claude Design (`claude.ai/design`) handoff bundle. The
prototype was HTML + `<script type="text/babel">` JSX with CDN React +
Babel-standalone. This port:

- Replaced React + Babel CDN with Preact + Vite + TS (same stack as
  `apps/admin`).
- Replaced the handoff's `window.COPY`, `window.S1Concept` etc. globals
  with ES-module named exports.
- Stripped the `TWEAKS` design-tweak sidecar (dev-only — belongs in the
  design tool, not production).
- Replaced the `window.confirm`/`window.alert` demo hooks with real link
  navigation (state persists to `localStorage` on every change so "Save
  & exit" just navigates back).
- Kept the Bauhaus/editorial `styles.css` verbatim (700 lines of custom
  tokens that match the landing page + admin palette) — no Tailwind
  needed.

Handoff artifacts are preserved for reference at
`/Users/cb/Downloads/trail-handoff (1).zip`.

## Stack

| Layer | Choice |
|---|---|
| Runtime | Browser (static build) |
| Framework | Preact 10 + `@preact/preset-vite` |
| Language | TypeScript (strict, `verbatimModuleSyntax`) |
| Styles | Custom CSS with `--accent`/`--fg`/etc. tokens (shared with admin + landing) |
| Fonts | Fraunces (serif) + JetBrains Mono + Inter via Google Fonts |
| State | Local-only: `useState` + `localStorage` (`trail.onboarding.v1`, `trail.onboarding.theme`) |
| Dev port | 3040 (admin=3030, server=3031) |

## File map

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

## Dev

```sh
pnpm --filter @trail/onboarding dev          # → http://localhost:3040
pnpm --filter @trail/onboarding typecheck
pnpm --filter @trail/onboarding build        # → dist/
```

## Deployment

Built output in `dist/` is static. Options:

- **Subpath under landing**: CMS build copies `apps/onboarding/dist/` under
  `/onboarding/` in the landing's static output — `trail.webhouse.dk/onboarding/`.
  Link from landing CTA.
- **Standalone subdomain**: `onboarding.trail.webhouse.dk` pointing at a
  dedicated Fly.io static service.

Phase 1 recommendation: subpath. Smaller surface area, shared origin with
`/admin`, no extra DNS.

## API integration (TODO)

The wizard is currently self-contained — finishing it just sets
`window.location.href = '/admin'`. Wiring for later:

1. Step 02 → `POST /api/v1/kbs` with `{ name, slug, description }`.
2. Step 03 → attach `template: TemplateKey` to the KB record.
3. Step 04 → use the existing file-upload ingest pipeline (already
   F95-connector-stamped).
4. Step 05 → `POST /api/v1/kbs/:id/invites` with email + role.
5. Step 06 → stream the real first-compile log via SSE instead of the
   hardcoded script.
6. Step 07 → hit the real `/api/v1/chat` endpoint against the new KB.

## Landing migration (related)

The trail-branded landing site (previously living at
`/Users/cb/Apps/webhouse/cms/examples/static/trail/`) was rsync'd into
`apps/landing/` in this repo so landing + onboarding + admin + engine all
live in one place. The landing is NOT a workspace package — it's
excluded in `pnpm-workspace.yaml` because its `@webhouse/cms` dependency
points at the CMS monorepo, not this one. The @webhouse/cms admin
(localhost:3010, org BROBERG-AI) should be repointed:

- **Config path**: `/Users/cb/Apps/broberg/trail/apps/landing/cms.config.ts`
- **Content directory**: `/Users/cb/Apps/broberg/trail/apps/landing/content`

The CMS admin owns building + deploying the landing; trail repo just
hosts the authoring surface.
