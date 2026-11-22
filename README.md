<p align="center">
  <img src="doc/readme-img/after-effects-mcp-vision-transparent.png" width="420" alt="After Effects MCP Vision">
</p>

<p align="center">
  An MCP server that lets an AI agent <strong>build</strong> and <strong>see</strong> inside a live Adobe After Effects session.
</p>

---

Most tool integrations let a model change things it cannot look at. This one lets
an agent change your comp, **render a frame, look at the pixels**, and correct
itself. It drives whatever project you have open; it never needs its own.

**Requires After Effects 2022 (22.0) or later**, on macOS or Windows. Earlier
versions cannot work: every layer is addressed by `Layer.id`, which Adobe added
in 22.0.

## Quick start

1. **Install.** Download the `.dmg` (macOS) or `.exe` (Windows) from
   [Releases](../../releases), quit After Effects, and run it. The installer is
   unsigned, so the first run needs one extra step
   ([details](docs/INSTALL.md#first-run-warnings)):
   - **macOS 15+:** System Settings > Privacy & Security > **Open Anyway**, then
     an admin password.
   - **Windows:** at *"Windows protected your PC"*, click **More info**, then
     **Run anyway**.
2. **Open After Effects.** The server starts by itself on `127.0.0.1:8791`,
   about 15 seconds after After Effects finishes loading. No panel needs to be
   open.
3. **Connect your client.** Open **Window > Extensions > AE MCP Vision**, pick
   your client, and copy the config — it has your real token filled in. Or, for
   Claude Code, one command:

   ```bash
   # macOS Terminal, or Git Bash on Windows
   claude mcp add --transport http --scope user ae-vision http://127.0.0.1:8791/mcp --header "Authorization: Bearer $(cat ~/.ae-mcp-vision/token)"
   ```

   ```powershell
   # Windows PowerShell
   claude mcp add --transport http --scope user ae-vision http://127.0.0.1:8791/mcp --header "Authorization: Bearer $(Get-Content ~/.ae-mcp-vision/token)"
   ```

4. **Check it.** Ask your agent to *"run `ae_query` with `sessionInfo`"*. You
   should get your After Effects version back.

## Connecting other clients

The server speaks standard MCP over Streamable HTTP with a bearer token, so it
is not tied to any one model or harness.

| Client | How | |
|---|---|---|
| Claude Code | HTTP, native | one-liner above |
| Claude Desktop | stdio bridge (`mcp-remote`) | [INSTALL.md](docs/INSTALL.md#claude-desktop) |
| Codex CLI, IDE extension, ChatGPT desktop app | HTTP, native, shared `~/.codex/config.toml` | [INSTALL.md](docs/INSTALL.md#codex-and-the-chatgpt-desktop-app) |
| **Anything else** | HTTP if it supports headers, otherwise the stdio bridge | [INSTALL.md](docs/INSTALL.md#any-other-mcp-client) |

ChatGPT connectors added on chatgpt.com cannot be used: they are called from
OpenAI's servers, which cannot reach a server on your machine.

## The tools

Sixteen verb-dispatching tools. Everything is addressed by stable id (`Item.id`,
`Layer.id`) and properties by `matchName` path, so it survives reordering and
works on localized installs.

| Tool | What it does |
|---|---|
| `ae_query` | `sessionInfo`, `tree`, `find`, `propertyKeys`, `propertyValues`, `selection`, `bounds`, and `describe` for a tool's live schema |
| `ae_set` | Batched property and expression writes, with per-item errors |
| `ae_animate` | Add, remove and read keyframes, with easing |
| `ae_layers` | Create, delete, duplicate, rename, reorder, reparent, lock, solo |
| `ae_effects` | List available, apply, remove, inspect parameters |
| `ae_project` | Create comps, import footage, folders, rename, relink, open, save, and collect files for handoff |
| `ae_capture` | **Vision:** one frame, a labelled contact sheet over time, or one layer isolated |
| `ae_masks` | Rect and freeform masks, feather, modes (add, subtract, …), rename, and a whole animated roto path in one call, read from disk if you like |
| `ae_timing` | Layer in/out/start, comp settings, markers |
| `ae_shapes` | Rect, ellipse, polygon, star and path layers; trim paths, repeaters, dashes |
| `ae_compose` | Precompose, track mattes, blend modes, parenting, 3D, cameras |
| `ae_render` | Render to a file, batch outputs, or hand off to Media Encoder |
| `ae_layout` | Measure, align, distribute, stack, pin, fit, stagger — AE has no layout engine |
| `ae_text` | Text animators and range selectors |
| `ae_template` | Essential Graphics — expose properties, export a `.mogrt` |
| `ae_diagnostics` | Missing footage, font substitutions, broken expressions; reload the host |

Mutating calls run inside an undo group, so an agent's whole batch is one Cmd-Z.

## Illustrator

The same extension also runs inside **Adobe Illustrator 2023 (27.0) or later**
(built and measured on 30.8.1). Each app gets its own server, so both can run
at once: Illustrator listens on `127.0.0.1:8792`, keeps its token in
`~/.illustrator-mcp-vision/token`, and shows **Window > Extensions >
Illustrator MCP Vision**. The server starts the first time Illustrator becomes
the active app.

```bash
claude mcp add --transport http --scope user illustrator-vision http://127.0.0.1:8792/mcp --header "Authorization: Bearer $(cat ~/.illustrator-mcp-vision/token)"
```

Ten tools. Items are addressed by `PageItem.uuid`; every position is in points
from the artboard's top-left with y growing down, the numbers the rulers show.

| Tool | What it does |
|---|---|
| `ai_query` | `sessionInfo`, `tree`, `find`, `item`, `selection`, `fonts`, `swatches`, and `describe` |
| `ai_document` | New, open, save, close, switch documents; add, move, resize and remove artboards |
| `ai_create` | Rectangles, ellipses, polygons, stars, lines, bezier paths, point and area text, and placed images (embedded, fitted to a box) |
| `ai_set` | Batched changes with per-item errors: position, size, rotation, paint, opacity, text, path points |
| `ai_items` | Delete, duplicate, group, clipping masks, ungroup, move to layer, stacking order, selection, outline text |
| `ai_layers` | Create, rename, show/hide, lock, reorder, delete layers and sublayers |
| `ai_layout` | Align, distribute and stack - Illustrator's Align panel is not scriptable |
| `ai_capture` | **Vision:** one artboard, every artboard on one contact sheet, a region, or one item isolated |
| `ai_export` | PNG, JPG or SVG from one artboard, without re-pointing the open document |
| `ai_diagnostics` | Missing links, overflowing area text, off-artboard artwork, empty paths; reload the host |

Each call is one undo step. Illustrator docs: [docs/illustrator/INSTALL.md](docs/illustrator/INSTALL.md)
and [docs/illustrator/RECIPES.md](docs/illustrator/RECIPES.md), also served as
`illustrator-vision://install` and `illustrator-vision://recipes`.

## Premiere Pro

The same extension also runs inside **Adobe Premiere Pro 2026 (26.0) or later**
(verified live on 26.0.2: `test/verify-live-premiere.sh` 37/37). Premiere listens on `127.0.0.1:8794`, keeps its token
in `~/.premiere-mcp-vision/token`, and shows **Window > Extensions > Premiere
MCP Vision**. It is ExtendScript through CEP, like the other two apps; a UXP
port is needed before Adobe turns CEP off by default (announced for December
2028).

```bash
claude mcp add --transport http --scope user premiere-vision http://127.0.0.1:8794/mcp --header "Authorization: Bearer $(cat ~/.premiere-mcp-vision/token)"
```

Twelve tools. Project items and timeline clips are addressed by `nodeId`,
sequences by `sequenceId`, tracks by name (`V1`, `A1`). Times are seconds on the
sequence timeline, snapped to its frame grid. The bridge edits only a project it
created or opened (or one explicitly adopted), so it cannot write into work you
have open and unsaved.

| Tool | What it does |
|---|---|
| `pr_query` | `sessionInfo`, `tree` (project panel, or one sequence's tracks and clips), `clip`, `propertyKeys`, `sequencePresets`, `describe` |
| `pr_project` | New, open, adopt, save, save as, close; bins; import media in place; import After Effects comps |
| `pr_sequence` | Create from a preset with no dialog, or from clips; rename, duplicate, in/out, playhead, add tracks |
| `pr_clips` | Batched insert/overwrite at a time (stills get a duration), trim, move, lift, ripple delete, enable, link |
| `pr_audio` | Clip levels in dB, fixed or keyframed (fades, a bed held under narration); track mute |
| `pr_motion` | Position, scale, rotation, anchor and opacity, fixed or keyframed - photo moves in pixels |
| `pr_markers` | Sequence and clip markers, chapter markers included |
| `pr_effects` | Any effect parameter by name; add effects and transitions (experimental, QE) |
| `pr_timeline` | Final Cut Pro 7 XML export and import |
| `pr_render` | List export presets; export directly or through Media Encoder, with a free-disk floor |
| `pr_capture` | **Vision:** one frame, or several times on one contact sheet |
| `pr_diagnostics` | Health, offline media, empty sequences, recent host errors; reload the host |

Two optional environment variables add guards for the server's process:
`PREMIERE_MCP_PROTECTED_DIRS` (folders, separated like `PATH`, that no export,
XML or project file may be written into) and `PREMIERE_MCP_MIN_FREE_GB` (the free
space a render needs, default 15). Premiere docs:
[docs/premiere/INSTALL.md](docs/premiere/INSTALL.md) and
[docs/premiere/RECIPES.md](docs/premiere/RECIPES.md), also served as
`premiere-vision://install` and `premiere-vision://recipes`.

## Media Encoder

The same extension also runs inside **Adobe Media Encoder 2026 (26.0) or later**
as a headless server (no panel) on `127.0.0.1:8795`, with its token in
`~/.ame-mcp-vision/token`. Media Encoder gives extensions no ExtendScript, so
the server reaches it by relay: its scripts go through the Premiere Pro or After
Effects bridge (one of them must be open) and on to Media Encoder over
BridgeTalk. `docs/ame/INSTALL.md` has the measurements behind that.

```bash
claude mcp add --transport http --scope user ame-vision http://127.0.0.1:8795/mcp --header "Authorization: Bearer $(cat ~/.ame-mcp-vision/token)"
```

| Tool | What it does |
|---|---|
| `ame_query` | Session info, formats, export presets, the comp guids in an .aep |
| `ame_queue` | Queue a comp or a file; refuses a comp that reads an expression library (it would render frozen) |
| `ame_batch` | Start, pause, stop, clear the queue |
| `ame_status` | Jobs and batch status; finished files with size and sha256 |
| `ame_diagnostics` | Health (which relay, Media Encoder build), recent errors |

Guards: `AME_MCP_PROTECTED_DIRS` and `AME_MCP_MIN_FREE_GB` (default 15), as for
Premiere. Docs: [docs/ame/INSTALL.md](docs/ame/INSTALL.md) and
[docs/ame/RECIPES.md](docs/ame/RECIPES.md), also served as `ame-vision://install`
and `ame-vision://recipes`. Check a live setup with `test/verify-live-ame.sh`.

## Documentation

| | For |
|---|---|
| [docs/INSTALL.md](docs/INSTALL.md) | Every install path, every client, troubleshooting, uninstalling |
| [docs/RECIPES.md](docs/RECIPES.md) | How to build things: value shapes, measurement traps, ExtendScript hazards |
| [docs/CAPABILITIES.md](docs/CAPABILITIES.md) | A measured pass / fail / needs-review matrix of what AE techniques are reachable |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Dev setup, architecture, testing, releasing |

The first three are also served over MCP as `ae-vision://install`,
`ae-vision://recipes` and `ae-vision://capabilities`, so an agent can read them
without a repo checkout.

## Security

The bearer token is the trust boundary: anything holding it can drive After
Effects as you.

- Listens on `127.0.0.1` only. The token lives in `~/.ae-mcp-vision/token`
  (mode `0600`) and is required on every request.
- The `Host` header is pinned to loopback, which blocks DNS rebinding. Requests
  from web origins are refused, which blocks a web page in your browser from
  reaching it; only the extension's own panel is allowed through.
- `ae_capture` writes only inside an app-owned folder. `ae_project save`
  requires a `.aep`/`.aepx` path and will not overwrite without `overwrite: true`.

## Credits

This project started as a fork of
[Dakkshin/after-effects-mcp](https://github.com/Dakkshin/after-effects-mcp),
which established the idea of driving After Effects from an MCP client. v2
replaced its file-polling transport with a server running inside After Effects,
moved to stable-id addressing, and added `ae_capture`.

## Licence

MIT — see [LICENSE](LICENSE). Copyright (c) 2025 Dakkshin, copyright (c) 2026
Nate Ryan. Both notices travel with every copy, including the installers.
