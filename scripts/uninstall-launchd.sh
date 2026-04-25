#!/usr/bin/env bash
#
# uninstall-launchd.sh — remove macOS launchd auto-restart for trail.
# After running, you're back to manual `trail start/stop/restart` flow.
set -euo pipefail

LA_DIR="$HOME/Library/LaunchAgents"

for svc in engine admin; do
  target="$LA_DIR/dk.broberg.trail.${svc}.plist"
  if [[ -f "$target" ]]; then
    echo "→ unloading + removing $svc plist"
    launchctl unload "$target" 2>/dev/null || true
    rm "$target"
  else
    echo "  $svc plist already absent — skipping"
  fi
done

echo
echo "✓ trail launchd services removed"
echo "  Run: trail start  (or scripts/trail start) to start manually"
