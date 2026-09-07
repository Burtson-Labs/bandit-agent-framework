#!/usr/bin/env bash
# Fetch a free Mixkit music bed into assets/music-bed.mp3 (local use only —
# Mixkit's free license covers video use; nothing here is redistributed).
# If none of the URLs work, pick a track manually at https://mixkit.co/free-stock-music/
# — see README "Music bed" for suggestions — and save it as assets/music-bed.mp3.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/assets/music-bed.mp3"

if [[ -f "$DEST" ]]; then
  echo "already have $DEST"
  exit 0
fi

# The /music/download/<slug> URLs 403 for curl; the raw asset URLs
# (https://assets.mixkit.co/music/<id>/<id>.mp3) work with a browser UA +
# referer. Ids: 130 = Tech House Vibes, 132 = Hazy After Hours, 443 = Serene View.
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
URLS=(
  "https://assets.mixkit.co/music/130/130.mp3"
  "https://assets.mixkit.co/music/132/132.mp3"
  "https://assets.mixkit.co/music/443/443.mp3"
)

for url in "${URLS[@]}"; do
  echo "trying $url"
  if curl -fsSL -m 90 -A "$UA" -e "https://mixkit.co/free-stock-music/" "$url" -o "$DEST.tmp"; then
    # Make sure we got audio, not an HTML error page.
    if ffprobe -v error -show_entries format=format_name -of default=noprint_wrappers=1:nokey=1 "$DEST.tmp" 2>/dev/null | grep -q mp3; then
      mv "$DEST.tmp" "$DEST"
      echo "saved $DEST"
      exit 0
    fi
  fi
  rm -f "$DEST.tmp"
done

echo "could not fetch a Mixkit track — download one manually (see README 'Music bed') into assets/music-bed.mp3" >&2
exit 1
