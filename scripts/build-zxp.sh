#!/usr/bin/env bash
# Builds a distributable .zxp from cep/.
#
# Signing is a RELEASE concern and is kept out of the local loop on purpose:
# local development symlinks cep/ via scripts/cep-install.sh and relies on
# PlayerDebugMode, so no certificate is needed to build or test.
#
# To produce a signed .zxp you need Adobe's ZXPSignCmd and a code-signing
# certificate. Set:
#   ZXP_CERT      path to a .p12
#   ZXP_CERT_PASS its password
#   ZXPSIGNCMD    path to ZXPSignCmd (default: looked up on PATH)
#
# Without those it emits an UNSIGNED .zxp, which installs only where
# PlayerDebugMode is enabled. That is fine for CI artifacts and testers, and
# not fine for public distribution.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/cep"
DIST="$ROOT/dist"
VERSION="$(node -p "require('$ROOT/package.json').version")"
STAGE="$DIST/stage"
OUT="$DIST/ae-mcp-vision-$VERSION.zxp"

rm -rf "$DIST"
mkdir -p "$STAGE"

# Copy the extension, excluding anything that should never ship.
# .debug opens CEP remote-debugging ports and is strictly a dev aid - it must
# never ship in a release package.
( cd "$SRC" && tar --exclude='.DS_Store' --exclude='*.log' --exclude='.debug' -cf - . ) | ( cd "$STAGE" && tar -xf - )

# MIT requires the copyright notice to travel with "all copies or substantial
# portions of the Software", and a packaged .zxp is a copy. This project is a
# derivative of Dakkshin/after-effects-mcp, so shipping without the notice is a
# licence breach, not a cosmetic omission.
cp "$ROOT/LICENSE" "$STAGE/LICENSE"

# Keep the manifest version in step with package.json so a released .zxp cannot
# claim a version the code does not have.
python3 - "$STAGE/CSXS/manifest.xml" "$VERSION" <<'PY'
import re, sys
path, version = sys.argv[1], sys.argv[2]
xml = open(path).read()
xml = re.sub(r'(ExtensionBundleVersion=")[^"]+(")', rf'\g<1>{version}\g<2>', xml)
xml = re.sub(r'(<Extension Id="[^"]+"\s+Version=")[^"]+(")', rf'\g<1>{version}\g<2>', xml)
open(path, 'w').write(xml)
print(f"manifest stamped to {version}")
PY

SIGNCMD="${ZXPSIGNCMD:-$(command -v ZXPSignCmd || true)}"

if [[ -n "$SIGNCMD" && -n "${ZXP_CERT:-}" && -n "${ZXP_CERT_PASS:-}" ]]; then
  echo "signing with $SIGNCMD"
  "$SIGNCMD" -sign "$STAGE" "$OUT" "$ZXP_CERT" "$ZXP_CERT_PASS" -tsa http://timestamp.digicert.com
  echo "signed: $OUT"
else
  echo "WARNING: no ZXPSignCmd and/or certificate - producing an UNSIGNED package." >&2
  echo "         It will install only where PlayerDebugMode is enabled." >&2
  # -D omits directory entries; some Adobe/zip consumers choke on them.
  ( cd "$STAGE" && zip -r -q -D "$OUT" . )
  echo "unsigned: $OUT"
fi

rm -rf "$STAGE"
ls -lh "$OUT"
