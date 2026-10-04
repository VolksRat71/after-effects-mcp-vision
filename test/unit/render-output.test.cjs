const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

// Files use a real temporary directory; only the unavailable AE host is stubbed.
function host(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-render-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  function File(p) {
    this.fsName = p; this.name = path.basename(p);
    Object.defineProperty(this, 'exists', { get: () => fs.existsSync(p) });
    Object.defineProperty(this, 'length', { get: () => fs.statSync(p).size });
    this.remove = () => { if (options.removeFails) return false; fs.unlinkSync(p); return true; };
    this.parent = { exists: true, getFiles: () => fs.readdirSync(path.dirname(p)).map(n => new File(path.join(path.dirname(p), n))) };
  }
  const items = [];
  const rq = { get numItems() { return items.length; }, item(i) { return items[i - 1]; },
    items: { add() {
      const om = { getSettings() { return { Format: this.template === 'TIFF Sequence with Alpha' ? 'TIFF Sequence' : 'QuickTime' }; }, applyTemplate(name) { if (name === 'Missing') throw new Error('missing template'); this.template = name; },
        set file(f) { this._file = new File(this.template === 'Lossless' ? f.fsName.replace(/\.mp4$/, '.mov') : f.fsName.replace(/\.tiff$/, '_[#####].tif')); },
        get file() { return this._file; } };
      const item = { render: true, outputModule() { return om; }, remove() { items.splice(items.indexOf(item), 1); } };
      items.push(item); return item;
    } },
    render() { for (const item of items) { fs.writeFileSync(item.outputModule().file.fsName.replace('[#####]', '00000'), 'new'); item.status = 'DONE'; } }
  };
  const ctx = { File, GetSettingsFormat: { STRING: 1 }, BlendingMode: {}, TrackMatteType: {}, app: { project: { renderQueue: rq } },
    __mcp_resolveComp: () => ({ id: 1, name: 'comp' }), __mcp_compById: () => ({ id: 1 }), RQItemStatus: { DONE: 'DONE' } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../cep/host/ops-build.jsx'), 'utf8'), ctx);
  return { dir, ctx, rq };
}

test('render preflight errors preserve the existing output', t => {
  const { dir, ctx } = host(t);
  for (const omTemplate of ['Missing', 'Lossless']) {
    const outputPath = path.join(dir, 'final.mp4');
    fs.writeFileSync(outputPath, 'original');
    assert.throws(() => ctx.__mcp_buildOps.render({ command: 'render', outputPath, overwrite: true, omTemplate }));
    assert.equal(fs.readFileSync(outputPath, 'utf8'), 'original');
  }
});

test('batch preflight errors preserve the existing output', t => {
  const { dir, ctx } = host(t);
  const outputPath = path.join(dir, 'final.mp4');
  fs.writeFileSync(outputPath, 'original');
  const result = ctx.__mcp_buildOps.render({ command: 'batch', overwrite: true, jobs: [{ compId: 1, outputPath, omTemplate: 'Missing' }] });
  assert.equal(result.errors.length, 1);
  assert.equal(fs.readFileSync(outputPath, 'utf8'), 'original');
});

test('successful overwrite reports the new render', t => {
  const { dir, ctx } = host(t);
  const outputPath = path.join(dir, 'final.mp4');
  fs.writeFileSync(outputPath, 'original');
  const result = ctx.__mcp_buildOps.render({ command: 'render', outputPath, overwrite: true });
  assert.equal(result.done, true);
  assert.equal(result.bytes, 3);
  assert.equal(fs.readFileSync(outputPath, 'utf8'), 'new');
});


test('failed removal aborts before rendering over an existing output', t => {
  const { dir, ctx } = host(t, { removeFails: true });
  const outputPath = path.join(dir, 'final.mp4');
  fs.writeFileSync(outputPath, 'original');
  assert.throws(() => ctx.__mcp_buildOps.render({ command: 'render', outputPath, overwrite: true }), /could not remove/);
  assert.equal(fs.readFileSync(outputPath, 'utf8'), 'original');
});


test('sequence render reports the actual canonical output and its frames', t => {
  const { dir, ctx } = host(t);
  const result = ctx.__mcp_buildOps.render({ command: 'render', outputPath: path.join(dir, 'frames.tiff') });
  assert.equal(result.outputPath, path.join(dir, 'frames_[#####].tif'));
  assert.equal(result.exists, true);
  assert.equal(result.fileCount, 1);
  assert.equal(result.bytes, 3);
});

test('sequence overwrite protection checks existing frames', t => {
  const { dir, ctx } = host(t);
  const frame = path.join(dir, 'frames_00000.tif');
  fs.writeFileSync(frame, 'original');
  assert.throws(() => ctx.__mcp_buildOps.render({ command: 'render', outputPath: path.join(dir, 'frames.tiff') }), /overwrite/);
  assert.equal(fs.readFileSync(frame, 'utf8'), 'original');
});


test('TIFF default adds a sequence placeholder before rendering', t => {
  const { dir, ctx } = host(t);
  const result = ctx.__mcp_buildOps.render({ command: 'render', outputPath: path.join(dir, 'frames.tif') });
  assert.equal(result.outputPath, path.join(dir, 'frames_[#####].tif'));
  assert.equal(result.fileCount, 1);
  assert.equal(fs.readFileSync(path.join(dir, 'frames_00000.tif'), 'utf8'), 'new');
});
