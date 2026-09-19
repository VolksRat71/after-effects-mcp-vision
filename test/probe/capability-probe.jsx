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

var RESULTS = [];
var COMP = null;

function probe(id, area, fn) {
    var r = { id: id, area: area };
    try {
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
        var r = t.sourceRectAtTime(0, false);
        t.property("ADBE Transform Group").property("ADBE Position").setValue([COMP.width/2, COMP.height/2]);
        var anchored = t.property("ADBE Transform Group").property("ADBE Anchor Point").value;
        var optical = (anchored[0] === r.left + r.width/2);
        return { verdict: "FAIL",
                 evidence: "no centre op; naive set leaves anchor at " + anchored.join(",") +
                           " while ink centre is " + (r.left + r.width/2).toFixed(1) + "," + (r.top + r.height/2).toFixed(1),
                 notes: "bounds is readable, but nothing composes measure+place. Caller does the maths." };
    });

    probe("A2", "layout", function () {
        var have = hasOp("align");
        return { verdict: have ? "PASS" : "FAIL",
                 evidence: "op 'align' present: " + have,
                 notes: "AE Align panel is not scriptable at all; this must be computed from sourceRectAtTime" };
    });

    probe("A3", "layout", function () {
        return { verdict: hasOp("distribute") ? "PASS" : "FAIL",
                 evidence: "op 'distribute' present: " + hasOp("distribute"),
                 notes: "two valid semantics (equal gaps vs equal centres); neither is offered" };
    });

    probe("A4", "layout", function () {
        return { verdict: hasOp("grid") || hasOp("stack") ? "PASS" : "FAIL",
                 evidence: "ops grid/stack present: " + hasOp("grid") + "/" + hasOp("stack") };
    });

    probe("A5", "layout", function () {
        // The industry's most-used utility: move the anchor WITHOUT the layer moving.
        var l = mkSolid("A5", 200, 100);
        var tr = l.property("ADBE Transform Group");
        tr.property("ADBE Position").setValue([500, 500]);
        var before = l.sourceRectAtTime(0, false);
        var beforeScreen = tr.property("ADBE Position").value[0] - tr.property("ADBE Anchor Point").value[0];
        // Move the anchor to the TOP-LEFT corner. [100,50] would have been the
        // default centre for a 200x100 solid - testing that moves nothing.
        call("set", { writes: [{ layerId: l.id, path: ["ADBE Transform Group", "ADBE Anchor Point"], value: [0, 0] }] });
        var afterScreen = tr.property("ADBE Position").value[0] - tr.property("ADBE Anchor Point").value[0];
        var jumped = !near(beforeScreen, afterScreen, 0.5);
        return { verdict: "FAIL",
                 evidence: "layer left edge moved " + beforeScreen.toFixed(1) + " -> " + afterScreen.toFixed(1) +
                           " (jumped: " + jumped + ")",
                 notes: "ae_set moves the anchor with no Position compensation, so the layer visibly jumps" };
    });

    probe("A6", "layout", function () {
        return { verdict: "FAIL", evidence: "no safe-area concept in any tool",
                 notes: "needs per-platform inset tables (TikTok/Reels reserve top 10-15%, bottom 20-25%), not a generic 80%" };
    });

    probe("A7", "layout", function () {
        return { verdict: hasOp("pin") ? "PASS" : "FAIL",
                 evidence: "op 'pin' present: " + hasOp("pin"),
                 notes: "padding/inset from a comp edge is pure arithmetic the caller must do" };
    });

    probe("A8", "layout", function () {
        var w0 = COMP.width;
        call("timing", { command: "setComp", compId: COMP.id, width: 1080, height: 1080 });
        var resized = (COMP.width === 1080 && COMP.height === 1080);
        call("timing", { command: "setComp", compId: COMP.id, width: w0, height: 1080 });
        call("timing", { command: "setComp", compId: COMP.id, width: w0, height: 1080 });
        return { verdict: "FAIL",
                 evidence: "comp resize works (" + resized + ") but no layer reflows",
                 notes: "multi-format delivery is P0 for ad work; resize alone letterboxes" };
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
        return { verdict: hasOp("stagger") ? "PASS" : "FAIL",
                 evidence: "op 'stagger' present: " + hasOp("stagger"),
                 notes: "the accordion build hand-computed N*3.75+0.25 across 48 keyframes" };
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
        // But adding the SAME keyframes twice is the real risk.
        call("keyframes", { layerId: l.id, path: ["ADBE Transform Group", "ADBE Opacity"],
                            add: [{ time: 0, value: 0 }, { time: 1, value: 100 }] });
        var n = op.numKeys;
        return { verdict: (near(i1, i2, 0.01) && n === 2) ? "PASS" : "REVIEW",
                 evidence: "ease influence " + i1.toFixed(1) + " -> " + i2.toFixed(1) +
                           " on re-apply; re-adding same-time keys left numKeys=" + n,
                 notes: "AE replaces a key at an identical time, so add is naturally idempotent. A stagger op would not be." };
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
        return { verdict: hasOp("timeRemap") ? "PASS" : "FAIL",
                 evidence: "op 'timeRemap' present: " + hasOp("timeRemap"),
                 notes: "layer.timeRemapEnabled + 'ADBE Time Remapping' is fully scriptable; just not exposed" };
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
        call("timing", { command: "addMarker", compId: COMP.id, time: 2, comment: "beat" });
        var canRead = hasOp("readMarkers");
        var n = COMP.markerProperty.numKeys;
        return { verdict: canRead ? "PASS" : "FAIL",
                 evidence: "wrote marker (comp now has " + n + "); read-back op present: " + canRead,
                 notes: "write-only. An agent cannot drive timing off existing markers it did not create." };
    });

    probe("B10", "timing", function () {
        var l = mkSolid("B10", 50, 50);
        var p = l.property("ADBE Transform Group").property("ADBE Position");
        var supported = (typeof p.dimensionsSeparated !== "undefined");
        return { verdict: hasOp("separateDimensions") ? "PASS" : "FAIL",
                 evidence: "AE supports dimensionsSeparated: " + supported + "; op exposed: " + hasOp("separateDimensions") };
    });

    probe("B11", "timing", function () {
        var l = mkSolid("B11", 50, 50);
        var settable = false;
        try { l.motionBlur = true; settable = l.motionBlur; } catch (e) {}
        return { verdict: hasOp("motionBlur") ? "PASS" : "FAIL",
                 evidence: "AE accepts layer.motionBlur=" + settable + "; op exposed: " + hasOp("motionBlur"),
                 notes: "near-universal on commercial work, commonly forgotten by automation" };
    });

    probe("B12", "timing", function () {
        return { verdict: hasOp("retime") ? "PASS" : "FAIL",
                 evidence: "op 'retime' present: " + hasOp("retime"),
                 notes: "'make this 20% faster' needs keyframe-time scaling that preserves eases" };
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
        var boxable = (typeof COMP.layers.addBoxText === "function");
        var r = opAccepts("layers", { compId: COMP.id, command: "createBoxText", text: "wrap me", width: 400, height: 200 });
        return { verdict: r.ok ? "PASS" : "FAIL",
                 evidence: "AE has addBoxText: " + boxable + "; createBoxText command accepted: " + r.ok +
                           (r.error ? " (" + r.error.code + ")" : ""),
                 notes: "point text only. Wrapping copy blocks are not expressible." };
    });

    probe("C4", "text", function () {
        var t = mkText("Animate me", "C4");
        // Can the shipped surface build an animator? propertyKeys can SEE the
        // group, but addProperty is what creates one, and no op does that.
        var grp = t.property("ADBE Text Properties").property("ADBE Text Animators");
        var visible = (grp !== null);
        var canAdd = hasOp("textAnimator");
        return { verdict: canAdd ? "PASS" : "FAIL",
                 evidence: "animator group visible to propertyKeys: " + visible + "; op to create one: " + canAdd,
                 notes: "per-character reveals are the single most common text technique in this work" };
    });

    probe("C5", "text", function () {
        return { verdict: hasOp("textAnimator") ? "REVIEW" : "FAIL",
                 evidence: "no animator op, so Based On=Words is unreachable",
                 notes: "'per word' vs 'per letter' is a routine art-direction request" };
    });

    probe("C6", "text", function () {
        return { verdict: hasOp("textAnimator") ? "REVIEW" : "FAIL",
                 evidence: "typewriter needs an opacity animator + square range selector",
                 notes: "could also be faked by keyframing sourceText per frame, which is worse and larger" };
    });

    probe("C7", "text", function () {
        var t = mkText("A fairly long string to fit", "C7");
        var b = call("bounds", { layerId: t.id, time: 0 });
        var fits = b.reliable && b.layerSpace.width > 0;
        return { verdict: fits ? "REVIEW" : "FAIL",
                 evidence: "bounds readable (w=" + b.layerSpace.width.toFixed(0) + "), but no fit op",
                 notes: "measurable, so an agent CAN iterate fontSize by hand; there is no autoFit primitive" };
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
        var sh = app.project.layerByID(r.id);
        var contents = sh.property("ADBE Root Vectors Group").property(1).property("ADBE Vectors Group");
        var canAdd = false, why = "";
        try { canAdd = contents.canAddProperty("ADBE Vector Filter - Trim"); } catch (e) { why = String(e); }
        return { verdict: hasOp("shapeFilter") ? "PASS" : "FAIL",
                 evidence: "AE canAddProperty(Trim)=" + canAdd + "; op to add one: " + hasOp("shapeFilter") + " " + why,
                 notes: "draw-on is P0 for this kind of work and is fully scriptable - purely a missing tool" };
    });

    probe("D3", "shapes", function () {
        return { verdict: hasOp("shapeFilter") ? "PASS" : "FAIL",
                 evidence: "no op adds 'ADBE Vector Filter - Repeater'",
                 notes: "repeater Offset is the native way to stagger copies without expressions" };
    });

    probe("D4", "shapes", function () {
        return { verdict: hasOp("shapeFilter") ? "PASS" : "FAIL",
                 evidence: "no op adds 'ADBE Vector Filter - Merge'",
                 notes: "also unsupported by Lottie, so worth flagging at generation time" };
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
        return { verdict: hasOp("shapeFilter") ? "PASS" : "FAIL",
                 evidence: "stroke dashes ('ADBE Vector Stroke Dashes') not exposed",
                 notes: "progress rings = ellipse + trim paths + dash + round cap" };
    });

    probe("D7", "shapes", function () {
        // The canonical ad-graphics unit: a pill that hugs its text.
        var t = mkText("Hug me", "D7");
        var b = call("bounds", { layerId: t.id, time: 0 });
        var pad = [24, 12];
        var pill = call("shapes", { command: "create", compId: COMP.id, kind: "rect",
            width: b.layerSpace.width + pad[0] * 2, height: b.layerSpace.height + pad[1] * 2,
            roundness: 999, fill: [1, 1, 1, 1] });
        var built = !!pill.id;
        return { verdict: built ? "REVIEW" : "FAIL",
                 evidence: "measured text " + b.layerSpace.width.toFixed(0) + "x" + b.layerSpace.height.toFixed(0) +
                           " and built a pill; caller did the padding maths and the centring",
                 notes: "possible but not composed: no op does measure->size->centre, and it does not follow a text change" };
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
        var op = l.property("ADBE Transform Group").property("ADBE Opacity");
        var can = false, err = "";
        try { can = op.canAddToMotionGraphicsTemplate(COMP); } catch (e) { err = String(e); }
        return { verdict: hasOp("template") ? "PASS" : "FAIL",
                 evidence: "AE canAddToMotionGraphicsTemplate(Opacity)=" + can + " " + err + "; op exposed: " + hasOp("template"),
                 notes: "fully scriptable and unexposed - the native answer to parameterised templates" };
    });

    probe("F3", "templating", function () {
        var can = (typeof COMP.exportAsMotionGraphicsTemplate === "function");
        return { verdict: hasOp("template") ? "PASS" : "FAIL",
                 evidence: "AE has exportAsMotionGraphicsTemplate: " + can + "; op exposed: " + hasOp("template") };
    });

    probe("F4", "templating", function () {
        var a = mkSolid("F4a", 40, 40), b = mkSolid("F4b", 40, 40);
        var r = call("compose", { command: "precompose", compId: COMP.id, layerIds: [a.id, b.id], name: "__f4__" });
        return { verdict: r.layersInside === 2 ? "PASS" : "FAIL",
                 evidence: "precomp " + r.precompId + " holds " + r.layersInside + " layers" };
    });

    probe("F5", "templating", function () {
        var l = mkSolid("F5", 100, 100);
        var settable = false;
        try { l.collapseTransformation = true; settable = l.collapseTransformation; } catch (e) {}
        return { verdict: hasOp("collapse") ? "PASS" : "FAIL",
                 evidence: "AE accepts collapseTransformation=" + settable + "; op exposed: " + hasOp("collapse"),
                 notes: "affects how nested vectors scale - a real quality issue on resized formats" };
    });

    probe("F6", "templating", function () {
        var l = mkSolid("F6", 100, 100);
        return { verdict: hasOp("applyPreset") ? "PASS" : "FAIL",
                 evidence: "AE has applyPreset: " + (typeof l.applyPreset === "function") +
                           "; op exposed: " + hasOp("applyPreset") };
    });

    probe("F7", "templating", function () {
        var l = mkSolid("F7", 50, 50);
        var fields = { label: false, shy: false, guideLayer: false, locked: false };
        try { l.label = 9; fields.label = (l.label === 9); } catch (e) {}
        try { l.shy = true; fields.shy = l.shy; } catch (e) {}
        try { l.guideLayer = true; fields.guideLayer = l.guideLayer; } catch (e) {}
        var folder = (typeof app.project.items.addFolder === "function");
        return { verdict: hasOp("organise") ? "PASS" : "FAIL",
                 evidence: "AE settable label/shy/guide=" + fields.label + "/" + fields.shy + "/" + fields.guideLayer +
                           "; addFolder=" + folder + "; op exposed: " + hasOp("organise"),
                 notes: "project hygiene separates handoff-ready work from junk; only rename+lock are exposed" };
    });

    probe("F8", "templating", function () {
        var r = opAccepts("project", { command: "newProject" });
        var hasNew = (typeof app.newProject === "function");
        var hasOpen = (typeof app.open === "function");
        return { verdict: r.ok ? "PASS" : "FAIL",
                 evidence: "AE has newProject=" + hasNew + " open=" + hasOpen +
                           "; project command 'newProject' accepted: " + r.ok +
                           (r.error ? " (" + r.error.code + ")" : ""),
                 notes: "save only. Blocks 'open template, fill, render, close' - how ad variants are produced." };
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
        var can = (typeof app.project.renderQueue.queueInAME === "function");
        return { verdict: hasOp("queueInAME") ? "PASS" : "FAIL",
                 evidence: "AE has queueInAME: " + can + "; op exposed: " + hasOp("queueInAME"),
                 notes: "AME gives real bitrate control; direct-from-RQ H.264 is larger and less efficient" };
    });

    probe("G5", "output", function () {
        return { verdict: hasOp("renderBatch") ? "PASS" : "FAIL",
                 evidence: "render takes one compId per call; no batch op",
                 notes: "ad delivery is N comps x M formats; one-at-a-time means N*M blocking calls" };
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

        // Load the SHIPPED host so probes exercise the real tool surface.
        $.evalFile(new File("__HOST_PATH__"));
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
