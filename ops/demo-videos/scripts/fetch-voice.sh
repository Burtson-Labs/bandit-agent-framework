#!/usr/bin/env bash
# Download the Kokoro voice bundle used for narration.
#
# Apache-2.0 weights (hexgrad/Kokoro-82M) published by the sherpa-onnx
# project. ~326 MB unpacked. Skipped entirely if a copy already exists —
# including the voice-lab checkout on a dev Mac, which `kokoroModelDir()`
# finds without anything being downloaded twice.
set -euo pipefail

BUNDLE="${KOKORO_BUNDLE:-kokoro-multi-lang-v1_0}"
URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/${BUNDLE}.tar.bz2"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${KOKORO_MODEL_DIR:-$HERE/models/$BUNDLE}"

if [ -f "$DEST/model.onnx" ] && [ -f "$DEST/voices.bin" ]; then
  echo "Kokoro bundle already present: $DEST"
  exit 0
fi

VOICE_LAB="$HOME/Documents/GitHub/voice-lab/models/$BUNDLE"
if [ -f "$VOICE_LAB/model.onnx" ]; then
  echo "Using the voice-lab copy: $VOICE_LAB"
  echo "(set KOKORO_MODEL_DIR to override, or delete it to force a download)"
  exit 0
fi

mkdir -p "$HERE/models"
echo "Downloading $BUNDLE (~326 MB) …"
curl -fL --progress-bar "$URL" -o "$HERE/models/$BUNDLE.tar.bz2"
echo "Unpacking …"
tar -xjf "$HERE/models/$BUNDLE.tar.bz2" -C "$HERE/models"
rm -f "$HERE/models/$BUNDLE.tar.bz2"
echo "Ready: $DEST"
