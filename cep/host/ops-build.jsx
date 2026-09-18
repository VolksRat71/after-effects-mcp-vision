/*
 * Build ops: timing, measurement, shapes, composition structure, rendering.
 *
 * Every API here was probed against AE 26.0x67 before being written down. The
 * two rules that bit during probing are encoded below rather than left as
 * comments in a chat log:
 *   - setting startTime SHIFTS inPoint/outPoint, so it must be applied first
 *   - addProperty() on a vector group invalidates references you are still
 *     holding to its siblings, so every reference is re-fetched after each add
 */

var __MCP_BLEND = {
    normal: BlendingMode.NORMAL, multiply: BlendingMode.MULTIPLY, screen: BlendingMode.SCREEN,
    overlay: BlendingMode.OVERLAY, add: BlendingMode.ADD, darken: BlendingMode.DARKEN,
    lighten: BlendingMode.LIGHTEN, difference: BlendingMode.DIFFERENCE,
    softLight: BlendingMode.SOFT_LIGHT, hardLight: BlendingMode.HARD_LIGHT,
    colorDodge: BlendingMode.COLOR_DODGE, colorBurn: BlendingMode.COLOR_BURN,
    hue: BlendingMode.HUE, saturation: BlendingMode.SATURATION,
    color: BlendingMode.COLOR, luminosity: BlendingMode.LUMINOSITY
};

var __MCP_MATTE = {
    alpha: TrackMatteType.ALPHA, alphaInverted: TrackMatteType.ALPHA_INVERTED,
    luma: TrackMatteType.LUMA, lumaInverted: TrackMatteType.LUMA_INVERTED
};

function __mcp_colorArg(c, fallback) {
    if (!c) { return fallback; }
    var out = [];
    for (var i = 0; i < 4; i++) { out.push(i < c.length ? Number(c[i]) : 1); }
    return out;
}

var __mcp_buildOps = {

    /*
     * Layer and comp timing. startTime is applied BEFORE inPoint/outPoint:
     * probing showed that setting startTime after them shifts both by the
     * same delta, so the order a caller writes them in would otherwise change
     * the result.
     */
    timing: function (args) {
        var cmd = args.command;

        if (cmd === "setLayer") {
            var layer = __mcp_layerById(args.layerId);
            if (args.startTime !== undefined) { layer.startTime = Number(args.startTime); }
            if (args.stretch !== undefined) { layer.stretch = Number(args.stretch); }
            if (args.inPoint !== undefined) { layer.inPoint = Number(args.inPoint); }
            if (args.outPoint !== undefined) { layer.outPoint = Number(args.outPoint); }
            return { layerId: layer.id, startTime: layer.startTime, inPoint: layer.inPoint,
                     outPoint: layer.outPoint, stretch: layer.stretch };
        }
        if (cmd === "setComp") {
            var comp = __mcp_compById(args.compId);
            if (args.duration !== undefined) { comp.duration = Number(args.duration); }
            if (args.frameRate !== undefined) { comp.frameRate = Number(args.frameRate); }
            if (args.width !== undefined) { comp.width = Number(args.width); }
            if (args.height !== undefined) { comp.height = Number(args.height); }
            if (args.workAreaStart !== undefined) { comp.workAreaStart = Number(args.workAreaStart); }
            if (args.workAreaDuration !== undefined) { comp.workAreaDuration = Number(args.workAreaDuration); }
            return __mcp_itemSummary(comp);
        }
        if (cmd === "addMarker") {
            var mv = new MarkerValue(String(args.comment || ""));
            if (args.duration !== undefined) { mv.duration = Number(args.duration); }
            var target, where;
            if (args.layerId !== undefined && args.layerId !== null) {
                target = __mcp_layerById(args.layerId).property("ADBE Marker"); where = "layer";
            } else {
                target = __mcp_resolveComp(args).markerProperty; where = "comp";
            }
            target.setValueAtTime(Number(args.time), mv);
            return { on: where, time: Number(args.time), comment: mv.comment, numMarkers: target.numKeys };
        }
        throw new Error("Unknown timing command: " + cmd);
    },

    /*
     * Rendered bounds in LAYER space. This is how an agent finds out how wide
     * its text actually came out instead of guessing - the first lower-third
     * built with this tool was clipped for exactly that reason. Text and
     * footage report accurately; a freshly-built shape layer can report zeros
     * until AE has evaluated it, so callers should treat 0x0 as "unknown".
     */
    bounds: function (args) {
        var layer = __mcp_layerById(args.layerId);
        var time = (args.time === undefined || args.time === null) ? layer.containingComp.time : Number(args.time);
        var b = layer.sourceRectAtTime(time, !!args.includeExtents);
        var pos = layer.property("ADBE Transform Group").property("ADBE Position").value;
        var anc = layer.property("ADBE Transform Group").property("ADBE Anchor Point").value;
        // Approximate comp-space box assuming no rotation/scale: useful for
        // "does this overlap that" without a full matrix walk.
        return {
            layerId: layer.id, time: time,
            layerSpace: { left: b.left, top: b.top, width: b.width, height: b.height },
            compSpaceApprox: {
                left: pos[0] - anc[0] + b.left, top: pos[1] - anc[1] + b.top,
                right: pos[0] - anc[0] + b.left + b.width, bottom: pos[1] - anc[1] + b.top + b.height
            },
            reliable: !(b.width === 0 && b.height === 0)
        };
    },

    /*
     * Shape layers with real geometry. Returns the matchName paths to every
     * animatable property it created, so ae_set / ae_animate can drive them
     * without the caller reconstructing the vector tree.
     *
     * References are RE-FETCHED after every addProperty. Holding a sibling
     * across an add throws "Object is invalid" - that is how the first attempt
     * at this failed.
     */
    shapes: function (args) {
        var cmd = args.command || "create";
        if (cmd !== "create") { throw new Error("Unknown shapes command: " + cmd); }

        var comp = __mcp_resolveComp(args);
        var kind = String(args.kind || "rect");
        var sh = comp.layers.addShape();
        if (args.name) { sh.name = String(args.name); }

        var root = sh.property("ADBE Root Vectors Group");
        root.addProperty("ADBE Vector Group");
        var grp = root.property(1);
        var groupName = String(args.name || "Shape");
        grp.name = groupName;
        var contents = grp.property("ADBE Vectors Group");

        var geomMatch, sizeMatch = null;
        if (kind === "rect") {
            contents.addProperty("ADBE Vector Shape - Rect");
            geomMatch = "ADBE Vector Shape - Rect"; sizeMatch = "ADBE Vector Rect Size";
            var rect = contents.property(1);
            rect.property("ADBE Vector Rect Size").setValue([Number(args.width || 200), Number(args.height || 200)]);
            if (args.roundness !== undefined) { rect.property("ADBE Vector Rect Roundness").setValue(Number(args.roundness)); }
        } else if (kind === "ellipse") {
            contents.addProperty("ADBE Vector Shape - Ellipse");
            geomMatch = "ADBE Vector Shape - Ellipse"; sizeMatch = "ADBE Vector Ellipse Size";
            contents.property(1).property("ADBE Vector Ellipse Size").setValue([Number(args.width || 200), Number(args.height || 200)]);
        } else if (kind === "polygon" || kind === "star") {
            contents.addProperty("ADBE Vector Shape - Star");
            geomMatch = "ADBE Vector Shape - Star";
            var star = contents.property(1);
            star.property("ADBE Vector Star Type").setValue(kind === "polygon" ? 2 : 1);
            star.property("ADBE Vector Star Points").setValue(Number(args.points || (kind === "polygon" ? 6 : 5)));
            star.property("ADBE Vector Star Outer Radius").setValue(Number(args.outerRadius || args.width / 2 || 100));
            if (kind === "star") { star.property("ADBE Vector Star Inner Radius").setValue(Number(args.innerRadius || 50)); }
        } else if (kind === "path") {
            if (!args.vertices || !args.vertices.length) { throw new Error("path requires vertices"); }
            contents.addProperty("ADBE Vector Shape - Group");
            geomMatch = "ADBE Vector Shape - Group";
            var s = new Shape();
            var v = [];
            for (var i = 0; i < args.vertices.length; i++) { v.push([Number(args.vertices[i][0]), Number(args.vertices[i][1])]); }
            s.vertices = v; s.closed = (args.closed !== false);
            contents.property(1).property("ADBE Vector Shape").setValue(s);
        } else {
            throw new Error("kind must be rect, ellipse, polygon, star or path");
        }

        var idx = 2;
        var fillIdx = null, strokeIdx = null;
        if (args.fill !== false) {
            contents.addProperty("ADBE Vector Graphic - Fill");
            contents.property(idx).property("ADBE Vector Fill Color").setValue(__mcp_colorArg(args.fill, [1, 1, 1, 1]));
            fillIdx = idx; idx++;
        }
        if (args.stroke) {
            contents.addProperty("ADBE Vector Graphic - Stroke");
            var st = contents.property(idx);
            st.property("ADBE Vector Stroke Color").setValue(__mcp_colorArg(args.stroke, [0, 0, 0, 1]));
            st.property("ADBE Vector Stroke Width").setValue(Number(args.strokeWidth || 2));
            strokeIdx = idx; idx++;
        }

        if (args.position) {
            sh.property("ADBE Transform Group").property("ADBE Position").setValue([Number(args.position[0]), Number(args.position[1])]);
        }

        var base = ["ADBE Root Vectors Group", groupName, "ADBE Vectors Group"];
        var paths = { groupTransform: ["ADBE Root Vectors Group", groupName, "ADBE Vector Transform Group"] };
        if (sizeMatch) { paths.size = base.concat([geomMatch, sizeMatch]); }
        if (kind === "rect") { paths.roundness = base.concat([geomMatch, "ADBE Vector Rect Roundness"]); }
        if (kind === "path") { paths.path = base.concat([geomMatch, "ADBE Vector Shape"]); }
        if (fillIdx) { paths.fillColor = base.concat(["ADBE Vector Graphic - Fill", "ADBE Vector Fill Color"]); }
        if (strokeIdx) {
            paths.strokeColor = base.concat(["ADBE Vector Graphic - Stroke", "ADBE Vector Stroke Color"]);
            paths.strokeWidth = base.concat(["ADBE Vector Graphic - Stroke", "ADBE Vector Stroke Width"]);
        }
        var summary = __mcp_layerSummary(sh);
        summary.kind = kind;
        summary.paths = paths;
        return summary;
    },

    /* Composition structure: grouping, mattes, blend modes, parenting, 3D. */
    compose: function (args) {
        var cmd = args.command;

        if (cmd === "precompose") {
            var comp = __mcp_resolveComp(args);
            if (!args.layerIds || !args.layerIds.length) { throw new Error("precompose requires layerIds"); }
            var indices = [];
            for (var i = 0; i < args.layerIds.length; i++) {
                var l = __mcp_layerById(args.layerIds[i]);
                if (l.containingComp.id !== comp.id) { throw new Error("Layer " + l.id + " is not in comp " + comp.id); }
                indices.push(l.index);
            }
            var pre = comp.layers.precompose(indices, String(args.name || "Pre-comp"), args.moveAttributes !== false);
            var newLayer = null;
            for (var j = 1; j <= comp.numLayers; j++) {
                if (comp.layer(j).source && comp.layer(j).source.id === pre.id) { newLayer = comp.layer(j); }
            }
            return { precompId: pre.id, precompName: pre.name, layersInside: pre.numLayers,
                     layerInParent: newLayer ? __mcp_layerSummary(newLayer) : null };
        }
        if (cmd === "setTrackMatte") {
            var target = __mcp_layerById(args.layerId);
            if (args.matteLayerId === null || args.matteLayerId === undefined) {
                target.removeTrackMatte();
                return { layerId: target.id, hasTrackMatte: target.hasTrackMatte };
            }
            var matte = __mcp_layerById(args.matteLayerId);
            var type = __MCP_MATTE[args.type || "alpha"];
            if (!type) { throw new Error("type must be alpha, alphaInverted, luma or lumaInverted"); }
            // AE 23+ API: no adjacency requirement, unlike the legacy trackMatteType.
            target.setTrackMatte(matte, type);
            return { layerId: target.id, matteLayerId: matte.id, type: args.type || "alpha", hasTrackMatte: target.hasTrackMatte };
        }
        if (cmd === "setBlendMode") {
            var bl = __mcp_layerById(args.layerId);
            var mode = __MCP_BLEND[args.mode];
            if (!mode) { var keys = []; for (var k in __MCP_BLEND) { keys.push(k); } throw new Error("mode must be one of: " + keys.join(", ")); }
            bl.blendingMode = mode;
            return { layerId: bl.id, mode: args.mode };
        }
        if (cmd === "parent") {
            var child = __mcp_layerById(args.layerId);
            if (args.parentLayerId === null || args.parentLayerId === undefined) { child.parent = null; }
            else {
                var par = __mcp_layerById(args.parentLayerId);
                // setParentWithJump keeps the child where it is on screen; plain
                // assignment keeps its numbers and lets it jump.
                if (args.keepPosition === false) { child.parent = par; } else { child.setParentWithJump(par); }
            }
            return { layerId: child.id, parentId: child.parent ? child.parent.id : null };
        }
        if (cmd === "set3D") {
            var l3 = __mcp_layerById(args.layerId);
            l3.threeDLayer = (args.enabled !== false);
            return { layerId: l3.id, threeD: l3.threeDLayer };
        }
        if (cmd === "addCamera") {
            var cc = __mcp_resolveComp(args);
            var cam = cc.layers.addCamera(String(args.name || "Camera"), [cc.width / 2, cc.height / 2]);
            return __mcp_layerSummary(cam);
        }
        throw new Error("Unknown compose command: " + cmd);
    },

    /*
     * Render to a file through the render queue. Blocking: renderQueue.render()
     * does not return until the job is done, so the tool layer gives this call
     * a long timeout. Other queued items are disabled for the duration and
     * restored afterwards, so this never renders someone's unrelated queue.
     */
    render: function (args) {
        var cmd = args.command || "render";
        var rq = app.project.renderQueue;

        if (cmd === "listTemplates") {
            var probeComp = __mcp_resolveComp(args);
            var probe = rq.items.add(probeComp);
            var om = probe.outputModule(1);
            var out = { outputModules: [], renderSettings: [] };
            for (var i = 0; i < om.templates.length; i++) { if (om.templates[i].indexOf("_HIDDEN") !== 0) { out.outputModules.push(om.templates[i]); } }
            for (var j = 0; j < probe.templates.length; j++) { if (probe.templates[j].indexOf("_HIDDEN") !== 0) { out.renderSettings.push(probe.templates[j]); } }
            probe.remove();
            return out;
        }
        if (cmd !== "render") { throw new Error("Unknown render command: " + cmd); }

        var comp = __mcp_resolveComp(args);
        var outPath = String(args.outputPath || "");
        if (!outPath) { throw new Error("render requires outputPath"); }
        if (!/\.(mov|mp4|m4v|avi|mxf|png|tif|tiff|jpg|jpeg|psd|aif|aiff|wav|mp3)$/i.test(outPath)) {
            throw new Error("outputPath needs a media extension (mov, mp4, png, tif, ...): " + outPath);
        }
        var dest = new File(outPath);
        if (dest.exists && args.overwrite !== true) {
            throw new Error("Refusing to overwrite existing file (pass overwrite:true): " + outPath);
        }

        var paused = [];
        for (var q = 1; q <= rq.numItems; q++) {
            if (rq.item(q).render) { paused.push(q); rq.item(q).render = false; }
        }

        var item = rq.items.add(comp);
        var result;
        try {
            if (args.rsTemplate) { item.applyTemplate(String(args.rsTemplate)); }
            if (args.startTime !== undefined) { item.timeSpanStart = Number(args.startTime); }
            if (args.endTime !== undefined) { item.timeSpanDuration = Number(args.endTime) - item.timeSpanStart; }
            var mod = item.outputModule(1);
            mod.applyTemplate(String(args.omTemplate || "H.264 - Match Render Settings - 15 Mbps"));
            mod.file = dest;
            item.comment = "[MCP]";
            var t0 = new Date().getTime();
            rq.render();
            result = {
                compId: comp.id, compName: comp.name, outputPath: dest.fsName,
                status: String(item.status), done: (item.status === RQItemStatus.DONE),
                elapsedMs: new Date().getTime() - t0,
                exists: (new File(dest.fsName)).exists,
                bytes: (new File(dest.fsName)).exists ? (new File(dest.fsName)).length : 0
            };
        } finally {
            try { item.remove(); } catch (e) {}
            for (var p = 0; p < paused.length; p++) { try { rq.item(paused[p]).render = true; } catch (e) {} }
        }
        if (!result.done) { throw new Error("Render did not complete: status " + result.status); }
        return result;
    }
};
