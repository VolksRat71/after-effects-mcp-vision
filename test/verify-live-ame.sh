#!/usr/bin/env bash
# End-to-end verification against a live, running extension inside Media Encoder.
#
# Media Encoder's server -> relay (Premiere or After Effects bridge) -> BridgeTalk
# -> Media Encoder. Nothing is stubbed. Test media is generated into a fresh
# temp folder that the script leaves behind and prints.
#
# Needs: Media Encoder running with the extension loaded, Premiere Pro or After
# Effects open with a host that has bridgeTalkSend (reloadHost or restart if it
# predates it), ffmpeg and ffprobe, python3, 15 GiB free.
#
# Optional: AME_VERIFY_AEP (a SAVED .aep that reads no expression library) and
# AME_VERIFY_COMP (the guid of a comp in it, from ame_query compItems) also
# queue and render that comp. A project that reads a library is the refusal
# case, for example
#   .../_cache/fam112/fam112-library-test-v1.aep (comp "FAM112 library test 2s")
# which needs allowExpressionLibrary:true and renders frozen.
#
# Starting runs Media Encoder's whole queue, so run this with the queue empty.

set -uo pipefail

PORT="${AME_MCP_PORT:-8795}"
TOKEN_FILE="${AME_MCP_TOKEN_DIR:-$HOME/.ame-mcp-vision}/token"
MIN_GB="${AME_MCP_MIN_FREE_GB:-15}"
PASS=0; FAIL=0

ok()   { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL  $1"; echo "        $2" | cut -c1-600; FAIL=$((FAIL+1)); }
done_() { echo; echo "$PASS passed, $FAIL failed"; echo "scratch: ${WORK:-none}"; [ "$FAIL" = 0 ]; exit $?; }

if ! pgrep -f "/Contents/MacOS/Adobe Media Encoder" >/dev/null 2>&1; then
  echo "Media Encoder is not running." >&2; exit 2
fi
command -v ffmpeg >/dev/null && command -v ffprobe >/dev/null || { echo "ffmpeg and ffprobe are needed." >&2; exit 2; }

FREE_GB="$(df -k "${TMPDIR:-/tmp}" | awk 'NR==2 {printf "%d", $4/1024/1024}')"
if [ "$FREE_GB" -lt "$MIN_GB" ]; then
  echo "Only $FREE_GB GiB free; this needs $MIN_GB. Stopping." >&2; exit 2
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/ame-live-XXXXXX")"

if [ ! -f "$TOKEN_FILE" ]; then
  bad "token file exists" "no token at $TOKEN_FILE - the extension never started in Media Encoder (about 20 s after launch)"
  done_
fi
TOKEN="$(cat "$TOKEN_FILE")"
ok "token file present"

mcp() {
  curl -s --max-time 600 -X POST "http://127.0.0.1:$PORT/mcp" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$1"
}
tool() {
  local body
  body="$(python3 -c 'import json,sys; print(json.dumps({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":sys.argv[1],"arguments":json.loads(sys.argv[2])}}))' "$1" "$2")"
  mcp "$body"
}
field() { python3 -c "import sys,json;r=json.loads(json.load(sys.stdin)['result']['content'][-1]['text']);print($1)" 2>/dev/null; }
is_error() { python3 -c "import sys,json;print(json.load(sys.stdin)['result'].get('isError', False))" 2>/dev/null; }
err_text() { python3 -c "import sys,json;print(json.load(sys.stdin)['result']['content'][0]['text'])" 2>/dev/null; }

H="$(curl -s --max-time 30 -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/health")"
if echo "$H" | grep -q '"service":"ame-mcp-vision"'; then
  ok "health names ame-mcp-vision"
else
  bad "health endpoint" "${H:-no response - is the extension loaded?}"; done_
fi

R="$(tool ame_diagnostics '{"command":"health"}')"
RELAY="$(echo "$R" | field "r['relay']['name'] if r.get('relay') else ''")"
BUILD="$(echo "$R" | field "r.get('buildNumber') or ''")"
[ -n "$RELAY" ] && ok "diagnostics health shows a relay ($RELAY)" || { bad "relay in use" "$R"; done_; }
[ -n "$BUILD" ] && ok "diagnostics health shows a Media Encoder build ($BUILD)" || { bad "buildNumber" "$R"; done_; }

R="$(tool ame_query '{"command":"presets","match":"H264"}')"
PRESET="$(echo "$R" | field "next((p for p in r['presets'] if 'Match Source - High bitrate' in p), r['presets'][0] if r['presets'] else '')")"
[ -n "$PRESET" ] && [ -f "$PRESET" ] && ok "presets lists .epr files that exist ($(basename "$PRESET"))" || { bad "presets" "$R"; done_; }

R="$(tool ame_query '{"command":"formats"}')"
[ "$(echo "$R" | field "len(r['formats'])")" -gt 0 ] 2>/dev/null && ok "formats is not empty" || bad "formats" "$R"

# ---------- a file through Media Encoder ----------
ffmpeg -v error -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=2" -c:v libx264 -pix_fmt yuv420p "$WORK/clip.mp4" \
  && ok "2 s test clip generated" || { bad "test clip" "ffmpeg failed"; done_; }
OUT="$WORK/out.mp4"

R="$(tool ame_queue "{\"command\":\"file\",\"source\":\"$WORK/clip.mp4\",\"preset\":\"$PRESET\",\"path\":\"$OUT\"}")"
JOB="$(echo "$R" | field "r['jobId']")"
[ "$(echo "$R" | is_error)" = "False" ] && [ -n "$JOB" ] && ok "ame_queue file returns a jobId and starts ($JOB)" || { bad "ame_queue file" "$R"; done_; }

FIN=""
for i in $(seq 1 90); do
  R="$(tool ame_status '{"command":"finished"}')"
  FIN="$(echo "$R" | field "next((f for f in r['finished'] if f['jobId']=='$JOB'), None) and json.dumps(next(f for f in r['finished'] if f['jobId']=='$JOB'))")"
  [ -n "$FIN" ] && [ "$FIN" != "None" ] && break
  sleep 2
done
if [ -n "$FIN" ] && [ "$FIN" != "None" ]; then
  ok "ame_status finished reports the job"
else
  bad "ame_status finished" "$(tool ame_status '{}')"; done_
fi
FILE="$(python3 -c "import json,sys;print(json.loads(sys.argv[1])['path'])" "$FIN")"
SIZE="$(python3 -c "import json,sys;print(json.loads(sys.argv[1])['size'])" "$FIN")"
SHA="$(python3 -c "import json,sys;print(json.loads(sys.argv[1])['sha256'])" "$FIN")"
[ -f "$FILE" ] && ok "the output exists ($(basename "$FILE"); Media Encoder may change the extension)" || bad "output exists" "$FILE"
[ "$SIZE" = "$(stat -f %z "$FILE" 2>/dev/null || stat -c %s "$FILE")" ] && ok "finished size matches the file" || bad "size" "$SIZE"
DUR="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$FILE" 2>/dev/null)"
python3 -c "import sys;sys.exit(0 if abs(float('${DUR:-0}')-2.0)<0.3 else 1)" && ok "the output plays, about 2 s ($DUR)" || bad "output plays" "duration: ${DUR:-unreadable}"
[ "$SHA" = "$(shasum -a 256 "$FILE" | cut -d' ' -f1)" ] && ok "finished sha256 matches the file" || bad "sha256" "$SHA"
R="$(tool ame_status '{}')"
[ "$(echo "$R" | field "[j['state'] for j in r['jobs'] if j['jobId']=='$JOB'][0]")" = "done" ] && ok "ame_status shows the job done" || bad "job state" "$R"

# ---------- refusals ----------
R="$(tool ame_queue "{\"command\":\"file\",\"source\":\"$WORK/clip.mp4\",\"preset\":\"$PRESET\",\"path\":\"$WORK/clip.mp4\"}")"
echo "$(echo "$R" | err_text)" | grep -q '^exists:' && ok "an existing output is refused without overwrite" || bad "overwrite guard" "$R"

R="$(tool ame_queue "{\"command\":\"file\",\"source\":\"$WORK/clip.mp4\",\"preset\":\"$WORK/none.epr\",\"path\":\"$WORK/o2.mp4\"}")"
echo "$(echo "$R" | err_text)" | grep -q '^missing_file:' && ok "a missing preset is refused" || bad "missing preset" "$R"

printf 'junk var L=footage("lib.jsx").sourceData; L.cam(L,time) junk' > "$WORK/fake.aep"
R="$(tool ame_queue "{\"command\":\"comp\",\"projectPath\":\"$WORK/fake.aep\",\"guid\":\"00000001-0000-0000-0000-000000000000\",\"preset\":\"$PRESET\",\"path\":\"$WORK/o3.mp4\"}")"
echo "$(echo "$R" | err_text)" | grep -q '^expression_library:.*lib.jsx' && ok "a project reading an expression library is refused, naming it" || bad "expression_library" "$R"

R="$(tool ame_batch '{"command":"clear"}')"
echo "$(echo "$R" | err_text)" | grep -q '^needs_all:' && ok "clear without all:true is refused" || bad "clear guard" "$R"

# ---------- optional: a real comp ----------
if [ -n "${AME_VERIFY_AEP:-}" ] && [ -n "${AME_VERIFY_COMP:-}" ]; then
  R="$(tool ame_queue "{\"command\":\"comp\",\"projectPath\":\"$AME_VERIFY_AEP\",\"guid\":\"$AME_VERIFY_COMP\",\"preset\":\"$PRESET\",\"path\":\"$WORK/comp.mp4\"}")"
  CJOB="$(echo "$R" | field "r['jobId']")"
  if [ -z "$CJOB" ]; then
    bad "ame_queue comp" "$(echo "$R" | err_text)"
  else
    CFILE=""
    for i in $(seq 1 120); do
      R="$(tool ame_status '{"command":"finished"}')"
      CFILE="$(echo "$R" | field "next((f['path'] for f in r['finished'] if f['jobId']=='$CJOB'), '')")"
      [ -n "$CFILE" ] && break
      sleep 2
    done
    CDUR="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$CFILE" 2>/dev/null)"
    [ -n "$CFILE" ] && [ -n "$CDUR" ] && ok "the queued comp rendered and plays ($CDUR s)" || bad "comp render" "no finished file for $CJOB"
  fi
else
  echo "  skip  comp render (set AME_VERIFY_AEP and AME_VERIFY_COMP to run it)"
fi

tool ame_batch '{"command":"clear","all":true}' >/dev/null
done_
