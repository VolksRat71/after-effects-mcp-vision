/*
 * Behaviour tests for the Premiere Pro ExtendScript host, run under node:vm.
 *
 * The real host files load into a sandbox with a small fake of Premiere's DOM:
 * Time objects counted in ticks, tracks whose insertClip creates track items,
 * components with keyframes, a marker collection and a QE stub. What these
 * prove is the host's own logic - addressing, the frame grid, the ownership
 * guard, unit conversions, batch errors and state restore. The fake is strict
 * where the scripting guide is: activeSequence has no setter (openSequence
 * switches), Track.insertClip takes a String of ticks, Marker.end takes
 * seconds - so the host cannot pass by leaning on a lenient fake. Whether
 * Premiere's real DOM behaves like the guide is what verify-live-premiere.sh
 * checks.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HOST = path.join(__dirname, '..', '..', 'cep', 'host');
const FILES = ['json-polyfill.jsx', 'pr/util.jsx', 'pr/ops-query.jsx', 'pr/ops-project.jsx', 'pr/ops-edit.jsx',
  'pr/ops-output.jsx', 'pr/ops.jsx', 'pr/host.jsx'];
const TPS = 254016000000;
const TPF_2997 = 8475667200; // ticks per frame at 29.97 fps

class Time {
  constructor() { this.t = 0; }
  get ticks() { return String(this.t); }
  set ticks(v) { this.t = Number(v); }
  get seconds() { return this.t / TPS; }
  set seconds(v) { this.t = Math.round(v * TPS); }
}
const at = (seconds) => { const t = new Time(); t.seconds = seconds; return t; };
const coll = (arr, count) => Object.defineProperty(arr, count, { get() { return arr.length; } });

function param(displayName, value) {
  return {
    displayName, value, keys: [], varying: false,
    getValue() { return this.value; },
    setValue(v) { this.value = v; },
    isTimeVarying() { return this.varying; },
    setTimeVarying(v) { this.varying = v; if (!v) this.keys = []; },
    addKey(t) { this.keys.push({ t, v: null }); },
    setValueAtKey(t, v) { this.keys.find((k) => k.t.ticks === t.ticks).v = v; },
    getKeys() { return this.keys.map((k) => k.t); },
    getValueAtKey(t) { return this.keys.find((k) => k.t.ticks === t.ticks).v; },
  };
}
const component = (displayName, params) => ({ displayName, matchName: displayName, properties: coll(params, 'numItems') });

let nextId = 100;
function projectItem(name, seconds = 10) {
  return {
    nodeId: String(nextId++), name, type: 1, children: null, seconds, inSet: 0, outSet: seconds,
    getMediaPath() { return `/media/${name}`; }, isOffline() { return false; },
    getInPoint() { return at(this.inSet); }, getOutPoint() { return at(this.outSet); },
    setInPoint(s, type) { assert.strictEqual(type, 4); this.inSet = s; },
    setOutPoint(s, type) { assert.strictEqual(type, 4); this.outSet = s; },
  };
}

function track(name, kind, seq) {
  const tr = {
    name, clips: coll([], 'numItems'), muted: 0, seq,
    isMuted() { return this.muted; }, setMute(v) { this.muted = v; },
    insertClip(item, time) {
      if (typeof time !== 'string' || !/^\d+$/.test(time)) throw new Error('insertClip time must be a String of ticks');
      const srcIn = item.inSet;
      const len = item.outSet - srcIn;
      const startTicks = Number(time);
      const start = new Time(); start.ticks = startTicks;
      const end = new Time(); end.ticks = startTicks + Math.round(len * TPS);
      const comps = kind === 'Video'
        ? [component('Opacity', [param('Opacity', 100)]),
           component('Motion', [param('Position', [0.5, 0.5]), param('Scale', 100), param('Rotation', 0), param('Anchor Point', [0.5, 0.5])])]
        : [component('Volume', [param('Bypass', false), param('Level', 0.17782794)])];
      const clip = {
        nodeId: String(nextId++), name: item.name, start, end, inPoint: at(srcIn), outPoint: at(srcIn + len),
        projectItem: item, mediaType: kind, disabled: false, components: coll(comps, 'numItems'),
        move(delta) { this.start = (() => { const t = new Time(); t.ticks = this.start.t + delta.t; return t; })();
                      this.end = (() => { const t = new Time(); t.ticks = this.end.t + delta.t; return t; })(); },
        remove() { const i = tr.clips.indexOf(this); tr.clips.splice(i, 1); },
      };
      tr.insertedWith = { srcIn: item.inSet, srcOut: item.outSet };
      tr.clips.push(clip);
      return true;
    },
  };
  tr.overwriteClip = tr.insertClip;
  return tr;
}

function markerCollection() {
  const list = [];
  let guid = 1;
  return {
    list,
    createMarker(seconds) {
      let end = at(seconds);
      const m = { guid: `m${guid++}`, name: '', comments: '', type: 'Comment', start: at(seconds),
        get end() { return end; },
        set end(s) { if (typeof s !== 'number') throw new Error('Marker.end takes seconds'); end = at(s); },
        setTypeAsChapter() { this.type = 'Chapter'; }, setTypeAsComment() { this.type = 'Comment'; },
        setTypeAsSegmentation() { this.type = 'Segmentation'; }, setTypeAsWebLink() { this.type = 'WebLink'; },
        setColorByIndex(i) { this.color = i; } };
      list.push(m);
      return m;
    },
    getFirstMarker() { return list[0]; },
    getNextMarker(m) { return list[list.indexOf(m) + 1]; },
    deleteMarker(m) { list.splice(list.indexOf(m), 1); },
  };
}

function sequence(name, id) {
  const seq = {
    sequenceID: id, name, timebase: String(TPF_2997), end: '0', frameSizeHorizontal: 1920, frameSizeVertical: 1080,
    playhead: at(0), markers: markerCollection(),
    getPlayerPosition() { return this.playhead; },
    setPlayerPosition(ticks) { const t = new Time(); t.ticks = ticks; this.playhead = t; },
    getInPoint() { return 0; }, getOutPoint() { return 0; },
  };
  seq.videoTracks = coll([track('Video 1', 'Video', seq), track('Video 2', 'Video', seq)], 'numTracks');
  seq.audioTracks = coll([track('Audio 1', 'Audio', seq)], 'numTracks');
  return seq;
}

function fakePremiere({ projectPath = '/Users/test/User Edit.prproj' } = {}) {
  const bars = projectItem('bars.mov', 10);
  const tone = projectItem('tone.wav', 10);
  const still = projectItem('still.png', 5);
  const seqA = sequence('Edit', 'seq-a');
  const seqB = sequence('Other', 'seq-b');
  let active = seqB;
  const project = {
    name: path.basename(projectPath), path: projectPath,
    rootItem: { nodeId: 'root', name: 'root', type: 3, children: coll([bars, tone, still], 'numItems') },
    sequences: coll([seqA, seqB], 'numSequences'),
    get activeSequence() { return active; },
    set activeSequence(v) { throw new Error('activeSequence is read-only; use openSequence'); },
    openSequence(id) { active = [seqA, seqB].find((s) => s.sequenceID === id) || active; return true; },
    saved: 0,
    save() { this.saved++; },
  };
  const exported = [];
  const qe = { project: {
    path: projectPath,
    init() { if (!qe.stuck) this.path = app.project.path; return true; },
    getActiveSequence() {
      return { CTI: { timecode: 'TC@' + project.activeSequence.playhead.ticks },
               exportFramePNG(tc, p) { exported.push({ tc, path: p, active: project.activeSequence.sequenceID }); } };
    },
  } };
  const onDisk = new Set([projectPath]);
  const app = {
    version: '26.0.2', project, projects: coll([project], 'numProjects'),
    enableQE() {},
    // Premiere reports a resolved path, which need not match the one asked for (macOS /tmp is /private/tmp).
    newProject(p) {
      const made = { ...project, name: path.basename(p), path: '/private' + p, sequences: coll([], 'numSequences'), saved: 0 };
      app.projects.push(made); app.project = made; onDisk.add(p);
    },
    openDocument() { throw new Error('the test does not open projects'); },
  };
  class File { constructor(p) { this.fsName = p; } get exists() { return onDisk.has(this.fsName); } get parent() { return new Folder(path.dirname(this.fsName)); } }
  class Folder { constructor(p) { this.fsName = p; } get exists() { return true; } create() { return true; } }
  Folder.temp = { fsName: '/tmp' };
  return { app, qe, File, Folder, Time, project, seqA, seqB, bars, tone, still, exported };
}

function loadHost(world) {
  const ctx = { app: world.app, qe: world.qe, File: world.File, Folder: world.Folder, Time: world.Time };
  vm.createContext(ctx);
  for (const f of FILES) {
    const src = fs.readFileSync(path.join(HOST, f), 'utf8').replace(/^[ \t]*#[a-z]+\b.*$/gim, '');
    vm.runInContext(src, ctx, { filename: f });
  }
  return ctx;
}

const exec = (ctx, op, args) => JSON.parse(ctx.__mcp_exec(JSON.stringify({ op, args: args || {} })));

function owned() {
  const world = fakePremiere();
  const ctx = loadHost(world);
  assert.strictEqual(exec(ctx, 'project', { command: 'adopt' }).ok, true);
  return { world, ctx };
}

test('sessionInfo lists projects and sequences and says the bridge does not own the user\'s project', () => {
  const world = fakePremiere();
  const r = exec(loadHost(world), 'sessionInfo');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.result.appVersion, '26.0.2');
  assert.strictEqual(r.result.active.ownedByBridge, false);
  assert.strictEqual(r.result.active.activeSequence, 'seq-b');
  const a = r.result.active.sequences.find((s) => s.sequenceId === 'seq-a');
  assert.strictEqual(a.fps, 29.97);
  assert.deepStrictEqual([a.width, a.height, a.videoTracks, a.audioTracks], [1920, 1080, 2, 1]);
});

test('every write refuses a project the bridge did not open, and changes nothing', () => {
  const world = fakePremiere();
  const ctx = loadHost(world);
  const r = exec(ctx, 'clips', { sequenceId: 'seq-a', command: 'insert', items: [{ projectItem: world.bars.nodeId, track: 'V1', at: 0 }] });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'not_owned');
  assert.strictEqual(world.seqA.videoTracks[0].clips.length, 0, 'the guard must stop the write');
  for (const [op, args] of [['markers', { command: 'add', markers: [{ at: 1 }] }], ['project', { command: 'save' }],
    ['motion', { items: [] }], ['audio', { command: 'mute', track: 'A1' }]]) {
    assert.strictEqual(exec(ctx, op, args).error.code, 'not_owned', `${op} must be guarded`);
  }
  assert.strictEqual(world.project.saved, 0);
  // Reads stay open.
  assert.strictEqual(exec(ctx, 'markers', { command: 'list' }).ok, true);
  assert.strictEqual(exec(ctx, 'tree', {}).ok, true);
});

test('adopt survives a host reload, so reloadHost does not lock the agent out', () => {
  const { world, ctx } = owned();
  for (const f of ['pr/util.jsx', 'pr/ops-output.jsx']) {
    vm.runInContext(fs.readFileSync(path.join(HOST, f), 'utf8'), ctx, { filename: f });
  }
  assert.strictEqual(exec(ctx, 'sessionInfo').result.active.ownedByBridge, true);
  assert.strictEqual(world.project.saved, 0);
});

test('times snap to the sequence frame grid', () => {
  const { world, ctx } = owned();
  // 1.0 s at 29.97 is between frames 29 and 30; it must land on 30, exactly.
  const r = exec(ctx, 'clips', { sequenceId: 'seq-a', command: 'insert', items: [{ projectItem: world.bars.nodeId, track: 'V1', at: 1.0 }] });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  const placed = r.result.applied[0].placed[0];
  assert.strictEqual(placed.start.frame, 30);
  assert.strictEqual(Number(world.seqA.videoTracks[0].clips[0].start.ticks) % TPF_2997, 0);
});

test('insert gives a still its duration, uses a source range, then clears it from the project item', () => {
  const { world, ctx } = owned();
  const r = exec(ctx, 'clips', { sequenceId: 'seq-a', command: 'insert', items: [
    { projectItem: world.still.nodeId, track: 'V2', at: 0, duration: 3 },
    { projectItem: world.bars.nodeId, track: 'V1', at: 0, sourceIn: 2, sourceOut: 4 },
  ] });
  assert.deepStrictEqual(r.result.errors, []);
  const still = r.result.applied[0].placed[0];
  assert.strictEqual(still.track, 'V2');
  assert.strictEqual(still.end.frame, 90, '3 s at 29.97 is 90 frames');
  const bars = r.result.applied[1].placed[0];
  assert.deepStrictEqual([bars.sourceIn, bars.sourceOut], [2, 4]);
  assert.deepStrictEqual(world.seqA.videoTracks[0].insertedWith, { srcIn: 2, srcOut: 4 });
  assert.deepStrictEqual([world.bars.inSet, world.bars.outSet], [0, 10], 'the project item\'s own in/out is put back');
});

test('a source range leaves the user\'s own in/out on the project item as it was', () => {
  const { world, ctx } = owned();
  world.bars.inSet = 1; world.bars.outSet = 9;
  exec(ctx, 'clips', { sequenceId: 'seq-a', command: 'insert', items: [{ projectItem: world.bars.nodeId, track: 'V1', at: 0, sourceIn: 3 }] });
  assert.deepStrictEqual(world.seqA.videoTracks[0].insertedWith, { srcIn: 3, srcOut: 9 });
  assert.deepStrictEqual([world.bars.inSet, world.bars.outSet], [1, 9]);
});

test('a batch reports each failure with a code and still applies the rest', () => {
  const { world, ctx } = owned();
  const r = exec(ctx, 'clips', { sequenceId: 'seq-a', command: 'insert', items: [
    { projectItem: world.bars.nodeId, track: 'V9', at: 0 },
    { projectItem: 'nope', track: 'V1', at: 0 },
    { projectItem: world.bars.nodeId, track: 'V1', at: 0 },
  ] });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.result.errors.map((e) => [e.index, e.code]), [[0, 'unknown_track'], [1, 'unknown_item']]);
  assert.strictEqual(r.result.applied.length, 1);
});

test('trim, move and ripple delete address clips by nodeId', () => {
  const { world, ctx } = owned();
  const ins = exec(ctx, 'clips', { sequenceId: 'seq-a', command: 'insert', items: [{ projectItem: world.bars.nodeId, track: 'V1', at: 0 }] });
  const id = ins.result.applied[0].placed[0].nodeId;
  const mv = exec(ctx, 'clips', { sequenceId: 'seq-a', command: 'move', items: [{ nodeId: id, to: 2 }] });
  assert.strictEqual(mv.result.applied[0].start.frame, 60);
  const tr = exec(ctx, 'clips', { sequenceId: 'seq-a', command: 'trim', items: [{ nodeId: id, end: 5 }] });
  assert.strictEqual(tr.result.applied[0].end.frame, Math.round(5 * 29.97));
  const del = exec(ctx, 'clips', { sequenceId: 'seq-a', command: 'rippleDelete', items: [{ nodeId: id }, { nodeId: 'gone' }] });
  assert.strictEqual(del.result.applied.length, 1);
  assert.strictEqual(del.result.errors[0].code, 'unknown_clip');
  assert.strictEqual(world.seqA.videoTracks[0].clips.length, 0);
});

test('audio levels are dB on the wire and Premiere\'s gain scale inside', () => {
  const { world, ctx } = owned();
  const ins = exec(ctx, 'clips', { sequenceId: 'seq-a', command: 'insert', items: [{ projectItem: world.tone.nodeId, track: 'A1', at: 0 }] });
  const id = ins.result.applied[0].placed[0].nodeId;
  assert.strictEqual(exec(ctx, 'audio', { sequenceId: 'seq-a', command: 'read', nodeId: id }).result.db, 0, '0.1778 reads as 0 dB');
  const set = exec(ctx, 'audio', { sequenceId: 'seq-a', command: 'level', items: [{ nodeId: id, db: -6 }] });
  assert.strictEqual(set.result.applied[0].db, -6);
  const level = world.seqA.audioTracks[0].clips[0].components[0].properties[1];
  assert.ok(Math.abs(level.value - Math.pow(10, -21 / 20)) < 1e-9);
});

test('keyframe times count from the clip\'s first frame, not its source in-point', () => {
  const { world, ctx } = owned();
  const ins = exec(ctx, 'clips', { sequenceId: 'seq-a', command: 'insert', items: [{ projectItem: world.tone.nodeId, track: 'A1', at: 0, sourceIn: 4 }] });
  const id = ins.result.applied[0].placed[0].nodeId;
  exec(ctx, 'audio', { sequenceId: 'seq-a', command: 'level', items: [{ nodeId: id, keys: [{ at: 0, value: -60 }, { at: 1, value: 0 }] }] });
  const level = world.seqA.audioTracks[0].clips[0].components[0].properties[1];
  assert.deepStrictEqual(level.keys.map((k) => k.t.seconds), [4, 5], 'stored against source time');
  const read = exec(ctx, 'audio', { sequenceId: 'seq-a', command: 'read', nodeId: id }).result;
  assert.deepStrictEqual(read.keys.map((k) => [k.at, k.db]), [[0, -60], [1, 0]], 'read back in clip time and dB');
});

test('silence reads as null dB, and the reply is still valid JSON', () => {
  const { world, ctx } = owned();
  const ins = exec(ctx, 'clips', { sequenceId: 'seq-a', command: 'insert', items: [{ projectItem: world.tone.nodeId, track: 'A1', at: 0 }] });
  world.seqA.audioTracks[0].clips[0].components[0].properties[1].value = 0;
  const raw = ctx.__mcp_exec(JSON.stringify({ op: 'audio', args: { sequenceId: 'seq-a', command: 'read', nodeId: ins.result.applied[0].placed[0].nodeId } }));
  assert.strictEqual(JSON.parse(raw).result.db, null);
});

test('a fixed value never silently deletes keyframes', () => {
  const { world, ctx } = owned();
  const ins = exec(ctx, 'clips', { sequenceId: 'seq-a', command: 'insert', items: [{ projectItem: world.still.nodeId, track: 'V1', at: 0 }] });
  const id = ins.result.applied[0].placed[0].nodeId;
  exec(ctx, 'motion', { sequenceId: 'seq-a', items: [{ nodeId: id, keys: [{ at: 0, scale: 100 }, { at: 2, scale: 120 }] }] });
  const refused = exec(ctx, 'motion', { sequenceId: 'seq-a', items: [{ nodeId: id, scale: 90 }] });
  assert.strictEqual(refused.result.errors[0].code, 'keyframed');
  const scale = world.seqA.videoTracks[0].clips[0].components[1].properties[1];
  assert.strictEqual(scale.keys.length, 2, 'the keys are still there');
  exec(ctx, 'motion', { sequenceId: 'seq-a', items: [{ nodeId: id, scale: 90, clearKeys: true }] });
  assert.deepStrictEqual([scale.keys.length, scale.value], [0, 90]);
});

test('motion takes pixels and writes Premiere\'s frame fractions; non-video clips are refused', () => {
  const { world, ctx } = owned();
  const ins = exec(ctx, 'clips', { sequenceId: 'seq-a', command: 'insert', items: [
    { projectItem: world.still.nodeId, track: 'V1', at: 0 }, { projectItem: world.tone.nodeId, track: 'A1', at: 0 }] });
  const v = ins.result.applied[0].placed[0].nodeId, a = ins.result.applied[1].placed[0].nodeId;
  const r = exec(ctx, 'motion', { sequenceId: 'seq-a', items: [
    { nodeId: v, position: [480, 270], keys: [{ at: 0, scale: 100 }, { at: 5, scale: 115 }] },
    { nodeId: a, scale: 50 }] });
  assert.deepStrictEqual(r.result.applied[0].set.sort(), ['position', 'scale']);
  assert.strictEqual(r.result.errors[0].code, 'type_mismatch');
  const motion = world.seqA.videoTracks[0].clips[0].components[1];
  assert.deepStrictEqual(Array.from(motion.properties[0].value), [0.25, 0.25]);
  assert.deepStrictEqual(motion.properties[1].keys.map((k) => [k.t.seconds, k.v]), [[0, 100], [5, 115]]);
});

test('markers: a chapter marker is added, listed and deleted by guid', () => {
  const { world, ctx } = owned();
  const add = exec(ctx, 'markers', { sequenceId: 'seq-a', command: 'add', markers: [
    { at: 10, name: 'Chapter 1', type: 'chapter' }, { at: 2, type: 'bogus' }] });
  assert.strictEqual(add.result.applied[0].type, 'chapter');
  assert.strictEqual(add.result.errors[0].code, 'bad_value');
  const list = exec(ctx, 'markers', { sequenceId: 'seq-a', command: 'list' }).result.markers;
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].start.frame, Math.round(10 * 29.97));
  exec(ctx, 'markers', { sequenceId: 'seq-a', command: 'delete', markers: [{ guid: list[0].guid }] });
  assert.strictEqual(world.seqA.markers.list.length, 0);
});

test('captureFrame shoots the asked sequence and frame, then restores the user\'s sequence and playhead', () => {
  const world = fakePremiere();
  const ctx = loadHost(world);
  world.seqA.setPlayerPosition(String(TPF_2997 * 7));
  const r = exec(ctx, 'captureFrame', { sequenceId: 'seq-a', time: 2, fileName: 'cap1.png' });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(world.exported[0].active, 'seq-a');
  assert.strictEqual(world.exported[0].tc, 'TC@' + TPF_2997 * 60, 'the frame at 2 s, on the grid');
  assert.strictEqual(world.exported[0].path, '/tmp/premiere-mcp-vision/cap1.png');
  assert.strictEqual(world.project.activeSequence.sequenceID, 'seq-b', 'the user\'s active sequence is back');
  assert.strictEqual(world.seqA.playhead.ticks, String(TPF_2997 * 7), 'and so is the playhead');
  assert.strictEqual(r.result.time.frame, 60);
});

test('QE is re-attached to the open project before use, and refused if it will not follow', () => {
  const world = fakePremiere();
  const ctx = loadHost(world);
  world.qe.project.path = '/Users/test/Closed Earlier.prproj';
  assert.strictEqual(exec(ctx, 'captureFrame', { sequenceId: 'seq-a', time: 0, fileName: 'a.png' }).ok, true);
  assert.strictEqual(world.qe.project.path, world.project.path, 'init() moved QE to the open project');
  world.qe.project.path = '/Users/test/Closed Earlier.prproj';
  world.qe.stuck = true;
  const r = exec(ctx, 'captureFrame', { sequenceId: 'seq-a', time: 0, fileName: 'b.png' });
  assert.strictEqual(r.error.code, 'qe_stale');
  assert.strictEqual(world.exported.length, 1, 'nothing ran against the wrong project');
});

test('capture never writes outside its own folder', () => {
  const ctx = loadHost(fakePremiere());
  for (const bad of ['../x.png', '/etc/x.png', 'a/b.png', 'x.jpg', '']) {
    const r = exec(ctx, 'captureFrame', { sequenceId: 'seq-a', time: 0, fileName: bad });
    assert.strictEqual(r.ok, false, bad);
    assert.strictEqual(r.error.code, 'bad_value');
  }
});

test('open refuses a project that is already open, so it cannot be taken over', () => {
  const world = fakePremiere();
  const ctx = loadHost(world);
  const r = exec(ctx, 'project', { command: 'open', path: '/Users/test/User Edit.prproj' });
  assert.strictEqual(r.error.code, 'already_open');
  assert.strictEqual(exec(ctx, 'sessionInfo').result.active.ownedByBridge, false);
});

test('a new or open that leaves the user\'s project active does not take it over', () => {
  const world = fakePremiere();
  world.app.newProject = () => {}; // Premiere declined: nothing changed
  const ctx = loadHost(world);
  const r = exec(ctx, 'project', { command: 'new', path: '/tmp/never.prproj' });
  assert.strictEqual(r.error.code, 'open_failed');
  assert.strictEqual(exec(ctx, 'sessionInfo').result.active.ownedByBridge, false);
  assert.strictEqual(exec(ctx, 'clips', { sequenceId: 'seq-a', command: 'insert', items: [] }).error.code, 'not_owned');
});

test('a clip that lands somewhere other than asked is taken back out', () => {
  const { world, ctx } = owned();
  const track = world.seqA.videoTracks[0];
  const real = track.insertClip;
  track.insertClip = function (item) { return real.call(this, item, String(TPF_2997 * 3)); }; // always frame 3
  const r = exec(ctx, 'clips', { sequenceId: 'seq-a', command: 'insert', items: [{ projectItem: world.bars.nodeId, track: 'V1', at: 0 }] });
  assert.strictEqual(r.result.errors[0].code, 'misplaced');
  assert.strictEqual(track.clips.length, 0);
});

test('a new project is owned under the path Premiere reports, not only the one asked for', () => {
  const world = fakePremiere();
  const ctx = loadHost(world);
  assert.strictEqual(exec(ctx, 'project', { command: 'new', path: '/tmp/scratch.prproj' }).ok, true);
  assert.strictEqual(world.app.project.path, '/private/tmp/scratch.prproj');
  assert.strictEqual(exec(ctx, 'sessionInfo').result.active.ownedByBridge, true);
});

test('the host always answers in JSON, even for nonsense', () => {
  const ctx = loadHost(fakePremiere());
  assert.strictEqual(JSON.parse(ctx.__mcp_exec('not json')).error.code, 'bad_request');
  assert.strictEqual(exec(ctx, 'noSuchOp').error.code, 'unknown_op');
  assert.strictEqual(exec(ctx, 'clip', { sequenceId: 'nope', nodeId: '1' }).error.code, 'unknown_sequence');
  assert.strictEqual(exec(ctx, 'ping').result.appVersion, '26.0.2');
});
