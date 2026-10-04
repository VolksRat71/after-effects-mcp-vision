/*
 * Changing existing artwork: styles, geometry, text, structure, layers.
 */

var __MCP_JUSTIFY = { left: "LEFT", center: "CENTER", right: "RIGHT", justify: "FULLJUSTIFYLASTLINELEFT" };
var __MCP_CAP = { butt: "BUTTENDCAP", round: "ROUNDENDCAP", square: "PROJECTINGENDCAP" };
var __MCP_JOIN = { miter: "MITERENDJOIN", round: "ROUNDENDJOIN", bevel: "BEVELENDJOIN" };

/*
 * The paths a style lands on. A group or compound path has no paint of its
 * own in the scripting model - the paint lives on its paths - so a fill on a
 * group is applied to every path inside it.
 */
function __mcp_paintTargets(it, out) {
    out = out || [];
    if (it.typename === "PathItem") { out.push(it); }
    else if (it.typename === "CompoundPathItem") {
        for (var i = 0; i < it.pathItems.length; i++) { out.push(it.pathItems[i]); }
    } else if (it.typename === "GroupItem") {
        for (var j = 0; j < it.pageItems.length; j++) { __mcp_paintTargets(it.pageItems[j], out); }
    }
    return out;
}

function __mcp_applyStyle(doc, it, s) {
    if (__mcp_has(s.opacity)) { it.opacity = Number(s.opacity); }
    if (__mcp_has(s.blendMode)) { it.blendingMode = __mcp_blendMode(s.blendMode); }

    if (it.typename === "TextFrame") {
        // One textRange throughout: a second one invalidates the first's
        // attributes (see __mcp_textInfo).
        var tr = it.textRange;
        var ca = tr.characterAttributes;
        if (__mcp_has(s.font)) {
            var f;
            try { f = app.textFonts.getByName(String(s.font)); } catch (e) { f = null; }
            if (!f) { throw new Error("No installed font with PostScript name '" + s.font + "' - look it up with ai_query fonts"); }
            ca.textFont = f;
        }
        if (__mcp_has(s.size)) { ca.size = Number(s.size); }
        if (__mcp_has(s.tracking)) { ca.tracking = Number(s.tracking); }
        if (__mcp_has(s.leading)) {
            if (s.leading === "auto") { ca.autoLeading = true; }
            else { ca.autoLeading = false; ca.leading = Number(s.leading); }
        }
        if (__mcp_has(s.fill)) {
            var fc = __mcp_color(doc, s.fill);
            ca.fillColor = fc;
        }
        if (__mcp_has(s.stroke)) { ca.strokeColor = __mcp_color(doc, s.stroke); }
        if (__mcp_has(s.strokeWidth)) { ca.strokeWeight = Number(s.strokeWidth); }
        if (__mcp_has(s.justification)) {
            var jk = __MCP_JUSTIFY[s.justification];
            if (!jk) { throw new Error("justification must be left, center, right or justify"); }
            tr.paragraphAttributes.justification = Justification[jk];
        }
        return;
    }

    var targets = __mcp_paintTargets(it);
    var paintKeys = ["fill", "stroke", "strokeWidth", "strokeDashes", "strokeCap", "strokeJoin"];
    var wantsPaint = false;
    for (var k = 0; k < paintKeys.length; k++) { if (__mcp_has(s[paintKeys[k]])) { wantsPaint = true; } }
    if (wantsPaint && !targets.length) { throw new Error(it.typename + " has no paths to paint"); }

    for (var i = 0; i < targets.length; i++) {
        var p = targets[i];
        if (__mcp_has(s.fill)) {
            if (s.fill === "none" || s.fill === null) { p.filled = false; }
            else { p.filled = true; p.fillColor = __mcp_color(doc, s.fill); }
        }
        if (__mcp_has(s.stroke)) {
            if (s.stroke === "none" || s.stroke === null) { p.stroked = false; }
            else { p.stroked = true; p.strokeColor = __mcp_color(doc, s.stroke); }
        }
        if (__mcp_has(s.strokeWidth)) { p.strokeWidth = Number(s.strokeWidth); if (!__mcp_has(s.stroke) && !p.stroked) { p.stroked = true; } }
        if (__mcp_has(s.strokeDashes)) { p.strokeDashes = s.strokeDashes; }
        if (__mcp_has(s.strokeCap)) {
            if (!__MCP_CAP[s.strokeCap]) { throw new Error("strokeCap must be butt, round or square"); }
            p.strokeCap = StrokeCap[__MCP_CAP[s.strokeCap]];
        }
        if (__mcp_has(s.strokeJoin)) {
            if (!__MCP_JOIN[s.strokeJoin]) { throw new Error("strokeJoin must be miter, round or bevel"); }
            p.strokeJoin = StrokeJoin[__MCP_JOIN[s.strokeJoin]];
        }
    }
}

/*
 * One write. Order matters and is fixed here so a caller cannot get it wrong:
 * unlock/show first (a locked item refuses every other change), then style
 * and text (which change a text box's size), then size, then rotation, then
 * position LAST so the final box really is at x,y. Lock/hide go on at the end.
 */
function __mcp_applyWrite(doc, it, w) {
    if (w.locked === false) { it.locked = false; }
    if (w.hidden === false) { it.hidden = false; }
    if (it.locked) { throw { code: "locked", message: "item is locked - pass locked:false in the same write to change it" }; }

    if (__mcp_has(w.name)) { it.name = String(w.name); }

    // Point text grows and re-anchors around its baseline point when its
    // contents, size or justification change - measured: centring a 48pt
    // line moved its box 113pt left. Record the top-left and put it back, so
    // x,y stays the top-left like every other item.
    var pointText = it.typename === "TextFrame" && it.kind === TextType.POINTTEXT;
    var keep = pointText ? it.geometricBounds : null;

    if (__mcp_has(w.contents)) {
        if (it.typename !== "TextFrame") { throw { code: "type_mismatch", message: "contents applies to text frames, not " + it.typename }; }
        it.contents = String(w.contents);
    }
    __mcp_applyStyle(doc, it, w);
    if (keep) {
        var now = it.geometricBounds;
        it.translate(keep[0] - now[0], keep[1] - now[1]);
    }

    if (__mcp_has(w.points)) {
        if (it.typename !== "PathItem") { throw { code: "type_mismatch", message: "points applies to paths, not " + it.typename }; }
        __mcp_validatePoints(w.points, 2);
        var abP = __mcp_has(w.artboard) ? Number(w.artboard) : __mcp_artboardOf(doc, it.geometricBounds);
        abP = __mcp_artboardIndex(doc, abP === null ? undefined : abP);
        while (it.pathPoints.length > 1) { it.pathPoints[it.pathPoints.length - 1].remove(); }
        // A path cannot hold zero points, so the first one is rewritten in
        // place and the rest are appended after it.
        var firstLeft = it.pathPoints[0];
        __mcp_pathPoints(doc, abP === null ? undefined : abP, it, w.points);
        firstLeft.remove();
    }
    // closed on its own (no new points) opens or closes the existing path.
    if (__mcp_has(w.closed)) {
        if (it.typename !== "PathItem") { throw { code: "type_mismatch", message: "closed applies to paths, not " + it.typename }; }
        it.closed = w.closed !== false;
    }

    var ab = __mcp_has(w.artboard) ? Number(w.artboard) : __mcp_artboardOf(doc, it.geometricBounds);
    if (ab === null) { ab = undefined; }

    if (__mcp_has(w.width) || __mcp_has(w.height)) {
        var gb = it.geometricBounds;
        var cw = gb[2] - gb[0], ch = gb[1] - gb[3];
        if (cw <= 0 || ch <= 0) { throw { code: "bad_value", message: "cannot resize an item with zero width or height" }; }
        var sx = __mcp_has(w.width) ? Number(w.width) / cw * 100 : 100;
        var sy = __mcp_has(w.height) ? Number(w.height) / ch * 100 : 100;
        if (w.keepRatio === true) {
            if (__mcp_has(w.width) && !__mcp_has(w.height)) { sy = sx; }
            else if (__mcp_has(w.height) && !__mcp_has(w.width)) { sx = sy; }
        }
        // Scale about the top-left so the item stays where it was; strokes keep
        // their weight unless scaleStrokes asks otherwise.
        it.resize(sx, sy, true, true, true, true, w.scaleStrokes === true ? (sx + sy) / 2 : 100, Transformation.TOPLEFT);
    }

    if (__mcp_has(w.rotateBy)) {
        it.rotate(Number(w.rotateBy), true, true, true, true, Transformation.CENTER);
    }

    if (__mcp_has(w.x) || __mcp_has(w.y)) {
        var box = __mcp_boxFromBounds(doc, ab, it.geometricBounds);
        __mcp_moveTopLeft(doc, ab, it,
                          __mcp_has(w.x) ? w.x : box.x,
                          __mcp_has(w.y) ? w.y : box.y);
    }
    if (__mcp_has(w.moveBy)) {
        it.translate(Number(w.moveBy[0]), -Number(w.moveBy[1]));
    }

    if (w.hidden === true) { it.hidden = true; }
    if (w.locked === true) { it.locked = true; }
}

/* Every page item on a layer and all of its sublayers. */
function __mcp_deepItemCount(l) {
    var n = l.pageItems.length;
    for (var i = 0; i < l.layers.length; i++) { n += __mcp_deepItemCount(l.layers[i]); }
    return n;
}

var __MCP_ARRANGE = {
    bringToFront: "BRINGTOFRONT", bringForward: "BRINGFORWARD",
    sendBackward: "SENDBACKWARD", sendToBack: "SENDTOBACK"
};

var __mcp_mutateOps = {

    /*
     * Batched writes with per-item errors. One bad uuid or value does not
     * discard the rest; the whole batch is still one undo step.
     */
    set: function (args) {
        var doc = __mcp_doc();
        var writes = args.writes;
        if (!(writes instanceof Array) || !writes.length) { throw new Error("writes must be a non-empty array"); }
        var applied = [], errors = [];
        for (var i = 0; i < writes.length; i++) {
            var w = writes[i], it = null;
            try { it = __mcp_item(w.uuid); } catch (e) {
                errors.push({ index: i, uuid: w.uuid, code: "unknown_uuid", message: String(e.message || e) });
                continue;
            }
            try {
                __mcp_applyWrite(doc, it, w);
                var ab = __mcp_artboardOf(doc, it.geometricBounds);
                applied.push({ index: i, uuid: it.uuid, box: __mcp_boxFromBounds(doc, ab === null ? undefined : ab, it.geometricBounds) });
            } catch (e2) {
                errors.push({ index: i, uuid: w.uuid, code: e2.code || "failed", message: String(e2.message || e2) });
            }
        }
        return { appliedCount: applied.length, applied: applied, errors: errors };
    },

    items: function (args) {
        var doc = __mcp_doc();
        var cmd = args.command;
        var list, it, i;

        if (cmd === "delete") {
            list = __mcp_items(args.uuids);
            var gone = [];
            for (i = 0; i < list.length; i++) { gone.push(list[i].uuid); list[i].remove(); }
            return { deleted: gone };
        }

        if (cmd === "duplicate") {
            it = __mcp_item(args.uuid);
            var dup = it.duplicate();
            if (__mcp_has(args.offset)) { dup.translate(Number(args.offset[0]), -Number(args.offset[1])); }
            if (args.name) { dup.name = String(args.name); }
            return __mcp_summary(doc, dup);
        }

        if (cmd === "group" || cmd === "clip") {
            list = __mcp_items(args.uuids);
            if (cmd === "clip" && list.length < 2) { throw new Error("clip needs the mask shape plus at least one item"); }
            // Validate before anything moves: a bad mask found after grouping
            // used to return an error with the artwork already regrouped.
            if (cmd === "clip" && list[0].typename !== "PathItem" && list[0].typename !== "CompoundPathItem") {
                throw new Error("The mask (first uuid) must be a path or compound path, not " + list[0].typename);
            }
            // The group goes where the topmost of its members was.
            var top = list[0];
            for (i = 1; i < list.length; i++) { if (list[i].zOrderPosition > top.zOrderPosition) { top = list[i]; } }
            var g = top.parent.groupItems.add();
            g.move(top, ElementPlacement.PLACEBEFORE);
            // Keep the members' stacking order: move bottom-most first, each to
            // the top of the group.
            var ordered = list.slice(0).sort(function (a, b) { return a.zOrderPosition - b.zOrderPosition; });
            for (i = 0; i < ordered.length; i++) { ordered[i].move(g, ElementPlacement.PLACEATBEGINNING); }
            if (cmd === "clip") {
                // The clipping path is the group's TOPMOST path - so the first
                // uuid given is moved to the top and becomes the mask.
                var mask = list[0];
                mask.move(g, ElementPlacement.PLACEATBEGINNING);
                g.clipped = true;
            }
            if (args.name) { g.name = String(args.name); }
            return __mcp_summary(doc, g);
        }

        if (cmd === "ungroup") {
            it = __mcp_item(args.uuid);
            if (it.typename !== "GroupItem") { throw new Error(args.uuid + " is not a group"); }
            var freed = [];
            // Released children keep their stacking order. PLACEBEFORE puts an
            // item directly above the group, so taking them topmost-first leaves
            // each later one just beneath the one before it.
            while (it.pageItems.length) {
                var child = it.pageItems[0];
                child.move(it, ElementPlacement.PLACEBEFORE);
                freed.push(child.uuid);
            }
            it.remove();
            return { released: freed };
        }

        if (cmd === "moveToLayer") {
            list = __mcp_items(args.uuids);
            var layer = __mcp_container(doc, { layer: args.layer });
            for (i = 0; i < list.length; i++) { list[i].move(layer, ElementPlacement.PLACEATBEGINNING); }
            return { moved: list.length, layer: __mcp_layerPath(layer) };
        }

        if (cmd === "arrange") {
            var how = __MCP_ARRANGE[args.order];
            if (!how) { throw new Error("order must be one of " + __mcp_keys(__MCP_ARRANGE).join(", ")); }
            list = __mcp_items(args.uuids);
            for (i = 0; i < list.length; i++) { list[i].zOrder(ZOrderMethod[how]); }
            return { arranged: list.length };
        }

        if (cmd === "select") {
            doc.selection = null;
            list = args.uuids && args.uuids.length ? __mcp_items(args.uuids) : [];
            for (i = 0; i < list.length; i++) { list[i].selected = true; }
            return { selected: list.length };
        }

        if (cmd === "outlineText") {
            it = __mcp_item(args.uuid);
            if (it.typename !== "TextFrame") { throw new Error(args.uuid + " is not text"); }
            var outlined = it.createOutline();
            return __mcp_summary(doc, outlined);
        }

        throw new Error("Unknown items command: " + cmd);
    },

    layers: function (args) {
        var doc = __mcp_doc();
        var cmd = args.command;
        var layer;

        if (cmd === "create") {
            var scope = __mcp_has(args.parent) ? __mcp_layerByPath(doc, args.parent).layers : doc.layers;
            layer = scope.add();
            if (args.name) { layer.name = String(args.name); }
            return { path: __mcp_layerPath(layer) };
        }

        layer = __mcp_layerByPath(doc, args.layer);

        if (cmd === "rename") { layer.name = String(args.name); return { path: __mcp_layerPath(layer) }; }
        if (cmd === "setVisible") { layer.visible = args.visible !== false; return { path: __mcp_layerPath(layer), visible: layer.visible }; }
        if (cmd === "setLocked") { layer.locked = args.locked !== false; return { path: __mcp_layerPath(layer), locked: layer.locked }; }
        if (cmd === "setActive") { doc.activeLayer = layer; return { active: __mcp_layerPath(layer) }; }
        if (cmd === "arrange") {
            var how = __MCP_ARRANGE[args.order];
            if (!how) { throw new Error("order must be one of " + __mcp_keys(__MCP_ARRANGE).join(", ")); }
            layer.zOrder(ZOrderMethod[how]);
            return { path: __mcp_layerPath(layer) };
        }
        if (cmd === "delete") {
            if (layer.parent.typename === "Document" && doc.layers.length < 2) { throw new Error("A document needs at least one layer"); }
            // Deleting a layer deletes its artwork, sublayers included.
            // Layer.pageItems holds only what sits directly on the layer, so a
            // layer that is nothing but sublayers full of art counted as empty.
            var held = __mcp_deepItemCount(layer);
            if (held && args.deleteContents !== true) {
                throw new Error("Layer '" + layer.name + "' holds " + held + " items" +
                    (layer.layers.length ? " across it and " + layer.layers.length + " sublayer(s)" : "") +
                    " - pass deleteContents:true to delete them with it");
            }
            var path = __mcp_layerPath(layer);
            layer.remove();
            return { deleted: path };
        }
        throw new Error("Unknown layers command: " + cmd);
    }
};
