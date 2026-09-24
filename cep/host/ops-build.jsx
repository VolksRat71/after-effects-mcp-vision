/*
 * Build ops: timing, measurement, shapes, composition structure, rendering.
 *
 * Every API here was probed against AE 26.0x67 before being written down. The
 * two rules that bit during probing are encoded below rather than left as
 * comments in a chat log:
 *   - setting startTime SHIFTS inPoint/outPoint, so it must be applied first
 *   - addProperty() on a vector group invalidates references you are still
 *     holding to its siblings, so every reference is re-fetched after each add
 */

var __MCP_BLEND = {
    normal: BlendingMode.NORMAL, multiply: BlendingMode.MULTIPLY, screen: BlendingMode.SCREEN,
    overlay: BlendingMode.OVERLAY, add: BlendingMode.ADD, darken: BlendingMode.DARKEN,
    lighten: BlendingMode.LIGHTEN, difference: BlendingMode.DIFFERENCE,
    softLight: BlendingMode.SOFT_LIGHT, hardLight: BlendingMode.HARD_LIGHT,
    colorDodge: BlendingMode.COLOR_DODGE, colorBurn: BlendingMode.COLOR_BURN,
    hue: BlendingMode.HUE, saturation: BlendingMode.SATURATION,
    color: BlendingMode.COLOR, luminosity: BlendingMode.LUMINOSITY
};

var __MCP_MATTE = {
    alpha: TrackMatteType.ALPHA, alphaInverted: TrackMatteType.ALPHA_INVERTED,
    luma: TrackMatteType.LUMA, lumaInverted: TrackMatteType.LUMA_INVERTED
};

function __mcp_colorArg(c, fallback) {
    if (!c) { return fallback; }
    var out = [];
    for (var i = 0; i < 4; i++) { out.push(i < c.length ? Number(c[i]) : 1); }
    return out;
}

var __mcp_buildOps = {

    /*
     * Layer and comp timing. startTime is applied BEFORE inPoint/outPoint:
     * probing showed that setting startTime after them shifts both by the
     * same delta, so the order a caller writes them in would otherwise change
     * the result.
     */
    timing: function (args) {
        var cmd = args.command;

        if (cmd === "setLayer") {
            var layer = __mcp_layerById(args.layerId);
            if (args.startTime !== undefined) { layer.startTime = Number(args.startTime); }
            if (args.stretch !== undefined) { layer.stretch = Number(args.stretch); }
            if (args.inPoint !== undefined) { layer.inPoint = Number(args.inPoint); }
            if (args.outPoint !== undefined) { layer.outPoint = Number(args.outPoint); }
            return { layerId: layer.id, startTime: layer.startTime, inPoint: layer.inPoint,
                     outPoint: layer.outPoint, stretch: layer.stretch };
        }
        if (cmd === "setComp") {
            var comp = __mcp_compById(args.compId);
            if (args.duration !== undefined) { comp.duration = Number(args.duration); }
            if (args.frameRate !== undefined) { comp.frameRate = Number(args.frameRate); }
            if (args.width !== undefined) { comp.width = Number(args.width); }
            if (args.height !== undefined) { comp.height = Number(args.height); }
            if (args.workAreaStart !== undefined) { comp.workAreaStart = Number(args.workAreaStart); }
            if (args.workAreaDuration !== undefined) { comp.workAreaDuration = Number(args.workAreaDuration); }
            return __mcp_itemSummary(comp);
        }
        if (cmd === "setTimeRemap") {
            var rl = __mcp_layerById(args.layerId);
            // Enabling auto-creates two keys and changes outPoint - surface both
            // so a caller is not surprised by a layer that suddenly got longer.
            var outBefore = rl.outPoint;
            rl.timeRemapEnabled = (args.enabled !== false);
            var tr = rl.timeRemapEnabled ? rl.property("ADBE Time Remapping") : null;
            return { layerId: rl.id, enabled: rl.timeRemapEnabled,
                     numKeys: tr ? tr.numKeys : 0,
                     outPoint: { before: outBefore, after: rl.outPoint },
                     path: ["ADBE Time Remapping"] };
        }
        if (cmd === "setMotionBlur") {
            var ml = __mcp_layerById(args.layerId);
            ml.motionBlur = (args.enabled !== false);
            var mc = ml.containingComp;
            // A layer's motion blur does nothing unless the comp switch is on.
            if (args.enableForComp !== false) { mc.motionBlur = true; }
            return { layerId: ml.id, layerMotionBlur: ml.motionBlur, compMotionBlur: mc.motionBlur };
        }
        if (cmd === "separateDimensions") {
            var sl = __mcp_layerById(args.layerId);
            var sp = __mcp_propByPath(sl, args.path || ["ADBE Transform Group", "ADBE Position"]);
            if (sp.dimensionsSeparated === undefined) { throw new Error("Property cannot separate dimensions"); }
            sp.dimensionsSeparated = (args.enabled !== false);
            return { layerId: sl.id, separated: sp.dimensionsSeparated };
        }
        if (cmd === "readMarkers") {
            var target, where;
            if (args.layerId !== undefined && args.layerId !== null) {
                target = __mcp_layerById(args.layerId).property("ADBE Marker"); where = "layer";
            } else {
                target = __mcp_resolveComp(args).markerProperty; where = "comp";
            }
            var out = [];
            for (var m = 1; m <= target.numKeys; m++) {
                var mv = target.keyValue(m);
                out.push({ index: m, time: target.keyTime(m), comment: mv.comment,
                           duration: mv.duration, protectedRegion: mv.protectedRegion,
                           label: mv.label, chapter: mv.chapter });
            }
            return { on: where, count: out.length, markers: out };
        }
        if (cmd === "addMarker") {
            var mv = new MarkerValue(String(args.comment || ""));
            if (args.duration !== undefined) { mv.duration = Number(args.duration); }
            // Responsive Design - Time: a protected region plays at original
            // speed when an editor retimes the template downstream.
            if (args.protectedRegion) { mv.protectedRegion = true; }
            var target, where;
            if (args.layerId !== undefined && args.layerId !== null) {
                target = __mcp_layerById(args.layerId).property("ADBE Marker"); where = "layer";
            } else {
                target = __mcp_resolveComp(args).markerProperty; where = "comp";
            }
            target.setValueAtTime(Number(args.time), mv);
            return { on: where, time: Number(args.time), comment: mv.comment, numMarkers: target.numKeys };
        }
        throw new Error("Unknown timing command: " + cmd);
    },

    /*
     * Rendered bounds in LAYER space. This is how an agent finds out how wide
     * its text actually came out instead of guessing - the first lower-third
     * built with this tool was clipped for exactly that reason. Text and
     * footage report accurately; a freshly-built shape layer can report zeros
     * until AE has evaluated it, so callers should treat 0x0 as "unknown".
     */
    bounds: function (args) {
        var layer = __mcp_layerById(args.layerId);
        var time = (args.time === undefined || args.time === null) ? layer.containingComp.time : Number(args.time);
        var b = layer.sourceRectAtTime(time, !!args.includeExtents);
        var pos = layer.property("ADBE Transform Group").property("ADBE Position").value;
        var anc = layer.property("ADBE Transform Group").property("ADBE Anchor Point").value;
        // Approximate comp-space box assuming no rotation/scale: useful for
        // "does this overlap that" without a full matrix walk.
        return {
            layerId: layer.id, time: time,
            layerSpace: { left: b.left, top: b.top, width: b.width, height: b.height },
            compSpaceApprox: {
                left: pos[0] - anc[0] + b.left, top: pos[1] - anc[1] + b.top,
                right: pos[0] - anc[0] + b.left + b.width, bottom: pos[1] - anc[1] + b.top + b.height
            },
            reliable: !(b.width === 0 && b.height === 0)
        };
    },

    /*
     * Shape layers with real geometry. Returns the matchName paths to every
     * animatable property it created, so ae_set / ae_animate can drive them
     * without the caller reconstructing the vector tree.
     *
     * References are RE-FETCHED after every addProperty. Holding a sibling
     * across an add throws "Object is invalid" - that is how the first attempt
     * at this failed.
     */
    shapes: function (args) {
        var cmd = args.command || "create";
        if (cmd !== "create") { throw new Error("Unknown shapes command: " + cmd); }

        var comp = __mcp_resolveComp(args);
        var kind = String(args.kind || "rect");
        var sh = comp.layers.addShape();
        if (args.name) { sh.name = String(args.name); }

        var root = sh.property("ADBE Root Vectors Group");
        root.addProperty("ADBE Vector Group");
        var grp = root.property(1);
        var groupName = String(args.name || "Shape");
        grp.name = groupName;
        var contents = grp.property("ADBE Vectors Group");

        var geomMatch, sizeMatch = null;
        if (kind === "rect") {
            contents.addProperty("ADBE Vector Shape - Rect");
            geomMatch = "ADBE Vector Shape - Rect"; sizeMatch = "ADBE Vector Rect Size";
            var rect = contents.property(1);
            rect.property("ADBE Vector Rect Size").setValue([Number(args.width || 200), Number(args.height || 200)]);
            if (args.roundness !== undefined) { rect.property("ADBE Vector Rect Roundness").setValue(Number(args.roundness)); }
        } else if (kind === "ellipse") {
            contents.addProperty("ADBE Vector Shape - Ellipse");
            geomMatch = "ADBE Vector Shape - Ellipse"; sizeMatch = "ADBE Vector Ellipse Size";
            contents.property(1).property("ADBE Vector Ellipse Size").setValue([Number(args.width || 200), Number(args.height || 200)]);
        } else if (kind === "polygon" || kind === "star") {
            contents.addProperty("ADBE Vector Shape - Star");
            geomMatch = "ADBE Vector Shape - Star";
            var star = contents.property(1);
            star.property("ADBE Vector Star Type").setValue(kind === "polygon" ? 2 : 1);
            star.property("ADBE Vector Star Points").setValue(Number(args.points || (kind === "polygon" ? 6 : 5)));
            star.property("ADBE Vector Star Outer Radius").setValue(Number(args.outerRadius || args.width / 2 || 100));
            if (kind === "star") { star.property("ADBE Vector Star Inner Radius").setValue(Number(args.innerRadius || 50)); }
        } else if (kind === "path") {
            if (!args.vertices || !args.vertices.length) { throw new Error("path requires vertices"); }
            contents.addProperty("ADBE Vector Shape - Group");
            geomMatch = "ADBE Vector Shape - Group";
            var s = new Shape();
            var v = [];
            for (var i = 0; i < args.vertices.length; i++) { v.push([Number(args.vertices[i][0]), Number(args.vertices[i][1])]); }
            s.vertices = v; s.closed = (args.closed !== false);
            contents.property(1).property("ADBE Vector Shape").setValue(s);
        } else {
            throw new Error("kind must be rect, ellipse, polygon, star or path");
        }

        var idx = 2;
        var fillIdx = null, strokeIdx = null;
        if (args.fill !== false) {
            contents.addProperty("ADBE Vector Graphic - Fill");
            contents.property(idx).property("ADBE Vector Fill Color").setValue(__mcp_colorArg(args.fill, [1, 1, 1, 1]));
            fillIdx = idx; idx++;
        }
        if (args.stroke) {
            contents.addProperty("ADBE Vector Graphic - Stroke");
            var st = contents.property(idx);
            st.property("ADBE Vector Stroke Color").setValue(__mcp_colorArg(args.stroke, [0, 0, 0, 1]));
            st.property("ADBE Vector Stroke Width").setValue(Number(args.strokeWidth || 2));
            strokeIdx = idx; idx++;
        }

        if (args.position) {
            sh.property("ADBE Transform Group").property("ADBE Position").setValue([Number(args.position[0]), Number(args.position[1])]);
        }

        var base = ["ADBE Root Vectors Group", groupName, "ADBE Vectors Group"];
        var paths = { groupTransform: ["ADBE Root Vectors Group", groupName, "ADBE Vector Transform Group"] };
        if (sizeMatch) { paths.size = base.concat([geomMatch, sizeMatch]); }
        if (kind === "rect") { paths.roundness = base.concat([geomMatch, "ADBE Vector Rect Roundness"]); }
        if (kind === "path") { paths.path = base.concat([geomMatch, "ADBE Vector Shape"]); }
        if (fillIdx) { paths.fillColor = base.concat(["ADBE Vector Graphic - Fill", "ADBE Vector Fill Color"]); }
        if (strokeIdx) {
            paths.strokeColor = base.concat(["ADBE Vector Graphic - Stroke", "ADBE Vector Stroke Color"]);
            paths.strokeWidth = base.concat(["ADBE Vector Graphic - Stroke", "ADBE Vector Stroke Width"]);
        }
        var summary = __mcp_layerSummary(sh);
        summary.kind = kind;
        summary.paths = paths;
        return summary;
    },

    /*
     * Shape operators - trim paths, repeater, merge, offset, round corners,
     * wiggle. These are what make a shape layer useful for motion graphics;
     * without them ae_shapes only produces static geometry.
     *
     * Same re-fetch discipline as shapes(): addProperty invalidates references
     * held to siblings.
     */
    shapeOps: function (args) {
        var cmd = args.command;
        var layer = __mcp_layerById(args.layerId);
        var root = layer.property("ADBE Root Vectors Group");
        if (!root) { throw new Error("Layer " + layer.id + " is not a shape layer"); }

        if (cmd === "list") {
            var found = [];
            for (var i = 1; i <= root.numProperties; i++) {
                found.push({ index: i, name: root.property(i).name, matchName: root.property(i).matchName });
            }
            return { layerId: layer.id, contents: found };
        }

        var KIND = {
            trim:    "ADBE Vector Filter - Trim",
            repeater:"ADBE Vector Filter - Repeater",
            merge:   "ADBE Vector Filter - Merge",
            offset:  "ADBE Vector Filter - Offset",
            round:   "ADBE Vector Filter - RC",
            wiggle:  "ADBE Vector Filter - Roughen",
            zigzag:  "ADBE Vector Filter - Zigzag",
            twist:   "ADBE Vector Filter - Twist"
        };

        if (cmd === "add") {
            var match = KIND[String(args.kind)];
            if (!match) {
                var ks = []; for (var k in KIND) { ks.push(k); }
                throw new Error("kind must be one of: " + ks.join(", "));
            }

            /*
             * Placement matters and is not cosmetic. A trim path must sit AFTER
             * the path it trims but is conventionally added at the group level;
             * a repeater placed above vs below a fill changes how gradients
             * repeat. Default to the shape group so behaviour matches the UI.
             */
            var target = root;
            var scope = "layer";
            if (args.groupIndex !== undefined && args.groupIndex !== null) {
                target = root.property(Number(args.groupIndex)).property("ADBE Vectors Group");
                scope = "group " + args.groupIndex;
            } else if (root.numProperties >= 1 && root.property(1).matchName === "ADBE Vector Group") {
                target = root.property(1).property("ADBE Vectors Group");
                scope = "group 1";
            }

            target.addProperty(match);
            var added = target.property(target.numProperties);
            if (args.name) { added.name = String(args.name); }

            // Apply any starting values the caller gave, by friendly name.
            var MAP = {
                start: "ADBE Vector Trim Start", end: "ADBE Vector Trim End",
                offset: (args.kind === "trim") ? "ADBE Vector Trim Offset" : "ADBE Vector Repeater Offset",
                copies: "ADBE Vector Repeater Copies",
                mode: (args.kind === "merge") ? "ADBE Vector Merge Type" : null,
                amount: "ADBE Vector Offset Amount",
                radius: "ADBE Vector RoundCorner Radius",
                size: "ADBE Vector Roughen Size"
            };
            var applied = [];
            for (var key in MAP) {
                if (args[key] === undefined || args[key] === null || !MAP[key]) { continue; }
                try { added.property(MAP[key]).setValue(Number(args[key])); applied.push(key); } catch (e) {}
            }

            // Hand back matchName paths so ae_set / ae_animate can drive it.
            var base = [];
            if (scope === "layer") { base = ["ADBE Root Vectors Group", added.name]; }
            else {
                base = ["ADBE Root Vectors Group", root.property(args.groupIndex || 1).name,
                        "ADBE Vectors Group", added.name];
            }
            var paths = {};
            for (var q = 1; q <= added.numProperties; q++) {
                var child = added.property(q);
                try { paths[child.name] = base.concat([child.matchName]); } catch (e) {}
            }
            return { layerId: layer.id, kind: args.kind, matchName: match, name: added.name,
                     placedIn: scope, appliedValues: applied, paths: paths };
        }

        if (cmd === "setDash") {
            /*
             * Stroke dashes are an INDEXED group: you cannot simply set a value,
             * you have to addProperty a Dash element first. That is why a naive
             * "set the dash" never works.
             */
            var sgroup = root.property(Number(args.groupIndex || 1)).property("ADBE Vectors Group");
            var stroke = null;
            for (var i = 1; i <= sgroup.numProperties; i++) {
                if (sgroup.property(i).matchName === "ADBE Vector Graphic - Stroke") { stroke = sgroup.property(i); }
            }
            if (!stroke) { throw new Error("Layer has no stroke to dash - create the shape with a stroke first"); }
            var dashes = stroke.property("ADBE Vector Stroke Dashes");
            if (!dashes) { throw new Error("Stroke has no Dashes group"); }

            /*
             * BOUNDED. `while (numProperties > 0) remove()` hangs forever if AE
             * refuses the removal - and because AE is single threaded and this
             * server lives inside it, an unbounded loop here freezes the entire
             * application, not just the call. Never loop on a mutation without
             * a ceiling and a progress check.
             */
            var guard = 0;
            while (dashes.numProperties > 0 && guard < 32) {
                var before = dashes.numProperties;
                try { dashes.property(1).remove(); } catch (e) { break; }
                if (dashes.numProperties >= before) { break; }  // made no progress
                guard++;
            }
            dashes.addProperty("ADBE Vector Stroke Dash 1");
            dashes.property(1).setValue(Number(args.dash || 10));
            if (args.gap !== undefined) {
                dashes.addProperty("ADBE Vector Stroke Gap 1");
                dashes.property(2).setValue(Number(args.gap));
            }
            if (args.offset !== undefined) {
                dashes.addProperty("ADBE Vector Stroke Offset");
                dashes.property(dashes.numProperties).setValue(Number(args.offset));
            }
            var dpaths = {};
            for (var q = 1; q <= dashes.numProperties; q++) {
                dpaths[dashes.property(q).name] = ["ADBE Root Vectors Group",
                    root.property(Number(args.groupIndex || 1)).name, "ADBE Vectors Group",
                    stroke.name, "ADBE Vector Stroke Dashes", dashes.property(q).matchName];
            }
            return { layerId: layer.id, elements: dashes.numProperties, paths: dpaths };
        }

        if (cmd === "remove") {
            var grp = (args.groupIndex !== undefined)
                ? root.property(Number(args.groupIndex)).property("ADBE Vectors Group") : root;
            var victim = grp.property(String(args.name));
            if (!victim) { throw new Error("No shape operator named " + args.name); }
            victim.remove();
            return { layerId: layer.id, removed: String(args.name) };
        }
        throw new Error("Unknown shapeOps command: " + cmd);
    },

    /* Composition structure: grouping, mattes, blend modes, parenting, 3D. */
    compose: function (args) {
        var cmd = args.command;

        if (cmd === "precompose") {
            var comp = __mcp_resolveComp(args);
            if (!args.layerIds || !args.layerIds.length) { throw new Error("precompose requires layerIds"); }
            var indices = [];
            for (var i = 0; i < args.layerIds.length; i++) {
                var l = __mcp_layerById(args.layerIds[i]);
                if (l.containingComp.id !== comp.id) { throw new Error("Layer " + l.id + " is not in comp " + comp.id); }
                indices.push(l.index);
            }
            var pre = comp.layers.precompose(indices, String(args.name || "Pre-comp"), args.moveAttributes !== false);
            var newLayer = null;
            for (var j = 1; j <= comp.numLayers; j++) {
                if (comp.layer(j).source && comp.layer(j).source.id === pre.id) { newLayer = comp.layer(j); }
            }
            return { precompId: pre.id, precompName: pre.name, layersInside: pre.numLayers,
                     layerInParent: newLayer ? __mcp_layerSummary(newLayer) : null };
        }
        if (cmd === "setTrackMatte") {
            var target = __mcp_layerById(args.layerId);
            if (args.matteLayerId === null || args.matteLayerId === undefined) {
                target.removeTrackMatte();
                return { layerId: target.id, hasTrackMatte: target.hasTrackMatte };
            }
            var matte = __mcp_layerById(args.matteLayerId);
            var type = __MCP_MATTE[args.type || "alpha"];
            if (!type) { throw new Error("type must be alpha, alphaInverted, luma or lumaInverted"); }
            // AE 23+ API: no adjacency requirement, unlike the legacy trackMatteType.
            target.setTrackMatte(matte, type);
            return { layerId: target.id, matteLayerId: matte.id, type: args.type || "alpha", hasTrackMatte: target.hasTrackMatte };
        }
        if (cmd === "setBlendMode") {
            var bl = __mcp_layerById(args.layerId);
            var mode = __MCP_BLEND[args.mode];
            if (!mode) { var keys = []; for (var k in __MCP_BLEND) { keys.push(k); } throw new Error("mode must be one of: " + keys.join(", ")); }
            bl.blendingMode = mode;
            return { layerId: bl.id, mode: args.mode };
        }
        if (cmd === "parent") {
            var child = __mcp_layerById(args.layerId);
            if (args.parentLayerId === null || args.parentLayerId === undefined) { child.parent = null; }
            else {
                var par = __mcp_layerById(args.parentLayerId);
                // setParentWithJump keeps the child where it is on screen; plain
                // assignment keeps its numbers and lets it jump.
                if (args.keepPosition === false) { child.parent = par; } else { child.setParentWithJump(par); }
            }
            return { layerId: child.id, parentId: child.parent ? child.parent.id : null };
        }
        if (cmd === "set3D") {
            var l3 = __mcp_layerById(args.layerId);
            l3.threeDLayer = (args.enabled !== false);
            return { layerId: l3.id, threeD: l3.threeDLayer };
        }
        if (cmd === "addCamera") {
            var cc = __mcp_resolveComp(args);
            var cam = cc.layers.addCamera(String(args.name || "Camera"), [cc.width / 2, cc.height / 2]);
            return __mcp_layerSummary(cam);
        }
        throw new Error("Unknown compose command: " + cmd);
    },

    /*
     * Text animators and range selectors - how essentially every per-character
     * and per-word reveal in this kind of work is built. Animating the range
     * selector's Start/End/Offset is the whole technique.
     */
    textAnimator: function (args) {
        var cmd = args.command;
        var layer = __mcp_layerById(args.layerId);
        var textProps = layer.property("ADBE Text Properties");
        if (!textProps) { throw new Error("Layer " + layer.id + " is not a text layer"); }
        var animators = textProps.property("ADBE Text Animators");

        if (cmd === "list") {
            var out = [];
            for (var i = 1; i <= animators.numProperties; i++) {
                var an = animators.property(i);
                var props = an.property("ADBE Text Animator Properties");
                var pnames = [];
                for (var q = 1; q <= props.numProperties; q++) { pnames.push(props.property(q).matchName); }
                out.push({ index: i, name: an.name, properties: pnames });
            }
            return { layerId: layer.id, count: out.length, animators: out };
        }

        if (cmd === "add") {
            var PROPS = {
                opacity:   "ADBE Text Opacity",
                position:  "ADBE Text Position 3D",
                scale:     "ADBE Text Scale 3D",
                rotation:  "ADBE Text Rotation",
                tracking:  "ADBE Text Tracking Amount",
                blur:      "ADBE Text Blur",
                fillColor: "ADBE Text Fill Color",
                charOffset:"ADBE Text Character Offset"
            };
            var wanted = args.properties || ["opacity"];

            animators.addProperty("ADBE Text Animator");
            var an = animators.property(animators.numProperties);
            if (args.name) { an.name = String(args.name); }
            // Re-fetch after every add: addProperty invalidates siblings.
            var propGroup = an.property("ADBE Text Animator Properties");

            var added = [], rejected = [];
            for (var w = 0; w < wanted.length; w++) {
                var mn = PROPS[wanted[w]];
                if (!mn) { rejected.push(wanted[w]); continue; }
                try { propGroup.addProperty(mn); added.push(wanted[w]); }
                catch (e) { rejected.push(wanted[w] + " (" + e + ")"); }
            }

            var selectors = an.property("ADBE Text Selectors");
            selectors.addProperty("ADBE Text Selector");
            var sel = selectors.property(selectors.numProperties);

            /*
             * Based On, Shape and Units live in a NESTED "Range Advanced" group,
             * not on the selector itself - setting them directly on the selector
             * silently does nothing, which is exactly what happened here until a
             * probe enumerated the tree. Verified matchNames on AE 26.0x67:
             *   ADBE Text Range Units / Range Type2 / Range Shape
             *
             * These are set WITHOUT a swallowing try/catch. A silently ignored
             * "per word" is worse than an error, because the reveal just looks
             * wrong and nothing reports why.
             */
            var adv = sel.property("ADBE Text Range Advanced");
            if (!adv) { throw new Error("Range selector has no Advanced group"); }

            var BASED = { characters: 1, charactersExcludingSpaces: 2, words: 3, lines: 4 };
            if (args.basedOn) {
                var b = BASED[String(args.basedOn)];
                if (!b) { throw new Error("basedOn must be characters, charactersExcludingSpaces, words or lines"); }
                adv.property("ADBE Text Range Type2").setValue(b);
            }
            // 1=Square, 2=Ramp Up, 3=Ramp Down, 4=Triangle, 5=Round, 6=Smooth
            var SHAPE = { square: 1, rampUp: 2, rampDown: 3, triangle: 4, round: 5, smooth: 6 };
            if (args.shape) {
                var sp = SHAPE[String(args.shape)];
                if (!sp) { throw new Error("shape must be square, rampUp, rampDown, triangle, round or smooth"); }
                adv.property("ADBE Text Range Shape").setValue(sp);
            }
            if (args.units === "index") { adv.property("ADBE Text Range Units").setValue(2); }

            var base = ["ADBE Text Properties", "ADBE Text Animators", an.name];
            var selBase = base.concat(["ADBE Text Selectors", sel.name]);
            var paths = {
                start:  selBase.concat(["ADBE Text Percent Start"]),
                end:    selBase.concat(["ADBE Text Percent End"]),
                offset: selBase.concat(["ADBE Text Percent Offset"])
            };
            for (var a2 = 0; a2 < added.length; a2++) {
                paths[added[a2]] = base.concat(["ADBE Text Animator Properties", PROPS[added[a2]]]);
            }
            return { layerId: layer.id, animator: an.name, added: added, rejected: rejected,
                     basedOn: args.basedOn || "characters", shape: args.shape || "square",
                     basedOnVerified: adv.property("ADBE Text Range Type2").value,
                     paths: paths,
                     hint: "animate paths.offset from -100 to 100, or paths.start 0 to 100, to run the reveal" };
        }

        if (cmd === "remove") {
            var victim = animators.property(String(args.name));
            if (!victim) { throw new Error("No animator named " + args.name); }
            victim.remove();
            return { layerId: layer.id, removed: String(args.name) };
        }
        throw new Error("Unknown textAnimator command: " + cmd);
    },

    /*
     * Project lifecycle. Save existed; new/open/close did not, which blocked
     * the "open a template, fill it, render, close" loop that ad variants are
     * actually produced with.
     */
    /*
     * Discarding has to be EXPLICIT.
     *
     * app.open() and app.newProject() on a dirty project raise AE's "Save
     * changes?" dialog. Everything here runs inside beginSuppressDialogs,
     * which answers a suppressed dialog with its DEFAULT button - and for
     * that prompt the default is Save. So `discardUnsaved: true` silently did
     * the opposite of what it says and overwrote the user's .aep with
     * whatever was in memory. Closing first removes the prompt entirely.
     */
    projectFile: function (args) {
        var cmd = args.command;
        if (cmd === "new") {
            if (app.project && app.project.dirty && args.discardUnsaved !== true) {
                throw new Error("Current project has unsaved changes. Save it, or pass discardUnsaved:true.");
            }
            __mcp_closeWithoutSaving();
            app.newProject();
            return { created: true, numItems: app.project.numItems };
        }
        if (cmd === "open") {
            var f = new File(String(args.path));
            if (!f.exists) { throw new Error("No project at " + args.path); }
            if (app.project && app.project.dirty && args.discardUnsaved !== true) {
                throw new Error("Current project has unsaved changes. Save it, or pass discardUnsaved:true.");
            }
            __mcp_closeWithoutSaving();
            app.open(f);
            return { opened: app.project.file ? app.project.file.fsName : null,
                     numItems: app.project.numItems };
        }
        if (cmd === "close") {
            if (!app.project) { return { closed: false, reason: "no project open" }; }
            var save = args.save === true;
            app.project.close(save ? CloseOptions.SAVE_CHANGES : CloseOptions.DO_NOT_SAVE_CHANGES);
            return { closed: true, saved: save };
        }
        throw new Error("Unknown projectFile command: " + cmd);
    },

    /*
     * Essential Graphics. Fully scriptable and previously unexposed - this is
     * AE's native answer to a parameterised template, and the thing a .mogrt
     * consumer actually interacts with.
     */
    template: function (args) {
        var cmd = args.command;
        var comp = __mcp_resolveComp(args);

        if (cmd === "expose") {
            var layer = __mcp_layerById(args.layerId);
            var prop = __mcp_propByPath(layer, args.path);
            // Pre-flight: 3D properties and paths are rejected outright, and a
            // property already exposed returns false from the add.
            if (!prop.canAddToMotionGraphicsTemplate(comp)) {
                throw new Error("This property type cannot be exposed (3D properties and paths are unsupported, " +
                                "or it is already exposed)");
            }
            var ok = args.name
                ? prop.addToMotionGraphicsTemplateAs(comp, String(args.name))
                : prop.addToMotionGraphicsTemplate(comp);
            if (!ok) { throw new Error("After Effects refused to expose that property"); }
            return { compId: comp.id, layerId: layer.id, path: args.path,
                     exposedAs: args.name || null,
                     controllerCount: comp.motionGraphicsTemplateControllerCount };
        }
        if (cmd === "listExposed") {
            var n = comp.motionGraphicsTemplateControllerCount;
            var list = [];
            for (var i = 1; i <= n; i++) {
                try { list.push({ index: i, value: comp.getMotionGraphicsDataPropertyValue(i) }); }
                catch (e) { list.push({ index: i, error: String(e) }); }
            }
            return { compId: comp.id, templateName: comp.motionGraphicsTemplateName,
                     controllerCount: n, controllers: list };
        }
        if (cmd === "exportMogrt") {
            if (!args.path) { throw new Error("exportMogrt requires path"); }
            var target = String(args.path);
            if (!/\.mogrt$/i.test(target)) { throw new Error("path must end in .mogrt: " + target); }
            var dest = new File(target);
            if (dest.exists && args.overwrite !== true) {
                throw new Error("Refusing to overwrite (pass overwrite:true): " + target);
            }
            // Capture everything off `comp` BEFORE exporting: the export
            // invalidates the CompItem reference, and touching comp.id
            // afterwards throws "Object is invalid".
            var cid = comp.id;
            var cname = comp.name;
            var done = comp.exportAsMotionGraphicsTemplate(args.overwrite === true, dest.fsName);
            return { compId: cid, compName: cname, exported: done, path: dest.fsName,
                     exists: (new File(dest.fsName)).exists };
        }
        throw new Error("Unknown template command: " + cmd);
    },

    /*
     * Render to a file through the render queue. Blocking: renderQueue.render()
     * does not return until the job is done, so the tool layer gives this call
     * a long timeout. Other queued items are disabled for the duration and
     * restored afterwards, so this never renders someone's unrelated queue.
     */
    render: function (args) {
        var cmd = args.command || "render";
        var rq = app.project.renderQueue;

        if (cmd === "listTemplates") {
            var probeComp = __mcp_resolveComp(args);
            var probe = rq.items.add(probeComp);
            var om = probe.outputModule(1);
            var out = { outputModules: [], renderSettings: [] };
            for (var i = 0; i < om.templates.length; i++) { if (om.templates[i].indexOf("_HIDDEN") !== 0) { out.outputModules.push(om.templates[i]); } }
            for (var j = 0; j < probe.templates.length; j++) { if (probe.templates[j].indexOf("_HIDDEN") !== 0) { out.renderSettings.push(probe.templates[j]); } }
            probe.remove();
            return out;
        }
        if (cmd === "queueInAME") {
            if (typeof rq.queueInAME !== "function") { throw new Error("This AE build has no queueInAME"); }
            var aComp = __mcp_resolveComp(args);
            var aItem = rq.items.add(aComp);
            if (args.omTemplate) { aItem.outputModule(1).applyTemplate(String(args.omTemplate)); }
            if (args.outputPath) { aItem.outputModule(1).file = new File(String(args.outputPath)); }
            rq.queueInAME(args.renderImmediately === true);
            return { compId: aComp.id, queued: true, renderImmediately: (args.renderImmediately === true),
                     note: "AME cannot export alpha - use command 'render' for RGB+Alpha" };
        }

        if (cmd === "batch") {
            /*
             * Ad delivery is N comps x M formats. One blocking call per output
             * means N*M round trips; this queues everything and renders once.
             */
            var jobs = args.jobs || [];
            if (!jobs.length) { throw new Error("batch requires a jobs array"); }

            var pausedB = [];
            for (var q = 1; q <= rq.numItems; q++) {
                if (rq.item(q).render) { pausedB.push(q); rq.item(q).render = false; }
            }
            var added = [], failures = [];
            for (var j = 0; j < jobs.length; j++) {
                try {
                    var job = jobs[j];
                    var jc = __mcp_compById(job.compId);
                    var jf = new File(String(job.outputPath));
                    // Per job, or for the whole batch. Only the batch-level flag was
                    // honoured before, and the job schema had no field for it.
                    var jobOverwrite = (job.overwrite === true) || (args.overwrite === true);
                    if (jf.exists && !jobOverwrite) {
                        throw new Error("would overwrite " + job.outputPath + " - pass overwrite:true on the job or the batch");
                    }
                    // Remove the old file so the post-render check reports THIS render.
                    if (jf.exists) { jf.remove(); }
                    var ji = rq.items.add(jc);
                    if (job.rsTemplate) { ji.applyTemplate(String(job.rsTemplate)); }
                    var jm = ji.outputModule(1);
                    jm.applyTemplate(String(job.omTemplate || "Lossless"));
                    jm.file = jf;
                    ji.comment = "[MCP batch]";
                    added.push({ index: j, compId: jc.id, outputPath: jf.fsName, item: ji });
                } catch (e) {
                    failures.push({ index: j, message: String(e) });
                }
            }

            var results = [];
            if (added.length) {
                var t0 = new Date().getTime();
                rq.render();
                for (var a = 0; a < added.length; a++) {
                    var f2 = new File(added[a].outputPath);
                    results.push({ index: added[a].index, compId: added[a].compId,
                                   outputPath: added[a].outputPath,
                                   done: (added[a].item.status === RQItemStatus.DONE),
                                   exists: f2.exists, bytes: f2.exists ? f2.length : 0 });
                }
                results.elapsedMs = new Date().getTime() - t0;
            }
            for (var b = 0; b < added.length; b++) { try { added[b].item.remove(); } catch (e) {} }
            for (var pz = 0; pz < pausedB.length; pz++) { try { rq.item(pausedB[pz]).render = true; } catch (e) {} }
            return { queued: added.length, rendered: results, errors: failures };
        }

        if (cmd !== "render") { throw new Error("Unknown render command: " + cmd); }

        var comp = __mcp_resolveComp(args);
        var outPath = String(args.outputPath || "");
        if (!outPath) { throw new Error("render requires outputPath"); }
        if (!/\.(mov|mp4|m4v|avi|mxf|png|tif|tiff|jpg|jpeg|psd|aif|aiff|wav|mp3)$/i.test(outPath)) {
            throw new Error("outputPath needs a media extension (mov, mp4, png, tif, ...): " + outPath);
        }
        var dest = new File(outPath);
        if (dest.exists && args.overwrite !== true) {
            throw new Error("Refusing to overwrite existing file (pass overwrite:true): " + outPath);
        }

        var paused = [];
        for (var q = 1; q <= rq.numItems; q++) {
            if (rq.item(q).render) { paused.push(q); rq.item(q).render = false; }
        }

        var item = rq.items.add(comp);
        var result;
        try {
            if (args.rsTemplate) { item.applyTemplate(String(args.rsTemplate)); }
            if (args.startTime !== undefined) { item.timeSpanStart = Number(args.startTime); }
            if (args.endTime !== undefined) { item.timeSpanDuration = Number(args.endTime) - item.timeSpanStart; }
            var mod = item.outputModule(1);
            mod.applyTemplate(String(args.omTemplate || "H.264 - Match Render Settings - 15 Mbps"));
            mod.file = dest;
            item.comment = "[MCP]";
            var t0 = new Date().getTime();
            rq.render();
            result = {
                compId: comp.id, compName: comp.name, outputPath: dest.fsName,
                status: String(item.status), done: (item.status === RQItemStatus.DONE),
                elapsedMs: new Date().getTime() - t0,
                exists: (new File(dest.fsName)).exists,
                bytes: (new File(dest.fsName)).exists ? (new File(dest.fsName)).length : 0
            };
        } finally {
            try { item.remove(); } catch (e) {}
            for (var p = 0; p < paused.length; p++) { try { rq.item(paused[p]).render = true; } catch (e) {} }
        }
        if (!result.done) { throw new Error("Render did not complete: status " + result.status); }
        return result;
    }
};
