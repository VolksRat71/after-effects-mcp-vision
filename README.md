<p align="center">
  <img src="doc/readme-img/after-effects-mcp-vision-transparent.png" width="420" alt="After Effects MCP Vision">
</p>

<p align="center">
  An MCP server that lets an AI agent <strong>build</strong> and <strong>see</strong> inside a live Adobe After Effects session.
</p>

---

## What this is

Most tool integrations let a model change things it cannot look at. It edits an
object tree, gets back "ok", and has no idea whether the result is right.

This one closes the loop. An agent can inspect the project, change it, **render
a frame and actually look at the pixels**, then correct itself. As far as I can
tell no other After Effects MCP ships a vision primitive — the one other public
CEP-based Adobe MCP has `get_document_image()` for Photoshop and Premiere, and
nothing for AE.

Requires **After Effects 22.0 or later**, macOS or Windows.

## The tools

Eight verb-dispatching tools rather than one tool per operation. Descriptions
carry workflow guidance and state their token cost, because walk depth and image
size are the two ways an agent burns a context window in here.

| Tool | What it does |
|---|---|
| `ae_query` | `sessionInfo`, `tree`, `find`, `propertyKeys`, `propertyValues`, `selection` |
| `ae_set` | Batched property and expression writes |
| `ae_animate` | Add / remove / read keyframes |
| `ae_layers` | Create, delete, duplicate, rename, reorder, reparent, lock, solo |
| `ae_effects` | List available, apply, remove, inspect parameters |
| `ae_project` | Create comps, import footage, add to comp, save |
| `ae_capture` | **Vision:** one frame, a contact sheet, or an isolated layer |
| `ae_masks` | Rectangular and freeform masks, feather, animated reveals |
| `ae_timing` | Layer in/out/startTime, comp settings, markers |
| `ae_shapes` | Shape layers with real geometry — rect, ellipse, polygon, star, path |
| `ae_compose` | Precompose, track mattes, blend modes, parenting, 3D, cameras |
| `ae_render` | Render to a file, batch N outputs in one pass, or hand off to Media Encoder |
| `ae_layout` | Measure, align, distribute, stack, pin, fit, stagger — AE has no layout engine |
| `ae_text` | Text animators and range selectors — per-character and per-word reveals |
| `ae_template` | Essential Graphics — expose properties, export a `.mogrt` |
| `ae_diagnostics` | Missing footage, font substitutions, broken expressions |

**What it cannot do is documented too.** [CAPABILITIES.md](docs/CAPABILITIES.md) is a
measured matrix of 63 probes run against a live After Effects — 26 pass, 32 fail, 5 need
human review. Layout is the weakest area; shape operators (trim paths, repeaters) and text
animators are absent; shape gradient colours and layer styles are permanently unreachable
through scripting. Regenerate it with `npm run probe`.

### Seeing

`ae_capture` is the point of the project.

- **`frame`** — one still. Defaults to a 512px long edge, which is plenty to
  judge layout, composition, alignment and colour.
- **`sequence`** — N frames across a time range, composited into **one labelled
  contact sheet**. Motion is exactly what a single still cannot show, and one
  sheet costs a fraction of the context that N separate images would.
- **`isolated`** — solos a single layer and captures it alone. This is the tool
  for *"why is this not visible"*: it separates "drawn, but hidden behind
  something" from "not drawn at all", which is near-impossible to work out from
  the object tree.

Captures composite onto mid grey, so a transparent region reads as transparent
instead of being mistaken for a black or white fill.

### Addressing

Everything is addressed by **stable ids** — `Item.id` and `Layer.id`, which
survive reordering and saving — and properties by **matchName path**:

```json
{ "layerId": 42, "path": ["ADBE Transform Group", "ADBE Position"], "value": [320, 180] }
```

`matchName` is stable across After Effects versions and independent of UI
language. This is what makes effects, masks, text animators, shape paths and
layer styles reachable at all, and it is why this works on a localized install.

Writes are batch-shaped and report per-item outcomes:

```json
{ "appliedCount": 1,
  "errors": [ { "index": 1, "code": "unknown_path", "message": "..." },
              { "index": 2, "code": "unknown_id",   "message": "..." } ] }
```

One bad path does not discard the rest of the batch. Every mutating call runs
inside an undo group, so an agent's whole batch is a single Cmd-Z.

## Installing

### From a release

Grab an installer from [Releases](../../releases) — `.dmg` for macOS, `.exe` for Windows,
or the `.zxp` if you already use ZXPInstaller. Quit After Effects first, then run it.

No admin rights needed; everything installs per-user. The installers are unsigned, so
your OS will warn on first run — [INSTALL.md](docs/INSTALL.md) covers that and the client
configuration for Claude Code, Claude Desktop and Codex.

### For development

```bash
git clone https://github.com/VolksRat71/after-effects-mcp-vision.git
cd after-effects-mcp-vision
npm run install:dev     # symlinks cep/ and enables PlayerDebugMode
```

Restart After Effects. The symlink means edits are live, though what counts as
"reload" depends on which half you touched: changes under `cep/client`,
`cep/server` or the HTML need only the panel reopened, while `cep/host` changes
need an After Effects restart, because `ScriptPath` loads once at extension
load. No signing certificate is involved in local development; that is a
release concern only.

### Connecting a client

The panel shows a ready-made config including a **per-launch bearer token**:

```json
{
  "mcpServers": {
    "ae-vision": {
      "type": "http",
      "url": "http://127.0.0.1:8791/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

The token is stored in `~/.ae-mcp-vision/token`, readable only by you, and persists
across restarts — paste a config once and it keeps working. Set `AE_MCP_PORT` to move the
port. Full client setup, including Codex's TOML form, is in
[INSTALL.md](docs/INSTALL.md).

## How it works

```
MCP client  --HTTP-->  Node server        (inside the CEP extension)
                            |
                            |  CSInterface.evalScript
                            v
                       ExtendScript host  (inside After Effects)
                            |
                            v
                       app.project
```

The server runs **inside** After Effects, in a headless CEP extension. That is
the same shape as the Rive and Obsidian MCP servers — the plugin *is* the
server. After Effects must be running; the status panel does not need to be
open.

A few decisions worth explaining, since they all look odd until you know why:

**Why CEP and not `aerender`.** `aerender` is a render-queue executor. It can
run ExtendScript through an undocumented inherited `-r` flag, but every call is
a cold boot of After Effects, and this project never opens or saves a `.aep` —
it drives whatever the user has open. A cold boot per call turns the vision loop
from seconds into minutes.

**Why CEP and not AppleScript.** Measured against After Effects 26.0: `DoScript`
returns `app.exitCode`, a single integer. It cannot carry structured data. The
often-repeated claim that it returns the last evaluated expression comes from
InDesign and does not hold here. `evalScript` genuinely returns a string, and
that is the whole reason for CEP.

**Why no `node_modules`.** CEP 12 ships **Node v17.7.2** — below the Node 18
that `@modelcontextprotocol/sdk` requires. MCP over HTTP is a small, stable
JSON-RPC surface, so it is implemented directly. No SDK, no bundler, no
runtime-version bet, and a 20-file package.

**Why not UXP.** After Effects 2026 does ship UXP, and accepts UXP plugins since
22.5 — but the only After Effects-specific UXP plugin Adobe ships has a 97-byte
stub for `main.js` and a placeholder panel id. It is UI hosting plus an internal
script context, not a public scripting API like Photoshop's. ExtendScript
remains After Effects' scripting surface. The host layer is kept isolated behind
the transport so a future UXP port is not a third rewrite.

## After Effects constraints worth knowing

These were all verified the hard way against After Effects 26.0x67, and they are
encoded in the code so they cannot bite twice.

- **ExtendScript is ES3.** No native `JSON` — a polyfill is injected. No `const`,
  `let`, arrow functions or template literals. `npm run lint` fails the build on
  any of them, because the failure mode inside After Effects is a modal dialog,
  not a stack trace.
- **`return` is illegal at top level.** Every payload is wrapped in an IIFE.
- **An error outside a `try` escapes `beginSuppressDialogs` and hangs After
  Effects on a modal** until a human clicks OK. Suppression wraps serialization
  and the reply too, not just the work.
- **`evalScript` collapses every failure to the literal string
  `"EvalScript error."`**, so the host serializes its own errors or they are
  lost entirely.
- **`saveFrameToPng` is undocumented and writes asynchronously** with no
  callback — it returned in ~0 ms and the file landed after a single 25 ms poll.
  Never trust the return; poll for the file.
- **`comp.resolutionFactor` controls real output pixel dimensions**, so it is the
  cost lever for cheap previews.
- **2D layers expose `ADBE Rotate Z`, not `ADBE Rotation`.**
- **Teardown is not automatic.** `comp.remove()` leaves orphaned solids and an
  auto-created "Solids" folder behind, and an undo group does not revert itself.

## Testing

```bash
npm run lint             # parse, ES3 dialect, require/#include/manifest resolution
npm test                 # unit tests, no After Effects needed
npm run test:integration # 33 cases against a live After Effects
./test/verify-live.sh    # the whole stack against a running extension, nothing stubbed
```

The integration suite builds a scratch comp, exercises every op against real
After Effects APIs, and tears it down. It cannot run in CI — no hosted runner
has After Effects — so it is the manual gate before tagging a release. It has
already earned its keep, catching a reorder that used `moveBefore` in both
directions, a bad layer id reported as `unknown_path`, and the `ADBE Rotate Z`
naming.

## Security

The bearer token is the trust boundary. Anything holding it can drive After
Effects as you — the same model every in-editor MCP server operates under.

- Per-launch token, written `0600`, required on every request.
- `Host` pinned to loopback, which defeats DNS rebinding.
- Any request carrying an `Origin` is refused, which blocks browser CSRF.
- `ae_capture` takes a bare filename matched against `[A-Za-z0-9._-]+\.png` and
  resolved inside one app-owned directory. It previously took an arbitrary path,
  which was an arbitrary file write — anything reaching the port could have
  dropped a file into a Startup script folder, which After Effects auto-executes.
- `ae_project save` requires a `.aep`/`.aepx` path and refuses to overwrite
  without `overwrite: true`.

`import` and `save` take absolute paths deliberately. Footage lives wherever you
keep it; sandboxing those would break the tool rather than secure it.

## Troubleshooting

**Panel is empty or missing from Window > Extensions.** The extension is
unsigned in development and needs `PlayerDebugMode`, which `npm run install:dev`
sets. Restart After Effects after installing.

**`host ping failed` in the panel.** `host.jsx` did not load or `__mcp_exec` is
undefined — usually an ExtendScript syntax error. Run `npm run lint`.

**`nothing listening on 8791`.** Another process holds the port. Set
`AE_MCP_PORT` and reload the panel.

**401 from the MCP client.** The token is regenerated on every server start.
Re-copy it from the panel.

**After Effects is frozen.** Something threw outside a guarded block and there
is a modal dialog waiting behind the main window. Click OK, then file a bug —
that is a real defect, not expected behaviour.

## Licence

MIT — see [LICENSE](LICENSE).
