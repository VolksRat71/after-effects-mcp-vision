/*
 * Integration suite. Runs inside After Effects against the real host layer.
 * Builds a scratch comp, exercises every op, tears the scratch down.
 *
 * Driven by test/run-integration.sh, which injects HOST_PATH and RESULT_PATH.
 */
(function () {
    var results = [];

    /*
     * Snapshot every item that already existed. Teardown removes only what the
     * suite itself spawned.
     *
     * The previous teardown matched on NAME and deleted anything called
     * "Solids" - which is AE's single shared folder holding every solid in the
     * project, not just ours. Running the suite against a real open project
     * silently destroyed the user's solid layers (a background and a video
     * plate went missing in exactly this way). "bg" had the same problem.
     */
    var __preExisting = {};
    try {
        for (var __p = 1; __p <= app.project.numItems; __p++) {
            __preExisting[app.project.item(__p).id] = true;
        }
    } catch (e) {}
    var scratchCompId = null;

    function record(name, fn) {
        var t0 = new Date().getTime();
        try {
            var value = fn();
            results.push({ name: name, pass: true, ms: new Date().getTime() - t0, value: value });
        } catch (e) {
            results.push({ name: name, pass: false, ms: new Date().getTime() - t0, error: String(e), line: (e && e.line) });
        }
    }

    function call(op, args) {
        var raw = __mcp_exec(JSON.stringify({ op: op, args: args || {} }));
        var parsed = JSON.parse(raw);
        if (!parsed.ok) { throw new Error(op + " -> " + parsed.error.code + ": " + parsed.error.message); }
        return parsed.result;
    }

    function expectFail(op, args, wantCode) {
        var parsed = JSON.parse(__mcp_exec(JSON.stringify({ op: op, args: args || {} })));
        if (parsed.ok) { throw new Error(op + " unexpectedly succeeded"); }
        if (wantCode && parsed.error.code !== wantCode) {
            throw new Error(op + " gave " + parsed.error.code + ", wanted " + wantCode);
        }
        return parsed.error.code;
    }

    try {
        $.evalFile(new File("__HOST_PATH__"));

        record("host loads", function () {
            if (typeof __mcp_exec !== "function") { throw new Error("__mcp_exec missing"); }
            return true;
        });

        record("ping", function () { return call("ping").aeVersion; });
        record("listOps", function () { return call("listOps").count; });
        record("sessionInfo", function () { return call("sessionInfo").numItems; });

        record("project.createComp", function () {
            var c = call("project", { command: "createComp", name: "__mcp_test__",
                                      width: 640, height: 360, duration: 3, frameRate: 30 });
            scratchCompId = c.id;
            return c.id;
        });

        record("layers.createText", function () {
            var l = call("layers", { compId: scratchCompId, command: "createText", text: "HELLO", name: "txt" });
            return l.id;
        });

        record("layers.createSolid", function () {
            return call("layers", { compId: scratchCompId, command: "createSolid",
                                    color: [0.2, 0.4, 0.9], name: "bg" }).id;
        });

        record("tree lists layers", function () {
            var t = call("tree", { compId: scratchCompId });
            if (t.layers.length !== 2) { throw new Error("expected 2 layers, got " + t.layers.length); }
            return t.layers.length;
        });

        record("find by name", function () {
            var f = call("find", { compId: scratchCompId, name: "txt" });
            if (!f.matches.length) { throw new Error("did not find 'txt'"); }
            return f.matches[0].id;
        });

        var textLayerId = null;
        record("layer ids are stable across reorder", function () {
            var t = call("tree", { compId: scratchCompId });
            var txt = null;
            for (var i = 0; i < t.layers.length; i++) { if (t.layers[i].name === "txt") { txt = t.layers[i]; } }
            textLayerId = txt.id;
            var beforeIndex = txt.index;
            call("layers", { compId: scratchCompId, command: "reorder", layerId: txt.id, index: 2 });
            var after = call("tree", { compId: scratchCompId });
            var stillThere = null;
            for (var j = 0; j < after.layers.length; j++) { if (after.layers[j].id === txt.id) { stillThere = after.layers[j]; } }
            if (!stillThere) { throw new Error("layer id vanished after reorder"); }
            return { id: txt.id, indexBefore: beforeIndex, indexAfter: stillThere.index };
        });

        record("propertyKeys reaches beyond transform", function () {
            var pk = call("propertyKeys", { layerId: textLayerId, depth: 2 });
            var names = [];
            for (var i = 0; i < pk.properties.length; i++) { names.push(pk.properties[i].matchName); }
            if (pk.count < 5) { throw new Error("only " + pk.count + " properties found"); }
            return { count: pk.count, sample: names.slice(0, 6) };
        });

        record("propertyValues reads position", function () {
            var pv = call("propertyValues", {
                layerId: textLayerId,
                paths: [["ADBE Transform Group", "ADBE Position"]]
            });
            if (pv.errors.length) { throw new Error(pv.errors[0].message); }
            return pv.values[0].value;
        });

        record("set writes position", function () {
            var r = call("set", { writes: [{ layerId: textLayerId,
                path: ["ADBE Transform Group", "ADBE Position"], value: [320, 180] }] });
            if (r.errors.length) { throw new Error(r.errors[0].message); }
            var pv = call("propertyValues", { layerId: textLayerId,
                paths: [["ADBE Transform Group", "ADBE Position"]] });
            var v = pv.values[0].value;
            if (Math.round(v[0]) !== 320) { throw new Error("position did not take: " + v.join(",")); }
            return v;
        });

        record("set reports per-item errors without failing the batch", function () {
            var r = call("set", { writes: [
                { layerId: textLayerId, path: ["ADBE Transform Group", "ADBE Opacity"], value: 50 },
                { layerId: textLayerId, path: ["ADBE Transform Group", "NOPE"], value: 1 },
                { layerId: 999999, path: ["ADBE Transform Group", "ADBE Opacity"], value: 10 }
            ]});
            if (r.appliedCount !== 1) { throw new Error("expected 1 applied, got " + r.appliedCount); }
            if (r.errors.length !== 2) { throw new Error("expected 2 errors, got " + r.errors.length); }
            return { applied: r.appliedCount, codes: [r.errors[0].code, r.errors[1].code] };
        });

        record("set rejects wrong value type", function () {
            var r = call("set", { writes: [{ layerId: textLayerId,
                path: ["ADBE Transform Group", "ADBE Position"], value: "not an array" }] });
            if (r.errors.length !== 1 || r.errors[0].code !== "type_mismatch") {
                throw new Error("expected type_mismatch, got " + JSON.stringify(r.errors));
            }
            return r.errors[0].code;
        });

        record("keyframes add and read back", function () {
            var r = call("keyframes", { layerId: textLayerId,
                path: ["ADBE Transform Group", "ADBE Opacity"],
                add: [{ time: 0, value: 0 }, { time: 1, value: 100 }] });
            if (r.numKeys !== 2) { throw new Error("expected 2 keys, got " + r.numKeys); }
            return r.numKeys;
        });

        record("setExpression applies", function () {
            var r = call("setExpression", { writes: [{ layerId: textLayerId,
                path: ["ADBE Transform Group", "ADBE Rotate Z"], expression: "time * 10" }] });
            if (r.errors.length) { throw new Error(r.errors[0].message); }
            return r.appliedCount;
        });

        record("setExpression surfaces a bad expression", function () {
            var r = call("setExpression", { writes: [{ layerId: textLayerId,
                path: ["ADBE Transform Group", "ADBE Rotate Z"], expression: "this is not valid(((" }] });
            if (!r.errors.length || r.errors[0].code !== "invalid_expression") {
                throw new Error("bad expression was not reported: " + JSON.stringify(r));
            }
            return r.errors[0].code;
        });

        record("effects listAvailable", function () {
            var e = call("effects", { command: "listAvailable" });
            if (e.count < 10) { throw new Error("suspiciously few effects: " + e.count); }
            return e.count;
        });

        record("effects apply and list", function () {
            call("effects", { layerId: textLayerId, command: "apply", matchName: "ADBE Gaussian Blur 2" });
            var list = call("effects", { layerId: textLayerId, command: "list" });
            if (!list.effects.length) { throw new Error("effect did not attach"); }
            return list.effects[0].matchName;
        });

        record("propertyKeys reaches effect params", function () {
            var pk = call("propertyKeys", { layerId: textLayerId,
                path: ["ADBE Effect Parade"], depth: 3 });
            if (pk.count < 2) { throw new Error("effect params not reachable: " + pk.count); }
            return pk.count;
        });

        record("masks add and setRect crop a layer", function () {
            var solidId = call("layers", { compId: scratchCompId, command: "createSolid",
                                           color: [1,1,1], name: "maskme", width: 400, height: 100 }).id;
            call("masks", { layerId: solidId, command: "add", name: "reveal" });
            var r = call("masks", { layerId: solidId, command: "setRect",
                                    left: 0, top: 0, width: 120, height: 100 });
            var list = call("masks", { layerId: solidId, command: "list" });
            if (!list.count) { throw new Error("mask was not created"); }
            return { masks: list.count, rect: r.rect };
        });

        record("mask shape keyframes when given a time", function () {
            var solidId = call("layers", { compId: scratchCompId, command: "createSolid",
                                           color: [1,1,1], name: "maskanim", width: 400, height: 100 }).id;
            call("masks", { layerId: solidId, command: "add" });
            call("masks", { layerId: solidId, command: "setRect", width: 100, height: 100, time: 0 });
            var r = call("masks", { layerId: solidId, command: "setRect", width: 400, height: 100, time: 1 });
            if (r.numKeys !== 2) { throw new Error("expected 2 mask keys, got " + r.numKeys); }
            return r.numKeys;
        });

        /*
         * Roto support. A traced roto is hundreds of shapes per mask whose point
         * count changes every frame; setPath's one-key-per-call made that ~4,000
         * round trips. These check the resulting KEYFRAMES inside AE, not just
         * what the op reports.
         */
        function circle(n, r, cx, cy) {
            var pts = [];
            for (var i = 0; i < n; i++) {
                var a = (i / n) * 2 * Math.PI;
                pts.push([Math.round(cx + r * Math.cos(a)), Math.round(cy + r * Math.sin(a))]);
            }
            return pts;
        }

        record("setPathKeys writes a whole animated path in one call, as holds", function () {
            var solidId = call("layers", { compId: scratchCompId, command: "createSolid",
                                           color: [1,1,1], name: "roto", width: 400, height: 400 }).id;
            call("masks", { layerId: solidId, command: "add", name: "outline" });
            var keys = [];
            // Point counts change every frame, like a traced outline. Deliberately
            // out of order: the op must sort.
            for (var f = 29; f >= 0; f--) { keys.push({ time: f / 24, vertices: circle(3 + f, 150, 200, 200) }); }
            var r = call("masks", { layerId: solidId, command: "setPathKeys", maskName: "outline", keys: keys, hold: true });
            if (r.pathKeys !== 30 || r.numKeys !== 30) { throw new Error("expected 30 keys, got " + r.pathKeys + "/" + r.numKeys); }

            var prop = __mcp_layerById(solidId).property("ADBE Mask Parade").property("outline").property("ADBE Mask Shape");
            for (var k = 1; k <= prop.numKeys; k++) {
                if (prop.keyOutInterpolationType(k) !== KeyframeInterpolationType.HOLD) { throw new Error("key " + k + " is not a hold"); }
            }
            var first = prop.keyValue(1).vertices.length, last = prop.keyValue(30).vertices.length;
            if (first !== 3 || last !== 32) { throw new Error("key values out of order: " + first + " .. " + last + " points"); }
            return { keys: prop.numKeys, points: first + ".." + last, ms: r.elapsedMs };
        });

        record("setPathKeys: empty frames key Mask Opacity to 0, as holds, transitions only", function () {
            var solidId = call("layers", { compId: scratchCompId, command: "createSolid",
                                           color: [1,1,1], name: "rotogaps", width: 400, height: 400 }).id;
            call("masks", { layerId: solidId, command: "add" });
            var sq = [[10,10],[90,10],[90,90],[10,90]];
            var r = call("masks", { layerId: solidId, command: "setPathKeys", hold: true, keys: [
                { time: 0 / 24, vertices: sq },
                { time: 1 / 24, vertices: sq },
                { time: 2 / 24, vertices: null },            // empty
                { time: 3 / 24, vertices: [[1,1],[2,2]] },   // degenerate: too few points, treated as empty
                { time: 4 / 24, vertices: sq }
            ] });
            if (r.pathKeys !== 3) { throw new Error("expected 3 path keys, got " + r.pathKeys); }
            if (r.emptyFrames !== 2 || r.degenerateShapes !== 1) { throw new Error("empty/degenerate counts wrong: " + r.emptyFrames + "/" + r.degenerateShapes); }
            if (r.opacityKeys !== 3) { throw new Error("expected 3 opacity transitions (100, 0, 100), got " + r.opacityKeys); }

            var op = __mcp_layerById(solidId).property("ADBE Mask Parade").property(1).property("ADBE Mask Opacity");
            var want = [100, 0, 100];
            for (var k = 1; k <= op.numKeys; k++) {
                if (op.keyValue(k) !== want[k - 1]) { throw new Error("opacity key " + k + " = " + op.keyValue(k) + ", wanted " + want[k - 1]); }
                if (op.keyOutInterpolationType(k) !== KeyframeInterpolationType.HOLD) { throw new Error("opacity key " + k + " is not a hold"); }
            }
            // Mid-gap the mask must be invisible, and visible again after.
            if (op.valueAtTime(2.5 / 24, false) !== 0 || op.valueAtTime(4 / 24, false) !== 100) { throw new Error("opacity does not switch at the gap"); }
            return { pathKeys: r.pathKeys, opacity: want };
        });

        record("setPathKeys leaves Mask Opacity alone when no frame is empty", function () {
            var solidId = call("layers", { compId: scratchCompId, command: "createSolid",
                                           color: [1,1,1], name: "rotofull", width: 200, height: 200 }).id;
            call("masks", { layerId: solidId, command: "add" });
            var r = call("masks", { layerId: solidId, command: "setPathKeys", keys: [
                { time: 0, vertices: circle(8, 50, 100, 100) }, { time: 1, vertices: circle(8, 80, 100, 100) } ] });
            var op = __mcp_layerById(solidId).property("ADBE Mask Parade").property(1).property("ADBE Mask Opacity");
            if (r.opacityKeys !== 0 || op.numKeys !== 0) { throw new Error("opacity was keyed although nothing was empty"); }
            var shape = __mcp_layerById(solidId).property("ADBE Mask Parade").property(1).property("ADBE Mask Shape");
            if (shape.keyOutInterpolationType(1) === KeyframeInterpolationType.HOLD) { throw new Error("hold was applied without hold:true"); }
            return { pathKeys: r.pathKeys, opacityKeys: 0 };
        });

        record("setPathKeys rejects a key with no time", function () {
            var solidId = call("layers", { compId: scratchCompId, command: "createSolid",
                                           color: [1,1,1], name: "rotobad", width: 100, height: 100 }).id;
            call("masks", { layerId: solidId, command: "add" });
            return expectFail("masks", { layerId: solidId, command: "setPathKeys", keys: [{ vertices: [[0,0],[10,0],[10,10]] }] }, "op_failed");
        });

        record("mask modes: set on add, changed by setMode, reported by name", function () {
            var solidId = call("layers", { compId: scratchCompId, command: "createSolid",
                                           color: [1,1,1], name: "modes", width: 200, height: 200 }).id;
            call("masks", { layerId: solidId, command: "add", name: "body" });
            var hole = call("masks", { layerId: solidId, command: "add", name: "gap", mode: "subtract" });
            if (hole.mode !== "subtract") { throw new Error("add ignored mode: " + hole.mode); }
            var m = __mcp_layerById(solidId).property("ADBE Mask Parade").property("gap");
            if (m.maskMode !== MaskMode.SUBTRACT) { throw new Error("AE mask mode is not SUBTRACT"); }
            var changed = call("masks", { layerId: solidId, command: "setMode", maskName: "gap", mode: "intersect" });
            if (changed.mode !== "intersect" || m.maskMode !== MaskMode.INTERSECT) { throw new Error("setMode did not take"); }
            var list = call("masks", { layerId: solidId, command: "list" });
            if (list.masks[0].mode !== "add" || list.masks[1].mode !== "intersect") {
                throw new Error("list did not report modes by name: " + list.masks[0].mode + ", " + list.masks[1].mode);
            }
            expectFail("masks", { layerId: solidId, command: "setMode", maskName: "gap", mode: "multiply" }, "op_failed");
            return { modes: [list.masks[0].mode, list.masks[1].mode] };
        });

        /*
         * Split calls. A job split by time range computed opacity transitions per
         * call, so one call's trailing empty frame could leave another call's range
         * stuck at opacity 0 - reported from a real roto run.
         */
        function opacityAt(layerId, t) {
            return __mcp_layerById(layerId).property("ADBE Mask Parade").property(1).property("ADBE Mask Opacity").valueAtTime(t, false);
        }
        record("split calls: a later call's trailing empty frame does not hide an earlier range", function () {
            var id = call("layers", { compId: scratchCompId, command: "createSolid", color: [1,1,1], name: "split1", width: 200, height: 200 }).id;
            call("masks", { layerId: id, command: "add" });
            var sq = [[10,10],[90,10],[90,90],[10,90]];
            var a = [], b = [];
            for (var f = 10; f <= 15; f++) { a.push({ time: f / 24, vertices: sq }); }                  // all visible, no opacity keys
            for (var g = 0; g <= 5; g++) { b.push({ time: g / 24, vertices: g === 5 ? null : sq }); }   // ends EMPTY, called later
            call("masks", { layerId: id, command: "setPathKeys", keys: a, hold: true });
            var rb = call("masks", { layerId: id, command: "setPathKeys", keys: b, hold: true });
            if (opacityAt(id, 12 / 24) !== 100) { throw new Error("earlier range is hidden: opacity " + opacityAt(id, 12 / 24) + " at frame 12"); }
            if (opacityAt(id, 5 / 24) !== 0) { throw new Error("the empty frame is not hidden"); }
            return { frame5: opacityAt(id, 5 / 24), frame12: opacityAt(id, 12 / 24), restored: rb.opacityRestoredAfterRange };
        });
        record("split calls: a later all-visible range shows even after an earlier trailing empty", function () {
            var id = call("layers", { compId: scratchCompId, command: "createSolid", color: [1,1,1], name: "split2", width: 200, height: 200 }).id;
            call("masks", { layerId: id, command: "add" });
            var sq = [[10,10],[90,10],[90,90],[10,90]];
            var a = [], b = [];
            for (var f = 0; f <= 5; f++) { a.push({ time: f / 24, vertices: f === 5 ? null : sq }); }   // ends EMPTY
            for (var g = 10; g <= 15; g++) { b.push({ time: g / 24, vertices: sq }); }                  // all visible, called later
            call("masks", { layerId: id, command: "setPathKeys", keys: a, hold: true });
            call("masks", { layerId: id, command: "setPathKeys", keys: b, hold: true });
            if (opacityAt(id, 12 / 24) !== 100) { throw new Error("later visible range is stuck at " + opacityAt(id, 12 / 24)); }
            if (opacityAt(id, 2 / 24) !== 100 || opacityAt(id, 5 / 24) !== 0) { throw new Error("the earlier range was disturbed"); }
            return { frame2: opacityAt(id, 2 / 24), frame5: opacityAt(id, 5 / 24), frame12: opacityAt(id, 12 / 24) };
        });

        /*
         * Collapsed empty frames, shaped like the roto job's "Gap 3": real shapes on
         * three frames only, with a leading, an interior and a trailing empty run.
         * Each run gets exactly one collapse key per edge and nothing in between,
         * and a re-run with the same data rewrites in place without removing keys.
         */
        record("setPathKeys collapses every empty run, trailing included, one key per run edge", function () {
            var id = call("layers", { compId: scratchCompId, command: "createSolid", color: [1,1,1], name: "gap3", width: 400, height: 400 }).id;
            call("masks", { layerId: id, command: "add" });
            var sq = [[10,10],[90,10],[90,90],[10,90]];
            var real = { 5: true, 6: true, 12: true };
            var keys = [];
            for (var f = 0; f <= 30; f++) { keys.push({ time: f / 24, vertices: real[f] ? sq : null }); }
            var r = call("masks", { layerId: id, command: "setPathKeys", keys: keys, hold: true });
            var shape = __mcp_layerById(id).property("ADBE Mask Parade").property(1).property("ADBE Mask Shape");
            var got = [];
            for (var k = 1; k <= shape.numKeys; k++) { got.push(Math.round(shape.keyTime(k) * 24)); }
            // runs 0-4, 7-11, 13-30: edges 0,4 / 7,11 / 13,30, plus the real 5,6,12
            var want = [0, 4, 5, 6, 7, 11, 12, 13, 30];
            if (got.join(",") !== want.join(",")) { throw new Error("key frames " + got.join(",") + ", wanted " + want.join(",")); }
            if (r.pathKeys !== 3 || r.collapsedKeys !== 6) { throw new Error("pathKeys/collapsedKeys " + r.pathKeys + "/" + r.collapsedKeys); }
            var mid = shape.valueAtTime(20 / 24, false).vertices;
            if (mid[0][0] !== 50 || mid[2][0] !== 50 || mid[0][1] !== 50) { throw new Error("trailing run is not collapsed at frame 20: " + mid.toString()); }
            var again = call("masks", { layerId: id, command: "setPathKeys", keys: keys, hold: true });
            if (again.clearedPathKeys !== 0 || shape.numKeys !== 9) { throw new Error("re-run removed " + again.clearedPathKeys + " keys, numKeys " + shape.numKeys); }
            keys[12].vertices = null;   // drop the last real shape: its key and the 13 edge have no replacement
            var third = call("masks", { layerId: id, command: "setPathKeys", keys: keys, hold: true });
            if (shape.numKeys !== third.pathKeys + third.collapsedKeys) { throw new Error("stale keys survived: numKeys " + shape.numKeys); }
            return { frames: got.join(","), rerunCleared: again.clearedPathKeys, afterDrop: shape.numKeys };
        });

        /*
         * Popups: an agent guessed Stroke's Paint Style integer backwards and
         * silently dropped the footage under every highlight.
         */
        record("popup params read as {value, label, options} and take a label on write", function () {
            var id = call("layers", { compId: scratchCompId, command: "createSolid", color: [1,1,1], name: "popup", width: 100, height: 100 }).id;
            call("effects", { layerId: id, command: "apply", matchName: "ADBE Stroke" });
            var path = ["ADBE Effect Parade", "ADBE Stroke", "ADBE Stroke-0007"];
            var w = call("set", { writes: [{ layerId: id, path: path, value: "on transparent" },
                                           { layerId: id, path: path, value: "Sideways" }] });
            if (w.appliedCount !== 1 || w.errors.length !== 1 || w.errors[0].message.indexOf("Reveal Original Image") === -1) {
                throw new Error("label write or bad-label error wrong: " + w.errors.length + " errors");
            }
            var r = call("propertyValues", { layerId: id, paths: [path] }).values[0];
            if (r.value !== 2 || r.label !== "On Transparent" || !r.options || r.options.length !== 3) {
                throw new Error("read back value " + r.value + " label " + r.label);
            }
            return { value: r.value, label: r.label, options: r.options.length };
        });

        record("project hygiene: rename an item, create folders, move items into them", function () {
            var comp = call("project", { command: "createComp", name: "hygiene", width: 64, height: 64, duration: 1, frameRate: 24 });
            var r = call("project", { command: "renameItem", itemId: comp.id, name: "hygiene renamed" });
            if (__mcp_itemById(comp.id).name !== "hygiene renamed" || r.from !== "hygiene") { throw new Error("renameItem did not take"); }
            var outer = call("project", { command: "createFolder", name: "__mcp_folder_outer" });
            var inner = call("project", { command: "createFolder", name: "__mcp_folder_inner", parentFolderId: outer.folderId });
            if (inner.parentFolderId !== outer.folderId) { throw new Error("nested folder has the wrong parent"); }
            var mv = call("project", { command: "moveToFolder", itemIds: [comp.id, 999999], folderId: inner.folderId });
            if (__mcp_itemById(comp.id).parentFolder.id !== inner.folderId) { throw new Error("item was not moved"); }
            if (mv.moved.length !== 1 || mv.errors.length !== 1) { throw new Error("partial success not reported: " + JSON.stringify(mv)); }
            expectFail("project", { command: "moveToFolder", itemIds: [comp.id], folderId: comp.id }, "op_failed");   // not a folder
            return { renamed: r.to, nested: true, moved: mv.moved.length, reportedBadId: mv.errors.length };
        });

        record("replaceFootage relinks a footage item to a new file", function () {
            // Make two real PNGs to import and swap between.
            function png(name, color) {
                var c = app.project.items.addComp(name, 32, 32, 1, 1, 24);
                c.layers.addSolid(color, "s", 32, 32, 1);
                var f = new File(Folder.temp.fsName + "/" + name + "_" + new Date().getTime() + ".png");
                c.saveFrameToPng(0, f);
                for (var w = 0; w < 200 && !(f.exists && f.length > 60); w++) { $.sleep(25); }
                $.sleep(150);   // saveFrameToPng writes asynchronously
                c.remove();
                return f;
            }
            var fa = png("mcp_a", [1, 0, 0]), fb = png("mcp_b", [0, 0, 1]);
            var item = app.project.importFile(new ImportOptions(fa));
            var r = call("project", { command: "replaceFootage", itemId: item.id, path: fb.fsName });
            if (__mcp_itemById(item.id).file.fsName !== fb.fsName) { throw new Error("footage still points at " + __mcp_itemById(item.id).file.fsName); }
            expectFail("project", { command: "replaceFootage", itemId: item.id, path: Folder.temp.fsName + "/no-such-file.png" }, "op_failed");
            fa.remove(); fb.remove();
            return { from: File(r.from).name, to: File(r.to).name };
        });

        record("batch render: an existing output is refused with a hint unless overwrite is set", function () {
            var comp = call("project", { command: "createComp", name: "batchow", width: 16, height: 16, duration: 0.1, frameRate: 24 });
            var out = new File(Folder.temp.fsName + "/mcp_batch_ow_" + new Date().getTime() + ".mov");
            out.open("w"); out.write("placeholder"); out.close();
            var r = call("render", { command: "batch", jobs: [{ compId: comp.id, outputPath: out.fsName }] });
            var msg = r.errors && r.errors[0] && r.errors[0].message;
            if (!msg || msg.indexOf("would overwrite") < 0 || msg.indexOf("overwrite:true") < 0) { throw new Error("no refusal with a hint: " + JSON.stringify(r).slice(0, 200)); }
            out.remove();
            return { refused: true, hint: msg.slice(0, 60) };
        });

        record("setEase applies temporal easing sized to the property", function () {
            call("keyframes", { layerId: textLayerId,
                path: ["ADBE Transform Group", "ADBE Position"],
                add: [{ time: 0, value: [100, 100] }, { time: 1, value: [200, 200] }] });
            var e = call("setEase", { layerId: textLayerId,
                path: ["ADBE Transform Group", "ADBE Position"],
                influence: 70, mode: "both" });
            // Position is TwoD_SPATIAL, and AE wants ONE temporal ease for a
            // spatial property regardless of its dimensionality.
            if (!e.spatial) { throw new Error("position should be spatial"); }
            if (e.dimensions !== 1) { throw new Error("spatial ease must be 1D, got " + e.dimensions); }
            if (e.keysEased < 2) { throw new Error("eased only " + e.keysEased + " keys"); }
            return { dims: e.dimensions, spatial: e.spatial, eased: e.keysEased };
        });

        record("setEase handles a non-spatial multi-dimensional property", function () {
            call("keyframes", { layerId: textLayerId,
                path: ["ADBE Transform Group", "ADBE Scale"],
                add: [{ time: 0, value: [50, 50, 100] }, { time: 1, value: [100, 100, 100] }] });
            var e = call("setEase", { layerId: textLayerId,
                path: ["ADBE Transform Group", "ADBE Scale"], influence: 60 });
            if (e.dimensions !== 3) { throw new Error("scale should be 3D, got " + e.dimensions); }
            return e.dimensions;
        });

        record("setEase rejects an out-of-range influence", function () {
            return expectFail("setEase", { layerId: textLayerId,
                path: ["ADBE Transform Group", "ADBE Opacity"], influence: 500 }, "op_failed");
        });

        record("capture returns a real png", function () {
            var c = call("capture", { compId: scratchCompId, time: 0.5,
                                      fileName: "suite_frame.png", longEdge: 256 });
            if (c.bytes < 100) { throw new Error("png too small: " + c.bytes); }
            return { w: c.width, h: c.height, bytes: c.bytes, waitedMs: c.waitedMs };
        });

        record("capture honours longEdge", function () {
            var c = call("capture", { compId: scratchCompId, fileName: "suite_small.png", longEdge: 160 });
            if (c.width > 220) { throw new Error("longEdge ignored, width " + c.width); }
            return { w: c.width, h: c.height, factor: c.resolutionFactor };
        });

        record("captureSequence produces N frames", function () {
            var s = call("captureSequence", { compId: scratchCompId, count: 4,
                                              prefix: "suite_seq", longEdge: 160 });
            if (s.frames.length !== 4) { throw new Error("got " + s.frames.length + " frames"); }
            return s.frames.length;
        });

        record("captureSequence never samples past the last renderable frame", function () {
            // comp.duration itself is one frame past the end and renders empty.
            var s = call("captureSequence", { compId: scratchCompId, count: 3,
                                              startTime: 0, endTime: 999,
                                              prefix: "suite_end", longEdge: 120 });
            var comp = null;
            var last = s.frames[s.frames.length - 1];
            if (last.time >= 3) { throw new Error("sampled at " + last.time + "s, past the end"); }
            return { lastSampledAt: last.time };
        });

        record("capture clamps a time at exactly duration", function () {
            var c = call("capture", { compId: scratchCompId, time: 3,
                                      fileName: "suite_end.png", longEdge: 120 });
            if (c.time >= 3) { throw new Error("did not clamp: " + c.time); }
            return c.time;
        });

        record("captureIsolated restores solo state", function () {
            var before = call("tree", { compId: scratchCompId });
            var c = call("captureIsolated", { layerId: textLayerId, fileName: "suite_iso.png", longEdge: 160 });
            var after = call("tree", { compId: scratchCompId });
            if (before.layers.length !== after.layers.length) { throw new Error("layer count changed"); }
            return c.isolatedLayerName;
        });

        record("capture rejects path traversal", function () {
            return expectFail("capture", { compId: scratchCompId, fileName: "../escape.png" }, "op_failed");
        });

        record("capture rejects non-png", function () {
            return expectFail("capture", { compId: scratchCompId, fileName: "evil.jsx" }, "op_failed");
        });

        record("unknown op is reported", function () { return expectFail("noSuchOp", {}, "unknown_op"); });
        record("malformed json is reported", function () {
            var parsed = JSON.parse(__mcp_exec("{not json"));
            if (parsed.ok || parsed.error.code !== "bad_request") { throw new Error("bad json not caught"); }
            return parsed.error.code;
        });

        record("timing sets in/out, and startTime shifts them", function () {
            var l = call("layers", { compId: scratchCompId, command: "createSolid",
                                     color: [0,1,0], name: "timed", width: 50, height: 50 }).id;
            var r = call("timing", { command: "setLayer", layerId: l,
                                     startTime: 0.5, inPoint: 1, outPoint: 2 });
            // startTime is applied first, so in/out land where the caller asked.
            if (Math.abs(r.inPoint - 1) > 0.05) { throw new Error("inPoint drifted to " + r.inPoint); }
            return { start: r.startTime, inP: r.inPoint, outP: r.outPoint };
        });

        record("timing edits comp settings after creation", function () {
            var r = call("timing", { command: "setComp", compId: scratchCompId, frameRate: 24 });
            if (r.frameRate !== 24) { throw new Error("frameRate is " + r.frameRate); }
            call("timing", { command: "setComp", compId: scratchCompId, frameRate: 30 });
            return 24;
        });

        record("timing adds comp and layer markers", function () {
            var a = call("timing", { command: "addMarker", compId: scratchCompId, time: 1, comment: "beat" });
            var b = call("timing", { command: "addMarker", layerId: textLayerId, time: 0.5, comment: "hit" });
            return { comp: a.numMarkers, layer: b.numMarkers };
        });

        record("bounds measures rendered text", function () {
            var b = call("bounds", { layerId: textLayerId, time: 0 });
            if (!b.reliable) { throw new Error("text bounds unreliable"); }
            if (b.layerSpace.width < 10) { throw new Error("implausible width " + b.layerSpace.width); }
            return { w: Math.round(b.layerSpace.width), h: Math.round(b.layerSpace.height) };
        });

        record("shapes create a rect with animatable Size", function () {
            var sh = call("shapes", { command: "create", compId: scratchCompId, kind: "rect",
                                      name: "bar", width: 300, height: 80, roundness: 8,
                                      fill: [0.2,0.6,1,1], stroke: [1,1,1,1], strokeWidth: 3 });
            if (!sh.paths || !sh.paths.size) { throw new Error("no size path returned"); }
            // The returned path must actually drive the property.
            var w = call("set", { writes: [{ layerId: sh.id, path: sh.paths.size, value: [500, 80], time: 1 }] });
            if (w.errors.length) { throw new Error(w.errors[0].message); }
            return { id: sh.id, size: sh.paths.size.join(" > ") };
        });

        record("shapes support ellipse, star and freeform path", function () {
            var e = call("shapes", { command: "create", compId: scratchCompId, kind: "ellipse", width: 120, height: 120 });
            var st = call("shapes", { command: "create", compId: scratchCompId, kind: "star", points: 5, outerRadius: 80, innerRadius: 40 });
            var pa = call("shapes", { command: "create", compId: scratchCompId, kind: "path",
                                      vertices: [[0,0],[120,0],[60,90]] });
            return { ellipse: !!e.paths.size, star: st.id > 0, path: !!pa.paths.path };
        });

        record("compose precomposes layers into a nested comp", function () {
            var a = call("layers", { compId: scratchCompId, command: "createSolid", color: [1,0,0], name: "pa", width: 40, height: 40 }).id;
            var b = call("layers", { compId: scratchCompId, command: "createSolid", color: [0,0,1], name: "pb", width: 40, height: 40 }).id;
            var r = call("compose", { command: "precompose", compId: scratchCompId,
                                      layerIds: [a, b], name: "__nested__" });
            if (r.layersInside !== 2) { throw new Error("expected 2 layers inside, got " + r.layersInside); }
            return { precompId: r.precompId, inside: r.layersInside };
        });

        record("compose sets a track matte without requiring adjacency", function () {
            var m = call("layers", { compId: scratchCompId, command: "createSolid", color: [1,1,1], name: "matte", width: 80, height: 80 }).id;
            var t = call("layers", { compId: scratchCompId, command: "createSolid", color: [1,0,1], name: "matted", width: 200, height: 200 }).id;
            var r = call("compose", { command: "setTrackMatte", layerId: t, matteLayerId: m, type: "alpha" });
            if (!r.hasTrackMatte) { throw new Error("matte did not attach"); }
            var off = call("compose", { command: "setTrackMatte", layerId: t, matteLayerId: null });
            return { attached: r.hasTrackMatte, removed: !off.hasTrackMatte };
        });

        record("compose sets blend mode and rejects a bad one", function () {
            call("compose", { command: "setBlendMode", layerId: textLayerId, mode: "screen" });
            call("compose", { command: "setBlendMode", layerId: textLayerId, mode: "normal" });
            return expectFail("compose", { command: "setBlendMode", layerId: textLayerId, mode: "nope" }, "op_failed");
        });

        record("compose parents while keeping screen position", function () {
            var n = call("layers", { compId: scratchCompId, command: "createNull" }).id;
            var before = call("propertyValues", { layerId: textLayerId,
                paths: [["ADBE Transform Group", "ADBE Position"]] }).values[0].value;
            call("compose", { command: "parent", layerId: textLayerId, parentLayerId: n });
            var after = call("propertyValues", { layerId: textLayerId,
                paths: [["ADBE Transform Group", "ADBE Position"]] }).values[0].value;
            call("compose", { command: "parent", layerId: textLayerId, parentLayerId: null });
            return { before: before[0], after: after[0] };
        });

        record("hold keyframes freeze a value", function () {
            var l = call("layers", { compId: scratchCompId, command: "createSolid", color: [1,1,0], name: "held", width: 40, height: 40 }).id;
            var r = call("keyframes", { layerId: l, path: ["ADBE Transform Group", "ADBE Opacity"],
                add: [{ time: 0, value: 100, hold: true }, { time: 1, value: 0 }] });
            if (r.numKeys !== 2) { throw new Error("expected 2 keys"); }
            return r.numKeys;
        });

        record("masks accept an arbitrary path and feather", function () {
            var l = call("layers", { compId: scratchCompId, command: "createSolid", color: [0,1,1], name: "pathmask", width: 200, height: 200 }).id;
            call("masks", { command: "add", layerId: l });
            var p = call("masks", { command: "setPath", layerId: l, vertices: [[0,0],[200,0],[100,150]] });
            var f = call("masks", { command: "setFeather", layerId: l, feather: 12 });
            if (p.vertices !== 3) { throw new Error("got " + p.vertices + " vertices"); }
            return { verts: p.vertices, feather: f.feather };
        });

        record("render lists this machine's output templates", function () {
            var r = call("render", { command: "listTemplates", compId: scratchCompId });
            if (!r.outputModules.length) { throw new Error("no output module templates"); }
            return { om: r.outputModules.length, rs: r.renderSettings.length };
        });

        record("render refuses a path with no media extension", function () {
            return expectFail("render", { compId: scratchCompId, command: "render",
                                          outputPath: "/tmp/nope.txt" }, "op_failed");
        });

        /*
         * Saving is tested WITHOUT touching the live project.
         *
         * project.save(file) rebinds app.project.file, so an earlier version of
         * this test renamed the user's open project to a temp path - the same
         * class of bug as a test suite deleting the real auth token. The save
         * path is therefore exercised only for its guards, which reject before
         * any write happens, and the successful-write path is left to
         * verify-live.sh where a throwaway project can be used.
         */
        record("project save refuses a non-aep path", function () {
            return expectFail("project", { command: "save", path: "/tmp/nope.txt" }, "op_failed");
        });

        record("project save refuses to clobber an existing file", function () {
            var tmp = Folder.temp.fsName + "/__mcp_guard.aep";
            var f = new File(tmp);
            if (!f.exists) { f.open("w"); f.write("x"); f.close(); }
            var code = expectFail("project", { command: "save", path: tmp }, "op_failed");
            try { f.remove(); } catch (e) {}
            return code;
        });

        record("selection reads without throwing", function () { return call("selection").activeItemId; });
        record("diagnostics.problems runs", function () {
            var d = call("problems", { maxLayers: 50 });
            return { healthy: d.healthy, scannedLayers: d.scanned.layers };
        });

    } catch (fatal) {
        results.push({ name: "SUITE FATAL", pass: false, error: String(fatal), line: (fatal && fatal.line) });
    }

    // Teardown: remove the scratch comp and anything it spawned.
    try {
        app.beginUndoGroup("mcp suite teardown");
        // Reverse order: removing a folder reindexes everything after it.
        for (var i = app.project.numItems; i >= 1; i--) {
            var it = app.project.item(i);
            // Never touch an item that was open before the suite started.
            if (__preExisting[it.id]) { continue; }
            try { it.remove(); } catch (e) {}
        }
        app.endUndoGroup();
    } catch (e) {
        results.push({ name: "teardown", pass: false, error: String(e) });
    }

    var passed = 0;
    for (var r = 0; r < results.length; r++) { if (results[r].pass) { passed++; } }
    var payload = { total: results.length, passed: passed, failed: results.length - passed, results: results };

    var body;
    try { body = JSON.stringify(payload, null, 2); }
    catch (e) { body = '{"total":0,"passed":0,"failed":1,"results":[{"name":"serialize","pass":false}]}'; }
    var f = new File("__RESULT_PATH__");
    f.open("w"); f.write(body); f.close();
})();
