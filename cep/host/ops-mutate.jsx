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
            if (value.font !== undefined) { td.font = String(value.font); }
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
            } catch (e) {
                var code = String(e).indexOf("No property") !== -1 ? "unknown_path" : "write_failed";
                errors.push({ index: i, code: code, message: String(e), line: __mcp_line(e) });
            }
        }
        return { appliedCount: applied.length, applied: applied, errors: errors };
    },

    setExpression: function (args) {
        var writes = args.writes || [];
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

        if (cmd === "list") {
            var out = [];
            for (var i = 1; i <= parade.numProperties; i++) {
                var mk = parade.property(i);
                out.push({ index: i, name: mk.name, inverted: mk.inverted,
                           mode: String(mk.maskMode), path: ["ADBE Mask Parade", mk.name] });
            }
            return { layerId: layer.id, count: out.length, masks: out };
        }

        if (cmd === "add") {
            var m = parade.addProperty("ADBE Mask Atom");
            if (args.name) { m.name = String(args.name); }
            if (args.inverted) { m.inverted = true; }
            if (args.expansion !== undefined) {
                m.property("ADBE Mask Offset").setValue(Number(args.expansion));
            }
            if (args.feather !== undefined) {
                m.property("ADBE Mask Feather").setValue([Number(args.feather), Number(args.feather)]);
            }
            return { layerId: layer.id, maskIndex: m.propertyIndex, name: m.name };
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
        if (cmd === "save") {
            if (!p.file && !args.path) { throw new Error("Untitled project - pass path to save it somewhere"); }
            if (args.path) {
                var target = String(args.path);
                if (!/\.aepx?$/i.test(target)) {
                    throw new Error("Project path must end in .aep or .aepx, got: " + target);
                }
                var dest = new File(target);
                // Never silently overwrite someone's project file.
                if (dest.exists && args.overwrite !== true) {
                    throw new Error("Refusing to overwrite existing file (pass overwrite:true): " + target);
                }
                p.saveAs(dest);
            } else {
                p.save();
            }
            return { saved: true, path: p.file ? p.file.fsName : null };
        }
        throw new Error("Unknown project command: " + cmd);
    }
};
