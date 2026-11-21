/*
 * Read-only ops: what is open, the project tree, one clip in detail, and the
 * effect parameters (components) a clip carries.
 */

function __mcp_sequenceInfo(seq) {
    var out = {
        sequenceId: String(seq.sequenceID), name: seq.name,
        fps: __mcp_fps(seq), ticksPerFrame: Number(seq.timebase),
        end: __mcp_when(seq, seq.end),
        videoTracks: seq.videoTracks.numTracks, audioTracks: seq.audioTracks.numTracks
    };
    try { out.width = seq.frameSizeHorizontal; out.height = seq.frameSizeVertical; } catch (e) {}
    try { out.playhead = __mcp_when(seq, seq.getPlayerPosition()); } catch (e) {}
    try { out.inPoint = __mcp_round(seq.getInPoint()); out.outPoint = __mcp_round(seq.getOutPoint()); } catch (e) {}
    try { if (seq.projectItem) { out.nodeId = String(seq.projectItem.nodeId); } } catch (e) {}
    return out;
}

function __mcp_componentInfo(seq, clip, values) {
    var out = [];
    var comps = clip.components;
    for (var i = 0; i < comps.numItems; i++) {
        var comp = comps[i], params = [];
        for (var p = 0; p < comp.properties.numItems; p++) {
            var prop = comp.properties[p], entry = { name: prop.displayName };
            if (values) {
                try { entry.value = prop.getValue(); } catch (e) { entry.value = null; }
                try { entry.keyframed = !!prop.isTimeVarying(); } catch (e) {}
                if (entry.keyframed) {
                    try {
                        var keys = prop.getKeys(), list = [];
                        for (var k = 0; k < keys.length; k++) {
                            list.push({ at: __mcp_round(keys[k].seconds - clip.inPoint.seconds),
                                        value: prop.getValueAtKey(keys[k]) });
                        }
                        entry.keys = list;
                    } catch (e) {}
                }
            }
            params.push(entry);
        }
        out.push({ name: comp.displayName, matchName: comp.matchName, params: params });
    }
    return out;
}

var __mcp_queryOps = {

    sessionInfo: function () {
        var out = { appVersion: app.version, projects: [] };
        // QE's own current project; QE-backed ops act there, so a mismatch explains a QE op that "did nothing".
        try { app.enableQE(); out.qeProject = qe.project ? String(qe.project.path || qe.project.name) : null; } catch (e) { out.qeProject = null; }
        for (var i = 0; i < app.projects.numProjects; i++) {
            var p = app.projects[i];
            out.projects.push({ name: p.name, path: p.path, ownedByBridge: !!__mcp_ownedProjects[__mcp_projectKey(p)] });
        }
        if (app.project && app.project.rootItem) {
            var project = app.project, seqs = [];
            for (var s = 0; s < project.sequences.numSequences; s++) { seqs.push(__mcp_sequenceInfo(project.sequences[s])); }
            out.active = {
                name: project.name, path: project.path,
                ownedByBridge: !!__mcp_ownedProjects[__mcp_projectKey(project)],
                activeSequence: project.activeSequence ? String(project.activeSequence.sequenceID) : null,
                sequences: seqs
            };
        } else {
            out.active = null;
        }
        return out;
    },

    /*
     * Without sequenceId: the project panel (bins, clips, sequences). With it:
     * that sequence's tracks and the clips on them, in time order per track.
     */
    tree: function (args) {
        var max = Number(args.maxItems || 300), count = 0, truncated = false;
        if (__mcp_has(args.sequenceId)) {
            var seq = __mcp_sequence(args.sequenceId), tracks = [];
            var kinds = [["V", seq.videoTracks], ["A", seq.audioTracks]];
            for (var k = 0; k < kinds.length; k++) {
                for (var t = 0; t < kinds[k][1].numTracks; t++) {
                    var track = kinds[k][1][t], name = kinds[k][0] + (t + 1), clips = [];
                    for (var c = 0; c < track.clips.numItems; c++) {
                        if (count >= max) { truncated = true; break; }
                        clips.push(__mcp_clipSummary(seq, track.clips[c], name)); count++;
                    }
                    var entry = { track: name, name: track.name, clips: clips };
                    try { entry.muted = !!track.isMuted(); } catch (e) {}
                    tracks.push(entry);
                }
            }
            return { sequence: __mcp_sequenceInfo(seq), tracks: tracks, truncated: truncated };
        }

        var depth = Math.max(1, Math.min(8, Number(args.depth || 2)));
        var start = __mcp_has(args.nodeId) ? __mcp_projectItem(args.nodeId) : __mcp_project().rootItem;
        function walk(item, level) {
            var node = __mcp_itemSummary(item);
            if (item.children && item.children.numItems && level < depth) {
                node.children = [];
                for (var i = 0; i < item.children.numItems; i++) {
                    if (count >= max) { truncated = true; break; }
                    count++;
                    node.children.push(walk(item.children[i], level + 1));
                }
            } else if (item.children && item.children.numItems) {
                node.childCount = item.children.numItems;
            }
            return node;
        }
        return { root: walk(start, 0), truncated: truncated };
    },

    /* One timeline clip: placement, linked clips, and its effect parameters with values. */
    clip: function (args) {
        var seq = __mcp_sequence(args.sequenceId);
        var where = __mcp_clip(seq, args.nodeId);
        var out = __mcp_clipSummary(seq, where.clip, where.trackName);
        try {
            var linked = where.clip.getLinkedItems(), ids = [];
            for (var i = 0; i < linked.numItems; i++) {
                if (String(linked[i].nodeId) !== out.nodeId) { ids.push(String(linked[i].nodeId)); }
            }
            out.linked = ids;
        } catch (e) {}
        out.components = __mcp_componentInfo(seq, where.clip, true);
        return out;
    },

    /* Component and parameter names only - what pr_effects params and pr_motion can address. */
    propertyKeys: function (args) {
        var seq = __mcp_sequence(args.sequenceId);
        var where = __mcp_clip(seq, args.nodeId);
        return { nodeId: String(where.clip.nodeId), components: __mcp_componentInfo(seq, where.clip, false) };
    },

    /* Sequence presets (.sqpreset) that ship with this Premiere, for pr_sequence create. */
    sequencePresets: function (args) {
        var match = String(args.match || "").toLowerCase(), out = [];
        var roots = [__mcp_appSettings() + "/SequencePresets"];
        for (var r = 0; r < roots.length; r++) {
            var stack = [new Folder(roots[r])];
            while (stack.length) {
                var f = stack.pop();
                if (!f.exists) { continue; }
                var kids = f.getFiles();
                for (var i = 0; i < kids.length; i++) {
                    if (kids[i] instanceof Folder) { stack.push(kids[i]); continue; }
                    var path = kids[i].fsName;
                    if (/\.sqpreset$/i.test(path) && (!match || path.toLowerCase().indexOf(match) !== -1)) { out.push(path); }
                }
            }
        }
        out.sort();
        return { count: out.length, presets: out.slice(0, Number(args.limit || 50)) };
    }
};

/* The app's Settings folder: Contents/Settings in the macOS bundle, Settings beside the exe on Windows. */
function __mcp_appSettings() {
    var candidates = [];
    try { candidates.push(Folder.appPackage.fsName + "/Contents/Settings"); } catch (e) {}
    try { candidates.push(new File(app.path).parent.fsName + "/Settings"); } catch (e) {}
    try { candidates.push(app.path + "/Contents/Settings"); } catch (e) {}
    for (var i = 0; i < candidates.length; i++) {
        if (new Folder(candidates[i]).exists) { return candidates[i]; }
    }
    throw __mcp_fail("no_settings", "Could not find Premiere's Settings folder (tried " + candidates.join(", ") + ")");
}
