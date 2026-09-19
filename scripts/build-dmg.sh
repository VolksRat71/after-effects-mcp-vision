#!/usr/bin/env bash
# Builds a macOS .dmg containing a double-clickable installer app.
#
# The app copies the extension into the per-user CEP extensions folder and
# enables PlayerDebugMode - no admin, no terminal. It is the same work
# scripts/cep-install.sh does, wrapped so a non-technical user can run it.
#
# SIGNING: if APPLE_SIGN_ID is set the app and dmg are signed, and if
# APPLE_ID / APPLE_TEAM_ID / APPLE_APP_PASSWORD are also set the dmg is
# notarized and stapled. Without them the build still succeeds and produces an
# UNSIGNED dmg, which macOS Gatekeeper will block on first open until the user
# right-clicks > Open. That tradeoff is documented in the release notes.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(node -p "require('$ROOT/package.json').version")"
DIST="$ROOT/dist"
APP_NAME="Install AE MCP Vision"
APP="$DIST/dmgroot/$APP_NAME.app"
DMG="$DIST/AE-MCP-Vision-$VERSION-macOS.dmg"

rm -rf "$DIST/dmgroot" "$DMG"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# Payload: the extension itself, minus dev-only bits.
mkdir -p "$APP/Contents/Resources/payload"
( cd "$ROOT/cep" && tar --exclude='.DS_Store' --exclude='*.log' --exclude='.debug' -cf - . ) \
  | ( cd "$APP/Contents/Resources/payload" && tar -xf - )

# MIT requires the notice to travel with every copy, and an installer payload
# is a copy. This is a derivative of Dakkshin/after-effects-mcp.
cp "$ROOT/LICENSE" "$APP/Contents/Resources/payload/LICENSE"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>$APP_NAME</string>
  <key>CFBundleDisplayName</key><string>$APP_NAME</string>
  <key>CFBundleIdentifier</key><string>com.aemcpvision.installer</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>installer</string>
  <key>LSMinimumSystemVersion</key><string>10.14</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

cp "$ROOT/scripts/installer/macos-installer.sh" "$APP/Contents/MacOS/installer"
chmod +x "$APP/Contents/MacOS/installer"

if [[ -n "${APPLE_SIGN_ID:-}" ]]; then
  echo "signing app as $APPLE_SIGN_ID"
  codesign --force --deep --options runtime --sign "$APPLE_SIGN_ID" "$APP"
else
  echo "WARNING: APPLE_SIGN_ID not set - the app is UNSIGNED." >&2
  echo "         Users must right-click > Open the first time." >&2
fi

# Deliberately no /Applications symlink: this is a double-click installer, not
# a drag-to-install app, and the symlink implies the wrong gesture.

hdiutil create -volname "AE MCP Vision" -srcfolder "$DIST/dmgroot" \
  -ov -format UDZO "$DMG" >/dev/null
echo "built $DMG"

if [[ -n "${APPLE_SIGN_ID:-}" ]]; then
  codesign --force --sign "$APPLE_SIGN_ID" "$DMG"
  if [[ -n "${APPLE_ID:-}" && -n "${APPLE_TEAM_ID:-}" && -n "${APPLE_APP_PASSWORD:-}" ]]; then
    echo "notarizing"
    xcrun notarytool submit "$DMG" --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" \
      --password "$APPLE_APP_PASSWORD" --wait
    xcrun stapler staple "$DMG"
    echo "notarized and stapled"
  fi
fi

rm -rf "$DIST/dmgroot"
ls -lh "$DMG"
