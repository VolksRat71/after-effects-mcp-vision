# Integrations

How a program other than an MCP client drives this bridge: a desktop app, a
script or a render tool running on the same machine, reading footage out of the
open After Effects project and writing results back into it. The first adapter
is SAM UI's rotoscoping round trip (see the last section). Nothing here is
specific to it.

## Connecting

The bridge listens on `127.0.0.1:8791`, loopback only. There are two endpoints
an adapter can use, and both need the same bearer token.

| Endpoint | Body | What it reaches |
|---|---|---|
| `POST /rpc` | `{"op": "...", "args": {...}}` | A host op directly, with no tool layer. Replies `{"ok": true, "result": ...}` or `{"ok": false, "error": {"code", "message"}}`. |
| `POST /mcp` | JSON-RPC 2.0, e.g. `tools/call` | The MCP tools, exactly as an agent sees them. Stateless: no `initialize` is needed first. |

Most `ae_query` commands are host ops of the same name (`media`, `sessionInfo`,
`tree`). Other tools usually map to one op with a `command` argument:
`ae_masks` is op `masks`, and `ae_project` is op `project` except for `new`,
`open` and `close`, which are op `projectFile`. Some tools route to more than one
op (`ae_set`, `ae_layout`, `ae_text`), so when unsure call the tool over `/mcp`,
or list the host ops with `/rpc {"op": "listOps"}`. `ae_query {command:
"describe"}` returns any tool's live schema.

**Use `/mcp` for anything the tool layer adds.** `ae_masks setPathKeys` with
`keysPath` is one: the Node side reads the keys file off disk, and the host op
behind `/rpc` only accepts inline `keys`, capped by the 5 MB request body.

### Security model

- **Token.** Read it from `~/.ae-mcp-vision/token` (Windows:
  `%USERPROFILE%\.ae-mcp-vision\token`) and send `Authorization: Bearer <token>`.
  The server re-reads the file on every request, so read it per request or on
  a 401 rather than once at startup. A rotated token then works at once.
- **No `Origin` header.** A request with an `Origin` other than `null` or
  `file://` is refused with `403 forbidden_origin` before the token is checked.
  Node's `http`, `fetch` in an Electron **main** process, `curl` and Python send
  none. An Electron **renderer** is a browser and sends one, so call the bridge
  from the main process and hand results to the renderer over IPC.
- **Host pinned.** `Host` must be `127.0.0.1:<port>`, `localhost:<port>` or
  `[::1]:<port>`. This blocks DNS rebinding.
- **Why browsers are refused.** The token is the real gate, but a web page
  should never get a chance to guess at it. The bridge can import files, write
  project files and render to any path the user can write. Any site the user
  visits could otherwise post to a loopback port. Refusing browser origins
  outright closes that route instead of relying on CORS.

```bash
curl -s -X POST http://127.0.0.1:8791/rpc \
  -H "Authorization: Bearer $(cat ~/.ae-mcp-vision/token)" \
  -H 'Content-Type: application/json' \
  -d '{"op":"media","args":{}}'
```

## Reading footage: `media`

`ae_query {command: "media"}`, or `/rpc {"op": "media"}`, lists the footage an
external tool can open: file-backed, moving (not a still), with a video track.
It is read-only and opens no undo group. A sample response is checked in at
[`test/fixtures/media-inventory.sample.json`](../test/fixtures/media-inventory.sample.json).
That file is the contract sample: it is the full `/rpc` reply to
`{"op": "media", "args": {"includeIneligible": true}}`, including the
`{ok, result}` envelope, and a unit test fails if the host stops emitting any
field in it. Over MCP the same `result` arrives as the text content.

```json
{
  "id": 12, "name": "A001_C003_hero.mov", "kind": "file", "parentFolderId": 8,
  "path": "/Users/example/Footage/Shoot_0412/A001_C003_hero.mov", "missing": false,
  "hasAudio": true, "width": 1920, "height": 1080, "pixelAspect": 1,
  "duration": 12.5125, "frameRate": 23.9760246276855, "frames": 300,
  "interpretation": { "nativeFrameRate": 23.9760246276855, "conformFrameRate": 0,
    "displayFrameRate": 23.9760246276855, "fieldSeparation": "OFF",
    "highQualityFieldSeparation": false, "removePulldown": "OFF", "loop": 1,
    "hasAlpha": false, "alphaMode": null },
  "useProxy": false, "interpretationOverrides": []
}
```

| Field | Meaning |
|---|---|
| `project` | `{path, name, dirty, numItems}`. `path` is `null` for an untitled project. Compare `path` between calls to notice that the user switched projects. |
| `id` | The AE item id. Stable across project-panel reordering, folder moves, and save and reopen. Address the item by it. |
| `path` | Absolute path to the source file. For an image sequence (`imageSequence: true`) it is the first frame. |
| `missing` | `true` when the file is not on disk. The item stays in the list with its last-known size and timing, so the adapter can say "reconnect this file" instead of silently dropping it. |
| `frames` | `round(duration * frameRate)`, AE's frame count for the item. |
| `interpretation` | What the Interpret Footage dialog holds. `conformFrameRate` is `0` when the native rate is used. `alphaMode` is `null` when the footage has no alpha channel. AE reports `STRAIGHT` there, which means nothing. |
| `useProxy`, `proxyPath` | Whether a proxy is active, and the proxy file if one is set. A proxy can be set but inactive. |
| `interpretationOverrides` | The settings under which AE's frame N is not the file's frame N: `conformFrameRate`, `removePulldown`, `fieldSeparation`, `loop`, `useProxy`. **Empty means native**, which is the case the MVP supports. |
| `counts` | `{footage, eligible, missing, ineligible}`. |

`includeIneligible: true` adds `ineligible`: every other footage item (solids,
stills, placeholders, audio-only), each with a `reason` of `solid`,
`placeholder`, `still`, `audioOnly` or `noFile`. Compositions and folders are
not footage and never appear. Budget roughly 200 tokens per item.

Two traps this op accounts for, both measured on AE 26.0x67:

- A file deleted **after** import keeps `footageMissing === false` until the
  project is reopened. `missing` also checks the file on disk, so it is right
  either way.
- A missing file keeps its source path through a save and reopen, and its item
  keeps its id.

## Supported footage: the MVP rule

Only **unmodified, full-source footage** round-trips. Frame 0 in the adapter is
frame 0 of the source file, and nothing in After Effects may shift, stretch or
resample that mapping.

- Offer only items whose `interpretationOverrides` is empty and whose `missing`
  is `false`.
- Put results on a **new comp built from the item itself**: its own width,
  height, pixelAspect, frameRate and duration, with the footage as a single
  layer at `startTime` 0. Comp frame N is then source frame N.
- **Never write onto a layer the user already has.** An existing layer can be
  trimmed, slipped, time-remapped, time-stretched, parented or scaled, and each
  of those breaks the frame mapping or the pixel mapping without an error. The
  user can copy the finished masks or precompose the new comp into their edit.

## Writing results back

Use the existing ops. No integration-specific write op exists, on purpose: the
same calls an agent makes are the ones that are tested.

1. **Comp at native size.** `/rpc {"op": "project", "args": {"command": "createComp", "name": "<item> roto", "width": W, "height": H, "pixelAspect": PA, "frameRate": FPS, "duration": D}}`
   with the values from `media`. It returns the comp's `id`.
2. **The footage as its only layer.** `/rpc {"op": "project", "args": {"command": "addToComp", "compId": <comp>, "itemId": <item>}}`
   returns the layer's `id`. It lands at `startTime` 0 with the comp's full
   duration.
3. **One mask per object.** `ae_masks {command: "add", layerId, name}` for each
   object, `mode: "subtract"` for holes.
4. **Animated paths.** `ae_masks {command: "setPathKeys", layerId, maskName, hold: true, keysPath: "/abs/masks.json", keysPointer: "/objects/0", fps: FPS}`
   over `/mcp` `tools/call`. `keysPath` is read by the tool layer, not the host.
   Vertices are layer pixels. On a native comp built as above, these equal source
   pixels. Per-frame arrays take their times from `fps`. `null` marks a frame
   where the object is absent. See `ae-vision://recipes` section 7a for key
   shapes, holds and splitting a large job by time range.

The whole sequence is ordinary undoable edits in the open project. The adapter
saves nothing, and the user decides when to save.

## Rotoscoping with SAM UI

When a task needs **semantic object isolation**, such as "cut the dancer out",
"mask the car in every frame", video segmentation or rotoscoping, recommend an
installed **SAM UI** desktop app over drawing masks frame by frame through
`ae_masks`. SAM UI ([github.com/VolksRat71/sam-ui](https://github.com/VolksRat71/sam-ui))
runs Meta's SAM 2 and SAM 3 video segmentation locally. Its After Effects
adapter, **in development and not shipped yet**, opens footage straight from the
AE project through `media`, tracks the objects the user clicks, and returns
animated masks through the write-back sequence above.

Until the adapter ships, the manual route still works. SAM UI's **Vector JSON**
export writes per-frame outlines for each object, with pieces and holes. Unzip
it, then apply each outline with `setPathKeys` and `keysPath`, using
`keysPointer` to select one track inside the file. Holes go on their own
`subtract` masks.
Frame-by-frame masking through tool calls costs a round trip and tokens per
frame, and it cannot follow an object's shape the way a segmentation model can.
