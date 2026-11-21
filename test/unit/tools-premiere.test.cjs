const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createToolRegistry, TOOLS, checkWritePath, listPresets } = require('../../cep/server/tools-premiere.js');

// The smallest complete PNG: header, 1x1 IHDR, one IDAT, IEND.
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082',
  'hex');

function stubHost(responses = {}) {
  const calls = [];
  return {
    calls,
    fn: async (op, args, timeoutMs) => {
      calls.push({ op, args, timeoutMs });
      const r = responses[op];
      if (typeof r === 'function') return r(args);
      if (r) return r;
      return { ok: true, result: { op, echoed: args } };
    },
  };
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pr-tools-'));
const text = (res) => JSON.parse(res.content[res.content.length - 1].text);
const BIG_DISK = { freeBytes: () => 500 * 1024 ** 3 };

test('the tool surface is the twelve documented tools, each with a real description', () => {
  assert.deepStrictEqual(TOOLS.map((t) => t.name).sort(), ['pr_audio', 'pr_capture', 'pr_clips', 'pr_diagnostics',
    'pr_effects', 'pr_markers', 'pr_motion', 'pr_project', 'pr_query', 'pr_render', 'pr_sequence', 'pr_timeline']);
  for (const t of TOOLS) {
    assert.ok(t.description.length > 100, `${t.name} description is too thin to guide a model`);
    assert.strictEqual(t.inputSchema.type, 'object');
  }
});

test('descriptions state the conventions an agent would otherwise get wrong', () => {
  const d = (n) => TOOLS.find((t) => t.name === n).description;
  assert.match(d('pr_clips'), /SECONDS/);
  assert.match(d('pr_clips'), /"V1" is the bottom video track/);
  assert.match(d('pr_motion'), /PIXELS/);
  assert.match(d('pr_audio'), /dB/);
  assert.match(d('pr_query'), /maxItems/);
  assert.match(d('pr_capture'), /cost scales/);
  assert.match(d('pr_effects'), /EXPERIMENTAL/);
  assert.match(d('pr_project'), /not_owned/);
});

test('pr_query sends read commands through and cannot reach a mutating op', async () => {
  const host = stubHost();
  const reg = createToolRegistry(host.fn);
  for (const command of ['sessionInfo', 'tree', 'clip', 'propertyKeys', 'sequencePresets']) {
    await reg.callTool('pr_query', { command });
  }
  assert.deepStrictEqual(host.calls.map((c) => c.op), ['sessionInfo', 'tree', 'clip', 'propertyKeys', 'sequencePresets']);
  for (const command of ['clips', 'project', 'render', 'captureFrame', 'reloadHost']) {
    assert.strictEqual((await reg.callTool('pr_query', { command })).isError, true, `${command} must be refused`);
  }
  assert.strictEqual(host.calls.length, 5);
});

test('each edit tool maps to its host op', async () => {
  const host = stubHost();
  const reg = createToolRegistry(host.fn);
  const pairs = [['pr_sequence', 'sequence'], ['pr_clips', 'clips'], ['pr_audio', 'audio'], ['pr_motion', 'motion'],
    ['pr_markers', 'markers'], ['pr_effects', 'effects'], ['pr_project', 'project']];
  for (const [tool] of pairs) await reg.callTool(tool, { command: 'list', items: [] });
  assert.deepStrictEqual(host.calls.map((c) => c.op), pairs.map((p) => p[1]));
});

test('host errors come back as tool errors and land in the diagnostics log', async () => {
  const host = stubHost({ clips: { ok: false, error: { code: 'not_owned', message: 'not yours' } } });
  const reg = createToolRegistry(host.fn, { bootLog: '/nonexistent/boot.log' });
  const res = await reg.callTool('pr_clips', { command: 'insert', items: [] });
  assert.strictEqual(res.isError, true);
  assert.match(res.content[0].text, /^not_owned: not yours/);
  const log = text(await reg.callTool('pr_diagnostics', { command: 'log' }));
  assert.strictEqual(log.hostErrors[0].code, 'not_owned');
  assert.deepStrictEqual(log.bootLog, []);
});

test('written paths must be absolute and outside every protected folder, symlinks included', () => {
  const root = tmp();
  const archive = path.join(root, 'archive');
  fs.mkdirSync(archive);
  fs.symlinkSync(archive, path.join(root, 'link'));
  const prior = process.env.PREMIERE_MCP_PROTECTED_DIRS;
  process.env.PREMIERE_MCP_PROTECTED_DIRS = ['/nowhere', archive].join(path.delimiter);
  try {
    assert.throws(() => checkWritePath('relative/out.mp4'), /must be an absolute path/);
    assert.throws(() => checkWritePath(path.join(archive, 'out.mp4')), /^Error: protected:/);
    assert.throws(() => checkWritePath(path.join(archive, 'new', 'deeper', 'out.mp4')), /protected/);
    assert.throws(() => checkWritePath(path.join(root, 'link', 'out.mp4')), /protected/, 'a symlink into it is refused');
    assert.throws(() => checkWritePath(path.join(root, 'x', '..', 'archive', 'out.mp4')), /protected/);
    assert.strictEqual(checkWritePath(path.join(root, 'renders', 'out.mp4')), path.join(root, 'renders', 'out.mp4'));
    assert.strictEqual(checkWritePath(path.join(root, 'archive-2', 'out.mp4')), path.join(root, 'archive-2', 'out.mp4'),
      'a sibling whose name starts the same is not inside');
  } finally {
    if (prior === undefined) delete process.env.PREMIERE_MCP_PROTECTED_DIRS; else process.env.PREMIERE_MCP_PROTECTED_DIRS = prior;
  }
});

test('pr_render refuses under the free-disk floor and never reaches Premiere', async () => {
  const dir = tmp();
  const preset = path.join(dir, 'h264.epr');
  fs.writeFileSync(preset, '<preset/>');
  const host = stubHost();
  const reg = createToolRegistry(host.fn, { freeBytes: () => 14.9 * 1024 ** 3 });
  const res = await reg.callTool('pr_render', { command: 'direct', path: path.join(dir, 'out.mp4'), preset });
  assert.strictEqual(res.isError, true);
  assert.match(res.content[0].text, /^low_disk: 14\.9 GiB free/);
  assert.strictEqual(host.calls.length, 0);
});

test('pr_render honours PREMIERE_MCP_MIN_FREE_GB and reports the free space it saw', async () => {
  const dir = tmp();
  const preset = path.join(dir, 'h264.epr');
  fs.writeFileSync(preset, '<preset/>');
  const prior = process.env.PREMIERE_MCP_MIN_FREE_GB;
  process.env.PREMIERE_MCP_MIN_FREE_GB = '10';
  try {
    const host = stubHost();
    const reg = createToolRegistry(host.fn, { freeBytes: () => 12 * 1024 ** 3 });
    const res = await reg.callTool('pr_render', { command: 'queue', path: path.join(dir, 'out.mp4'), preset });
    assert.strictEqual(res.isError, undefined, res.content[0].text);
    assert.strictEqual(text(res).freeGiBBefore, 12);
    assert.strictEqual(host.calls[0].op, 'render');
    assert.strictEqual(host.calls[0].timeoutMs, 60 * 60 * 1000);
  } finally {
    if (prior === undefined) delete process.env.PREMIERE_MCP_MIN_FREE_GB; else process.env.PREMIERE_MCP_MIN_FREE_GB = prior;
  }
});

test('outputs are never replaced without overwrite:true, and a missing preset is refused', async () => {
  const dir = tmp();
  const out = path.join(dir, 'cut-v1.mp4');
  const preset = path.join(dir, 'p.epr');
  fs.writeFileSync(out, 'old');
  fs.writeFileSync(preset, 'p');
  const host = stubHost();
  const reg = createToolRegistry(host.fn, BIG_DISK);
  assert.match((await reg.callTool('pr_render', { command: 'direct', path: out, preset })).content[0].text, /^exists:/);
  assert.match((await reg.callTool('pr_render', { command: 'direct', path: path.join(dir, 'new.mp4'), preset: '/no.epr' })).content[0].text, /^missing_file:/);
  assert.match((await reg.callTool('pr_timeline', { command: 'export', path: out })).content[0].text, /^exists:/);
  assert.match((await reg.callTool('pr_project', { command: 'new', path: out })).content[0].text, /^exists:/);
  assert.strictEqual(host.calls.length, 0);
  await reg.callTool('pr_render', { command: 'direct', path: out, preset, overwrite: true });
  assert.strictEqual(host.calls.length, 1);
});

test('pr_render presets lists .epr files under the preset folders', async () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'H264'));
  fs.writeFileSync(path.join(root, 'H264', 'Match Source - High bitrate.epr'), '');
  fs.writeFileSync(path.join(root, 'H264', 'notes.txt'), '');
  fs.writeFileSync(path.join(root, 'ProRes 422.epr'), '');
  assert.deepStrictEqual(listPresets('h264', 10, [root]).presets, [path.join(root, 'H264', 'Match Source - High bitrate.epr')]);
  const reg = createToolRegistry(stubHost().fn, { presetRoots: [root] });
  assert.strictEqual(text(await reg.callTool('pr_render', { command: 'presets' })).count, 2);
});

test('pr_capture frame waits for the PNG Premiere writes (with or without .png appended) and cleans up', async () => {
  for (const suffix of ['', '.png']) {
    let written = null;
    const host = stubHost({
      captureFrame: (args) => {
        const p = path.join(os.tmpdir(), args.fileName);
        written = p + suffix;
        setTimeout(() => fs.writeFileSync(written, PNG), 30);
        return { ok: true, result: { path: p, fileName: args.fileName, sequenceId: 's', time: { seconds: 2, frame: 60 } } };
      },
    });
    const res = await createToolRegistry(host.fn).callTool('pr_capture', { command: 'frame', sequenceId: 's', time: 2 });
    assert.strictEqual(res.isError, undefined, JSON.stringify(res));
    assert.strictEqual(res.content[0].type, 'image');
    assert.strictEqual(Buffer.from(res.content[0].data, 'base64').equals(PNG), true);
    assert.strictEqual(host.calls[0].args.time, 2);
    assert.match(host.calls[0].args.fileName, /^[A-Za-z0-9._-]+\.png$/);
    assert.strictEqual(fs.existsSync(written), false, 'the capture file is removed');
  }
});

test('pr_capture frames needs times and removes every capture even when the sheet cannot be built', async () => {
  const made = [];
  const host = stubHost({
    captureFrame: (args) => {
      const p = path.join(os.tmpdir(), args.fileName);
      fs.writeFileSync(p, PNG);
      made.push(p);
      return { ok: true, result: { path: p, fileName: args.fileName, time: { seconds: args.time, frame: 0 } } };
    },
  });
  const reg = createToolRegistry(host.fn);
  assert.strictEqual((await reg.callTool('pr_capture', { command: 'frames' })).isError, true);
  // Outside CEP there is no canvas, so building the sheet fails - the captures must still go.
  const res = await reg.callTool('pr_capture', { command: 'frames', times: [0, 1, 2] });
  assert.strictEqual(res.isError, true);
  assert.strictEqual(made.length, 3);
  for (const p of made) assert.strictEqual(fs.existsSync(p), false, `${p} must be removed`);
});

test('pr_diagnostics health reports an unreachable host instead of throwing', async () => {
  const reg = createToolRegistry(async () => ({ ok: false, error: { code: 'evalscript_error', message: 'no host' } }));
  const out = text(await reg.callTool('pr_diagnostics', {}));
  assert.strictEqual(out.hostReachable, false);
  assert.match(out.error, /evalscript_error/);
  assert.ok(out.bridge.version);
});

test('pr_diagnostics reloadHost reports a reload only when the load stamp changed', async () => {
  let stamp = 1;
  const host = stubHost({
    hostInfo: () => ({ ok: true, result: { loadedAt: stamp } }),
    reloadHost: (args) => { assert.match(args.hostPath, /host[\\/]pr[\\/]host\.jsx$/); return { ok: true, result: { loadedAt: stamp, opCount: 9 } }; },
  });
  const reg = createToolRegistry(host.fn);
  assert.strictEqual(text(await reg.callTool('pr_diagnostics', { command: 'reloadHost' })).reloaded, false);
  host.calls.length = 0;
  const bump = stubHost({
    hostInfo: () => ({ ok: true, result: { loadedAt: 1 } }),
    reloadHost: () => ({ ok: true, result: { loadedAt: 2, opCount: 9 } }),
  });
  assert.strictEqual(text(await createToolRegistry(bump.fn).callTool('pr_diagnostics', { command: 'reloadHost' })).reloaded, true);
});
