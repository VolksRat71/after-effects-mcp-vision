## Which file do I download?

| You are on | Download |
|---|---|
| **macOS** | `AE-MCP-Vision-__VERSION__-macOS.dmg` |
| **Windows** | `AE-MCP-Vision-__VERSION__-Windows.exe` |

Requires **After Effects 2022 (22.0) or later.** Quit After Effects before
installing.

The `.zxp` is attached for people who already manage extensions by hand. It is
unsigned and needs `PlayerDebugMode` set manually — see
[INSTALL.md](https://github.com/VolksRat71/after-effects-mcp-vision/blob/main/docs/INSTALL.md#install).

### First run

The installers are **not code-signed**, so your OS objects the first time:

- **macOS 15 and later:** try to open the installer once, then go to
  **System Settings > Privacy & Security**, click **Open Anyway**, confirm, and
  enter an **administrator password**. Right-click > Open no longer works.
- **macOS 14 and earlier:** right-click the installer > **Open**, then **Open**.
- **Windows:** at *"Windows protected your PC"*, click **More info**, then
  **Run anyway**.

### Then

1. Open After Effects. The MCP server starts on its own.
2. Open **Window > Extensions > AE MCP Vision**, pick your client, copy the config.

Works with Claude Code, Claude Desktop, Codex, the ChatGPT desktop app, and any
MCP client that speaks Streamable HTTP or launches stdio servers —
[setup for each](https://github.com/VolksRat71/after-effects-mcp-vision/blob/main/docs/INSTALL.md#connect-a-client).

### Verifying a download

```
shasum -a 256 -c checksums.txt
```
