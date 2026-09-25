/*
 * Mutation ops. All of these run inside an undo group opened by __mcp_exec, so
 * any batch an agent applies is a single Cmd-Z for the human at the keyboard.
 *
 * Writes are batch-shaped and report per-item outcomes rather than failing the
 * whole call: one bad path in a batch of twenty should not discard the other
 * nineteen. Error codes are machine-readable so a model can correct itself.
 */

function __mcp_coerceForProperty(p, value) {
    var vt = p.propertyValueType;
    if (vt === PropertyValueType.COLOR ||
        vt === PropertyValueType.ThreeD || vt === PropertyValueType.ThreeD_SPATIAL ||
        vt === PropertyValueType.TwoD || vt === PropertyValueType.TwoD_SPATIAL) {
        if (!(value instanceof Array)) {
            throw new Error("expected an array for " + __mcp_valueTypeName(p));
        }
        var out = [];
        for (var i = 0; i < value.length; i++) {
            var n = Number(value[i]);
            if (isNaN(n)) { throw new Error("non-numeric element at index " + i); }
            out.push(n);
        }
        return out;
    }
    if (vt === PropertyValueType.OneD || vt === PropertyValueType.LAYER_INDEX ||
        vt === PropertyValueType.MASK_INDEX) {
        // A popup takes its menu label too: "On Transparent" instead of a guessed 2.
        if (typeof value === "string" && isNaN(Number(value))) {
            var opts = __mcp_enumOptions(p);
            if (!opts) { throw new Error("expected a number - this parameter has no known option labels"); }
            for (var oi = 0; oi < opts.length; oi++) {
                if (opts[oi].toLowerCase() === value.toLowerCase()) { return oi + 1; }
            }
            throw new Error("no option '" + value + "' - options are: " + opts.join(" | "));
        }
        var num = Number(value);
        if (isNaN(num)) { throw new Error("expected a number"); }
        return num;
    }
    if (vt === PropertyValueType.TEXT_DOCUMENT) {
        // Mutate the live TextDocument so font/size/justification survive.
        var td = p.value;
        if (typeof value === "string") { td.text = value; return td; }
        if (value && typeof value === "object") {
            if (value.text !== undefined) { td.text = String(value.text); }
            if (value.fontSize !== undefined) { td.fontSize = Number(value.fontSize); }
            if (value.font !== undefined) { td.font = __mcp_resolveFont(String(value.font)); }
            if (value.fillColor !== undefined) { td.fillColor = value.fillColor; }
            if (value.tracking !== undefined) { td.tracking = Number(value.tracking); }
            if (value.leading !== undefined) { td.leading = Number(value.leading); }
            /*
             * Justification matters more than it looks. Point text anchors at
             * the baseline LEFT, so setting a layer's position to the comp
             * centre puts the text's left edge there, not its middle - it reads
             * as "pushed right and clipped". Centre-justifying is the fix, and
             * without this branch there was no way to reach it.
             */
            if (value.justification !== undefined) {
                var j = String(value.justification).toLowerCase();
                if (j === "center" || j === "centre") { td.justification = ParagraphJustification.CENTER_JUSTIFY; }
                else if (j === "left") { td.justification = ParagraphJustification.LEFT_JUSTIFY; }
                else if (j === "right") { td.justification = ParagraphJustification.RIGHT_JUSTIFY; }
                else { throw new Error("justification must be left, center or right"); }
            }
            return td;
        }
        throw new Error("expected a string or {text,fontSize,font,justification,fillColor,tracking,leading}");
    }
    return value;
}

var __mcp_mutateOps = {

    /*
     * Generic batched write - the AE analogue of Rive's set_property_values.
     * writes: [{ layerId, path:[matchNames], value, time? }]
     * A `time` turns the write into a keyframe instead of a static value.
     */
    set: function (args) {
        var writes = args.writes || [];
        if (!writes.length) { throw new Error("set requires a non-empty writes array"); }
        var applied = [];
        var errors = [];
        var warnings = [];
        // Colours whose alpha AE ignores; the value that controls it lives next door.
        var ALPHA_IGNORED = { "ADBE Vector Fill Color": "ADBE Vector Fill Opacity",
                              "ADBE Vector Stroke Color": "ADBE Vector Stroke Opacity" };

        for (var i = 0; i < writes.length; i++) {
            var w = writes[i];
            var layer;
            try {
                layer = __mcp_layerById(w.layerId);
            } catch (le) {
                errors.push({ index: i, code: "unknown_id", message: String(le) });
                continue;
            }
            try {
                var p = __mcp_propByPath(layer, w.path);

                if (__mcp_propTypeName(p) !== "PROPERTY") {
                    errors.push({ index: i, code: "not_a_property",
                                  message: "Path resolves to a group, not a settable property" });
                    continue;
                }

                var coerced;
                try { coerced = __mcp_coerceForProperty(p, w.value); }
                catch (ce) {
                    errors.push({ index: i, code: "type_mismatch", message: String(ce) });
                    continue;
                }

                if (w.time !== undefined && w.time !== null) {
                    p.setValueAtTime(Number(w.time), coerced);
                } else {
                    p.setValue(coerced);
                }
                applied.push({ index: i, layerId: w.layerId, path: w.path });
                if (ALPHA_IGNORED.hasOwnProperty(p.matchName) && coerced.length > 3 && coerced[3] < 1) {
                    var opPath = w.path.slice(0, w.path.length - 1).concat([ALPHA_IGNORED[p.matchName]]);
                    warnings.push({ index: i, code: "alpha_ignored",
                                    message: "AE ignores the alpha of " + p.matchName + " - it renders opaque. Set " +
                                             ALPHA_IGNORED[p.matchName] + " (0-100) for transparency.",
                                    opacityPath: opPath, suggestedOpacity: coerced[3] * 100 });
                }
            } catch (e) {
                var code = String(e).indexOf("No property") !== -1 ? "unknown_path" : "write_failed";
                errors.push({ index: i, code: code, message: String(e), line: __mcp_line(e) });
            }
        }
        var res = { appliedCount: applied.length, applied: applied, errors: errors };
        if (warnings.length) { res.warnings = warnings; }
        return res;
    },

    setExpression: function (args) {
        var writes = args.writes || [];
        // Without this, a caller who passes the wrong key gets appliedCount 0
        // and an empty errors array - a success-shaped reply for a no-op.
        if (!writes.length) { throw new Error("setExpression requires a non-empty writes array: [{layerId, path, expression}]"); }
        var applied = [], errors = [];
        for (var i = 0; i < writes.length; i++) {
            var w = writes[i];
            try {
                var exLayer;
                try { exLayer = __mcp_layerById(w.layerId); }
                catch (le) { errors.push({ index: i, code: "unknown_id", message: String(le) }); continue; }
                var p = __mcp_propByPath(exLayer, w.path);
                if (!p.canSetExpression) {
                    errors.push({ index: i, code: "read_only", message: "Property does not accept expressions" });
                    continue;
                }
                p.expression = String(w.expression || "");
                // AE does not throw on a bad expression; it disables it and
                // populates expressionError. Surface that as a real failure.
                if (w.expression && p.expressionError) {
                    errors.push({ index: i, code: "invalid_expression", message: p.expressionError });
                    continue;
                }
                applied.push({ index: i, layerId: w.layerId, path: w.path });
            } catch (e) {
                errors.push({ index: i, code: "write_failed", message: String(e) });
            }
        }
        return { appliedCount: applied.length, applied: applied, errors: errors };
    },

    /* Keyframes: add / change / delete in one call. */
    keyframes: function (args) {
        var layer = __mcp_layerById(args.layerId);
        var p = __mcp_propByPath(layer, args.path);
        var result = { added: 0, deleted: 0, errors: [] };

        var del = args.remove || [];
        // Descending so indices stay valid while removing.
        del.sort(function (a, b) { return b - a; });
        for (var d = 0; d < del.length; d++) {
            try { p.removeKey(Number(del[d])); result.deleted++; }
            catch (e) { result.errors.push({ keyIndex: del[d], code: "remove_failed", message: String(e) }); }
        }

        var add = args.add || [];
        for (var a = 0; a < add.length; a++) {
            try {
                p.setValueAtTime(Number(add[a].time), __mcp_coerceForProperty(p, add[a].value));
                // A hold key freezes the value until the next key: the right
                // tool for cuts, on/off states and stepped motion.
                if (add[a].hold) {
                    var ki = p.nearestKeyIndex(Number(add[a].time));
                    p.setInterpolationTypeAtKey(ki, KeyframeInterpolationType.HOLD, KeyframeInterpolationType.HOLD);
                }
                result.added++;
            } catch (e) {
                result.errors.push({ index: a, code: "add_failed", message: String(e) });
            }
        }

        var keys = [];
        for (var k = 1; k <= p.numKeys; k++) {
            keys.push({ index: k, time: p.keyTime(k), value: __mcp_readValue({ value: p.keyValue(k), propertyValueType: p.propertyValueType }) });
        }
        result.keys = keys;
        result.numKeys = p.numKeys;
        return result;
    },

    /*
     * Easing. Without this every keyframe is linear, which reads mechanically -
     * and Rive's own transitions carry interpolation, so a linear translation is
     * not a faithful one.
     *
     * `ease` is the influence percentage AE shows in its Keyframe Velocity
     * dialog. AE requires an ease array whose length matches the property's
     * dimensionality, so it is expanded per-property rather than assumed 1D.
     */
    setEase: function (args) {
        var layer = __mcp_layerById(args.layerId);
        var p = __mcp_propByPath(layer, args.path);
        if (!p.numKeys) { throw new Error("Property has no keyframes to ease"); }

        var influence = Number(args.influence === undefined ? 50 : args.influence);
        if (influence < 0.1 || influence > 100) { throw new Error("influence must be 0.1-100"); }
        var mode = args.mode || "both";

        /*
         * SPATIAL properties take exactly ONE temporal ease, not one per
         * dimension - a spatial property moves along a single path through
         * time, so there is only one temporal curve regardless of whether it
         * is 2D or 3D. Passing one ease per dimension throws
         * "Unable to call setTemporalEaseAtKey". Only non-spatial multi-
         * dimensional properties want an ease per dimension.
         */
        var dims = 1;
        var vt = p.propertyValueType;
        if (vt === PropertyValueType.TwoD) { dims = 2; }
        else if (vt === PropertyValueType.ThreeD) { dims = 3; }
        else if (vt === PropertyValueType.COLOR) { dims = 4; }
        var spatial = (vt === PropertyValueType.TwoD_SPATIAL || vt === PropertyValueType.ThreeD_SPATIAL);
        if (spatial) { dims = 1; }

        function easeArray(inf) {
            var arr = [];
            for (var d = 0; d < dims; d++) { arr.push(new KeyframeEase(0, inf)); }
            return arr;
        }

        var indices = args.keyIndices && args.keyIndices.length ? args.keyIndices : null;
        var touched = 0;
        for (var k = 1; k <= p.numKeys; k++) {
            if (indices) {
                var wanted = false;
                for (var q = 0; q < indices.length; q++) { if (Number(indices[q]) === k) { wanted = true; } }
                if (!wanted) { continue; }
            }
            var inEase = easeArray(mode === "out" ? 0.1 : influence);
            var outEase = easeArray(mode === "in" ? 0.1 : influence);
            p.setTemporalEaseAtKey(k, inEase, outEase);
            touched++;
        }
        return { layerId: layer.id, path: args.path, keysEased: touched,
                 influence: influence, mode: mode, dimensions: dims, spatial: spatial };
    },

    /* Layer lifecycle. */
    layers: function (args) {
        var cmd = args.command;
        var comp = __mcp_resolveComp(args);

        if (cmd === "createText") {
            var t = comp.layers.addText(String(args.text === undefined ? "" : args.text));
            if (args.name) { t.name = String(args.name); }
            return __mcp_layerSummary(t);
        }
        if (cmd === "createSolid") {
            var c = args.color || [1, 1, 1];
            var s = comp.layers.addSolid(
                [Number(c[0]), Number(c[1]), Number(c[2])],
                String(args.name || "Solid"),
                Number(args.width || comp.width), Number(args.height || comp.height), 1);
            return __mcp_layerSummary(s);
        }
        if (cmd === "createBoxText") {
            // Paragraph text, which wraps. addText() only makes point text.
            var bw = Number(args.width || 400), bh = Number(args.height || 200);
            var bt = comp.layers.addBoxText([bw, bh]);
            if (args.text !== undefined) {
                var btd = bt.property("ADBE Text Properties").property("ADBE Text Document").value;
                btd.text = String(args.text);
                bt.property("ADBE Text Properties").property("ADBE Text Document").setValue(btd);
            }
            if (args.name) { bt.name = String(args.name); }
            var bs = __mcp_layerSummary(bt);
            bs.boxSize = [bw, bh];
            return bs;
        }
        if (cmd === "setCollapse") {
            var cl = __mcp_layerById(args.layerId);
            cl.collapseTransformation = (args.enabled !== false);
            return { layerId: cl.id, collapseTransformation: cl.collapseTransformation };
        }
        if (cmd === "applyPreset") {
            var pl = __mcp_layerById(args.layerId);
            var pf = new File(String(args.path));
            if (!pf.exists) { throw new Error("No preset at " + args.path); }
            pl.applyPreset(pf);
            return { layerId: pl.id, applied: pf.fsName };
        }
        if (cmd === "organise") {
            var ol = __mcp_layerById(args.layerId);
            var changed = {};
            if (args.label !== undefined) { ol.label = Number(args.label); changed.label = ol.label; }
            if (args.shy !== undefined) { ol.shy = (args.shy !== false); changed.shy = ol.shy; }
            if (args.guideLayer !== undefined) { ol.guideLayer = (args.guideLayer !== false); changed.guideLayer = ol.guideLayer; }
            if (args.solo !== undefined) { ol.solo = (args.solo !== false); changed.solo = ol.solo; }
            if (args.comment !== undefined) { ol.comment = String(args.comment); changed.comment = ol.comment; }
            return { layerId: ol.id, changed: changed };
        }
        if (cmd === "createShape") {
            var sh = comp.layers.addShape();
            if (args.name) { sh.name = String(args.name); }
            return __mcp_layerSummary(sh);
        }
        if (cmd === "createNull") {
            // ExtendScript cannot take an explicit `undefined` for an optional
            // argument - passing one throws "Unable to call addNull". The call
            // has to be branched rather than the value defaulted.
            var nl = (args.duration === undefined || args.duration === null)
                ? comp.layers.addNull()
                : comp.layers.addNull(Number(args.duration));
            if (args.name) { nl.name = String(args.name); }
            return __mcp_layerSummary(nl);
        }

        // Everything below addresses an existing layer by stable id.
        var layer = __mcp_layerById(args.layerId);
        if (cmd === "delete")    { var id = layer.id; layer.remove(); return { deletedLayerId: id }; }
        if (cmd === "duplicate") { return __mcp_layerSummary(layer.duplicate()); }
        if (cmd === "rename")    { layer.name = String(args.name); return __mcp_layerSummary(layer); }
        if (cmd === "select")    { layer.selected = (args.selected !== false); return __mcp_layerSummary(layer); }
        if (cmd === "setEnabled"){ layer.enabled = (args.enabled !== false); return __mcp_layerSummary(layer); }
        if (cmd === "setLocked") { layer.locked = (args.locked !== false); return __mcp_layerSummary(layer); }
        if (cmd === "reparent")  {
            layer.parent = (args.parentLayerId === null) ? null : __mcp_layerById(args.parentLayerId);
            return __mcp_layerSummary(layer);
        }
        if (cmd === "reorder") {
            var target = Number(args.index);
            if (target < 1 || target > comp.numLayers) {
                throw new Error("index out of range 1.." + comp.numLayers);
            }
            var current = layer.index;
            if (target !== current) {
                // moveBefore against your own position is an AE error, and the
                // direction of travel decides which primitive is legal.
                if (target < current) { layer.moveBefore(comp.layer(target)); }
                else { layer.moveAfter(comp.layer(target)); }
            }
            return __mcp_layerSummary(layer);
        }
        throw new Error("Unknown layers command: " + cmd);
    },

    /* Effects. */
    effects: function (args) {
        var cmd = args.command;

        if (cmd === "listAvailable") {
            var out = [];
            for (var i = 0; i < app.effects.length; i++) {
                out.push({ displayName: app.effects[i].displayName, matchName: app.effects[i].matchName });
            }
            return { count: out.length, effects: out };
        }

        var layer = __mcp_layerById(args.layerId);
        var parade = layer.property("ADBE Effect Parade");
        if (!parade) { throw new Error("Layer does not support effects"); }

        if (cmd === "list") {
            var list = [];
            for (var j = 1; j <= parade.numProperties; j++) {
                var e = parade.property(j);
                list.push({ index: j, name: e.name, matchName: e.matchName,
                            path: ["ADBE Effect Parade", e.matchName] });
            }
            return { layerId: layer.id, effects: list };
        }
        if (cmd === "apply") {
            var applied = parade.addProperty(String(args.matchName));
            if (args.name) { applied.name = String(args.name); }
            return { layerId: layer.id, name: applied.name, matchName: applied.matchName,
                     path: ["ADBE Effect Parade", applied.matchName] };
        }
        if (cmd === "remove") {
            var victim = parade.property(String(args.matchName));
            if (!victim) { throw new Error("No effect '" + args.matchName + "' on that layer"); }
            victim.remove();
            return { layerId: layer.id, removed: args.matchName };
        }
        throw new Error("Unknown effects command: " + cmd);
    },

    /*
     * Masks. The reason this exists: translating a Rive LayoutComponent, whose
     * `clip` property reveals a fixed-width bitmap, is impossible without one.
     * Scaling the layer instead squashes the artwork rather than revealing it.
     *
     * Mask vertices are in LAYER space - (0,0) is the layer's top-left, NOT the
     * comp origin and NOT the anchor point. A rect from (0,0) to (w,h) crops the
     * layer to its first w pixels, which is exactly a reveal.
     *
     * setRect accepts a `time`, making the mask shape a keyframe, so a reveal
     * animates without touching scale.
     */
    masks: function (args) {
        var cmd = args.command;
        var layer = __mcp_layerById(args.layerId);
        var parade = layer.property("ADBE Mask Parade");
        if (!parade) { throw new Error("Layer does not support masks"); }

        // Mask blend modes by the name an agent would use. Inverting a mask is
        // NOT the same as subtracting it: holes between limbs in a roto need
        // SUBTRACT, which nothing could previously write.
        var MODES = { none: MaskMode.NONE, add: MaskMode.ADD, subtract: MaskMode.SUBTRACT,
                      intersect: MaskMode.INTERSECT, lighten: MaskMode.LIGHTEN,
                      darken: MaskMode.DARKEN, difference: MaskMode.DIFFERENCE };
        function modeValue(name) {
            var k = String(name).toLowerCase();
            if (!MODES.hasOwnProperty(k)) {
                var names = []; for (var mn in MODES) { if (MODES.hasOwnProperty(mn)) { names.push(mn); } }
                throw new Error("mode must be one of: " + names.join(", "));
            }
            return MODES[k];
        }
        function modeName(v) {
            for (var mk2 in MODES) { if (MODES.hasOwnProperty(mk2) && MODES[mk2] === v) { return mk2; } }
            return String(v);
        }
        // maskIndex, else maskName, else the most recently added mask.
        function pickMask() {
            var picked = null;
            if (args.maskIndex) { picked = parade.property(Number(args.maskIndex)); }
            else if (args.maskName) { picked = parade.property(String(args.maskName)); }
            else if (parade.numProperties > 0) { picked = parade.property(parade.numProperties); }
            if (!picked) { throw new Error("No such mask - add one first, or check maskIndex/maskName"); }
            return picked;
        }

        if (cmd === "list") {
            var out = [];
            for (var i = 1; i <= parade.numProperties; i++) {
                var mk = parade.property(i);
                out.push({ index: i, name: mk.name, inverted: mk.inverted,
                           mode: modeName(mk.maskMode), path: ["ADBE Mask Parade", mk.name] });
            }
            return { layerId: layer.id, count: out.length, masks: out };
        }

        if (cmd === "add") {
            var m = parade.addProperty("ADBE Mask Atom");
            if (args.name) { m.name = String(args.name); }
            if (args.inverted) { m.inverted = true; }
            if (args.mode) { m.maskMode = modeValue(args.mode); }
            if (args.expansion !== undefined) {
                m.property("ADBE Mask Offset").setValue(Number(args.expansion));
            }
            if (args.feather !== undefined) {
                m.property("ADBE Mask Feather").setValue([Number(args.feather), Number(args.feather)]);
            }
            return { layerId: layer.id, maskIndex: m.propertyIndex, name: m.name, mode: modeName(m.maskMode) };
        }

        if (cmd === "setRect") {
            var target = args.maskIndex ? parade.property(Number(args.maskIndex))
                                        : parade.property(parade.numProperties);
            if (!target) { throw new Error("No mask to set - add one first"); }
            var left = Number(args.left || 0);
            var top = Number(args.top || 0);
            var w = Number(args.width);
            var h = Number(args.height);
            if (isNaN(w) || isNaN(h)) { throw new Error("setRect requires width and height"); }

            var shape = new Shape();
            shape.vertices = [[left, top], [left + w, top], [left + w, top + h], [left, top + h]];
            shape.inTangents = [[0, 0], [0, 0], [0, 0], [0, 0]];
            shape.outTangents = [[0, 0], [0, 0], [0, 0], [0, 0]];
            shape.closed = true;

            var shapeProp = target.property("ADBE Mask Shape");
            if (args.time !== undefined && args.time !== null) {
                shapeProp.setValueAtTime(Number(args.time), shape);
            } else {
                shapeProp.setValue(shape);
            }
            return { layerId: layer.id, maskIndex: target.propertyIndex,
                     rect: { left: left, top: top, width: w, height: h },
                     time: (args.time === undefined ? null : Number(args.time)),
                     numKeys: shapeProp.numKeys };
        }

        if (cmd === "setPath") {
            var tp = args.maskIndex ? parade.property(Number(args.maskIndex)) : parade.property(parade.numProperties);
            if (!tp) { throw new Error("No mask to set - add one first"); }
            if (!args.vertices || args.vertices.length < 3) { throw new Error("setPath needs at least 3 vertices"); }
            var ps = new Shape(); var vv = [];
            for (var q = 0; q < args.vertices.length; q++) { vv.push([Number(args.vertices[q][0]), Number(args.vertices[q][1])]); }
            ps.vertices = vv; ps.closed = (args.closed !== false);
            var sp = tp.property("ADBE Mask Shape");
            if (args.time !== undefined && args.time !== null) { sp.setValueAtTime(Number(args.time), ps); } else { sp.setValue(ps); }
            return { layerId: layer.id, maskIndex: tp.propertyIndex, vertices: vv.length, numKeys: sp.numKeys };
        }
        if (cmd === "setMode") {
            var tm = pickMask();
            tm.maskMode = modeValue(args.mode);
            return { layerId: layer.id, maskIndex: tm.propertyIndex, name: tm.name, mode: modeName(tm.maskMode) };
        }

        /*
         * A whole animated path in one call. A roto is hundreds of shapes per
         * mask; setPath's one-key-per-call meant ~4,000 round trips and as many
         * undo steps for a 693-frame, 6-mask job. This builds every Shape and
         * writes them with a single setValuesAtTimes.
         *
         * keys:  [{ time, vertices: [[x,y],...] | null, closed? }] - comp seconds,
         *        LAYER-space pixels. Order does not matter.
         * hold:  make every key in this call a hold keyframe. Outlines whose
         *        point count changes frame to frame morph unpredictably under
         *        linear interpolation; holds show exactly the traced shape.
         * null vertices (or fewer than 3 points) mean "nothing this frame": the
         * path keeps its last shape and Mask Opacity is keyed to 0, then back to
         * 100 when a shape returns. Opacity keys are always holds, and only the
         * transitions are written.
         */
        if (cmd === "setPathKeys") {
            var km = pickMask();
            var keys = args.keys;
            if (!keys || !keys.length) { throw new Error("setPathKeys needs a non-empty keys array: [{time, vertices}]"); }
            var started = new Date().getTime();
            /*
             * Key times are COMP seconds, because that is what AE's keyframe API
             * takes. A tracker file indexes frames of the CLIP, so on a layer
             * whose startTime was shifted (or stretched) those frames land in
             * the wrong place. timeBase:"layer" maps layer time to comp time
             * (startTime + t * stretch/100); timeOffset adds seconds either way.
             */
            var toLayer = (args.timeBase === "layer");
            if (args.timeBase !== undefined && args.timeBase !== "comp" && !toLayer) {
                throw new Error("timeBase must be \"comp\" (default) or \"layer\"");
            }
            var tOffset = Number(args.timeOffset || 0);
            if (isNaN(tOffset)) { throw new Error("timeOffset must be a number of seconds"); }
            var stretch = toLayer ? layer.stretch / 100 : 1, shift = (toLayer ? layer.startTime : 0) + tOffset;
            var sorted = [];
            for (var kk = 0; kk < keys.length; kk++) {
                var src0 = keys[kk], kt0 = Number(src0.time);
                if (src0.time === undefined || src0.time === null || isNaN(kt0)) {
                    throw new Error("keys[" + kk + "] has no numeric time");
                }
                sorted.push({ time: shift + kt0 * stretch, vertices: src0.vertices, closed: src0.closed });
            }
            sorted.sort(function (a, b) { return Number(a.time) - Number(b.time); });

            var pTimes = [], pShapes = [], oTimes = [], oVals = [];
            var frames = [];   // {t, shape|null} in time order, for the collapse pass
            var empty = 0, degenerate = 0, prevVisible = null;
            for (var n = 0; n < sorted.length; n++) {
                var key = sorted[n];
                var t = Number(key.time);
                if (key.time === undefined || key.time === null || isNaN(t)) {
                    throw new Error("keys[" + n + "] (after sorting by time) has no numeric time");
                }
                var verts = key.vertices;
                var visible = !!(verts && verts.length >= 3);
                if (visible) {
                    var shp = new Shape(); var pts = [];
                    for (var vi = 0; vi < verts.length; vi++) { pts.push([Number(verts[vi][0]), Number(verts[vi][1])]); }
                    shp.vertices = pts;
                    shp.closed = (key.closed !== false);
                    pTimes.push(t); pShapes.push(shp);
                    frames.push({ t: t, shape: shp });
                } else {
                    empty++;
                    if (verts && verts.length) { degenerate++; }
                    frames.push({ t: t, shape: null });
                }
                if (visible !== prevVisible) { oTimes.push(t); oVals.push(visible ? 100 : 0); prevVisible = visible; }
            }

            /*
             * Empty frames also get a COLLAPSED path: every vertex on the
             * centroid of the neighbouring real shape. Opacity 0 keeps the render
             * clean, but AE draws every mask path on a selected layer whatever
             * its opacity, so a held last shape left stale outlines all over the
             * viewer - and before a mask's first real key AE shows that key, so a
             * shape appeared long before it existed. Keys go on the first and the
             * last frame of each empty run, so a non-hold path cannot grow across
             * the gap either. Opacity keys stay as belt and braces.
             */
            var collapsed = function (src) {
                var sv = src.vertices, cx = 0, cy = 0;
                for (var ci = 0; ci < sv.length; ci++) { cx += sv[ci][0]; cy += sv[ci][1]; }
                cx /= sv.length; cy /= sv.length;
                var dot = [];
                for (var cj = 0; cj < sv.length; cj++) { dot.push([cx, cy]); }
                var c = new Shape(); c.vertices = dot; c.closed = src.closed;
                return c;
            };
            var cTimes = [], cShapes = [];
            var r = 0;
            while (r < frames.length) {
                if (frames[r].shape) { r++; continue; }
                var runStart = r;
                while (r < frames.length && !frames[r].shape) { r++; }
                var runEnd = r - 1;
                var before = runStart > 0 ? frames[runStart - 1].shape : null;
                var after = r < frames.length ? frames[r].shape : null;
                if (!before && !after) { continue; }   // no real shape anywhere to collapse
                cTimes.push(frames[runStart].t); cShapes.push(collapsed(before || after));
                if (runEnd !== runStart) { cTimes.push(frames[runEnd].t); cShapes.push(collapsed(after || before)); }
            }

            /*
             * A call REPLACES its own time range: path keys inside [first, last]
             * go first, so a re-run gives exactly what was sent instead of
             * layering new keys over an earlier run's shapes and collapses.
             */
            var pathProp = km.property("ADBE Mask Shape");
            var rangeStart = Number(sorted[0].time), rangeEnd = Number(sorted[sorted.length - 1].time);
            var allTimes = pTimes.concat(cTimes), allShapes = pShapes.concat(cShapes);
            // removeKey is the slow part (~65 ms a key on a 505-key roto mask), so a
            // key this call rewrites at the same time is left for setValuesAtTimes
            // to overwrite, and only keys with no replacement are removed.
            var rewritten = {};
            for (var rw = 0; rw < allTimes.length; rw++) { rewritten[Math.round(allTimes[rw] * 1e4)] = true; }
            var clearedPathKeys = 0;
            for (var pk = pathProp.numKeys; pk >= 1; pk--) {
                var pkt = pathProp.keyTime(pk);
                if (pkt >= rangeStart - 1e-6 && pkt <= rangeEnd + 1e-6 && !rewritten[Math.round(pkt * 1e4)]) {
                    pathProp.removeKey(pk); clearedPathKeys++;
                }
            }
            if (allTimes.length) { pathProp.setValuesAtTimes(allTimes, allShapes); }
            var hold = (args.hold === true);
            if (hold) {
                for (var h = 0; h < allTimes.length; h++) {
                    pathProp.setInterpolationTypeAtKey(pathProp.nearestKeyIndex(allTimes[h]),
                        KeyframeInterpolationType.HOLD, KeyframeInterpolationType.HOLD);
                }
            }

            /*
             * Opacity is managed when this call has an empty frame, or when an
             * earlier call already keyed it. A job split across calls by time
             * range used to compute transitions per call only, so one call's
             * trailing "empty" could leave another call's range stuck at 0.
             * Now a call OWNS its range [first key, last key]: it clears the
             * opacity keys inside it, writes its own transitions, and hands back
             * to whatever the frame after its range showed before the call.
             */
            var opProp = km.property("ADBE Mask Opacity");
            var opacityKeys = 0, restoredAfter = null;
            if (empty > 0 || opProp.numKeys > 0) {
                var tStart = Number(sorted[0].time), tEnd = Number(sorted[sorted.length - 1].time);
                var fd = layer.containingComp.frameDuration;
                var restoreAt = tEnd + fd;
                var afterVal = opProp.valueAtTime(restoreAt, false);   // read BEFORE touching anything
                // Also drop keys at or past the comp's end: an older build wrote a
                // restore key there, and no current call can own it.
                var compEnd = layer.containingComp.duration;
                for (var dk = opProp.numKeys; dk >= 1; dk--) {
                    var kt = opProp.keyTime(dk);
                    if ((kt >= tStart - 1e-6 && kt <= tEnd + 1e-6) || kt >= compEnd - 1e-6) { opProp.removeKey(dk); }
                }
                opProp.setValuesAtTimes(oTimes, oVals);
                var governed = false;
                for (var ek = 1; ek <= opProp.numKeys; ek++) {
                    if (Math.abs(opProp.keyTime(ek) - restoreAt) < 1e-6) { governed = true; break; }
                }
                // No restore key past the end of the comp: nothing is there to hand back to.
                var pastEnd = restoreAt >= layer.containingComp.duration - 1e-6;
                if (!governed && !pastEnd && oVals[oVals.length - 1] !== afterVal) {
                    opProp.setValueAtTime(restoreAt, afterVal);
                    oTimes.push(restoreAt);
                    restoredAfter = afterVal;
                }
                for (var o = 0; o < oTimes.length; o++) {
                    opProp.setInterpolationTypeAtKey(opProp.nearestKeyIndex(oTimes[o]),
                        KeyframeInterpolationType.HOLD, KeyframeInterpolationType.HOLD);
                }
                opacityKeys = oTimes.length;
            }

            return { layerId: layer.id, maskIndex: km.propertyIndex, name: km.name,
                     pathKeys: pTimes.length, collapsedKeys: cTimes.length, opacityKeys: opacityKeys,
                     clearedPathKeys: clearedPathKeys, opacityNumKeys: opProp.numKeys,
                     timeBase: toLayer ? "layer" : "comp", compTimeRange: [sorted[0].time, sorted[sorted.length - 1].time],
                     emptyFrames: empty, degenerateShapes: degenerate, hold: hold,
                     opacityRestoredAfterRange: restoredAfter,
                     numKeys: pathProp.numKeys, elapsedMs: new Date().getTime() - started };
        }

        if (cmd === "rename") {
            var rm = pickMask();
            if (!args.newName) { throw new Error("rename needs newName"); }
            var oldName = rm.name;
            rm.name = String(args.newName);
            return { layerId: layer.id, maskIndex: rm.propertyIndex, oldName: oldName, name: rm.name };
        }
        if (cmd === "setFeather") {
            var tf = args.maskIndex ? parade.property(Number(args.maskIndex)) : parade.property(parade.numProperties);
            if (!tf) { throw new Error("No mask to set - add one first"); }
            var fp = tf.property("ADBE Mask Feather");
            var fv = [Number(args.feather || 0), Number(args.feather || 0)];
            if (args.time !== undefined && args.time !== null) { fp.setValueAtTime(Number(args.time), fv); } else { fp.setValue(fv); }
            return { layerId: layer.id, maskIndex: tf.propertyIndex, feather: fv[0], numKeys: fp.numKeys };
        }
        if (cmd === "remove") {
            var victim = parade.property(Number(args.maskIndex));
            if (!victim) { throw new Error("No mask at index " + args.maskIndex); }
            victim.remove();
            return { layerId: layer.id, removed: Number(args.maskIndex) };
        }
        throw new Error("Unknown masks command: " + cmd);
    },

    /* Project-level operations. */
    project: function (args) {
        var cmd = args.command;
        var p = app.project;

        if (cmd === "createComp") {
            var comp = p.items.addComp(
                String(args.name || "Comp"),
                Number(args.width || 1920), Number(args.height || 1080),
                Number(args.pixelAspect || 1), Number(args.duration || 10),
                Number(args.frameRate || 30));
            return __mcp_itemSummary(comp);
        }
        if (cmd === "deleteItem") { var it = __mcp_itemById(args.itemId); var id = it.id; it.remove(); return { deletedItemId: id }; }
        if (cmd === "import") {
            /*
             * import and save take absolute paths on purpose. Footage lives
             * wherever the user keeps it and projects save where the user wants,
             * so sandboxing these would break the tool rather than secure it.
             * The bearer token on the RPC port is the trust boundary: anything
             * holding it can drive After Effects as the user, which is the same
             * model every in-editor MCP server operates under. What is guarded
             * below is the narrower risk of destroying work by accident.
             */
            var f = new File(String(args.path));
            if (!f.exists) { throw new Error("No file at " + args.path); }
            if (f instanceof Folder) { throw new Error("Path is a folder, not a file: " + args.path); }
            var io = new ImportOptions(f);
            if (args.importAs === "composition" && io.canImportAs(ImportAsType.COMP)) {
                io.importAs = ImportAsType.COMP;
            }
            return __mcp_itemSummary(p.importFile(io));
        }
        if (cmd === "addToComp") {
            var comp2 = __mcp_resolveComp(args);
            var src = __mcp_itemById(args.itemId);
            return __mcp_layerSummary(comp2.layers.add(src));
        }
        /*
         * Project hygiene - what it takes to hand a project to someone else.
         * Found preparing a roto project to share as an example: layers could be
         * renamed but project items could not, and there were no folders,
         * relinking or Collect Files.
         */
        if (cmd === "renameItem") {
            var ri = __mcp_itemById(args.itemId);
            if (!args.name) { throw new Error("renameItem requires name"); }
            var riFrom = ri.name;
            ri.name = String(args.name);
            return { itemId: ri.id, from: riFrom, to: ri.name };
        }
        if (cmd === "createFolder") {
            var pf = args.parentFolderId ? __mcp_itemById(args.parentFolderId) : p.rootFolder;
            if (!(pf instanceof FolderItem)) { throw new Error("parentFolderId " + args.parentFolderId + " is not a folder"); }
            var nf = p.items.addFolder(String(args.name || "Folder"));
            if (pf !== p.rootFolder) { nf.parentFolder = pf; }
            return { folderId: nf.id, name: nf.name, parentFolderId: nf.parentFolder.id };
        }
        if (cmd === "moveToFolder") {
            var tf2 = args.folderId ? __mcp_itemById(args.folderId) : p.rootFolder;
            if (!(tf2 instanceof FolderItem)) { throw new Error("folderId " + args.folderId + " is not a folder"); }
            var mids = args.itemIds || [];
            if (!mids.length) { throw new Error("moveToFolder requires itemIds"); }
            var moved = [], moveErrors = [];
            for (var mi = 0; mi < mids.length; mi++) {
                try {
                    var mItem = __mcp_itemById(mids[mi]);
                    if (mItem === tf2) { throw new Error("cannot move a folder into itself"); }
                    mItem.parentFolder = tf2;
                    moved.push(mItem.id);
                } catch (e) { moveErrors.push({ itemId: mids[mi], message: String(e) }); }
            }
            return { folderId: tf2.id, moved: moved, errors: moveErrors };
        }
        if (cmd === "replaceFootage") {
            var fItem = __mcp_itemById(args.itemId);
            if (!(fItem instanceof FootageItem) || !fItem.file) { throw new Error("item " + args.itemId + " is not file-based footage"); }
            var nFile = new File(String(args.path || ""));
            if (!nFile.exists) { throw new Error("No file at " + args.path); }
            var fFrom = fItem.file.fsName;
            if (args.sequence === true) { fItem.replaceWithSequence(nFile, true); } else { fItem.replace(nFile); }
            return { itemId: fItem.id, from: fFrom, to: fItem.file ? fItem.file.fsName : null, missing: fItem.footageMissing };
        }
        if (cmd === "collect") {
            /*
             * Collect Files. AE's own command opens a modal dialog and is not
             * scriptable, so this does the same job directly: copy every
             * file-based footage item into <folder>/Footage, relink it, and save
             * the project into <folder>. Like AE's command, the original .aep on
             * disk is untouched - but the OPEN project becomes the collected copy.
             * Image sequences are reported, not copied: telling a sequence's
             * frames apart from unrelated files next to it is guesswork.
             */
            if (!args.folder) { throw new Error("collect requires folder, an absolute path"); }
            var cRoot = new Folder(String(args.folder));
            var cName = String(args.projectName || (p.file ? p.file.displayName : "collected.aep"));
            if (!/\.aepx?$/i.test(cName)) { cName += ".aep"; }
            var cProj = new File(cRoot.fsName + "/" + cName);
            // Check before copying anything, so a refusal leaves nothing half-done.
            if (cProj.exists && args.overwrite !== true) { throw new Error("Refusing to overwrite (pass overwrite:true): " + cProj.fsName); }
            if (!cRoot.exists && !cRoot.create()) { throw new Error("Could not create " + cRoot.fsName); }
            var cFoot = new Folder(cRoot.fsName + "/Footage");
            if (!cFoot.exists && !cFoot.create()) { throw new Error("Could not create " + cFoot.fsName); }
            var STILL = { png: 1, jpg: 1, jpeg: 1, tif: 1, tiff: 1, exr: 1, dpx: 1, psd: 1, tga: 1, bmp: 1, gif: 1 };
            var copied = [], skipped = [], used = {};
            for (var ci = 1; ci <= p.numItems; ci++) {
                var cItem = p.item(ci);
                if (!(cItem instanceof FootageItem) || !cItem.file) { continue; }   // solids, placeholders
                var cSrc = cItem.file;
                if (cItem.footageMissing || !cSrc.exists) { skipped.push({ itemId: cItem.id, name: cItem.name, reason: "missing on disk" }); continue; }
                var cExt = cSrc.displayName.split(".").pop().toLowerCase();
                if (STILL[cExt] && !cItem.mainSource.isStill) {
                    skipped.push({ itemId: cItem.id, name: cItem.name, reason: "image sequence - copy its folder and use replaceFootage with sequence:true" });
                    continue;
                }
                var cBase = cSrc.displayName;
                if (used[cBase.toLowerCase()]) { cBase = cItem.id + "_" + cBase; }
                used[cBase.toLowerCase()] = true;
                var cDst = new File(cFoot.fsName + "/" + cBase);
                if (cDst.fsName !== cSrc.fsName && !cSrc.copy(cDst)) {
                    skipped.push({ itemId: cItem.id, name: cItem.name, reason: "copy failed: " + cSrc.error });
                    continue;
                }
                cItem.replace(cDst);
                copied.push({ itemId: cItem.id, name: cItem.name, to: cDst.fsName });
            }
            p.save(cProj);
            return { folder: cRoot.fsName, project: cProj.fsName, collected: copied.length, copied: copied, skipped: skipped,
                     note: "The open project is now the collected copy; the original .aep on disk is untouched." };
        }

        if (cmd === "save") {
            if (!p.file && !args.path) { throw new Error("Untitled project - pass path to save it somewhere"); }
            if (args.path) {
                var target = String(args.path);
                if (!/\.aepx?$/i.test(target)) {
                    throw new Error("Project path must end in .aep or .aepx, got: " + target);
                }
                var dest = new File(target);
                // AE's own error for a missing folder is "File couldn't be opened for
                // writing .../x.49417.36289656.aep" - make the folder instead.
                if (dest.parent && !dest.parent.exists && !dest.parent.create()) {
                    throw new Error("Could not create the folder to save into: " + dest.parent.fsName);
                }
                // Never silently overwrite someone's project file.
                if (dest.exists && args.overwrite !== true) {
                    throw new Error("Refusing to overwrite existing file (pass overwrite:true): " + target);
                }
                // Project has save([file]), NOT saveAs - that belongs to other
                // Adobe apps. Calling saveAs throws "Function p.saveAs is undefined".
                p.save(dest);
            } else {
                p.save();
            }
            return { saved: true, path: p.file ? p.file.fsName : null };
        }
        throw new Error("Unknown project command: " + cmd);
    }
};
