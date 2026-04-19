# F33 — Fly.io `arn` Deploy for `apps/server`

> Move the engine from "runs on Christian's Mac" to "runs on Fly.io Stockholm". Single-tenant Phase 1 deploy with volume-backed SQLite.

## Problem

Phase 1 is feature-complete locally but has no production deploy story. Sanne onboarding (F37) blocks on this. Every infrastructure decision we've deferred (secrets, volumes, domains, monitoring) needs to land at once.

## Solution

Ship `infra/fly/` with a reference `fly.toml` + secrets recipe + volume setup for Fly.io Stockholm (`arn`). Region choice is explicit per global policy — trail NEVER deploys to US or Amsterdam.

## Technical Design

### Fly app shape

Shipped artifacts live at `infra/fly/` — `fly.toml`, `Dockerfile`,
`deploy.sh`, and a walkthrough README. Key choices:

- **Runtime: Bun on Fly too.** The server runs `bun run src/index.ts` in
  dev (see `apps/server/package.json`); we keep that in production via
  `oven/bun:1.2-alpine` so there's zero transpile drift between envs.
  Node 22 was the original plan — we deviate because Bun is already the
  stack's canonical runtime and an extra build step buys us nothing.
- **Domain: `api.trailmem.com`.** Phase 1 engine endpoint on the CF-
  registered `trailmem.com` zone. Phase 2 SaaS moves to
  `app.trailmem.com` (F40.2/F41) sharing this codebase.
- **Volume: 10 GB `trail_data` mount at `/data`.** DB + uploads.

### Dockerfile

`oven/bun:1.2-alpine` base. Copy monorepo manifests first for layer
caching, `pnpm install --frozen-lockfile --filter @trail/server...` to
pull only the server subgraph's deps, then copy source and run as the
unprivileged `bun` user. Entry: `bun run apps/server/src/index.ts`.

### Secrets

Set via `fly secrets set -a trail-engine`:

- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` — F35
- `ANTHROPIC_API_KEY` — for vision (F08) and optional chat backend (F14)
- `SESSION_SECRET` — cookie signing, `openssl rand -hex 32`

### Volume

```
fly volumes create trail_data --region arn --size 10 -a trail-engine
```

Holds SQLite DB + uploaded source files. Backup policy: `fly volumes snapshots create`. Phase 2 (F42 R2 storage) moves uploads off the volume; DB stays.

### Domain + TLS

```
fly certs create api.trailmem.com -a trail-engine
```

DNS at Cloudflare (zone `trailmem.com` already registered there):
`CNAME api.trailmem.com → trail-engine.fly.dev` with the CF proxy
OFF so Fly terminates TLS directly. Landing (F34) stays on `trailmem.com` /
`www.trailmem.com`; engine on `api.trailmem.com`.

### Healthcheck

`GET /api/health` (mounted at `/api`, not `/api/v1`, so Fly checks land
on a zero-auth path). Returns `{ status, service, db, version }` with
a 503 when the DB ping fails — a broken volume mount surfaces as
unhealthy instead of a green check on a dead engine. Fly config:
`interval=15s timeout=5s grace_period=30s`.

## Impact Analysis

### Files affected

- **Create:** `infra/fly/{fly.toml, Dockerfile, deploy.sh, README.md}` ✅ landed
- **Modify:** `apps/server/src/routes/health.ts` (was a 1-liner stub; now DB-pings + returns version) ✅ landed
- **Unchanged:** `apps/server/src/app.ts` already mounts `healthRoutes` at `/api` — no edit needed.

### Downstream dependents

- None internal — infra is additive.
- External: `APP_URL` and `API_URL` env change the OAuth callback registration — coordinate with F35.

### Blast radius

Deploy can't break local dev. The main risk is volume-backed SQLite — must verify that `better-sqlite3` bindings run under the Node 22 Docker image (not an issue with Bun in dev).

### Breaking changes

None to code. Operational: MCP stdio entrypoint (`TRAIL_MCP_ENTRY`)
currently resolves relative to the local monorepo layout — on Fly.io it
resolves to `/app/apps/mcp/src/index.ts` (Bun runs TS directly, no
`dist/` build). Set via `fly secrets` when ingest needs it.

### Test plan

- [ ] `fly deploy` builds the Docker image and rolls out
- [ ] `curl https://api.trail.broberg.ai/api/v1/health` returns 200
- [ ] Volume persists SQLite across machine restarts (deploy twice, verify DB contents)
- [ ] Google OAuth login roundtrip works with production client
- [ ] Upload a markdown source via the admin → ingest completes → wiki pages appear
- [ ] Backup: snapshot the volume and restore into a scratch app, verify data integrity

## Implementation Steps

Artifacts landed (code-side):

1. ✅ `infra/fly/Dockerfile` — Bun 1.2-alpine + pnpm, layer-cached install.
2. ✅ `infra/fly/fly.toml` — env, volume mount, `[[http_service.checks]]`.
3. ✅ `apps/server/src/routes/health.ts` — DB ping + version.
4. ✅ `infra/fly/deploy.sh` — `--first-time` bootstrap + idempotent re-run.
5. ✅ `infra/fly/README.md` — full walkthrough.

Operational steps (require `flyctl` auth + human approval on secrets):

6. ⏭ `infra/fly/deploy.sh --first-time` → creates app + volume + lists missing secrets.
7. ⏭ `fly secrets set GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET ANTHROPIC_API_KEY SESSION_SECRET`.
8. ⏭ `infra/fly/deploy.sh` (second run) → builds + rolls out.
9. ⏭ `fly certs create api.trailmem.com --app trail-engine` + CF DNS record.
10. ⏭ Smoke test the Test Plan below against `https://api.trailmem.com`.

## Dependencies

- F35 OAuth production credentials (for post-deploy login test)

Unlocks: F34 (landing shares the same DNS zone), F36 (dogfooding needs a live endpoint), F37 (Sanne onboarding lands here).

## Effort Estimate

**Small** — 2-3 days including first deploy + smoke tests + documentation.
