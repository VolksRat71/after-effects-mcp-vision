const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createToolRegistry } = require('../../cep/server/tools.js');

/*
 * keysPath: tracker output read from disk. Routing 87,641 vertices through the
 * agent's tool-call arguments was ~0.9 MB and several hundred thousand tokens,
 * so the roto agent only built two short windows of a 693-frame clip.
 */
function capture() {
  const calls = [];
  const reg = createToolRegistry(async (op, args) => { calls.push({ op, args }); return { ok: true, result: { ok: 1 } }; });
  return { reg, calls };
}
function file(obj) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'keys-')), 'k.json');
  fs.writeFileSync(f, JSON.stringify(obj));
  return f;
}
const tri = [[0, 0], [10, 0], [10, 10]];
const run = async (args) => { const { reg, calls } = capture(); const r = await reg.callTool('ae_masks', { command: 'setPathKeys', layerId: 1, ...args }); return { r, calls }; };

test('an array of {time, vertices} is passed through, and keysPath never reaches the host', async () => {
  const { calls } = await run({ keysPath: file([{ time: 0, vertices: tri }, { time: 1, vertices: null }]), hold: true });
  assert.deepStrictEqual(calls[0].args.keys, [{ time: 0, vertices: tri }, { time: 1, vertices: null }]);
  assert.strictEqual(calls[0].args.hold, true);
  assert.ok(!('keysPath' in calls[0].args), 'the host should get keys, not a path');
});

test('the roto tracker format works as-is via keysPointer, fps from the file', async () => {
  const f = file({ fps: 24, w: 1920, h: 1080, add: [[tri, null, tri], [null]], sub: [] });
  const { calls } = await run({ keysPath: f, keysPointer: '/add/0' });
  assert.deepStrictEqual(calls[0].args.keys.map((k) => k.time), [0, 1 / 24, 2 / 24]);
  assert.strictEqual(calls[0].args.keys[1].vertices, null);
});

test('{fps, frames} and {keys} shapes are accepted; an explicit fps wins', async () => {
  const a = await run({ keysPath: file({ fps: 30, frames: [tri, tri] }) });
  assert.deepStrictEqual(a.calls[0].args.keys.map((k) => k.time), [0, 1 / 30]);
  const b = await run({ keysPath: file({ fps: 30, frames: [tri, tri] }), fps: 10 });
  assert.deepStrictEqual(b.calls[0].args.keys.map((k) => k.time), [0, 0.1]);
  const c = await run({ keysPath: file({ keys: [{ time: 2, vertices: tri }] }) });
  assert.strictEqual(c.calls[0].args.keys[0].time, 2);
});

test('clear errors: relative path, missing file, bad JSON, bad pointer, no fps', async () => {
  const cases = [
    [{ keysPath: 'relative/k.json' }, /must be absolute/],
    [{ keysPath: path.join(os.tmpdir(), 'no-such-keys.json') }, /no file at/],
    [{ keysPath: (() => { const f = file({}); fs.writeFileSync(f, '{nope'); return f; })() }, /not valid JSON/],
    [{ keysPath: file({ add: [] }), keysPointer: '/add/3' }, /nothing at "3"/],
    [{ keysPath: file([tri, tri]) }, /needs an fps/],
  ];
  for (const [args, re] of cases) {
    const { reg, calls } = capture();
    const r = await reg.callTool('ae_masks', { command: 'setPathKeys', layerId: 1, ...args });
    // What an MCP client receives: an error result carrying the message.
    assert.strictEqual(r.isError, true, `expected an error result for ${JSON.stringify(args)}`);
    assert.match(r.content[0].text, re);
    assert.strictEqual(calls.length, 0, 'a bad keys file must never reach the host');
  }
});

test('inline keys still work exactly as before', async () => {
  const { calls } = await run({ keys: [{ time: 0, vertices: tri }] });
  assert.deepStrictEqual(calls[0].args.keys, [{ time: 0, vertices: tri }]);
});
