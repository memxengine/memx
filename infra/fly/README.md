# Trail engine — Fly.io deploy

Phase 1 single-tenant deploy for `apps/server`. Region **arn (Stockholm)** per global policy — never deploy this stack to US or Amsterdam.

## First-time setup

```bash
# From repo root, with flyctl authed to the broberg-ai org.
infra/fly/deploy.sh --first-time
```

That creates the app, provisions the 10 GB volume, and lists any
required secrets that aren't yet set. You'll fill those in manually
(shell history never sees the values):

```bash
fly secrets set GOOGLE_CLIENT_ID=... --app trail-engine
fly secrets set GOOGLE_CLIENT_SECRET=... --app trail-engine
fly secrets set ANTHROPIC_API_KEY=... --app trail-engine
fly secrets set SESSION_SECRET=$(openssl rand -hex 32) --app trail-engine
```

Once all four are set, re-run `infra/fly/deploy.sh` without the flag to
do the actual deploy.

## Subsequent deploys

```bash
infra/fly/deploy.sh
```

Rolls out any code changes. Same Dockerfile layer caching as local
`docker build` — a pure source edit only invalidates the last layer.

## Domains + TLS

Point `api.trailmem.com` at the Fly app via Cloudflare (zone already
registered there). Two records:

1. `CNAME api.trailmem.com → trail-engine.fly.dev` (proxy OFF — Fly
   terminates TLS directly).
2. Validate + issue cert:

   ```bash
   fly certs create api.trailmem.com --app trail-engine
   fly certs check api.trailmem.com --app trail-engine
   ```

`api.trailmem.com` is the Phase 1 engine endpoint. Phase 2 SaaS lives
at `app.trailmem.com` (F40.2/F41) and shares this tenant-aware
codebase with per-tenant routing on top.

## Volume backups

SQLite DB + uploaded source files live on `/data`. Snapshot before any
schema change or long migration:

```bash
fly volumes list --app trail-engine
fly volumes snapshots create <volume-id> --app trail-engine
```

Fly retains daily auto-snapshots for 5 days by default. Phase 2 (F42
R2 storage) moves uploads off the volume; DB stays.

## Health + observability

`GET /api/health` returns `{ status, service, db, version }`. Fly's
built-in checks poll every 15s (see `fly.toml` [[http_service.checks]])
with a 30s grace on first boot so the libsql DB open + bootstrap can
finish before the first check. Failing checks → rolling restart.

## Scaling

Single shared-CPU machine is plenty for Phase 1 — SQLite write-lock
serializes anyway, and the heavy lifting (LLM calls) is IO-bound.
Scale up when F40.2 multi-tenant makes horizontal sharding meaningful:

```bash
fly scale count 2 --app trail-engine
fly scale vm shared-cpu-2x --app trail-engine
```

## Rollback

```bash
fly releases list --app trail-engine
fly releases rollback <n> --app trail-engine
```

Volume-backed state survives rollback. A rollback that needs to undo a
schema migration requires restoring the volume snapshot from before
the deploy that ran the migration.
