/*
 * The Premiere Pro tool surface. Same shape as the After Effects and
 * Illustrator servers, so an agent drives all three the same way:
 *   - everything addressed by stable id (ProjectItem / TrackItem nodeId,
 *     Sequence sequenceID), tracks by name ("V1", "A1"), never by index
 *   - a discovery chain: sessionInfo -> tree -> clip -> edit -> capture
 *   - batch-shaped writes with per-item machine-readable errors
 *   - one time convention everywhere: seconds on the sequence timeline,
 *     snapped to the sequence's frame grid
 *
 * Guards that live on this side, because Node can see the disk and the host
 * cannot: every written path is absolute, never replaces a file without
 * overwrite:true, and never lands inside a folder listed in
 * PREMIERE_MCP_PROTECTED_DIRS; renders refuse to start with less than
 * PREMIERE_MCP_MIN_FREE_GB (default 15) free on the target disk.
 */

const fs = require('fs');
const os = require('os');
const nodePath = require('path');
const { execFileSync } = require('child_process');
const { buildContactSheet, renderCapture } = require('./contact-sheet-illustrator.js');
const { isCompletePng } = require('./png-ready.js');
const { bridgeInfo } = require('./bridge-info.js');

const HOST_JSX = nodePath.join(__dirname, '..', 'host', 'pr', 'host.jsx');

const TIME =
  'Times are SECONDS on the sequence timeline (0 = the first frame) and are snapped to the sequence\'s frame ' +
  'grid. Results give both seconds and the frame number.';

const IDS =
  'Address project items and timeline clips by the nodeId pr_query returns, sequences by sequenceId, tracks ' +
  'by name: "V1" is the bottom video track, "A1" the top audio track.';

const sequenceIdSchema = { type: 'string', description: 'sequenceId from pr_query. Default: the active sequence.' };
const nodeIdSchema = { type: 'string', description: 'nodeId from pr_query.' };
const keysSchema = {
  type: 'array',
  items: { type: 'object', properties: { at: { type: 'number', description: 'Seconds from the clip\'s first frame.' } } },
};

const clearKeysSchema = {
  type: 'boolean',
  description: 'A fixed value on a keyframed property deletes its keyframes, so it is refused (code keyframed) unless this is true.',
};

function textContent(value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

function errorContent(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

const TOOLS = [
  {
    name: 'pr_query',
    description:
      'Read Premiere Pro. START HERE - sessionInfo first, then tree.\n\n' +
      '- sessionInfo: Premiere version, open projects, the active one\'s sequences (size, fps, track counts, ' +
      'length) and whether this bridge may edit it (ownedByBridge).\n' +
      '- tree: without sequenceId, the project panel - bins, clips, sequences - to depth (default 2). With ' +
      'sequenceId, that sequence\'s tracks and every clip on them with start, end and source in/out. maxItems ' +
      '(default 300) caps the listing and the result says truncated:true - a long edit has thousands of clips, ' +
      'so ask for one sequence at a time.\n' +
      '- clip: one timeline clip in full: placement, linked clips, and every effect parameter with its value ' +
      'and keyframes. Large for a clip with many effects.\n' +
      '- propertyKeys: just the component and parameter names on a clip - what pr_effects params can address.\n' +
      '- sequencePresets: the .sqpreset files Premiere ships, filtered by match (e.g. "1080p").\n' +
      '- describe: this server\'s live schema for one tool ({tool:"pr_clips"}).\n\n' + IDS,
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['sessionInfo', 'tree', 'clip', 'propertyKeys', 'sequencePresets', 'describe'] },
        tool: { type: 'string', description: 'describe: tool name.' },
        sequenceId: sequenceIdSchema,
        nodeId: { type: 'string', description: 'tree: walk this bin only. clip/propertyKeys: the timeline clip.' },
        depth: { type: 'number', description: 'tree: 1-8. Default 2.' },
        maxItems: { type: 'number', description: 'tree: cap. Default 300.' },
        match: { type: 'string', description: 'sequencePresets: substring filter.' },
        limit: { type: 'number' },
      },
      required: ['command'],
    },
  },
  {
    name: 'pr_project',
    description:
      'Projects, bins and imports. The bridge edits only projects it created or opened itself, so it cannot ' +
      'overwrite work the user has open and unsaved. Every other write tool refuses with not_owned on any other ' +
      'project. adopt lifts that for the active project: use it only when the user asked you to edit that project.\n\n' +
      '- new: path (absolute, .prproj, must not exist). open: path. save. saveAs: path (Premiere then works on ' +
      'the new file). close: save:true to save first; without it unsaved changes are discarded.\n' +
      '- bin: name, optional parent bin nodeId. Returns its nodeId.\n' +
      '- import: paths (absolute). Media is referenced where it is, never copied. Returns the new items\' nodeIds.\n' +
      '- importAE: an After Effects project path, comps (names; default all). The comps stay live-linked.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['new', 'open', 'adopt', 'save', 'saveAs', 'close', 'bin', 'import', 'importAE'] },
        path: { type: 'string' },
        paths: { type: 'array', items: { type: 'string' } },
        name: { type: 'string' },
        parent: { type: 'string', description: 'bin: parent bin nodeId. Default the project root.' },
        bin: { type: 'string', description: 'import/importAE: target bin nodeId.' },
        comps: { type: 'array', items: { type: 'string' } },
        save: { type: 'boolean' },
        overwrite: { type: 'boolean' },
      },
      required: ['command'],
    },
  },
  {
    name: 'pr_sequence',
    description:
      'Sequences.\n\n' +
      '- create: name, preset (a .sqpreset path or a name relative to Premiere\'s SequencePresets folder, ' +
      'default "HD 1080p/HD 1080p 29.97 fps"; list them with pr_query sequencePresets), or fromClips (project ' +
      'item nodeIds) to match the first clip\'s settings. No dialog is shown. Returns the sequenceId.\n' +
      '- info, activate, rename, duplicate (optional name).\n' +
      '- setInOut: inPoint/outPoint seconds - what pr_render range:"inOut" exports. setPlayhead: time.\n' +
      '- addTracks: video and/or audio counts, added above the existing ones. Experimental (QE).\n\n' + TIME,
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['create', 'info', 'activate', 'rename', 'duplicate', 'setInOut', 'setPlayhead', 'addTracks'] },
        sequenceId: sequenceIdSchema,
        name: { type: 'string' },
        preset: { type: 'string' },
        fromClips: { type: 'array', items: { type: 'string' } },
        bin: { type: 'string' },
        inPoint: { type: 'number' }, outPoint: { type: 'number' },
        time: { type: 'number' },
        video: { type: 'number' }, audio: { type: 'number' },
      },
      required: ['command'],
    },
  },
  {
    name: 'pr_clips',
    description:
      'Put clips on the timeline and edit them. Batch-shaped: pass every item in ONE call; partial success is ' +
      'normal and the result lists applied items and errors with codes (unknown_clip, unknown_track, bad_value, ' +
      'failed).\n\n' +
      '- insert / overwrite: items [{projectItem, track, at, duration?, sourceIn?, sourceOut?}]. insert pushes ' +
      'later clips right; overwrite replaces what is there. A video item also places its linked audio. duration ' +
      'sets the length on the timeline - how a still gets its length. Returns every new clip\'s nodeId.\n' +
      '- trim: items [{nodeId, start?, end?, sourceIn?, sourceOut?}]. start/end are timeline seconds, ' +
      'sourceIn/sourceOut are seconds into the media.\n' +
      '- move: items [{nodeId, to}] (new start) or [{nodeId, by}] (offset).\n' +
      '- lift (leaves a gap) / rippleDelete (closes it): items [{nodeId}].\n' +
      '- enable / disable: items [{nodeId}].\n' +
      '- link / unlink: nodeIds.\n\n' + TIME + ' ' + IDS,
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['insert', 'overwrite', 'trim', 'move', 'lift', 'rippleDelete', 'enable', 'disable', 'link', 'unlink'] },
        sequenceId: sequenceIdSchema,
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              projectItem: nodeIdSchema, nodeId: nodeIdSchema,
              track: { type: 'string', description: '"V1", "A2"...' },
              at: { type: 'number' }, duration: { type: 'number' },
              sourceIn: { type: 'number' }, sourceOut: { type: 'number' },
              start: { type: 'number' }, end: { type: 'number' },
              to: { type: 'number' }, by: { type: 'number' },
            },
          },
        },
        nodeIds: { type: 'array', items: { type: 'string' } },
      },
      required: ['command'],
    },
  },
  {
    name: 'pr_audio',
    description:
      'Audio levels in dB.\n\n' +
      '- level: items [{nodeId, db}] for a fixed level, or [{nodeId, keys:[{at, value}]}] with value in dB for a ' +
      'level curve - fades, or a music bed held down under narration. at is seconds from the clip\'s first frame.\n' +
      '- read: one clip\'s level or keyframes, in dB (null is silence).\n' +
      '- mute / unmute: track ("A1").\n\n' +
      'Clip levels only: Premiere\'s scripting does not reach track faders.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['level', 'read', 'mute', 'unmute'] },
        sequenceId: sequenceIdSchema,
        nodeId: nodeIdSchema,
        track: { type: 'string' },
        items: {
          type: 'array',
          items: { type: 'object', properties: { nodeId: nodeIdSchema, db: { type: 'number' }, keys: keysSchema, clearKeys: clearKeysSchema } },
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'pr_motion',
    description:
      'Motion and Opacity on video clips: photo moves done in Premiere. items [{nodeId, position?, scale?, ' +
      'rotation?, anchor?, opacity?, keys?}].\n\n' +
      '- position / anchor: [x, y] in PIXELS of the sequence frame, from its top-left. [960, 540] is the centre ' +
      'of a 1920x1080 sequence.\n' +
      '- scale: percent (100 = original). rotation: degrees. opacity: 0-100.\n' +
      '- keys: [{at, scale?, position?, ...}] - each key sets whichever properties it names, at seconds from the ' +
      'clip\'s first frame. A slow push-in is two keys on scale. Keys replace a fixed value for that property.',
    inputSchema: {
      type: 'object',
      properties: {
        sequenceId: sequenceIdSchema,
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              nodeId: nodeIdSchema,
              position: { type: 'array', items: { type: 'number' } },
              anchor: { type: 'array', items: { type: 'number' } },
              scale: { type: 'number' }, rotation: { type: 'number' }, opacity: { type: 'number' },
              keys: keysSchema, clearKeys: clearKeysSchema,
            },
            required: ['nodeId'],
          },
        },
      },
      required: ['items'],
    },
  },
  {
    name: 'pr_markers',
    description:
      'Sequence markers, or a source clip\'s markers with projectItem. Chapter markers become chapters in an ' +
      'exported file.\n\n' +
      '- list.\n' +
      '- add: markers [{at, name?, comments?, type? (comment, chapter, segmentation, weblink), duration?, color? (0-7)}].\n' +
      '- update: markers [{guid, name?, comments?, type?}]. delete: markers [{guid}].\n\n' + TIME,
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['list', 'add', 'update', 'delete'] },
        sequenceId: sequenceIdSchema,
        projectItem: { type: 'string', description: 'Work on this project item\'s markers instead of the sequence\'s.' },
        markers: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              guid: { type: 'string' }, at: { type: 'number' }, duration: { type: 'number' },
              name: { type: 'string' }, comments: { type: 'string' },
              type: { type: 'string', enum: ['comment', 'chapter', 'segmentation', 'weblink'] },
              color: { type: 'number' },
            },
          },
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'pr_effects',
    description:
      'Effects and transitions. add and transition go through Premiere\'s undocumented QE DOM: EXPERIMENTAL - ' +
      'check the result with pr_query clip or pr_capture.\n\n' +
      '- list: kind video (default), audio or transition; match filters names.\n' +
      '- add: items [{nodeId, name}] - an effect by its display name, e.g. "Gaussian Blur".\n' +
      '- transition: items [{nodeId, name? (default "Cross Dissolve"), duration? (seconds, default 1), atStart? ' +
      '(default true; false puts it on the clip\'s end)}].\n' +
      '- params: items [{nodeId, component, param, value}] or keys [{at, value}] - any effect parameter by the ' +
      'names pr_query propertyKeys lists. Values are Premiere\'s raw scripting values.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['list', 'add', 'transition', 'params'] },
        sequenceId: sequenceIdSchema,
        kind: { type: 'string', enum: ['video', 'audio', 'transition'] },
        match: { type: 'string' },
        limit: { type: 'number' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              nodeId: nodeIdSchema, name: { type: 'string' }, duration: { type: 'number' }, atStart: { type: 'boolean' },
              component: { type: 'string' }, param: { type: 'string' }, value: {}, keys: keysSchema, clearKeys: clearKeysSchema,
            },
          },
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'pr_timeline',
    description:
      'Final Cut Pro 7 XML (xmeml) in and out - the same format an agent can write by hand for a rough cut.\n\n' +
      '- export: a sequence to path (absolute .xml).\n' +
      '- import: an .xml file; its sequences arrive as new sequences (returned with sequenceIds). Importing a ' +
      'revised XML into the same project duplicates its media, so import each revision into a fresh bin or ' +
      'project.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['export', 'import'] },
        sequenceId: sequenceIdSchema,
        path: { type: 'string' },
        bin: { type: 'string' },
        overwrite: { type: 'boolean' },
      },
      required: ['command', 'path'],
    },
  },
  {
    name: 'pr_render',
    description:
      'Export a sequence. Refuses to start with less than PREMIERE_MCP_MIN_FREE_GB (default 15) GiB free on the ' +
      'target disk, never replaces a file without overwrite:true, and never writes inside a ' +
      'PREMIERE_MCP_PROTECTED_DIRS folder.\n\n' +
      '- presets: export presets (.epr) from Media Encoder and Premiere, filtered by match (e.g. "H264", ' +
      '"ProRes 422"). Pass the path as preset.\n' +
      '- direct: export in Premiere and wait - Premiere is busy until it finishes. For short test renders.\n' +
      '- queue: hand the job to Media Encoder and return a jobId at once; start:false only queues it.\n' +
      '- status: jobId (and path to check the file).\n\n' +
      'range: entire (default), inOut (pr_sequence setInOut) or workArea.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['presets', 'direct', 'queue', 'status'] },
        sequenceId: sequenceIdSchema,
        path: { type: 'string' },
        preset: { type: 'string' },
        range: { type: 'string', enum: ['entire', 'inOut', 'workArea'] },
        jobId: { type: 'string' },
        start: { type: 'boolean' },
        match: { type: 'string' },
        limit: { type: 'number' },
        overwrite: { type: 'boolean' },
      },
      required: ['command'],
    },
  },
  {
    name: 'pr_capture',
    description:
      'LOOK at the edit rather than inferring it from the clip list. Returns a real image of the sequence as ' +
      'Premiere renders it.\n\n' +
      '- frame: one frame at time (seconds). longEdge defaults to 768px; cost scales with image area.\n' +
      '- frames: several times on ONE labelled contact sheet (longEdge per cell, default 320) - the cheap way ' +
      'to check every cut, title or photo move in a stretch of the edit.\n\n' +
      'The sequence becomes active and the playhead moves for the shot; both are put back.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['frame', 'frames'] },
        sequenceId: sequenceIdSchema,
        time: { type: 'number' },
        times: { type: 'array', items: { type: 'number' } },
        longEdge: { type: 'number' },
        columns: { type: 'number' },
      },
      required: ['command'],
    },
  },
  {
    name: 'pr_diagnostics',
    description:
      'Is the bridge healthy, and what is wrong with the project.\n\n' +
      '- health (default): Premiere version, bridge version, the active project, and whether the host answers.\n' +
      '- problems: offline media and empty sequences.\n' +
      '- log: the last host errors this server saw and the tail of the boot log.\n' +
      '- reloadHost: re-read the ExtendScript host from disk (CEP loads it once per Premiere start).',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['health', 'problems', 'log', 'reloadHost'] },
        limit: { type: 'number' },
      },
    },
  },
];

/* ---------- guards ---------- */

function protectedDirs() {
  return String(process.env.PREMIERE_MCP_PROTECTED_DIRS || '')
    .split(nodePath.delimiter).map((d) => d.trim()).filter(Boolean).map((d) => nodePath.resolve(d));
}

/** Throws unless p is absolute and outside every protected folder. Returns the resolved path. */
function checkWritePath(p, what = 'path') {
  if (typeof p !== 'string' || !nodePath.isAbsolute(p)) throw new Error(`bad_value: ${what} must be an absolute path`);
  const full = nodePath.resolve(p);
  let real = full;
  // Resolve symlinks on the nearest existing ancestor, so a link cannot smuggle a write into a protected folder.
  for (let dir = full; ; dir = nodePath.dirname(dir)) {
    try { real = nodePath.join(fs.realpathSync.native(dir), nodePath.relative(dir, full)); break; } catch (e) {
      if (dir === nodePath.dirname(dir)) break;
    }
  }
  // macOS and Windows disks are case-insensitive by default, so /Archive and /archive are one folder.
  // shortcut: Windows 8.3 short names and trailing dots are not normalised; add that if Windows renders are protected.
  const fold = process.platform === 'darwin' || process.platform === 'win32' ? (x) => x.normalize('NFC').toLowerCase() : (x) => x;
  for (const d of protectedDirs()) {
    let rd = d;
    try { rd = fs.realpathSync.native(d); } catch (e) { /* keep as given */ }
    for (const cand of [full, real]) {
      const rel = nodePath.relative(fold(rd), fold(cand));
      // "..cache" inside the folder is a name, not a step up: only ".." itself or "../" leaves it.
      const outside = rel === '..' || rel.startsWith('..' + nodePath.sep) || nodePath.isAbsolute(rel);
      if (!outside) {
        throw new Error(`protected: ${what} ${p} is inside protected folder ${d} (PREMIERE_MCP_PROTECTED_DIRS)`);
      }
    }
  }
  return full;
}

/* Free bytes on the disk holding p (or its nearest existing parent). */
function freeBytes(p) {
  let dir = nodePath.resolve(p);
  while (!fs.existsSync(dir) && dir !== nodePath.dirname(dir)) dir = nodePath.dirname(dir);
  // shortcut: df is macOS/Linux only; on Windows this throws and the render is refused - add a PowerShell probe when Windows renders are needed.
  // POSIX output keeps one line per disk; the numbers are matched before the % so names with spaces cannot shift them.
  const line = execFileSync('df', ['-kP', dir], { encoding: 'utf8' }).trim().split('\n').pop();
  const m = / (\d+) +(\d+) +(\d+) +\d+% /.exec(line);
  if (!m) throw new Error(`low_disk: could not read free space from df: ${line}`);
  return Number(m[3]) * 1024;
}

function minFreeBytes() {
  const gb = Number(process.env.PREMIERE_MCP_MIN_FREE_GB || 15);
  return (Number.isFinite(gb) && gb >= 0 ? gb : 15) * 1024 ** 3;
}

/* ---------- presets ---------- */

function presetRoots() {
  const roots = [];
  const apps = process.platform === 'win32' ? 'C:\\Program Files\\Adobe' : '/Applications';
  let entries = [];
  try { entries = fs.readdirSync(apps); } catch (e) { entries = []; }
  for (const name of entries) {
    if (/^Adobe Media Encoder/.test(name)) {
      roots.push(process.platform === 'win32'
        ? nodePath.join(apps, name, 'MediaIO', 'systempresets')
        : nodePath.join(apps, name, `${name}.app`, 'Contents', 'MediaIO', 'systempresets'));
    }
    if (/^Adobe Premiere Pro/.test(name)) {
      roots.push(process.platform === 'win32'
        ? nodePath.join(apps, name, 'Settings', 'EncoderPresets')
        : nodePath.join(apps, name, `${name}.app`, 'Contents', 'Settings', 'EncoderPresets'));
    }
  }
  roots.push(nodePath.join(os.homedir(), 'Documents', 'Adobe', 'Adobe Media Encoder'));
  return roots;
}

function listPresets(match, limit = 50, roots = presetRoots()) {
  const out = [];
  const want = String(match || '').toLowerCase();
  const walk = (dir, depth) => {
    let kids = [];
    try { kids = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const k of kids) {
      const full = nodePath.join(dir, k.name);
      if (k.isDirectory() && depth < 6) walk(full, depth + 1);
      else if (/\.epr$/i.test(k.name) && (!want || full.toLowerCase().includes(want))) out.push(full);
    }
  };
  roots.forEach((r) => walk(r, 0));
  out.sort();
  return { count: out.length, presets: out.slice(0, limit) };
}

/* ---------- capture ---------- */

/* exportFramePNG's naming is undocumented: accept the path as given or with .png appended. */
async function waitForFrame(file, timeoutMs = 20000) {
  const candidates = [file, `${file}.png`];
  const started = Date.now();
  for (;;) {
    for (const c of candidates) {
      let buf = null;
      try { buf = fs.readFileSync(c); } catch (e) { buf = null; }
      if (isCompletePng(buf)) return c;
    }
    if (Date.now() - started >= timeoutMs) {
      // A late write would otherwise be left in the temp folder for good.
      const sweep = () => candidates.forEach((c) => { try { fs.unlinkSync(c); } catch (e) {} });
      sweep();
      setTimeout(sweep, 30000).unref?.();
      throw new Error(`capture_failed: Premiere wrote no complete PNG at ${file} within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

const LONG_OPS = { timeline: 2 * 60 * 1000, render: 60 * 60 * 1000, captureFrame: 60 * 1000, project: 2 * 60 * 1000 };

/**
 * @param {(op:string,args:object,timeoutMs?:number)=>Promise<object>} callHost
 * @param {{freeBytes?: (p:string)=>number, presetRoots?: string[], bootLog?: string}} [deps] test seams
 */
function createToolRegistry(callHost, deps = {}) {
  const free = deps.freeBytes || freeBytes;
  const errors = [];

  async function host(op, args) {
    const res = await callHost(op, args, LONG_OPS[op]);
    if (!res.ok) {
      const e = res.error || {};
      errors.push({ at: new Date().toISOString(), op, code: e.code || 'error', message: e.message || 'unknown host failure' });
      if (errors.length > 20) errors.shift();
      throw new Error(`${e.code || 'error'}: ${e.message || 'unknown host failure'}`);
    }
    return res.result;
  }

  function existingRefused(p, overwrite) {
    if (!overwrite && fs.existsSync(p)) throw new Error(`exists: ${p} exists; pass overwrite:true to replace it`);
  }

  async function captureOne(args, time, edge) {
    const fileName = `pr${Date.now()}_${Math.round(Number(time || 0) * 1000)}.png`;
    const shot = await host('captureFrame', { sequenceId: args.sequenceId, time, fileName });
    const written = await waitForFrame(shot.path);
    return { ...shot, path: written, edge };
  }

  async function capture(args) {
    if (args.command === 'frames') {
      const times = Array.isArray(args.times) && args.times.length ? args.times : null;
      if (!times) throw new Error('bad_value: frames needs times, a list of seconds');
      const edge = args.longEdge || 320;
      const shots = [];
      const failed = [];
      try {
        for (const t of times) {
          try {
            const s = await captureOne(args, t, edge);
            shots.push({ path: s.path, label: `${s.time.seconds}s  f${s.time.frame}`, meta: s });
          } catch (err) { failed.push({ time: t, message: String(err.message || err) }); }
        }
        if (!shots.length) throw new Error(`No frames captured: ${JSON.stringify(failed)}`);
        const sheet = await buildContactSheet(shots, { columns: args.columns, maxEdge: edge });
        return {
          content: [
            { type: 'image', data: sheet.base64, mimeType: 'image/png' },
            { type: 'text', text: JSON.stringify({ frames: shots.map((s) => s.meta.time), errors: failed,
              sheet: { width: sheet.width, height: sheet.height, columns: sheet.columns, rows: sheet.rows } }, null, 2) },
          ],
        };
      } finally {
        shots.forEach((s) => { try { fs.unlinkSync(s.path); } catch (e) {} });
      }
    }
    if (args.command !== 'frame') throw new Error(`Unknown pr_capture command ${args.command}. Known: frame, frames`);
    const edge = args.longEdge || 768;
    const shot = await captureOne(args, args.time || 0, edge);
    try {
      const img = await renderCapture(shot.path, { background: null, maxEdge: edge });
      const { path, fileName, edge: _e, ...meta } = shot;
      if (img.width) { meta.imageWidth = img.width; meta.imageHeight = img.height; }
      return {
        content: [
          { type: 'image', data: img.base64, mimeType: 'image/png' },
          { type: 'text', text: JSON.stringify(meta, null, 2) },
        ],
      };
    } finally {
      try { fs.unlinkSync(shot.path); } catch (e) {}
    }
  }

  async function render(a) {
    if (a.command === 'presets') return textContent(listPresets(a.match, a.limit || 50, deps.presetRoots));
    if (a.command === 'status') return textContent(await host('render', a));
    if (a.command !== 'direct' && a.command !== 'queue') return errorContent(`Unknown pr_render command ${a.command}`);
    const out = checkWritePath(a.path, 'path');
    // Without an extension the encoder adds its own, and that file was never checked.
    if (!nodePath.extname(out)) throw new Error('bad_value: path must end in the extension the preset writes, e.g. .mp4 or .mov');
    existingRefused(out, a.overwrite);
    if (typeof a.preset !== 'string' || !fs.existsSync(a.preset)) {
      throw new Error(`missing_file: no export preset at ${a.preset}; list them with pr_render presets`);
    }
    const have = free(out);
    if (have < minFreeBytes()) {
      throw new Error(`low_disk: ${(have / 1024 ** 3).toFixed(1)} GiB free on the disk for ${out}, under the ` +
        `${(minFreeBytes() / 1024 ** 3).toFixed(0)} GiB floor (PREMIERE_MCP_MIN_FREE_GB). Nothing was rendered.`);
    }
    const result = await host('render', { ...a, path: out });
    return textContent({ ...result, freeGiBBefore: Number((have / 1024 ** 3).toFixed(1)) });
  }

  function bootLog(n) {
    const file = deps.bootLog || nodePath.join(os.tmpdir(), 'premiere-mcp-vision', 'boot.log');
    try { return fs.readFileSync(file, 'utf8').trim().split('\n').slice(-n); } catch (e) { return []; }
  }

  const QUERY_OPS = { sessionInfo: 1, tree: 1, clip: 1, propertyKeys: 1, sequencePresets: 1 };
  const PROJECT_WRITES = { new: 1, saveAs: 1 };
  // These write to (or make writable) the project file itself, so its own path is checked too.
  const PROJECT_IN_PLACE = { adopt: 1, save: 1 };

  const handlers = {
    pr_query: async (a) => {
      if (a.command === 'describe') {
        if (!a.tool) return textContent({ tools: TOOLS.map((t) => t.name), bridge: bridgeInfo() });
        const def = TOOLS.find((t) => t.name === a.tool);
        if (!def) return errorContent(`No tool named ${a.tool}. Known: ${TOOLS.map((t) => t.name).join(', ')}`);
        return textContent({ ...def, bridge: bridgeInfo() });
      }
      // Listed explicitly so a command name can never reach a mutating op through the read-only tool.
      if (!Object.prototype.hasOwnProperty.call(QUERY_OPS, a.command)) return errorContent(`Unknown pr_query command ${a.command}`);
      const out = await host(a.command, a);
      if (a.command === 'sessionInfo' && out && typeof out === 'object') out.bridge = bridgeInfo();
      return textContent(out);
    },
    pr_project: async (a) => {
      if (Object.prototype.hasOwnProperty.call(PROJECT_WRITES, a.command)) {
        const p = checkWritePath(a.path, 'path');
        existingRefused(p, a.overwrite);
        a = { ...a, path: p };
      }
      // The host gets the path that was checked, not the caller's spelling of it.
      if (a.command === 'open') a = { ...a, path: checkWritePath(a.path, 'project') };
      if (Object.prototype.hasOwnProperty.call(PROJECT_IN_PLACE, a.command) || (a.command === 'close' && a.save)) {
        const session = await host('sessionInfo', {});
        if (session.active && session.active.path) checkWritePath(session.active.path, 'project');
      }
      return textContent(await host('project', a));
    },
    pr_sequence: (a) => host('sequence', a).then(textContent),
    pr_clips: (a) => host('clips', a).then(textContent),
    pr_audio: (a) => host('audio', a).then(textContent),
    pr_motion: (a) => host('motion', a).then(textContent),
    pr_markers: (a) => host('markers', a).then(textContent),
    pr_effects: (a) => host('effects', a).then(textContent),
    pr_timeline: async (a) => {
      if (a.command === 'export') {
        const p = checkWritePath(a.path, 'path');
        existingRefused(p, a.overwrite);
        a = { ...a, path: p };
      }
      return textContent(await host('timeline', a));
    },
    pr_render: render,
    pr_capture: capture,
    pr_diagnostics: async (a) => {
      const cmd = a.command || 'health';
      if (cmd === 'problems') return textContent(await host('problems', a));
      if (cmd === 'log') return textContent({ hostErrors: errors.slice(-(a.limit || 20)), bootLog: bootLog(a.limit || 20) });
      if (cmd === 'reloadHost') {
        const before = await host('hostInfo', {});
        const after = await host('reloadHost', { hostPath: HOST_JSX });
        const reloaded = !after.reloadError && after.loadedAt !== before.loadedAt;
        return textContent({ reloaded, file: HOST_JSX, loadedAt: after.loadedAt, previousLoadedAt: before.loadedAt,
          opCount: after.opCount, error: after.reloadError || (reloaded ? null : 'the host was not re-evaluated - restart Premiere') });
      }
      if (cmd !== 'health') return errorContent(`Unknown pr_diagnostics command ${cmd}`);
      const out = { bridge: bridgeInfo(), hostReachable: false };
      try {
        const info = await host('hostInfo', {});
        out.hostReachable = true;
        out.appVersion = info.appVersion;
        out.opCount = info.opCount;
        const session = await host('sessionInfo', {});
        out.activeProject = session.active ? { name: session.active.name, path: session.active.path,
          ownedByBridge: session.active.ownedByBridge, sequences: session.active.sequences.length } : null;
      } catch (err) { out.error = String(err.message || err); }
      out.recentHostErrors = errors.length;
      return textContent(out);
    },
  };

  return {
    tools: TOOLS,
    async callTool(name, args) {
      const handler = handlers[name];
      if (!handler) return errorContent(`Unknown tool: ${name}`);
      try {
        return await handler(args || {});
      } catch (err) {
        return errorContent(String((err && err.message) || err));
      }
    },
  };
}

module.exports = { createToolRegistry, TOOLS, checkWritePath, listPresets, waitForFrame, freeBytes };
