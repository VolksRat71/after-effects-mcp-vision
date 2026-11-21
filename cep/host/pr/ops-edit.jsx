/*
 * Timeline edits: placing and trimming clips, markers, audio levels, Motion
 * and Opacity, and effects.
 *
 * Writes are batch-shaped where an agent naturally makes many at once (clips,
 * markers, keyframes): each item succeeds or fails on its own with a code, and
 * the rest still run.
 *
 * KEYFRAME TIME. Every keyframe `at` is seconds from the START OF THE CLIP on
 * the timeline - 0 is the clip's first frame - whatever Premiere counts in
 * underneath. Premiere stores clip keyframes against the clip's source media,
 * so the host adds the clip's source in-point.
 */

/* Run each item; collect {applied, errors} with codes instead of stopping at the first failure. */
function __mcp_batch(list, fn) {
    var applied = [], errors = [];
    if (!(list instanceof Array)) { throw __mcp_fail("bad_value", "Expected a list"); }
    for (var i = 0; i < list.length; i++) {
        try { applied.push(fn(list[i], i)); } catch (e) {
            errors.push({ index: i, code: e.code || "failed", message: (e && e.message !== undefined) ? e.message : String(e) });
        }
    }
    return { applied: applied, errors: errors };
}

/* ---------- clips ---------- */

function __mcp_place(seq, w, overwrite) {
    var item = __mcp_projectItem(w.projectItem);
    var track = __mcp_track(seq, w.track || "V1");
    var ticks = __mcp_snapTicks(seq, w.at || 0);
    var hasRange = __mcp_has(w.sourceIn) || __mcp_has(w.sourceOut);
    // insertClip uses the project item's own in/out, so a source range is set
    // there for the call. The user's own in/out on that item is put back after.
    var priorIn = null, priorOut = null;
    if (hasRange) {
        priorIn = item.getInPoint().seconds; priorOut = item.getOutPoint().seconds;
        if (__mcp_has(w.sourceIn)) { item.setInPoint(Number(w.sourceIn), 4); }
        if (__mcp_has(w.sourceOut)) { item.setOutPoint(Number(w.sourceOut), 4); }
    }
    var before = __mcp_clipIds(seq);
    try {
        // Track.insertClip/overwriteClip take the time as a String of ticks.
        if (overwrite) { track.overwriteClip(item, String(ticks)); } else { track.insertClip(item, String(ticks)); }
    } finally {
        if (hasRange) { try { item.setInPoint(priorIn, 4); item.setOutPoint(priorOut, 4); } catch (e) {} }
    }
    var placed = [];
    __mcp_eachClip(seq, function (c, name) {
        if (!before[String(c.nodeId)]) { placed.push({ clip: c, name: name }); }
        return false;
    });
    if (!placed.length) { throw __mcp_fail("failed", "Premiere placed nothing for " + item.name); }
    if (Number(placed[0].clip.start.ticks) !== ticks) {
        throw __mcp_fail("misplaced", item.name + " landed at " + __mcp_when(seq, placed[0].clip.start).seconds +
            " s, not " + __mcp_when(seq, ticks).seconds + " s - check the time units insertClip takes");
    }
    if (__mcp_has(w.duration)) {
        var end = __mcp_time(ticks + __mcp_snapTicks(seq, w.duration));
        for (var p = 0; p < placed.length; p++) { placed[p].clip.end = end; }
    }
    var out = [];
    for (var q = 0; q < placed.length; q++) { out.push(__mcp_clipSummary(seq, placed[q].clip, placed[q].name)); }
    return { placed: out };
}

function __mcp_trim(seq, w) {
    var c = __mcp_clip(seq, w.nodeId).clip;
    if (__mcp_has(w.start)) { c.start = __mcp_time(__mcp_snapTicks(seq, w.start)); }
    if (__mcp_has(w.end)) { c.end = __mcp_time(__mcp_snapTicks(seq, w.end)); }
    if (__mcp_has(w.sourceIn)) { c.inPoint = __mcp_time(Math.round(Number(w.sourceIn) * __MCP_TICKS)); }
    if (__mcp_has(w.sourceOut)) { c.outPoint = __mcp_time(Math.round(Number(w.sourceOut) * __MCP_TICKS)); }
    var where = __mcp_clip(seq, w.nodeId);
    return __mcp_clipSummary(seq, where.clip, where.trackName);
}

/* ---------- components ---------- */

function __mcp_component(clip, names) {
    var comps = clip.components;
    for (var i = 0; i < comps.numItems; i++) {
        for (var n = 0; n < names.length; n++) {
            if (comps[i].displayName === names[n] || comps[i].matchName === names[n]) { return comps[i]; }
        }
    }
    return null;
}

function __mcp_param(clip, compNames, paramName) {
    var comp = __mcp_component(clip, compNames);
    if (!comp) { throw __mcp_fail("no_component", "Clip " + clip.name + " has no " + compNames[0] + " component"); }
    for (var p = 0; p < comp.properties.numItems; p++) {
        if (comp.properties[p].displayName === paramName) { return comp.properties[p]; }
    }
    throw __mcp_fail("no_param", comp.displayName + " has no parameter " + paramName);
}

/* Set a value, or keyframes [{at, value}], on one parameter. */
function __mcp_setParam(clip, prop, value, keys, convert, clearKeys) {
    if (keys instanceof Array && keys.length) {
        prop.setTimeVarying(true);
        for (var k = 0; k < keys.length; k++) {
            var t = __mcp_time(Math.round((clip.inPoint.seconds + Number(keys[k].at)) * __MCP_TICKS));
            prop.addKey(t);
            prop.setValueAtKey(t, convert(keys[k].value), true);
        }
        return;
    }
    if (prop.isTimeVarying()) {
        // Turning keyframing off deletes every key, which may be the user's own work.
        if (!clearKeys) { throw __mcp_fail("keyframed", prop.displayName + " has keyframes; a fixed value would delete them. Pass clearKeys:true to do that."); }
        prop.setTimeVarying(false);
    }
    prop.setValue(convert(value), true);
}

/*
 * Premiere's Volume "Level" is not in dB. Measured scripting value is a gain
 * where +15 dB is 1.0, so dB = 20*log10(v) + 15, and 0 dB is about 0.1778.
 */
function __mcp_dbToLevel(db) { return Math.pow(10, (Number(db) - 15) / 20); }
/* Silence is null: -Infinity is not valid JSON, and the polyfill would write it as a bare token. */
function __mcp_levelToDb(v) { return v > 0 ? __mcp_round(20 * Math.log(v) / Math.LN10 + 15) : null; }

/* ---------- markers ---------- */

var __MCP_MARKER_TYPES = { comment: "setTypeAsComment", chapter: "setTypeAsChapter",
                           segmentation: "setTypeAsSegmentation", weblink: "setTypeAsWebLink" };

function __mcp_markerInfo(seq, m) {
    var out = { guid: String(m.guid), name: m.name, comments: m.comments, type: String(m.type).toLowerCase(),
                start: __mcp_when(seq, m.start) };
    var end = __mcp_when(seq, m.end);
    if (end.seconds > out.start.seconds) { out.end = end; }
    return out;
}

function __mcp_markerList(seq, collection) {
    var out = [], m = collection.getFirstMarker();
    while (m) { out.push(__mcp_markerInfo(seq, m)); m = collection.getNextMarker(m); }
    return out;
}

function __mcp_markerByGuid(collection, guid) {
    var m = collection.getFirstMarker();
    while (m) { if (String(m.guid) === String(guid)) { return m; } m = collection.getNextMarker(m); }
    throw __mcp_fail("unknown_marker", "No marker with guid " + guid);
}

/* ---------- QE bridging for effects ---------- */

/* Frames as a non-drop "HH:MM:SS:FF" at the nominal rate (29.97 counts as 30), the form QE takes durations in. */
function __mcp_framesToTimecode(frames, fps) {
    var base = Math.round(fps), f = Math.round(frames);
    var pad = function (n) { return (n < 10 ? "0" : "") + n; };
    var s = Math.floor(f / base);
    return pad(Math.floor(s / 3600)) + ":" + pad(Math.floor(s / 60) % 60) + ":" + pad(s % 60) + ":" + pad(f % base);
}

/* The QE twin of a timeline clip: same track, same start tick. getItemAt also returns gaps, so they are skipped. */
function __mcp_qeClip(seq, where) {
    var m = /^([VA])(\d+)$/.exec(where.trackName);
    var qs = __mcp_qe().project.getActiveSequence();
    var qt = m[1] === "V" ? qs.getVideoTrackAt(Number(m[2]) - 1) : qs.getAudioTrackAt(Number(m[2]) - 1);
    var want = String(where.clip.start.ticks);
    for (var i = 0; i < qt.numItems; i++) {
        var q = qt.getItemAt(i);
        if (q && q.type !== "Empty" && String(q.start.ticks) === want) { return q; }
    }
    throw __mcp_fail("no_qe_clip", "Could not find clip " + where.clip.name + " in the QE DOM");
}

var __mcp_editOps = {

    clips: function (args) {
        __mcp_requireOwned();
        var seq = __mcp_sequence(args.sequenceId), cmd = args.command;
        if (cmd === "insert" || cmd === "overwrite") {
            return __mcp_batch(args.items, function (w) { return __mcp_place(seq, w, cmd === "overwrite"); });
        }
        if (cmd === "trim") { return __mcp_batch(args.items, function (w) { return __mcp_trim(seq, w); }); }
        if (cmd === "move") {
            return __mcp_batch(args.items, function (w) {
                var c = __mcp_clip(seq, w.nodeId).clip;
                var delta = __mcp_has(w.by) ? __mcp_snapTicks(seq, w.by) : __mcp_snapTicks(seq, w.to) - Number(c.start.ticks);
                c.move(__mcp_time(delta));
                var where = __mcp_clip(seq, w.nodeId);
                return __mcp_clipSummary(seq, where.clip, where.trackName);
            });
        }
        if (cmd === "lift" || cmd === "rippleDelete") {
            return __mcp_batch(args.items, function (w) {
                var c = __mcp_clip(seq, w.nodeId).clip, name = c.name;
                c.remove(cmd === "rippleDelete", true);
                return { removed: String(w.nodeId), name: name };
            });
        }
        if (cmd === "enable" || cmd === "disable") {
            return __mcp_batch(args.items, function (w) {
                var c = __mcp_clip(seq, w.nodeId).clip;
                c.disabled = cmd === "disable";
                return { nodeId: String(c.nodeId), disabled: !!c.disabled };
            });
        }
        if (cmd === "link" || cmd === "unlink") {
            // Premiere links and unlinks the selection, so the selection is borrowed and put back.
            var prior = seq.getSelection(), ids = args.nodeIds || [];
            for (var s = 0; s < prior.length; s++) { prior[s].setSelected(false, true); }
            var chosen = [];
            for (var i = 0; i < ids.length; i++) { var c = __mcp_clip(seq, ids[i]).clip; c.setSelected(true, true); chosen.push(c); }
            if (cmd === "link") { seq.linkSelection(); } else { seq.unlinkSelection(); }
            for (var j = 0; j < chosen.length; j++) { chosen[j].setSelected(false, true); }
            for (var r = 0; r < prior.length; r++) { try { prior[r].setSelected(true, true); } catch (e) {} }
            return { command: cmd, nodeIds: ids };
        }
        throw __mcp_fail("bad_value", "Unknown pr_clips command " + cmd);
    },

    markers: function (args) {
        var seq = __mcp_sequence(args.sequenceId);
        var collection = __mcp_has(args.projectItem) ? __mcp_projectItem(args.projectItem).getMarkers() : seq.markers;
        var cmd = args.command || "list";
        if (cmd === "list") { return { markers: __mcp_markerList(seq, collection) }; }
        __mcp_requireOwned();
        if (cmd === "add") {
            return __mcp_batch(args.markers, function (w) {
                var type = String(w.type || "comment");
                if (!__MCP_MARKER_TYPES[type]) { throw __mcp_fail("bad_value", "type must be one of " + __mcp_keys(__MCP_MARKER_TYPES).join(", ")); }
                var m = collection.createMarker(__mcp_snapTicks(seq, w.at) / __MCP_TICKS);
                m[__MCP_MARKER_TYPES[type]]();
                if (__mcp_has(w.name)) { m.name = String(w.name); }
                if (__mcp_has(w.comments)) { m.comments = String(w.comments); }
                // Marker.end takes seconds, not a Time.
                if (__mcp_has(w.duration)) { m.end = __mcp_snapTicks(seq, Number(w.at) + Number(w.duration)) / __MCP_TICKS; }
                if (__mcp_has(w.color)) { m.setColorByIndex(Number(w.color)); }
                return __mcp_markerInfo(seq, m);
            });
        }
        if (cmd === "update") {
            return __mcp_batch(args.markers, function (w) {
                var m = __mcp_markerByGuid(collection, w.guid);
                if (__mcp_has(w.name)) { m.name = String(w.name); }
                if (__mcp_has(w.comments)) { m.comments = String(w.comments); }
                if (__mcp_has(w.type)) {
                    if (!__MCP_MARKER_TYPES[String(w.type)]) { throw __mcp_fail("bad_value", "type must be one of " + __mcp_keys(__MCP_MARKER_TYPES).join(", ")); }
                    m[__MCP_MARKER_TYPES[String(w.type)]]();
                }
                return __mcp_markerInfo(seq, m);
            });
        }
        if (cmd === "delete") {
            return __mcp_batch(args.markers, function (w) {
                collection.deleteMarker(__mcp_markerByGuid(collection, w.guid));
                return { deleted: String(w.guid) };
            });
        }
        throw __mcp_fail("bad_value", "Unknown pr_markers command " + cmd);
    },

    audio: function (args) {
        var seq = __mcp_sequence(args.sequenceId), cmd = args.command;
        if (cmd === "level") {
            __mcp_requireOwned();
            return __mcp_batch(args.items, function (w) {
                var c = __mcp_clip(seq, w.nodeId).clip;
                if (c.mediaType !== "Audio") { throw __mcp_fail("type_mismatch", c.name + " is not an audio clip"); }
                var prop = __mcp_param(c, ["Volume"], "Level");
                if (!__mcp_has(w.db) && !(w.keys instanceof Array)) { throw __mcp_fail("bad_value", "Give db or keys"); }
                __mcp_setParam(c, prop, w.db, w.keys, __mcp_dbToLevel, w.clearKeys);
                var out = { nodeId: String(c.nodeId), keyframed: !!prop.isTimeVarying() };
                if (!out.keyframed) { out.db = __mcp_levelToDb(prop.getValue()); }
                return out;
            });
        }
        if (cmd === "mute" || cmd === "unmute") {
            __mcp_requireOwned();
            var track = __mcp_track(seq, args.track);
            track.setMute(cmd === "mute" ? 1 : 0);
            return { track: args.track, muted: !!track.isMuted() };
        }
        if (cmd === "read") {
            var cl = __mcp_clip(seq, args.nodeId).clip;
            var lv = __mcp_param(cl, ["Volume"], "Level"), info = { nodeId: String(cl.nodeId), keyframed: !!lv.isTimeVarying() };
            if (info.keyframed) {
                var keys = lv.getKeys(), list = [];
                for (var k = 0; k < keys.length; k++) {
                    list.push({ at: __mcp_round(keys[k].seconds - cl.inPoint.seconds), db: __mcp_levelToDb(lv.getValueAtKey(keys[k])) });
                }
                info.keys = list;
            } else {
                info.db = __mcp_levelToDb(lv.getValue());
            }
            return info;
        }
        throw __mcp_fail("bad_value", "Unknown pr_audio command " + cmd);
    },

    /*
     * Motion's Position and Anchor Point are fractions of the frame in
     * scripting (0.5, 0.5 is centre). Callers speak pixels; the host divides
     * by the sequence frame size.
     */
    motion: function (args) {
        __mcp_requireOwned();
        var seq = __mcp_sequence(args.sequenceId);
        var w = Number(seq.frameSizeHorizontal), h = Number(seq.frameSizeVertical);
        var toFrac = function (v) {
            if (!(v instanceof Array) || v.length !== 2) { throw __mcp_fail("bad_value", "position/anchor must be [x, y] in pixels"); }
            return [Number(v[0]) / w, Number(v[1]) / h];
        };
        var same = function (v) { return Number(v); };
        var PARAMS = {
            position: [["Motion"], "Position", toFrac], scale: [["Motion"], "Scale", same],
            rotation: [["Motion"], "Rotation", same], anchor: [["Motion"], "Anchor Point", toFrac],
            opacity: [["Opacity"], "Opacity", same]
        };
        return __mcp_batch(args.items, function (item) {
            var c = __mcp_clip(seq, item.nodeId).clip, done = [];
            if (c.mediaType !== "Video") { throw __mcp_fail("type_mismatch", c.name + " is not a video clip"); }
            for (var key in PARAMS) {
                if (!PARAMS.hasOwnProperty(key)) { continue; }
                var spec = PARAMS[key], keys = [];
                if (item.keys instanceof Array) {
                    for (var k = 0; k < item.keys.length; k++) {
                        if (__mcp_has(item.keys[k][key])) { keys.push({ at: item.keys[k].at, value: item.keys[k][key] }); }
                    }
                }
                if (!keys.length && !__mcp_has(item[key])) { continue; }
                __mcp_setParam(c, __mcp_param(c, spec[0], spec[1]), item[key], keys, spec[2], item.clearKeys);
                done.push(key);
            }
            if (!done.length) { throw __mcp_fail("bad_value", "Nothing to set: give position, scale, rotation, anchor or opacity, or keys"); }
            return { nodeId: String(c.nodeId), set: done };
        });
    },

    effects: function (args) {
        var seq = __mcp_sequence(args.sequenceId), cmd = args.command;
        if (cmd === "list") {
            var q = __mcp_qe().project, kind = args.kind || "video", names = [];
            var raw = kind === "transition" ? q.getVideoTransitionList() : (kind === "audio" ? q.getAudioEffectList() : q.getVideoEffectList());
            var match = String(args.match || "").toLowerCase();
            for (var i = 0; i < raw.length; i++) {
                if (!match || String(raw[i]).toLowerCase().indexOf(match) !== -1) { names.push(String(raw[i])); }
            }
            return { kind: kind, count: names.length, names: names.slice(0, Number(args.limit || 100)) };
        }
        __mcp_requireOwned();
        if (cmd === "params") {
            return __mcp_batch(args.items, function (w) {
                var c = __mcp_clip(seq, w.nodeId).clip;
                var prop = __mcp_param(c, [String(w.component)], String(w.param));
                __mcp_setParam(c, prop, w.value, w.keys, function (v) { return v; }, w.clearKeys);
                return { nodeId: String(c.nodeId), component: w.component, param: w.param, value: prop.isTimeVarying() ? null : prop.getValue() };
            });
        }
        if (cmd === "add" || cmd === "transition") {
            return __mcp_withActive(seq, function () {
                return __mcp_batch(args.items, function (w) {
                    var where = __mcp_clip(seq, w.nodeId), qc = __mcp_qeClip(seq, where), qp = __mcp_qe().project;
                    if (cmd === "transition") {
                        var tr = qp.getVideoTransitionByName(String(w.name || "Cross Dissolve"));
                        if (!tr) { throw __mcp_fail("unknown_effect", "No transition named " + w.name); }
                        var frames = Math.max(1, Math.round(Number(w.duration || 1) * __mcp_fps(seq)));
                        qc.addTransition(tr, w.atStart !== false, __mcp_framesToTimecode(frames, __mcp_fps(seq)), "00:00:00:00", 0.5, false, true);
                        return { nodeId: String(where.clip.nodeId), transition: String(w.name || "Cross Dissolve"), frames: frames };
                    }
                    var audio = where.clip.mediaType === "Audio";
                    var fx = audio ? qp.getAudioEffectByName(String(w.name)) : qp.getVideoEffectByName(String(w.name));
                    if (!fx) { throw __mcp_fail("unknown_effect", "No " + (audio ? "audio" : "video") + " effect named " + w.name); }
                    if (audio) { qc.addAudioEffect(fx); } else { qc.addVideoEffect(fx); }
                    return { nodeId: String(where.clip.nodeId), added: String(w.name) };
                });
            });
        }
        throw __mcp_fail("bad_value", "Unknown pr_effects command " + cmd);
    }
};
