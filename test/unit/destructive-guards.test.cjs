/*
 * Guards against the two ways this project has destroyed real user work.
 *
 * These assert on source text because the code under test is ExtendScript that
 * only runs inside After Effects. A static check that cannot be fooled is worth
 * more here than no check at all: both bugs below shipped, and both were found
 * by a human noticing their artwork had gone missing.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('integration teardown never deletes items by name', () => {
  const src = read('test/integration/host-suite.jsx');
  // "Solids" is AE's single shared folder for EVERY solid in the project.
  // Deleting it by name wiped the user's background and video plate.
  assert.doesNotMatch(src, /name === "Solids"/,
    'deleting the shared Solids folder destroys solids the suite did not create');
  assert.doesNotMatch(src, /name === "bg"/,
    'deleting by a generic name can hit a user item that happens to share it');
  assert.match(src, /__preExisting/,
    'teardown must remove only items absent from the pre-run snapshot');
});

test('integration teardown skips anything that pre-existed the run', () => {
  const src = read('test/integration/host-suite.jsx');
  assert.match(src, /if \(__preExisting\[it\.id\]\) \{ continue; \}/,
    'the snapshot must actually be consulted in the removal loop');
});

test('every app.open / app.newProject call closes without saving first', () => {
  const lines = read('cep/host/ops-build.jsx').split('\n');
  // Statement lines only - a prose mention inside a comment is not a call.
  const calls = lines
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => /^\s*app\.(open|newProject)\s*\(/.test(line));

  assert.ok(calls.length >= 2, 'expected the new and open branches');

  for (const { line, i } of calls) {
    // Everything runs inside beginSuppressDialogs, which answers a suppressed
    // dialog with its DEFAULT button. For "Save changes?" that default is
    // Save - so discardUnsaved:true silently SAVED over the user's .aep.
    const preceding = lines.slice(Math.max(0, i - 3), i).join('\n');
    assert.match(preceding, /__mcp_closeWithoutSaving\(\)/,
      `${line.trim()} (line ${i + 1}) must be preceded by an explicit discard`);
  }
});

test('the close helper discards rather than saves', () => {
  const src = read('cep/host/util.jsx');
  const fn = src.slice(src.indexOf('function __mcp_closeWithoutSaving'));
  assert.match(fn, /CloseOptions\.DO_NOT_SAVE_CHANGES/);
  assert.doesNotMatch(fn.slice(0, fn.indexOf('}')), /CloseOptions\.SAVE_CHANGES/);
});
