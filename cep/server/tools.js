/*
 * The MCP tool surface: verb-dispatching tools, each covering several host ops.
 *
 * Shaped after the Rive MCP, which this project treats as the reference for
 * what "an agent can really build and see in here" looks like:
 *   - everything addressed by stable id, never by index
 *   - a discovery chain (find -> tree -> propertyKeys -> propertyValues -> set)
 *   - batch-shaped writes with per-item machine-readable errors
 *   - token cost stated in the description, because depth and image size are
 *     the two ways an agent accidentally burns a context window here
 *   - workflow guidance in the description, so the model follows the AE idiom
 *     instead of inventing a second comp when it should reuse the open one
 */

const fs = require('fs');
const nodePath = require('path');
const { buildContactSheet, flattenOnGrey } = require('./contact-sheet.js');
const { bridgeInfo } = require('./bridge-info.js');

/*
 * Absolute path to the ExtendScript entry point. $.fileName is not meaningful
 * for a script CEP loads via ScriptPath (it came back as "8"), so the Node side
 * - which does know where it lives - hands the path to reloadHost.
 */
const HOST_JSX = nodePath.join(__dirname, '..', 'host', 'host.jsx');

/*
 * Keys for ae_masks setPathKeys, read from a JSON file.
 *   - an array of {time, vertices}          -> used as-is
 *   - {keys: [...]}                          -> used as-is
 *   - an array of per-frame vertices/null    -> time = frame / fps
 *   - {fps, frames: [...]}                   -> the same
 * keysPointer is an RFC 6901 JSON Pointer into the file (e.g. "/add/0"), so a
 * tracker's own output works without a conversion step. fps comes from the
 * argument, else the selected node, else the file's root.
 */
const MAX_KEYS_FILE = 50 * 1024 * 1024;
function loadKeys(keysPath, keysPointer, fpsArg) {
  const nodePath = require('path');
  if (!nodePath.isAbsolute(String(keysPath))) throw new Error(`keysPath must be absolute, got ${keysPath}`);
  let stat;
  try { stat = fs.statSync(keysPath); } catch (e) { throw new Error(`keysPath: no file at ${keysPath}`); }
  if (stat.size > MAX_KEYS_FILE) throw new Error(`keysPath: ${keysPath} is ${(stat.size / 1e6).toFixed(1)} MB; split it (limit 50 MB)`);
  let root;
  try { root = JSON.parse(fs.readFileSync(keysPath, 'utf8')); } catch (e) { throw new Error(`keysPath: ${keysPath} is not valid JSON - ${e.message}`); }
  let node = root;
  if (keysPointer) {
    for (const raw of String(keysPointer).split('/').slice(1)) {
      const part = raw.replace(/~1/g, '/').replace(/~0/g, '~');
      if (node === null || typeof node !== 'object' || !(part in node)) throw new Error(`keysPointer ${keysPointer}: nothing at "${part}"`);
      node = node[part];
    }
  }
  const fromFrames = (frames, fps) => {
    const f = Number(fps);
    if (!(f > 0)) throw new Error('per-frame data needs an fps (argument, or "fps" in the file)');
    return frames.map((v, i) => ({ time: i / f, vertices: v }));
  };
  let keys;
  if (Array.isArray(node)) {
    const first = node.find((x) => x !== null && x !== undefined);
    keys = first && !Array.isArray(first) && typeof first === 'object' && 'time' in first
      ? node : fromFrames(node, fpsArg || root.fps);
  } else if (node && Array.isArray(node.keys)) {
    keys = node.keys;
  } else if (node && Array.isArray(node.frames)) {
    keys = fromFrames(node.frames, fpsArg || node.fps || root.fps);
  } else {
    throw new Error('keysPath: expected an array of keys, {keys:[...]}, per-frame vertices, or {fps, frames:[...]}');
  }
  if (!keys.length) throw new Error('keysPath: the file has no keys');
  return keys;
}

function textContent(value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

function errorContent(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// A property path segment: a matchName, a display name, or a 1-based index.
// Indexes are what ae_shapes returns for shape groups, since AE does not
// always resolve a long group name it was just given.
const PATH_SEGMENT = { type: ['string', 'number'] };

const TOOLS = [
  {
    name: 'ae_query',
    description:
      'Read the open After Effects project. START HERE - run sessionInfo first to see what is open, ' +
      'then tree, then propertyKeys on a specific layer.\n\n' +
      'Commands:\n' +
      '- sessionInfo: AE version, project name, and every composition with its id.\n' +
      '- tree: with compId, the comp\'s layers; without, the project item list.\n' +
      '- find: search layers (or scope:"items") by name substring and/or type.\n' +
      '- propertyKeys: EVERY addressable property on a layer as matchName paths. ' +
      'This is how you reach effects, masks, text animators and shape paths - not just transform. ' +
      'depth defaults to 2, which is transform plus effect group headers. Raise it to drill into ' +
      'ONE branch via `path`; a depth-6 walk of a shape layer can run to thousands of tokens.\n' +
      '- propertyValues: read specific properties by path, at `time` if given. Mask paths come back as ' +
      'a summary: vertexCount, closed, bbox, collapsed. Popups add label and options.\n' +
      '- selection: what the user currently has selected.\n' +      '- describe: the live schema of a tool ({tool:"ae_masks"}), straight from this server. Use it when ' +
      'a command or argument you expect is missing from your tool list - clients can cache definitions ' +
      'from session start.\n' +
      '- bounds: how large a layer ACTUALLY renders, via sourceRectAtTime. Use this before ' +
      'positioning text - a string\'s rendered width is not knowable from its font size, and ' +
      'guessing is how text ends up clipped or off-centre. Returns layer-space and an ' +
      'approximate comp-space box. A freshly created shape layer can report 0x0 until After ' +
      'Effects has evaluated it, so check `reliable` before trusting a zero.\n\n' +
      'Ids from these are stable across reorders and saves. Always address by id.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['sessionInfo', 'tree', 'find', 'propertyKeys', 'propertyValues', 'selection', 'bounds', 'describe'] },
        tool: { type: 'string', description: 'describe: the tool whose live schema to return, e.g. "ae_masks". Omit for every tool name.' },
        compId: { type: 'number', description: 'Composition id. Defaults to the active comp.' },
        layerId: { type: 'number', description: 'Layer id, required by propertyKeys and propertyValues.' },
        name: { type: 'string', description: 'find: case-insensitive substring.' },
        type: { type: 'string', description: 'find: e.g. TextLayer, ShapeLayer, AVLayer, Composition, Footage.' },
        scope: { type: 'string', enum: ['layers', 'items'], description: 'find scope. Default layers.' },
        path: { type: 'array', items: PATH_SEGMENT, description: 'propertyKeys: matchName path to start from.' },
        paths: { type: 'array', items: { type: 'array', items: PATH_SEGMENT }, description: 'propertyValues: matchName paths to read.' },
        depth: { type: 'number', description: 'propertyKeys depth, 1-8. Default 2. Start shallow.' },
        includeValues: { type: 'boolean', description: 'propertyKeys: include current values. Roughly doubles output size.' },
        time: { type: 'number', description: 'bounds/propertyValues: evaluate at this time (comp seconds). Defaults to the playhead; propertyValues reports the time it used.' },
        includeExtents: { type: 'boolean', description: 'bounds: include masks and effects in the box.' },
        limit: { type: 'number', description: 'find: max matches. Default 100.' },
      },
      required: ['command'],
    },
  },
  {
    name: 'ae_set',
    description:
      'Write property values or expressions. Batch-shaped: pass every write in ONE call rather than ' +
      'calling once per property - each call is a round trip into AE.\n\n' +
      'Paths are matchName arrays from ae_query propertyKeys, e.g. ' +
      '["ADBE Transform Group","ADBE Position"]. Note 2D layers expose "ADBE Rotate Z", not ' +
      '"ADBE Rotation".\n\n' +
      'Give a write a `time` to make it a keyframe instead of a static value.\n\n' +      'POPUP parameters (Stroke Paint Style, Glow Composite Original, ...) take their menu label as ' +
      'the value - "On Transparent" - rather than a guessed integer; a wrong label errors with the ' +
      'options. ae_query propertyValues shows value, label and options for a popup.\n\n' +
      'A `warnings` array flags writes AE accepts but ignores - e.g. alpha on a shape fill or stroke colour, ' +
      'which renders opaque; the warning names the Opacity property to set instead.\n\n' +
      'Partial success is normal: the response reports appliedCount plus a per-item errors array ' +
      'with codes (unknown_id, unknown_path, type_mismatch, not_a_property, invalid_expression). ' +
      'One bad path does not discard the rest of the batch. The whole batch is a single undo step.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['values', 'expressions'], description: 'Default values.' },
        writes: {
          type: 'array',
          description: 'For values: [{layerId, path, value, time?}]. For expressions: [{layerId, path, expression}].',
          items: {
            type: 'object',
            properties: {
              layerId: { type: 'number' },
              path: { type: 'array', items: PATH_SEGMENT },
              value: { description: 'Number for 1D, array for 2D/3D/colour - colour channels are 0-1, NOT 0-255. For a text document: a string, or {text,fontSize,font,justification,fillColor,tracking,leading}; font takes a PostScript name, a family ("Courier New") or "Family Style". Point text anchors at the baseline LEFT, so centre it with justification:"center" rather than by nudging position.' },
              expression: { type: 'string' },
              time: { type: 'number', description: 'Present = write a keyframe at this time.' },
            },
            required: ['layerId', 'path'],
          },
        },
      },
      required: ['writes'],
    },
  },
  {
    name: 'ae_animate',
    description:
      'Add, remove and read keyframes on one property. add and remove apply in the same call; ' +
      'removals are processed first. Returns the full key list afterwards so you can verify without ' +
      'a second round trip. For a static value with no keyframe, use ae_set instead.\n\n' +
      'Keyframes are LINEAR by default, which reads mechanically. Pass `ease` to apply temporal ' +
      'easing afterwards: ease.influence is the percentage AE shows in its Keyframe Velocity ' +
      'dialog (try 60-75 for UI motion), and ease.mode is in, out or both.',
    inputSchema: {
      type: 'object',
      properties: {
        layerId: { type: 'number' },
        path: { type: 'array', items: PATH_SEGMENT },
        add: { type: 'array', items: { type: 'object', properties: { time: { type: 'number' }, value: {}, hold: { type: 'boolean', description: 'Freeze this value until the next key - for cuts and stepped motion.' } }, required: ['time', 'value'] } },
        remove: { type: 'array', items: { type: 'number' }, description: '1-based key indices to delete.' },
        ease: {
          type: 'object',
          description: 'Apply temporal easing after the add/remove.',
          properties: {
            influence: { type: 'number', description: '0.1-100. AE\'s Keyframe Velocity influence.' },
            mode: { type: 'string', enum: ['in', 'out', 'both'] },
            keyIndices: { type: 'array', items: { type: 'number' }, description: 'Default: all keys.' },
          },
        },
      },
      required: ['layerId', 'path'],
    },
  },
  {
    name: 'ae_layers',
    description:
      'Create and manage layers. REUSE WHAT IS THERE: run ae_query tree first and operate on ' +
      'existing layers by id. Creating a duplicate layer when one already exists is the most common ' +
      'way to make a mess of someone\'s project.\n\n' +
      'create* commands need a compId (or default to the active comp). Every other command needs a ' +
      'layerId. reorder takes a 1-based target index; ids stay valid across reorders.\n\n' +
      'createText makes POINT text, which does not wrap. For a wrapping copy block use ' +
      'createBoxText with a width and height. organise sets label colour, shy, guide-layer, solo ' +
      'and comment - project hygiene that separates handoff-ready work from junk.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['createText', 'createBoxText', 'createSolid', 'createShape', 'createNull', 'delete', 'duplicate', 'rename', 'select', 'setEnabled', 'setLocked', 'reparent', 'reorder', 'setCollapse', 'applyPreset', 'organise'] },
        compId: { type: 'number' },
        layerId: { type: 'number' },
        name: { type: 'string' },
        text: { type: 'string', description: 'createText content.' },
        color: { type: 'array', items: { type: 'number' }, description: 'createSolid RGB, 0-1.' },
        width: { type: 'number' },
        height: { type: 'number' },
        index: { type: 'number', description: 'reorder target, 1-based.' },
        parentLayerId: { type: ['number', 'null'], description: 'reparent target, or null to unparent.' },
        enabled: { type: 'boolean' },
        locked: { type: 'boolean' },
        selected: { type: 'boolean' },
        label: { type: 'number', description: 'organise: AE label colour index 0-16.' },
        shy: { type: 'boolean' },
        guideLayer: { type: 'boolean' },
        solo: { type: 'boolean' },
        comment: { type: 'string' },
        path: { type: 'string', description: 'applyPreset: absolute path to a .ffx.' },
      },
      required: ['command'],
    },
  },
  {
    name: 'ae_effects',
    description:
      'Apply, remove and list effects. listAvailable returns every installed effect with its ' +
      'matchName - it is a long list, so filter it yourself rather than echoing it back. ' +
      'Apply by matchName (e.g. "ADBE Gaussian Blur 2"). ' +
      'To reach an applied effect\'s parameters, call ae_query propertyKeys with ' +
      'path:["ADBE Effect Parade"] and depth:3.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['list', 'listAvailable', 'apply', 'remove'] },
        layerId: { type: 'number' },
        matchName: { type: 'string' },
        name: { type: 'string', description: 'Optional display name for an applied effect.' },
      },
      required: ['command'],
    },
  },
  {
    name: 'ae_project',
    description:
      'Project-level operations: create compositions, import footage, add items to comps, delete ' +
      'items, save. Import takes an absolute path. save on an untitled project needs an explicit ' +
      'path, and creates missing folders. Prefer working in the comp the user already has open over ' +
      'creating new ones.\n\n' +
      'HANDING A PROJECT TO SOMEONE: renameItem (comps, footage, folders - ae_layers rename is layers ' +
      'only), createFolder, moveToFolder, replaceFootage (relink; sequence:true for an image ' +
      'sequence), and collect - copies every file-based footage item into <folder>/Footage, relinks ' +
      'it, and saves the .aep into <folder>. Like AE\'s Collect Files the original .aep on disk is ' +
      'untouched, but the OPEN project becomes the collected copy. Image sequences are reported in ' +
      '"skipped", not copied.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['createComp', 'import', 'addToComp', 'deleteItem', 'save', 'new', 'open', 'close', 'renameItem', 'createFolder', 'moveToFolder', 'replaceFootage', 'collect'] },
        name: { type: 'string' },
        width: { type: 'number' },
        height: { type: 'number' },
        duration: { type: 'number' },
        frameRate: { type: 'number' },
        pixelAspect: { type: 'number' },
        path: { type: 'string', description: 'import source, save destination (missing folders are created), or replaceFootage\'s new file.' },
        importAs: { type: 'string', enum: ['footage', 'composition'] },
        itemId: { type: 'number' },
        compId: { type: 'number' },
        overwrite: { type: 'boolean', description: 'save: required to overwrite an existing project file.' },
        discardUnsaved: { type: 'boolean', description: 'new/open: required to abandon unsaved changes in the current project.' },
        itemIds: { type: 'array', items: { type: 'number' }, description: 'moveToFolder: the items to move.' },
        folderId: { type: 'number', description: 'moveToFolder: destination folder id. Omit for the project root.' },
        parentFolderId: { type: 'number', description: 'createFolder: parent folder id. Omit for the project root.' },
        sequence: { type: 'boolean', description: 'replaceFootage: path is the first frame of an image sequence.' },
        folder: { type: 'string', description: 'collect: absolute folder to collect into (created if missing).' },
        projectName: { type: 'string', description: 'collect: file name for the collected .aep. Default: the current project\'s name.' },
      },
      required: ['command'],
    },
  },
  {
    name: 'ae_capture',
    description:
      'LOOK at what is actually rendered, rather than inferring it from the object tree. Returns a ' +
      'real image.\n\n' +
      '- frame: one still. longEdge defaults to 512, which is plenty to judge layout, composition, ' +
      'alignment and colour. Ask for more only to read small text; cost scales with image area.\n' +
      '- sequence: N frames across a time range composited into ONE labelled contact sheet. Use this ' +
      'for anything involving motion - a single still cannot show it, and one sheet costs far less ' +
      'context than N images.\n' +
      '- isolated: solo one layer and capture it alone. This is the tool for "why is this not ' +
      'visible" - it separates "drawn but hidden behind something" from "not drawn at all".\n\n' +
      'Captures composite onto mid grey, so a transparent region reads as transparent rather than ' +
      'being mistaken for a black or white fill.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['frame', 'sequence', 'isolated'] },
        compId: { type: 'number' },
        layerId: { type: 'number', description: 'Required by isolated.' },
        time: { type: 'number', description: 'Seconds. Defaults to the comp playhead.' },
        startTime: { type: 'number' },
        endTime: { type: 'number' },
        count: { type: 'number', description: 'sequence frame count, 2-24. Default 6.' },
        columns: { type: 'number', description: 'sequence sheet columns. Default is roughly square.' },
        longEdge: { type: 'number', description: 'Longest edge in px. Default 512 for frame, 320 per cell for sequence.' },
      },
      required: ['command'],
    },
  },
  {
    name: 'ae_masks',
    description:
      'Masks on a layer: rectangles, arbitrary paths, and whole animated roto paths from a tracker ' +
      '(one call, keys read from disk if you like), with modes, feather and rename.\n\n' +
      'This is how you reveal part of a layer WITHOUT scaling it. Scaling squashes artwork; ' +
      'a mask reveals it. If you are translating a design where a fixed-size asset is shown ' +
      'progressively (an accordion, a wipe, a progress bar), this is the tool, not ae_set scale.\n\n' +
      'Mask vertices are in LAYER space: (0,0) is the layer\'s top-left corner, not the comp ' +
      'origin and not the anchor point. A rect from (0,0) sized w x h crops the layer to its ' +
      'first w pixels.\n\n' +
      'Pass a `time` to setRect to make the mask shape a keyframe, so the reveal animates. ' +
      'Call add once, then setRect repeatedly at different times.\n\n' +
      'setPath takes arbitrary vertices for non-rectangular masks, and setFeather softens the ' +
      'edge (also keyframeable). To clip a layer to the SHAPE of another layer rather than to a ' +
      'path, use ae_compose setTrackMatte instead.\n\n' +
      'ROTO / ANIMATED PATHS: use setPathKeys, not setPath in a loop. It writes a whole ' +
      'animated path in ONE call: keys:[{time, vertices}], all keys, one undo step. ' +
      'A 505-frame roto mask is one call instead of 505. Pass hold:true when the outline\'s ' +
      'point count changes between frames (traced or tracked shapes) - linear interpolation ' +
      'between mismatched outlines morphs unpredictably. vertices:null marks a frame where the ' +
      'mask shows nothing; the tool keys Mask Opacity to 0 there (as holds) automatically, and ' +
      'collapses the path to a point so no stale outline is drawn in the viewer. ' +
      'A request body is capped at 5 MB: about 490,000 vertices with integer coordinates, half ' +
      'that with decimals (a 505-frame, 83,000-vertex roto mask is 0.9 MB). Split a larger job across ' +
      'calls by time range - keys from later calls are added alongside earlier ones, and each call owns ' +
      'the Mask Opacity keys inside its own time range, so split calls cannot leave each other stuck at 0.\n\n' +
      'FROM A FILE: pass keysPath (absolute) instead of keys - tracker output goes straight from disk, ' +
      'costing no tokens. keysPointer selects inside the file ("/add/0"); per-frame arrays use fps.\n\n' +
      'TIME BASE: key times are COMP seconds by default. A tracker file indexes frames of the clip, so ' +
      'on a layer whose startTime was shifted pass timeBase:"layer" (maps through startTime and ' +
      'stretch) rather than zeroing startTime around the call. timeOffset adds seconds on top.\n\n' +
      'MODES: pass mode on add, or call setMode. Holes (the gap between an arm and a torso) ' +
      'need mode:"subtract" on their own mask - inverting a mask is not the same thing.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['add', 'setRect', 'setPath', 'setPathKeys', 'setMode', 'rename', 'setFeather', 'list', 'remove'] },
        layerId: { type: 'number' },
        maskIndex: { type: 'number', description: 'Defaults to the most recently added mask.' },
        maskName: { type: 'string', description: 'setPathKeys/setMode/rename: address a mask by name instead of index.' },
        newName: { type: 'string', description: 'rename: the new mask name.' },
        name: { type: 'string' },
        left: { type: 'number', description: 'Rect left in layer space. Default 0.' },
        top: { type: 'number', description: 'Rect top in layer space. Default 0.' },
        width: { type: 'number' },
        height: { type: 'number' },
        time: { type: 'number', description: 'Present = keyframe the mask shape at this time.' },
        inverted: { type: 'boolean' },
        feather: { type: 'number' },
        expansion: { type: 'number' },
        vertices: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: 'setPath: [[x,y], ...] in layer space, 3 or more.' },
        closed: { type: 'boolean', description: 'setPath. Default true.' },
        keys: {
          type: 'array',
          description: 'setPathKeys: [{time, vertices, closed?}]. time in comp seconds; vertices [[x,y],...] in ' +
            'layer space, 3 or more, or null for "no shape this frame" (Mask Opacity is keyed to 0 there).',
          items: {
            type: 'object',
            properties: {
              time: { type: 'number' },
              vertices: { type: ['array', 'null'], items: { type: 'array', items: { type: 'number' } } },
              closed: { type: 'boolean' },
            },
            required: ['time'],
          },
        },
        keysPath: { type: 'string', description: 'setPathKeys: absolute path to a JSON file of keys, instead of passing them inline. ' +
          'Accepts [{time, vertices}], {keys:[...]}, per-frame [vertices|null, ...], or {fps, frames:[...]}. Use this for tracker ' +
          'output - inline vertices cost the agent tokens for every point.' },
        keysPointer: { type: 'string', description: 'setPathKeys: JSON Pointer into keysPath\'s file, e.g. "/add/0" for slot 0 of {add:[[...]]}.' },
        fps: { type: 'number', description: 'setPathKeys with per-frame data: frames per second (time = frame/fps). Defaults to the file\'s "fps".' },
        timeBase: { type: 'string', enum: ['comp', 'layer'], description: 'setPathKeys: what key times (and per-frame file indexes) are measured in. comp (default) = comp seconds, which is what AE stores. layer = the layer\'s own clip time, mapped through its startTime and stretch - use it for a clip-wide tracker file on a layer that has been shifted.' },
        timeOffset: { type: 'number', description: 'setPathKeys: seconds added to every key time, after timeBase.' },
        hold: { type: 'boolean', description: 'setPathKeys: make every key in this call a hold keyframe. Use for traced/tracked outlines.' },
        mode: { type: 'string', enum: ['add', 'subtract', 'intersect', 'lighten', 'darken', 'difference', 'none'],
          description: 'add/setMode: mask blend mode. Default for a new mask is add.' },
      },
      required: ['command', 'layerId'],
    },
  },
  {
    name: 'ae_timing',
    description:
      'When things happen: layer in/out points, comp duration and frame rate, and markers.\n\n' +
      'Without this every layer spans the whole composition, which is almost never what a real ' +
      'sequence looks like. setLayer applies startTime FIRST and then in/out, because moving ' +
      'startTime shifts both by the same amount - so writing them in the other order silently ' +
      'gives a different result.\n\n' +
      'setComp can change duration, frameRate and size AFTER the comp exists. Markers attach to ' +
      'a comp, or to a layer when you pass layerId, and readMarkers reads them back so you can ' +
      'drive timing off markers a human placed.\n\n' +
      'setTimeRemap enables time remapping - note AE auto-creates two keyframes and changes the ' +
      'layer outPoint, both reported back. setMotionBlur switches it on for the layer AND the comp, ' +
      'since the layer flag alone does nothing. separateDimensions splits Position into X and Y so ' +
      'they can be eased independently.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['setLayer', 'setComp', 'addMarker', 'readMarkers', 'setTimeRemap', 'setMotionBlur', 'separateDimensions'] },
        layerId: { type: 'number' },
        compId: { type: 'number' },
        inPoint: { type: 'number', description: 'Seconds. When the layer starts being visible.' },
        outPoint: { type: 'number' },
        startTime: { type: 'number', description: 'Shifts the layer in time, moving in/out with it.' },
        stretch: { type: 'number', description: 'Time stretch percentage. 100 is normal, 200 is half speed.' },
        duration: { type: 'number' },
        frameRate: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
        workAreaStart: { type: 'number' },
        workAreaDuration: { type: 'number' },
        time: { type: 'number', description: 'addMarker: where to place it.' },
        comment: { type: 'string', description: 'addMarker: the marker text.' },
        protectedRegion: { type: 'boolean', description: 'addMarker: Responsive Design - Time. A protected region plays at original speed when an editor retimes the template downstream.' },
        enabled: { type: 'boolean' },
        enableForComp: { type: 'boolean', description: 'setMotionBlur: also switch it on for the comp. Default true - a layer\'s motion blur does nothing without it.' },
        path: { type: 'array', items: PATH_SEGMENT, description: 'separateDimensions: defaults to Position.' },
      },
      required: ['command'],
    },
  },
  {
    name: 'ae_shapes',
    description:
      'Create shape layers with real vector geometry: rect, ellipse, polygon, star, or a freeform ' +
      'path from vertices.\n\n' +
      'Prefer this over a solid whenever the geometry itself should animate. A rectangle\'s Size ' +
      'is a real animatable property, so a bar that grows is a Size keyframe rather than a scale ' +
      'that stretches the artwork. Solids can only scale.\n\n' +
      'The response includes a `paths` map of matchName paths to every animatable property it ' +
      'created - size, roundness, fill colour, stroke width, group transform - so you can drive ' +
      'them with ae_set or ae_animate without reconstructing the vector tree yourself.\n\n' +
      'addOperator adds the things that make a shape layer useful for motion graphics:\n' +
      '- trim: the draw-on. Animate End 0 to 100. Offsetting Start behind End gives a travelling dash.\n' +
      '- repeater: N copies with a per-copy transform. Animating its Offset is the native way to ' +
      'stagger copies without expressions.\n' +
      '- merge: boolean path ops. Note Lottie does not support these.\n' +
      '- offset / round / wiggle / zigzag / twist: path distortions.\n\n' +
      'It returns `paths` for the operator too, so you can keyframe Trim End directly. Placement ' +
      'matters: a repeater above vs below the fill changes how gradients repeat, so operators go ' +
      'inside the shape group by default, matching the UI.\n\n' +
      'setDash dashes a stroke. Dashes are an INDEXED group, so a Dash element has to be added ' +
      'before any value can be set - which is why naively setting a dash property never works. ' +
      'Combine a dashed stroke with trim paths for progress rings.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['create', 'addOperator', 'removeOperator', 'listOperators', 'setDash'] },
        compId: { type: 'number' },
        kind: { type: 'string', enum: ['rect', 'ellipse', 'polygon', 'star', 'path'] },
        name: { type: 'string' },
        width: { type: 'number' },
        height: { type: 'number' },
        roundness: { type: 'number', description: 'rect only: corner radius.' },
        points: { type: 'number', description: 'polygon/star: number of points.' },
        outerRadius: { type: 'number' },
        innerRadius: { type: 'number', description: 'star only.' },
        vertices: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: 'path only: [[x,y], ...].' },
        closed: { type: 'boolean', description: 'path only. Default true.' },
        fill: { description: 'RGBA 0-1 array, or false for no fill. Defaults to white. AE ignores a shape colour\'s alpha, so alpha below 1 is written to Fill Opacity instead.' },
        stroke: { type: 'array', items: { type: 'number' }, description: 'RGBA 0-1. Omit for no stroke. Alpha below 1 goes to Stroke Opacity.' },
        strokeWidth: { type: 'number' },
        position: { type: 'array', items: { type: 'number' } },
        layerId: { type: 'number', description: 'Required by the operator commands.' },
        kind: { type: 'string', description: 'Also: trim, repeater, merge, offset, round, wiggle, zigzag, twist for addOperator.' },
        groupIndex: { type: 'number', description: 'Which shape group to add the operator into. Default 1.' },
        start: { type: 'number', description: 'trim: Start %.' },
        end: { type: 'number', description: 'trim: End %.' },
        copies: { type: 'number', description: 'repeater: number of copies.' },
        offset: { type: 'number', description: 'trim or repeater offset.' },
        amount: { type: 'number' },
        radius: { type: 'number' },
        dash: { type: 'number', description: 'setDash: dash length.' },
        gap: { type: 'number', description: 'setDash: gap length.' },
      },
      required: ['command'],
    },
  },
  {
    name: 'ae_compose',
    description:
      'Structure: grouping, clipping by another layer, blend modes, parenting, 3D.\n\n' +
      '- precompose: collapse layers into a nested composition. Use it when many layers must move ' +
      'together - one parent moving beats N layers each carrying identical keyframes.\n' +
      '- setTrackMatte: clip a layer to the alpha or luma of ANOTHER layer. This is the tool for ' +
      'non-rectangular clipping; ae_masks covers rectangles. The matte layer does not need to be ' +
      'adjacent.\n' +
      '- parent: by default the child keeps its on-screen position (setParentWithJump). Pass ' +
      'keepPosition:false to keep its raw numbers and let it jump instead.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['precompose', 'setTrackMatte', 'setBlendMode', 'parent', 'set3D', 'addCamera'] },
        compId: { type: 'number' },
        layerId: { type: 'number' },
        layerIds: { type: 'array', items: { type: 'number' }, description: 'precompose: layers to collapse.' },
        name: { type: 'string' },
        moveAttributes: { type: 'boolean', description: 'precompose: move transforms into the new comp. Default true.' },
        matteLayerId: { type: ['number', 'null'], description: 'setTrackMatte: null removes the matte.' },
        type: { type: 'string', enum: ['alpha', 'alphaInverted', 'luma', 'lumaInverted'] },
        mode: { type: 'string', description: 'setBlendMode: normal, multiply, screen, overlay, add, darken, lighten, difference, softLight, hardLight, colorDodge, colorBurn, hue, saturation, color, luminosity.' },
        parentLayerId: { type: ['number', 'null'] },
        keepPosition: { type: 'boolean', description: 'parent: default true, keeps the child on screen.' },
        enabled: { type: 'boolean' },
      },
      required: ['command'],
    },
  },
  {
    name: 'ae_render',
    description:
      'Render a composition to a real file through the render queue. This is the deliverable; ' +
      'ae_capture is for looking, not for output.\n\n' +
      'BLOCKING and potentially slow - a long comp can take minutes, and After Effects is ' +
      'unresponsive throughout. Render a short range first if you are unsure.\n\n' +
      'Format is not directly settable in After Effects scripting, so it comes from an output ' +
      'module template. Run listTemplates to see what this machine has; "Lossless" and the H.264 ' +
      'presets are usually present. Any other queued items are disabled during the render and ' +
      'restored afterwards, so this never renders somebody else\'s queue.\n\n' +
      'OUTPUT: a missing output folder is created. With no omTemplate the template follows the ' +
      'extension (.mp4 -> H.264, .mov -> Lossless, .tif -> TIFF sequence); a template that would write ' +
      'a different extension is an error rather than a silently renamed file. A job that produces no ' +
      'file is reported in errors. Rendering never changes the project: batch removes its queue items ' +
      'and restores paused ones even when a render fails.\n\n' +
      'batch takes N jobs and renders them in ONE pass - ad delivery is N comps by M formats, and ' +
      'one blocking call per output does not scale. queueInAME hands off to Media Encoder for real ' +
      'bitrate control, but note AME CANNOT export alpha: for RGB+Alpha use command render with an ' +
      'alpha output module template.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['render', 'batch', 'queueInAME', 'listTemplates'] },
        compId: { type: 'number' },
        outputPath: { type: 'string', description: 'Absolute path with a media extension.' },
        omTemplate: { type: 'string', description: 'Output module template name. Default: chosen from the outputPath extension.' },
        rsTemplate: { type: 'string', description: 'Render settings template, e.g. "Best Settings".' },
        startTime: { type: 'number' },
        endTime: { type: 'number' },
        overwrite: { type: 'boolean', description: 'Required to replace an existing file.' },
        jobs: {
          type: 'array',
          description: 'batch: [{compId, outputPath, omTemplate?, rsTemplate?, overwrite?}]. Queued together and rendered in one pass. ' +
            'overwrite on a job, or on the whole call, replaces an existing file.',
          items: { type: 'object', properties: {
            compId: { type: 'number' }, outputPath: { type: 'string' },
            omTemplate: { type: 'string' }, rsTemplate: { type: 'string' },
            overwrite: { type: 'boolean', description: 'Replace this job\'s existing output file.' },
          }, required: ['compId', 'outputPath'] },
        },
        renderImmediately: { type: 'boolean', description: 'queueInAME: start AME rendering rather than just queueing.' },
      },
      required: ['command'],
    },
  },
  {
    name: 'ae_layout',
    description:
      'Layout: the thing After Effects has no engine for. There is no align API in AE at all, no ' +
      'distribute, no grid, no padding - every position is absolute arithmetic. These compose ' +
      'measure-and-place so you do not do that arithmetic yourself.\n\n' +
      'Commands:\n' +
      '- measure: rendered bounds in COMP space. Handles the sourceRectAtTime traps for you - it ' +
      'ignores layer Scale, returns layer space, and desyncs on time-offset layers. Reports ' +
      '`reliable:false` rather than lying when a fresh shape layer measures 0x0.\n' +
      '- anchor: move the anchor to a corner or centre WITHOUT the layer moving. Setting an anchor ' +
      'alone shifts the layer by the anchor delta; this compensates Position and returns `movedBy` ' +
      'so you can verify it stayed put.\n' +
      '- align: to each other or to the comp. distribute: by equal `gaps` between boxes (usually ' +
      'what is meant) or equal `centers`.\n' +
      '- stack: row, column or grid with a gap. This is the reflow primitive - a four-tile ' +
      'accordion is one stack call rather than dozens of hand-computed keyframes.\n' +
      '- pin: to a comp edge or corner with padding.\n' +
      '- fit: size a SHAPE layer to hug another layer plus padding. The pill-behind-text unit.\n' +
      '- stagger: offset layers in time. IDEMPOTENT - base times are recorded, so running it twice ' +
      're-derives instead of compounding.\n\n' +
      'mode: "static" bakes pixels; "rigged" bakes them AND attaches an expression on top, so the ' +
      'layout follows later edits. A rigged value degrades to the baked pixels if the expression ' +
      'errors - and note Lottie native players and Rive ignore expressions entirely, so bake before ' +
      'those exports.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['measure', 'anchor', 'align', 'distribute', 'stack', 'pin', 'fit', 'stagger'] },
        compId: { type: 'number' },
        layerId: { type: 'number' },
        layerIds: { type: 'array', items: { type: 'number' } },
        toLayerId: { type: 'number', description: 'fit: the layer to hug.' },
        to: { type: 'string', enum: ['topLeft','topCenter','topRight','middleLeft','center','middleRight','bottomLeft','bottomCenter','bottomRight'], description: 'anchor / pin target.' },
        align: { type: 'string', enum: ['left','right','centerX','top','bottom','centerY','center'] },
        relativeTo: { type: 'string', enum: ['selection', 'comp'] },
        axis: { type: 'string', enum: ['horizontal', 'vertical'] },
        by: { type: 'string', enum: ['gaps', 'centers'] },
        direction: { type: 'string', enum: ['row', 'column', 'grid'] },
        columns: { type: 'number', description: 'grid only.' },
        gap: { type: 'number' },
        x: { type: 'number', description: 'stack origin. Defaults to where the first layer already is.' },
        y: { type: 'number' },
        padding: { type: 'number' },
        paddingX: { type: 'number' },
        paddingY: { type: 'number' },
        step: { type: 'number', description: 'stagger: seconds between layers.' },
        from: { type: 'number', description: 'stagger: time the first layer starts at.' },
        order: { type: 'string', enum: ['listed', 'index', 'reverse'] },
        time: { type: 'number', description: 'Measure at this time. Defaults to the playhead.' },
        mode: { type: 'string', enum: ['static', 'rigged'] },
      },
      required: ['command'],
    },
  },
  {
    name: 'ae_text',
    description:
      'Text animators and range selectors - how essentially every per-character and per-word ' +
      'reveal is built. This is the most common text technique in commercial motion graphics and ' +
      'is not reachable any other way.\n\n' +
      'add creates an animator with the properties you name (opacity, position, scale, rotation, ' +
      'tracking, blur, fillColor, charOffset) plus a range selector, and returns matchName `paths` ' +
      'for the selector\'s Start / End / Offset. Animate those to run the reveal - ' +
      'typically offset from -100 to 100, or start from 0 to 100.\n\n' +
      '`basedOn` is the choice that matters: `characters` gives a per-letter reveal, `words` gives ' +
      'per-word. Art direction asks for one or the other constantly and they look completely ' +
      'different. A typewriter is properties:["opacity"], basedOn:"characters", shape:"square", ' +
      'then animate start 0 to 100.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['add', 'list', 'remove'] },
        layerId: { type: 'number' },
        name: { type: 'string' },
        properties: {
          type: 'array',
          items: { type: 'string', enum: ['opacity', 'position', 'scale', 'rotation', 'tracking', 'blur', 'fillColor', 'charOffset'] },
          description: 'What the animator changes. Default ["opacity"].',
        },
        basedOn: { type: 'string', enum: ['characters', 'charactersExcludingSpaces', 'words', 'lines'] },
        shape: { type: 'string', enum: ['square', 'rampUp', 'rampDown', 'triangle', 'round', 'smooth'] },
        units: { type: 'string', enum: ['percent', 'index'] },
      },
      required: ['command', 'layerId'],
    },
  },
  {
    name: 'ae_template',
    description:
      'Essential Graphics: expose properties so a downstream editor can change them, and export a ' +
      '.mogrt. This is After Effects\' native answer to a parameterised template, and what a ' +
      '.mogrt consumer actually interacts with.\n\n' +
      'Only some property types can be exposed: single-value numerics, 2D points, angle, checkbox, ' +
      'colour, source text, dropdown, media replacement. THREE-dimensional properties and paths are ' +
      'rejected - exposing a 3D layer\'s Position will fail. expose pre-flights with ' +
      'canAddToMotionGraphicsTemplate and reports why rather than silently doing nothing.\n\n' +
      'Pair this with expression controls: apply a Slider Control via ae_effects, drive real ' +
      'properties from it with an expression, then expose only the slider. That is the standard rig.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['expose', 'listExposed', 'exportMogrt'] },
        compId: { type: 'number' },
        layerId: { type: 'number' },
        path: { type: 'array', items: PATH_SEGMENT, description: 'expose: matchName path to the property.' },
        name: { type: 'string', description: 'expose: display name shown to the editor. Default names are useless - set this.' },
        overwrite: { type: 'boolean' },
      },
      required: ['command'],
    },
  },
  {
    name: 'ae_diagnostics',
    description:
      'What is wrong with this project: missing footage, substituted or missing fonts, and broken ' +
      'expressions. After Effects has no single problems API, so this assembles all three. ' +
      'Run it when something renders wrong and the object tree looks fine - a silently-substituted ' +
      'font or a disabled expression will not show up anywhere else.',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          enum: ['problems', 'reloadHost', 'effectEnums'],
          description:
            'Default problems. reloadHost re-reads the ExtendScript host from disk - CEP loads it ' +
            'once per extension start, so host edits are otherwise invisible until AE restarts.',
        },
        maxLayers: { type: 'number', description: 'Cap on layers scanned for expression errors. Default 400.' },
        offset: { type: 'number', description: 'effectEnums (maintainers only, scratch project): first effect of the batch.' },
        limit: { type: 'number', description: 'effectEnums: effects per batch. Default 25.' },
      },
    },
  },
];

/**
 * @param {(op:string,args:object,timeoutMs?:number)=>Promise<object>} callHost
 */
function createToolRegistry(callHost) {
  /*
   * Most ops answer in milliseconds. A render does not: renderQueue.render()
   * blocks until the job finishes, so it gets its own long ceiling rather than
   * timing out on every real output.
   */
  // masks: a batched roto write builds hundreds of Shapes and keys them in one
  // host call, which can outlast the default ceiling on a large mask.
  const LONG_OPS = { render: 30 * 60 * 1000, captureSequence: 5 * 60 * 1000, masks: 3 * 60 * 1000, effectEnums: 5 * 60 * 1000 };

  async function host(op, args) {
    const res = await callHost(op, args, LONG_OPS[op]);
    if (!res.ok) {
      const e = res.error || {};
      throw new Error(`${e.code || 'error'}: ${e.message || 'unknown host failure'}`);
    }
    return res.result;
  }

  async function capture(args) {
    const command = args.command || 'frame';
    const stamp = Date.now();

    if (command === 'sequence') {
      const seq = await host('captureSequence', {
        compId: args.compId,
        count: args.count,
        startTime: args.startTime,
        endTime: args.endTime,
        longEdge: args.longEdge || 320,
        prefix: `seq${stamp}`,
      });
      if (!seq.frames.length) throw new Error('No frames were captured');
      const sheet = await buildContactSheet(seq.frames, { columns: args.columns });
      seq.frames.forEach((f) => { try { fs.unlinkSync(f.path); } catch (e) {} });
      return {
        content: [
          { type: 'image', data: sheet.base64, mimeType: 'image/png' },
          {
            type: 'text',
            text: JSON.stringify(
              { compId: seq.compId, compName: seq.compName, frames: seq.frames.length,
                startTime: seq.startTime, endTime: seq.endTime,
                sheet: { width: sheet.width, height: sheet.height, columns: sheet.columns, rows: sheet.rows },
                times: seq.frames.map((f) => f.time), errors: seq.errors }, null, 2),
          },
        ],
      };
    }

    const op = command === 'isolated' ? 'captureIsolated' : 'capture';
    const frame = await host(op, {
      compId: args.compId,
      layerId: args.layerId,
      time: args.time,
      longEdge: args.longEdge || 512,
      fileName: `cap${stamp}.png`,
    });
    // Not readFileSync: AE writes the PNG asynchronously, and a large frame read
    // early came back with a third of its rows missing.
    const b64 = await flattenOnGrey(frame.path);
    try { fs.unlinkSync(frame.path); } catch (e) {}
    const { path, ...meta } = frame;
    return {
      content: [
        { type: 'image', data: b64, mimeType: 'image/png' },
        { type: 'text', text: JSON.stringify(meta, null, 2) },
      ],
    };
  }

  const handlers = {
    ae_query: async (a) => {
      // The live schema, from this server. A client that cached tool
      // definitions at session start can still find new commands and args.
      if (a.command === 'describe') {
        if (!a.tool) return textContent({ tools: TOOLS.map((t) => t.name), bridge: bridgeInfo() });
        const def = TOOLS.find((t) => t.name === a.tool);
        if (!def) return errorContent(`No tool named ${a.tool}. Known: ${TOOLS.map((t) => t.name).join(', ')}`);
        return textContent({ ...def, bridge: bridgeInfo() });
      }
      const out = await host(a.command, a);
      // Lets a client notice a stale tool list: compare this with what it expects.
      if (a.command === 'sessionInfo' && out && typeof out === 'object') out.bridge = bridgeInfo();
      return textContent(out);
    },
    ae_set: (a) => host(a.command === 'expressions' ? 'setExpression' : 'set', a).then(textContent),
    ae_animate: async (a) => {
      const result = await host('keyframes', a);
      // Easing is a second host call by design: it has to run after the keys
      // exist, and doing it here keeps that ordering out of the caller's hands.
      if (a.ease) {
        result.ease = await host('setEase', {
          layerId: a.layerId, path: a.path,
          influence: a.ease.influence, mode: a.ease.mode, keyIndices: a.ease.keyIndices,
        });
      }
      return textContent(result);
    },
    ae_masks: async (a) => {
      // Tracker output can be ~90,000 vertices; routing that through the agent's
      // tool-call arguments costs hundreds of thousands of tokens. keysPath
      // reads it from disk instead.
      if (a.command === 'setPathKeys' && a.keysPath) {
        const { keysPath, keysPointer, fps, ...rest } = a;
        return textContent(await host('masks', { ...rest, keys: loadKeys(keysPath, keysPointer, fps) }));
      }
      return textContent(await host('masks', a));
    },
    ae_timing: (a) => host('timing', a).then(textContent),
    ae_shapes: (a) => {
      const op = a.command === 'create' ? 'shapes' : 'shapeOps';
      const args = op === 'shapeOps' ? { ...a, command: a.command.replace(/Operator$/, '').replace(/^add$/, 'add') } : a;
      if (op === 'shapeOps') {
        args.command = { addOperator: 'add', removeOperator: 'remove', listOperators: 'list', setDash: 'setDash' }[a.command] || a.command;
      }
      return host(op, args).then(textContent);
    },
    ae_template: (a) => host('template', a).then(textContent),
    ae_text: (a) => host('textAnimator', a).then(textContent),
    // Each layout command is its own host op; the tool is the grouping.
    ae_layout: (a) => host(a.command, a).then(textContent),
    ae_compose: (a) => host('compose', a).then(textContent),
    ae_render: (a) => host('render', a).then(textContent),
    ae_layers: (a) => host('layers', a).then(textContent),
    ae_effects: (a) => host('effects', a).then(textContent),
    ae_project: (a) => {
      // Lifecycle lives in its own host op; the rest stay on 'project'.
      const lifecycle = { new: 'new', open: 'open', close: 'close' };
      return lifecycle[a.command]
        ? host('projectFile', a).then(textContent)
        : host('project', a).then(textContent);
    },
    ae_capture: capture,
    ae_diagnostics: async (a) => {
      if (a.command === 'effectEnums') return textContent(await host('effectEnums', a));
      if (a.command !== 'reloadHost') return textContent(await host('problems', a));
      // Report a reload only if the host's load stamp actually changed. The old
      // implementation answered "reloaded: true" while reloading nothing.
      const before = await host('hostInfo', {});
      const after = await host('reloadHost', { hostPath: HOST_JSX });
      const reloaded = !after.reloadError && after.loadedAt !== before.loadedAt;
      return textContent({
        reloaded,
        file: HOST_JSX,
        loadedAt: after.loadedAt,
        previousLoadedAt: before.loadedAt,
        opCount: after.opCount,
        error: after.reloadError || (reloaded ? null : 'the host was not re-evaluated - restart After Effects'),
      });
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

module.exports = { createToolRegistry, TOOLS };
