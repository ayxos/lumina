#!/usr/bin/env bash
# Ensure Lumina runtime directories exist on the host (survives reboot).
# Usage: ./scripts/setup.sh [path/to/photos]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PHOTOS="${1:-${LUMINA_MEDIA_PATH:-}}"

mkdir -p "$ROOT/data/thumbnails" "$ROOT/data/backups"

if [ -n "$PHOTOS" ]; then
  if [ ! -d "$PHOTOS" ]; then
    echo "Photo library not found: $PHOTOS" >&2
    exit 1
  fi
  if [ -e "$ROOT/media" ] && [ ! -L "$ROOT/media" ]; then
    echo "Refusing to replace existing media/ directory — move it aside first." >&2
    exit 1
  fi
  ln -sfn "$PHOTOS" "$ROOT/media"
  echo "media -> $PHOTOS"
elif [ ! -e "$ROOT/media" ]; then
  mkdir -p "$ROOT/media"
  echo "Created empty $ROOT/media (add photos or re-run with your library path)"
fi

echo "Runtime dirs ready under $ROOT/data"
