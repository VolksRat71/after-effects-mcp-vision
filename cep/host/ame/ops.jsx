/*
 * Media Encoder ExtendScript ops.
 *
 * Media Encoder's CEP gives extensions no ExtendScript, so nothing loads this
 * as a host. The Node server (ame-relay.js) sends it, with the JSON polyfill,
 * as the body of a BridgeTalk message routed through Premiere or After Effects,
 * and the engine inside Media Encoder runs it fresh on every call. Only that
 * engine's globals persist between calls, which is why the event counters live
 * on $.global. ES3 only; no JSON in this engine, hence the polyfill.
 *
 * Measured on 26.0.2: events carry no item id, only the event type, so the
 * counters say how much happened, not which item it happened to.
 */

var __ame_ops = {};

function __ame_state() {
    var g = $.global;
    if (!g.__ame_st) {
        g.__ame_st = { added: 0, started: 0, completed: 0, lastEncodeSuccess: null, errors: 0, lastError: null,
                       progressEvents: 0, lastProgressAt: null, statusChanges: 0, lastStatus: null, recent: [] };
        __ame_listen(g.__ame_st);
    }
    return g.__ame_st;
}

// Registered once per Media Encoder session; the handlers close over st, not over this call.
function __ame_listen(st) {
    function note(type) {
        st.recent.push({ at: new Date().getTime(), type: type });
        if (st.recent.length > 30) { st.recent.shift(); }
    }
    function on(obj, type, fn) {
        try {
            obj.addEventListener(type, function () { note(type); try { fn(); } catch (e) {} });
        } catch (e) { note("register failed " + type); }
    }
    var fe = app.getFrontend(), eh = app.getEncoderHost(), ex = app.getExporter();
    on(fe, "onItemAddedToBatch", function () { st.added++; });
    on(ex, "onItemEncodingStarted", function () { st.started++; });
    on(ex, "onEncodingItemProgressUpdated", function () { st.progressEvents++; st.lastProgressAt = new Date().getTime(); });
    on(ex, "onEncodeComplete", function () { st.completed++; st.lastEncodeSuccess = ex.encodeSuccess; });
    on(eh, "onBatchEncoderStatusChanged", function () { st.statusChanges++; st.lastStatus = String(eh.getBatchEncoderStatus()); });
    on(fe, "onBatchItemCreationFailed", function () { st.errors++; st.lastError = "batch item creation failed"; });
    on(eh, "onEncoderJobError", function () { st.errors++; st.lastError = "encoder job error"; });
}

function __ame_text(v, what) {
    if (typeof v !== "string" || !v) { var e = new Error(what + " must be a non-empty string"); e.code = "bad_value"; throw e; }
    return v;
}

__ame_ops.ping = function () {
    return { pong: true, appVersion: String(app.buildNumber), time: new Date().getTime() };
};

__ame_ops.info = function () {
    var eh = app.getEncoderHost();
    __ame_state();
    var formats = [];
    try { formats = String(eh.getFormatList()).split(","); } catch (e) {}
    return { buildNumber: String(app.buildNumber), batchStatus: String(eh.getBatchEncoderStatus()),
             isBatchRunning: eh.isBatchRunning() ? true : false, formats: formats };
};

// getDLItemsAtRoot hands back bare ids (zero-padded hex), no names: measured on 26.0.2.
__ame_ops.compItems = function (a) {
    var r = app.getFrontend().getDLItemsAtRoot(__ame_text(a.projectPath, "projectPath"));
    var out = [];
    if (r) {
        for (var i = 0; i < r.length; i++) {
            var g = String(r[i]);
            out.push({ guid: g, itemId: parseInt(g.substring(0, 8), 16) });
        }
    }
    return { count: out.length, items: out };
};

__ame_ops.queueComp = function (a) {
    var st = __ame_state();
    var r = app.getFrontend().addDLToBatch(__ame_text(a.projectPath, "projectPath"), a.format || "",
        __ame_text(a.presetPath, "presetPath"), __ame_text(a.guid, "guid"), __ame_text(a.outputPath, "outputPath"));
    if (!r) { var e = new Error("Media Encoder refused guid " + a.guid + " in " + a.projectPath + " (null); list them with compItems"); e.code = "bad_guid"; throw e; }
    return { queued: true, completedBefore: st.completed };
};

__ame_ops.queueFile = function (a) {
    var st = __ame_state();
    var r = app.getFrontend().addFileToBatch(__ame_text(a.filePath, "filePath"), a.format || "",
        __ame_text(a.presetPath, "presetPath"), __ame_text(a.outputPath, "outputPath"));
    if (!r) { var e = new Error("Media Encoder would not queue " + a.filePath); e.code = "queue_failed"; throw e; }
    return { queued: true, completedBefore: st.completed };
};

__ame_ops.start = function () { __ame_state(); return { started: app.getEncoderHost().runBatch() }; };
__ame_ops.pause = function () { return { paused: app.getEncoderHost().pauseBatch() }; };
__ame_ops.stop = function () { return { stopped: app.getEncoderHost().stopBatch() }; };
__ame_ops.clear = function () { return { cleared: app.getExporter().removeAllBatchItems() }; };

__ame_ops.status = function () {
    var eh = app.getEncoderHost(), st = __ame_state();
    return { batchStatus: String(eh.getBatchEncoderStatus()), isBatchRunning: eh.isBatchRunning() ? true : false,
             added: st.added, started: st.started, completed: st.completed, lastEncodeSuccess: st.lastEncodeSuccess,
             errors: st.errors, lastError: st.lastError, progressEvents: st.progressEvents,
             lastProgressAt: st.lastProgressAt, recentEvents: st.recent };
};

function __ame_exec(reqJson) {
    var out;
    try {
        var req = JSON.parse(reqJson);
        if (!__ame_ops.hasOwnProperty(req.op)) {
            out = { ok: false, error: { code: "unknown_op", message: "No such op: " + req.op } };
        } else {
            out = { ok: true, result: __ame_ops[req.op](req.args || {}) };
        }
    } catch (e) {
        out = { ok: false, error: { code: e.code || "op_failed", message: String(e.message || e) } };
    }
    try { return JSON.stringify(out); } catch (e2) { return '{"ok":false,"error":{"code":"serialize_failed"}}'; }
}
