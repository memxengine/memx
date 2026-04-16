# F62 — `demo.trailmem.com` — Polished Public Reference Site

> Public, zero-login showcase of what a Trail brain looks like. Seeded with real content (Bush essays, trail-vs-RAG comparisons, sample clinical material). Reader browses Neurons and chats with them; a "recently approved" feed from the curator queue shows the compile-time loop working in real time. Lives alongside the landing (F34) and the docs-brain (F36) as the third public-facing trailmem.com surface.

## Problem

Trail is architecturally different from every RAG chatbot anyone has seen. Explaining "compile-at-ingest vs. retrieve-at-query" in writing works for people who already read technical content. For everyone else — prospective customers, partners, investors, curious developers — there's no "click here to see what this is."

The landing (F34) explains. The docs-brain (F36) shows the technical reality but only for Trail's own documentation, which is meta and not broadly relatable. We need a **third surface**: a demo brain with universally interesting content (Vannevar Bush, memory/knowledge topics, curated comparisons) that a visitor can genuinely read, search, and converse with. And while they're there, show the curation queue moving — "a human just approved this claim 12 seconds ago" — so the architectural pitch becomes experiential.

User said it explicitly: *"vi kan lade os inspirere af LLM wiki sitet vi sprang ud fra men jeg vil have noget der er mere lækkert."* Karpathy's LLM Wiki seeded the pattern; this is our opinionated, polished version.

## Solution

Deploy a read-only Preact/Lit consumer at `demo.trailmem.com` backed by a dedicated `trail-demo` tenant on the SaaS infrastructure (eventually on `app.trailmem.com`, initially on the single-tenant Fly deploy). The frontend reuses components from F18 (Admin UI) wherever possible — the wiki tree renderer, the Neuron reader, the chat widget (F29). What's unique: a polished public-consumer theme, seeded sample content, and a "live queue" sidebar showing recently auto-approved candidates with timestamps.

No login. No write access from the public. Chat is scoped to the demo KBs. The curator queue is read-only display only (Christian curates the demo content from Admin UI).

## Technical Design

### Where it lives in the repo

```
apps/
  demo-site/                      ← new, separate from apps/admin
    src/
      main.tsx
      app.tsx                     ← shared shell layout
      panels/
        home.tsx                  ← hero + featured Neurons + live queue
        neuron.tsx                ← single Neuron reader
        trail.tsx                 ← category/Trail browser
        chat.tsx                  ← standalone chat with citations
      components/
        queue-feed.tsx            ← live "recently approved" list
        neuron-card.tsx           ← reused from admin, restyled
        provenance-trail.tsx      ← source → Neuron trail visualization
    vite.config.ts
    package.json (@trail/demo-site)
```

Shares the `@trail/shared` types and the API client pattern from `apps/admin`. Uses `@webhouse/cms` shortcode expander from F45/the static-boilerplate work for inline SVG figures.

### Backend surface (no new endpoints required)

Everything comes from existing engine endpoints, just filtered to the demo tenant:

- `GET /api/v1/knowledge-bases` — list demo Trails
- `GET /api/v1/documents/:slug` — read a Neuron
- `POST /api/v1/chat` — public chat (scoped to demo tenant, rate-limited, no auth)
- `GET /api/v1/queue?status=approved&limit=20` — the "recently approved" feed

The engine gains one small addition: a **public-access token** mode for the demo tenant. Every call carries `X-Demo-Token: <hardcoded>` and the server allows read + chat operations on this one tenant without a session cookie. No writes allowed under the demo token.

### Seeded content

One-time content bootstrap (before first deploy) by running ingest against a curated source set:

| Trail (KB) | Sources | Purpose |
|---|---|---|
| **Bush & Memex** | "As We May Think" (1945), Engelbart's "Augmenting Human Intellect" (1962), Nelson's "Literary Machines" excerpt | The historical backbone. Beautiful Neurons, rich cross-refs. |
| **Compile vs. Retrieve** | The three brain-vs-RAG essays already in our posts, plus the NotebookLM comparison | Self-explanatory demo of Trail's thesis. |
| **Memory & Neuroscience** | Hebb 1949 excerpts, memory reconsolidation summaries, synaptic plasticity overviews | Meaty content that also supports the brain-analogy. |
| **Zoneterapi & NADA** (optional) | Sanne's material, published only with consent | Shows a completely different domain. Confidence gate — only include if Sanne explicitly approves. |

~4 Trails, ~50-80 Neurons total, curated by Christian pre-launch. Re-ingest on any source update.

### Live queue feed

Small component (`queue-feed.tsx`) polls `/api/v1/queue?status=approved&limit=20&sort=reviewedAt_desc` every 15 seconds. Shows:

```
Recently approved · 12s ago
"Vannevar Bush's memex proposed associative trails…"
Tagged: memex, bush · Trail: Bush & Memex
```

Each entry fades in from the top, pushing older entries down. When the queue is idle (no recent changes), it says "The curator is resting — meanwhile, 47 Neurons are live." This is the *experiential* part of the pitch: visitors see Trail being maintained live.

When Christian approves a candidate from Admin UI (F18), the feed picks it up within 15s. Visible causation.

### Theme direction

"More polished than LLM Wiki" means:

- Typography: Inter for UI, a serif (Fraunces or Source Serif 4) for Neuron body — matches scholarly content
- Layout: two-column on wide screens (Neuron body + margin with cross-refs + queue feed); stacks on mobile
- Color: same amber accent as landing, warm off-white background, generous whitespace
- Micro-interactions: fade-in for queue updates, soft pulse on live-chat typing indicator, smooth scroll to anchors
- Inline figures: via F45's `{{svg:slug}}` shortcode pattern so timelines/Memex-schematic render crisp
- Provenance trails: clickable "source → claim → page" breadcrumbs under each assertion

Inspired by: Karpathy's LLM Wiki, Stripe Press, Distill.pub, Fly.io's blog.

### Deploy

Static-ish Preact app built to `dist/`, served by Fly.io arn (or Cloudflare Pages) with a CNAME for `demo.trailmem.com`. At request time, the client calls `api.trail.broberg.ai` (later `api.trailmem.com`) for data. Build pipeline in GitHub Action, redeploys on push to `apps/demo-site/**`.

DNS: `demo.trailmem.com` CNAME → `trail-demo.fly.dev` (or Pages equivalent), configured via the DNS MCP.

## Impact Analysis

### Files affected

- **Create:** `apps/demo-site/**` — new Preact app
- **Create:** `infra/fly/demo.toml` (or Cloudflare Pages config)
- **Create:** `.github/workflows/deploy-demo-site.yml`
- **Modify:** `apps/server/src/middleware/auth.ts` — accept `X-Demo-Token` for read + chat on `trail-demo` tenant only
- **Modify:** `apps/server/src/routes/chat.ts` — enforce rate limit on demo-token requests
- **Modify:** DNS: `demo.trailmem.com` CNAME

### Downstream dependents

None. This is a leaf consumer.

### Blast radius

Low. The demo tenant is isolated; a demo-site bug or traffic spike can't bleed into Sanne's production tenant. The `X-Demo-Token` auth bypass is the single new attack surface — audit carefully (read + chat scope only, rate-limited, specific tenant).

### Breaking changes

None.

### Test plan

- [ ] Build produces a static bundle under `apps/demo-site/dist/`
- [ ] `curl https://demo.trailmem.com/` returns 200, renders hero + featured Neurons
- [ ] Chat endpoint answers a question scoped to demo Trails (not the user's real tenants)
- [ ] Rate limit kicks in after N requests/minute per IP
- [ ] Queue feed updates within 15s of Christian approving a candidate in Admin UI
- [ ] Mobile layout degrades gracefully (two-column → stacked)
- [ ] SVG figures render correctly via `{{svg:slug}}` expansion
- [ ] Regression: Sanne's tenant queries unaffected by demo-token middleware

## Implementation Steps

1. Scaffold `apps/demo-site` with Vite + Preact + Tailwind v4 (mirror `apps/admin` setup).
2. Extract shared components from `apps/admin` into `packages/ui-components` (or keep them in admin and import via workspace until the shape stabilises).
3. Add `X-Demo-Token` handling to auth middleware — strict scope: read + chat only, `trail-demo` tenant only.
4. Build home / neuron-reader / chat panels. Provenance trails component.
5. Queue-feed polling component + live animation.
6. Theme pass — fonts, colors, layout polish.
7. Content seed — curate ~4 Trails, ingest through the standard pipeline, approve manually in Admin.
8. Fly.io deploy config + GitHub Action.
9. DNS via MCP.
10. Soft launch on social — this is the demo link we hand out.

## Dependencies

- F17 Queue API (Done) — queue-feed reads from here
- F18 Curator UI (Session 1 Done) — components we reuse
- F29 `<trail-chat>` widget — reused for the chat panel
- F34 Landing Deploy — shares the deploy pattern
- F40.1 libSQL driver swap — demo tenant runs on same engine; any DB driver change affects demo
- F33 Fly.io server deploy (engine needs to be reachable)

**Soft dependency on F36** (docs.trailmem.com): both are public read-surfaces; consistent design language saves work.

**Phase considerations:**
- Pre-F40 (no multi-tenancy yet): runs on single-tenant Fly deploy with a "trail-demo" namespace/KB convention
- Post-F40: migrates to a real `trail-demo` tenant on `app.trailmem.com`

## Placement on the critical path

Inserted between F18 (Admin UI) and F37 (Sanne live). Rationale:

1. Admin UI (F18) ships components the demo site reuses — don't build twice
2. Demo site is a forcing function for polish: if we can ship a public-facing site we're proud of, we've validated the component library for Sanne's experience too
3. Sanne benefits: we can point her at `demo.trailmem.com` during onboarding so she sees where her Trail is headed

Proposed updated critical path:

```
✅ F17   Queue API
✅ F18.1 Admin UI (queue panel)
⏭ F40.1 libSQL driver swap
⏭ F33   Fly.io server deploy
⏭ F35   OAuth production credentials
⏭ F18.2 Admin UI (sources + wiki tree panels)
⏭ F62   Demo site ← public showcase
⏭ F37   Sanne live
```

## Effort Estimate

**Medium** — 5-7 days including theme polish, content seeding, and the demo-token auth path. Shorter if we accept "good-enough" styling; longer if we chase pixel-perfect across devices.

## Open questions

1. **Authentication for curator demo view.** Should the public see a live curator queue (adds wow-factor) or just a "recently approved" feed (safer)? I'm recommending read-only feed; live curator view leaks timing info about Christian's work patterns.
2. **Sanne content inclusion.** Only if she explicitly approves. Alternative: use a different clinical domain (anonymised, public-licensed) so we can include the "different-domain" demonstration without Sanne's personal material.
3. **Rate limits.** IP-based or token-based? Probably IP for demo (no accounts), with generous limits (60/min/IP for chat, unlimited for reads). Tunable.
4. **Deploy target.** Fly.io (consolidates vendor) or Cloudflare Pages (free tier, CDN built-in). Recommend Fly.io for consistency; evaluate if the static hosting cost becomes non-trivial.
