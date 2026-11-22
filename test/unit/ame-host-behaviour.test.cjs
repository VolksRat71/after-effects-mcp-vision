/*
 * The Media Encoder ops (cep/host/ame/ops.jsx) under node:vm, with a small fake
 * of Media Encoder's DOM whose events fire the way the measured ones did:
 * no item id on any event, status flips on start and stop. What this proves is
 * the ops' own logic: listeners registered ONCE across calls, the counters,
 * null from addDLToBatch becoming bad_guid, errors serialised. What the real
 * Media Encoder does is checked by test/verify-live-ame.sh.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HOST = path.join(__dirname, '..', '..', 'cep', 'host');
const SRC = ['json-polyfill.jsx', 'ame/ops.jsx'].map((f) => fs.readFileSync(path.join(HOST, f), 'utf8')).join('\n');

function fakeAme() {
  const listeners = [];
  const reg = (obj) => (type, fn) => { listeners.push({ obj, type, fn }); };
  const state = { status: 'stopped', queued: [], calls: [] };
  const eh = { getBatchEncoderStatus: () => state.status, isBatchRunning: () => state.status === 'running',
    getFormatList: () => 'H.264,QuickTime', addEventListener: reg('eh'),
    runBatch() { state.status = 'running'; return true; }, pauseBatch() { state.status = 'paused'; return true; }, stopBatch() { state.status = 'stopped'; return true; } };
  const fe = { addEventListener: reg('fe'),
    getDLItemsAtRoot: () => ['0000005d-0000-0000-0000-000000000000', '00000001-0000-0000-0000-000000000000'],
    addDLToBatch(p, f, preset, guid, out) { state.calls.push(['dl', guid, out]); return guid === 'bad' ? null : {}; },
    addFileToBatch(p, f, preset, out) { state.calls.push(['file', out]); return {}; } };
  const ex = { addEventListener: reg('ex'), encodeSuccess: true, removeAllBatchItems: () => true };
  const fire = (obj, type) => listeners.filter((l) => l.obj === obj && l.type === type).forEach((l) => l.fn({}));
  return { app: { buildNumber: '26.0.2.1', getEncoderHost: () => eh, getFrontend: () => fe, getExporter: () => ex }, listeners, state, fire };
}

/* Media Encoder's engine globals outlive each call; the context stands in for that engine. */
function engine(world) {
  const ctx = { app: world.app };
  ctx.$ = { global: {} };
  vm.createContext(ctx);
  // Each BridgeTalk body is a fresh evaluation, but $.global persists.
  const run = (op, args) => JSON.parse(vm.runInContext(`${SRC}\n__ame_exec(${JSON.stringify(JSON.stringify({ op, args }))});`, ctx));
  return run;
}

test('info reports build, status and the formats', () => {
  const run = engine(fakeAme());
  const r = run('info');
  assert.deepStrictEqual(r.result, { buildNumber: '26.0.2.1', batchStatus: 'stopped', isBatchRunning: false, formats: ['H.264', 'QuickTime'] });
  assert.strictEqual(run('ping').result.appVersion, '26.0.2.1');
});

test('listeners are registered once however many calls run', () => {
  const world = fakeAme();
  const run = engine(world);
  run('status'); run('status'); run('info'); run('queueFile', { filePath: '/a', presetPath: '/p', outputPath: '/o.mp4' });
  const n = world.listeners.length;
  assert.ok(n >= 5);
  run('status');
  assert.strictEqual(world.listeners.length, n);
});

test('events become counters that status returns, across separate calls', () => {
  const world = fakeAme();
  const run = engine(world);
  run('queueFile', { filePath: '/a', presetPath: '/p', outputPath: '/o.mp4' });
  world.fire('fe', 'onItemAddedToBatch');
  run('start'); world.state.status = 'running'; world.fire('eh', 'onBatchEncoderStatusChanged');
  world.fire('ex', 'onItemEncodingStarted'); world.fire('ex', 'onEncodingItemProgressUpdated'); world.fire('ex', 'onEncodingItemProgressUpdated');
  world.fire('ex', 'onEncodeComplete');
  const s = run('status').result;
  assert.strictEqual(s.added, 1); assert.strictEqual(s.started, 1); assert.strictEqual(s.completed, 1);
  assert.strictEqual(s.progressEvents, 2); assert.strictEqual(s.lastEncodeSuccess, true);
  assert.strictEqual(s.isBatchRunning, true); assert.strictEqual(s.recentEvents.length, 6);
});

test('queueFile and queueComp hand over the paths; a null from Media Encoder is a bad_guid', () => {
  const world = fakeAme();
  const run = engine(world);
  assert.strictEqual(run('queueFile', { filePath: '/a', presetPath: '/p', outputPath: '/o.mp4' }).result.queued, true);
  assert.strictEqual(run('queueComp', { projectPath: '/x.aep', guid: 'g1', presetPath: '/p', outputPath: '/c.mov' }).ok, true);
  const bad = run('queueComp', { projectPath: '/x.aep', guid: 'bad', presetPath: '/p', outputPath: '/c.mov' });
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.error.code, 'bad_guid');
  assert.deepStrictEqual(world.state.calls.map((c) => c[0]), ['file', 'dl', 'dl']);
});

test('compItems returns the guids with their numeric item ids', () => {
  const r = engine(fakeAme())('compItems', { projectPath: '/x.aep' }).result;
  assert.deepStrictEqual(r.items.map((i) => i.itemId), [93, 1]);
});

test('batch controls drive the encoder; bad input and unknown ops are serialised errors', () => {
  const world = fakeAme();
  const run = engine(world);
  assert.strictEqual(run('start').result.started, true); assert.strictEqual(world.state.status, 'running');
  run('pause'); assert.strictEqual(world.state.status, 'paused');
  run('stop'); assert.strictEqual(world.state.status, 'stopped');
  assert.strictEqual(run('clear').result.cleared, true);
  assert.strictEqual(run('queueFile', { filePath: '', presetPath: '/p', outputPath: '/o' }).error.code, 'bad_value');
  assert.strictEqual(run('nope').error.code, 'unknown_op');
});

test('a failed listener registration is retried on the next call, not remembered as done', () => {
  const world = fakeAme();
  const fe = world.app.getFrontend;
  let broken = true;
  world.app.getFrontend = () => { if (broken) throw new Error('not ready'); return fe(); };
  const run = engine(world);
  assert.strictEqual(run('status').ok, false);
  broken = false;
  assert.strictEqual(run('status').ok, true);
  assert.ok(world.listeners.length >= 5, 'registered on the retry');
});
