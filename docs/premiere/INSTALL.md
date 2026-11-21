# Premiere Pro: install and troubleshooting

The Premiere server is the same CEP extension as the After Effects and
Illustrator ones. Premiere loads its own copy and runs its own server.

| | |
|---|---|
| Premiere Pro | 2026 (26.0) or later; written against 26.0.2 |
| Port | `127.0.0.1:8793` (`PREMIERE_MCP_PORT` overrides) |
| Token | `~/.premiere-mcp-vision/token` (`PREMIERE_MCP_TOKEN_DIR` overrides) |
| Panel | Window > Extensions > Premiere MCP Vision |
| Boot log | `$TMPDIR/premiere-mcp-vision/boot.log` |

## Install

Any of the repo's installs puts the extension where Premiere finds it too; see
[../INSTALL.md](../INSTALL.md). For a dev checkout, `npm run install:dev` links
`cep/` into the per-user CEP extensions folder and sets `PlayerDebugMode` so the
unsigned extension loads. Quit Premiere first: CEP reads extensions at launch.

## Connect a client

```bash
claude mcp add --transport http --scope user premiere-vision http://127.0.0.1:8793/mcp --header "Authorization: Bearer $(cat ~/.premiere-mcp-vision/token)"
```

## Optional guards

Read from the environment Premiere was started with (on macOS,
`launchctl setenv NAME value`, then restart Premiere):

- `PREMIERE_MCP_PROTECTED_DIRS`: folders, separated like `PATH`, that no render,
  XML export or project file may be written into. Symlinks are resolved.
  Importing from them is still allowed, since imports only read.
- `PREMIERE_MCP_MIN_FREE_GB`: free space a render needs on the target disk
  (default 15). Below it, `pr_render` refuses and renders nothing.

## When the server does not answer

1. Is Premiere running? The server lives inside it.
2. `curl -s -H "Authorization: Bearer $(cat ~/.premiere-mcp-vision/token)" http://127.0.0.1:8793/health`
   should report `"service":"premiere-mcp-vision"` and `"reachable":true`.
3. No token file means the headless extension never started. Which start-up
   events Premiere sends a hidden extension is not verified yet; open
   Window > Extensions > Premiere MCP Vision once to start it by hand.
4. Read the boot log above. `pr_diagnostics log` shows the last host errors.
5. After editing `cep/host/pr/*.jsx`, run `pr_diagnostics reloadHost`; anything
   under `cep/server/` needs a Premiere restart.
