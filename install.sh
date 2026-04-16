#!/usr/bin/env bash
#
# install.sh — install the `trail` CLI as a symlink in ~/.local/bin.
#
# Idempotent: run it again after pulling changes and it just re-points
# the symlink. The actual script lives in scripts/trail and is source-
# controlled; the symlink exists so you can type `trail start` from any
# directory without paths in your shell config.
#
# Usage:
#   ./install.sh          # install to ~/.local/bin (no sudo)
#   ./install.sh --system # install to /usr/local/bin (needs sudo)

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$REPO/scripts/trail"

if [[ ! -x "$SRC" ]]; then
  echo "install.sh: $SRC is not executable — run 'chmod +x scripts/trail'" >&2
  exit 1
fi

# Target directory. Default ~/.local/bin to match buddy's install path and
# avoid needing sudo. --system installs to /usr/local/bin for all users.
BIN_DIR="$HOME/.local/bin"
if [[ "${1:-}" == "--system" ]]; then
  BIN_DIR="/usr/local/bin"
fi

mkdir -p "$BIN_DIR"
TARGET="$BIN_DIR/trail"

# Refuse to overwrite an existing non-symlink (a real binary somebody put
# there — preserve it, make the user decide).
if [[ -e "$TARGET" && ! -L "$TARGET" ]]; then
  echo "install.sh: $TARGET exists and is not a symlink — refusing to overwrite" >&2
  exit 1
fi

# Remove stale symlink (possibly pointing at an old repo location) and
# re-create.
rm -f "$TARGET"
ln -s "$SRC" "$TARGET"

echo "installed: $TARGET → $SRC"

# Warn if BIN_DIR isn't on PATH so the user isn't confused about why
# `trail start` doesn't find anything.
if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  cat <<EOF

warning: $BIN_DIR is not on your PATH.

Add this to ~/.zshrc or ~/.bashrc:
  export PATH="$BIN_DIR:\$PATH"

Then restart the shell, or run:
  source ~/.zshrc
EOF
fi

echo
echo "Try: trail start"
