/*
 * Projects, bins, imports and sequences.
 *
 * Imports always reference media where it is; nothing is copied. Premiere's
 * own importer can show dialogs, so every import passes suppressUI.
 */

function __mcp_findBin(nodeId) {
    if (!__mcp_has(nodeId)) { return __mcp_project().rootItem; }
    var bin = __mcp_projectItem(nodeId);
    if (bin.type !== 2 && bin.type !== 3) { throw __mcp_fail("type_mismatch", bin.name + " is not a bin"); }
    return bin;
}

function __mcp_sequenceIds() {
    var ids = {}, seqs = __mcp_project().sequences;
    for (var i = 0; i < seqs.numSequences; i++) { ids[String(seqs[i].sequenceID)] = true; }
    return ids;
}

function __mcp_newSequences(before) {
    var out = [], seqs = __mcp_project().sequences;
    for (var i = 0; i < seqs.numSequences; i++) {
        if (!before[String(seqs[i].sequenceID)]) { out.push(__mcp_sequenceInfo(seqs[i])); }
    }
    return out;
}

/* Items in a bin that were not there before an import. */
function __mcp_newChildren(bin, before) {
    var out = [];
    for (var i = 0; i < bin.children.numItems; i++) {
        if (!before[String(bin.children[i].nodeId)]) { out.push(__mcp_itemSummary(bin.children[i])); }
    }
    return out;
}

function __mcp_childIds(bin) {
    var ids = {};
    for (var i = 0; i < bin.children.numItems; i++) { ids[String(bin.children[i].nodeId)] = true; }
    return ids;
}

/* Import files (or an FCP7 XML / AE project) into a bin, returning what arrived. */
function __mcp_importInto(paths, binId) {
    var bin = __mcp_findBin(binId);
    var list = [];
    for (var i = 0; i < paths.length; i++) {
        var p = __mcp_absPath(paths[i], "import path");
        if (!new File(p).exists) { throw __mcp_fail("missing_file", "No file at " + p); }
        list.push(p);
    }
    var beforeItems = __mcp_childIds(bin), beforeSeqs = __mcp_sequenceIds();
    var ok = __mcp_project().importFiles(list, true, bin, false);
    return { imported: ok !== false, items: __mcp_newChildren(bin, beforeItems), sequences: __mcp_newSequences(beforeSeqs) };
}

/* Own a project by the path asked for AND the path Premiere reports, which can differ (symlinks, slashes). */
function __mcp_own(path) {
    __mcp_ownedProjects[__mcp_pathKey(path)] = true;
    if (app.project && app.project.path) { __mcp_ownedProjects[__mcp_projectKey(app.project)] = true; }
}

var __mcp_projectOps = {

    project: function (args) {
        var cmd = args.command;
        if (cmd === "new") {
            var path = __mcp_absPath(args.path, "path");
            if (!/\.prproj$/i.test(path)) { throw __mcp_fail("bad_value", "path must end in .prproj"); }
            if (new File(path).exists) { throw __mcp_fail("exists", "A project already exists at " + path + "; open it instead"); }
            app.newProject(path);
            __mcp_own(path);
            return { created: path, active: app.project ? app.project.path : null };
        }
        if (cmd === "open") {
            var op = __mcp_absPath(args.path, "path");
            if (!new File(op).exists) { throw __mcp_fail("missing_file", "No project at " + op); }
            // Already open means the user may have unsaved work in it: opening again would just
            // switch to it, and owning it then would bypass the guard.
            for (var i = 0; i < app.projects.numProjects; i++) {
                if (__mcp_projectKey(app.projects[i]) === __mcp_pathKey(op)) {
                    throw __mcp_fail("already_open", op + " is already open in Premiere, so nothing was changed. " +
                        "Use pr_project adopt only if the user asked you to edit it.");
                }
            }
            app.openDocument(op, true, true, true, true);
            __mcp_own(op);
            return { opened: op, active: app.project ? app.project.path : null };
        }
        if (cmd === "adopt") {
            var p = __mcp_project();
            __mcp_ownedProjects[__mcp_projectKey(p)] = true;
            return { adopted: p.path };
        }
        if (cmd === "save") {
            __mcp_requireOwned().save();
            return { saved: app.project.path };
        }
        if (cmd === "saveAs") {
            var target = __mcp_absPath(args.path, "path");
            if (new File(target).exists && !args.overwrite) { throw __mcp_fail("exists", target + " exists; pass overwrite:true"); }
            __mcp_requireOwned().saveAs(target);
            __mcp_own(target);
            return { saved: target, active: app.project.path };
        }
        if (cmd === "close") {
            var cp = __mcp_requireOwned(), name = cp.name;
            if (args.save) { cp.save(); }
            cp.closeDocument(args.save ? 1 : 0, 0);
            return { closed: name, saved: !!args.save };
        }
        if (cmd === "bin") {
            __mcp_requireOwned();
            var parent = __mcp_findBin(args.parent);
            var made = parent.createBin(String(args.name || "Bin"));
            return __mcp_itemSummary(made);
        }
        if (cmd === "import") {
            __mcp_requireOwned();
            var paths = args.paths instanceof Array ? args.paths : [args.path];
            return __mcp_importInto(paths, args.bin);
        }
        if (cmd === "importAE") {
            __mcp_requireOwned();
            var aep = __mcp_absPath(args.path, "path");
            if (!new File(aep).exists) { throw __mcp_fail("missing_file", "No After Effects project at " + aep); }
            var bin = __mcp_findBin(args.bin), before = __mcp_childIds(bin);
            if (args.comps instanceof Array && args.comps.length) {
                __mcp_project().importAEComps(aep, args.comps, bin);
            } else {
                __mcp_project().importAllAEComps(aep, bin);
            }
            return { items: __mcp_newChildren(bin, before) };
        }
        throw __mcp_fail("bad_value", "Unknown pr_project command " + cmd);
    },

    sequence: function (args) {
        var cmd = args.command;
        if (cmd === "create") {
            __mcp_requireOwned();
            var name = String(args.name || "Sequence");
            var before = __mcp_sequenceIds();
            if (args.fromClips instanceof Array && args.fromClips.length) {
                var items = [];
                for (var i = 0; i < args.fromClips.length; i++) { items.push(__mcp_projectItem(args.fromClips[i])); }
                __mcp_project().createNewSequenceFromClips(name, items, __mcp_findBin(args.bin));
            } else {
                var preset = args.preset ? String(args.preset) : "HD 1080p/HD 1080p 29.97 fps.sqpreset";
                if (!/^(\/|[A-Za-z]:)/.test(preset)) { preset = __mcp_appSettings() + "/SequencePresets/" + preset; }
                if (!/\.sqpreset$/i.test(preset)) { preset += ".sqpreset"; }
                if (!new File(preset).exists) {
                    throw __mcp_fail("missing_file", "No sequence preset at " + preset + ". List them with pr_query sequencePresets.");
                }
                // QE's newSequence takes a preset path and never shows the New Sequence dialog.
                __mcp_qe().project.newSequence(name, preset);
            }
            var made = __mcp_newSequences(before);
            if (!made.length) { throw __mcp_fail("failed", "Premiere did not create a sequence"); }
            return made[0];
        }
        var seq = __mcp_sequence(args.sequenceId);
        if (cmd === "info") { return __mcp_sequenceInfo(seq); }
        __mcp_requireOwned();
        if (cmd === "activate") {
            __mcp_activate(seq);
            return __mcp_sequenceInfo(seq);
        }
        if (cmd === "rename") { seq.name = String(args.name); return __mcp_sequenceInfo(seq); }
        if (cmd === "duplicate") {
            var b = __mcp_sequenceIds();
            seq.clone();
            var copy = __mcp_newSequences(b);
            if (!copy.length) { throw __mcp_fail("failed", "Premiere did not duplicate the sequence"); }
            if (args.name) { __mcp_sequence(copy[0].sequenceId).name = String(args.name); copy[0].name = String(args.name); }
            return copy[0];
        }
        if (cmd === "setInOut") {
            if (__mcp_has(args.inPoint)) { seq.setInPoint(__mcp_snapTicks(seq, args.inPoint) / __MCP_TICKS); }
            if (__mcp_has(args.outPoint)) { seq.setOutPoint(__mcp_snapTicks(seq, args.outPoint) / __MCP_TICKS); }
            return __mcp_sequenceInfo(seq);
        }
        if (cmd === "setPlayhead") {
            seq.setPlayerPosition(String(__mcp_snapTicks(seq, args.time)));
            return __mcp_sequenceInfo(seq);
        }
        if (cmd === "addTracks") {
            // QE only, and QE acts on the active sequence.
            var v = Number(args.video || 0), a = Number(args.audio || 0);
            var v0 = seq.videoTracks.numTracks, a0 = seq.audioTracks.numTracks;
            __mcp_withActive(seq, function () {
                __mcp_qe().project.getActiveSequence().addTracks(v, v0, a, 1, a0, 0, 0, 0);
            });
            var info = __mcp_sequenceInfo(seq);
            if (info.videoTracks !== v0 + v || info.audioTracks !== a0 + a) {
                throw __mcp_fail("failed", "QE addTracks left " + info.videoTracks + " video / " + info.audioTracks +
                    " audio tracks; expected " + (v0 + v) + " / " + (a0 + a));
            }
            return info;
        }
        throw __mcp_fail("bad_value", "Unknown pr_sequence command " + cmd);
    }
};
