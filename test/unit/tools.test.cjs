const test = require('node:test');
const assert = require('node:assert');
const { createToolRegistry, TOOLS } = require('../../cep/server/tools.js');

function stubHost(responses = {}) {
  const calls = [];
  return {
    calls,
    fn: async (op, args) => {
      calls.push({ op, args });
      if (responses[op]) return responses[op];
      return { ok: true, result: { op, echoed: args } };
    },
  };
}

test('every tool has a name, a description and an object schema', () => {
  for (const t of TOOLS) {
    assert.ok(t.name.startsWith('ae_'), `${t.name} should be ae_-prefixed`);
    assert.ok(t.description.length > 100, `${t.name} description is too thin to guide a model`);
    assert.strictEqual(t.inputSchema.type, 'object');
  }
});

test('the tool surface is the eight documented tools', () => {
  assert.deepStrictEqual(
    TOOLS.map((t) => t.name).sort(),
    ['ae_animate', 'ae_capture', 'ae_diagnostics', 'ae_effects', 'ae_layers', 'ae_masks', 'ae_project', 'ae_query', 'ae_set'],
  );
});

test('descriptions state token cost where an agent can blow a context window', () => {
  const query = TOOLS.find((t) => t.name === 'ae_query');
  assert.match(query.description, /depth/i);
  assert.match(query.description, /thousands of tokens/i);
  const capture = TOOLS.find((t) => t.name === 'ae_capture');
  assert.match(capture.description, /cost scales/i);
});

test('ae_query dispatches the command straight through as a host op', async () => {
  const host = stubHost();
  const reg = createToolRegistry(host.fn);
  await reg.callTool('ae_query', { command: 'sessionInfo' });
  assert.strictEqual(host.calls[0].op, 'sessionInfo');
});

test('ae_set maps to the set op, and expressions to setExpression', async () => {
  const host = stubHost();
  const reg = createToolRegistry(host.fn);
  await reg.callTool('ae_set', { writes: [] });
  await reg.callTool('ae_set', { command: 'expressions', writes: [] });
  assert.deepStrictEqual(host.calls.map((c) => c.op), ['set', 'setExpression']);
});

test('each remaining tool maps to its host op', async () => {
  const host = stubHost();
  const reg = createToolRegistry(host.fn);
  await reg.callTool('ae_animate', {});
  await reg.callTool('ae_layers', {});
  await reg.callTool('ae_effects', {});
  await reg.callTool('ae_project', {});
  await reg.callTool('ae_diagnostics', {});
  await reg.callTool('ae_masks', { command: 'list', layerId: 1 });
  assert.deepStrictEqual(host.calls.map((c) => c.op), ['keyframes', 'layers', 'effects', 'project', 'problems', 'masks']);
});

test('an unknown tool is an isError result rather than a throw', async () => {
  const reg = createToolRegistry(stubHost().fn);
  const res = await reg.callTool('ae_nope', {});
  assert.strictEqual(res.isError, true);
  assert.match(res.content[0].text, /Unknown tool/);
});

test('a host-side failure surfaces its code and message', async () => {
  const host = stubHost({ sessionInfo: { ok: false, error: { code: 'op_failed', message: 'no project' } } });
  const reg = createToolRegistry(host.fn);
  const res = await reg.callTool('ae_query', { command: 'sessionInfo' });
  assert.strictEqual(res.isError, true);
  assert.match(res.content[0].text, /op_failed/);
  assert.match(res.content[0].text, /no project/);
});

test('ae_capture asks for a sandboxed bare filename, never a caller path', async () => {
  const host = stubHost({ capture: { ok: false, error: { code: 'op_failed', message: 'stub' } } });
  const reg = createToolRegistry(host.fn);
  await reg.callTool('ae_capture', { command: 'frame' });
  const sent = host.calls[0].args;
  assert.match(sent.fileName, /^cap\d+\.png$/);
  assert.strictEqual(sent.outPath, undefined);
});

test('ae_capture defaults to a 512px long edge for stills', async () => {
  const host = stubHost({ capture: { ok: false, error: { code: 'x', message: 'y' } } });
  const reg = createToolRegistry(host.fn);
  await reg.callTool('ae_capture', { command: 'frame' });
  assert.strictEqual(host.calls[0].args.longEdge, 512);
});

test('ae_capture isolated routes to captureIsolated', async () => {
  const host = stubHost({ captureIsolated: { ok: false, error: { code: 'x', message: 'y' } } });
  const reg = createToolRegistry(host.fn);
  await reg.callTool('ae_capture', { command: 'isolated', layerId: 5 });
  assert.strictEqual(host.calls[0].op, 'captureIsolated');
  assert.strictEqual(host.calls[0].args.layerId, 5);
});

test('ae_capture sequence uses a smaller per-cell edge than a still', async () => {
  const host = stubHost({ captureSequence: { ok: false, error: { code: 'x', message: 'y' } } });
  const reg = createToolRegistry(host.fn);
  await reg.callTool('ae_capture', { command: 'sequence' });
  assert.strictEqual(host.calls[0].op, 'captureSequence');
  assert.strictEqual(host.calls[0].args.longEdge, 320);
});

test('ae_masks documents that vertices are layer-space, the trap that breaks clipping', () => {
  const masks = TOOLS.find((t) => t.name === 'ae_masks');
  assert.match(masks.description, /LAYER space/);
  assert.match(masks.description, /scal/i, 'must steer callers away from scaling as a fake clip');
});

test('ae_animate applies easing as a second host call, after the keys exist', async () => {
  const host = stubHost();
  const reg = createToolRegistry(host.fn);
  await reg.callTool('ae_animate', {
    layerId: 7, path: ['a', 'b'],
    add: [{ time: 0, value: 1 }],
    ease: { influence: 70, mode: 'both' },
  });
  assert.deepStrictEqual(host.calls.map((c) => c.op), ['keyframes', 'setEase']);
  assert.strictEqual(host.calls[1].args.influence, 70);
});

test('ae_animate skips the easing call when none is requested', async () => {
  const host = stubHost();
  const reg = createToolRegistry(host.fn);
  await reg.callTool('ae_animate', { layerId: 7, path: ['a', 'b'] });
  assert.deepStrictEqual(host.calls.map((c) => c.op), ['keyframes']);
});
