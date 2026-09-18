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
      '- selection: what the user currently has selected.\n' +
      '- bounds: how large a layer ACTUALLY renders, via sourceRectAtTime. Use this before ' +
      'positioning text - a string\'s rendered width is not knowable from its font size, and ' +
      'guessing is how text ends up clipped or off-centre. Returns layer-space and an ' +
      'approximate comp-space box. A freshly created shape layer can report 0x0 until After ' +
      'Effects has evaluated it, so check `reliable` before trusting a zero.\n\n' +
      'Ids from these are stable across reorders and saves. Always address by id.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['sessionInfo', 'tree', 'find', 'propertyKeys', 'propertyValues', 'selection', 'bounds'] },
        compId: { type: 'number', description: 'Composition id. Defaults to the active comp.' },
        layerId: { type: 'number', description: 'Layer id, required by propertyKeys and propertyValues.' },
        name: { type: 'string', description: 'find: case-insensitive substring.' },
        type: { type: 'string', description: 'find: e.g. TextLayer, ShapeLayer, AVLayer, Composition, Footage.' },
        scope: { type: 'string', enum: ['layers', 'items'], description: 'find scope. Default layers.' },
        path: { type: 'array', items: { type: 'string' }, description: 'propertyKeys: matchName path to start from.' },
        paths: { type: 'array', items: { type: 'array', items: { type: 'string' } }, description: 'propertyValues: matchName paths to read.' },
        depth: { type: 'number', description: 'propertyKeys depth, 1-8. Default 2. Start shallow.' },
        includeValues: { type: 'boolean', description: 'propertyKeys: include current values. Roughly doubles output size.' },
        time: { type: 'number', description: 'bounds: evaluate at this time. Defaults to the playhead.' },
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
      'Call add once, then setRect repeatedly at different times.\n\n' +
      'setPath takes arbitrary vertices for non-rectangular masks, and setFeather softens the ' +
      'edge (also keyframeable). To clip a layer to the SHAPE of another layer rather than to a ' +
      'path, use ae_compose setTrackMatte instead.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['add', 'setRect', 'setPath', 'setFeather', 'list', 'remove'] },
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
        vertices: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: 'setPath: [[x,y], ...] in layer space, 3 or more.' },
        closed: { type: 'boolean', description: 'setPath. Default true.' },
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
      'a comp, or to a layer when you pass layerId.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['setLayer', 'setComp', 'addMarker'] },
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
      'them with ae_set or ae_animate without reconstructing the vector tree yourself.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['create'] },
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
        fill: { description: 'RGBA 0-1 array, or false for no fill. Defaults to white.' },
        stroke: { type: 'array', items: { type: 'number' }, description: 'RGBA 0-1. Omit for no stroke.' },
        strokeWidth: { type: 'number' },
        position: { type: 'array', items: { type: 'number' } },
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
      'restored afterwards, so this never renders somebody else\'s queue.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['render', 'listTemplates'] },
        compId: { type: 'number' },
        outputPath: { type: 'string', description: 'Absolute path with a media extension.' },
        omTemplate: { type: 'string', description: 'Output module template name. Default: an H.264 preset.' },
        rsTemplate: { type: 'string', description: 'Render settings template, e.g. "Best Settings".' },
        startTime: { type: 'number' },
        endTime: { type: 'number' },
        overwrite: { type: 'boolean', description: 'Required to replace an existing file.' },
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
        maxLayers: { type: 'number', description: 'Cap on layers scanned for expression errors. Default 400.' },
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
  const LONG_OPS = { render: 30 * 60 * 1000, captureSequence: 5 * 60 * 1000 };

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
    ae_timing: (a) => host('timing', a).then(textContent),
    ae_shapes: (a) => host('shapes', a).then(textContent),
    ae_compose: (a) => host('compose', a).then(textContent),
    ae_render: (a) => host('render', a).then(textContent),
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
