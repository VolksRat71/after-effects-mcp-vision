/*
 * The discovery chain: find -> tree -> propertyKeys -> propertyValues.
 *
 * v1 could reach exactly five hardcoded transform properties, by English
 * display name. This walks the real PropertyGroup tree by matchName, so
 * effects, masks, text animators, shape paths and layer styles are all
 * addressable - and it keeps working on a localized After Effects.
 */

function __mcp_layerSummary(l) {
    var s = {
        id: l.id, index: l.index, name: l.name,
        enabled: l.enabled, locked: l.locked, shy: l.shy,
        inPoint: l.inPoint, outPoint: l.outPoint,
        startTime: l.startTime, selected: l.selected
    };
    // Explicit branches: a chained ternary across newlines mis-associates in
    // ExtendScript (it silently broke the pin rig in ops-layout.jsx).
    try {
        if (l instanceof TextLayer) { s.type = "TextLayer"; }
        else if (l instanceof ShapeLayer) { s.type = "ShapeLayer"; }
        else if (l instanceof CameraLayer) { s.type = "CameraLayer"; }
        else if (l instanceof LightLayer) { s.type = "LightLayer"; }
        else if (l instanceof AVLayer) { s.type = "AVLayer"; }
        else { s.type = "Layer"; }
    } catch (e) { s.type = "Layer"; }
    try { s.parentId = l.parent ? l.parent.id : null; } catch (e) { s.parentId = null; }
    try { s.hasVideo = l.hasVideo; } catch (e) {}
    try { if (l.hasAudio) { s.hasAudio = true; s.audioEnabled = l.audioEnabled; } } catch (e) {}
    // Handoff notes set by ae_layers organise; omitted when empty to keep trees small.
    try { if (l.comment) { s.comment = l.comment; } } catch (e) {}
    return s;
}

function __mcp_itemSummary(it) {
    var s = { id: it.id, name: it.name, typeName: it.typeName };
    // The root folder is its own parent; report it as null so a flat list can be rebuilt as a tree.
    try { s.parentFolderId = (it.parentFolder && it.parentFolder !== app.project.rootFolder) ? it.parentFolder.id : null; } catch (e) {}
    if (it instanceof CompItem) {
        s.type = "Composition";
        s.width = it.width; s.height = it.height;
        s.frameRate = it.frameRate; s.duration = it.duration;
        s.numLayers = it.numLayers;
    } else if (it instanceof FolderItem) {
        s.type = "Folder"; s.numItems = it.numItems;
    } else if (it instanceof FootageItem) {
        s.type = (it.mainSource instanceof SolidSource) ? "Solid" : "Footage";
        try { s.footageMissing = it.footageMissing; } catch (e) {}
        try { s.file = it.file ? it.file.fsName : null; } catch (e) {}
        // What a caller needs before building on footage: its size, timing and whether it has sound.
        try { s.width = it.width; s.height = it.height; } catch (e) {}
        try { s.hasVideo = it.hasVideo; s.hasAudio = it.hasAudio; } catch (e) {}
        try {
            if (it.mainSource && !it.mainSource.isStill) {
                s.duration = it.duration; s.frameRate = it.frameRate;
                s.frames = Math.round(it.duration * it.frameRate);
            } else if (it.mainSource) { s.still = true; }
        } catch (e) {}
    }
    return s;
}

/*
 * Media inventory, for external adapters (SAM UI's roto handoff is the first).
 *
 * Every field here was read against AE 26.0x67 on a FileSource, a missing
 * FileSource, a PlaceholderSource and a SolidSource, and none of them threw -
 * but each read is still guarded, because a throw here would cost the caller
 * the whole list rather than one field.
 *
 * Verified behaviour this relies on:
 *  - A file deleted AFTER import keeps footageMissing === false until the
 *    project is reopened; only file.exists notices. So `missing` checks both.
 *  - On reopen, a missing file keeps its FileSource, its path, its id and its
 *    last-known size and timing, and mainSource.missingFootagePath carries the
 *    path. That is why a missing item stays in the list instead of dropping.
 *  - alphaMode reads STRAIGHT on footage with no alpha at all, so it is only
 *    meaningful next to hasAlpha.
 *  - conformFrameRate changes frameRate and duration but not the frame count.
 *
 * Source type is decided with explicit branches: a one-line chained ternary
 * over instanceof returned "PlaceholderSource" for every source type.
 */
function __mcp_enumName(value, table) {
    for (var k in table) {
        if (table.hasOwnProperty(k)) {
            try { if (table[k] === value) { return k; } } catch (e) {}
        }
    }
    return value;
}

function __mcp_enumTable(ctor, names) {
    var t = {};
    for (var i = 0; i < names.length; i++) {
        try { if (ctor[names[i]] !== undefined) { t[names[i]] = ctor[names[i]]; } } catch (e) {}
    }
    return t;
}

// File extensions AE imports as stills. A non-still FileSource with one of
// these is an image sequence, whose `path` is only the first frame.
var __mcp_stillExt = /\.(png|jpe?g|tiff?|tga|exr|dpx|cin|bmp|psd|gif|hdr|sgi|rla|rpf|iff|pxr|dng|cr2|nef|arw|heic|webp)$/i;

function __mcp_mediaRecord(it) {
    var ms = it.mainSource;
    var kind = "other";
    if (ms instanceof SolidSource) { kind = "solid"; }
    else if (ms instanceof PlaceholderSource) { kind = "placeholder"; }
    else if (ms instanceof FileSource) { kind = "file"; }

    var r = { id: it.id, name: it.name, kind: kind };
    try { r.parentFolderId = (it.parentFolder && it.parentFolder !== app.project.rootFolder) ? it.parentFolder.id : null; } catch (e) {}

    var path = null, exists = null;
    try { if (it.file) { path = it.file.fsName; exists = it.file.exists; } } catch (e) {}
    if (!path) { try { if (ms.missingFootagePath) { path = String(ms.missingFootagePath); exists = false; } } catch (e) {} }
    r.path = path;

    var footageMissing = false;
    try { footageMissing = it.footageMissing === true; } catch (e) {}
    r.missing = (kind === "file") && (footageMissing || exists === false);

    var still = false;
    try { still = ms.isStill === true; } catch (e) {}
    try { r.hasVideo = it.hasVideo; } catch (e) {}
    try { r.hasAudio = it.hasAudio; } catch (e) {}
    try { r.width = it.width; r.height = it.height; } catch (e) {}
    try { r.pixelAspect = it.pixelAspect; } catch (e) {}
    if (!still) {
        try {
            r.duration = it.duration;
            r.frameRate = it.frameRate;
            r.frames = Math.round(it.duration * it.frameRate);
        } catch (e) {}
    }
    r.still = still;
    if (kind === "file" && !still && path && __mcp_stillExt.test(path)) { r.imageSequence = true; }

    // Interpretation, as the Interpret Footage dialog would show it.
    var interp = {};
    try { interp.nativeFrameRate = ms.nativeFrameRate; } catch (e) {}
    try { interp.conformFrameRate = ms.conformFrameRate; } catch (e) {}
    try { interp.displayFrameRate = ms.displayFrameRate; } catch (e) {}
    try { interp.fieldSeparation = __mcp_enumName(ms.fieldSeparationType,
            __mcp_enumTable(FieldSeparationType, ["OFF", "UPPER_FIELD_FIRST", "LOWER_FIELD_FIRST"])); } catch (e) {}
    try { interp.highQualityFieldSeparation = ms.highQualityFieldSeparation; } catch (e) {}
    try { interp.removePulldown = __mcp_enumName(ms.removePulldown,
            __mcp_enumTable(PulldownPhase, ["OFF", "WSSWW", "SSWWW", "SWWWS", "WWWSS", "WWSSW",
                                            "WSSWW_24P_ADVANCE", "SSWWW_24P_ADVANCE", "SWWWS_24P_ADVANCE",
                                            "WWWSS_24P_ADVANCE", "WWSSW_24P_ADVANCE"])); } catch (e) {}
    try { interp.loop = ms.loop; } catch (e) {}
    try { interp.hasAlpha = ms.hasAlpha; } catch (e) {}
    // Null without an alpha channel: AE reads STRAIGHT there, which means nothing.
    interp.alphaMode = null;
    if (interp.hasAlpha === true) {
        try { interp.alphaMode = __mcp_enumName(ms.alphaMode,
                __mcp_enumTable(AlphaMode, ["IGNORE", "STRAIGHT", "PREMULTIPLIED"])); } catch (e) {}
        try { interp.invertAlpha = ms.invertAlpha; } catch (e) {}
    }
    r.interpretation = interp;

    try { r.useProxy = it.useProxy === true; } catch (e) {}
    try {
        // proxySource outlives useProxy = false, so report the path whenever one is set.
        if (it.proxySource && it.proxySource.file) { r.proxyPath = it.proxySource.file.fsName; }
    } catch (e) {}

    /*
     * Everything that makes AE's frame N differ from the file's frame N, or
     * that makes what AE shows differ from what an adapter decodes. Empty means
     * the item is interpreted natively.
     */
    var o = [];
    if (interp.conformFrameRate && interp.nativeFrameRate &&
        Math.abs(interp.conformFrameRate - interp.nativeFrameRate) > 1e-6) { o.push("conformFrameRate"); }
    if (interp.fieldSeparation !== undefined && interp.fieldSeparation !== "OFF") { o.push("fieldSeparation"); }
    if (interp.removePulldown !== undefined && interp.removePulldown !== "OFF") { o.push("removePulldown"); }
    if (interp.loop !== undefined && interp.loop !== 1) { o.push("loop"); }
    if (r.useProxy) { o.push("useProxy"); }
    r.interpretationOverrides = o;

    // Eligibility for an external segmenter: a moving picture in a real file.
    // A missing file stays eligible - the adapter should say "reconnect".
    var reason = null;
    if (kind === "solid") { reason = "solid"; }
    else if (kind === "placeholder") { reason = "placeholder"; }
    else if (kind !== "file" || !path) { reason = "noFile"; }
    else if (still) { reason = "still"; }
    else if (r.hasVideo === false) { reason = "audioOnly"; }
    r.eligible = (reason === null);
    if (reason) { r.reason = reason; }
    return r;
}

/*
 * Recursive property walk. Depth is capped hard because an unbounded walk of a
 * shape layer or a heavily-effected layer produces thousands of tokens - the
 * same trap Rive's get_artboard_hierarchy warns about.
 */
function __mcp_walkProps(group, pathSoFar, depth, maxDepth, out, includeValues) {
    if (depth > maxDepth) { return; }
    var n = 0;
    try { n = group.numProperties; } catch (e) { return; }

    for (var i = 1; i <= n; i++) {
        var p;
        try { p = group.property(i); } catch (e) { continue; }
        if (!p) { continue; }

        var mn;
        try { mn = p.matchName; } catch (e) { mn = null; }
        var path = pathSoFar.concat([mn]);

        var entry = {
            path: path,
            matchName: mn,
            name: (function () { try { return p.name; } catch (e) { return null; } })(),
            propertyType: __mcp_propTypeName(p),
            valueType: __mcp_valueTypeName(p)
        };

        try { if (p.canSetExpression) { entry.canSetExpression = true; } } catch (e) {}
        try { if (p.numKeys) { entry.numKeys = p.numKeys; } } catch (e) {}
        try { if (p.expression) { entry.expression = p.expression; } } catch (e) {}
        try { if (p.expressionError) { entry.expressionError = p.expressionError; } } catch (e) {}

        var opts = __mcp_enumOptions(p);
        if (opts) { entry.enumOptions = opts; }

        if (includeValues && __mcp_propTypeName(p) === "PROPERTY") {
            entry.value = __mcp_readValue(p);
            var lbl = __mcp_valueLabel(p);
            if (lbl !== null) { entry.label = lbl; }
        }

        out.push(entry);

        if (__mcp_propTypeName(p) !== "PROPERTY") {
            __mcp_walkProps(p, path, depth + 1, maxDepth, out, includeValues);
        }
    }
}

var __mcp_queryOps = {

    /* Substring/type search over layers in a comp, or project items. */
    find: function (args) {
        var scope = args.scope || "layers";
        var needle = (args.name || "").toLowerCase();
        var wantType = args.type ? String(args.type).toLowerCase() : null;
        var limit = Number(args.limit || 100);
        var results = [];

        if (scope === "items") {
            var p = app.project;
            for (var i = 1; i <= p.numItems && results.length < limit; i++) {
                var it = p.item(i);
                var s = __mcp_itemSummary(it);
                if (needle && String(s.name).toLowerCase().indexOf(needle) === -1) { continue; }
                if (wantType && String(s.type).toLowerCase().indexOf(wantType) === -1) { continue; }
                results.push(s);
            }
            return { scope: "items", matches: results };
        }

        var comp = __mcp_resolveComp(args);
        for (var j = 1; j <= comp.numLayers && results.length < limit; j++) {
            var ls = __mcp_layerSummary(comp.layer(j));
            if (needle && String(ls.name).toLowerCase().indexOf(needle) === -1) { continue; }
            if (wantType && String(ls.type).toLowerCase().indexOf(wantType) === -1) { continue; }
            results.push(ls);
        }
        return { scope: "layers", compId: comp.id, compName: comp.name, matches: results };
    },

    /* Project tree, or a comp's layer list. Start shallow. */
    tree: function (args) {
        if (args.compId !== undefined && args.compId !== null) {
            var comp = __mcp_compById(args.compId);
            var layers = [];
            for (var i = 1; i <= comp.numLayers; i++) { layers.push(__mcp_layerSummary(comp.layer(i))); }
            return { compId: comp.id, name: comp.name, layers: layers };
        }
        var p = app.project;
        var items = [];
        for (var j = 1; j <= p.numItems; j++) { items.push(__mcp_itemSummary(p.item(j))); }
        return { projectName: p.file ? p.file.name : null, items: items };
    },

    /*
     * Every addressable property on a layer, as matchName paths.
     * depth defaults to 2 (transform + effect groups) - enough to orient
     * without flooding context. Raise it to drill into one branch.
     */
    propertyKeys: function (args) {
        if (args.layerId === undefined || args.layerId === null) {
            throw new Error("propertyKeys requires layerId");
        }
        var layer = __mcp_layerById(args.layerId);
        var maxDepth = Math.max(1, Math.min(8, Number(args.depth || 2)));
        var out = [];
        var root = layer;
        if (args.path) { root = __mcp_propByPath(layer, args.path); }
        __mcp_walkProps(root, args.path || [], 1, maxDepth, out, !!args.includeValues);
        return {
            layerId: layer.id, layerName: layer.name,
            depth: maxDepth, count: out.length, properties: out
        };
    },

    /* Read specific properties: { layerId, paths: [[...matchNames], ...] } */
    propertyValues: function (args) {
        var layer = __mcp_layerById(args.layerId);
        var paths = args.paths || [];
        var values = [];
        var errors = [];
        var hasTime = (args.time !== undefined && args.time !== null);
        var evalTime = hasTime ? Number(args.time) : layer.containingComp.time;
        for (var i = 0; i < paths.length; i++) {
            try {
                var p = __mcp_propByPath(layer, paths[i]);
                if (__mcp_propTypeName(p) !== "PROPERTY") {
                    errors.push({ path: paths[i], code: "not_a_property",
                                  message: "Path resolves to a group (" + p.matchName + "), not a readable property - use propertyKeys with this path to list what is inside" });
                    continue;
                }
                var rec = {
                    path: paths[i],
                    value: __mcp_readValue(p, evalTime),
                    valueType: __mcp_valueTypeName(p)
                };
                // valueText is the CURRENT value's text, so only label a read at the playhead.
                if (!hasTime || Math.abs(evalTime - layer.containingComp.time) < 1e-6) {
                    var lb = __mcp_valueLabel(p);
                    if (lb !== null) { rec.label = lb; }
                }
                var ropts = __mcp_enumOptions(p);
                if (ropts) { rec.options = ropts; }
                try { if (p.numKeys) { rec.numKeys = p.numKeys; } } catch (e) {}
                try { if (p.expression) { rec.expression = p.expression; } } catch (e) {}
                values.push(rec);
            } catch (e) {
                errors.push({ path: paths[i], code: "unknown_path", message: String(e) });
            }
        }
        return { layerId: layer.id, time: evalTime, values: values, errors: errors };
    },

    /*
     * Footage an external tool can open: file-backed, moving, with video.
     * Read-only. includeIneligible adds every other footage item (solids,
     * stills, placeholders, audio) under `ineligible`, each with its reason.
     */
    media: function (args) {
        var p = app.project;
        var project = { path: null, name: null, dirty: false, numItems: p.numItems };
        try { if (p.file) { project.path = p.file.fsName; project.name = p.file.name; } } catch (e) {}
        try { project.dirty = p.dirty; } catch (e) {}

        var items = [], ineligible = [], footage = 0, missing = 0;
        for (var i = 1; i <= p.numItems; i++) {
            var it = p.item(i);
            if (!(it instanceof FootageItem)) { continue; }
            footage++;
            var r = __mcp_mediaRecord(it);
            if (r.eligible) {
                // List membership says eligible; these three are constant here.
                delete r.eligible; delete r.still; delete r.hasVideo;
                if (r.missing) { missing++; }
                items.push(r);
            } else if (args.includeIneligible === true) {
                // Compact: nobody segments a solid, so its interpretation is noise.
                ineligible.push({ id: r.id, name: r.name, kind: r.kind, reason: r.reason,
                                  parentFolderId: r.parentFolderId, path: r.path,
                                  width: r.width, height: r.height,
                                  hasVideo: r.hasVideo, hasAudio: r.hasAudio, still: r.still });
            }
        }
        var out = { project: project, items: items,
                    counts: { footage: footage, eligible: items.length, missing: missing,
                              ineligible: footage - items.length } };
        if (args.includeIneligible === true) { out.ineligible = ineligible; }
        return out;
    },

    selection: function () {
        var p = app.project;
        var items = [];
        for (var i = 0; i < p.selection.length; i++) { items.push(__mcp_itemSummary(p.selection[i])); }
        var out = { activeItemId: p.activeItem ? p.activeItem.id : null, selectedItems: items };
        if (__mcp_isCompItem(p.activeItem)) {
            var comp = p.activeItem;
            var layers = [];
            for (var j = 0; j < comp.selectedLayers.length; j++) {
                layers.push(__mcp_layerSummary(comp.selectedLayers[j]));
            }
            out.compId = comp.id;
            out.selectedLayers = layers;
            var props = [];
            for (var k = 0; k < comp.selectedProperties.length; k++) {
                var sp = comp.selectedProperties[k];
                try { props.push({ matchName: sp.matchName, name: sp.name }); } catch (e) {}
            }
            out.selectedProperties = props;
        }
        return out;
    }
};
