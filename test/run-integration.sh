#!/usr/bin/env bash
# Drives the ExtendScript integration suite against a running After Effects.
#
# Requires AE to be open. This cannot run in CI - it is the manual gate before
# a release, and the only way to verify the host layer against real AE APIs.
#
#   ./test/run-integration.sh [AE application name]

set -euo pipefail

AE_APP="${1:-Adobe After Effects 2026}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

SUITE="$WORK/suite.jsx"
RESULT="$WORK/result.json"

sed -e "s|__HOST_PATH__|$ROOT/cep/host/host.jsx|" \
    -e "s|__RESULT_PATH__|$RESULT|" \
    "$ROOT/test/integration/host-suite.jsx" > "$SUITE"

if ! pgrep -x "After Effects" >/dev/null 2>&1; then
  echo "After Effects is not running. Open it and try again." >&2
  exit 2
fi

echo "running suite against: $AE_APP"
osascript -l JavaScript -e "Application('$AE_APP').doscriptfile('$SUITE')" >/dev/null 2>&1 || true

for _ in $(seq 1 120); do
  [[ -f "$RESULT" ]] && break
  sleep 0.5
done

if [[ ! -f "$RESULT" ]]; then
  echo "suite produced no result file - AE may be showing a modal dialog" >&2
  exit 1
fi

python3 - "$RESULT" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
for r in d["results"]:
    mark = "PASS" if r["pass"] else "FAIL"
    detail = ""
    if r["pass"]:
        v = r.get("value")
        if v is not None:
            detail = json.dumps(v) if not isinstance(v, str) else v
    else:
        detail = r.get("error", "")
    print(f"  {mark}  {r['name']:<52} {str(detail)[:70]}")
print(f"\n{d['passed']}/{d['total']} passed, {d['failed']} failed")
sys.exit(0 if d["failed"] == 0 else 1)
PY
