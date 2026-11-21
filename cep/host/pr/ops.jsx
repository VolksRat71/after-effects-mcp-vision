/*
 * Op registry. Merges the per-area op tables into the single dispatch table
 * __mcp_exec uses.
 */

var __mcp_ops = {};

(function () {
    var tables = [__mcp_queryOps, __mcp_projectOps, __mcp_editOps, __mcp_outputOps, __mcp_diagnosticOps];
    for (var t = 0; t < tables.length; t++) {
        for (var k in tables[t]) {
            if (tables[t].hasOwnProperty(k)) { __mcp_ops[k] = tables[t][k]; }
        }
    }
})();

__mcp_ops.ping = function () {
    return { pong: true, appVersion: app.version, time: new Date().getTime() };
};

function __mcp_opCount() {
    var n = 0;
    for (var k in __mcp_ops) { if (__mcp_ops.hasOwnProperty(k)) { n++; } }
    return n;
}

/*
 * Reloading happens in bridge.js, not here. $.evalFile defines everything in
 * the CALLING scope, so evaluating the host from inside this function would
 * reload nothing. bridge.js runs the evalFile at the top level of the same
 * evalScript, then calls this to report the outcome.
 */
__mcp_ops.reloadHost = function () {
    return { loadedAt: __mcp_loadedAt,
             reloadError: (typeof __mcp_reloadError === "undefined") ? null : __mcp_reloadError,
             opCount: __mcp_opCount() };
};

__mcp_ops.hostInfo = function () {
    return { loadedAt: __mcp_loadedAt, opCount: __mcp_opCount(), appVersion: app.version };
};

__mcp_ops.listOps = function () {
    var names = __mcp_keys(__mcp_ops);
    names.sort();
    return { count: names.length, ops: names };
};
