#!/usr/bin/env bash
#
# install-launchd.sh — install macOS launchd auto-restart for trail
# engine + admin.
#
# After install:
#   - Both processes start automatically at login
#   - Both restart within ~5-10 seconds of crash
#   - Survive sleep/wake/logout
#   - Logs land at ~/.trail/{engine,admin}.log (same as before)
#
# Idempotent: safe to re-run; unloads + reloads existing services.
#
# Companion: scripts/uninstall-launchd.sh
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
LA_DIR="$HOME/Library/LaunchAgents"
TEMPLATES="$REPO/infra/launchd"

mkdir -p "$LA_DIR" "$HOME/.trail"

# If the standalone `trail` launcher has live processes, kill them
# first — otherwise the launchd-spawned engine will fail to bind on
# port 58021. trail stop is idempotent so this is safe even when
# nothing's running.
if [[ -x "$REPO/scripts/trail" ]]; then
  echo "→ stopping any standalone trail processes…"
  "$REPO/scripts/trail" stop || true
fi

for svc in engine admin; do
  template="$TEMPLATES/dk.broberg.trail.${svc}.plist"
  target="$LA_DIR/dk.broberg.trail.${svc}.plist"

  echo "→ installing $svc plist → $target"
  sed "s|__REPO__|$REPO|g; s|__HOME__|$HOME|g" "$template" > "$target"
  chmod 644 "$target"

  # Unload first if already loaded — launchctl errors on double-load.
  launchctl unload "$target" 2>/dev/null || true
  launchctl load "$target"
done

echo
echo "✓ trail engine + admin now managed by launchd"
echo
echo "  Status:    launchctl list | grep dk.broberg.trail"
echo "  Logs:      tail -f ~/.trail/engine.log ~/.trail/admin.log"
echo "  Restart:   launchctl kickstart -k gui/$(id -u)/dk.broberg.trail.engine"
echo "             launchctl kickstart -k gui/$(id -u)/dk.broberg.trail.admin"
echo "  Remove:    bash scripts/uninstall-launchd.sh"
echo
echo "  Engine:    http://127.0.0.1:58021"
echo "  Admin:     http://127.0.0.1:58031"
