#!/usr/bin/env bash
set -euo pipefail

# F94 — Ambient Audio System
# Convert source MP3s in docs/assets/sound/ → Opus 96 kbps loops in
# apps/admin/public/ambient/. Two-pass loudnorm targets -18 LUFS so all loops
# sit at the same perceived volume regardless of source mastering.
#
# Filename remap: home.mp3 → landing.opus  (per Christian: home == landing == root)
# All others keep their stem. `idle.opus` is the fallback when the active
# pathname matches none of the named routes.

SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)/docs/assets/sound"
OUT_DIR="$(cd "$(dirname "$0")/.." && pwd)/apps/admin/public/ambient"

mkdir -p "$OUT_DIR"

declare -a MAP=(
  "home:landing"
  "landing:landing"
  "idle:idle"
  "neurons:neurons"
  "queue:queue"
  "chat:chat"
  "search:search"
  "sources:sources"
)

# Per-output trim (seconds). Some sources are mastered as long-form pieces
# (chat.mp3 is 18 min) — trim to a usable loop length without touching the
# original asset.
declare -A TRIM_SEC=(
  ["chat"]="120"
)

# Per-output leading-skip (seconds). Some sources open with true silence +
# a slow fade-in that feels like dead air when the loop starts. A hard
# `-ss` skip cuts to the audible body of the clip. Applied via input-side
# seek so loudnorm sees the final audio.
declare -A SKIP_SEC=(
  ["idle"]="2"
)

# Per-output fade-out (seconds, applied at the tail of the trimmed window).
# Smooths the loop seam audibly when the source wasn't mastered for looping.
declare -A FADE_OUT_SEC=(
  ["chat"]="5"
)

for entry in "${MAP[@]}"; do
  src_stem="${entry%%:*}"
  dst_stem="${entry##*:}"
  src="$SRC_DIR/${src_stem}.mp3"
  dst="$OUT_DIR/${dst_stem}.opus"
  [[ -f "$src" ]] || continue

  trim="${TRIM_SEC[$dst_stem]:-}"
  skip="${SKIP_SEC[$dst_stem]:-}"
  fade="${FADE_OUT_SEC[$dst_stem]:-}"

  filters="loudnorm=I=-18:TP=-2:LRA=7"
  input_args=()
  trim_args=()
  if [[ -n "$skip" ]]; then
    input_args=(-ss "$skip")
  fi
  if [[ -n "$trim" ]]; then
    trim_args=(-t "$trim")
    if [[ -n "$fade" ]]; then
      fade_start=$(( trim - fade ))
      filters="afade=t=out:st=${fade_start}:d=${fade},${filters}"
    fi
  fi

  echo ">>> $src_stem.mp3 → $dst_stem.opus${skip:+  (skip ${skip}s)}${trim:+  (trim ${trim}s${fade:+, fade ${fade}s})}"
  ffmpeg -hide_banner -loglevel error -y \
    "${input_args[@]}" -i "$src" "${trim_args[@]}" \
    -af "$filters" \
    -c:a libopus -b:a 96k -vbr on -compression_level 10 -application audio \
    "$dst"
  ls -lh "$dst" | awk '{print "    " $5 "  " $NF}'
done

echo "Done."
