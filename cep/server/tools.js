/*
 * The MCP tool surface: eight verb-dispatching tools over ~18 host ops.
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
const { buildContactSheet } = require('./contact-sheet.js');

function textContent(value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

function errorContent(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

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
      '- propertyValues: read specific properties by path.\n' +
      '- selection: what the user currently has selected.\n\n' +
      'Ids from these are stable across reorders and saves. Always address by id.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['sessionInfo', 'tree', 'find', 'propertyKeys', 'propertyValues', 'selection'] },
        compId: { type: 'number', description: 'Composition id. Defaults to the active comp.' },
        layerId: { type: 'number', description: 'Layer id, required by propertyKeys and propertyValues.' },
        name: { type: 'string', description: 'find: case-insensitive substring.' },
        type: { type: 'string', description: 'find: e.g. TextLayer, ShapeLayer, AVLayer, Composition, Footage.' },
        scope: { type: 'string', enum: ['layers', 'items'], description: 'find scope. Default layers.' },
        path: { type: 'array', items: { type: 'string' }, description: 'propertyKeys: matchName path to start from.' },
        paths: { type: 'array', items: { type: 'array', items: { type: 'string' } }, description: 'propertyValues: matchName paths to read.' },
        depth: { type: 'number', description: 'propertyKeys depth, 1-8. Default 2. Start shallow.' },
        includeValues: { type: 'boolean', description: 'propertyKeys: include current values. Roughly doubles output size.' },
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
      'Give a write a `time` to make it a keyframe instead of a static value.\n\n' +
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
              path: { type: 'array', items: { type: 'string' } },
              value: { description: 'Number for 1D, array for 2D/3D/colour. For a text document: a string, or {text,fontSize,font,justification,fillColor,tracking,leading}. Point text anchors at the baseline LEFT, so centre it with justification:"center" rather than by nudging position.' },
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
        path: { type: 'array', items: { type: 'string' } },
        add: { type: 'array', items: { type: 'object', properties: { time: { type: 'number' }, value: {} }, required: ['time', 'value'] } },
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
      'layerId. reorder takes a 1-based target index; ids stay valid across reorders.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['createText', 'createSolid', 'createShape', 'createNull', 'delete', 'duplicate', 'rename', 'select', 'setEnabled', 'setLocked', 'reparent', 'reorder'] },
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
      'path. Prefer working in the comp the user already has open over creating new ones.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['createComp', 'import', 'addToComp', 'deleteItem', 'save'] },
        name: { type: 'string' },
        width: { type: 'number' },
        height: { type: 'number' },
        duration: { type: 'number' },
        frameRate: { type: 'number' },
        pixelAspect: { type: 'number' },
        path: { type: 'string', description: 'import source, or save destination.' },
        importAs: { type: 'string', enum: ['footage', 'composition'] },
        itemId: { type: 'number' },
        compId: { type: 'number' },
        overwrite: { type: 'boolean', description: 'save: required to overwrite an existing project file.' },
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
      'Clip a layer with a rectangular mask, and animate that clip.\n\n' +
      'This is how you reveal part of a layer WITHOUT scaling it. Scaling squashes artwork; ' +
      'a mask reveals it. If you are translating a design where a fixed-size asset is shown ' +
      'progressively (an accordion, a wipe, a progress bar), this is the tool, not ae_set scale.\n\n' +
      'Mask vertices are in LAYER space: (0,0) is the layer\'s top-left corner, not the comp ' +
      'origin and not the anchor point. A rect from (0,0) sized w x h crops the layer to its ' +
      'first w pixels.\n\n' +
      'Pass a `time` to setRect to make the mask shape a keyframe, so the reveal animates. ' +
      'Call add once, then setRect repeatedly at different times.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['add', 'setRect', 'list', 'remove'] },
        layerId: { type: 'number' },
        maskIndex: { type: 'number', description: 'Defaults to the most recently added mask.' },
        name: { type: 'string' },
        left: { type: 'number', description: 'Rect left in layer space. Default 0.' },
        top: { type: 'number', description: 'Rect top in layer space. Default 0.' },
        width: { type: 'number' },
        height: { type: 'number' },
        time: { type: 'number', description: 'Present = keyframe the mask shape at this time.' },
        inverted: { type: 'boolean' },
        feather: { type: 'number' },
        expansion: { type: 'number' },
      },
      required: ['command', 'layerId'],
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
        maxLayers: { type: 'number', description: 'Cap on layers scanned for expression errors. Default 400.' },
      },
    },
  },
];

/**
 * @param {(op:string,args:object,timeoutMs?:number)=>Promise<object>} callHost
 */
function createToolRegistry(callHost) {
  async function host(op, args) {
    const res = await callHost(op, args);
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
    const b64 = fs.readFileSync(frame.path).toString('base64');
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
    ae_query: (a) => host(a.command, a).then(textContent),
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
    ae_masks: (a) => host('masks', a).then(textContent),
    ae_layers: (a) => host('layers', a).then(textContent),
    ae_effects: (a) => host('effects', a).then(textContent),
    ae_project: (a) => host('project', a).then(textContent),
    ae_capture: capture,
    ae_diagnostics: (a) => host('problems', a).then(textContent),
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
