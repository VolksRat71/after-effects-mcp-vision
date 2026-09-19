#!/usr/bin/env bash
# Runs the capability probe against a live After Effects.
#
# SAFETY: probes create dozens of layers, so they run in a THROWAWAY project.
# This script saves whatever is open, opens a new empty project, probes, then
# reopens the original. The probe itself refuses to run if the project is not
# empty. Two prior incidents motivate all of this - the unit suite deleted the
# live auth token, and the integration suite renamed the open project.

set -uo pipefail

# --keep leaves the probe project open so you can inspect what the probes built.
# Without it the driver restores your project immediately, which means three
# project swaps per run and nothing to look at.
KEEP=0
ARGS=()
for a in "$@"; do
  case "$a" in
    --keep|-k) KEEP=1 ;;
    *) ARGS+=("$a") ;;
  esac
done
AE_APP="${ARGS[0]:-Adobe After Effects 2026}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
RESULT="$WORK/probe.json"
# The stash must OUTLIVE $WORK. If the open project was untitled we reopen it
# from here, and deleting the file out from under AE would leave it holding a
# project whose file no longer exists.
STASH_DIR="$HOME/.ae-mcp-vision/stash"
mkdir -p "$STASH_DIR"
STASH="$STASH_DIR/probe-stash-$(date +%Y%m%d-%H%M%S).aep"

if ! pgrep -x "After Effects" >/dev/null 2>&1; then
  echo "After Effects is not running." >&2; exit 2
fi

jxa() { osascript -l JavaScript -e "Application('$AE_APP').doscriptfile('$1')" >/dev/null 2>&1; }

# 1. stash whatever is open
cat > "$WORK/stash.jsx" <<JSX
(function(){ try { app.beginSuppressDialogs();
  var had = app.project.file ? app.project.file.fsName : "";
  var f = new File("$WORK/original_path.txt"); f.open("w"); f.write(had); f.close();
  if (app.project.numItems > 0 || app.project.dirty) { app.project.save(new File("$STASH")); }
  app.endSuppressDialogs(false); app.exitCode = 0;
} catch(e) { app.exitCode = 1; } })();
JSX
jxa "$WORK/stash.jsx"; sleep 2
ORIGINAL="$(cat "$WORK/original_path.txt" 2>/dev/null || echo "")"
echo "stashed open project: ${ORIGINAL:-<untitled>}"

# 2. throwaway project
cat > "$WORK/fresh.jsx" <<'JSX'
(function(){ try { app.beginSuppressDialogs(); app.newProject();
  app.endSuppressDialogs(false); app.exitCode = 0; } catch(e){ app.exitCode = 1; } })();
JSX
jxa "$WORK/fresh.jsx"; sleep 3

# 3. probe
sed -e "s|__HOST_PATH__|$ROOT/cep/host/host.jsx|" \
    -e "s|__RESULT_PATH__|$RESULT|" \
    "$ROOT/test/probe/capability-probe.jsx" > "$WORK/probe.jsx"
echo "probing..."
jxa "$WORK/probe.jsx"
for _ in $(seq 1 180); do [[ -f "$RESULT" ]] && break; sleep 0.5; done

# 4. restore, unless asked to keep the probe project open
if [[ "$KEEP" == "1" ]]; then
  echo
  echo "--keep: leaving the probe project open for inspection."
  echo "Your project is stashed at: ${ORIGINAL:-$STASH}"
  echo "Reopen it yourself when done."
  python3 "$ROOT/test/probe/report.py" "$RESULT"
  STATUS=$?
  mkdir -p "$ROOT/dist" && cp "$RESULT" "$ROOT/dist/probe.json"
  rm -rf "$WORK"
  exit $STATUS
fi

cat > "$WORK/restore.jsx" <<JSX
(function(){ try { app.beginSuppressDialogs();
  var p = "$STASH"; var orig = "$ORIGINAL";
  var target = (orig !== "") ? orig : p;
  var f = new File(target);
  if (f.exists) { app.open(f); } else { app.newProject(); }
  app.endSuppressDialogs(false); app.exitCode = 0;
} catch(e){ app.exitCode = 1; } })();
JSX
jxa "$WORK/restore.jsx"; sleep 3
echo "restored: ${ORIGINAL:-<new empty project>}"

if [[ ! -f "$RESULT" ]]; then
  echo "probe produced no result - AE may be showing a modal" >&2
  rm -rf "$WORK"; exit 1
fi
mkdir -p "$ROOT/dist" && cp "$RESULT" "$ROOT/dist/probe.json"
python3 "$ROOT/test/probe/report.py" "$RESULT"
STATUS=$?
rm -rf "$WORK"
echo
echo "stash kept at: $STASH (delete once you have confirmed your project is fine)"
exit $STATUS
