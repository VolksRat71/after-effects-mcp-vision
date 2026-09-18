#!/usr/bin/env bash
# End-to-end verification against a live, running extension inside After Effects.
#
# Unlike the unit and integration suites this exercises the whole stack:
# CEP Node -> HTTP -> MCP protocol -> evalScript -> ExtendScript -> After Effects.
# Nothing is stubbed.

set -uo pipefail

PORT="${AE_MCP_PORT:-8791}"
TOKEN_FILE="$(node -p "require('os').tmpdir()")/ae-mcp-vision/token"
PASS=0; FAIL=0

ok()   { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL  $1"; echo "        $2"; FAIL=$((FAIL+1)); }

if ! pgrep -x "After Effects" >/dev/null 2>&1; then
  echo "After Effects is not running." >&2; exit 2
fi

if [ ! -f "$TOKEN_FILE" ]; then
  bad "token file exists" "no token at $TOKEN_FILE - the extension never started"
  echo; echo "0/1 passed"; exit 1
fi
TOKEN="$(cat "$TOKEN_FILE")"
ok "token file present"

mcp() {
  curl -s --max-time 30 -X POST "http://127.0.0.1:$PORT/mcp" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$1"
}

H="$(curl -s --max-time 10 -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/health")"
if echo "$H" | grep -q '"ok":true'; then
  ok "health endpoint responds"
  echo "        node $(echo "$H" | python3 -c 'import sys,json;print(json.load(sys.stdin)["nodeVersion"])' 2>/dev/null)"
  if echo "$H" | grep -q '"reachable":true'; then
    ok "ExtendScript host reachable through evalScript"
  else
    bad "ExtendScript host reachable" "$H"
  fi
else
  bad "health endpoint responds" "${H:-no response - is the extension loaded?}"
fi

R="$(mcp '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}')"
echo "$R" | grep -q 'ae-mcp-vision' && ok "MCP initialize" || bad "MCP initialize" "$R"

R="$(mcp '{"jsonrpc":"2.0","id":2,"method":"tools/list"}')"
COUNT="$(echo "$R" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["result"]["tools"]))' 2>/dev/null || echo 0)"
[ "$COUNT" = "8" ] && ok "tools/list returns 8 tools" || bad "tools/list returns 8 tools" "got $COUNT: $R"

R="$(mcp '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"ae_query","arguments":{"command":"sessionInfo"}}}')"
echo "$R" | grep -q 'aeVersion' && ok "ae_query sessionInfo through the full stack" || bad "ae_query sessionInfo" "$R"

R="$(mcp '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"ae_diagnostics","arguments":{}}}')"
echo "$R" | grep -q 'healthy' && ok "ae_diagnostics" || bad "ae_diagnostics" "$R"

# Vision: only meaningful if a comp exists.
R="$(mcp '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"ae_capture","arguments":{"command":"frame","longEdge":256}}}')"
if echo "$R" | grep -q '"type":"image"'; then
  BYTES="$(echo "$R" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(len(d["result"]["content"][0]["data"]))' 2>/dev/null)"
  ok "ae_capture returned a real image ($BYTES base64 chars)"
  echo "$R" | python3 -c 'import sys,json,base64,pathlib;d=json.load(sys.stdin);pathlib.Path("/tmp/ae-live-capture.png").write_bytes(base64.b64decode(d["result"]["content"][0]["data"]))' 2>/dev/null \
    && echo "        wrote /tmp/ae-live-capture.png"
elif echo "$R" | grep -q 'No composition available'; then
  echo "  SKIP  ae_capture (no composition open)"
else
  bad "ae_capture" "$R"
fi

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
