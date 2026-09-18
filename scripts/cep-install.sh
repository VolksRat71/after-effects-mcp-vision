#!/usr/bin/env bash
# Dev install: symlink the CEP extension into the per-user extensions folder.
#
# No sudo and no signing certificate. Unsigned extensions load because
# PlayerDebugMode is set (see below) - signing is a packaging/release concern
# only, deliberately kept out of the local loop.
#
# Usage:  ./scripts/cep-install.sh [--uninstall]

set -euo pipefail

BUNDLE_ID="com.aemcpvision.bridge"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/cep"
DEST_DIR="$HOME/Library/Application Support/Adobe/CEP/extensions"
DEST="$DEST_DIR/$BUNDLE_ID"

if [[ "${1:-}" == "--uninstall" ]]; then
  rm -rf "$DEST"
  echo "removed $DEST"
  exit 0
fi

if [[ ! -d "$SRC" ]]; then
  echo "error: no cep/ directory at $SRC" >&2
  exit 1
fi

mkdir -p "$DEST_DIR"

# Only ever replace our own symlink. A real directory here means a packaged
# install we must not silently destroy.
if [[ -L "$DEST" ]]; then
  rm "$DEST"
elif [[ -e "$DEST" ]]; then
  echo "error: $DEST exists and is not a symlink." >&2
  echo "That looks like a packaged install - remove it by hand if intended." >&2
  exit 1
fi

ln -s "$SRC" "$DEST"
echo "linked $DEST -> $SRC"

# CEP refuses unsigned extensions unless debug mode is on, per CSXS major version.
# AE 2026 ships CEP 12; set a range so older/newer hosts also work.
for v in 10 11 12 13; do
  current="$(defaults read "com.adobe.CSXS.$v" PlayerDebugMode 2>/dev/null || echo "")"
  if [[ "$current" != "1" ]]; then
    defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1
    echo "enabled PlayerDebugMode for CSXS.$v"
  fi
done

echo
echo "Restart After Effects, then open:  Window > Extensions > AE MCP Vision"
