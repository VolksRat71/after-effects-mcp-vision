/*
 * AE MCP Vision - op implementations.
 * Every op takes an args object and returns a plain serializable value.
 * Ops must not catch their own errors; __mcp_exec handles that uniformly.
 */

// Ops that change project state. These get wrapped in an undo group.
var __mcp_mutating = {
    capture: true   // mutates comp.resolutionFactor, then restores it
};

/*
 * Capture output is confined to one app-owned directory and callers pass a bare
 * filename, never a path. Accepting an arbitrary outPath made this an arbitrary
 * file write: anything that could reach the RPC port could drop a PNG anywhere
 * the AE process can write, including startup script folders.
 */
function __mcp_captureDir() {
    var dir = new Folder(Folder.temp.fsName + "/ae-mcp-vision");
    if (!dir.exists) { dir.create(); }
    return dir;
}

function __mcp_safeCaptureFile(fileName) {
    if (!fileName) { throw new Error("capture requires fileName"); }
    fileName = String(fileName);
    if (fileName.indexOf("/") !== -1 || fileName.indexOf("\\") !== -1 ||
        fileName.indexOf("..") !== -1 || fileName.indexOf(":") !== -1) {
        throw new Error("fileName must be a bare filename with no path separators");
    }
    if (!/^[A-Za-z0-9._-]+\.png$/.test(fileName)) {
        throw new Error("fileName must match [A-Za-z0-9._-]+.png");
    }
    return new File(__mcp_captureDir().fsName + "/" + fileName);
}

function __mcp_findComp(args) {
    var p = app.project;
    if (args.compId !== undefined && args.compId !== null) {
        var byId = p.itemByID(args.compId);
        if (!byId) { throw new Error("No item with id " + args.compId); }
        if (!(byId instanceof CompItem)) { throw new Error("Item " + args.compId + " is not a composition"); }
        return byId;
    }
    if (p.activeItem instanceof CompItem) { return p.activeItem; }
    for (var i = 1; i <= p.numItems; i++) {
        if (p.item(i) instanceof CompItem) { return p.item(i); }
    }
    throw new Error("No composition available");
}

var __mcp_ops = {

    ping: function () {
        return { pong: true, aeVersion: app.version, time: new Date().getTime() };
    },

    sessionInfo: function () {
        var p = app.project;
        var comps = [];
        for (var i = 1; i <= p.numItems; i++) {
            var it = p.item(i);
            if (it instanceof CompItem) {
                comps.push({
                    id: it.id, name: it.name, width: it.width, height: it.height,
                    frameRate: it.frameRate, duration: it.duration, numLayers: it.numLayers
                });
            }
        }
        var sel = [];
        for (var s = 0; s < p.selection.length; s++) { sel.push(p.selection[s].id); }
        return {
            aeVersion: app.version,
            projectName: p.file ? p.file.name : null,
            projectPath: p.file ? p.file.fsName : null,
            numItems: p.numItems,
            dirty: p.dirty,
            activeItemId: (p.activeItem ? p.activeItem.id : null),
            selectionIds: sel,
            comps: comps
        };
    },

    /*
     * Vision primitive. Verified against AE 26.0x67:
     *   saveFrameToPng returns in ~0ms and writes asynchronously; the file
     *   landed after a single 25ms poll. resolutionFactor controls real output
     *   pixel dimensions, so it is the cost lever for hitting a target size.
     */
    capture: function (args) {
        // Validate caller input BEFORE touching project state, so a bad
        // filename fails the same way whether or not a comp happens to exist.
        var file = __mcp_safeCaptureFile(args.fileName);
        var outPath = file.fsName;
        var comp = __mcp_findComp(args);

        var time = (args.time === undefined || args.time === null) ? comp.time : Number(args.time);
        if (time < 0 || time > comp.duration) {
            throw new Error("time " + time + "s outside comp duration (0-" + comp.duration + "s)");
        }

        var longEdge = Number(args.longEdge || 512);
        var compLong = Math.max(comp.width, comp.height);
        var factor = Math.max(1, Math.min(99, Math.round(compLong / longEdge)));

        var original = comp.resolutionFactor;
        var waited = 0;
        var timeoutMs = Number(args.timeoutMs || 10000);

        try {
            comp.resolutionFactor = [factor, factor];
            comp.saveFrameToPng(time, file);
            // The write is async with no callback - poll rather than trust the return.
            while (waited < timeoutMs) {
                file = new File(outPath);
                if (file.exists && file.length > 0) { break; }
                $.sleep(25);
                waited += 25;
            }
        } finally {
            try { comp.resolutionFactor = original; } catch (e) {}
        }

        if (!file.exists) {
            throw new Error("saveFrameToPng produced no file after " + waited + "ms at " + outPath);
        }

        return {
            path: outPath,
            compId: comp.id,
            compName: comp.name,
            time: time,
            requestedLongEdge: longEdge,
            resolutionFactor: factor,
            width: Math.round(comp.width / factor),
            height: Math.round(comp.height / factor),
            bytes: file.length,
            waitedMs: waited
        };
    }
};
