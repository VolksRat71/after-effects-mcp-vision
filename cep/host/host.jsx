/*
 * AE MCP Vision - ExtendScript host layer.
 *
 * Everything the panel runs goes through __mcp_exec. Four constraints are
 * baked in here because each one was verified the hard way against AE 26.0x67:
 *
 *  1. ExtendScript is ES3 - there is no native JSON. Hence the polyfill.
 *  2. `return` is illegal at top level, so every payload is an IIFE.
 *  3. An error thrown OUTSIDE a try block escapes beginSuppressDialogs and
 *     hangs AE on a modal until a human clicks OK. Suppression therefore wraps
 *     the serialization and the reply, not just the work.
 *  4. CSInterface.evalScript collapses any failure to the literal string
 *     "EvalScript error.", so errors must be serialized by us or they are lost.
 */

#include "./json-polyfill.jsx"
#include "./util.jsx"
#include "./ops-query.jsx"
#include "./ops-mutate.jsx"
#include "./ops-capture.jsx"
#include "./ops-diagnostics.jsx"
#include "./ops.jsx"

function __mcp_serialize(obj) {
    try {
        return JSON.stringify(obj);
    } catch (e) {
        // Last-ditch flat encoding so a serialization bug still returns something
        var s = '{"ok":false,"error":{"code":"serialize_failed","message":"';
        s += String(e).replace(/"/g, "'");
        s += '"}}';
        return s;
    }
}

function __mcp_err(code, message, line) {
    return { ok: false, error: { code: code, message: String(message), line: line } };
}

/**
 * Single entry point. Takes a JSON request string, always returns a JSON string.
 * Never throws, never lets a dialog escape.
 */
function __mcp_exec(reqJson) {
    var suppressed = false;
    var out;
    var undoOpen = false;

    try {
        app.beginSuppressDialogs();
        suppressed = true;

        var req;
        try {
            req = JSON.parse(reqJson);
        } catch (e) {
            out = __mcp_err("bad_request", "Request was not valid JSON: " + String(e), __mcp_line(e));
            req = null;
        }

        if (req) {
            var op = req.op;
            var args = req.args || {};

            if (!__mcp_ops.hasOwnProperty(op)) {
                out = __mcp_err("unknown_op", "No such op: " + op);
            } else {
                // Mutating ops get an undo group so an AI batch is one Cmd-Z.
                if (__mcp_mutating[op]) {
                    app.beginUndoGroup("MCP: " + op);
                    undoOpen = true;
                }
                try {
                    out = { ok: true, result: __mcp_ops[op](args) };
                } catch (e) {
                    out = __mcp_err("op_failed", e, __mcp_line(e));
                }
            }
        }
    } catch (e) {
        out = __mcp_err("host_failed", e, __mcp_line(e));
    }

    if (undoOpen) { try { app.endUndoGroup(); } catch (e) {} }

    var body;
    try {
        if (out && out.ok === undefined) { out = __mcp_err("no_result", "op produced nothing"); }
        body = __mcp_serialize(out);
    } catch (e) {
        body = '{"ok":false,"error":{"code":"fatal","message":"serialize threw"}}';
    }

    if (suppressed) { try { app.endSuppressDialogs(false); } catch (e) {} }
    return body;
}
