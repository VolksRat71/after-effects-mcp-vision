/*
 * Addressing, time and safety helpers for the Premiere Pro host.
 *
 * ADDRESSING. Premiere gives three stable handles, and every tool uses them:
 *   - ProjectItem.nodeId  for bins, clips and files in the project panel
 *   - Sequence.sequenceID for sequences (a GUID that survives renaming)
 *   - TrackItem.nodeId    for clips placed on a timeline
 * Tracks have no id worth trusting, so they are named the way an editor names
 * them: "V1", "V2", "A1". Nothing is addressed by its position in a list.
 *
 * TIME. Premiere counts in ticks: 254016000000 per second, for every frame
 * rate. Every tool speaks SECONDS on the sequence's timeline, and every
 * timeline position is snapped to the sequence's frame grid, so 1.0 s at
 * 29.97 fps lands on frame 30 rather than between frames 29 and 30.
 */

var __MCP_TICKS = 254016000000;

function __mcp_line(e) {
    try { return (e && e.line !== undefined) ? e.line : null; } catch (x) { return null; }
}

function __mcp_has(v) { return v !== undefined && v !== null; }

function __mcp_keys(o) {
    var out = [];
    for (var k in o) { if (o.hasOwnProperty(k)) { out.push(k); } }
    return out;
}

function __mcp_round(n) { return Math.round(Number(n) * 1000) / 1000; }

/* An Error carrying a machine-readable code, for batch results. */
function __mcp_fail(code, message) {
    var e = new Error(message);
    e.code = code;
    return e;
}

function __mcp_project() {
    if (!app.project || !app.project.rootItem) { throw __mcp_fail("no_project", "No project is open"); }
    return app.project;
}

/* ---------- time ---------- */

function __mcp_ticksPerFrame(seq) {
    var t = Number(seq.timebase);
    if (!t || t <= 0) { throw __mcp_fail("bad_sequence", "Sequence " + seq.name + " reports no frame rate"); }
    return t;
}

function __mcp_fps(seq) { return __mcp_round(__MCP_TICKS / __mcp_ticksPerFrame(seq)); }

/* Seconds -> ticks on the sequence's frame grid. */
function __mcp_snapTicks(seq, seconds) {
    var s = Number(seconds);
    if (isNaN(s)) { throw __mcp_fail("bad_value", "Time must be a number of seconds, got " + seconds); }
    var tpf = __mcp_ticksPerFrame(seq);
    return Math.round(s * __MCP_TICKS / tpf) * tpf;
}

function __mcp_time(ticks) {
    var t = new Time();
    t.ticks = String(ticks);
    return t;
}

/* A Premiere Time (or tick string) as {seconds, frame}. */
function __mcp_when(seq, t) {
    var ticks = (t && t.ticks !== undefined) ? Number(t.ticks) : Number(t);
    var out = { seconds: __mcp_round(ticks / __MCP_TICKS) };
    if (seq) { out.frame = Math.round(ticks / __mcp_ticksPerFrame(seq)); }
    return out;
}

/* ---------- lookups ---------- */

function __mcp_walkItems(root, visit) {
    var stack = [root];
    while (stack.length) {
        var item = stack.pop();
        if (visit(item) === true) { return item; }
        var kids = item.children;
        if (kids) { for (var i = kids.numItems - 1; i >= 0; i--) { stack.push(kids[i]); } }
    }
    return null;
}

function __mcp_projectItem(nodeId) {
    if (!__mcp_has(nodeId)) { throw __mcp_fail("bad_value", "nodeId is required"); }
    var id = String(nodeId);
    var found = __mcp_walkItems(__mcp_project().rootItem, function (it) { return String(it.nodeId) === id; });
    if (!found) { throw __mcp_fail("unknown_item", "No project item with nodeId " + id); }
    return found;
}

function __mcp_sequence(sequenceId) {
    var project = __mcp_project();
    if (!__mcp_has(sequenceId)) {
        if (!project.activeSequence) { throw __mcp_fail("no_sequence", "No sequence is active; pass sequenceId"); }
        return project.activeSequence;
    }
    for (var i = 0; i < project.sequences.numSequences; i++) {
        if (String(project.sequences[i].sequenceID) === String(sequenceId)) { return project.sequences[i]; }
    }
    throw __mcp_fail("unknown_sequence", "No sequence with id " + sequenceId);
}

/* "V1" / "A2" -> the track. */
function __mcp_track(seq, name) {
    var m = /^([VA])(\d+)$/i.exec(String(name || ""));
    if (!m) { throw __mcp_fail("bad_value", "track must look like V1 or A1, got " + name); }
    var list = m[1].toUpperCase() === "V" ? seq.videoTracks : seq.audioTracks;
    var i = Number(m[2]) - 1;
    if (i < 0 || i >= list.numTracks) {
        throw __mcp_fail("unknown_track", "Sequence " + seq.name + " has no track " + name + " (it has " +
            seq.videoTracks.numTracks + " video, " + seq.audioTracks.numTracks + " audio)");
    }
    return list[i];
}

/* Every track item in a sequence, with the track name it sits on. */
function __mcp_eachClip(seq, visit) {
    var kinds = [["V", seq.videoTracks], ["A", seq.audioTracks]];
    for (var k = 0; k < kinds.length; k++) {
        var tracks = kinds[k][1];
        for (var t = 0; t < tracks.numTracks; t++) {
            var clips = tracks[t].clips;
            for (var c = 0; c < clips.numItems; c++) {
                if (visit(clips[c], kinds[k][0] + (t + 1), tracks[t]) === true) { return clips[c]; }
            }
        }
    }
    return null;
}

/* A track item by nodeId: {clip, track, trackName}. Searches one sequence. */
function __mcp_clip(seq, nodeId) {
    if (!__mcp_has(nodeId)) { throw __mcp_fail("bad_value", "nodeId is required"); }
    var id = String(nodeId), where = null;
    __mcp_eachClip(seq, function (c, name, track) {
        if (String(c.nodeId) === id) { where = { clip: c, track: track, trackName: name }; return true; }
        return false;
    });
    if (!where) { throw __mcp_fail("unknown_clip", "No clip with nodeId " + id + " in sequence " + seq.name); }
    return where;
}

function __mcp_clipIds(seq) {
    var ids = {};
    __mcp_eachClip(seq, function (c) { ids[String(c.nodeId)] = true; return false; });
    return ids;
}

/* ---------- descriptions ---------- */

function __mcp_itemType(it) {
    var t = it.type;
    if (t === 2) { return "bin"; }
    if (t === 3) { return "root"; }
    if (t === 4) { return "file"; }
    var seq = false;
    try { seq = it.isSequence && it.isSequence(); } catch (e) {}
    return seq ? "sequence" : "clip";
}

function __mcp_itemSummary(it) {
    var out = { nodeId: String(it.nodeId), name: it.name, type: __mcp_itemType(it) };
    if (out.type === "clip" || out.type === "file") {
        try { out.path = it.getMediaPath() || null; } catch (e) {}
        try { out.offline = !!it.isOffline(); } catch (e) {}
    }
    return out;
}

function __mcp_clipSummary(seq, c, trackName) {
    var out = {
        nodeId: String(c.nodeId), name: c.name, track: trackName,
        start: __mcp_when(seq, c.start), end: __mcp_when(seq, c.end),
        sourceIn: __mcp_when(null, c.inPoint).seconds, sourceOut: __mcp_when(null, c.outPoint).seconds
    };
    try { out.disabled = !!c.disabled; } catch (e) {}
    try { if (c.projectItem) { out.projectItem = String(c.projectItem.nodeId); } } catch (e) {}
    return out;
}

/* ---------- safety ---------- */

/*
 * Projects the bridge created or opened, by path. Kept across a host reload so
 * reloadHost does not quietly lock the agent out of its own project.
 */
if (typeof __mcp_ownedProjects === "undefined") { var __mcp_ownedProjects = {}; }

/* Paths as keys: one slash style, one case, so "C:\\A\\b.prproj" and "c:/a/b.prproj" match. */
function __mcp_pathKey(p) { return String(p || "").replace(/\\/g, "/").toLowerCase(); }
function __mcp_projectKey(project) { return __mcp_pathKey(project.path); }

/*
 * Edits go only to a project this bridge made or opened, or one adopted on
 * purpose. A project the user has open was never saved by us, so an agent's
 * edit could not be told apart from the user's own unsaved work.
 */
function __mcp_requireOwned() {
    var project = __mcp_project();
    if (!__mcp_ownedProjects[__mcp_projectKey(project)]) {
        throw __mcp_fail("not_owned",
            "The active project '" + project.name + "' was not opened by this bridge, so nothing was changed. " +
            "Open or create a project with pr_project, or run pr_project adopt if the user asked you to edit this one.");
    }
    return project;
}

function __mcp_captureDir() {
    var dir = new Folder(Folder.temp.fsName + "/premiere-mcp-vision");
    if (!dir.exists) { dir.create(); }
    return dir;
}

/* Captures go to one app-owned folder under a bare name, never a caller's path. */
function __mcp_safeCaptureFile(fileName) {
    fileName = String(fileName || "");
    if (!/^[A-Za-z0-9._-]+\.png$/.test(fileName) || fileName.indexOf("..") !== -1) {
        throw __mcp_fail("bad_value", "fileName must be a bare name matching [A-Za-z0-9._-]+.png");
    }
    return new File(__mcp_captureDir().fsName + "/" + fileName);
}

function __mcp_absPath(p, what) {
    var s = String(p || "");
    if (!/^(\/|[A-Za-z]:[\\\/])/.test(s)) { throw __mcp_fail("bad_value", what + " must be an absolute path, got '" + s + "'"); }
    return s;
}

/*
 * QE is undocumented and must be switched on before use. It also keeps its own
 * current project, which does not follow app.project: measured on 26.0.2, after
 * the first project was closed and a second created, QE still pointed at the
 * closed one, and QE's newSequence went into it. qe.project.init() re-attaches
 * it (measured). A QE op never runs while the two disagree.
 */
function __mcp_qe() {
    app.enableQE();
    if (typeof qe === "undefined" || !qe.project) { throw __mcp_fail("no_qe", "The QE DOM is not available in this Premiere build"); }
    var want = __mcp_projectKey(__mcp_project());
    var have = function () { try { return __mcp_pathKey(qe.project.path); } catch (e) { return ""; } };
    if (want && have() && have() !== want) {
        try { qe.project.init(); } catch (e) {}
        if (have() !== want) {
            throw __mcp_fail("qe_stale", "QE is attached to " + qe.project.path + ", not the open project " +
                app.project.path + ", so nothing was done. Restart Premiere to reset it.");
        }
    }
    return qe;
}

/*
 * Make seq the active sequence. activeSequence has no documented setter;
 * openSequence(id) is the documented call (it also brings up the sequence's
 * timeline tab). It is read back, so a switch that did not take is an error,
 * not a capture of the wrong sequence.
 */
function __mcp_activate(seq) {
    var project = __mcp_project();
    if (project.activeSequence && String(project.activeSequence.sequenceID) === String(seq.sequenceID)) { return; }
    project.openSequence(seq.sequenceID);
    if (!project.activeSequence || String(project.activeSequence.sequenceID) !== String(seq.sequenceID)) {
        throw __mcp_fail("activate_failed", "Premiere did not make sequence " + seq.name + " active");
    }
}

/* Run fn with seq as the active sequence (QE only sees the active one), then put the user's back. */
function __mcp_withActive(seq, fn) {
    var project = __mcp_project();
    var prior = project.activeSequence;
    var switched = !prior || String(prior.sequenceID) !== String(seq.sequenceID);
    if (switched) { __mcp_activate(seq); }
    try { return fn(); } finally {
        if (switched && prior) { try { project.openSequence(prior.sequenceID); } catch (e) {} }
    }
}
