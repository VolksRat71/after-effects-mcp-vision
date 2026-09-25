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
    }
    return s;
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
                try { if (p.numKeys) { rec.numKeys = p.numKeys; } } catch (e) {}
                try { if (p.expression) { rec.expression = p.expression; } } catch (e) {}
                values.push(rec);
            } catch (e) {
                errors.push({ path: paths[i], code: "unknown_path", message: String(e) });
            }
        }
        return { layerId: layer.id, time: evalTime, values: values, errors: errors };
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
