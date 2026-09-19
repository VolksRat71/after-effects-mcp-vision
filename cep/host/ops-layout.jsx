/*
 * Layout jigs - the closest thing After Effects has to a layout engine.
 *
 * AE has none. There is no align API (the Align panel is not scriptable at
 * all), no distribute, no grid, no stack, no padding. Every position is
 * absolute arithmetic, which is why translating a four-tile Rive accordion
 * meant carrying 419.18 through 48 hand-written keyframes.
 *
 * MEASUREMENT
 * All of this rests on sourceRectAtTime, which has sharp edges:
 *   - it returns the SOURCE box, ignoring the layer's own Scale
 *   - it is in LAYER space, so it must be round-tripped through toComp()
 *   - it desyncs on time-stretched or offset layers unless you pass
 *     sourceTime(time) rather than time
 *   - it reports 0x0 on a freshly created shape layer until AE evaluates it
 * __mcp_measure handles all four and flags when the result is not trustworthy.
 *
 * STATIC vs RIGGED
 * Every jig takes mode: "static" | "rigged". Rigged writes the computed pixel
 * value FIRST and then attaches an expression on top. AE stores those
 * separately - the expression shadows the static value, and disabling it or
 * hitting an error reveals the baked pixels underneath. So a rigged layout
 * degrades to "correct but frozen" rather than "destroyed" when a layer is
 * renamed, the comp is precomposed, or the file is exported to Lottie, whose
 * native players do not evaluate expressions at all.
 */

/* Rendered bounds in COMP space, with the gotchas handled. */
function __mcp_measure(layer, time) {
    var comp = layer.containingComp;
    var t = (time === undefined || time === null) ? comp.time : Number(time);

    // Sample the SOURCE at the layer's own time, not comp time. These differ
    // whenever a layer is stretched, remapped, or does not start at zero.
    var st = t;
    try { if (typeof layer.sourceTime === "function") { st = layer.sourceTime(t); } } catch (e) {}

    var r = layer.sourceRectAtTime(st, false);
    var reliable = !(r.width === 0 && r.height === 0);

    // sourceRectAtTime ignores the layer's Scale, so apply it ourselves.
    var scale = [100, 100];
    try { scale = layer.property("ADBE Transform Group").property("ADBE Scale").value; } catch (e) {}
    var sx = scale[0] / 100, sy = scale[1] / 100;

    var anchor = layer.property("ADBE Transform Group").property("ADBE Anchor Point").value;
    var pos = layer.property("ADBE Transform Group").property("ADBE Position").value;

    // Corners in comp space, derived from the anchor rather than assumed.
    var left = pos[0] + (r.left - anchor[0]) * sx;
    var top  = pos[1] + (r.top  - anchor[1]) * sy;
    var w = r.width * sx, h = r.height * sy;

    return {
        layerId: layer.id, name: layer.name, reliable: reliable,
        left: left, top: top, right: left + w, bottom: top + h,
        width: w, height: h,
        centerX: left + w / 2, centerY: top + h / 2,
        source: { left: r.left, top: r.top, width: r.width, height: r.height },
        anchor: anchor, position: pos, scale: scale
    };
}

/*
 * Write a value, and optionally a rig on top of it.
 * Returns what actually happened rather than assuming the expression took -
 * AE disables a bad expression silently and only reports via expressionError.
 */
function __mcp_writeRigged(prop, value, expression, mode) {
    prop.setValue(value);
    var out = { value: value, rigged: false };
    if (mode === "rigged" && expression) {
        prop.expression = String(expression);
        if (prop.expressionError) {
            // Fall back to the baked pixels rather than leaving a broken rig.
            out.expressionError = prop.expressionError;
            prop.expression = "";
        } else {
            out.rigged = true;
            out.expression = expression;
        }
    }
    return out;
}

function __mcp_posProp(layer) {
    return layer.property("ADBE Transform Group").property("ADBE Position");
}

var __mcp_layoutOps = {

    /* Measure one or more layers. The read half of every jig. */
    measure: function (args) {
        var ids = args.layerIds || (args.layerId !== undefined ? [args.layerId] : []);
        if (!ids.length) { throw new Error("measure requires layerId or layerIds"); }
        var out = [];
        for (var i = 0; i < ids.length; i++) {
            out.push(__mcp_measure(__mcp_layerById(ids[i]), args.time));
        }
        return { time: (args.time === undefined ? null : args.time), measured: out };
    },

    /*
     * Move the anchor point WITHOUT the layer moving.
     * Setting an anchor alone shifts the layer by the anchor delta - measured at
     * 100px in the audit. Position must be compensated in the same call, which
     * is what every anchor-point utility in the industry exists to do.
     */
    anchor: function (args) {
        var layer = __mcp_layerById(args.layerId);
        var m = __mcp_measure(layer, args.time);
        if (!m.reliable) { throw new Error("Cannot measure layer " + layer.id + " - bounds are 0x0"); }

        var PRESET = {
            topLeft:      [0,   0  ], topCenter:    [0.5, 0  ], topRight:    [1, 0  ],
            middleLeft:   [0,   0.5], center:       [0.5, 0.5], middleRight: [1, 0.5],
            bottomLeft:   [0,   1  ], bottomCenter: [0.5, 1  ], bottomRight: [1, 1  ]
        };
        var f = PRESET[String(args.to)];
        if (!f) {
            var ks = []; for (var k in PRESET) { ks.push(k); }
            throw new Error("to must be one of: " + ks.join(", "));
        }

        var src = m.source;
        var newAnchor = [src.left + src.width * f[0], src.top + src.height * f[1]];
        var oldAnchor = m.anchor;
        var scale = m.scale;

        // Compensate position by the anchor delta, in comp units.
        var dx = (newAnchor[0] - oldAnchor[0]) * (scale[0] / 100);
        var dy = (newAnchor[1] - oldAnchor[1]) * (scale[1] / 100);
        var pos = m.position;
        var newPos = [pos[0] + dx, pos[1] + dy];
        if (pos.length > 2) { newPos.push(pos[2]); }

        layer.property("ADBE Transform Group").property("ADBE Anchor Point").setValue(
            (oldAnchor.length > 2) ? [newAnchor[0], newAnchor[1], oldAnchor[2]] : newAnchor);
        __mcp_posProp(layer).setValue(newPos);

        var after = __mcp_measure(layer, args.time);
        return {
            layerId: layer.id, to: args.to,
            anchor: { before: oldAnchor, after: newAnchor },
            position: { before: pos, after: newPos },
            // Prove it did not move, rather than claiming it.
            movedBy: { x: Math.round((after.left - m.left) * 100) / 100,
                       y: Math.round((after.top - m.top) * 100) / 100 }
        };
    },

    /* Align layers to each other, or to the comp. */
    align: function (args) {
        var ids = args.layerIds || [];
        if (!ids.length) { throw new Error("align requires layerIds"); }
        var comp = __mcp_resolveComp(args);
        var mode = args.mode || "static";
        var axis = String(args.align);

        var layers = [], boxes = [];
        for (var i = 0; i < ids.length; i++) {
            var l = __mcp_layerById(ids[i]);
            layers.push(l); boxes.push(__mcp_measure(l, args.time));
        }

        // Reference frame: the comp, or the union of the selection.
        var ref;
        if (args.relativeTo === "comp" || ids.length === 1) {
            ref = { left: 0, top: 0, right: comp.width, bottom: comp.height,
                    centerX: comp.width / 2, centerY: comp.height / 2 };
        } else {
            ref = { left: boxes[0].left, top: boxes[0].top, right: boxes[0].right, bottom: boxes[0].bottom };
            for (var b = 1; b < boxes.length; b++) {
                ref.left = Math.min(ref.left, boxes[b].left);
                ref.top = Math.min(ref.top, boxes[b].top);
                ref.right = Math.max(ref.right, boxes[b].right);
                ref.bottom = Math.max(ref.bottom, boxes[b].bottom);
            }
            ref.centerX = (ref.left + ref.right) / 2;
            ref.centerY = (ref.top + ref.bottom) / 2;
        }

        var pad = Number(args.padding || 0);
        var moved = [];
        for (var j = 0; j < layers.length; j++) {
            var m = boxes[j];
            if (!m.reliable) { moved.push({ layerId: m.layerId, skipped: "bounds are 0x0" }); continue; }
            var p = m.position.slice(0);
            var expr = null;

            if (axis === "left")   { p[0] += (ref.left + pad) - m.left; expr = "[" + (ref.left + pad) + " + (value[0] - thisLayer.sourceRectAtTime(time,false).left), value[1]]"; }
            else if (axis === "right")  { p[0] += (ref.right - pad) - m.right; }
            else if (axis === "centerX"){ p[0] += ref.centerX - m.centerX; }
            else if (axis === "top")    { p[1] += (ref.top + pad) - m.top; }
            else if (axis === "bottom") { p[1] += (ref.bottom - pad) - m.bottom; }
            else if (axis === "centerY"){ p[1] += ref.centerY - m.centerY; }
            else if (axis === "center") { p[0] += ref.centerX - m.centerX; p[1] += ref.centerY - m.centerY; }
            else { throw new Error("align must be left, right, centerX, top, bottom, centerY or center"); }

            __mcp_posProp(layers[j]).setValue(p);
            moved.push({ layerId: m.layerId, from: m.position, to: p });
        }
        return { align: axis, relativeTo: args.relativeTo || "selection", padding: pad,
                 reference: ref, mode: mode, moved: moved };
    },

    /*
     * Distribute evenly. Two genuinely different semantics, and picking the
     * wrong one is a classic layout bug:
     *   gaps    - equal SPACE between bounding boxes (what designers usually mean)
     *   centers - equal distance between centres (what naive code does)
     */
    distribute: function (args) {
        var ids = args.layerIds || [];
        if (ids.length < 3) { throw new Error("distribute needs at least 3 layers"); }
        var axis = (args.axis === "vertical") ? "vertical" : "horizontal";
        var by = (args.by === "centers") ? "centers" : "gaps";

        var items = [];
        for (var i = 0; i < ids.length; i++) {
            var l = __mcp_layerById(ids[i]);
            var m = __mcp_measure(l, args.time);
            if (!m.reliable) { throw new Error("Layer " + l.id + " has 0x0 bounds - cannot distribute"); }
            items.push({ layer: l, m: m });
        }
        // Sort by current position along the axis, so the caller does not have
        // to pass them in visual order.
        items.sort(function (a, b) {
            return axis === "horizontal" ? (a.m.left - b.m.left) : (a.m.top - b.m.top);
        });

        var first = items[0].m, last = items[items.length - 1].m;
        var moved = [];

        if (by === "centers") {
            var c0 = axis === "horizontal" ? first.centerX : first.centerY;
            var c1 = axis === "horizontal" ? last.centerX : last.centerY;
            var step = (c1 - c0) / (items.length - 1);
            for (var k = 1; k < items.length - 1; k++) {
                var it = items[k];
                var want = c0 + step * k;
                var p = it.m.position.slice(0);
                if (axis === "horizontal") { p[0] += want - it.m.centerX; } else { p[1] += want - it.m.centerY; }
                __mcp_posProp(it.layer).setValue(p);
                moved.push({ layerId: it.m.layerId, to: p });
            }
        } else {
            var spanStart = axis === "horizontal" ? first.left : first.top;
            var spanEnd = axis === "horizontal" ? last.right : last.bottom;
            var used = 0;
            for (var u = 0; u < items.length; u++) { used += axis === "horizontal" ? items[u].m.width : items[u].m.height; }
            var gap = ((spanEnd - spanStart) - used) / (items.length - 1);
            var cursor = spanStart;
            for (var g = 0; g < items.length; g++) {
                var itg = items[g];
                var pg = itg.m.position.slice(0);
                if (axis === "horizontal") { pg[0] += cursor - itg.m.left; cursor += itg.m.width + gap; }
                else { pg[1] += cursor - itg.m.top; cursor += itg.m.height + gap; }
                if (g > 0 && g < items.length - 1) {
                    __mcp_posProp(itg.layer).setValue(pg);
                    moved.push({ layerId: itg.m.layerId, to: pg });
                }
            }
            return { axis: axis, by: by, gap: Math.round(gap * 100) / 100, moved: moved };
        }
        return { axis: axis, by: by, moved: moved };
    }
,

    /*
     * Lay N layers out in a row, column or grid with a gap.
     * This is the jig the accordion needed: the reflow that cost 48
     * hand-written keyframes is `stack` plus one gap value.
     */
    stack: function (args) {
        var ids = args.layerIds || [];
        if (!ids.length) { throw new Error("stack requires layerIds"); }
        var dir = args.direction || "row";
        var gap = Number(args.gap === undefined ? 0 : args.gap);
        var cols = Number(args.columns || 0);
        var comp = __mcp_resolveComp(args);

        var items = [];
        for (var i = 0; i < ids.length; i++) {
            var l = __mcp_layerById(ids[i]);
            var m = __mcp_measure(l, args.time);
            if (!m.reliable) { throw new Error("Layer " + l.id + " has 0x0 bounds - cannot stack"); }
            items.push({ layer: l, m: m });
        }

        // Origin: an explicit point, or wherever the first item already sits.
        var ox = (args.x !== undefined) ? Number(args.x) : items[0].m.left;
        var oy = (args.y !== undefined) ? Number(args.y) : items[0].m.top;

        var placed = [], cx = ox, cy = oy, rowH = 0, col = 0;
        for (var j = 0; j < items.length; j++) {
            var it = items[j], m = it.m;
            var tx = cx, ty = cy;

            if (dir === "row") { cx += m.width + gap; }
            else if (dir === "column") { cy += m.height + gap; }
            else if (dir === "grid") {
                if (!cols) { throw new Error("grid requires columns"); }
                rowH = Math.max(rowH, m.height);
                col++;
                if (col >= cols) { col = 0; cx = ox; cy += rowH + gap; rowH = 0; }
                else { cx += m.width + gap; }
            } else { throw new Error("direction must be row, column or grid"); }

            var p = m.position.slice(0);
            p[0] += tx - m.left;
            p[1] += ty - m.top;
            __mcp_posProp(it.layer).setValue(p);
            placed.push({ layerId: m.layerId, left: tx, top: ty, width: m.width, height: m.height });
        }
        return { direction: dir, gap: gap, columns: cols || null,
                 origin: [ox, oy], count: placed.length, placed: placed };
    },

    /*
     * Pin a layer to a comp edge or corner with padding.
     * In rigged mode this emits an expression referencing thisComp.width /
     * .height, so the layout survives a comp resize - which is what makes one
     * build deliverable at 1:1, 9:16 and 4:5.
     */
    pin: function (args) {
        var layer = __mcp_layerById(args.layerId);
        var comp = layer.containingComp;
        var m = __mcp_measure(layer, args.time);
        if (!m.reliable) { throw new Error("Cannot measure layer " + layer.id + " - bounds are 0x0"); }
        var pad = Number(args.padding || 0);
        var mode = args.mode || "static";

        var TO = {
            topLeft: [0,0], topCenter: [0.5,0], topRight: [1,0],
            middleLeft: [0,0.5], center: [0.5,0.5], middleRight: [1,0.5],
            bottomLeft: [0,1], bottomCenter: [0.5,1], bottomRight: [1,1]
        };
        var f = TO[String(args.to)];
        if (!f) { var ks=[]; for (var k in TO) { ks.push(k); } throw new Error("to must be one of: " + ks.join(", ")); }

        // Target the layer's own edge that faces the comp edge.
        var wantLeft = f[0] === 0 ? pad : (f[0] === 1 ? comp.width - pad - m.width : (comp.width - m.width) / 2);
        var wantTop  = f[1] === 0 ? pad : (f[1] === 1 ? comp.height - pad - m.height : (comp.height - m.height) / 2);

        var p = m.position.slice(0);
        p[0] += wantLeft - m.left;
        p[1] += wantTop - m.top;

        /*
         * The rig re-derives from thisComp each frame. It measures the layer's
         * own rect so it stays correct if the text changes, and offsets by the
         * gap between the anchor and the rect - that is what keeps a
         * baseline-left text layer from drifting.
         */
        var expr =
            "var pad = " + pad + ";\n" +
            "var r = thisLayer.sourceRectAtTime(time, false);\n" +
            "var a = thisLayer.transform.anchorPoint;\n" +
            "var dx = a[0] - r.left, dy = a[1] - r.top;\n" +
            "var x = " + (f[0] === 0 ? "pad + dx"
                        : f[0] === 1 ? "thisComp.width - pad - r.width + dx"
                                     : "(thisComp.width - r.width)/2 + dx") + ";\n" +
            "var y = " + (f[1] === 0 ? "pad + dy"
                        : f[1] === 1 ? "thisComp.height - pad - r.height + dy"
                                     : "(thisComp.height - r.height)/2 + dy") + ";\n" +
            "[x, y]";

        var w = __mcp_writeRigged(__mcp_posProp(layer), p, expr, mode);
        var after = __mcp_measure(layer, args.time);
        return { layerId: layer.id, to: args.to, padding: pad, mode: mode,
                 position: p, rigged: w.rigged, expressionError: w.expressionError || null,
                 resulting: { left: Math.round(after.left*10)/10, top: Math.round(after.top*10)/10 } };
    },

    /*
     * Size a box to fit another layer's content, with padding.
     * The canonical ad-graphics unit: a pill that hugs its text. In rigged mode
     * the box follows a text change; in static mode it is a snapshot.
     */
    fit: function (args) {
        var box = __mcp_layerById(args.layerId);
        var target = __mcp_layerById(args.toLayerId);
        var m = __mcp_measure(target, args.time);
        if (!m.reliable) { throw new Error("Cannot measure target layer - bounds are 0x0"); }

        var padX = Number(args.paddingX !== undefined ? args.paddingX : (args.padding || 0));
        var padY = Number(args.paddingY !== undefined ? args.paddingY : (args.padding || 0));
        var mode = args.mode || "static";

        // Only a shape layer has a Size to drive; a solid can only scale.
        var root = box.property("ADBE Root Vectors Group");
        if (!root) { throw new Error("fit needs a SHAPE layer (ae_shapes create) - a solid has no Size to drive"); }
        var sizeProp = null, groupName = null;
        for (var g = 1; g <= root.numProperties; g++) {
            var grp = root.property(g);
            if (grp.matchName !== "ADBE Vector Group") { continue; }
            var contents = grp.property("ADBE Vectors Group");
            for (var c = 1; c <= contents.numProperties; c++) {
                var sh = contents.property(c);
                if (sh.matchName === "ADBE Vector Shape - Rect") { sizeProp = sh.property("ADBE Vector Rect Size"); groupName = grp.name; }
                else if (sh.matchName === "ADBE Vector Shape - Ellipse") { sizeProp = sh.property("ADBE Vector Ellipse Size"); groupName = grp.name; }
            }
        }
        if (!sizeProp) { throw new Error("No rect or ellipse found on layer " + box.id); }

        var size = [m.width + padX * 2, m.height + padY * 2];
        var expr =
            "var pad = [" + padX + ", " + padY + "];\n" +
            "var L = thisComp.layer(" + target.index + ");\n" +
            "var r = L.sourceRectAtTime(L.sourceTime ? L.sourceTime(time) : time, false);\n" +
            "[r.width + pad[0]*2, r.height + pad[1]*2]";
        var w = __mcp_writeRigged(sizeProp, size, expr, mode);

        // Centre the box on the target's ink, not on its anchor.
        var bm = __mcp_measure(box, args.time);
        var bp = bm.position.slice(0);
        bp[0] += m.centerX - bm.centerX;
        bp[1] += m.centerY - bm.centerY;
        __mcp_posProp(box).setValue(bp);

        return { layerId: box.id, toLayerId: target.id, group: groupName,
                 measured: { width: m.width, height: m.height },
                 size: size, padding: [padX, padY], mode: mode,
                 rigged: w.rigged, expressionError: w.expressionError || null,
                 centeredAt: bp };
    },

    /*
     * Offset N layers in time by a fixed step.
     * IDEMPOTENT by construction: offsets are computed from a recorded base
     * startTime stored in the layer comment, so running it twice does not
     * compound. That is the classic automation failure and the reason a naive
     * stagger op is dangerous.
     */
    stagger: function (args) {
        var ids = args.layerIds || [];
        if (!ids.length) { throw new Error("stagger requires layerIds"); }
        var step = Number(args.step === undefined ? 0.1 : args.step);
        var from = Number(args.from || 0);
        var order = args.order || "listed";

        var items = [];
        for (var i = 0; i < ids.length; i++) { items.push(__mcp_layerById(ids[i])); }
        if (order === "index") { items.sort(function (a, b) { return a.index - b.index; }); }
        else if (order === "reverse") { items.reverse(); }

        var TAG = "[mcp:stagger-base=";
        var applied = [];
        for (var j = 0; j < items.length; j++) {
            var l = items[j];
            // Recover the ORIGINAL start time if we have staggered this before.
            var base = null;
            var comment = l.comment || "";
            var at = comment.indexOf(TAG);
            if (at !== -1) {
                var end = comment.indexOf("]", at);
                base = parseFloat(comment.substring(at + TAG.length, end));
            }
            if (base === null || isNaN(base)) {
                base = l.startTime;
                l.comment = comment + TAG + base + "]";
            }
            var t = from + step * j;
            l.startTime = base + t;
            applied.push({ layerId: l.id, name: l.name, baseStart: base, offset: t, startTime: l.startTime });
        }
        return { step: step, from: from, order: order, count: applied.length,
                 idempotent: true, applied: applied,
                 notes: "base start times are recorded in the layer comment, so re-running re-derives rather than compounds" };
    }
};
