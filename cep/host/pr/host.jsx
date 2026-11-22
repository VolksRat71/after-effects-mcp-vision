/*
 * Premiere Pro MCP Vision - ExtendScript host layer.
 *
 * Everything the panel runs goes through __mcp_exec, which takes a JSON
 * request string and always returns a JSON string:
 *
 *  1. ExtendScript is ES3 - no native JSON, hence the polyfill.
 *  2. `return` is illegal at top level, so every payload is a function call.
 *  3. CSInterface.evalScript collapses any failure to "EvalScript error.",
 *     so every error is caught and serialized here or it is lost.
 *  4. Premiere's importers and the New Sequence command can raise dialogs.
 *     Imports pass suppressUI and sequences are made from a preset through
 *     QE, which shows none.
 *
 * Undo: Premiere's scripting has no undo-group API, and each scripted edit is
 * its own undo step.
 */

#include "../json-polyfill.jsx"
#include "../bridgetalk.jsx"
#include "./util.jsx"
#include "./ops-query.jsx"
#include "./ops-project.jsx"
#include "./ops-edit.jsx"
#include "./ops-output.jsx"
#include "./ops.jsx"

// Set on every evaluation of this file, so a reload can be PROVEN by the stamp
// changing rather than assumed from a call that returned without error.
var __mcp_loadedAt = new Date().getTime();

function __mcp_serialize(obj) {
    try {
        return JSON.stringify(obj);
    } catch (e) {
        return '{"ok":false,"error":{"code":"serialize_failed","message":"' + String(e).replace(/"/g, "'") + '"}}';
    }
}

function __mcp_err(code, message, line) {
    var text = (message && message.message !== undefined) ? message.message : String(message);
    return { ok: false, error: { code: code, message: String(text), line: line } };
}

function __mcp_exec(reqJson) {
    var out;
    try {
        var req = null;
        try {
            req = JSON.parse(reqJson);
        } catch (e) {
            out = __mcp_err("bad_request", "Request was not valid JSON: " + String(e), __mcp_line(e));
        }
        if (req) {
            var op = req.op, args = req.args || {};
            if (!__mcp_ops.hasOwnProperty(op)) {
                out = __mcp_err("unknown_op", "No such op: " + op);
            } else {
                try {
                    out = { ok: true, result: __mcp_ops[op](args) };
                } catch (e) {
                    out = __mcp_err(e.code || "op_failed", e, __mcp_line(e));
                }
            }
        }
    } catch (e) {
        out = __mcp_err("host_failed", e, __mcp_line(e));
    }
    try {
        if (!out || out.ok === undefined) { out = __mcp_err("no_result", "op produced nothing"); }
        return __mcp_serialize(out);
    } catch (e) {
        return '{"ok":false,"error":{"code":"fatal","message":"serialize threw"}}';
    }
}
