/*
 * Vision ops.
 *
 * Measured on AE 26.0x67: saveFrameToPng returns in ~0ms and writes
 * asynchronously with no callback; the file landed after a single 25ms poll.
 * comp.resolutionFactor controls real output pixel dimensions, so it is the
 * cost lever - a model rarely needs a full-res frame to judge layout.
 *
 * Output is confined to one app-owned directory (see __mcp_safeCaptureFile);
 * callers pass a bare filename, never a path.
 */

function __mcp_factorFor(comp, longEdge) {
    var compLong = Math.max(comp.width, comp.height);
    return Math.max(1, Math.min(99, Math.round(compLong / Math.max(1, longEdge))));
}

function __mcp_waitForFile(pathStr, timeoutMs) {
    var waited = 0;
    var f = new File(pathStr);
    while (waited < timeoutMs) {
        f = new File(pathStr);
        if (f.exists && f.length > 0) { return { file: f, waitedMs: waited }; }
        $.sleep(25);
        waited += 25;
    }
    return { file: null, waitedMs: waited };
}

function __mcp_captureOne(comp, time, fileName, longEdge, timeoutMs) {
    var file = __mcp_safeCaptureFile(fileName);
    var outPath = file.fsName;
    var factor = __mcp_factorFor(comp, longEdge);
    var original = comp.resolutionFactor;
    var res;
    try {
        comp.resolutionFactor = [factor, factor];
        comp.saveFrameToPng(time, file);
        res = __mcp_waitForFile(outPath, timeoutMs);
    } finally {
        try { comp.resolutionFactor = original; } catch (e) {}
    }
    if (!res.file) { throw new Error("saveFrameToPng produced no file after " + res.waitedMs + "ms"); }
    return {
        path: outPath, fileName: fileName, time: time,
        width: Math.round(comp.width / factor), height: Math.round(comp.height / factor),
        resolutionFactor: factor, bytes: res.file.length, waitedMs: res.waitedMs
    };
}

var __mcp_captureOps = {

    capture: function (args) {
        var file = __mcp_safeCaptureFile(args.fileName);
        var comp = __mcp_resolveComp(args);
        var time = (args.time === undefined || args.time === null) ? comp.time : Number(args.time);
        if (time < 0 || time > comp.duration) {
            throw new Error("time " + time + "s outside comp duration (0-" + comp.duration + "s)");
        }
        var frame = __mcp_captureOne(comp, time, args.fileName,
                                     Number(args.longEdge || 512), Number(args.timeoutMs || 10000));
        frame.compId = comp.id;
        frame.compName = comp.name;
        return frame;
    },

    /*
     * N frames across a time range. Motion is exactly what a single still
     * cannot show; the JS layer composites these into one contact sheet so the
     * model spends one image's worth of context instead of N.
     */
    captureSequence: function (args) {
        var comp = __mcp_resolveComp(args);
        var count = Math.max(2, Math.min(24, Number(args.count || 6)));
        var start = (args.startTime === undefined) ? 0 : Number(args.startTime);
        var end = (args.endTime === undefined) ? comp.duration : Number(args.endTime);
        if (end <= start) { throw new Error("endTime must be greater than startTime"); }

        var prefix = String(args.prefix || "seq");
        if (!/^[A-Za-z0-9_-]+$/.test(prefix)) { throw new Error("prefix must match [A-Za-z0-9_-]+"); }

        var longEdge = Number(args.longEdge || 320);
        var timeoutMs = Number(args.timeoutMs || 10000);
        var step = (end - start) / (count - 1);

        var frames = [], errors = [];
        for (var i = 0; i < count; i++) {
            var t = start + (step * i);
            if (t > comp.duration) { t = comp.duration; }
            try {
                frames.push(__mcp_captureOne(comp, t, prefix + "_" + i + ".png", longEdge, timeoutMs));
            } catch (e) {
                errors.push({ index: i, time: t, message: String(e) });
            }
        }
        return {
            compId: comp.id, compName: comp.name,
            startTime: start, endTime: end, count: frames.length,
            frames: frames, errors: errors
        };
    },

    /*
     * Solo one layer, capture, restore. Answers "why is this invisible", which
     * is near-impossible for a model to diagnose from the object tree alone.
     */
    captureIsolated: function (args) {
        var layer = __mcp_layerById(args.layerId);
        var comp = layer.containingComp;
        var time = (args.time === undefined || args.time === null) ? comp.time : Number(args.time);

        // Record every layer's solo state so we restore exactly what we found.
        var prior = [];
        for (var i = 1; i <= comp.numLayers; i++) {
            var l = comp.layer(i);
            prior.push({ layer: l, solo: l.solo });
        }
        var frame;
        try {
            for (var j = 0; j < prior.length; j++) {
                try { prior[j].layer.solo = (prior[j].layer.id === layer.id); } catch (e) {}
            }
            frame = __mcp_captureOne(comp, time, args.fileName,
                                     Number(args.longEdge || 512), Number(args.timeoutMs || 10000));
        } finally {
            for (var k = 0; k < prior.length; k++) {
                try { prior[k].layer.solo = prior[k].solo; } catch (e) {}
            }
        }
        frame.compId = comp.id;
        frame.isolatedLayerId = layer.id;
        frame.isolatedLayerName = layer.name;
        return frame;
    }
};
