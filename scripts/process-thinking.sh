#!/usr/bin/env bash
set -euo pipefail

# F94 — Thinking-cue assets. Short one-shot percussive sounds layered on top
# of the ambient loop while the engine is doing work (ingest, candidate
# resolve, link, etc.). Unlike the ambient loops, these are NOT loudnorm'd
# — they're meant to be heard, not blend in. Pure format conversion.

SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)/docs/assets/sound/thinking"
OUT_DIR="$(cd "$(dirname "$0")/.." && pwd)/apps/admin/public/thinking"

mkdir -p "$OUT_DIR"

for src in "$SRC_DIR"/thinking_*.mp3; do
  [[ -f "$src" ]] || continue
  name=$(basename "$src" .mp3)
  dst="$OUT_DIR/${name}.opus"
  echo ">>> $name.mp3 → $name.opus"
  ffmpeg -hide_banner -loglevel error -y \
    -i "$src" \
    -c:a libopus -b:a 96k -vbr on -compression_level 10 -application audio \
    "$dst"
  ls -lh "$dst" | awk '{print "    " $5 "  " $NF}'
done

echo "Done."
