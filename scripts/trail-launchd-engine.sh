#!/usr/bin/env bash
#
# trail-launchd-engine.sh — foreground launcher for the trail engine,
# invoked by ~/Library/LaunchAgents/dk.broberg.trail.engine.plist.
#
# Differs from `scripts/trail` by:
#   1. Runs in FOREGROUND (no nohup, no fork) — launchd needs the
#      process to stay attached so KeepAlive can detect crashes.
#   2. Sources repo-root .env so OPENAI / OPENROUTER / R2 / etc keys
#      are visible to bun (Bun's auto-load uses cwd which is
#      apps/server, not repo root).
#   3. Resolves TRAIL_INGEST_TOKEN from ~/.trail/.env when present;
#      otherwise leaves it for the engine to mint on first request.
#
# launchd is configured with KeepAlive on crash + ThrottleInterval=10
# so a misconfigured env or migration error doesn't cascade into a
# crash-loop hammering the box.
#
# To switch back to the manual `trail start/stop/restart` flow:
#   bash scripts/uninstall-launchd.sh
set -euo pipefail

# Resolve repo root from this script's location.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO"

# Provider keys + secret-master from .env.
if [[ -f .env ]]; then
  set -a
  # shellcheck source=/dev/null
  source .env
  set +a
fi

# Persistent ingest token. Same precedence as scripts/trail's resolve_token.
STATE_DIR="$HOME/.trail"
STATE_ENV="$STATE_DIR/.env"
mkdir -p "$STATE_DIR"
if [[ -z "${TRAIL_INGEST_TOKEN:-}" ]]; then
  if [[ -f "$STATE_ENV" ]] && grep -q '^TRAIL_INGEST_TOKEN=' "$STATE_ENV"; then
    TRAIL_INGEST_TOKEN="$(grep '^TRAIL_INGEST_TOKEN=' "$STATE_ENV" | head -n1 | cut -d= -f2-)"
    export TRAIL_INGEST_TOKEN
  fi
fi

export TRAIL_DEV_AUTH=1
export TRAIL_DATA_DIR="$REPO/data"
export TRAIL_INGEST_TENANT_SLUG="${TRAIL_INGEST_TENANT_SLUG:-christian}"
export TRAIL_PROJECT_ROOT="$REPO"
export PORT="${TRAIL_PORT:-58021}"
export APP_URL="http://127.0.0.1:${TRAIL_ADMIN_PORT:-58031}"

# Bun is a static binary in ~/.bun/bin or via Homebrew. launchd doesn't
# inherit interactive PATH, so resolve explicitly. Override via the
# BUN env-var if you keep bun elsewhere.
BUN="${BUN:-/Users/$(whoami)/.bun/bin/bun}"
if [[ ! -x "$BUN" ]]; then
  if command -v bun >/dev/null 2>&1; then
    BUN="$(command -v bun)"
  else
    echo "trail-engine: bun not found; install via 'curl -fsSL https://bun.sh/install | bash'" >&2
    exit 127
  fi
fi

exec "$BUN" run --cwd apps/server src/index.ts
