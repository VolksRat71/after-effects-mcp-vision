/*
 * Op registry. Merges the per-area op tables into the single dispatch table
 * __mcp_exec uses, and declares which ops mutate the project (those get an
 * undo group, so an agent's whole batch is one Cmd-Z).
 */

var __mcp_ops = {};

(function () {
    var tables = [__mcp_queryOps, __mcp_mutateOps, __mcp_captureOps, __mcp_diagnosticOps, __mcp_buildOps, __mcp_layoutOps];
    for (var t = 0; t < tables.length; t++) {
        for (var k in tables[t]) {
            if (tables[t].hasOwnProperty(k)) { __mcp_ops[k] = tables[t][k]; }
        }
    }
})();

__mcp_ops.ping = function () {
    return { pong: true, aeVersion: app.version, time: new Date().getTime() };
};

__mcp_ops.sessionInfo = function () {
    var p = app.project;
    var comps = [];
    for (var i = 1; i <= p.numItems; i++) {
        if (p.item(i) instanceof CompItem) { comps.push(__mcp_itemSummary(p.item(i))); }
    }
    return {
        aeVersion: app.version,
        projectName: p.file ? p.file.name : null,
        projectPath: p.file ? p.file.fsName : null,
        numItems: p.numItems,
        dirty: p.dirty,
        activeItemId: p.activeItem ? p.activeItem.id : null,
        comps: comps
    };
};

/*
 * Re-evaluate the host from disk. CEP loads ScriptPath once per extension
 * start, so without this every host edit costs an After Effects restart.
 */
__mcp_ops.reloadHost = function (args) {
    // The Node side supplies the path; $.fileName is not usable under CEP.
    var candidates = [];
    if (args && args.hostPath) { candidates.push(String(args.hostPath)); }
    // $.fileName returned "8" under CEP, so only trust it if it looks like a path.
    if (__mcp_hostFile && String(__mcp_hostFile).indexOf("/") !== -1) { candidates.push(String(__mcp_hostFile)); }
    // Conventional CEP install location, as a last resort.
    try {
        candidates.push(Folder.userData.fsName +
            "/Adobe/CEP/extensions/com.aemcpvision.bridge/host/host.jsx");
    } catch (e) {}

    var f = null;
    for (var i = 0; i < candidates.length; i++) {
        var cand = new File(candidates[i]);
        if (cand.exists) { f = cand; break; }
    }
    if (!f) { throw new Error("could not locate host.jsx; tried: " + candidates.join(", ")); }
    $.evalFile(f);
    var n = 0;
    for (var k in __mcp_ops) { if (__mcp_ops.hasOwnProperty(k)) { n++; } }
    return { reloaded: true, file: f.fsName, opCount: n };
};

__mcp_ops.listOps = function () {
    var names = [];
    for (var k in __mcp_ops) { if (__mcp_ops.hasOwnProperty(k)) { names.push(k); } }
    names.sort();
    return { count: names.length, ops: names };
};

/*
 * Ops that change project state. capture* are included because they touch
 * comp.resolutionFactor and layer solo flags before restoring them - if one
 * throws mid-flight, the undo group is what gets the user back.
 */
var __mcp_mutating = {
    set: true, setExpression: true, keyframes: true,
    masks: true, setEase: true,
    timing: true, shapes: true, compose: true, render: true,
    shapeOps: true, projectFile: true, template: true, textAnimator: true,
    anchor: true, align: true, distribute: true, stack: true, pin: true, fit: true, stagger: true,
    layers: true, effects: true, project: true,
    capture: true, captureSequence: true, captureIsolated: true
};
