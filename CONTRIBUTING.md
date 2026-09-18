# Contributing

## Layout

```
cep/
  CSXS/manifest.xml   two extensions: headless server + optional status panel
  server.html         headless entry, owns the Node process
  index.html          status panel
  client/             CEP-side JS: evalScript bridge, server startup, panel UI
  server/             MCP protocol, HTTP transport, tool surface, contact sheet
  host/               ExtendScript that runs inside After Effects
test/
  unit/               runs anywhere, gates CI
  integration/        needs a live After Effects
scripts/              lint, dev install (sh + ps1), .zxp packaging
```

The split that matters: **`cep/host/*.jsx` runs inside After Effects on an ES3
engine, everything else runs on CEP's Node.** They are different languages with
the same file extension family, and mixing them up is the easiest mistake to
make here.

## Dev loop

```bash
npm run install:dev      # macOS   (npm run install:dev:win on Windows)
```

Then restart After Effects. `cep/` is symlinked, so edits are live — but *how*
live depends on which half you touched:

| Changed | To see it |
|---|---|
| `cep/client/**`, `cep/server/**`, `*.html` | Close and reopen the panel |
| `cep/host/**` | Restart After Effects — `ScriptPath` loads once at extension load |

That second row is why the integration suite `$.evalFile`s the host directly
rather than going through the running extension: it picks up host changes
without a restart.

## Verifying

```bash
npm run lint             # parse, ES3 dialect, require/#include/manifest resolution
npm test                 # unit tests, no After Effects needed
npm run test:integration # against a live After Effects
./test/verify-live.sh    # against a running extension, nothing stubbed
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

1. Implement it in the right `cep/host/ops-*.jsx` table. Take stable ids, never
   indices. Don't catch your own errors — `__mcp_exec` handles that uniformly.
2. If it mutates the project, add it to `__mcp_mutating` in `cep/host/ops.jsx`
   so it runs inside an undo group.
3. Expose it through a tool in `cep/server/tools.js`, or as a new `command` on
   an existing one. Prefer widening an existing tool: eight fat tools beat
   twenty thin ones for a model choosing between them.
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
