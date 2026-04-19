# Single-stage Bun image. Trail's server runs on Bun in dev (see
# apps/server/package.json `start` script) so we run on Bun in prod too —
# same runtime, zero transpile drift, fast cold-starts. Base pinned to a
# tagged minor so `latest` churn never surprises a deploy.
FROM oven/bun:1.2-alpine AS base

# pnpm is the workspace package manager; corepack ships with Bun-alpine so
# we enable the exact version pinned in root package.json.
RUN apk add --no-cache nodejs npm && \
    npm install -g pnpm@9.0.0

WORKDIR /app

# Copy the monorepo manifest layer first so Docker can cache the install
# step across deploys that only touch source files.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY turbo.json tsconfig.json ./
COPY apps/server/package.json ./apps/server/
COPY apps/mcp/package.json ./apps/mcp/
COPY packages/core/package.json ./packages/core/
COPY packages/db/package.json ./packages/db/
COPY packages/pipelines/package.json ./packages/pipelines/
COPY packages/shared/package.json ./packages/shared/
COPY packages/storage/package.json ./packages/storage/

# --frozen-lockfile fails fast if anyone forgets to commit a lockfile
# update. Workspace deps still resolve via `workspace:*`.
RUN pnpm install --frozen-lockfile --filter @trail/server... --filter @trail/mcp...

# Source tree last — this is the layer that invalidates on every deploy.
COPY apps/server ./apps/server
COPY apps/mcp ./apps/mcp
COPY packages ./packages

# Volumes mount at /data; create the dir with correct perms for the bun
# user so the first write doesn't race a permissions fix.
RUN mkdir -p /data /data/uploads && chown -R bun:bun /data /app

USER bun

ENV PORT=3031 \
    TRAIL_DATA_DIR=/data \
    TRAIL_DB_PATH=/data/trail.db \
    TRAIL_UPLOADS_DIR=/data/uploads \
    NODE_ENV=production

EXPOSE 3031

CMD ["bun", "run", "apps/server/src/index.ts"]
