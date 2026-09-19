## Which file do I download?

| You are on | Download | Then |
|---|---|---|
| **macOS** (recommended) | `ae-mcp-vision-__VERSION__.zxp` | Drag onto [ZXPInstaller](https://zxpinstaller.com/) — no security prompts |
| **Windows** | `AE-MCP-Vision-__VERSION__-Windows.exe` | Run it, click through SmartScreen |
| macOS, if you prefer a native installer | `AE-MCP-Vision-__VERSION__-macOS.dmg` | Four Gatekeeper steps and an admin password — see below |

**Quit After Effects before installing.** It loads extensions at startup, so installing
underneath a running copy leaves a half-loaded state that looks broken.

Everything installs into your own user folder. On **macOS 15 and later** you will still
be asked for an administrator password to launch the unsigned installer — the `.zxp` via
[ZXPInstaller](https://zxpinstaller.com/) avoids that and is the smoothest route on a
modern Mac.

### Requirements

- **After Effects 22.0 or later.** Earlier versions cannot work: this addresses layers by
  `Layer.id`, which Adobe added in 22.0, and stable ids are the basis of every tool here.
- macOS 10.14+ or Windows 10/11.

### First run

The installers are **not code-signed**, so your operating system will object the first time:

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
