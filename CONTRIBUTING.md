# Contributing

## Layout

```
cep/
  CSXS/manifest.xml   two extensions: headless server + optional status panel
  server.html         headless entry, owns the Node process
  index.html          status panel
  client/             CEP-side JS: evalScript bridge, server startup, panel UI
  server/             MCP protocol, HTTP transport, tool surface, contact sheet
  host/ae/            ExtendScript that runs inside After Effects
  host/ai/            ExtendScript that runs inside Illustrator
  host/pr/            ExtendScript that runs inside Premiere Pro
  host/ame/           ExtendScript for Media Encoder, sent to it by relay (it has no host of its own)
  host/bridgetalk.jsx relay ops shared by the Premiere and After Effects hosts
  host/json-polyfill.jsx  shared by both hosts
test/
  unit/               runs anywhere, gates CI
  integration/        needs a live After Effects
scripts/              lint, dev install (sh + ps1), .zxp packaging
```

The split that matters: **`cep/host/*.jsx` runs inside After Effects on an ES3
engine, everything else runs on CEP's Node.** They are different languages with
the same file extension family, and mixing them up is the easiest mistake to
make here.

## More than one app

The extension is listed for After Effects (`AEFT`), Illustrator (`ILST`) and
Premiere Pro (`PPRO`). Media Encoder (`AME`) runs only a server, with no panel and no
ExtendScript of its own; `profile.relay` makes it send its scripts through Premiere or After Effects.
Each app loads its own copy in its own process, so each runs its own server.
What differs per app is decided in one place, `cep/server/app-profile.js`:
port (8791 / 8792 / 8794; 8793 is left to SAM UI), token folder, service name, tool file (`tools.js` /
`tools-illustrator.js` / `tools-premiere.js`), MCP instructions and doc resources. The manifest gives
each host its own `DispatchInfo`, which is how each app gets its own
`host/<app>/host.jsx` and panel menu name. Everything else - HTTP, auth, the
MCP protocol, the evalScript bridge, the contact sheet - is shared.

After Effects keeps exactly what it had before, so existing configs keep
working. Outside CEP (unit tests) `MCP_HOST_APP` picks the profile, defaulting
to After Effects.

Adding an app: a profile in `app-profile.js`, a `Host` and two `DispatchInfo`
blocks in the manifest, a `cep/host/<app>/` host, a tools file, and docs under
`docs/<app>/`. `test/unit/app-profile.test.cjs` checks the wiring.

## Why it is built this way

The MCP server runs **inside** After Effects, in a headless CEP extension, and
reaches ExtendScript through `CSInterface.evalScript`:

```
MCP client --HTTP--> Node server (headless CEP extension) --evalScript--> ExtendScript --> app.project
```

Each alternative was measured and rejected:

- **`aerender`** can run scripts through an undocumented `-r` flag, but every
  call cold-boots After Effects and it cannot touch the project the user has
  open. The build-look-correct loop goes from seconds to minutes.
- **AppleScript `DoScript`** returns `app.exitCode`, a single integer, not the
  script's result. `evalScript` returns a string, which is the whole reason for
  CEP.
- **The MCP SDK** needs Node 18; CEP 12 ships Node 17.7.2. MCP over HTTP is a
  small JSON-RPC surface, so it is implemented directly, with no `node_modules`.
- **UXP** hosts panels in After Effects but has no public scripting API there
  yet. The host layer sits behind the transport so a future port is not a
  rewrite.

## Dev loop

```bash
npm run install:dev      # macOS   (npm run install:dev:win on Windows)
```

Then restart After Effects. `cep/` is symlinked, so edits are on disk
immediately — but what picks them up depends on which process loads the file:

| Changed | To see it |
|---|---|
| `cep/host/**` | `ae_diagnostics {command: "reloadHost"}`, or restart After Effects |
| `cep/server/**`, `cep/server.html`, `cep/client/{server-boot,start-server,bridge}.js` | Restart After Effects |
| `cep/index.html`, `cep/client/panel.js` | Close and reopen the panel |

The server runs in the **headless** extension, which starts once with After
Effects, so reopening the panel does not reload it. The host is compiled once
per extension start too, which is what `reloadHost` exists to work around —
without it, on-disk source and running behaviour can silently disagree.

## Verifying

```bash
npm run lint             # parse, ES3 dialect, require/#include/manifest resolution
npm test                 # unit tests, no After Effects needed
npm run test:integration # against a live After Effects
./test/verify-live.sh    # against a running extension, nothing stubbed
./test/verify-live-illustrator.sh   # the same, against Illustrator
./test/verify-live-premiere.sh      # the same, against Premiere Pro, plus the FCP7 XML probe
./test/verify-live-ame.sh           # the same, against Media Encoder (needs Premiere or After Effects open as the relay)
```

`npm run lint` and `npm test` gate CI. The integration suite cannot — no hosted
runner has After Effects — so **run it before tagging a release.** It has caught
more real bugs than the unit tests have.

## Writing ExtendScript

`cep/host/*.jsx` is ES3. The linter fails the build on `const`, `let`, arrow
functions and template literals, because the failure mode inside After Effects
is a modal dialog that blocks the whole application, not a stack trace.

Beyond syntax:

- **There is no native `JSON`.** The polyfill is `#include`d; don't assume it.
- **`return` is illegal at top level.** Everything is wrapped in an IIFE.
- **Anything that can throw must be inside a `try`.** An error escaping
  `beginSuppressDialogs` hangs After Effects on a modal until a human clicks OK.
  Suppression wraps serialization and the reply too, not just the work.
- **`evalScript` collapses every failure to `"EvalScript error."`** — the host
  serializes its own errors or they are lost.
- **Don't coerce an Error with `+`.** `"msg: " + e` throws
  *"Object of type Error found where a Number, Array, or Property is needed"*.
  Use `String(e)`.
- **Teardown is manual.** `comp.remove()` orphans solids and leaves an
  auto-created "Solids" folder; undo groups do not revert themselves.

## Adding an op

1. Implement it in the right `cep/host/ae/ops-*.jsx` table. Take stable ids, never
   indices. Don't catch your own errors — `__mcp_exec` handles that uniformly.
2. If it mutates the project, add it to `__mcp_mutating` in `cep/host/ae/ops.jsx`
   so it runs inside an undo group.
3. Expose it through a tool in `cep/server/tools.js`, or as a new `command` on
   an existing one. Prefer widening an existing tool: a few fat tools beat
   many thin ones for a model choosing between them.
4. Write the description for a model that has never seen After Effects. State
   the token cost if the output can be large, and the idiom if there is a wrong
   way to use it.
5. Add an integration case. Batch ops need a case proving partial success —
   some succeed, some fail, and the errors carry machine-readable codes.

## Releasing

```bash
npm run test:integration   # the gate CI cannot provide
npm version <patch|minor|major>
git push --follow-tags
```

The release workflow refuses to build if the tag and `package.json` disagree.
Signing is optional: without `ZXP_CERT_B64` and `ZXP_CERT_PASS` secrets it
produces an unsigned `.zxp` that installs only where `PlayerDebugMode` is set.
