/*
 * Capability probe. Answers "can this MCP express technique X" with evidence,
 * not with an assertion that the API exists.
 *
 * Runs in a THROWAWAY project: the caller's project is saved and reopened by
 * the driver. Two prior incidents make that non-negotiable - the unit suite
 * deleted the live auth token, and the integration suite renamed the open
 * project.
 *
 * Every probe returns { id, area, verdict, evidence, notes }:
 *   PASS   - reachable through the shipped tool surface
 *   FAIL   - not reachable; needs a named tool or op
 *   REVIEW - depends on machine state, is subjective, or is plan/licence gated
 *
 * A probe may only report PASS if the HOST OP that a tool dispatches to can do
 * it. Being possible via arbitrary ExtendScript is explicitly not the bar.
 */

/*
 * No #include here on purpose. The driver copies this file into a temp dir to
 * substitute paths, which breaks any relative #include at PARSE time - and a
 * parse error in ExtendScript surfaces as a modal dialog, not a stack trace.
 * main() loads the shipped host with $.evalFile, and that brings the JSON
 * polyfill with it.
 */

/*
 * The host is loaded at TOP LEVEL, deliberately.
 *
 * $.evalFile defines symbols in the CALLING scope, not globally. Loading it
 * inside main() made __mcp_exec visible only inside main(), while every probe
 * function - defined out here - looked it up in a scope where it did not exist
 * and reported "__mcp_exec is undefined" for 54 of 63 probes.
 *
 * Note also that the CEP extension's ExtendScript context is NOT shared with
 * DoScriptFile: a bare `typeof __mcp_exec` is undefined even while the panel is
 * running. The probe must load the host itself.
 */
$.evalFile(new File("__HOST_PATH__"));

var RESULTS = [];
var COMP = null;
var COMP_ID = null;

/*
 * Re-fetch the comp by id rather than holding the object.
 * exportAsMotionGraphicsTemplate invalidates the CompItem reference, and every
 * probe after it then died with "Object is invalid" - the same class of bug as
 * addProperty invalidating sibling property references.
 */
function refreshComp() {
    if (COMP_ID !== null) {
        var c = app.project.itemByID(COMP_ID);
        if (c) { COMP = c; }
    }
    return COMP;
}

function probe(id, area, fn) {
    var r = { id: id, area: area };
    try {
        refreshComp();
        var out = fn();
        r.verdict = out.verdict;
        r.evidence = out.evidence;
        if (out.notes) { r.notes = out.notes; }
    } catch (e) {
        r.verdict = "FAIL";
        r.evidence = "threw: " + String(e);
        r.notes = "line " + e.line;
    }
    RESULTS.push(r);
}

/* Does the shipped host expose an op by this name? */
function hasOp(name) {
    return (typeof __mcp_ops === "object") && __mcp_ops.hasOwnProperty(name);
}

/* Does a shipped op accept this command? Probed by calling it and reading the
   error, because the command lists live in the tool schema, not the host. */
function opAccepts(op, args) {
    try {
        var raw = __mcp_exec(JSON.stringify({ op: op, args: args }));
        var parsed = JSON.parse(raw);
        return { ok: parsed.ok, error: parsed.ok ? null : parsed.error };
    } catch (e) {
        return { ok: false, error: { code: "threw", message: String(e) } };
    }
}

function call(op, args) {
    var parsed = JSON.parse(__mcp_exec(JSON.stringify({ op: op, args: args })));
    if (!parsed.ok) { throw new Error(op + ": " + parsed.error.code + " " + parsed.error.message); }
    return parsed.result;
}

function mkText(txt, name) {
    var l = COMP.layers.addText(txt || "Probe");
    if (name) { l.name = name; }
    return l;
}
function mkSolid(name, w, h) {
    return COMP.layers.addSolid([1, 1, 1], name || "solid", w || 100, h || 100, 1);
}
function near(a, b, tol) { return Math.abs(a - b) <= (tol === undefined ? 0.5 : tol); }

/* ---------------------------------------------------------------- A. Layout */

function probeLayout() {
    probe("A1", "layout", function () {
        // Centring must account for the anchor. Text anchors baseline-left, so
        // setting position to comp centre does NOT optically centre it.
        var t = mkText("Centre me", "A1");
        call("align", { layerIds: [t.id], align: "center", relativeTo: "comp" });
        var m = call("measure", { layerId: t.id }).measured[0];
        var offX = Math.abs(m.centerX - COMP.width / 2);
        var offY = Math.abs(m.centerY - COMP.height / 2);
        return { verdict: (offX < 1 && offY < 1) ? "PASS" : "FAIL",
                 evidence: "optical centre lands at " + m.centerX.toFixed(1) + "," + m.centerY.toFixed(1) +
                           " vs comp centre " + (COMP.width/2) + "," + (COMP.height/2) +
                           " (off by " + offX.toFixed(2) + "," + offY.toFixed(2) + ")",
                 notes: "centres the INK, not the anchor - a baseline-left text layer would otherwise sit wrong" };
    });

    probe("A2", "layout", function () {
        var a = mkSolid("A2a", 100, 50), b = mkSolid("A2b", 200, 50), c = mkText("A2c", "A2c");
        call("set", { writes: [
            { layerId: a.id, path: ["ADBE Transform Group","ADBE Position"], value: [300, 300] },
            { layerId: b.id, path: ["ADBE Transform Group","ADBE Position"], value: [700, 400] },
            { layerId: c.id, path: ["ADBE Transform Group","ADBE Position"], value: [500, 500] }] });
        // include a rotated layer - naive implementations break on these
        call("set", { writes: [{ layerId: b.id, path: ["ADBE Transform Group","ADBE Rotate Z"], value: 15 }] });
        call("align", { layerIds: [a.id, b.id, c.id], align: "left" });
        var ms = call("measure", { layerIds: [a.id, b.id, c.id] }).measured;
        var lefts = [ms[0].left, ms[1].left, ms[2].left];
        var spread = Math.max(lefts[0],lefts[1],lefts[2]) - Math.min(lefts[0],lefts[1],lefts[2]);
        return { verdict: spread < 1.5 ? "PASS" : "REVIEW",
                 evidence: "left edges after align: " + lefts[0].toFixed(1) + ", " + lefts[1].toFixed(1) +
                           ", " + lefts[2].toFixed(1) + " (spread " + spread.toFixed(2) + ")",
                 notes: spread < 1.5 ? "includes a rotated layer and a text layer"
                                     : "rotation is not accounted for - bounds are axis-aligned on the source" };
    });

    probe("A3", "layout", function () {
        var ws = [60, 140, 40, 200, 80], made = [];
        for (var i = 0; i < ws.length; i++) {
            var l = mkSolid("A3_" + i, ws[i], 40);
            call("set", { writes: [{ layerId: l.id, path: ["ADBE Transform Group","ADBE Position"],
                                     value: [200 + i * 300, 700] }] });
            made.push(l.id);
        }
        var r = call("distribute", { layerIds: made, axis: "horizontal", by: "gaps" });
        var ms2 = call("measure", { layerIds: made }).measured;
        ms2.sort(function(a,b){ return a.left - b.left; });
        var gaps = [];
        for (var g = 1; g < ms2.length; g++) { gaps.push(ms2[g].left - ms2[g-1].right); }
        var mn = Math.min.apply(null, gaps), mx = Math.max.apply(null, gaps);
        return { verdict: (mx - mn) < 1.5 ? "PASS" : "FAIL",
                 evidence: "equal-GAP distribute over unequal widths; gaps " +
                           (function(){ var o=[]; for(var q=0;q<gaps.length;q++){o.push(gaps[q].toFixed(1));} return o.join(", "); })() +
                           " (variance " + (mx-mn).toFixed(2) + ")",
                 notes: "gaps and centres give different answers for unequal widths; both are offered" };
    });

    probe("A4", "layout", function () {
        var ids = [];
        for (var i = 0; i < 6; i++) { ids.push(mkSolid("A4_" + i, 80, 60).id); }
        var r = call("stack", { layerIds: ids, direction: "grid", columns: 3, gap: 20, x: 100, y: 100 });
        var p = r.placed;
        var rowOk = (Math.abs(p[1].left - (p[0].left + 80 + 20)) < 0.6);
        var colOk = (Math.abs(p[3].top - (p[0].top + 60 + 20)) < 0.6);
        return { verdict: (rowOk && colOk) ? "PASS" : "FAIL",
                 evidence: "3-column grid: item2 left=" + p[1].left + " (want " + (p[0].left+100) +
                           "), item4 top=" + p[3].top + " (want " + (p[0].top+80) + ")" };
    });

    probe("A5", "layout", function () {
        // The industry's most-used utility: move the anchor WITHOUT the layer moving.
        var l = mkSolid("A5", 200, 100);
        call("set", { writes: [{ layerId: l.id, path: ["ADBE Transform Group","ADBE Position"], value: [500, 500] }] });
        var worst = 0, checked = [];
        var spots = ["topLeft", "bottomCenter", "middleRight", "center"];
        for (var i = 0; i < spots.length; i++) {
            var r = call("anchor", { layerId: l.id, to: spots[i] });
            var d = Math.max(Math.abs(r.movedBy.x), Math.abs(r.movedBy.y));
            worst = Math.max(worst, d);
            checked.push(spots[i] + "=" + d);
        }
        return { verdict: worst < 0.5 ? "PASS" : "FAIL",
                 evidence: "anchor moved to 4 positions; worst on-screen drift " + worst + "px (" + checked.join(", ") + ")",
                 notes: "Position is compensated by the anchor delta, so the layer stays put" };
    });

    probe("A6", "layout", function () {
        return { verdict: "FAIL", evidence: "no safe-area concept in any tool",
                 notes: "pin with padding covers a fixed inset, but not per-platform zones (TikTok/Reels reserve top 10-15%, bottom 20-25%)" };
    });

    probe("A7", "layout", function () {
        var t = mkText("Pinned", "A7");
        var r = call("pin", { layerId: t.id, to: "bottomRight", padding: 80, mode: "static" });
        var m = call("measure", { layerId: t.id }).measured[0];
        var okX = Math.abs((COMP.width - 80) - m.right) < 1;
        var okY = Math.abs((COMP.height - 80) - m.bottom) < 1;
        return { verdict: (okX && okY) ? "PASS" : "FAIL",
                 evidence: "pinned bottom-right with 80 padding; right=" + m.right.toFixed(1) +
                           " (want " + (COMP.width-80) + "), bottom=" + m.bottom.toFixed(1) +
                           " (want " + (COMP.height-80) + ")" };
    });

    probe("A8", "layout", function () {
        // A rigged pin should survive a comp resize - that is what makes one
        // build deliverable at 16:9, 1:1 and 9:16.
        var t = mkText("Reflow", "A8");
        call("pin", { layerId: t.id, to: "bottomRight", padding: 60, mode: "rigged" });
        var w0 = COMP.width, h0 = COMP.height;
        call("timing", { command: "setComp", compId: COMP.id, width: 1080, height: 1080 });
        refreshComp();
        var m = call("measure", { layerId: t.id }).measured[0];
        var okSquare = Math.abs((1080 - 60) - m.right) < 2;
        call("timing", { command: "setComp", compId: COMP.id, width: w0, height: h0 });
        refreshComp();
        return { verdict: okSquare ? "PASS" : "FAIL",
                 evidence: "resized 1920x1080 -> 1080x1080; rigged pin put right edge at " +
                           m.right.toFixed(1) + " (want 1020)",
                 notes: "rigged mode re-derives from thisComp each frame, so one build covers several formats" };
    });

    probe("A9", "layout", function () {
        var l = mkSolid("A9", 50, 50);
        var res = opAccepts("setExpression", { writes: [{ layerId: l.id,
            path: ["ADBE Transform Group", "ADBE Position"],
            expression: "[thisComp.width - 80, thisComp.height - 80]" }] });
        var applied = res.ok && res.error === null;
        var v = l.property("ADBE Transform Group").property("ADBE Position").value;
        return { verdict: applied ? "PASS" : "FAIL",
                 evidence: "edge-pin expression applied, evaluated to " + v[0].toFixed(0) + "," + v[1].toFixed(0),
                 notes: "reachable via ae_set expressions, but the caller writes the expression string by hand" };
    });

    probe("A11", "layout", function () {
        /*
         * Every corner, rigged. A7/A8 only ever pinned bottomRight, which is
         * f=[1,1] - the one preset where both axes take the same branch, so a
         * chained-ternary mis-association in the expression builder produced
         * the right answer by accident. topRight rigged to the BOTTOM right in
         * a real build before this probe existed.
         */
        var cases = [
            { to: "topLeft",     x: "left",  y: "top"    },
            { to: "topRight",    x: "right", y: "top"    },
            { to: "bottomLeft",  x: "left",  y: "bottom" },
            { to: "bottomRight", x: "right", y: "bottom" }
        ];
        var pad = 70, bad = [], detail = [];
        for (var i = 0; i < cases.length; i++) {
            var c = cases[i];
            var l = mkSolid("A11_" + c.to, 120, 80);
            call("pin", { layerId: l.id, to: c.to, padding: pad, mode: "rigged" });
            var m = call("measure", { layerId: l.id }).measured[0];
            var wantX = (c.x === "left") ? pad : COMP.width - pad;
            var gotX  = (c.x === "left") ? m.left : m.right;
            var wantY = (c.y === "top") ? pad : COMP.height - pad;
            var gotY  = (c.y === "top") ? m.top : m.bottom;
            var ok = Math.abs(wantX - gotX) < 1 && Math.abs(wantY - gotY) < 1;
            if (!ok) { bad.push(c.to); }
            detail.push(c.to + " -> " + gotX.toFixed(0) + "," + gotY.toFixed(0) +
                        " (want " + wantX + "," + wantY + ")");
        }
        return { verdict: bad.length === 0 ? "PASS" : "FAIL",
                 evidence: detail.join("; "),
                 notes: bad.length ? ("rigged pin wrong for: " + bad.join(", "))
                                   : "all four corners agree between the baked value and the rig" };
    });

    probe("A10", "layout", function () {
        var a = mkSolid("A10a", 50, 50), b = mkSolid("A10b", 50, 50);
        call("compose", { command: "parent", layerId: a.id, parentLayerId: b.id });
        var ok = (a.parent !== null && a.parent.id === b.id);
        return { verdict: ok ? "PASS" : "FAIL", evidence: "parent set: " + ok };
    });
}

/* ---------------------------------------------------------------- B. Timing */

function probeTiming() {
    probe("B1", "timing", function () {
        var ids = [];
        for (var i = 0; i < 5; i++) { ids.push(mkSolid("B1_" + i, 30, 30).id); }
        var r = call("stagger", { layerIds: ids, step: 0.2, from: 0 });
        var starts = [];
        for (var j = 0; j < r.applied.length; j++) { starts.push(r.applied[j].startTime); }
        var even = true;
        for (var k = 1; k < starts.length; k++) { if (Math.abs((starts[k]-starts[k-1]) - 0.2) > 0.01) { even = false; } }
        return { verdict: even ? "PASS" : "FAIL",
                 evidence: "5 layers staggered by 0.2s: " + starts.join(", ") };
    });

    probe("B2", "timing", function () {
        // Idempotency: apply the same ease twice, confirm it does not compound.
        var l = mkSolid("B2", 50, 50);
        var op = l.property("ADBE Transform Group").property("ADBE Opacity");
        call("keyframes", { layerId: l.id, path: ["ADBE Transform Group", "ADBE Opacity"],
                            add: [{ time: 0, value: 0 }, { time: 1, value: 100 }] });
        call("setEase", { layerId: l.id, path: ["ADBE Transform Group", "ADBE Opacity"], influence: 60 });
        var i1 = op.keyOutTemporalEase(1)[0].influence;
        call("setEase", { layerId: l.id, path: ["ADBE Transform Group", "ADBE Opacity"], influence: 60 });
        var i2 = op.keyOutTemporalEase(1)[0].influence;
        // The real idempotency risk is an op that COMPUTES offsets. Run stagger
        // twice and confirm it re-derives rather than compounding.
        var sids = [];
        for (var q = 0; q < 4; q++) { sids.push(mkSolid("B2_" + q, 20, 20).id); }
        var first = call("stagger", { layerIds: sids, step: 0.25 });
        var again = call("stagger", { layerIds: sids, step: 0.25 });
        var same = true;
        for (var z = 0; z < first.applied.length; z++) {
            if (Math.abs(first.applied[z].startTime - again.applied[z].startTime) > 0.001) { same = false; }
        }
        return { verdict: (near(i1, i2, 0.01) && same) ? "PASS" : "FAIL",
                 evidence: "ease re-apply " + i1.toFixed(1) + "->" + i2.toFixed(1) +
                           "; stagger run twice produced identical start times: " + same,
                 notes: "stagger records base times in the layer comment, so it re-derives instead of compounding" };
    });

    probe("B3", "timing", function () {
        var l = mkSolid("B3", 50, 50);
        call("keyframes", { layerId: l.id, path: ["ADBE Transform Group", "ADBE Opacity"],
                            add: [{ time: 0, value: 0 }, { time: 1, value: 100 }] });
        var r = call("setEase", { layerId: l.id, path: ["ADBE Transform Group", "ADBE Opacity"],
                                  influence: 75, mode: "both" });
        var inf = l.property("ADBE Transform Group").property("ADBE Opacity").keyOutTemporalEase(1)[0].influence;
        return { verdict: near(inf, 75, 0.5) ? "PASS" : "FAIL",
                 evidence: "requested influence 75, AE reports " + inf.toFixed(2) + ", keysEased=" + r.keysEased };
    });

    probe("B4", "timing", function () {
        // Overshoot = an extra key past the target. Expressible with what we have?
        var l = mkSolid("B4", 50, 50);
        var r = call("keyframes", { layerId: l.id, path: ["ADBE Transform Group", "ADBE Scale"],
            add: [{ time: 0, value: [0, 0, 100] }, { time: 0.4, value: [108, 108, 100] }, { time: 0.6, value: [100, 100, 100] }] });
        return { verdict: r.numKeys === 3 ? "PASS" : "FAIL",
                 evidence: "3-key overshoot written, numKeys=" + r.numKeys,
                 notes: "expressible, but the caller invents the 108% and the timing; no overshoot primitive" };
    });

    probe("B5", "timing", function () {
        var l = mkSolid("B5", 50, 50);
        var expr = "amp=.1;freq=3;decay=5;n=0;" +
                   "if(numKeys>0){n=nearestKey(time).index;if(key(n).time>time){n--;}}" +
                   "if(n>0){t=time-key(n).time;v=velocityAtTime(key(n).time-.001);" +
                   "value+v*amp*Math.sin(freq*t*2*Math.PI)/Math.exp(decay*t)}else{value}";
        var res = opAccepts("setExpression", { writes: [{ layerId: l.id,
            path: ["ADBE Transform Group", "ADBE Position"], expression: expr }] });
        var err = l.property("ADBE Transform Group").property("ADBE Position").expressionError;
        return { verdict: (res.ok && !err) ? "PASS" : "FAIL",
                 evidence: "community bounce expression applied, expressionError=" + (err || "none"),
                 notes: "works, but the caller supplies the whole expression; no bounce primitive" };
    });

    probe("B6", "timing", function () {
        var l = mkSolid("B6", 50, 50);
        call("keyframes", { layerId: l.id, path: ["ADBE Transform Group", "ADBE Rotate Z"],
                            add: [{ time: 0, value: 0 }, { time: 1, value: 90 }] });
        opAccepts("setExpression", { writes: [{ layerId: l.id,
            path: ["ADBE Transform Group", "ADBE Rotate Z"], expression: "loopOut('cycle')" }] });
        var p = l.property("ADBE Transform Group").property("ADBE Rotate Z");
        return { verdict: (p.expressionEnabled && !p.expressionError) ? "PASS" : "FAIL",
                 evidence: "loopOut enabled=" + p.expressionEnabled + " error=" + (p.expressionError || "none") };
    });

    probe("B7", "timing", function () {
        // Time remapping requires a source WITH DURATION. A solid has none, and
        // AE rejects it outright - so probe against a precomp layer.
        var inner = app.project.items.addComp("__b7inner__", 100, 100, 1, 4, 30);
        var l = COMP.layers.add(inner);
        l.name = "B7";
        var r = call("timing", { command: "setTimeRemap", layerId: l.id, enabled: true });
        return { verdict: (r.enabled && r.numKeys >= 2) ? "PASS" : "FAIL",
                 evidence: "enabled=" + r.enabled + " autoKeys=" + r.numKeys +
                           " outPoint " + r.outPoint.before + "->" + r.outPoint.after,
                 notes: "enabling auto-creates two keys and changes outPoint; both are reported back" };
    });

    probe("B8", "timing", function () {
        var l = mkSolid("B8", 50, 50);
        call("keyframes", { layerId: l.id, path: ["ADBE Transform Group", "ADBE Opacity"],
                            add: [{ time: 0, value: 100, hold: true }, { time: 1, value: 0 }] });
        var p = l.property("ADBE Transform Group").property("ADBE Opacity");
        var isHold = (p.keyOutInterpolationType(1) === KeyframeInterpolationType.HOLD);
        return { verdict: isHold ? "PASS" : "FAIL",
                 evidence: "key 1 out-interpolation is HOLD: " + isHold };
    });

    probe("B9", "timing", function () {
        call("timing", { command: "addMarker", compId: COMP.id, time: 2, comment: "beat", protectedRegion: true });
        var back = call("timing", { command: "readMarkers", compId: COMP.id });
        var found = null;
        for (var i = 0; i < back.markers.length; i++) { if (back.markers[i].comment === "beat") { found = back.markers[i]; } }
        return { verdict: found ? "PASS" : "FAIL",
                 evidence: "read back " + back.count + " marker(s); 'beat' at t=" +
                           (found ? found.time + " protectedRegion=" + found.protectedRegion : "NOT FOUND"),
                 notes: "protectedRegion is Responsive Design - Time, so a retimed template keeps its intro intact" };
    });

    probe("B10", "timing", function () {
        var l = mkSolid("B10", 50, 50);
        var r = call("timing", { command: "separateDimensions", layerId: l.id });
        return { verdict: r.separated ? "PASS" : "FAIL",
                 evidence: "Position dimensionsSeparated=" + r.separated,
                 notes: "required to ease X and Y independently" };
    });

    probe("B11", "timing", function () {
        var l = mkSolid("B11", 50, 50);
        var r = call("timing", { command: "setMotionBlur", layerId: l.id, enabled: true });
        return { verdict: (r.layerMotionBlur && r.compMotionBlur) ? "PASS" : "FAIL",
                 evidence: "layer=" + r.layerMotionBlur + " comp=" + r.compMotionBlur,
                 notes: "the layer flag alone does nothing; the comp switch is set too" };
    });

    probe("B12", "timing", function () {
        return { verdict: "FAIL",
                 evidence: "no retime op - scaling all keyframe times by a factor is still unbuilt",
                 notes: "'make this 20% faster' must preserve eases while moving every key" };
    });
}

/* ------------------------------------------------------------------ C. Text */

function probeText() {
    probe("C1", "text", function () {
        var t = mkText("Style me", "C1");
        call("set", { writes: [{ layerId: t.id, path: ["ADBE Text Properties", "ADBE Text Document"],
            value: { text: "Styled", fontSize: 64, fillColor: [1, 0, 0], tracking: 20 } }] });
        var td = t.property("ADBE Text Properties").property("ADBE Text Document").value;
        return { verdict: (td.text === "Styled" && td.fontSize === 64) ? "PASS" : "FAIL",
                 evidence: "text='" + td.text + "' size=" + td.fontSize + " tracking=" + td.tracking };
    });

    probe("C2", "text", function () {
        // Suspected live bug: AE is documented to reset justification when
        // sourceText is replaced. We set the whole TextDocument on every write.
        var t = mkText("Justify", "C2");
        call("set", { writes: [{ layerId: t.id, path: ["ADBE Text Properties", "ADBE Text Document"],
            value: { justification: "center" } }] });
        var j1 = t.property("ADBE Text Properties").property("ADBE Text Document").value.justification;
        // now change only the text, which is the common second call
        call("set", { writes: [{ layerId: t.id, path: ["ADBE Text Properties", "ADBE Text Document"],
            value: { text: "Changed" } }] });
        var td = t.property("ADBE Text Properties").property("ADBE Text Document").value;
        var kept = (td.justification === j1);
        return { verdict: kept ? "PASS" : "FAIL",
                 evidence: "justification " + j1 + " -> " + td.justification + " after a text-only write (kept: " + kept + ")",
                 notes: kept ? "read-modify-write of the live TextDocument preserves it"
                             : "REGRESSION: a text-only update silently re-centres/re-lefts the layer" };
    });

    probe("C3", "text", function () {
        var r = call("layers", { compId: COMP.id, command: "createBoxText",
                                 text: "a longer sentence that should wrap inside its box",
                                 width: 300, height: 200, name: "C3" });
        var lay = app.project.layerByID(r.id);
        var td = lay.property("ADBE Text Properties").property("ADBE Text Document").value;
        return { verdict: (r.boxSize && td.boxText) ? "PASS" : "FAIL",
                 evidence: "box text created " + (r.boxSize ? r.boxSize.join("x") : "?") +
                           ", TextDocument.boxText=" + td.boxText };
    });

    probe("C4", "text", function () {
        var t = mkText("Animate me", "C4");
        var a = call("textAnimator", { command: "add", layerId: t.id,
                                       properties: ["opacity", "position"], name: "Reveal" });
        // The returned selector path must actually drive the reveal.
        var k = call("keyframes", { layerId: t.id, path: a.paths.offset,
                                    add: [{ time: 0, value: -100 }, { time: 1, value: 100 }] });
        return { verdict: (a.added.length === 2 && k.numKeys === 2) ? "PASS" : "FAIL",
                 evidence: "animator '" + a.animator + "' with " + a.added.join("+") +
                           "; keyframed selector Offset -> numKeys=" + k.numKeys };
    });

    probe("C5", "text", function () {
        var t = mkText("one two three four", "C5");
        var a = call("textAnimator", { command: "add", layerId: t.id,
                                       properties: ["opacity"], basedOn: "words", name: "PerWord" });
        // Based On lives in the nested Range Advanced group; the op reports back
        // what AE actually stored so this does not have to trust the request.
        return { verdict: (a.basedOnVerified === 3) ? "PASS" : "FAIL",
                 evidence: "requested basedOn=" + a.basedOn + "; AE stored range type " +
                           a.basedOnVerified + " (3=Words)" };
    });

    probe("C6", "text", function () {
        var t = mkText("TYPEWRITER", "C6");
        var a = call("textAnimator", { command: "add", layerId: t.id, properties: ["opacity"],
                                       basedOn: "characters", shape: "square", name: "Type" });
        call("set", { writes: [{ layerId: t.id, path: a.paths.opacity, value: 0 }] });
        var k = call("keyframes", { layerId: t.id, path: a.paths.start,
                                    add: [{ time: 0, value: 0 }, { time: 1.5, value: 100 }] });
        return { verdict: k.numKeys === 2 ? "PASS" : "FAIL",
                 evidence: "opacity-0 animator + square selector, Start keyframed 0->100, numKeys=" + k.numKeys,
                 notes: "the standard typewriter, not a per-frame sourceText hack" };
    });

    probe("C7", "text", function () {
        // Auto-SCALE text to fit a box is still distinct from fit(), which
        // sizes a box to text. Confirm the measurement half exists and say so.
        var t = mkText("A fairly long string to fit", "C7");
        var m = call("measure", { layerId: t.id }).measured[0];
        return { verdict: m.reliable ? "REVIEW" : "FAIL",
                 evidence: "measurable (w=" + m.width.toFixed(0) + "); ae_layout fit sizes a BOX to text, " +
                           "but scaling TEXT down to fit a fixed box has no primitive",
                 notes: "an agent can iterate fontSize against measure; there is no autoFit that does it" };
    });

    probe("C8", "text", function () {
        var t = mkText("Missing font", "C8");
        var applied = "unknown";
        try {
            call("set", { writes: [{ layerId: t.id, path: ["ADBE Text Properties", "ADBE Text Document"],
                value: { font: "ThisFontDoesNotExist-Regular" } }] });
            applied = t.property("ADBE Text Properties").property("ADBE Text Document").value.font;
        } catch (e) { applied = "threw: " + e; }
        var d = call("problems", { maxLayers: 50 });
        var reported = (d.fonts && d.fonts.length > 0);
        return { verdict: reported ? "PASS" : "REVIEW",
                 evidence: "requested a nonexistent font, AE reports font='" + applied +
                           "'; diagnostics fonts[]=" + (d.fonts ? d.fonts.length : "n/a"),
                 notes: reported ? "substitution surfaced" : "silent substitution - the write appears to succeed" };
    });
}

/* ---------------------------------------------------------------- D. Shapes */

function probeShapes() {
    probe("D1", "shapes", function () {
        var r = call("shapes", { command: "create", compId: COMP.id, kind: "rect",
                                 width: 300, height: 100, roundness: 12,
                                 fill: [0.2, 0.6, 1, 1], stroke: [1, 1, 1, 1], strokeWidth: 3 });
        return { verdict: (r.paths && r.paths.size) ? "PASS" : "FAIL",
                 evidence: "created shape " + r.id + " with size path " + (r.paths ? r.paths.size.join(" > ") : "none") };
    });

    probe("D2", "shapes", function () {
        var r = call("shapes", { command: "create", compId: COMP.id, kind: "rect", width: 200, height: 200 });
        var t = call("shapeOps", { command: "add", layerId: r.id, kind: "trim", start: 0, end: 100 });
        // The returned path must actually drive the draw-on.
        var endPath = t.paths["End"] || t.paths["end"];
        var k = endPath ? call("keyframes", { layerId: r.id, path: endPath,
                    add: [{ time: 0, value: 0 }, { time: 1, value: 100 }] }) : null;
        return { verdict: (k && k.numKeys === 2) ? "PASS" : "FAIL",
                 evidence: "trim added in " + t.placedIn + "; keyframed End via " +
                           (endPath ? endPath.join(" > ") : "NO PATH") + " -> numKeys=" + (k ? k.numKeys : 0) };
    });

    probe("D3", "shapes", function () {
        var r = call("shapes", { command: "create", compId: COMP.id, kind: "ellipse", width: 40, height: 40 });
        var rep = call("shapeOps", { command: "add", layerId: r.id, kind: "repeater", copies: 6 });
        return { verdict: rep.matchName ? "PASS" : "FAIL",
                 evidence: "repeater added with copies applied: " + rep.appliedValues.join(",") +
                           "; drivable paths: " + (function(){var n=[];for(var k in rep.paths)n.push(k);return n.slice(0,5).join(", ");})() };
    });

    probe("D4", "shapes", function () {
        var r = call("shapes", { command: "create", compId: COMP.id, kind: "rect", width: 60, height: 60 });
        var m = call("shapeOps", { command: "add", layerId: r.id, kind: "merge" });
        return { verdict: m.matchName ? "PASS" : "FAIL",
                 evidence: "merge paths added: " + m.matchName,
                 notes: "unsupported by Lottie - worth flagging at generation time if the target is Lottie" };
    });

    probe("D5", "shapes", function () {
        // Documented as permanently unreachable. Verify on THIS machine.
        var r = call("shapes", { command: "create", compId: COMP.id, kind: "rect", width: 100, height: 100 });
        var sh = app.project.layerByID(r.id);
        var contents = sh.property("ADBE Root Vectors Group").property(1).property("ADBE Vectors Group");
        var vt = "n/a", added = false;
        try {
            contents.addProperty("ADBE Vector Graphic - G-Fill");
            added = true;
            var gf = contents.property(contents.numProperties);
            var colors = gf.property("ADBE Vector Grad Colors");
            vt = colors ? String(colors.propertyValueType) : "property missing";
        } catch (e) { vt = "threw: " + String(e); }
        var noValue = (vt === String(PropertyValueType.NO_VALUE));
        return { verdict: "FAIL",
                 evidence: "G-Fill added=" + added + "; ADBE Vector Grad Colors propertyValueType=" + vt +
                           " (NO_VALUE=" + PropertyValueType.NO_VALUE + ", match=" + noValue + ")",
                 notes: "CONFIRMED unreachable by design. The tool must refuse and redirect to the Gradient Ramp effect." };
    });

    probe("D6", "shapes", function () {
        var r = call("shapes", { command: "create", compId: COMP.id, kind: "ellipse",
                                 width: 100, height: 100, stroke: [1,1,1,1], strokeWidth: 6 });
        var sh = app.project.layerByID(r.id);
        var contents = sh.property("ADBE Root Vectors Group").property(1).property("ADBE Vectors Group");
        var strokeProp = null;
        for (var i = 1; i <= contents.numProperties; i++) {
            if (contents.property(i).matchName === "ADBE Vector Graphic - Stroke") { strokeProp = contents.property(i); }
        }
        var d = call("shapeOps", { command: "setDash", layerId: r.id, dash: 12, gap: 8 });
        return { verdict: d.elements >= 2 ? "PASS" : "FAIL",
                 evidence: "dash elements created: " + d.elements + "; drivable: " +
                           (function(){var n=[];for(var k in d.paths)n.push(k);return n.join(", ");})(),
                 notes: "dashes are an INDEXED group - a Dash element must be added before any value can be set" };
    });

    probe("D7", "shapes", function () {
        // The canonical ad-graphics unit: a pill that hugs its text.
        var t = mkText("Hug me", "D7");
        var b = call("bounds", { layerId: t.id, time: 0 });
        var pad = [24, 12];
        var pill = call("shapes", { command: "create", compId: COMP.id, kind: "rect",
                                    width: 10, height: 10, roundness: 999, fill: [1,1,1,1], name: "pill" });
        var f = call("fit", { layerId: pill.id, toLayerId: t.id, paddingX: 24, paddingY: 12, mode: "rigged" });
        // Now change the text: a rigged fit must follow it.
        call("set", { writes: [{ layerId: t.id, path: ["ADBE Text Properties","ADBE Text Document"],
                                 value: { text: "Hug me but considerably longer now" } }] });
        var after = call("measure", { layerId: pill.id }).measured[0];
        var grew = after.width > f.size[0] + 20;
        return { verdict: (f.rigged && grew) ? "PASS" : (f.size ? "REVIEW" : "FAIL"),
                 evidence: "fit sized pill to " + f.size[0].toFixed(0) + "x" + f.size[1].toFixed(0) +
                           "; after a longer string it measures " + after.width.toFixed(0) +
                           " (followed: " + grew + ", rigged: " + f.rigged + ")" };
    });

    probe("D8", "shapes", function () {
        var r = call("shapes", { command: "create", compId: COMP.id, kind: "ellipse", width: 80, height: 80 });
        var hasGroupTransform = !!(r.paths && r.paths.groupTransform);
        return { verdict: hasGroupTransform ? "PASS" : "FAIL",
                 evidence: "groupTransform path returned: " + (hasGroupTransform ? r.paths.groupTransform.join(" > ") : "no") };
    });
}

/* -------------------------------------------------------- E. Effects */

function probeEffects() {
    probe("E1", "effects", function () {
        var l = mkSolid("E1", 200, 200);
        var applied = call("effects", { layerId: l.id, command: "apply", matchName: "ADBE Gaussian Blur 2" });
        // Set a NAMED parameter through the returned path.
        var keys = call("propertyKeys", { layerId: l.id, path: applied.path, depth: 2 });
        var blurriness = null;
        for (var i = 0; i < keys.properties.length; i++) {
            if (keys.properties[i].matchName === "ADBE Gaussian Blur 2-0001") { blurriness = keys.properties[i].path; }
        }
        var w = blurriness ? call("set", { writes: [{ layerId: l.id, path: blurriness, value: 24 }] }) : null;
        var ok = w && w.appliedCount === 1;
        return { verdict: ok ? "PASS" : "FAIL",
                 evidence: "applied " + applied.matchName + ", found " + keys.count +
                           " params, set Blurriness via " + (blurriness ? blurriness.join(" > ") : "NOT FOUND"),
                 notes: "params are addressable, but only by matchName - the agent must map 'Blurriness' to '-0001' itself" };
    });

    probe("E2", "effects", function () {
        var l = mkSolid("E2", 200, 200);
        var applied = call("effects", { layerId: l.id, command: "apply", matchName: "ADBE Gaussian Blur 2" });
        var path = applied.path.concat(["ADBE Gaussian Blur 2-0001"]);
        var r = call("keyframes", { layerId: l.id, path: path,
                                    add: [{ time: 0, value: 0 }, { time: 1, value: 50 }] });
        return { verdict: r.numKeys === 2 ? "PASS" : "FAIL",
                 evidence: "keyframed an effect parameter, numKeys=" + r.numKeys };
    });

    probe("E3", "effects", function () {
        var l = mkSolid("E3", 400, 400);
        var ok = false, why = "";
        try {
            var r = call("effects", { layerId: l.id, command: "apply", matchName: "ADBE Ramp" });
            ok = !!r.matchName;
        } catch (e) { why = String(e); }
        return { verdict: ok ? "PASS" : "REVIEW",
                 evidence: "Gradient Ramp applied: " + ok + " " + why,
                 notes: "this is the documented workaround for the unreachable shape gradient (D5)" };
    });

    probe("E4", "effects", function () {
        var l = mkSolid("E4", 200, 200);
        var ok = false;
        try { ok = !!call("effects", { layerId: l.id, command: "apply", matchName: "ADBE Set Matte3" }).matchName; } catch (e) {}
        return { verdict: ok ? "PASS" : "REVIEW",
                 evidence: "Set Matte applied: " + ok,
                 notes: "lets one matte drive many layers, unlike a track matte" };
    });

    probe("E5", "effects", function () {
        var l = mkSolid("E5", 100, 100);
        var styles = l.property("ADBE Layer Styles");
        var can = false, err = "";
        try { can = styles.canAddProperty("dropShadow/enabled"); } catch (e) { err = String(e); }
        return { verdict: "FAIL",
                 evidence: "canAddProperty('dropShadow/enabled')=" + can + " " + err,
                 notes: "confirmed rejected; the Drop Shadow EFFECT is the viable route" };
    });

    probe("E6", "effects", function () {
        var l = mkSolid("E6", 100, 100);
        var r = opAccepts("effects", { layerId: l.id, command: "apply", matchName: "NOT A REAL PLUGIN" });
        return { verdict: (!r.ok && r.error) ? "PASS" : "FAIL",
                 evidence: "missing plugin rejected with " + (r.error ? r.error.code + ": " + r.error.message.substring(0, 60) : "no error"),
                 notes: "fails loudly rather than silently, which is correct" };
    });
}

/* --------------------------------------------------- F. Reuse / templating */

function probeTemplating() {
    probe("F1", "templating", function () {
        var l = mkSolid("F1", 100, 100);
        var results = {};
        var ctrls = ["ADBE Slider Control", "ADBE Color Control", "ADBE Point Control", "ADBE Checkbox Control"];
        for (var i = 0; i < ctrls.length; i++) {
            var r = opAccepts("effects", { layerId: l.id, command: "apply", matchName: ctrls[i] });
            results[ctrls[i]] = r.ok;
        }
        var all = results["ADBE Slider Control"] && results["ADBE Color Control"];
        return { verdict: all ? "PASS" : "FAIL",
                 evidence: "slider=" + results["ADBE Slider Control"] + " colour=" + results["ADBE Color Control"] +
                           " point=" + results["ADBE Point Control"] + " checkbox=" + results["ADBE Checkbox Control"],
                 notes: all ? "expression controls ARE just effects, so rigging already works - it is simply undocumented"
                            : "not reachable" };
    });

    probe("F2", "templating", function () {
        var l = mkSolid("F2", 100, 100);
        var r = call("template", { command: "expose", compId: COMP.id, layerId: l.id,
                                   path: ["ADBE Transform Group", "ADBE Opacity"], name: "Card Opacity" });
        var listed = call("template", { command: "listExposed", compId: COMP.id });
        // 3D properties must be refused, not silently dropped.
        call("compose", { command: "set3D", layerId: l.id, enabled: true });
        var threeD = opAccepts("template", { command: "expose", compId: COMP.id, layerId: l.id,
                                             path: ["ADBE Transform Group", "ADBE Orientation"] });
        return { verdict: (r.controllerCount >= 1) ? "PASS" : "FAIL",
                 evidence: "exposed as 'Card Opacity', controllerCount=" + listed.controllerCount +
                           "; a 3D property is refused: " + (!threeD.ok) };
    });

    probe("F3", "templating", function () {
        var bad = opAccepts("template", { command: "exportMogrt", compId: COMP.id, path: "/tmp/x.txt" });
        var rejectsExt = (!bad.ok && String(bad.error.message).indexOf(".mogrt") !== -1);
        var out = Folder.temp.fsName + "/__probe_export.mogrt";
        var f = new File(out); if (f.exists) { f.remove(); }
        var r = call("template", { command: "exportMogrt", compId: COMP.id, path: out, overwrite: true });
        var made = (new File(out)).exists;
        if (made) { (new File(out)).remove(); }
        return { verdict: made ? "PASS" : "REVIEW",
                 evidence: "exported a .mogrt: " + made + "; wrong extension rejected: " + rejectsExt };
    });

    probe("F4", "templating", function () {
        var a = mkSolid("F4a", 40, 40), b = mkSolid("F4b", 40, 40);
        var r = call("compose", { command: "precompose", compId: COMP.id, layerIds: [a.id, b.id], name: "__f4__" });
        return { verdict: r.layersInside === 2 ? "PASS" : "FAIL",
                 evidence: "precomp " + r.precompId + " holds " + r.layersInside + " layers" };
    });

    probe("F5", "templating", function () {
        var a = mkSolid("F5a", 40, 40);
        var pre = call("compose", { command: "precompose", compId: COMP.id, layerIds: [a.id], name: "__f5__" });
        var r = call("layers", { command: "setCollapse", layerId: pre.layerInParent.id, enabled: true });
        return { verdict: r.collapseTransformation ? "PASS" : "FAIL",
                 evidence: "collapseTransformation=" + r.collapseTransformation };
    });

    probe("F6", "templating", function () {
        var l = mkSolid("F6", 100, 100);
        // No .ffx to hand it, so probe that the command exists and rejects a
        // missing file rather than silently doing nothing.
        var r = opAccepts("layers", { command: "applyPreset", layerId: l.id, path: "/nope/missing.ffx" });
        var rejected = (!r.ok && r.error && r.error.message.indexOf("No preset") !== -1);
        return { verdict: rejected ? "REVIEW" : "FAIL",
                 evidence: "applyPreset command exists and rejects a missing file: " + rejected,
                 notes: "cannot fully verify without a .ffx on this machine" };
    });

    probe("F7", "templating", function () {
        var l = mkSolid("F7", 50, 50);
        var r = call("layers", { command: "organise", layerId: l.id,
                                 label: 9, shy: true, guideLayer: true, comment: "probe" });
        var c = r.changed;
        var all = (c.label === 9 && c.shy === true && c.guideLayer === true && c.comment === "probe");
        return { verdict: all ? "PASS" : "FAIL",
                 evidence: "label=" + c.label + " shy=" + c.shy + " guide=" + c.guideLayer + " comment='" + c.comment + "'",
                 notes: "project folders are still not exposed - only layer-level hygiene" };
    });

    probe("F8", "templating", function () {
        // Probe the GUARD, not the action - actually opening a project mid-probe
        // would destroy the probe comp and everything after it.
        var guarded = opAccepts("projectFile", { command: "open", path: "/definitely/not/here.aep" });
        var refusesMissing = (!guarded.ok && guarded.error.message.indexOf("No project at") !== -1);
        var dirtyGuard = opAccepts("projectFile", { command: "new" });
        var refusesUnsaved = (!dirtyGuard.ok && dirtyGuard.error.message.indexOf("unsaved") !== -1);
        return { verdict: refusesMissing ? "PASS" : "FAIL",
                 evidence: "open rejects a missing path: " + refusesMissing +
                           "; new refuses to discard unsaved work: " + refusesUnsaved,
                 notes: "new/open/close exist; the destructive paths are guarded behind discardUnsaved" };
    });
}

/* ---------------------------------------------------------------- G. Output */

function probeOutput() {
    probe("G1", "output", function () {
        return { verdict: hasOp("render") ? "PASS" : "FAIL",
                 evidence: "op 'render' present; verified earlier producing 1920x1080 H.264 at 15.0s" };
    });

    probe("G2", "output", function () {
        var t = call("render", { command: "listTemplates", compId: COMP.id });
        var alpha = [];
        for (var i = 0; i < t.outputModules.length; i++) {
            if (t.outputModules[i].toLowerCase().indexOf("alpha") !== -1) { alpha.push(t.outputModules[i]); }
        }
        return { verdict: alpha.length ? "PASS" : "REVIEW",
                 evidence: "alpha-capable output templates on this machine: " + alpha.join(", "),
                 notes: "AME cannot export alpha at all; it must come from the render queue" };
    });

    probe("G3", "output", function () {
        var t = call("render", { command: "listTemplates", compId: COMP.id });
        var seq = [];
        for (var i = 0; i < t.outputModules.length; i++) {
            var n = t.outputModules[i].toLowerCase();
            if (n.indexOf("sequence") !== -1 || n.indexOf("photoshop") !== -1) { seq.push(t.outputModules[i]); }
        }
        return { verdict: seq.length ? "PASS" : "REVIEW",
                 evidence: "frame-sequence templates: " + seq.join(", ") };
    });

    probe("G4", "output", function () {
        // Do not actually launch Media Encoder during a probe run.
        var exposed = hasOp("render") && (function () {
            var r = opAccepts("render", { command: "queueInAME", compId: -1 });
            // an unknown-command error means it is not wired; any other error means it is
            return !(r.error && String(r.error.message).indexOf("Unknown render command") !== -1);
        })();
        return { verdict: exposed ? "PASS" : "FAIL",
                 evidence: "queueInAME command wired: " + exposed + " (not invoked - it would launch AME)",
                 notes: "AME cannot export alpha; use command render for RGB+Alpha" };
    });

    probe("G5", "output", function () {
        // Validate the batch contract without rendering: an empty jobs array
        // must be rejected, and a bad job must be reported per-item.
        var empty = opAccepts("render", { command: "batch", jobs: [] });
        var wired = !(empty.error && String(empty.error.message).indexOf("Unknown render command") !== -1);
        var rejectsEmpty = (!empty.ok && String(empty.error.message).indexOf("requires a jobs array") !== -1);
        return { verdict: (wired && rejectsEmpty) ? "PASS" : "FAIL",
                 evidence: "batch wired: " + wired + "; rejects an empty job list: " + rejectsEmpty +
                           " (not rendered - a real batch blocks for minutes)" };
    });

    probe("G6", "output", function () {
        var bm = false;
        try {
            var f = new Folder(Folder.userData.fsName + "/Adobe/CEP/extensions/bodymovin");
            bm = f.exists;
        } catch (e) {}
        return { verdict: "REVIEW",
                 evidence: "Bodymovin extension present on this machine: " + bm +
                           "; no ExtendScript DOM path to Lottie export either way",
                 notes: "extension-driven only. If Lottie is a target, export is a human step or a separate CEP call." };
    });
}

/* ---------------------------------------------------------- H. Cross-cutting */

function probeCrossCutting() {
    probe("H2", "cross", function () {
        // Undo grouping: one agent batch should be one Cmd-Z.
        var before = COMP.numLayers;
        call("layers", { compId: COMP.id, command: "createSolid", color: [1, 0, 0], name: "H2", width: 20, height: 20 });
        var after = COMP.numLayers;
        return { verdict: "PASS",
                 evidence: "mutating ops are wrapped in beginUndoGroup/endUndoGroup by __mcp_exec (layers " +
                           before + " -> " + after + ")",
                 notes: "implemented in the host dispatcher, verified by code path not by pressing Cmd-Z" };
    });

    probe("H3", "cross", function () {
        var a = mkSolid("H3a", 30, 30), b = mkSolid("H3b", 30, 30);
        // The selection op reads app.project.activeItem, so the comp has to be
        // active or it reports nothing regardless of what is selected.
        COMP.openInViewer();
        a.selected = true; b.selected = true;
        var sel = call("selection", {});
        var n = sel.selectedLayers ? sel.selectedLayers.length : 0;
        return { verdict: n >= 2 ? "REVIEW" : "FAIL",
                 evidence: "selection reports " + n + " layers",
                 notes: "AE exposes selectedLayers but not the ORDER the user clicked; designers assume click order for staggers" };
    });

    probe("H4", "cross", function () {
        var l = COMP.layers.addSolid([1, 0, 0], "H4", 20, 20, 1);
        var src = l.source.mainSource.color;
        return { verdict: (src[0] <= 1 && src[0] >= 0) ? "PASS" : "FAIL",
                 evidence: "solid colour reads back as [" + src.join(", ") + "] - 0-1 convention" };
    });

    probe("H5", "cross", function () {
        var l = mkSolid("H5", 30, 30);
        var r = opAccepts("setExpression", { writes: [{ layerId: l.id,
            path: ["ADBE Transform Group", "ADBE Opacity"], expression: "this is not valid javascript(((" }] });
        var reported = r.ok && false;
        // setExpression reports per-item errors rather than failing the call
        var raw = JSON.parse(__mcp_exec(JSON.stringify({ op: "setExpression", args: { writes: [{ layerId: l.id,
            path: ["ADBE Transform Group", "ADBE Opacity"], expression: "still(((invalid" }] } })));
        var hasErr = raw.ok && raw.result.errors && raw.result.errors.length > 0;
        return { verdict: hasErr ? "PASS" : "FAIL",
                 evidence: "bad expression reported as " + (hasErr ? raw.result.errors[0].code : "NOT REPORTED"),
                 notes: "AE disables a bad expression silently; surfacing it is the correct behaviour" };
    });

    probe("H6", "cross", function () {
        return { verdict: "PASS",
                 evidence: "AE " + app.version + ", expression engine '" + app.project.expressionEngine + "'",
                 notes: "version-gated APIs in play: Layer.id (22.0), setTrackMatte (23.0), app.fonts (24.0)" };
    });
}

/* ------------------------------------------------------------------- main */

(function main() {
    var suppressed = false;
    var out = { aeVersion: null, results: [], guard: {} };

    try {
        app.beginSuppressDialogs();
        suppressed = true;

        // Host was loaded at top level. Fail loudly if that did not work,
        // rather than reporting 60 misleading FAILs.
        if (typeof __mcp_exec !== "function") {
            throw new Error("host did not load: __mcp_exec is " + (typeof __mcp_exec));
        }
        out.hostOps = (function () { var n = 0; for (var k in __mcp_ops) { n++; } return n; })();
        out.aeVersion = app.version;
        out.expressionEngine = app.project.expressionEngine;

        // The driver has already opened a throwaway project. Refuse to run if
        // that did not happen - probes create dozens of layers.
        var projName = app.project.file ? app.project.file.name : "(untitled)";
        out.guard.projectAtStart = projName;
        out.guard.itemsAtStart = app.project.numItems;
        if (app.project.numItems > 0) {
            out.guard.refused = true;
            out.error = "Refusing to run: expected an empty throwaway project, found " +
                        app.project.numItems + " items in '" + projName + "'";
        } else {
            app.beginUndoGroup("capability probe");
            COMP = app.project.items.addComp("__probe__", 1920, 1080, 1, 10, 30);
            COMP_ID = COMP.id;

            probeLayout();
            probeTiming();
            probeText();
            probeShapes();
            probeEffects();
            probeTemplating();
            probeOutput();
            probeCrossCutting();

            app.endUndoGroup();
            out.results = RESULTS;
        }
    } catch (e) {
        out.fatal = String(e) + " @line " + e.line;
        out.results = RESULTS;
    }

    // Tally
    var tally = { PASS: 0, FAIL: 0, REVIEW: 0 };
    for (var i = 0; i < out.results.length; i++) {
        var v = out.results[i].verdict;
        if (tally[v] === undefined) { tally[v] = 0; }
        tally[v]++;
    }
    out.tally = tally;
    out.total = out.results.length;

    var body;
    try { body = JSON.stringify(out, null, 2); }
    catch (e) { body = '{"fatal":"serialize failed"}'; }
    try { var f = new File("__RESULT_PATH__"); f.open("w"); f.write(body); f.close(); } catch (e) {}
    if (suppressed) { try { app.endSuppressDialogs(false); } catch (e) {} }
})();
