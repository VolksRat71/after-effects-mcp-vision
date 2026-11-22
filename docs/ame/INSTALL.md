# Media Encoder: install and troubleshooting

The Media Encoder server is the same CEP extension as the other three. Media
Encoder loads its own copy and runs its own server. It works differently from
the others in one way: it has no ExtendScript of its own, so it needs Premiere
Pro or After Effects open next to it.

| | |
|---|---|
| Media Encoder | 2026 (26.0) or later; written against 26.0.2 |
| Port | `127.0.0.1:8795` (`AME_MCP_PORT` overrides) |
| Token | `~/.ame-mcp-vision/token` (`AME_MCP_TOKEN_DIR` overrides) |
| Panel | none (Media Encoder has no Window > Extensions menu) |
| Boot log | `$TMPDIR/ame-mcp-vision/boot.log` |

## What loads where

Measured on 26.0.2:

1. The extension boots inside Media Encoder as a headless server. Node runs
   and the server binds `127.0.0.1:8795` about 20 seconds after launch.
2. Media Encoder's CEP gives third-party extensions no ExtendScript. Every
   `evalScript` answers "EvalScript error.", and the CEP log says "PlugPlugSetup
   must be called first". It has no AppleScript dictionary either.
3. BridgeTalk from Premiere's (or After Effects') ExtendScript to the target
   `ame` does work, asynchronously: a send returns at once and the answer
   arrives about half a second later.

So the server sends each call to the Premiere or After Effects bridge, whose
host forwards it to Media Encoder through BridgeTalk (the ops `bridgeTalkSend`
and `bridgeTalkResult`, which accept only the target `ame`), and then polls for
the answer. The script Media Encoder runs is `cep/host/ame/ops.jsx`, sent fresh
with every call, so there is nothing to reload.

## The relay requirement

Premiere Pro or After Effects must be open, with its bridge running and a host
that has `bridgeTalkSend`. The server tries Premiere (port 8794, then the older
8793), then After Effects (8791), and remembers the one that worked.
`ame_diagnostics health` names it. A Premiere or After Effects that was already
open before this version was installed has the old host: run `pr_diagnostics
reloadHost` (After Effects: `ae_diagnostics reloadHost`) or restart the app.
Without a relay every call fails with `no_relay`.

## Install

Any of the repo's installs puts the extension where Media Encoder finds it too;
see [../INSTALL.md](../INSTALL.md). For a dev checkout, `npm run install:dev`
links `cep/` into the per-user CEP extensions folder. Quit Media Encoder first:
CEP reads extensions at launch.

## Connect a client

```bash
claude mcp add --transport http --scope user ame-vision http://127.0.0.1:8795/mcp --header "Authorization: Bearer $(cat ~/.ame-mcp-vision/token)"
```

## Optional guards

Read from the environment Media Encoder was started with (on macOS,
`launchctl setenv NAME value`, then restart it):

- `AME_MCP_PROTECTED_DIRS`: folders, separated like `PATH`, that no queued
  output may be written into. Symlinks are resolved.
- `AME_MCP_MIN_FREE_GB`: free space a queue needs on the output disk (default
  15). Below it, `ame_queue` refuses and queues nothing.

## When the server does not answer

1. Is Media Encoder running, and has it been up for 20 seconds or so?
2. `curl -s -H "Authorization: Bearer $(cat ~/.ame-mcp-vision/token)" http://127.0.0.1:8795/health`
   should report `"service":"ame-mcp-vision"`.
3. `"reachable":false` with `no_relay`: open Premiere Pro or After Effects and
   reload its host, as above.
4. `ame_timeout`: the relay is up but Media Encoder did not answer, usually
   because it is still starting.
5. `ame_diagnostics log` shows the last errors and the boot log tail. Anything
   under `cep/server/` needs a Media Encoder restart; `cep/host/ame/ops.jsx`
   takes effect on the next call.
