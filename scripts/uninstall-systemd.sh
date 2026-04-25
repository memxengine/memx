#!/usr/bin/env bash
#
# uninstall-systemd.sh — remove Linux user-mode systemd auto-restart.
# After running, you're back to manual `trail start/stop/restart` flow.
set -euo pipefail

UNIT_DIR="$HOME/.config/systemd/user"

if ! command -v systemctl >/dev/null 2>&1; then
  echo "trail: systemctl not found — nothing to uninstall." >&2
  exit 0
fi

for svc in engine admin; do
  unit="trail-${svc}.service"
  target="$UNIT_DIR/$unit"
  if [[ -f "$target" ]]; then
    echo "→ stopping + disabling + removing $svc"
    systemctl --user stop "$unit" 2>/dev/null || true
    systemctl --user disable "$unit" 2>/dev/null || true
    rm "$target"
  else
    echo "  $svc unit already absent — skipping"
  fi
done

systemctl --user daemon-reload

echo
echo "✓ trail systemd units removed"
echo "  Run: trail start  (or scripts/trail start) to start manually"
