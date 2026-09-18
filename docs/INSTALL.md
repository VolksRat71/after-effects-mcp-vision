# Installing

## Requirements

- **After Effects 22.0 or later.** This is a hard floor, not a recommendation. Layers are
  addressed by `Layer.id`, which Adobe added in 22.0, and stable ids are the basis of
  every tool here. There is no fallback for earlier versions.
- macOS 10.14+ or Windows 10/11.
- An MCP client: Claude Code, Claude Desktop, or Codex.

**Quit After Effects before installing.** It reads the extensions folder at startup, so
installing underneath a running copy leaves a half-loaded state that looks like a broken
install rather than a pending one.

## Pick an installer

Everything installs into your own user folder. On **macOS 15 and later**, though,
*launching* an unsigned installer requires an administrator password even though the
install itself does not — see below. The `.zxp` route avoids that entirely and is the
path of least resistance on a modern Mac.

| Platform | File | How |
|---|---|---|
| macOS | `AE-MCP-Vision-<version>-macOS.dmg` | Open, double-click **Install AE MCP Vision** |
| Windows | `AE-MCP-Vision-<version>-Windows.exe` | Run it |
| Either | `ae-mcp-vision-<version>.zxp` | Drag onto [ZXPInstaller](https://zxpinstaller.com/) |

Downloads are on the [Releases page](../../releases).

### The unsigned-software warning

The installers are not code-signed, so your OS will object the first time. This is
expected and is not specific to this download.

- **macOS 15 (Sequoia) and later — this now costs four steps and an admin password.**
  Apple removed the old right-click > Open bypass. You must: (1) try to open it once, so
  macOS records the block; (2) go to **System Settings > Privacy & Security > Security**
  and click **Open Anyway**; (3) click **Open Anyway** again in the confirmation; (4) enter
  an **administrator username and password**.

  If that is more than you want to deal with, **use the `.zxp` instead** — ZXPInstaller is
  itself a notarized app, so the `.zxp` is data it reads rather than code Gatekeeper
  evaluates, and none of the above applies.
- **macOS 14 and earlier:** right-click the app > **Open**, then **Open** in the dialog.
- **Windows:** SmartScreen shows *"Windows protected your PC"*. Click **More info** then
  **Run anyway**. No admin password is required.

Signing certificates that work with Adobe's tooling are, at present, largely unobtainable:
since June 2023 CAs must keep code-signing keys on hardware tokens, while Adobe's
`ZXPSignCmd` requires an exportable `.p12`. [Adobe's own tracking issue][zxp-issue] has
been open since September 2023. Building from source avoids the warning entirely.

[zxp-issue]: https://github.com/Adobe-CEP/CEP-Resources/issues/499

## Connect your client

Open After Effects, then **Window > Extensions > AE MCP Vision**. Pick your client's tab
and press **Copy config**. The panel fills in your real port and token.

Your token lives in `~/.ae-mcp-vision/token` (`%USERPROFILE%\.ae-mcp-vision\token` on
Windows), is readable only by you, and **persists across restarts** — paste a config once
and it keeps working.

### Claude Code

Add to `.mcp.json` in your project, or `~/.claude.json` to have it everywhere:

```json
{
  "mcpServers": {
    "ae-vision": {
      "type": "http",
      "url": "http://127.0.0.1:8791/mcp",
      "headers": { "Authorization": "Bearer <your token>" }
    }
  }
}
```

### Claude Desktop

**Settings > Developer > Edit Config**, add the same block as above, then restart Claude
Desktop.

### Codex CLI / Desktop

Codex uses TOML and reads the token from an environment variable rather than the config
file. Add to `~/.codex/config.toml`:

```toml
[mcp_servers.ae_vision]
url = "http://127.0.0.1:8791/mcp"
bearer_token_env_var = "AE_MCP_TOKEN"
```

Then export the token in your shell profile:

```bash
export AE_MCP_TOKEN="<your token>"
```

## Checking it works

Ask your client to run `ae_query` with `command: "sessionInfo"`. You should get your After
Effects version and a list of compositions.

If you would rather check directly:

```bash
curl -H "Authorization: Bearer $(cat ~/.ae-mcp-vision/token)" \
     http://127.0.0.1:8791/health
```

## If something is wrong

**The panel is not under Window > Extensions.** The extension did not install, or After
Effects was running during installation. Quit After Effects and run the installer again.

**The panel says "nothing listening".** Another process holds port 8791. Set the
`AE_MCP_PORT` environment variable and restart After Effects.

**Your client reports 401.** The token changed — most likely you rotated it. Re-copy the
config from the panel.

**The panel says "host ping failed".** The ExtendScript side did not load. Please
[open an issue](../../issues) with the contents of
`~/.ae-mcp-vision/` and your After Effects version.

**After Effects is frozen.** Something threw where it should not have and a modal dialog
is waiting behind the main window. Click OK, then please report it — that is a real
defect, not expected behaviour.

## Uninstalling

- **macOS:** delete `~/Library/Application Support/Adobe/CEP/extensions/com.aemcpvision.bridge`
- **Windows:** Settings > Apps > **AE MCP Vision** > Uninstall

Then delete `~/.ae-mcp-vision/` to remove your token.
