# Installing

## Requirements

- **After Effects 2022 (22.0) or later.** A hard floor: layers are addressed by
  `Layer.id`, which Adobe added in 22.0.
- macOS or Windows 10/11.
- For Claude Desktop, or any client that needs the stdio bridge: **Node.js 18+**.

## Install

Quit After Effects first. It reads the extensions folder at startup, so an
install underneath a running copy looks broken until the next restart.

| Platform | Download from [Releases](../../releases) | Then |
|---|---|---|
| macOS | `AE-MCP-Vision-<version>-macOS.dmg` | Open it, double-click **Install AE MCP Vision** |
| Windows | `AE-MCP-Vision-<version>-Windows.exe` | Run it |

Both install into your own user folder and turn on `PlayerDebugMode`, which After
Effects requires before it will load an unsigned extension.

**About the `.zxp`.** It is also attached to each release, but it is unsigned.
In testing, Adobe's own installer (`UnifiedPluginInstallerAgent`) hung without
installing it, and even when extracted by hand it only loads once
`PlayerDebugMode` is set — which the `.dmg` and `.exe` do for you and ZXP tools
do not. Use it only if you already know you need it, and set the flag yourself:

```bash
# macOS
for v in 10 11 12 13; do defaults write com.adobe.CSXS.$v PlayerDebugMode 1; done
```

```bat
:: Windows, in Command Prompt
for %v in (10 11 12 13) do reg add HKCU\Software\Adobe\CSXS.%v /v PlayerDebugMode /t REG_SZ /d 1 /f
```

## First-run warnings

The installers are not code-signed, so your OS objects the first time.

- **macOS 15 (Sequoia) and later.** Right-click > Open no longer works. Try to
  open the installer once so macOS records the block, then go to
  **System Settings > Privacy & Security**, click **Open Anyway**, confirm, and
  enter an **administrator password**. The install itself still goes to your
  user folder.
- **macOS 14 and earlier.** Right-click the installer > **Open**, then **Open**.
- **Windows.** SmartScreen shows *"Windows protected your PC"*. Click **More
  info**, then **Run anyway**. No admin password is needed.

A Developer ID certificate would remove this; the release pipeline supports one
but the project does not have one yet.

## Connect a client

Open After Effects first. The server starts on its own and creates your token.

**Your token** is in `~/.ae-mcp-vision/token` on macOS and
`%USERPROFILE%\.ae-mcp-vision\token` on Windows. It persists across restarts, so
a config you set up once keeps working. The easiest way to get a ready-made
config is **Window > Extensions > AE MCP Vision**, which fills in your port and
token for each client below.

In the examples, replace `<token>` with the contents of that file.

### Claude Code

```bash
claude mcp add --transport http --scope user ae-vision http://127.0.0.1:8791/mcp \
  --header "Authorization: Bearer <token>"
```

`--scope user` makes it available in every project; leave it off to add it to
the current project only. On macOS you can write
`$(cat ~/.ae-mcp-vision/token)` in place of `<token>`.

### Claude Desktop

Claude Desktop's config file only launches local (stdio) servers, so it reaches
this HTTP server through [`mcp-remote`](https://github.com/geelen/mcp-remote),
a small bridge run by `npx`. Open **Settings > Developer > Edit Config** and add:

```json
{
  "mcpServers": {
    "ae-vision": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://127.0.0.1:8791/mcp",
               "--header", "Authorization:${AUTH_HEADER}",
               "--transport", "http-only"],
      "env": { "AUTH_HEADER": "Bearer <token>" }
    }
  }
}
```

Then fully quit and reopen Claude Desktop. The token goes in `env` rather than
directly in `args` because some clients, Claude Desktop on Windows among them,
mangle spaces inside arguments.

A custom connector added under **Settings > Connectors** will not work: Claude
reaches connectors from Anthropic's servers, which cannot see your machine.

### Codex and the ChatGPT desktop app

The Codex CLI, the Codex IDE extension and the ChatGPT desktop app share one
config file, `~/.codex/config.toml`. Add:

```toml
[mcp_servers.ae_vision]
url = "http://127.0.0.1:8791/mcp"
http_headers = { Authorization = "Bearer <token>" }
```

Codex asks before running MCP tools unless told otherwise. To let this server's
tools run without a prompt — required for non-interactive `codex exec`, which
cannot ask — add one line to the same table:

```toml
[mcp_servers.ae_vision]
url = "http://127.0.0.1:8791/mcp"
http_headers = { Authorization = "Bearer <token>" }
default_tools_approval_mode = "approve"
```

**Avoid `bearer_token_env_var` here.** It works only when Codex inherits that
environment variable from your shell. The IDE extension and the ChatGPT desktop
app are not launched from a shell, so they send no token and every call fails
with 401 — while `codex mcp list` still reports the server as healthy. The static
header above works everywhere.

ChatGPT connectors added on chatgpt.com cannot be used: they are called from
OpenAI's servers, which cannot reach a server on your machine.

### Any other MCP client

Use your client's "add MCP server" setting with whichever of these it supports.

**If it supports Streamable HTTP with custom headers**, point it directly at the
server:

| Setting | Value |
|---|---|
| Transport | Streamable HTTP |
| URL | `http://127.0.0.1:8791/mcp` |
| Header | `Authorization: Bearer <token>` |
| Auth | None beyond the header — there is no OAuth flow |

**If it only launches local (stdio) servers**, give it the bridge as the command:

```
command:  npx
args:     -y mcp-remote http://127.0.0.1:8791/mcp --header Authorization:${AUTH_HEADER} --transport http-only
env:      AUTH_HEADER=Bearer <token>
```

Most clients that use a JSON `mcpServers` file accept exactly the Claude Desktop
block above.

**What will not work:** anything that runs in a browser tab or on someone else's
server. The server listens only on your own machine and refuses requests from
web origins.

## Check it works

Ask your agent to *"run `ae_query` with `sessionInfo`"* — it should return your
After Effects version and your compositions. Or check directly:

```bash
curl -H "Authorization: Bearer $(cat ~/.ae-mcp-vision/token)" http://127.0.0.1:8791/health
```

## Troubleshooting

**Connection refused, or "nothing listening on 8791".** After Effects is not
running. The server lives inside it, so it exists only while After Effects is
open.

**Windows: After Effects opens but nothing listens on 8791.** Releases before
2.0.3 could not start on Windows at all - the extension computed an invalid
path to its own files. Install 2.0.3 or later.

**The panel says "No server on port 8791" while your client works.** A bug in
2.0.0 that stopped the panel reaching its own server. Install 2.0.1 or later.

**401 Unauthorized.** Your config's token does not match the token file — most
often because `~/.ae-mcp-vision/` was deleted and a new token was created. Copy
the current one in again. (Codex users: see the `bearer_token_env_var` note
above.)

**The panel is missing from Window > Extensions.** The install did not happen, or
After Effects was running during it. Quit After Effects and run the installer
again.

**Port 8791 is taken by something else.** After Effects reads `AE_MCP_PORT` from
its own environment. On macOS, apps opened from the Dock do not see shell
variables, so use `launchctl setenv AE_MCP_PORT 8795` and restart After Effects;
on Windows, set it as a user environment variable. Update your client's URL to
match.

**After Effects is frozen.** A modal dialog is waiting behind the main window.
Click OK, then please [open an issue](../../issues) — that is a bug.

## Uninstalling

- **macOS:** delete
  `~/Library/Application Support/Adobe/CEP/extensions/com.aemcpvision.bridge`
- **Windows:** Settings > Apps > **AE MCP Vision** > Uninstall

Then delete `~/.ae-mcp-vision/` to remove your token, and remove the server from
your client's config.
