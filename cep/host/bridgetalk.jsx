/*
 * Relay ops shared by the Premiere and After Effects hosts: hand a script to
 * Media Encoder through BridgeTalk and read the answer back later.
 *
 * Media Encoder's own CEP gives extensions no ExtendScript, so its server
 * borrows one of these two apps' engines to reach it. Only target "ame" is
 * accepted: this must never become a general way to run code in other apps.
 * Sends are ASYNC with no timeout argument; a synchronous send(timeout) or
 * BridgeTalk.getTargets() hung After Effects' script engine for two minutes.
 * ES3 only.
 */

// Kept across a host reload so answers already in flight are not lost.
if (typeof __mcp_bt === "undefined") {
    var __mcp_bt = { results: {}, order: [], seq: 0, max: 50 };
}

function __mcp_btFail(code, message) {
    var e = new Error(message);
    e.code = code;
    return e;
}

function __mcp_btRemember(id, entry) {
    __mcp_bt.results[id] = entry;
    __mcp_bt.order.push(id);
    while (__mcp_bt.order.length > __mcp_bt.max) {
        delete __mcp_bt.results[__mcp_bt.order.shift()];
    }
}

function __mcp_btForget(id) {
    delete __mcp_bt.results[id];
    for (var i = 0; i < __mcp_bt.order.length; i++) {
        if (__mcp_bt.order[i] === id) { __mcp_bt.order.splice(i, 1); break; }
    }
}

var __mcp_bridgeTalkOps = {};

__mcp_bridgeTalkOps.bridgeTalkSend = function (args) {
    if (!args || args.target !== "ame") {
        throw __mcp_btFail("bad_target", "bridgeTalkSend only reaches target \"ame\"");
    }
    if (typeof args.body !== "string" || !args.body) {
        throw __mcp_btFail("bad_value", "body must be a non-empty string");
    }
    var id = "bt" + (++__mcp_bt.seq) + "_" + new Date().getTime();
    var entry = { state: "pending", body: null, sentAt: new Date().getTime(),
                  timeoutMs: Number(args.timeoutMs) > 0 ? Number(args.timeoutMs) : 120000 };
    var bt = new BridgeTalk();
    bt.target = "ame";
    bt.body = args.body;
    bt.onResult = function (m) { entry.state = "done"; entry.body = String(m.body); };
    bt.onError = function (m) { entry.state = "error"; entry.body = String(m.body); };
    __mcp_btRemember(id, entry);
    var sent = false;
    try { sent = bt.send(); } catch (e) { __mcp_btForget(id); throw __mcp_btFail("send_failed", String(e)); }
    if (!sent) {
        __mcp_btForget(id);
        throw __mcp_btFail("send_failed", "BridgeTalk would not send; is Media Encoder running?");
    }
    return { id: id };
};

__mcp_bridgeTalkOps.bridgeTalkResult = function (args) {
    var id = args ? args.id : undefined;
    if (!__mcp_bt.results.hasOwnProperty(id)) {
        throw __mcp_btFail("unknown_id", "No pending BridgeTalk message " + id + " (already read, or dropped)");
    }
    var e = __mcp_bt.results[id];
    if (e.state === "pending" && new Date().getTime() - e.sentAt > e.timeoutMs) { e.state = "timeout"; }
    if (e.state === "pending") { return { state: "pending" }; }
    __mcp_btForget(id);
    return { state: e.state, body: e.body };
};
