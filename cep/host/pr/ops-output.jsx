/*
 * Getting things out: FCP7 XML, renders, and single frames for an agent to
 * look at. Paths reaching these ops were already checked on the Node side
 * (absolute, no overwrite without consent, not in a protected folder, enough
 * free disk); the host re-checks what it can see itself.
 */

/* Media Encoder jobs this bridge queued, and their outcomes from its event callbacks. Kept across a host reload. */
if (typeof __mcp_encodeJobs === "undefined") { var __mcp_encodeJobs = {}; }
if (typeof __mcp_encoderBound === "undefined") { var __mcp_encoderBound = false; }

function __mcp_bindEncoder() {
    if (__mcp_encoderBound) { return; }
    var mark = function (state) {
        return function (jobID, outputFilePath) {
            __mcp_encodeJobs[String(jobID)] = { state: state, output: outputFilePath ? String(outputFilePath) : null,
                                                 at: new Date().getTime() };
        };
    };
    app.encoder.bind("onEncoderJobComplete", mark("complete"));
    app.encoder.bind("onEncoderJobError", mark("error"));
    app.encoder.bind("onEncoderJobCanceled", mark("canceled"));
    __mcp_encoderBound = true;
}

function __mcp_refuseExisting(path, overwrite) {
    if (new File(path).exists && !overwrite) { throw __mcp_fail("exists", path + " exists; pass overwrite:true to replace it"); }
    var dir = new File(path).parent;
    if (!dir.exists && !dir.create()) { throw __mcp_fail("failed", "Could not create folder " + dir.fsName); }
}

var __MCP_WORKAREA = { entire: 0, inOut: 1, workArea: 2 };

var __mcp_outputOps = {

    timeline: function (args) {
        var cmd = args.command;
        if (cmd === "export") {
            var seq = __mcp_sequence(args.sequenceId);
            var path = __mcp_absPath(args.path, "path");
            if (!/\.xml$/i.test(path)) { throw __mcp_fail("bad_value", "path must end in .xml"); }
            __mcp_refuseExisting(path, args.overwrite);
            seq.exportAsFinalCutProXML(path, 1);
            if (!new File(path).exists) { throw __mcp_fail("failed", "Premiere wrote no file at " + path); }
            return { exported: path, sequence: seq.name };
        }
        if (cmd === "import") {
            __mcp_requireOwned();
            var r = __mcp_importInto([args.path], args.bin);
            if (!r.sequences.length) { r.warning = "No new sequence appeared; Premiere may have rejected the XML"; }
            return r;
        }
        throw __mcp_fail("bad_value", "Unknown pr_timeline command " + cmd);
    },

    render: function (args) {
        var cmd = args.command;
        if (cmd === "status") {
            if (!__mcp_encodeJobs.hasOwnProperty(String(args.jobId))) { throw __mcp_fail("unknown_job", "This bridge queued no job " + args.jobId); }
            var job = __mcp_encodeJobs[String(args.jobId)];
            var out = { jobId: String(args.jobId), state: job.state, output: job.output || null };
            if (args.path) { out.fileExists = new File(String(args.path)).exists; }
            return out;
        }
        var seq = __mcp_sequence(args.sequenceId);
        var path = __mcp_absPath(args.path, "path");
        var preset = __mcp_absPath(args.preset, "preset");
        if (!new File(preset).exists) { throw __mcp_fail("missing_file", "No export preset at " + preset); }
        var area = __MCP_WORKAREA[args.range || "entire"];
        if (area === undefined) { throw __mcp_fail("bad_value", "range must be entire, inOut or workArea"); }
        __mcp_refuseExisting(path, args.overwrite);
        if (cmd === "direct") {
            // Synchronous: Premiere is busy until the file is written.
            var t0 = new Date().getTime();
            var res = seq.exportAsMediaDirect(path, preset, area);
            return { output: path, exists: new File(path).exists, ms: new Date().getTime() - t0, result: res ? String(res) : null };
        }
        if (cmd === "queue") {
            __mcp_bindEncoder();
            app.encoder.launchEncoder();
            var jobId = app.encoder.encodeSequence(seq, path, preset, area, 1);
            if (!jobId || String(jobId) === "0") { throw __mcp_fail("failed", "Media Encoder did not accept the job"); }
            if (!__mcp_encodeJobs.hasOwnProperty(String(jobId))) { __mcp_encodeJobs[String(jobId)] = { state: "queued-or-running" }; }
            if (args.start !== false) { app.encoder.startBatch(); }
            return { jobId: String(jobId), output: path, started: args.start !== false };
        }
        throw __mcp_fail("bad_value", "Unknown pr_render command " + cmd);
    },

    /*
     * One frame of a sequence as a PNG. Premiere has no documented call for
     * this; QE's exportFramePNG renders the frame under the playhead of the
     * active sequence. So the sequence is made active and the playhead moved
     * for the shot, then both are put back.
     */
    captureFrame: function (args) {
        var seq = __mcp_sequence(args.sequenceId);
        var file = __mcp_safeCaptureFile(args.fileName);
        var ticks = __mcp_snapTicks(seq, args.time || 0);
        return __mcp_withActive(seq, function () {
            var priorPos = null;
            try { priorPos = seq.getPlayerPosition().ticks; } catch (e) {}
            seq.setPlayerPosition(String(ticks));
            try {
                var qs = __mcp_qe().project.getActiveSequence();
                qs.exportFramePNG(qs.CTI.timecode, file.fsName);
            } finally {
                if (priorPos !== null) { try { seq.setPlayerPosition(String(priorPos)); } catch (e) {} }
            }
            return { path: file.fsName, fileName: String(args.fileName), sequenceId: String(seq.sequenceID),
                     time: __mcp_when(seq, ticks), width: seq.frameSizeHorizontal, height: seq.frameSizeVertical };
        });
    }
};

var __mcp_diagnosticOps = {

    /* Offline media and empty sequences: what breaks an import or a render later. */
    problems: function (args) {
        var limit = Number(args.limit || 50), offline = [], empty = [];
        __mcp_walkItems(__mcp_project().rootItem, function (it) {
            try { if (it.type === 1 && it.isOffline() && offline.length < limit) { offline.push(__mcp_itemSummary(it)); } } catch (e) {}
            return false;
        });
        var seqs = __mcp_project().sequences;
        for (var i = 0; i < seqs.numSequences; i++) {
            var n = 0;
            __mcp_eachClip(seqs[i], function () { n++; return true; });
            if (!n) { empty.push({ sequenceId: String(seqs[i].sequenceID), name: seqs[i].name }); }
        }
        return { offline: offline, emptySequences: empty, total: offline.length + empty.length };
    }
};
