## Which file do I download?

| You are on | Download | Then |
|---|---|---|
| **macOS** | `AE-MCP-Vision-__VERSION__-macOS.dmg` | Open it, double-click **Install AE MCP Vision** |
| **Windows** | `AE-MCP-Vision-__VERSION__-Windows.exe` | Run it |
| Already use ZXPInstaller | `ae-mcp-vision-__VERSION__.zxp` | Drag onto [ZXPInstaller](https://zxpinstaller.com/) |

**Quit After Effects before installing.** It loads extensions at startup, so installing
underneath a running copy leaves a half-loaded state that looks broken.

No admin rights required. Everything installs into your own user folder.

### Requirements

- **After Effects 22.0 or later.** Earlier versions cannot work: this addresses layers by
  `Layer.id`, which Adobe added in 22.0, and stable ids are the basis of every tool here.
- macOS 10.14+ or Windows 10/11.

### First run

The installers are **not code-signed**, so your operating system will object the first time:

- **macOS:** right-click the installer app and choose **Open**, then **Open** again. After
  that it runs normally. (Double-clicking shows a dead-end "cannot be verified" dialog.)
- **Windows:** SmartScreen shows "Windows protected your PC" — click **More info**, then
  **Run anyway**.

This is expected for unsigned software and is not a warning about this specific download.
If that bothers you, build from source instead — see the README.

### After installing

1. Open After Effects. The MCP server starts on its own.
2. Open **Window > Extensions > AE MCP Vision**.
3. Pick your client tab, press **Copy config**, paste it in.

Supported out of the box: **Claude Code**, **Claude Desktop**, **Codex CLI / Desktop**.

Your access token is stored in `~/.ae-mcp-vision/token` and persists across restarts, so
a config you paste once keeps working.

### Verifying a download

Checksums are attached to this release. On macOS or Linux:

```
shasum -a 256 -c checksums.txt
```
