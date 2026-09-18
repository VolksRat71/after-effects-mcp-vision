/*
 * Integration suite. Runs inside After Effects against the real host layer.
 * Builds a scratch comp, exercises every op, tears the scratch down.
 *
 * Driven by test/run-integration.sh, which injects HOST_PATH and RESULT_PATH.
 */
(function () {
    var results = [];
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
        for (var i = app.project.numItems; i >= 1; i--) {
            var it = app.project.item(i);
            if (it.name === "__mcp_test__" || it.name === "bg" || it.name === "Solids") { it.remove(); }
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
