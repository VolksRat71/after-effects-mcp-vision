#!/usr/bin/env bash
# End-to-end verification against a live, running extension inside Premiere Pro.
#
# CEP Node -> HTTP -> MCP protocol -> evalScript -> ExtendScript -> Premiere.
# Nothing is stubbed. Everything happens in a scratch project the script
# creates, with media it generates (colour bars, a test card, a sine tone), in
# a fresh temp folder that it leaves behind and prints. It never opens or
# edits a project you have open.
#
# Part two is the FCP7 XML probe: a hand-written xmeml with two video tracks,
# a still with a duration, an audio level keyframe, a cross dissolve, a marker
# and a Motion scale keyframe is imported, and Premiere's own re-export of the
# imported sequence shows which of those survived. Those lines say SURVIVED or
# LOST; they are findings about Premiere, not bridge failures.
#
# Needs: Premiere running with the extension loaded, ffmpeg, python3.

set -uo pipefail

PORT="${PREMIERE_MCP_PORT:-8794}"
TOKEN_FILE="$HOME/.premiere-mcp-vision/token"
PASS=0; FAIL=0

ok()   { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL  $1"; echo "        $2" | cut -c1-600; FAIL=$((FAIL+1)); }
done_() { echo; echo "$PASS passed, $FAIL failed"; echo "scratch: $WORK"; [ "$FAIL" = 0 ]; exit $?; }

if ! pgrep -f "/Contents/MacOS/Adobe Premiere Pro" >/dev/null 2>&1; then
  echo "Premiere Pro is not running." >&2; exit 2
fi
command -v ffmpeg >/dev/null || { echo "ffmpeg is needed to make the test media." >&2; exit 2; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/premiere-live-XXXXXX")"

if [ ! -f "$TOKEN_FILE" ]; then
  bad "token file exists" "no token at $TOKEN_FILE - the extension never started (open Window > Extensions > Premiere MCP Vision once)"
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
# Evaluate a Python expression against the last text block of a tool result, bound to r.
field() { python3 -c "import sys,json;r=json.loads(json.load(sys.stdin)['result']['content'][-1]['text']);print($1)" 2>/dev/null; }
is_error() { python3 -c "import sys,json;print(json.load(sys.stdin)['result'].get('isError', False))" 2>/dev/null; }

H="$(curl -s --max-time 10 -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/health")"
if echo "$H" | grep -q '"service":"premiere-mcp-vision"'; then
  ok "health names premiere-mcp-vision"
  echo "$H" | grep -q '"reachable":true' && ok "ExtendScript host reachable" || bad "ExtendScript host reachable" "$H"
else
  bad "health endpoint" "${H:-no response - is the extension loaded?}"; done_
fi

R="$(mcp '{"jsonrpc":"2.0","id":2,"method":"tools/list"}')"
COUNT="$(echo "$R" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["result"]["tools"]))' 2>/dev/null || echo 0)"
[ "$COUNT" = "12" ] && ok "tools/list returns 12 tools" || bad "tools/list returns 12 tools" "got $COUNT"

R="$(tool pr_query '{"command":"sessionInfo"}')"
echo "$R" | grep -q 'appVersion' && ok "pr_query sessionInfo ($(echo "$R" | field "r['appVersion']"))" || bad "pr_query sessionInfo" "$R"

# ---------- media ----------
ffmpeg -v error -f lavfi -i "smptehdbars=size=1920x1080:rate=30:duration=10" -c:v libx264 -pix_fmt yuv420p "$WORK/bars.mp4" \
  && ffmpeg -v error -f lavfi -i "testsrc2=size=1920x1080:rate=1:duration=1" -frames:v 1 "$WORK/card.png" \
  && ffmpeg -v error -f lavfi -i "sine=frequency=1000:sample_rate=48000:duration=10" -ac 2 -c:a pcm_s16le "$WORK/tone.wav" \
  && ok "test media generated" || { bad "test media" "ffmpeg failed"; done_; }

# ---------- project, import, sequence ----------
R="$(tool pr_project "{\"command\":\"new\",\"path\":\"$WORK/scratch.prproj\"}")"
[ "$(echo "$R" | is_error)" = "False" ] && ok "pr_project new" || { bad "pr_project new" "$R"; done_; }

R="$(tool pr_project "{\"command\":\"import\",\"paths\":[\"$WORK/bars.mp4\",\"$WORK/card.png\",\"$WORK/tone.wav\"]}")"
ITEMS="$(echo "$R" | field "{i['name']: i['nodeId'] for i in r['items']}")"
BARS="$(echo "$R" | field "[i['nodeId'] for i in r['items'] if i['name'].startswith('bars')][0]")"
CARD="$(echo "$R" | field "[i['nodeId'] for i in r['items'] if i['name'].startswith('card')][0]")"
TONE="$(echo "$R" | field "[i['nodeId'] for i in r['items'] if i['name'].startswith('tone')][0]")"
[ -n "$BARS" ] && [ -n "$CARD" ] && [ -n "$TONE" ] && ok "pr_project import returns nodeIds $ITEMS" || { bad "pr_project import" "$R"; done_; }

R="$(tool pr_sequence '{"command":"create","name":"live-check","preset":"HD 1080p/HD 1080p 29.97 fps"}')"
SEQ="$(echo "$R" | field "r['sequenceId']")"
[ -n "$SEQ" ] && ok "pr_sequence create from a preset, no dialog ($(echo "$R" | field "str(r['width'])+'x'+str(r['height'])+' @ '+str(r['fps'])"))" || { bad "pr_sequence create" "$R"; done_; }

# ---------- clips ----------
R="$(tool pr_clips "{\"command\":\"overwrite\",\"sequenceId\":\"$SEQ\",\"items\":[
  {\"projectItem\":\"$BARS\",\"track\":\"V1\",\"at\":0,\"sourceIn\":1,\"sourceOut\":7},
  {\"projectItem\":\"$CARD\",\"track\":\"V2\",\"at\":1,\"duration\":3},
  {\"projectItem\":\"$TONE\",\"track\":\"A1\",\"at\":0,\"duration\":6}]}")"
ERRS="$(echo "$R" | field "len(r['errors'])")"
[ "$ERRS" = "0" ] && ok "pr_clips overwrite: three clips placed" || bad "pr_clips overwrite" "$R"
CARD_CLIP="$(echo "$R" | field "r['applied'][1]['placed'][0]['nodeId']")"
TONE_CLIP="$(echo "$R" | field "r['applied'][2]['placed'][0]['nodeId']")"
BARS_CLIP="$(echo "$R" | field "r['applied'][0]['placed'][0]['nodeId']")"

R="$(tool pr_query "{\"command\":\"tree\",\"sequenceId\":\"$SEQ\"}")"
GOT="$(echo "$R" | field "[(c['track'],c['start']['frame'],c['end']['frame']) for t in r['tracks'] for c in t['clips']]")"
echo "$GOT" | grep -q "('V1', 0, 180)" && ok "bars on V1 frames 0-180 (6 s source range)" || bad "bars placement" "$GOT"
echo "$GOT" | grep -q "('V2', 30, 120)" && ok "still on V2 frames 30-120 (duration 3 s)" || bad "still duration" "$GOT"
echo "$GOT" | grep -q "('A1', 0, 180)" && ok "tone on A1 frames 0-180" || bad "tone placement" "$GOT"

# ---------- markers, motion, audio ----------
R="$(tool pr_markers "{\"command\":\"add\",\"sequenceId\":\"$SEQ\",\"markers\":[{\"at\":2,\"name\":\"Chapter one\",\"type\":\"chapter\"}]}")"
R="$(tool pr_markers "{\"command\":\"list\",\"sequenceId\":\"$SEQ\"}")"
[ "$(echo "$R" | field "[(m['name'],m['type'],m['start']['frame']) for m in r['markers']]")" = "[('Chapter one', 'chapter', 60)]" ] \
  && ok "chapter marker at frame 60" || bad "pr_markers" "$R"

R="$(tool pr_motion "{\"sequenceId\":\"$SEQ\",\"items\":[{\"nodeId\":\"$CARD_CLIP\",\"position\":[960,540],\"keys\":[{\"at\":0,\"scale\":50},{\"at\":3,\"scale\":80}]}]}")"
[ "$(echo "$R" | field "len(r['errors'])")" = "0" ] && ok "pr_motion position and scale keys" || bad "pr_motion" "$R"
R="$(tool pr_query "{\"command\":\"clip\",\"sequenceId\":\"$SEQ\",\"nodeId\":\"$CARD_CLIP\"}")"
KEYS="$(echo "$R" | field "[p.get('keys') for c in r['components'] if c['name']=='Motion' for p in c['params'] if p['name']=='Scale'][0]")"
echo "$KEYS" | grep -q "'at': 0" && echo "$KEYS" | grep -q "'at': 3" && echo "$KEYS" | grep -q "80" \
  && ok "scale keys read back at 0 s and 3 s from the clip's start: $KEYS" || bad "scale keys read back" "$KEYS"

R="$(tool pr_audio "{\"command\":\"level\",\"sequenceId\":\"$SEQ\",\"items\":[{\"nodeId\":\"$TONE_CLIP\",\"keys\":[{\"at\":0,\"value\":-60},{\"at\":1,\"value\":-6}]}]}")"
R="$(tool pr_audio "{\"command\":\"read\",\"sequenceId\":\"$SEQ\",\"nodeId\":\"$TONE_CLIP\"}")"
[ "$(echo "$R" | field "[(float(k['at']), round(k['db'])) for k in r['keys']]")" = "[(0.0, -60), (1.0, -6)]" ] \
  && ok "audio fade keys read back in dB" || bad "pr_audio keys" "$R"

# ---------- vision ----------
R="$(tool pr_capture "{\"command\":\"frame\",\"sequenceId\":\"$SEQ\",\"time\":2,\"longEdge\":480}")"
if echo "$R" | grep -q '"type":"image"'; then
  echo "$R" | python3 -c 'import sys,json,base64;d=json.load(sys.stdin);open(sys.argv[1],"wb").write(base64.b64decode(d["result"]["content"][0]["data"]))' "$WORK/capture-2s.png"
  ok "pr_capture frame returned an image (saved $WORK/capture-2s.png - check the card sits over the bars)"
else
  bad "pr_capture frame" "$R"
fi
R="$(tool pr_capture "{\"command\":\"frames\",\"sequenceId\":\"$SEQ\",\"times\":[0.5,2,4.5]}")"
if echo "$R" | grep -q '"type":"image"'; then
  echo "$R" | python3 -c 'import sys,json,base64;d=json.load(sys.stdin);open(sys.argv[1],"wb").write(base64.b64decode(d["result"]["content"][0]["data"]))' "$WORK/sheet.png"
  ok "pr_capture frames contact sheet (saved $WORK/sheet.png)"
else
  bad "pr_capture frames" "$R"
fi

# ---------- more edits: tracks, effects, trim/move/delete ----------
R="$(tool pr_sequence "{\"command\":\"addTracks\",\"sequenceId\":\"$SEQ\",\"video\":1,\"audio\":1}")"
[ "$(echo "$R" | is_error)" = "False" ] && ok "pr_sequence addTracks (QE): $(echo "$R" | field "str(r['videoTracks'])+' video, '+str(r['audioTracks'])+' audio'")" || bad "pr_sequence addTracks" "$R"

R="$(tool pr_effects '{"command":"list","kind":"transition","match":"dissolve"}')"
echo "$R" | grep -q "Cross Dissolve" && ok "pr_effects list finds Cross Dissolve" || bad "pr_effects list" "$R"
R="$(tool pr_effects "{\"command\":\"transition\",\"sequenceId\":\"$SEQ\",\"items\":[{\"nodeId\":\"$CARD_CLIP\",\"duration\":0.5}]}")"
[ "$(echo "$R" | field "len(r['errors'])")" = "0" ] && ok "pr_effects transition on the card (QE)" || bad "pr_effects transition" "$R"
R="$(tool pr_effects "{\"command\":\"add\",\"sequenceId\":\"$SEQ\",\"items\":[{\"nodeId\":\"$BARS_CLIP\",\"name\":\"Gaussian Blur\"}]}")"
if [ "$(echo "$R" | field "len(r['errors'])")" = "0" ]; then
  K="$(tool pr_query "{\"command\":\"propertyKeys\",\"sequenceId\":\"$SEQ\",\"nodeId\":\"$BARS_CLIP\"}" | field "[c['name'] for c in r['components']]")"
  echo "$K" | grep -q "Gaussian Blur" && ok "pr_effects add Gaussian Blur shows up on the clip" || bad "Gaussian Blur on clip" "$K"
  R="$(tool pr_effects "{\"command\":\"params\",\"sequenceId\":\"$SEQ\",\"items\":[{\"nodeId\":\"$BARS_CLIP\",\"component\":\"Gaussian Blur\",\"param\":\"Amount\",\"value\":20}]}")"
  [ "$(echo "$R" | field "r['applied'][0]['value']")" = "20" ] || [ "$(echo "$R" | field "r['applied'][0]['value']")" = "20.0" ] \
    && ok "pr_effects params sets the blur Amount to 20 (26.0 Gaussian Blur is AE.Impact_Blur_FX; its strength is Amount)" || bad "pr_effects params" "$R"
else
  bad "pr_effects add" "$R"
fi

R="$(tool pr_clips "{\"command\":\"trim\",\"sequenceId\":\"$SEQ\",\"items\":[{\"nodeId\":\"$CARD_CLIP\",\"end\":3.5}]}")"
[ "$(echo "$R" | field "r['applied'][0]['end']['frame']")" = "105" ] && ok "pr_clips trim end to 3.5 s (frame 105)" || bad "pr_clips trim" "$R"
R="$(tool pr_clips "{\"command\":\"move\",\"sequenceId\":\"$SEQ\",\"items\":[{\"nodeId\":\"$CARD_CLIP\",\"to\":2}]}")"
[ "$(echo "$R" | field "r['applied'][0]['start']['frame']")" = "60" ] && ok "pr_clips move start to 2 s (frame 60)" || bad "pr_clips move" "$R"
R="$(tool pr_clips "{\"command\":\"lift\",\"sequenceId\":\"$SEQ\",\"items\":[{\"nodeId\":\"$CARD_CLIP\"},{\"nodeId\":\"no-such-clip\"}]}")"
[ "$(echo "$R" | field "(len(r['applied']), r['errors'][0]['code'])")" = "(1, 'unknown_clip')" ] && ok "pr_clips lift: one removed, one unknown_clip" || bad "pr_clips lift" "$R"

R="$(tool pr_diagnostics '{"command":"problems"}')"
[ "$(echo "$R" | field "len(r['offline'])")" = "0" ] && ok "pr_diagnostics problems: no offline media" || bad "pr_diagnostics problems" "$R"

# ---------- timeline export and render ----------
R="$(tool pr_timeline "{\"command\":\"export\",\"sequenceId\":\"$SEQ\",\"path\":\"$WORK/live-check.xml\"}")"
grep -q "<xmeml" "$WORK/live-check.xml" 2>/dev/null && ok "pr_timeline export wrote xmeml" || bad "pr_timeline export" "$R"

PRESET="$(tool pr_render '{"command":"presets","match":"4E49434B_48323634/01 - Match Source - High"}' | field "r['presets'][0]")"
if [ -n "$PRESET" ]; then
  tool pr_sequence "{\"command\":\"setInOut\",\"sequenceId\":\"$SEQ\",\"inPoint\":0,\"outPoint\":1}" >/dev/null
  R="$(tool pr_render "{\"command\":\"direct\",\"sequenceId\":\"$SEQ\",\"path\":\"$WORK/render-1s.mp4\",\"preset\":\"$PRESET\",\"range\":\"inOut\"}")"
  DUR="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$WORK/render-1s.mp4" 2>/dev/null)"
  python3 -c "import sys; sys.exit(0 if 0.9 <= float(sys.argv[1] or 0) <= 1.1 else 1)" "$DUR" \
    && ok "pr_render direct wrote a ${DUR}s H.264 file (in/out was 1 s)" || bad "pr_render direct" "duration '$DUR': $R"
  R="$(tool pr_render "{\"command\":\"queue\",\"sequenceId\":\"$SEQ\",\"path\":\"$WORK/render-queue.mp4\",\"preset\":\"$PRESET\",\"range\":\"inOut\"}")"
  JOB="$(echo "$R" | field "r['jobId']")"
  [ -n "$JOB" ] && ok "pr_render queue handed job $JOB to Media Encoder" || bad "pr_render queue" "$R"
  QDUR=""
  for _ in $(seq 60); do
    QDUR="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$WORK/render-queue.mp4" 2>/dev/null)"
    [ -n "$QDUR" ] && break; sleep 2
  done
  R="$(tool pr_render "{\"command\":\"status\",\"jobId\":\"$JOB\",\"path\":\"$WORK/render-queue.mp4\"}")"
  [ -n "$QDUR" ] && ok "Media Encoder finished the queued job: ${QDUR}s file, status $(echo "$R" | field "r['state']")" \
    || bad "pr_render queue output" "no readable file after 120 s; status $R"
else
  bad "pr_render presets" "no H.264 Match Source preset found"
fi

# ---------- the FCP7 XML probe ----------
python3 - "$WORK" <<'PY'
import sys, urllib.parse, pathlib
work = pathlib.Path(sys.argv[1])
url = lambda p: 'file://localhost' + urllib.parse.quote(str(work / p))
rate = '<rate><timebase>30</timebase><ntsc>FALSE</ntsc></rate>'
vfmt = '<samplecharacteristics>' + rate + '<width>1920</width><height>1080</height><pixelaspectratio>square</pixelaspectratio></samplecharacteristics>'
def vfile(fid, name, dur):
    return f'<file id="{fid}"><name>{name}</name><pathurl>{url(name)}</pathurl>{rate}<duration>{dur}</duration><media><video>{vfmt}</video></media></file>'
xml = f'''<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
<sequence id="probe-seq">
  <name>xmeml-probe</name><duration>240</duration>{rate}
  <media>
    <video>
      <format>{vfmt}</format>
      <track>
        <clipitem id="bars-a"><name>bars.mp4</name><duration>300</duration>{rate}<start>0</start><end>-1</end><in>0</in><out>135</out>{vfile("f-bars", "bars.mp4", 300)}</clipitem>
        <transitionitem>{rate}<start>105</start><end>135</end><alignment>center</alignment>
          <effect><name>Cross Dissolve</name><effectid>Cross Dissolve</effectid><effectcategory>Dissolve</effectcategory><effecttype>transition</effecttype><mediatype>video</mediatype></effect>
        </transitionitem>
        <clipitem id="bars-b"><name>bars.mp4</name><duration>300</duration>{rate}<start>-1</start><end>240</end><in>150</in><out>270</out><file id="f-bars"/></clipitem>
      </track>
      <track>
        <clipitem id="card"><name>card.png</name><duration>18000</duration>{rate}<start>30</start><end>180</end><in>0</in><out>150</out>{vfile("f-card", "card.png", 18000)}
          <filter><effect><name>Basic Motion</name><effectid>basic</effectid><effectcategory>motion</effectcategory><effecttype>motion</effecttype><mediatype>video</mediatype>
            <parameter><parameterid>scale</parameterid><name>Scale</name><valuemin>0</valuemin><valuemax>1000</valuemax>
              <keyframe><when>0</when><value>50</value></keyframe><keyframe><when>150</when><value>80</value></keyframe>
            </parameter>
          </effect></filter>
        </clipitem>
      </track>
    </video>
    <audio>
      <track>
        <clipitem id="tone"><name>tone.wav</name><duration>300</duration>{rate}<start>0</start><end>240</end><in>0</in><out>240</out>
          <file id="f-tone"><name>tone.wav</name><pathurl>{url("tone.wav")}</pathurl>{rate}<duration>300</duration><media><audio><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics><channelcount>2</channelcount></audio></media></file>
          <sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack>
          <filter><effect><name>Audio Levels</name><effectid>audiolevels</effectid><effectcategory>audiolevels</effectcategory><effecttype>audiolevels</effecttype><mediatype>audio</mediatype>
            <parameter><parameterid>level</parameterid><name>Level</name><valuemin>0</valuemin><valuemax>3.98109</valuemax>
              <keyframe><when>0</when><value>0</value></keyframe><keyframe><when>30</when><value>1</value></keyframe>
            </parameter>
          </effect></filter>
        </clipitem>
      </track>
    </audio>
  </media>
  <marker><name>probe-marker</name><comment>from the xmeml</comment><in>60</in><out>-1</out></marker>
</sequence>
</xmeml>
'''
(work / 'xmeml-probe.xml').write_text(xml)
PY
ok "xmeml probe written ($WORK/xmeml-probe.xml)"

R="$(tool pr_timeline "{\"command\":\"import\",\"path\":\"$WORK/xmeml-probe.xml\"}")"
PSEQ="$(echo "$R" | field "r['sequences'][0]['sequenceId']")"
if [ -z "$PSEQ" ]; then
  bad "pr_timeline import of the probe" "$R"
else
  ok "pr_timeline import: probe arrived as sequence $PSEQ"
  R="$(tool pr_query "{\"command\":\"tree\",\"sequenceId\":\"$PSEQ\"}")"
  echo "        imported clips: $(echo "$R" | field "[(c['track'],c['name'],c['start']['frame'],c['end']['frame']) for t in r['tracks'] for c in t['clips']]")"
  # Capture a sequence that is NOT active: the bridge must switch to it (openSequence) and switch back.
  tool pr_sequence "{\"command\":\"activate\",\"sequenceId\":\"$PSEQ\"}" >/dev/null
  BEFORE="$(tool pr_query '{"command":"sessionInfo"}' | field "r['active']['activeSequence']")"
  R="$(tool pr_capture "{\"command\":\"frame\",\"sequenceId\":\"$SEQ\",\"time\":0.5,\"longEdge\":256}")"
  AFTER="$(tool pr_query '{"command":"sessionInfo"}' | field "r['active']['activeSequence']")"
  [ "$BEFORE" = "$PSEQ" ] && [ "$AFTER" = "$PSEQ" ] && echo "$R" | grep -q '"type":"image"' \
    && ok "capture of an inactive sequence switched to it and back (active stayed $PSEQ)" \
    || bad "sequence switch and restore" "before=$BEFORE after=$AFTER"
  tool pr_timeline "{\"command\":\"export\",\"sequenceId\":\"$PSEQ\",\"path\":\"$WORK/xmeml-probe-roundtrip.xml\"}" >/dev/null
  RT="$WORK/xmeml-probe-roundtrip.xml"
  echo "  FCP7 XML probe (from Premiere's own re-export, $RT):"
  python3 - "$RT" <<'PY2'
import sys, xml.etree.ElementTree as ET
try:
    seq = ET.parse(sys.argv[1]).getroot().find('.//sequence')
except Exception as e:
    print('  LOST      everything: no readable re-export (%s)' % e); sys.exit(0)
v = seq.findall('./media/video/track'); a = seq.findall('./media/audio/track')
clips = seq.findall('.//clipitem')
card = [c for c in clips if (c.findtext('name') or '').startswith('card')]
def span(c):
    try: return int(c.findtext('end')) - int(c.findtext('start'))
    except Exception: return None
def keys(c, pid):
    return [k for p in c.iter('parameter') if (p.findtext('parameterid') or '').lower() == pid for k in p.findall('keyframe')]
tone = [c for c in clips if (c.findtext('name') or '').startswith('tone')]
checks = [
    ('two video tracks', len([t for t in v if t.find('clipitem') is not None]) >= 2),
    ('one audio track with the tone', bool(tone)),
    ('still with a 150-frame duration', bool(card) and span(card[0]) == 150),
    ('cross dissolve', any('dissolve' in (e.findtext('name') or '').lower() for e in seq.iter('effect')
                           if (e.findtext('effecttype') or '') == 'transition')),
    ('marker', any(m.findtext('name') == 'probe-marker' for m in seq.iter('marker'))),
    ('Motion scale keyframes (2)', bool(card) and len(keys(card[0], 'scale')) >= 2),
    ('audio level keyframes (2)', any(len(keys(c, 'level')) >= 2 for c in tone)),
]
for name, kept in checks:
    print('  %s  %s' % ('SURVIVED' if kept else 'LOST    ', name))
PY2
  echo "        (each LOST line should be confirmed by eye in the imported sequence)"
fi

R="$(tool pr_project '{"command":"close","save":true}')"
[ "$(echo "$R" | is_error)" = "False" ] && ok "scratch project saved and closed" || bad "pr_project close" "$R"

R="$(tool pr_project "{\"command\":\"open\",\"path\":\"$WORK/scratch.prproj\"}")"
N="$(tool pr_query '{"command":"sessionInfo"}' | field "len(r['active']['sequences']) if r['active'] and r['active']['ownedByBridge'] else -1")"
[ "${N:-0}" -ge 2 ] && ok "pr_project open of the saved scratch project: owned, $N sequences" || bad "pr_project open" "$R / sequences=$N"
tool pr_project '{"command":"close"}' >/dev/null

done_
