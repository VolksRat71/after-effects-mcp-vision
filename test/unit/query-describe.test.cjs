const test = require('node:test');
const assert = require('node:assert');
const { createToolRegistry } = require('../../cep/server/tools.js');

/*
 * describe: Claude Code caches tool definitions from session start, and a
 * /mcp reconnect did not refresh them, so an agent found moveToFolder's
 * itemIds and collect's folder only from error messages.
 */
function registry() {
  const calls = [];
  const reg = createToolRegistry(async (op, args) => { calls.push({ op, args }); return { ok: true, result: {} }; });
  return { reg, calls };
}
const body = (r) => JSON.parse(r.content[0].text);

test('describe returns the live schema of one tool without touching the host', async () => {
  const { reg, calls } = registry();
  const out = body(await reg.callTool('ae_query', { command: 'describe', tool: 'ae_masks' }));
  assert.strictEqual(out.name, 'ae_masks');
  assert.ok(out.inputSchema.properties.command.enum.includes('rename'));
  assert.ok('keysPath' in out.inputSchema.properties);
  assert.ok(out.bridge && out.bridge.version, 'carries the bridge version');
  assert.strictEqual(calls.length, 0);
});

test('describe with no tool lists every tool name', async () => {
  const { reg } = registry();
  const out = body(await reg.callTool('ae_query', { command: 'describe' }));
  assert.ok(out.tools.includes('ae_project') && out.tools.includes('ae_render'));
});

test('describe on an unknown tool is an error result naming the real ones', async () => {
  const { reg } = registry();
  const r = await reg.callTool('ae_query', { command: 'describe', tool: 'ae_nope' });
  assert.strictEqual(r.isError, true);
  assert.match(r.content[0].text, /ae_masks/);
});
