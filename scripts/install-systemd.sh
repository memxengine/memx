#!/usr/bin/env bash
#
# install-systemd.sh — Linux user-mode systemd install for trail
# engine + admin.
#
# After install:
#   - Both processes start automatically at user login (lingering
#     enabled so they survive logout — see `loginctl enable-linger`)
#   - Both restart within ~10 seconds of crash
#   - Logs land at ~/.trail/{engine,admin}.log AND journald
#
# Idempotent: safe to re-run; daemon-reload + restart picks up
# changes to the unit files.
#
# Companion: scripts/uninstall-systemd.sh
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
UNIT_DIR="$HOME/.config/systemd/user"
TEMPLATES="$REPO/infra/systemd"

if ! command -v systemctl >/dev/null 2>&1; then
  echo "trail: systemctl not found — this script is for Linux." >&2
  echo "  On macOS use scripts/install-launchd.sh instead." >&2
  exit 1
fi

mkdir -p "$UNIT_DIR" "$HOME/.trail"

# If the standalone `trail` launcher has live processes, kill them
# first — otherwise the systemd-spawned engine fails to bind on port 58021.
if [[ -x "$REPO/scripts/trail" ]]; then
  echo "→ stopping any standalone trail processes…"
  "$REPO/scripts/trail" stop || true
fi

for svc in engine admin; do
  template="$TEMPLATES/trail-${svc}.service"
  target="$UNIT_DIR/trail-${svc}.service"

  echo "→ installing $svc unit → $target"
  sed "s|__REPO__|$REPO|g; s|__HOME__|$HOME|g" "$template" > "$target"
  chmod 644 "$target"
done

systemctl --user daemon-reload

for svc in engine admin; do
  systemctl --user enable "trail-${svc}.service"
  systemctl --user restart "trail-${svc}.service"
done

# Linger ensures the units stay running after the user logs out.
# Requires sudo on most distros.
if ! loginctl show-user "$(whoami)" 2>/dev/null | grep -q '^Linger=yes'; then
  echo
  echo "→ enabling user lingering (so trail survives logout)…"
  echo "  This requires sudo. Run manually if you'd rather:"
  echo "    sudo loginctl enable-linger $(whoami)"
  sudo loginctl enable-linger "$(whoami)" || \
    echo "  ⚠  could not enable lingering — trail will stop at logout"
fi

echo
echo "✓ trail engine + admin now managed by systemd (user-mode)"
echo
echo "  Status:    systemctl --user status trail-engine trail-admin"
echo "  Logs:      tail -f ~/.trail/engine.log ~/.trail/admin.log"
echo "             journalctl --user -u trail-engine -f"
echo "  Restart:   systemctl --user restart trail-engine"
echo "             systemctl --user restart trail-admin"
echo "  Remove:    bash scripts/uninstall-systemd.sh"
echo
echo "  Engine:    http://127.0.0.1:58021"
echo "  Admin:     http://127.0.0.1:58031"
