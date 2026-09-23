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
   unsigned, so macOS 15+ needs **System Settings > Privacy & Security > Open
   Anyway** and an admin password the first time — [details](docs/INSTALL.md#first-run-warnings).
2. **Open After Effects.** The server starts by itself on `127.0.0.1:8791`
   within a few seconds. No panel needs to be open.
3. **Connect your client.** Open **Window > Extensions > AE MCP Vision**, pick
   your client, and copy the config — it has your real token filled in. Or, for
   Claude Code on macOS, in one line:

   ```bash
   claude mcp add --transport http --scope user ae-vision http://127.0.0.1:8791/mcp \
     --header "Authorization: Bearer $(cat ~/.ae-mcp-vision/token)"
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
| `ae_query` | `sessionInfo`, `tree`, `find`, `propertyKeys`, `propertyValues`, `selection` |
| `ae_set` | Batched property and expression writes, with per-item errors |
| `ae_animate` | Add, remove and read keyframes, with easing |
| `ae_layers` | Create, delete, duplicate, rename, reorder, reparent, lock, solo |
| `ae_effects` | List available, apply, remove, inspect parameters |
| `ae_project` | Create comps, import footage, add to comp, open, save |
| `ae_capture` | **Vision:** one frame, a labelled contact sheet over time, or one layer isolated |
| `ae_masks` | Rectangular and freeform masks, feather |
| `ae_timing` | Layer in/out/start, comp settings, markers |
| `ae_shapes` | Rect, ellipse, polygon, star and path layers; trim paths, repeaters, dashes |
| `ae_compose` | Precompose, track mattes, blend modes, parenting, 3D, cameras |
| `ae_render` | Render to a file, batch outputs, or hand off to Media Encoder |
| `ae_layout` | Measure, align, distribute, stack, pin, fit, stagger — AE has no layout engine |
| `ae_text` | Text animators and range selectors |
| `ae_template` | Essential Graphics — expose properties, export a `.mogrt` |
| `ae_diagnostics` | Missing footage, font substitutions, broken expressions; reload the host |

Mutating calls run inside an undo group, so an agent's whole batch is one Cmd-Z.

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
