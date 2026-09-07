#!/usr/bin/env bash
#
# assemble.sh <vidrec|videx>
#
# Takes out/<product>/{raw.webm, subs.srt, steps.tsv, narration/*.aiff} from
# record.mjs and produces ~/Desktop/bandit-demos/<product>-<YYYY-MM-DD>.mp4:
#
#   1. pads each per-step narration clip to its exact on-screen step duration
#   2. concatenates them into one narration track aligned with the video
#   3. optionally ducks a music bed under it (first assets/music.* if present)
#   4. burns subs.srt into the picture and encodes h264/aac
#   5. verifies the result with ffprobe (duration must exceed 15s)
#
# Steps with no narration audio (say unavailable) become silence, so a cut
# always renders.
set -euo pipefail

PRODUCT="${1:?usage: assemble.sh <vidrec|videx>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/out/$PRODUCT"
DEST="$HOME/Desktop/bandit-demos"
STAMP="$(date +%F)"
FINAL="$DEST/$PRODUCT-$STAMP.mp4"

[ -f "$OUT/raw.webm" ]  || { echo "missing $OUT/raw.webm — run: node record.mjs $PRODUCT" >&2; exit 1; }
[ -f "$OUT/steps.tsv" ] || { echo "missing $OUT/steps.tsv — run: node record.mjs $PRODUCT" >&2; exit 1; }
[ -f "$OUT/subs.srt" ]  || { echo "missing $OUT/subs.srt — run: node record.mjs $PRODUCT" >&2; exit 1; }

# The burn-in needs the libass `subtitles` filter and some system ffmpeg
# builds ship without it — probe candidates instead of trusting PATH. The
# ffmpeg-static devDependency is a full build, so it always qualifies.
FFMPEG=""
for cand in "$(command -v ffmpeg || true)" "$(cd "$HERE" && node -p "require('ffmpeg-static')" 2>/dev/null || true)"; do
  [ -n "$cand" ] && [ -x "$cand" ] || continue
  if "$cand" -hide_banner -filters 2>/dev/null | grep ' subtitles ' >/dev/null; then
    FFMPEG="$cand"
    break
  fi
  echo "note: $cand has no subtitles filter — skipping"
done
[ -n "$FFMPEG" ] || { echo "no subtitles-capable ffmpeg found — npm install here (ffmpeg-static) or a libass-enabled brew ffmpeg" >&2; exit 1; }

FFPROBE="$(command -v ffprobe || true)"
[ -n "$FFPROBE" ] || FFPROBE="$(cd "$HERE" && node -p "require('ffprobe-static').path" 2>/dev/null || true)"
[ -n "$FFPROBE" ] || { echo "ffprobe not found — brew install ffmpeg or npm install here (ffprobe-static)" >&2; exit 1; }

mkdir -p "$DEST" "$OUT/audio"
cd "$OUT" # keeps the subtitles= filter path free of escaping problems

# --- 1. per-step narration segments, each padded to the exact step duration
: > audio/concat.txt
while IFS=$'\t' read -r idx _start dur audio_rel; do
  [ -n "$idx" ] || continue
  seg="audio/seg-$idx.wav"
  dur_s="$(awk -v d="$dur" 'BEGIN{printf "%.3f", d/1000}')"
  if [ -n "$audio_rel" ] && [ -f "$audio_rel" ]; then
    "$FFMPEG" -y -v error -i "$audio_rel" -ar 44100 -ac 2 -af apad -t "$dur_s" "$seg"
  else
    "$FFMPEG" -y -v error -f lavfi -i "anullsrc=r=44100:cl=stereo" -t "$dur_s" "$seg"
  fi
  echo "file 'seg-$idx.wav'" >> audio/concat.txt
done < steps.tsv

# --- 2. one narration track
"$FFMPEG" -y -v error -f concat -safe 0 -i audio/concat.txt -c pcm_s16le audio/narration.wav

# --- 3. optional music bed (first assets/music.* wins), ducked under narration
MUSIC=""
for f in "$HERE"/assets/music.*; do
  [ -f "$f" ] && { MUSIC="$f"; break; }
done
if [ -n "$MUSIC" ]; then
  echo "[assemble] music bed: $(basename "$MUSIC")"
  "$FFMPEG" -y -v error -i audio/narration.wav -stream_loop -1 -i "$MUSIC" \
    -filter_complex "[1:a]volume=0.12[m];[0:a][m]amix=inputs=2:duration=first:dropout_transition=2,apad=pad_dur=3[a]" \
    -map "[a]" -c pcm_s16le audio/mix.wav
else
  echo "[assemble] no assets/music.* found — narration only (see assets/README.md)"
  "$FFMPEG" -y -v error -i audio/narration.wav -af "apad=pad_dur=3" -c pcm_s16le audio/mix.wav
fi

# --- 4. burn subtitles, encode
# Prefer subs.ass: its style header carries font/outline/margins, so no
# force_style= inline quoting (which ffmpeg 8's filter parser rejects).
SUBS="subs.srt"
[ -f subs.ass ] && SUBS="subs.ass"
"$FFMPEG" -y -v error -i raw.webm -i audio/mix.wav \
  -map 0:v -map 1:a \
  -vf "subtitles=$SUBS" \
  -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p -r 30 \
  -c:a aac -b:a 160k -movflags +faststart -shortest \
  "$FINAL"

# --- 5. verify
DUR="$("$FFPROBE" -v error -show_entries format=duration -of csv=p=0 "$FINAL")"
echo "[assemble] $FINAL — ${DUR}s"
awk -v d="$DUR" 'BEGIN{ if (d+0 > 15) exit 0; exit 1 }' \
  || { echo "[assemble] FAIL: duration ${DUR}s is not > 15s" >&2; exit 1; }
echo "[assemble] PASS (duration > 15s)"
