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
 * Reloading happens in bridge.js, not here. $.evalFile defines everything in
 * the CALLING scope, so evaluating the host from inside this function reloaded
 * nothing - the new definitions were locals of this function and vanished when
 * it returned - while still reporting success. bridge.js runs the evalFile at
 * the top level of the same evalScript, then calls this to report the outcome.
 */
function __mcp_opCount() {
    var n = 0;
    for (var k in __mcp_ops) { if (__mcp_ops.hasOwnProperty(k)) { n++; } }
    return n;
}
__mcp_ops.reloadHost = function () {
    return { loadedAt: __mcp_loadedAt,
             reloadError: (typeof __mcp_reloadError === "undefined") ? null : __mcp_reloadError,
             opCount: __mcp_opCount() };
};
__mcp_ops.hostInfo = function () {
    return { loadedAt: __mcp_loadedAt, opCount: __mcp_opCount(), aeVersion: app.version };
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
