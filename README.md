<p align="center">
  <img src="doc/readme-img/after-effects-mcp-vision-transparent.png" width="420" alt="After Effects MCP Vision">
</p>

<p align="center">
  An MCP server and CEP extension that lets an AI agent <strong>build</strong> in a live Adobe After Effects or Illustrator session, then <strong>look</strong> at what it made.
</p>

<!-- Demo video goes here. -->

---

Most tool integrations let a model change things it cannot look at. This one lets
an agent change your comp or artboard, **capture it, look at the pixels**, and
correct itself. It drives whatever project or document you have open; it never
needs its own.

**Requires After Effects 2022 (22.0) or later**, or **Illustrator 2023 (27.0)
or later**, on macOS or Windows. Earlier After Effects versions cannot work:
every layer is addressed by `Layer.id`, which Adobe added in 22.0.

## Quick start

1. **Install.** Download the `.dmg` (macOS) or `.exe` (Windows) from
   [Releases](../../releases), quit After Effects and Illustrator, and run it.
   One installer covers both apps. The installer is
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
   your client, and copy the config. It has your real token filled in. Or, for
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

Sixteen verb-dispatching tools for After Effects. Everything is addressed by
stable id (`Item.id`, `Layer.id`) and properties by `matchName` path, so it
survives reordering and works on localized installs.

| Tool | What it does |
|---|---|
| `ae_query` | `sessionInfo`, `tree`, `find`, `propertyKeys`, `propertyValues`, `selection`, `bounds`, `media` for the footage inventory, and `describe` for a tool's live schema |
| `ae_set` | Batched property and expression writes, with per-item errors; effect popups take their menu label |
| `ae_animate` | Add, remove and read keyframes, with easing |
| `ae_layers` | Create, delete, duplicate, rename, reorder, reparent, lock, audio on/off, label, shy, solo |
| `ae_effects` | List available, apply, remove, inspect parameters |
| `ae_project` | Create comps, import footage, folders, rename, relink, open, save, and collect files for handoff |
| `ae_capture` | **Vision:** one frame, a labelled contact sheet over time, or one layer isolated |
| `ae_masks` | Rect and freeform masks, feather, modes (add, subtract, ...), rename, reorder, and a whole animated roto path in one call, read from disk if you like |
| `ae_timing` | Layer in/out/start, comp settings, markers, time remap, motion blur |
| `ae_shapes` | Rect, ellipse, polygon, star and path layers; trim paths, repeaters, dashes |
| `ae_compose` | Precompose, track mattes, blend modes, parenting, 3D, cameras |
| `ae_render` | Render to a file or image sequence, batch outputs, or hand off to Media Encoder; never replaces a file without `overwrite` |
| `ae_layout` | Measure, align, distribute, stack, pin, fit, stagger. AE has no layout engine |
| `ae_text` | Text animators and range selectors |
| `ae_template` | Essential Graphics: expose properties, export a `.mogrt` |
| `ae_diagnostics` | Missing footage, font substitutions, broken expressions; reload the host |

Mutating calls run inside an undo group, so an agent's whole batch is one Cmd-Z.

## Works with

Other programs on the same machine can read footage out of the open After
Effects project and write results back. `ae_query media` lists the footage an
external tool can open, with its source path, size, timing and any
interpretation overrides.

[**sam-ui**](https://github.com/VolksRat71/sam-ui) uses it for a rotoscoping
round trip: open After Effects footage in place in the sam-ui desktop app,
track objects with SAM 2 or SAM 3, and export the result back to a new comp as
animated masks.

To build your own adapter, read [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md),
also served as `ae-vision://integrations`. It covers the endpoints, the token
and origin rules, the footage the round trip supports, and the write-back calls.

## Illustrator

Illustrator support was contributed by Noah Lewis
([@nlewis-knowah](https://github.com/nlewis-knowah)). The same extension runs
inside **Adobe Illustrator 2023 (27.0) or later**. Each app gets its own
server, so both can run at once: Illustrator listens on `127.0.0.1:8792`, keeps
its token in `~/.illustrator-mcp-vision/token`, and shows **Window > Extensions
> Illustrator MCP Vision**. The server starts the first time Illustrator
becomes the active app.

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

Each call is one undo step. Setup for other clients is in
[docs/illustrator/INSTALL.md](docs/illustrator/INSTALL.md).

## Documentation

| | For |
|---|---|
| [docs/INSTALL.md](docs/INSTALL.md) | Every install path, every client, troubleshooting, uninstalling |
| [docs/RECIPES.md](docs/RECIPES.md) | How to build things: value shapes, measurement traps, ExtendScript hazards |
| [docs/CAPABILITIES.md](docs/CAPABILITIES.md) | A measured pass / fail / needs-review matrix of what AE techniques are reachable |
| [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) | Driving the bridge from another program: footage inventory and write-back |
| [docs/illustrator/INSTALL.md](docs/illustrator/INSTALL.md) | Illustrator install, clients and troubleshooting |
| [docs/illustrator/RECIPES.md](docs/illustrator/RECIPES.md) | How to build things in Illustrator |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Dev setup, architecture, testing, releasing |

The After Effects docs are also served over MCP as `ae-vision://install`,
`ae-vision://recipes`, `ae-vision://capabilities` and
`ae-vision://integrations`, and the Illustrator ones as
`illustrator-vision://install` and `illustrator-vision://recipes`, so an agent
can read them without a repo checkout.

## Security

The bearer token is the trust boundary: anything holding it can drive After
Effects or Illustrator as you.

- Listens on `127.0.0.1` only. The tokens live in `~/.ae-mcp-vision/token` and
  `~/.illustrator-mcp-vision/token` (mode `0600`), one per app, and are
  required on every request.
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
moved to stable-id addressing, and added `ae_capture`. Noah Lewis contributed
the Illustrator support in 2.2.0.

## Licence

MIT, see [LICENSE](LICENSE). Copyright (c) 2025 Dakkshin, copyright (c) 2026
Nate Ryan. Both notices travel with every copy, including the installers.
