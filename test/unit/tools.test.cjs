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
    ['ae_animate', 'ae_capture', 'ae_compose', 'ae_diagnostics', 'ae_effects', 'ae_layers',
     'ae_layout', 'ae_masks', 'ae_project', 'ae_query', 'ae_render', 'ae_set', 'ae_shapes',
     'ae_template', 'ae_text', 'ae_timing'],
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

test('the new build tools each map to their host op', async () => {
  const host = stubHost();
  const reg = createToolRegistry(host.fn);
  await reg.callTool('ae_timing', { command: 'setLayer' });
  await reg.callTool('ae_shapes', { command: 'create' });
  await reg.callTool('ae_compose', { command: 'precompose' });
  await reg.callTool('ae_render', { command: 'listTemplates' });
  assert.deepStrictEqual(host.calls.map((c) => c.op), ['timing', 'shapes', 'compose', 'render']);
});

test('render is given a long timeout, since renderQueue.render blocks', async () => {
  const seen = [];
  const reg = createToolRegistry(async (op, args, timeoutMs) => {
    seen.push({ op, timeoutMs });
    return { ok: true, result: {} };
  });
  await reg.callTool('ae_render', { command: 'render', outputPath: '/tmp/x.mov' });
  await reg.callTool('ae_query', { command: 'sessionInfo' });
  assert.ok(seen[0].timeoutMs >= 60000, 'a render must not inherit the default 30s timeout');
  assert.strictEqual(seen[1].timeoutMs, undefined, 'ordinary reads keep the default');
});

test('ae_query exposes bounds, so layout does not have to be guessed', async () => {
  const host = stubHost();
  const reg = createToolRegistry(host.fn);
  await reg.callTool('ae_query', { command: 'bounds', layerId: 3 });
  assert.strictEqual(host.calls[0].op, 'bounds');
  const q = TOOLS.find((t) => t.name === 'ae_query');
  assert.match(q.description, /sourceRectAtTime/);
  assert.match(q.description, /reliable/, 'must warn that a fresh shape layer reports 0x0');
});

test('ae_shapes steers callers away from scaling solids', () => {
  const sh = TOOLS.find((t) => t.name === 'ae_shapes');
  assert.match(sh.description, /Size/);
  assert.match(sh.description, /paths/, 'must promise the matchName paths back');
});

test('ae_render warns that it blocks', () => {
  const r = TOOLS.find((t) => t.name === 'ae_render');
  assert.match(r.description, /BLOCKING/i);
  assert.match(r.description, /template/i, 'format comes from an output module template');
});

test('ae_timing documents that startTime shifts in and out points', () => {
  const t = TOOLS.find((t) => t.name === 'ae_timing');
  assert.match(t.description, /startTime FIRST|shifts both/);
});

test('ae_shapes routes operator commands to shapeOps, create to shapes', async () => {
  const host = stubHost();
  const reg = createToolRegistry(host.fn);
  await reg.callTool('ae_shapes', { command: 'create', kind: 'rect' });
  await reg.callTool('ae_shapes', { command: 'addOperator', layerId: 1, kind: 'trim' });
  await reg.callTool('ae_shapes', { command: 'listOperators', layerId: 1 });
  assert.deepStrictEqual(host.calls.map((c) => c.op), ['shapes', 'shapeOps', 'shapeOps']);
  assert.strictEqual(host.calls[1].args.command, 'add');
  assert.strictEqual(host.calls[2].args.command, 'list');
});

test('ae_project splits lifecycle commands onto projectFile', async () => {
  const host = stubHost();
  const reg = createToolRegistry(host.fn);
  await reg.callTool('ae_project', { command: 'createComp' });
  await reg.callTool('ae_project', { command: 'open', path: '/x.aep' });
  await reg.callTool('ae_project', { command: 'close' });
  assert.deepStrictEqual(host.calls.map((c) => c.op), ['project', 'projectFile', 'projectFile']);
});

test('ae_render warns that AME cannot do alpha', () => {
  const r = TOOLS.find((t) => t.name === 'ae_render');
  assert.match(r.description, /CANNOT export alpha/i);
  assert.match(r.description, /batch/);
});

test('ae_template states which property types are rejected', () => {
  const t = TOOLS.find((t) => t.name === 'ae_template');
  assert.match(t.description, /THREE-dimensional|3D/);
  assert.match(t.description, /canAddToMotionGraphicsTemplate/);
});

test('ae_layers distinguishes point text from wrapping box text', () => {
  const l = TOOLS.find((t) => t.name === 'ae_layers');
  assert.match(l.description, /POINT text/);
  assert.match(l.description, /createBoxText/);
});

test('ae_timing explains that layer motion blur needs the comp switch', () => {
  const t = TOOLS.find((t) => t.name === 'ae_timing');
  assert.match(t.description, /comp/i);
  assert.match(t.description, /readMarkers/);
});

test('ae_text explains the per-letter vs per-word choice, which is the whole point', () => {
  const t = TOOLS.find((t) => t.name === 'ae_text');
  assert.match(t.description, /per-word/);
  assert.match(t.description, /basedOn/);
  assert.match(t.description, /typewriter/i);
});

test('ae_layout dispatches each command to its own host op', async () => {
  const host = stubHost();
  const reg = createToolRegistry(host.fn);
  for (const c of ['measure', 'anchor', 'align', 'distribute', 'stack', 'pin', 'fit', 'stagger']) {
    await reg.callTool('ae_layout', { command: c });
  }
  assert.deepStrictEqual(host.calls.map((x) => x.op),
    ['measure', 'anchor', 'align', 'distribute', 'stack', 'pin', 'fit', 'stagger']);
});

test('ae_layout documents the anchor-jump problem it exists to solve', () => {
  const l = TOOLS.find((t) => t.name === 'ae_layout');
  assert.match(l.description, /WITHOUT the layer moving/);
  assert.match(l.description, /movedBy/);
});

test('ae_layout states that rigged mode does not survive Lottie or Rive', () => {
  const l = TOOLS.find((t) => t.name === 'ae_layout');
  assert.match(l.description, /Lottie/);
  assert.match(l.description, /Rive/);
  assert.match(l.description, /IDEMPOTENT/);
});

test('ae_masks exposes batched roto keys, holds and mask modes', () => {
  const masks = TOOLS.find((t) => t.name === 'ae_masks');
  const p = masks.inputSchema.properties;
  for (const cmd of ['setPathKeys', 'setMode']) assert.ok(p.command.enum.includes(cmd), `missing command ${cmd}`);
  assert.ok(p.keys && p.hold && p.mode && p.maskName, 'keys, hold, mode and maskName must be in the schema');
  assert.ok(p.mode.enum.includes('subtract'), 'subtract is the mode rotos need for holes');
  assert.ok(p.keys.items.properties.vertices.type.includes('null'), 'null vertices must be allowed - they mark empty frames');
  // The description must steer agents off a setPath loop, the thing that cost 4,000 round trips.
  assert.match(masks.description, /setPathKeys/);
  assert.match(masks.description, /hold/);
});

test('a batched masks call gets a longer host timeout than the default', async () => {
  let seenTimeout = null;
  const reg = createToolRegistry(async (op, args, timeoutMs) => { seenTimeout = timeoutMs; return { ok: true, result: {} }; });
  await reg.callTool('ae_masks', { command: 'setPathKeys', layerId: 1, keys: [{ time: 0, vertices: null }] });
  assert.ok(seenTimeout >= 60 * 1000, `masks ran with a ${seenTimeout}ms ceiling`);
});
