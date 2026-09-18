#!/bin/bash
# Installer executable inside "Install AE MCP Vision.app".
#
# Everything here is per-user: no sudo, no admin prompt. All user-facing
# messaging goes through osascript dialogs, because someone double-clicking an
# app in Finder will never see stdout.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PAYLOAD="$HERE/../Resources/payload"
BUNDLE_ID="com.aemcpvision.bridge"
DEST_DIR="$HOME/Library/Application Support/Adobe/CEP/extensions"
DEST="$DEST_DIR/$BUNDLE_ID"

dialog() {
  /usr/bin/osascript -e "display dialog \"$1\" buttons {\"OK\"} default button 1 with title \"AE MCP Vision\" with icon note" >/dev/null 2>&1
}
fail() {
  /usr/bin/osascript -e "display dialog \"$1\" buttons {\"OK\"} default button 1 with title \"AE MCP Vision\" with icon stop" >/dev/null 2>&1
  exit 1
}

[ -d "$PAYLOAD" ] || fail "This installer is damaged - its payload is missing. Please download it again."

# Refuse to run while After Effects is open: CEP reads the extensions folder at
# launch, so installing underneath a running AE produces a half-loaded state
# that looks like a broken install.
if /usr/bin/pgrep -x "After Effects" >/dev/null 2>&1; then
  /usr/bin/osascript -e 'display dialog "Please quit After Effects first, then run this installer again.\n\nAfter Effects loads extensions when it starts, so it needs to be closed during installation." buttons {"OK"} default button 1 with title "AE MCP Vision" with icon caution' >/dev/null 2>&1
  exit 1
fi

mkdir -p "$DEST_DIR" || fail "Could not create:\n$DEST_DIR"

# Replace a previous install, but never blindly delete something unexpected.
if [ -e "$DEST" ] || [ -L "$DEST" ]; then
  rm -rf "$DEST" || fail "Could not replace the existing installation at:\n$DEST"
fi

mkdir -p "$DEST" || fail "Could not create:\n$DEST"
if ! ( cd "$PAYLOAD" && tar -cf - . ) | ( cd "$DEST" && tar -xf - ); then
  fail "Could not copy files into:\n$DEST"
fi

# Unsigned extensions need PlayerDebugMode. Set for every CSXS version that
# might be present so the install works across After Effects releases.
for v in 10 11 12 13; do
  /usr/bin/defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1 >/dev/null 2>&1
done

dialog "Installed.\n\nNext:\n1. Open After Effects.\n2. The MCP server starts automatically.\n3. Open Window > Extensions > AE MCP Vision to get your connection settings.\n\nThe panel shows ready-to-paste configuration for Claude Desktop, Claude Code and Codex."
