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
            return td;
        }
        throw new Error("expected a string or {text,fontSize,font}");
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
            var nl = comp.layers.addNull(args.duration ? Number(args.duration) : undefined);
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
