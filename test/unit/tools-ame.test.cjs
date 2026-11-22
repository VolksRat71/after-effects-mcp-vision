const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createToolRegistry, TOOLS, expressionLibraries } = require('../../cep/server/tools-ame.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ame-tools-'));
const text = (res) => JSON.parse(res.content[res.content.length - 1].text);
const NO_WAIT = { sleep: async () => {}, freeBytes: () => 500 * 1024 ** 3 };

function stubHost(responses = {}) {
  const calls = [];
  const fn = async (op, args, timeoutMs) => {
    calls.push({ op, args, timeoutMs });
    const r = responses[op];
    if (typeof r === 'function') return r(args);
    if (r) return r;
    return { ok: true, result: { op, started: true, completedBefore: 0, batchStatus: 'stopped', isBatchRunning: false, completed: 0, errors: 0 } };
  };
  fn.lastRelay = () => ({ name: 'premiere', port: 8794 });
  return { calls, fn };
}

/** A scratch dir with a source, a preset and a project. */
function scene(aepText = 'plain project') {
  const dir = tmp();
  const f = (n, c = 'x') => { const p = path.join(dir, n); fs.writeFileSync(p, c); return p; };
  return { dir, src: f('in.mp4'), preset: f('H264.epr'), aep: f('p.aep', aepText), out: path.join(dir, 'out.mp4'), f };
}

test('five tools, each with a real description', () => {
  assert.deepStrictEqual(TOOLS.map((t) => t.name).sort(), ['ame_batch', 'ame_diagnostics', 'ame_query', 'ame_queue', 'ame_status']);
  for (const t of TOOLS) assert.ok(t.description.length > 80, t.name);
  assert.match(TOOLS.find((t) => t.name === 'ame_queue').description, /SAVED \.aep, so save/);
});

test('queueing a file sends the checked paths, starts, and returns a jobId and the relay', async () => {
  const s = scene(); const host = stubHost();
  const reg = createToolRegistry(host.fn, NO_WAIT);
  const r = await reg.callTool('ame_queue', { command: 'file', source: s.src, preset: s.preset, path: s.out });
  assert.notStrictEqual(r.isError, true, JSON.stringify(r));
  const body = text(r);
  assert.match(body.jobId, /^ame-1-/);
  assert.strictEqual(body.started, true);
  assert.deepStrictEqual(body.relay, { name: 'premiere', port: 8794 });
  assert.deepStrictEqual(host.calls.map((c) => c.op), ['queueFile', 'start']);
  assert.strictEqual(host.calls[0].args.outputPath, s.out);
  const none = await reg.callTool('ame_queue', { command: 'file', source: s.src, preset: s.preset, path: path.join(s.dir, 'b.mp4'), start: false });
  assert.strictEqual(text(none).started, false);
});

test('every guard refuses before anything reaches Media Encoder', async () => {
  const s = scene(); const host = stubHost();
  const reg = createToolRegistry(host.fn, NO_WAIT);
  const base = { command: 'file', source: s.src, preset: s.preset, path: s.out };
  const refuse = async (over, re) => {
    const r = await reg.callTool('ame_queue', { ...base, ...over });
    assert.strictEqual(r.isError, true, JSON.stringify(over));
    assert.match(r.content[0].text, re, JSON.stringify(over));
  };
  await refuse({ path: 'relative/out.mp4' }, /^bad_value: path must be an absolute path/);
  await refuse({ path: path.join(s.dir, 'noext') }, /extension/);
  await refuse({ path: s.src }, /^exists:/);
  await refuse({ preset: path.join(s.dir, 'missing.epr') }, /^missing_file: no export preset/);
  await refuse({ source: path.join(s.dir, 'nope.mp4') }, /^missing_file: no source/);
  await refuse({ command: 'comp', projectPath: s.aep }, /^bad_value: guid is required/);
  await refuse({ command: 'comp', projectPath: path.join(s.dir, 'nope.aep'), guid: 'g' }, /^missing_file: no project/);
  await refuse({ command: 'zip' }, /Unknown ame_queue command/);
  assert.strictEqual(host.calls.length, 0);
  // overwrite lifts only the exists guard
  const ok = await reg.callTool('ame_queue', { ...base, path: s.src, overwrite: true, start: false });
  assert.notStrictEqual(ok.isError, true);
});

test('protected folders are honoured from AME_MCP_PROTECTED_DIRS, not the Premiere variable', async () => {
  const s = scene(); const host = stubHost();
  const reg = createToolRegistry(host.fn, NO_WAIT);
  const vault = path.join(s.dir, 'archive'); fs.mkdirSync(vault);
  const args = { command: 'file', source: s.src, preset: s.preset, path: path.join(vault, 'o.mp4') };
  process.env.PREMIERE_MCP_PROTECTED_DIRS = vault;
  try {
    assert.notStrictEqual((await reg.callTool('ame_queue', { ...args, start: false })).isError, true, 'the Premiere variable is not ours');
    process.env.AME_MCP_PROTECTED_DIRS = vault;
    const r = await reg.callTool('ame_queue', args);
    assert.match(r.content[0].text, /^protected: .*\(AME_MCP_PROTECTED_DIRS\)/);
  } finally { delete process.env.PREMIERE_MCP_PROTECTED_DIRS; delete process.env.AME_MCP_PROTECTED_DIRS; }
});

test('low disk refuses, and AME_MCP_MIN_FREE_GB moves the floor', async () => {
  const s = scene(); const host = stubHost();
  const reg = createToolRegistry(host.fn, { sleep: async () => {}, freeBytes: () => 10 * 1024 ** 3 });
  const args = { command: 'file', source: s.src, preset: s.preset, path: s.out };
  const r = await reg.callTool('ame_queue', args);
  assert.match(r.content[0].text, /^low_disk: 10\.0 GiB free .* 15 GiB floor/);
  assert.strictEqual(host.calls.length, 0);
  process.env.AME_MCP_MIN_FREE_GB = '5';
  try { assert.notStrictEqual((await reg.callTool('ame_queue', { ...args, start: false })).isError, true); } finally { delete process.env.AME_MCP_MIN_FREE_GB; }
});

test('a project that reads an expression library is refused by name, and the override queues it', async () => {
  const cases = {
    jsx: 'junk var L=footage("rig-ch1-v1.jsx").sourceData; L.cam(L,time) junk',
    single: "x footage('lib.js').sourceData y",
    json: 'x footage( "data.json" ).sourceData y',
  };
  for (const [kind, content] of Object.entries(cases)) {
    const s = scene(content); const host = stubHost();
    const reg = createToolRegistry(host.fn, NO_WAIT);
    const r = await reg.callTool('ame_queue', { command: 'comp', projectPath: s.aep, guid: 'g', preset: s.preset, path: s.out });
    assert.strictEqual(r.isError, true, kind);
    assert.match(r.content[0].text, /^expression_library:/, kind);
    assert.match(r.content[0].text, new RegExp(content.match(/footage\(\s*["']([^"']+)/)[1].replace('.', '\\.')), kind);
    assert.match(r.content[0].text, /reads a data or script file through footage\(\.\.\.\)\.sourceData/);
    assert.match(r.content[0].text, /headless engine, which returns nothing/);
    assert.match(r.content[0].text, /ae_render/);
    assert.strictEqual(host.calls.length, 0);
    const ok = await reg.callTool('ame_queue', { command: 'comp', projectPath: s.aep, guid: 'g', preset: s.preset, path: s.out, allowExpressionLibrary: true });
    assert.notStrictEqual(ok.isError, true, kind);
    assert.strictEqual(host.calls[0].op, 'queueComp');
  }
  const ev = scene('a $.evalFile(x) b');
  assert.strictEqual(expressionLibraries(ev.aep).evalFile, true);
  assert.match((await createToolRegistry(stubHost().fn, NO_WAIT).callTool('ame_queue', { command: 'comp', projectPath: ev.aep, guid: 'g', preset: ev.preset, path: ev.out })).content[0].text, /\$\.evalFile/);
});

test('a clean project queues a comp with its guid', async () => {
  const s = scene(); const host = stubHost();
  const r = await createToolRegistry(host.fn, NO_WAIT).callTool('ame_queue', { command: 'comp', projectPath: s.aep, guid: 'g1', comp: 'Main', preset: s.preset, path: s.out, format: 'H.264' });
  assert.notStrictEqual(r.isError, true, JSON.stringify(r));
  assert.deepStrictEqual(host.calls[0].args, { projectPath: s.aep, guid: 'g1', format: 'H.264', presetPath: s.preset, outputPath: s.out });
});

test('host failures surface as code: message', async () => {
  const s = scene();
  const host = stubHost({ queueFile: { ok: false, error: { code: 'no_relay', message: 'open Premiere' } } });
  const r = await createToolRegistry(host.fn, NO_WAIT).callTool('ame_queue', { command: 'file', source: s.src, preset: s.preset, path: s.out });
  assert.strictEqual(r.content[0].text, 'no_relay: open Premiere');
  assert.strictEqual(text(await createToolRegistry(host.fn, NO_WAIT).callTool('ame_diagnostics', { command: 'log' })).hostErrors.length, 0);
});

test('ame_batch: start, pause, stop go through; clear needs all:true', async () => {
  const host = stubHost(); const reg = createToolRegistry(host.fn, NO_WAIT);
  for (const command of ['start', 'pause', 'stop']) await reg.callTool('ame_batch', { command });
  assert.deepStrictEqual(host.calls.map((c) => c.op), ['start', 'pause', 'status', 'stop'], 'stop reads the status first');
  const refused = await reg.callTool('ame_batch', { command: 'clear' });
  assert.match(refused.content[0].text, /^needs_all:/);
  assert.strictEqual(host.calls.length, 4);
  await reg.callTool('ame_batch', { command: 'clear', all: true });
  assert.strictEqual(host.calls[4].op, 'clear');
  assert.strictEqual((await reg.callTool('ame_batch', { command: 'explode' })).isError, true);
});

test('ame_query: presets from disk, compItems checks the project, unknown commands refused', async () => {
  const s = scene(); const host = stubHost();
  const reg = createToolRegistry(host.fn, { ...NO_WAIT, presetRoots: [s.dir] });
  const p = text(await reg.callTool('ame_query', { command: 'presets', match: 'h264' }));
  assert.deepStrictEqual(p.presets, [s.preset]);
  await reg.callTool('ame_query', { command: 'compItems', projectPath: s.aep });
  assert.strictEqual(host.calls[0].op, 'compItems');
  assert.match((await reg.callTool('ame_query', { command: 'compItems', projectPath: '/nope.aep' })).content[0].text, /^missing_file/);
  assert.strictEqual((await reg.callTool('ame_query', { command: 'queueFile' })).isError, true);
  assert.strictEqual((await reg.callTool('nope', {})).isError, true);
  assert.strictEqual(text(await reg.callTool('ame_query', { command: 'describe', tool: 'ame_queue' })).name, 'ame_queue');
});

test('status lists jobs by inferred state; finished needs a stable complete file and gives its sha256', async () => {
  const s = scene(); let ame = { batchStatus: 'running', isBatchRunning: true, completed: 0, errors: 0 };
  const host = stubHost({ status: () => ({ ok: true, result: ame }) });
  let growth = null;
  const reg = createToolRegistry(host.fn, { freeBytes: () => 500 * 1024 ** 3, sleep: async () => { if (growth) growth(); } });
  const { jobId } = text(await reg.callTool('ame_queue', { command: 'file', source: s.src, preset: s.preset, path: s.out }));
  let jobs = text(await reg.callTool('ame_status', {})).jobs;
  assert.strictEqual(jobs[0].state, 'queued');
  assert.deepStrictEqual(text(await reg.callTool('ame_status', { command: 'finished' })).finished, []);

  // Media Encoder writes .mov whatever was asked; the real path is found by name.
  const real = path.join(s.dir, 'out.mov'); fs.writeFileSync(real, 'part');
  assert.strictEqual(text(await reg.callTool('ame_status', {})).jobs[0].state, 'encoding');
  growth = () => fs.appendFileSync(real, 'more');
  assert.deepStrictEqual(text(await reg.callTool('ame_status', { command: 'finished' })).finished, [], 'still growing');
  growth = null;
  assert.deepStrictEqual(text(await reg.callTool('ame_status', { command: 'finished' })).finished, [], 'batch running and nothing completed');

  ame = { ...ame, completed: 1 };
  const fin = text(await reg.callTool('ame_status', { command: 'finished' })).finished;
  assert.strictEqual(fin.length, 1);
  assert.strictEqual(fin[0].jobId, jobId);
  assert.strictEqual(fin[0].path, real);
  assert.strictEqual(fin[0].size, fs.statSync(real).size);
  assert.strictEqual(fin[0].sha256, require('node:crypto').createHash('sha256').update(fs.readFileSync(real)).digest('hex'));

  ame = { ...ame, isBatchRunning: false, batchStatus: 'stopped' };
  assert.strictEqual(text(await reg.callTool('ame_status', {})).jobs[0].state, 'done');
  assert.match((await reg.callTool('ame_status', { jobId: 'nope' })).content[0].text, /^unknown_job/);
});

test('failed: no output, batch idle, errors counted; cleared after clear', async () => {
  const s = scene(); let ame = { isBatchRunning: false, batchStatus: 'stopped', completed: 0, errors: 1 };
  const reg = createToolRegistry(stubHost({ status: () => ({ ok: true, result: ame }) }).fn, NO_WAIT);
  await reg.callTool('ame_queue', { command: 'file', source: s.src, preset: s.preset, path: s.out });
  assert.strictEqual(text(await reg.callTool('ame_status', {})).jobs[0].state, 'failed');
  ame = { ...ame, errors: 0 };
  await reg.callTool('ame_batch', { command: 'clear', all: true });
  assert.strictEqual(text(await reg.callTool('ame_status', {})).jobs[0].state, 'cleared');
});

test('diagnostics health reports the relay and build, and says so when nothing answers', async () => {
  const ok = stubHost({ info: { ok: true, result: { buildNumber: '26.0.2.1', batchStatus: 'stopped' } } });
  const h = text(await createToolRegistry(ok.fn, NO_WAIT).callTool('ame_diagnostics', {}));
  assert.strictEqual(h.ameReachable, true);
  assert.strictEqual(h.buildNumber, '26.0.2.1');
  assert.strictEqual(h.relay.name, 'premiere');
  const down = stubHost({ info: { ok: false, error: { code: 'no_relay', message: 'none' } } });
  const reg = createToolRegistry(down.fn, { ...NO_WAIT, bootLog: path.join(tmp(), 'none.log') });
  const d = text(await reg.callTool('ame_diagnostics', { command: 'health' }));
  assert.strictEqual(d.ameReachable, false);
  assert.match(d.error, /no_relay/);
  assert.strictEqual(text(await reg.callTool('ame_diagnostics', { command: 'log' })).hostErrors[0].code, 'no_relay');
});

test('the footage FILE is what is matched, whatever the expression does with it', async () => {
  for (const content of ['x footage("rig.JSON") y', "footage('a b/lib.jsx').text", 'footage("L.js")']) {
    const s = scene(content);
    const r = await createToolRegistry(stubHost().fn, NO_WAIT).callTool('ame_queue', { command: 'comp', projectPath: s.aep, guid: 'g', preset: s.preset, path: s.out });
    assert.match(r.content[0].text, /^expression_library:/, content);
  }
  const clean = scene('footage("clip.mp4").width footage("pic.png")');
  assert.deepStrictEqual(expressionLibraries(clean.aep).files, []);
});

test('a project that cannot be scanned is refused unless the override is given', async () => {
  const s = scene(); const host = stubHost();
  const reg = createToolRegistry(host.fn, NO_WAIT);
  const real = fs.readFileSync;
  fs.readFileSync = function (p, ...rest) { if (p === s.aep) { const e = new Error('too long'); e.code = 'ERR_STRING_TOO_LONG'; throw e; } return real.call(this, p, ...rest); };
  try {
    const r = await reg.callTool('ame_queue', { command: 'comp', projectPath: s.aep, guid: 'g', preset: s.preset, path: s.out });
    assert.match(r.content[0].text, /^expression_library_unchecked: .*ERR_STRING_TOO_LONG/);
    assert.strictEqual(host.calls.length, 0);
    const ok = await reg.callTool('ame_queue', { command: 'comp', projectPath: s.aep, guid: 'g', preset: s.preset, path: s.out, allowExpressionLibrary: true, start: false });
    assert.notStrictEqual(ok.isError, true);
  } finally { fs.readFileSync = real; }
});

test('a start that throws after queueing still returns the job, with the error', async () => {
  const s = scene();
  const host = stubHost({ start: { ok: false, error: { code: 'ame_timeout', message: 'slow' } } });
  const reg = createToolRegistry(host.fn, NO_WAIT);
  const r = await reg.callTool('ame_queue', { command: 'file', source: s.src, preset: s.preset, path: s.out });
  assert.notStrictEqual(r.isError, true);
  const body = text(r);
  assert.strictEqual(body.started, false);
  assert.match(body.startError, /ame_timeout/);
  assert.strictEqual(text(await reg.callTool('ame_status', {})).jobs[0].jobId, body.jobId);
});

test('a file left from before is never the job\'s output, but an overwrite and a new file are', async () => {
  const s = scene(); let ame = { isBatchRunning: false, batchStatus: 'stopped', completed: 0, errors: 0 };
  const reg = createToolRegistry(stubHost({ status: () => ({ ok: true, result: ame }) }).fn, NO_WAIT);
  fs.writeFileSync(s.out, 'old run');
  fs.writeFileSync(path.join(s.dir, 'out.mov'), 'older mov');
  await reg.callTool('ame_queue', { command: 'file', source: s.src, preset: s.preset, path: s.out, overwrite: true, start: false });
  const view = async () => text(await reg.callTool('ame_status', {})).jobs[0];
  assert.strictEqual((await view()).state, 'queued', 'old bytes do not count');
  assert.deepStrictEqual(text(await reg.callTool('ame_status', { command: 'finished' })).finished, []);
  await new Promise((r) => setTimeout(r, 15));
  fs.writeFileSync(s.out, 'new run, different size');
  assert.strictEqual((await view()).state, 'done', 'a changed file at the exact path is the job\'s');
  const t = scene();
  await reg.callTool('ame_queue', { command: 'file', source: t.src, preset: t.preset, path: t.out, start: false });
  fs.writeFileSync(path.join(t.dir, 'out.mov'), 'made after');
  const jobs = text(await reg.callTool('ame_status', {})).jobs;
  assert.strictEqual(jobs[1].outputFile.path, path.join(t.dir, 'out.mov'));
});

test('a stopped batch and a failed encode are not reported as done, and finished skips them', async () => {
  const s = scene(); let ame = { isBatchRunning: true, batchStatus: 'running', completed: 0, errors: 0, lastEncodeSuccess: null };
  const reg = createToolRegistry(stubHost({ status: () => ({ ok: true, result: ame }) }).fn, NO_WAIT);
  await reg.callTool('ame_queue', { command: 'file', source: s.src, preset: s.preset, path: s.out });
  fs.writeFileSync(s.out, 'partial');
  assert.strictEqual(text(await reg.callTool('ame_status', {})).jobs[0].state, 'encoding', 'running means encoding, never done');
  await reg.callTool('ame_batch', { command: 'stop' });
  ame = { ...ame, isBatchRunning: false, batchStatus: 'stopped' };
  assert.strictEqual(text(await reg.callTool('ame_status', {})).jobs[0].state, 'stopped');
  assert.deepStrictEqual(text(await reg.callTool('ame_status', { command: 'finished' })).finished, []);

  const f = scene();
  ame = { isBatchRunning: false, batchStatus: 'stopped', completed: 1, errors: 0, lastEncodeSuccess: false };
  await reg.callTool('ame_queue', { command: 'file', source: f.src, preset: f.preset, path: f.out, start: false });
  fs.writeFileSync(f.out, 'half a file');
  const jobs = text(await reg.callTool('ame_status', {})).jobs;
  assert.strictEqual(jobs[1].state, 'failed');
  assert.deepStrictEqual(text(await reg.callTool('ame_status', { command: 'finished' })).finished, []);
});

test('the job registry keeps the newest 200', async () => {
  const s = scene(); const reg = createToolRegistry(stubHost().fn, NO_WAIT);
  for (let i = 0; i < 205; i++) await reg.callTool('ame_queue', { command: 'file', source: s.src, preset: s.preset, path: path.join(s.dir, `o${i}.mp4`), start: false });
  const jobs = text(await reg.callTool('ame_status', {})).jobs;
  assert.strictEqual(jobs.length, 200);
  assert.ok(jobs[0].output.endsWith('o5.mp4'));
});

test('ame_query has no formats command (sessionInfo carries them)', async () => {
  assert.ok(!TOOLS.find((t) => t.name === 'ame_query').inputSchema.properties.command.enum.includes('formats'));
  assert.strictEqual((await createToolRegistry(stubHost().fn, NO_WAIT).callTool('ame_query', { command: 'formats' })).isError, true);
});
