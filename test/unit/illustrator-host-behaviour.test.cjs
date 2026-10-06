/*
 * Behaviour tests for the Illustrator ExtendScript host, run under node:vm.
 *
 * The host is ES3 and parses in Node, so the real files load into a sandbox
 * with a handful of fakes standing in for Illustrator's DOM. That reproduces
 * Illustrator's behaviour rather than matching source text: the fake text
 * frame below invalidates earlier text ranges exactly the way Illustrator
 * does, which is the bug that made every font, size and fill read as null.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HOST = path.join(__dirname, '..', '..', 'cep', 'host');
const FILES = ['json-polyfill.jsx', 'ai/util.jsx', 'ai/ops-query.jsx', 'ai/ops-build.jsx', 'ai/ops-mutate.jsx',
  'ai/ops-layout.jsx', 'ai/ops-capture.jsx', 'ai/ops-diagnostics.jsx', 'ai/ops.jsx', 'ai/host.jsx'];

/* A sandbox with the real host loaded and `doc` as the active document. */
function loadHost(doc) {
  const app = {
    documents: doc ? [doc] : [],
    get activeDocument() { return doc; },
    userInteractionLevel: 'DISPLAYALERTS',
    coordinateSystem: 'ARTBOARD',
    version: '30.8.1',
  };
  // No JSON from this realm: the host's `instanceof Array` checks must see
  // arrays made by the sandbox's own JSON, as they would be in ExtendScript.
  const ctx = {
    app,
    UserInteractionLevel: { DONTDISPLAYALERTS: 'DONTDISPLAYALERTS' },
    CoordinateSystem: { DOCUMENTCOORDINATESYSTEM: 'DOCUMENT' },
    TextType: { POINTTEXT: 'TextType.POINTTEXT', AREATEXT: 'TextType.AREATEXT' },
  };
  vm.createContext(ctx);
  for (const f of FILES) {
    // Blank preprocessor lines (#include) rather than remove them, so line
    // numbers in any error still match the file.
    const src = fs.readFileSync(path.join(HOST, f), 'utf8').replace(/^[ \t]*#[a-z]+\b.*$/gim, '');
    vm.runInContext(src, ctx, { filename: f });
  }
  return ctx;
}

const exec = (ctx, op, args) => JSON.parse(ctx.__mcp_exec(JSON.stringify({ op, args: args || {} })));
/* A value rebuilt inside the sandbox, so its arrays are the sandbox's arrays. */
const inside = (ctx, v) => vm.runInContext(`(${JSON.stringify(v)})`, ctx);

/*
 * A point text frame whose textRange getter behaves like Illustrator's: each
 * access returns a fresh range, and attributes taken from an earlier range
 * throw "the value would result in an illegal text range" once a newer one
 * has been asked for. Measured on Illustrator 30.8.1.
 */
function fakeTextFrame() {
  let generation = 0;
  const frame = {
    typename: 'TextFrame', kind: 'TextType.POINTTEXT', contents: '2026', uuid: '9',
    characters: { length: 4 }, lines: [{ characters: { length: 4 } }],
  };
  Object.defineProperty(frame, 'textRange', {
    get() {
      const mine = ++generation;
      const live = () => { if (mine !== generation) throw new Error('the value would result in an illegal text range.'); };
      const attrs = {};
      const define = (name, value) => Object.defineProperty(attrs, name, { get() { live(); return value; } });
      define('size', 151.239);
      define('textFont', { name: 'IBMPlexSans-Bold', family: 'IBM Plex Sans', style: 'Bold' });
      define('autoLeading', true);
      define('tracking', 0);
      define('fillColor', { typename: 'CMYKColor', cyan: 0, magenta: 67.254, yellow: 80.667, black: 0 });
      const para = {};
      Object.defineProperty(para, 'justification', { get() { live(); return 'Justification.LEFT'; } });
      return { characterAttributes: attrs, paragraphAttributes: para };
    },
  });
  return frame;
}

test('text attributes survive Illustrator invalidating earlier text ranges', () => {
  const ctx = loadHost(null);
  const info = ctx.__mcp_textInfo(fakeTextFrame());
  assert.strictEqual(info.size, 151.239);
  assert.strictEqual(info.font, 'IBMPlexSans-Bold');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(info.fill)), { cmyk: [0, 67.254, 80.667, 0] });
  assert.strictEqual(info.justification, 'LEFT');
});

/* Layers whose art may live entirely in sublayers. */
function fakeLayer(name, direct, sublayers = []) {
  const l = { typename: 'Layer', name, pageItems: { length: direct }, layers: sublayers, removed: false,
    locked: false, visible: true, remove() { this.removed = true; } };
  for (const s of sublayers) s.parent = l;
  return l;
}

function fakeDoc(layers) {
  const doc = { typename: 'Document', name: 'Awards.ai', layers, saved: true };
  for (const l of layers) l.parent = doc;
  return doc;
}

test('deleting a layer counts the art in its sublayers', () => {
  const child = fakeLayer('Child', 3);
  const parent = fakeLayer('Parent', 0, [child]);
  const doc = fakeDoc([parent, fakeLayer('Other', 1)]);
  const ctx = loadHost(doc);
  const refused = exec(ctx, 'layers', { command: 'delete', layer: ['Parent'] });
  assert.strictEqual(refused.ok, false);
  assert.match(refused.error.message, /holds 3 items across it and 1 sublayer/);
  assert.strictEqual(parent.removed, false, 'nothing may be removed without deleteContents');
  const done = exec(ctx, 'layers', { command: 'delete', layer: ['Parent'], deleteContents: true });
  assert.strictEqual(done.ok, true);
  assert.strictEqual(parent.removed, true);
});

test('a call pinned to another document is refused before the op runs', () => {
  const child = fakeLayer('Child', 3);
  const parent = fakeLayer('Parent', 0, [child]);
  const doc = fakeDoc([parent, fakeLayer('Other', 1)]);
  const ctx = loadHost(doc);
  const r = exec(ctx, 'layers', { command: 'delete', layer: ['Parent'], deleteContents: true, document: 'Someone Else.ai' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'wrong_document');
  assert.strictEqual(parent.removed, false, 'the guard must stop the write, not just report it');
  const ok = exec(ctx, 'layers', { command: 'rename', layer: ['Other'], name: 'Renamed', document: 'Awards.ai' });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.result.document, 'Awards.ai', 'results say which document they ran in');
});

test('point lists are validated in full before a path is touched', () => {
  const ctx = loadHost(null);
  assert.doesNotThrow(() => ctx.__mcp_validatePoints(inside(ctx, [[0, 0], [10, 0], { anchor: [5, 5], left: [4, 4] }]), 2));
  for (const bad of [[[0, 0]], [[0, 0], ['x', 5]], [[0, 0], { anchor: 'bad' }], [[0, 0], { anchor: [1, 1], left: [null, 2] }], 'nope']) {
    assert.throws(() => ctx.__mcp_validatePoints(inside(ctx, bad), 2), (e) => e.code === 'bad_value', JSON.stringify(bad));
  }
});

test('invalid artboard preserves every existing path point', () => {
  const ctx = loadHost(null);
  vm.runInContext(`
    var doc = {artboards: [{artboardRect:[0,100,100,0]}]};
    doc.artboards.getActiveArtboardIndex = function () { return 0; };
    var item = {typename:'PathItem', geometricBounds:[0,10,10,0], pathPoints:[]};
    for (var i=0; i<4; i++) item.pathPoints.push({remove:function () {
      item.pathPoints.splice(item.pathPoints.indexOf(this),1);
    }});
  `, ctx);
  assert.throws(() => ctx.__mcp_applyWrite(ctx.doc, ctx.item, inside(ctx, {artboard:99, points:[[0,0],[10,10]]})), /artboard 99 does not exist/);
  assert.strictEqual(ctx.item.pathPoints.length, 4);
});

/*
 * Rectangles with x/width 0/1000, 10/10 and 30/10 (review on #10): centres
 * 500, 15 and 35. Sorted by left edge, the wide one stays first and 15 moves;
 * sorted by centre, 15 and 500 stay put and 35 moves to 257.5.
 */
function distributeDoc(ctx, horizontal) {
  vm.runInContext(`
    var horiz = ${horizontal};
    var spans = [[0, 1000], [10, 20], [30, 40]];
    var byUuid = {};
    for (var i = 0; i < spans.length; i++) {
      var s = spans[i];
      var it = {uuid: String(i + 1), geometricBounds: horiz ? [s[0], 0, s[1], -10] : [0, -s[0], 10, -s[1]]};
      it.translate = function (dx, dy) { var b = this.geometricBounds; this.geometricBounds = [b[0] + dx, b[1] + dy, b[2] + dx, b[3] + dy]; };
      byUuid[it.uuid] = it;
    }
    var doc = {name: 'Layout.ai', artboards: [{artboardRect: [-2000, 2000, 2000, -2000]}],
               getPageItemFromUuid: function (u) { return byUuid[u]; }};
    doc.artboards.getActiveArtboardIndex = function () { return 0; };
    app.documents = [doc];
  `, ctx);
  Object.defineProperty(ctx.app, 'activeDocument', { get: () => ctx.doc });
  return ctx.byUuid;
}

for (const axis of ['horizontal', 'vertical']) {
  test('distribute by centers keeps the outer centres fixed: ' + axis, () => {
    const ctx = loadHost(null);
    const items = distributeDoc(ctx, axis === 'horizontal');
    const r = exec(ctx, 'distribute', { uuids: ['1', '2', '3'], by: 'centers', axis });
    assert.strictEqual(r.ok, true, JSON.stringify(r.error));
    const centre = (it) => {
      const b = it.geometricBounds;
      return axis === 'horizontal' ? (b[0] + b[2]) / 2 : -(b[1] + b[3]) / 2;
    };
    assert.strictEqual(centre(items['1']), 500);
    assert.strictEqual(centre(items['2']), 15);
    assert.strictEqual(centre(items['3']), 257.5);
  });
}

function exportFilesystem(options = {}) {
  const files = new Map([['/tmp/render.png', 'new render'], ['/out/result.png', 'old output']]);
  function File(name) {
    if (!(this instanceof File)) return new File(name);
    this.fsName = name;
  }
  Object.defineProperties(File.prototype, {
    name: {get() { return this.fsName.split('/').pop(); }},
    exists: {get() { return files.has(this.fsName); }},
    length: {get() { return (files.get(this.fsName) || '').length; }},
  });
  File.prototype.copy = function (target) {
    if (options.copyFails) return false;
    files.set(target, options.shortCopy ? 'x' : files.get(this.fsName));
    return true;
  };
  File.prototype.rename = function (name) {
    if (this.fsName.endsWith('.staged') && options.promoteThrows) throw new Error('rename failed');
    if (this.fsName.endsWith('.staged') && options.promoteFails) return false;
    if (this.fsName.endsWith('.backup') && options.restoreFails) return false;
    const target = this.fsName.slice(0, this.fsName.lastIndexOf('/') + 1) + name;
    if (files.has(target)) return false;
    files.set(target, files.get(this.fsName));
    files.delete(this.fsName);
    this.fsName = target;
    return true;
  };
  File.prototype.remove = function () { return files.delete(this.fsName); };
  const ctx = loadHost(null);
  ctx.File = File;
  return {files, replace: (overwrite = true) => ctx.__mcp_replaceExport(new File('/tmp/render.png'), new File('/out/result.png'), overwrite)};
}

for (const options of [{copyFails:true}, {shortCopy:true}]) {
  test('failed or incomplete staging preserves previous export: ' + JSON.stringify(options), () => {
    const f = exportFilesystem(options);
    assert.throws(f.replace, /Could not stage/);
    assert.strictEqual(f.files.get('/out/result.png'), 'old output');
    assert.strictEqual(f.files.get('/tmp/render.png'), 'new render');
  });
}

test('failed export promotion restores previous output and retains staged render', () => {
  const f = exportFilesystem({promoteFails:true});
  assert.throws(f.replace, /previous output restored/);
  assert.strictEqual(f.files.get('/out/result.png'), 'old output');
  assert.ok([...f.files].some(([p, v]) => p.endsWith('.staged') && v === 'new render'));
});

test('failed export recovery preserves both backup and staged render', () => {
  const f = exportFilesystem({promoteFails:true, restoreFails:true});
  assert.throws(f.replace, /previous output retained at/);
  assert.ok([...f.files].some(([p, v]) => p.endsWith('.backup') && v === 'old output'));
  assert.ok([...f.files].some(([p, v]) => p.endsWith('.staged') && v === 'new render'));
});

test('successful export replacement installs render and removes backup', () => {
  const f = exportFilesystem();
  f.replace();
  assert.strictEqual(f.files.get('/out/result.png'), 'new render');
  assert.ok(![...f.files.keys()].some(p => /\.(backup|staged)$/.test(p)));
});


test('throwing export promotion also restores previous output', () => {
  const f = exportFilesystem({promoteThrows:true});
  assert.throws(f.replace, /previous output restored/);
  assert.strictEqual(f.files.get('/out/result.png'), 'old output');
});


test('replacement rechecks overwrite permission and preserves existing output', () => {
  const f = exportFilesystem();
  assert.throws(() => f.replace(false), /pass overwrite:true/);
  assert.strictEqual(f.files.get('/out/result.png'), 'old output');
});
