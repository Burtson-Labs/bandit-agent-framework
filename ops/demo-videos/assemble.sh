#!/usr/bin/env bash
# Assemble the final demo mp4 for a scene:
#   - narration audio placed at each step's recorded timestamp
#   - music bed (assets/music-bed.mp3) looped, held low, sidechain-ducked
#     under the voice; skipped cleanly if the file isn't there
#   - subtitles burned in from out/<scene>/subtitles.srt
# Output: ~/Desktop/bandit-demos/<scene>-<YYYY-MM-DD>.mp4 (DEMO_DEST_DIR overrides).
# Nothing is uploaded or published anywhere.
set -euo pipefail

SCENE="${1:?usage: assemble.sh <scene-name>}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$ROOT/out/$SCENE"
MUSIC="$ROOT/assets/music-bed.mp3"
DEST_DIR="${DEMO_DEST_DIR:-$HOME/Desktop/bandit-demos}"
DEST="$DEST_DIR/$SCENE-$(date +%Y-%m-%d).mp4"

for f in "$OUT/video.webm" "$OUT/steps.json" "$OUT/subtitles.srt" "$OUT/audio/durations.json"; do
  [[ -f "$f" ]] || { echo "missing $f — run \`pnpm narrate $SCENE\` then \`pnpm record $SCENE\` first" >&2; exit 1; }
done

# ffmpeg: needs the `subtitles` (libass) filter for the burn-in, and some
# system builds ship without it — probe candidates instead of trusting PATH.
# The ffmpeg-static devDependency is a full build, so it always qualifies.
FFMPEG=""
for cand in "$(command -v ffmpeg || true)" "$(cd "$ROOT" && node -p "require('ffmpeg-static')" 2>/dev/null || true)"; do
  [[ -n "$cand" && -x "$cand" ]] || continue
  # (no `grep -q` here: with pipefail, -q's early exit SIGPIPEs ffmpeg and fails the probe)
  if "$cand" -hide_banner -filters 2>/dev/null | grep ' subtitles ' >/dev/null; then
    FFMPEG="$cand"
    break
  fi
  echo "note: $cand has no subtitles filter — skipping"
done
[[ -n "$FFMPEG" ]] || {
  echo "no subtitles-capable ffmpeg found. \`pnpm install\` here (ffmpeg-static), or a libass-enabled \`brew install ffmpeg\`." >&2
  exit 1
}
FFPROBE="$(command -v ffprobe || true)"
[[ -n "$FFPROBE" ]] || FFPROBE="$(cd "$ROOT" && node -p "require('ffprobe-static').path" 2>/dev/null || true)"
[[ -n "$FFPROBE" ]] || { echo "ffprobe not found. \`brew install ffmpeg\` or \`pnpm install\` here (ffprobe-static)." >&2; exit 1; }

VIDEO_DUR="$("$FFPROBE" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$OUT/video.webm")"

if [[ ! -f "$MUSIC" ]]; then
  echo "note: no music bed at assets/music-bed.mp3 — voice-only mix (try \`pnpm fetch-music\`, see README)"
  MUSIC=""
fi

# Filtergraph + ordered audio inputs (narration first, music last).
AUDIO_INPUTS=()
while IFS= read -r line; do
  [[ -n "$line" ]] && AUDIO_INPUTS+=("$line")
done < <(node "$ROOT/src/buildFilter.mjs" "$OUT" "$MUSIC")

ARGS=(-y -v warning -stats -i "$OUT/video.webm")
LAST=$(( ${#AUDIO_INPUTS[@]} - 1 ))
for i in $(seq 0 $LAST); do
  if [[ -n "$MUSIC" && $i -eq $LAST ]]; then
    ARGS+=(-stream_loop -1) # loop the bed for the whole video
  fi
  ARGS+=(-i "${AUDIO_INPUTS[$i]}")
done

mkdir -p "$DEST_DIR"
( cd "$OUT" && "$FFMPEG" "${ARGS[@]}" \
    -filter_complex_script "$OUT/filter.txt" \
    -map '[vout]' -map '[aout]' \
    -t "$VIDEO_DUR" \
    -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p \
    -c:a aac -b:a 192k \
    -movflags +faststart \
    "$DEST" )

FINAL_DUR="$("$FFPROBE" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$DEST")"
echo "final cut: $DEST (${FINAL_DUR%.*}s)"
