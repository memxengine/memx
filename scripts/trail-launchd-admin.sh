#!/usr/bin/env bash
#
# trail-launchd-admin.sh — foreground launcher for the admin Vite
# dev-server, invoked by ~/Library/LaunchAgents/dk.broberg.trail.admin.plist.
#
# Independent from the engine plist — Vite restart shouldn't ripple to
# the engine and vice versa. Each service has its own KeepAlive
# supervisor.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO"

# Vite reads VITE_* + the .env automatically once cwd is correct, but
# admin doesn't need .env at all (no secrets). Setting API_URL so
# admin's fetch baseUrl points at the engine port.
export API_URL="http://127.0.0.1:${TRAIL_PORT:-58021}"

BUN="${BUN:-/Users/$(whoami)/.bun/bin/bun}"
if [[ ! -x "$BUN" ]]; then
  if command -v bun >/dev/null 2>&1; then
    BUN="$(command -v bun)"
  else
    echo "trail-admin: bun not found" >&2
    exit 127
  fi
fi

ADMIN_PORT="${TRAIL_ADMIN_PORT:-58031}"
exec "$BUN" run --cwd apps/admin vite --port "$ADMIN_PORT" --host 127.0.0.1 --strictPort
