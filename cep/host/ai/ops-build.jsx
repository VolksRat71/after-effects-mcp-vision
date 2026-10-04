/*
 * Documents, artboards, creating artwork, and export.
 */

function __mcp_requireAbsolute(path, what) {
    var s = String(path || "");
    if (!s || !(s.charAt(0) === "/" || /^[A-Za-z]:[\\\/]/.test(s))) {
        throw new Error(what + " must be an absolute path, got '" + s + "'");
    }
    return s;
}

function __mcp_extOf(path) {
    var m = /\.([A-Za-z0-9]+)$/.exec(String(path));
    return m ? m[1].toLowerCase() : "";
}

/*
 * Artboard geometry Illustrator rejects comes back as a bare four-character
 * code. Measured on 30.8.1: adding an artboard to the right of a row already
 * ~8,200pt wide failed with "an Illustrator error occurred: 1095724867
 * ('CoOA')" - the rectangle fell outside Illustrator's fixed-size canvas.
 * Say that, in terms the caller can act on.
 */
function __mcp_setArtboardRect(doc, rect, apply) {
    try {
        return apply(rect);
    } catch (e) {
        if (String(e.message || e).indexOf("CoOA") !== -1) {
            var r0 = doc.artboards[0].artboardRect;
            throw new Error("That artboard would fall outside Illustrator's canvas (x " +
                __mcp_round(rect[0] - r0[0]) + " to " + __mcp_round(rect[2] - r0[0]) + ", y " +
                __mcp_round(r0[1] - rect[1]) + " to " + __mcp_round(r0[1] - rect[3]) +
                " from artboard 0). The canvas is a fixed 16,383pt square; place it closer to the " +
                "other artboards, for example in a new row below them.");
        }
        throw e;
    }
}

/* Stage on the destination volume before moving the previous deliverable aside.
 * Failed replacements retain the staged render and report its recovery path.
 */
function __mcp_replaceExport(source, destination, overwrite) {
    var targetPath = destination.fsName;
    var targetName = destination.name;
    var suffix = ".mcp-" + new Date().getTime() + "-" + Math.floor(Math.random() * 1e9);
    var staged = new File(targetPath + suffix + ".staged");
    var backup = new File(targetPath + suffix + ".backup");
    if (staged.exists || backup.exists) { throw new Error("Export staging path already exists; retry the export"); }
    if (!source.copy(staged.fsName) || !staged.exists || staged.length !== source.length) {
        throw new Error("Could not stage a complete export at " + staged.fsName);
    }
    // Re-check after copying: the destination may have appeared during rendering.
    var old = new File(targetPath);
    var backedUp = false;
    if (old.exists) {
        if (overwrite !== true) { throw new Error(targetPath + " exists - pass overwrite:true to replace it; render retained at " + staged.fsName); }
        if (!old.rename(backup.name)) { throw new Error("Could not back up " + targetPath + "; render retained at " + staged.fsName); }
        backedUp = true;
    }
    var promoted = false;
    try { promoted = staged.rename(targetName); } catch (e) {}
    if (!promoted) {
        var restored = !backedUp;
        if (backedUp) { try { restored = new File(backup.fsName).rename(targetName); } catch (e2) {} }
        throw new Error("Could not replace " + targetPath + "; render retained at " + staged.fsName +
                        (restored ? "; previous output restored" : "; previous output retained at " + backup.fsName));
    }
    // A failed backup cleanup must never turn a successful replacement into loss.
    if (backedUp) { try { new File(backup.fsName).remove(); } catch (e3) {} }
}

function __mcp_ensureParent(file) {
    if (!file.parent.exists) { file.parent.create(); }
}

/*
 * Where new artwork goes: a group (by uuid), a layer (by name path), or the
 * active layer. A locked or hidden target is refused up front, because
 * Illustrator's own error for it ("Target layer cannot be modified") does not
 * say which layer or why.
 */
function __mcp_container(doc, args) {
    if (__mcp_has(args.groupUuid)) {
        var g = __mcp_item(args.groupUuid);
        if (g.typename !== "GroupItem") { throw new Error(args.groupUuid + " is not a group"); }
        return g;
    }
    var layer = __mcp_has(args.layer) ? __mcp_layerByPath(doc, args.layer) : doc.activeLayer;
    var node = layer;
    while (node && node.typename === "Layer") {
        if (node.locked) { throw new Error("Layer '" + node.name + "' is locked - unlock it with ai_layers setLocked"); }
        if (!node.visible) { throw new Error("Layer '" + node.name + "' is hidden - show it with ai_layers setVisible"); }
        node = node.parent;
    }
    return layer;
}

/*
 * Move an item so its geometric top-left lands on (x, y) in artboard space.
 * Used after text is styled, because a point text's box depends on its font.
 */
function __mcp_moveTopLeft(doc, abIndex, it, x, y) {
    var target = __mcp_toDoc(doc, abIndex, x, y);
    var gb = it.geometricBounds;
    it.translate(target[0] - gb[0], target[1] - gb[1]);
}

/*
 * Check a whole point list before any path is touched. Points are applied one
 * at a time, so a bad entry found partway through used to leave a half-written
 * path behind.
 */
function __mcp_validatePoints(points, min) {
    if (!(points instanceof Array) || points.length < min) {
        throw { code: "bad_value", message: "points must be an array of at least " + min + " points" };
    }
    var xy = function (v) {
        return v instanceof Array && v.length >= 2 && isFinite(Number(v[0])) && isFinite(Number(v[1])) &&
               v[0] !== null && v[1] !== null;
    };
    for (var i = 0; i < points.length; i++) {
        var p = points[i];
        var good = xy(p) || (p && typeof p === "object" && !(p instanceof Array) && xy(p.anchor) &&
                   (!__mcp_has(p.left) || xy(p.left)) && (!__mcp_has(p.right) || xy(p.right)));
        if (!good) {
            throw { code: "bad_value", message: "point " + i + " must be [x, y] or {anchor:[x,y], left?, right?}, got " + JSON.stringify(p) };
        }
    }
}

function __mcp_pathPoints(doc, abIndex, path, points) {
    var r = __mcp_abRect(doc, abIndex);
    var conv = function (p) { return [r[0] + Number(p[0]), r[1] - Number(p[1])]; };
    for (var i = 0; i < points.length; i++) {
        var p = points[i];
        var pp = path.pathPoints.add();
        if (p instanceof Array) {
            var a = conv(p);
            pp.anchor = a; pp.leftDirection = a; pp.rightDirection = a;
            pp.pointType = PointType.CORNER;
        } else {
            var anc = conv(p.anchor);
            pp.anchor = anc;
            pp.leftDirection = p.left ? conv(p.left) : anc;
            pp.rightDirection = p.right ? conv(p.right) : anc;
            pp.pointType = (p.left || p.right) ? PointType.SMOOTH : PointType.CORNER;
        }
    }
}

function __mcp_created(doc, abIndex, it) {
    return {
        uuid: it.uuid, type: it.typename, name: it.name || null, artboard: abIndex,
        box: __mcp_boxFromBounds(doc, abIndex, it.geometricBounds),
        visibleBox: __mcp_boxFromBounds(doc, abIndex, it.visibleBounds)
    };
}

/*
 * SVG goes through exportForScreens, NOT exportFile. Measured on 30.8.1:
 * exportFile(ExportType.SVG) re-points the open document at the .svg and marks
 * it saved - so a later "save" writes somewhere the user never chose, and the
 * unsaved-changes guard on close is silently disarmed. exportForScreens leaves
 * the document alone. It names its output itself (prefix + artboard name), so
 * exportFile below renders it into a private folder and moves it into place.
 */
function __mcp_exportSvgInto(doc, abIndex, folder, args) {
    var o = new ExportForScreensOptionsWebOptimizedSVG();
    o.coordinatePrecision = 3;
    o.cssProperties = SVGCSSPropertyLocation.STYLEATTRIBUTES;
    o.fontType = args.outlineText === true ? SVGFontType.OUTLINEFONT : SVGFontType.SVGFONT;
    var what = new ExportForScreensItemToExport();
    what.artboards = String(abIndex + 1);
    what.document = false;
    doc.exportForScreens(folder, ExportForScreensType.SE_SVG, o, what, "mcp-");
}

function __mcp_findFiles(folder, re) {
    var out = [], entries = folder.getFiles();
    for (var i = 0; i < entries.length; i++) {
        if (entries[i] instanceof Folder) { out = out.concat(__mcp_findFiles(entries[i], re)); }
        else if (re.test(entries[i].name)) { out.push(entries[i]); }
    }
    return out;
}

function __mcp_removeTree(folder) {
    try {
        var entries = folder.getFiles();
        for (var i = 0; i < entries.length; i++) {
            if (entries[i] instanceof Folder) { __mcp_removeTree(entries[i]); } else { entries[i].remove(); }
        }
        folder.remove();
    } catch (e) {}
}

/*
 * Place an image or vector file. Sizing follows the box the caller gives:
 * width AND height fit the artwork inside that box, keeping its proportions,
 * and centre it there - the way a logo drops into a slot. Only one of them
 * scales to it proportionally; neither keeps the file's own size. keepRatio
 * false stretches to the box exactly.
 *
 * embed (default true) embeds the file, so the document does not depend on a
 * path on this machine - a linked logo breaks the moment the file is handed
 * to someone else. Embedding replaces the placed item with a new one, which
 * is why the result is looked up again afterwards.
 */
function __mcp_placeImage(doc, abIndex, parent, args) {
    if (!__mcp_has(args.path)) { throw new Error("image needs path: an absolute path to the file"); }
    var file = new File(__mcp_requireAbsolute(args.path, "path"));
    if (!file.exists) { throw new Error("No file at " + file.fsName); }
    if (!__mcp_has(args.x) || !__mcp_has(args.y)) { throw new Error("image needs x and y"); }

    var p = parent.placedItems.add();
    var it = p;
    try {
        p.file = file;
        var w0 = p.width, h0 = p.height;
        if (!(w0 > 0 && h0 > 0)) { throw new Error("Illustrator could not read an image size from " + file.fsName); }
        var hasW = __mcp_has(args.width), hasH = __mcp_has(args.height);
        var boxW = hasW ? Number(args.width) : null, boxH = hasH ? Number(args.height) : null;
        var w = w0, h = h0;
        if (hasW && hasH && args.keepRatio === false) { w = boxW; h = boxH; }
        else if (hasW && hasH) { var k = Math.min(boxW / w0, boxH / h0); w = w0 * k; h = h0 * k; }
        else if (hasW) { w = boxW; h = h0 * boxW / w0; }
        else if (hasH) { h = boxH; w = w0 * boxH / h0; }
        p.width = w; p.height = h;
        // Centre inside the box when it was a fit, else top-left at x,y.
        var x = Number(args.x) + (hasW && hasH ? (boxW - w) / 2 : 0);
        var y = Number(args.y) + (hasW && hasH ? (boxH - h) / 2 : 0);
        __mcp_moveTopLeft(doc, abIndex, p, x, y);

        if (args.embed !== false) {
            // The embedded replacement takes the placed item's place in the
            // stack, and a new placed item is always at the top of its parent.
            p.embed();
            it = parent.pageItems[0];
        }
        if (args.name) { it.name = String(args.name); }
        if (__mcp_has(args.opacity)) { it.opacity = Number(args.opacity); }
    } catch (e) {
        try { it.remove(); } catch (x) {}
        throw e;
    }
    var out = __mcp_created(doc, abIndex, it);
    out.source = file.fsName;
    out.embedded = args.embed !== false;
    out.scale = __mcp_round(w / w0 * 100);
    return out;
}

var __MCP_DEFAULT_FILL = "#000000";

var __mcp_buildOps = {

    document: function (args) {
        var cmd = args.command;
        var doc, file;

        if (cmd === "new") {
            var space = String(args.colorSpace || "RGB").toUpperCase() === "CMYK" ? DocumentColorSpace.CMYK : DocumentColorSpace.RGB;
            doc = app.documents.add(space, Number(args.width || 1080), Number(args.height || 1080));
            return { name: doc.name, colorSpace: String(doc.documentColorSpace).replace("DocumentColorSpace.", ""),
                     artboards: __mcp_artboardList(doc) };
        }

        if (cmd === "open") {
            file = new File(__mcp_requireAbsolute(args.path, "path"));
            if (!file.exists) { throw new Error("No file at " + file.fsName); }
            doc = app.open(file);
            return { name: doc.name, artboards: __mcp_artboardList(doc), items: doc.pageItems.length };
        }

        if (cmd === "activate") {
            if (!args.name) { throw new Error("activate needs the document name from sessionInfo"); }
            for (var i = 0; i < app.documents.length; i++) {
                if (app.documents[i].name === String(args.name)) {
                    app.documents[i].activate();
                    return { active: app.activeDocument.name };
                }
            }
            throw new Error("No open document named '" + args.name + "'");
        }

        doc = __mcp_doc();

        if (cmd === "save") {
            // Saving in place is only allowed for a document that already has a
            // file; an untitled one needs an explicit destination.
            if (!__mcp_has(args.path)) {
                if (!(doc.path && doc.path.fsName)) { throw new Error("This document has never been saved - pass path (an absolute .ai path)"); }
                doc.save();
                return { saved: true, path: doc.fullName.fsName };
            }
            file = new File(__mcp_requireAbsolute(args.path, "path"));
            if (__mcp_extOf(file.fsName) !== "ai") { throw new Error("save writes .ai files; use ai_export for other formats"); }
            if (file.exists && args.overwrite !== true) { throw new Error(file.fsName + " exists - pass overwrite:true to replace it"); }
            __mcp_ensureParent(file);
            doc.saveAs(file, new IllustratorSaveOptions());
            return { saved: true, path: doc.fullName.fsName, name: doc.name };
        }

        if (cmd === "close") {
            // name pins the document. Without it, close acts on whatever is
            // active - and the user can click into their own file at any time.
            if (__mcp_has(args.name)) {
                doc = null;
                for (var ci = 0; ci < app.documents.length; ci++) {
                    if (app.documents[ci].name === String(args.name)) { doc = app.documents[ci]; break; }
                }
                if (!doc) { throw new Error("No open document named '" + args.name + "' - nothing was closed"); }
            }
            // Never SAVECHANGES: with alerts suppressed, a "save changes?"
            // prompt is answered for the user, and an agent must not be the one
            // who decided to overwrite their file.
            if (!doc.saved && args.discardUnsaved !== true) {
                throw new Error("'" + doc.name + "' has unsaved changes - save it first, or pass discardUnsaved:true");
            }
            var closedName = doc.name;
            doc.close(SaveOptions.DONOTSAVECHANGES);
            return { closed: closedName, remaining: app.documents.length };
        }

        var r0 = doc.artboards[0].artboardRect;
        var abRect = function (x, y, w, h) {
            var l = r0[0] + Number(x), t = r0[1] - Number(y);
            return [l, t, l + Number(w), t - Number(h)];
        };

        if (cmd === "addArtboard") {
            if (!__mcp_has(args.width) || !__mcp_has(args.height)) { throw new Error("addArtboard needs width and height"); }
            var x = args.x, y = args.y;
            if (!__mcp_has(x)) {
                // Default: to the right of the rightmost artboard, 40pt gap.
                var maxR = -Infinity, topOf = r0[1];
                for (var a = 0; a < doc.artboards.length; a++) {
                    var ar = doc.artboards[a].artboardRect;
                    if (ar[2] > maxR) { maxR = ar[2]; topOf = ar[1]; }
                }
                x = maxR - r0[0] + 40; y = r0[1] - topOf;
            }
            var ab = __mcp_setArtboardRect(doc, abRect(x, y || 0, args.width, args.height),
                                           function (r) { return doc.artboards.add(r); });
            if (args.name) { ab.name = String(args.name); }
            return { index: doc.artboards.length - 1, artboards: __mcp_artboardList(doc) };
        }

        if (cmd === "setArtboard") {
            var idx = __mcp_artboardIndex(doc, args.index);
            var board = doc.artboards[idx];
            var cur = board.artboardRect;
            if (__mcp_has(args.x) || __mcp_has(args.y) || __mcp_has(args.width) || __mcp_has(args.height)) {
                // artboard 0 is the origin; moving it moves the frame everything
                // else is measured from, which is a surprise worth refusing.
                if (idx === 0 && (__mcp_has(args.x) || __mcp_has(args.y))) {
                    throw new Error("artboard 0 is the origin for artboard positions and cannot be moved; resize it, or move the others");
                }
                __mcp_setArtboardRect(doc, abRect(
                    __mcp_has(args.x) ? args.x : cur[0] - r0[0],
                    __mcp_has(args.y) ? args.y : r0[1] - cur[1],
                    __mcp_has(args.width) ? args.width : cur[2] - cur[0],
                    __mcp_has(args.height) ? args.height : cur[1] - cur[3]),
                    function (r) { board.artboardRect = r; });
            }
            if (args.name) { board.name = String(args.name); }
            if (args.active === true) { doc.artboards.setActiveArtboardIndex(idx); }
            return { index: idx, artboards: __mcp_artboardList(doc) };
        }

        if (cmd === "removeArtboard") {
            if (doc.artboards.length < 2) { throw new Error("A document needs at least one artboard"); }
            var ri = __mcp_artboardIndex(doc, args.index);
            if (ri === 0) { throw new Error("Removing artboard 0 shifts the origin every position is measured from; remove others instead"); }
            doc.artboards[ri].remove();
            return { removed: ri, artboards: __mcp_artboardList(doc) };
        }

        throw new Error("Unknown document command: " + cmd);
    },

    /*
     * Create one item. Geometry is artboard space, y down. Fill defaults to
     * black and stroke to none - explicit, rather than inheriting whatever the
     * user last had in the toolbar.
     */
    create: function (args) {
        var doc = __mcp_doc();
        var abIndex = __mcp_artboardIndex(doc, args.artboard);
        var parent = __mcp_container(doc, args);
        var kind = args.kind;
        var it, tl;

        var need = function (names) {
            for (var i = 0; i < names.length; i++) {
                if (!__mcp_has(args[names[i]])) { throw new Error(kind + " needs " + names.join(", ")); }
            }
        };

        if (kind === "image") { return __mcp_placeImage(doc, abIndex, parent, args); }

        // A create that fails must leave nothing behind, so the try opens before
        // the first item exists and covers points, contents and styling - a
        // malformed point or bad font used to strand an empty or unstyled item.
        var frame = null;
        try {
            if (kind === "rect" || kind === "ellipse") {
                need(["x", "y", "width", "height"]);
                tl = __mcp_toDoc(doc, abIndex, args.x, args.y);
                if (kind === "ellipse") {
                    it = parent.pathItems.ellipse(tl[1], tl[0], Number(args.width), Number(args.height));
                } else if (Number(args.cornerRadius) > 0) {
                    var cr = Number(args.cornerRadius);
                    it = parent.pathItems.roundedRectangle(tl[1], tl[0], Number(args.width), Number(args.height), cr, cr);
                } else {
                    it = parent.pathItems.rectangle(tl[1], tl[0], Number(args.width), Number(args.height));
                }
            } else if (kind === "polygon" || kind === "star") {
                need(["centerX", "centerY", "radius"]);
                var c = __mcp_toDoc(doc, abIndex, args.centerX, args.centerY);
                if (kind === "polygon") {
                    it = parent.pathItems.polygon(c[0], c[1], Number(args.radius), Number(args.sides || 6));
                } else {
                    it = parent.pathItems.star(c[0], c[1], Number(args.radius),
                                               Number(__mcp_has(args.innerRadius) ? args.innerRadius : args.radius / 2),
                                               Number(args.points || 5));
                }
            } else if (kind === "line" || kind === "path") {
                need(["points"]);
                var pts = args.points;
                __mcp_validatePoints(pts, 2);
                it = parent.pathItems.add();
                __mcp_pathPoints(doc, abIndex, it, pts);
                it.closed = kind === "line" ? false : (args.closed !== false);
                // An open path with a fill paints a phantom closing edge; a line
                // wants a stroke, not a fill.
                if (!it.closed && !__mcp_has(args.fill)) { args.fill = "none"; }
                if (kind === "line" && !__mcp_has(args.stroke)) { args.stroke = "#000000"; }
            } else if (kind === "text" || kind === "areaText") {
                need(["x", "y"]);
                if (!__mcp_has(args.contents)) { throw new Error(kind + " needs contents"); }
                tl = __mcp_toDoc(doc, abIndex, args.x, args.y);
                if (kind === "areaText") {
                    need(["width", "height"]);
                    frame = parent.pathItems.rectangle(tl[1], tl[0], Number(args.width), Number(args.height));
                    it = parent.textFrames.areaText(frame);
                } else {
                    it = parent.textFrames.pointText(tl);
                }
                it.contents = String(args.contents);
            } else {
                throw new Error("Unknown kind '" + kind + "'. Known: rect, ellipse, polygon, star, line, path, text, areaText, image");
            }

            if (args.name) { it.name = String(args.name); }
            var style = {};
            var keys = ["fill", "stroke", "strokeWidth", "strokeDashes", "strokeCap", "strokeJoin", "opacity", "blendMode",
                        "font", "size", "justification", "tracking", "leading"];
            for (var k = 0; k < keys.length; k++) { if (__mcp_has(args[keys[k]])) { style[keys[k]] = args[keys[k]]; } }
            if (!__mcp_has(style.fill)) { style.fill = __MCP_DEFAULT_FILL; }
            if (!__mcp_has(style.stroke) && it.typename !== "TextFrame") { style.stroke = "none"; }
            __mcp_applyStyle(doc, it, style);
            // Point text grows from its baseline, so its box is only known once
            // the font and size are set. Re-seat it so x,y is the top-left like
            // every other kind.
            if (kind === "text") { __mcp_moveTopLeft(doc, abIndex, it, args.x, args.y); }
        } catch (e) {
            // An area text's frame path is consumed into the text frame, so
            // removing the text removes both; the frame alone is removed when
            // areaText() itself failed.
            if (it) { try { it.remove(); } catch (x) {} }
            else if (frame) { try { frame.remove(); } catch (x) {} }
            throw e;
        }

        return __mcp_created(doc, abIndex, it);
    },

    /*
     * Export to a real file. png, jpg and svg each render one artboard.
     * The path must be absolute and is never overwritten
     * without overwrite:true.
     */
    exportFile: function (args) {
        var doc = __mcp_doc();
        var file = new File(__mcp_requireAbsolute(args.path, "path"));
        var norm = function (f) { f = String(f).toLowerCase(); return f === "jpeg" ? "jpg" : f; };
        var ext = norm(__mcp_extOf(file.fsName));
        var format = norm(args.format || ext);
        if (ext !== format) { throw new Error("path extension ." + __mcp_extOf(file.fsName) + " does not match format " + format); }
        if (format !== "png" && format !== "jpg" && format !== "svg") {
            throw new Error("Unknown format " + format + ". Known: png, jpg, svg. PDF is not offered: scripting can only saveAs a PDF, which re-points the open document at it.");
        }
        if (file.exists && args.overwrite !== true) { throw new Error(file.fsName + " exists - pass overwrite:true to replace it"); }
        __mcp_ensureParent(file);

        var abIndex = __mcp_artboardIndex(doc, args.artboard);
        var priorActive = doc.artboards.getActiveArtboardIndex();
        var scale = Number(args.scale || 100);
        var t0 = new Date().getTime();

        /*
         * Every format renders into a private folder and is then moved to the
         * exact path asked for. Illustrator does not write the name it is given
         * - measured: PNG export turned "Campaign Tech Award 2026.png" into
         * "Campaign-Tech-Award-2026.png" - so exporting in place made the
         * overwrite check look at the wrong name, and finding "what landed" by
         * pattern could pick up a neighbour such as logo-old.png. A fresh folder
         * holds exactly one output, and the destination is always the name the
         * caller chose.
         */
        var tmp = new Folder(__mcp_captureDir().fsName + "/export-" + t0 + "-" + Math.floor(Math.random() * 1e6));
        tmp.create();
        var exportComplete = false;
        try {
            if (format === "svg") {
                __mcp_exportSvgInto(doc, abIndex, tmp, args);
            } else {
                // exportFile renders the ACTIVE artboard; switch, then restore.
                doc.artboards.setActiveArtboardIndex(abIndex);
                var o;
                if (format === "png") {
                    o = new ExportOptionsPNG24();
                    o.transparency = args.transparent !== false;
                } else {
                    o = new ExportOptionsJPEG();
                    o.qualitySetting = Number(args.quality || 85);
                }
                o.artBoardClipping = true;
                o.antiAliasing = true;
                o.horizontalScale = scale;
                o.verticalScale = scale;
                doc.exportFile(new File(tmp.fsName + "/mcp-export." + format), format === "png" ? ExportType.PNG24 : ExportType.JPEG, o);
            }
            var produced = __mcp_findFiles(tmp, format === "svg" ? /\.svg$/i : (format === "png" ? /\.png$/i : /\.jpe?g$/i));
            if (produced.length !== 1) {
                throw new Error("Illustrator reported no error but produced " + produced.length + " " + format + " files");
            }
            __mcp_replaceExport(produced[0], file, args.overwrite);
            exportComplete = true;
        } catch (e) {
            // Keep the original render even when staging or recovery failed.
            throw new Error(String(e.message || e) + "; original render retained at " + tmp.fsName);
        } finally {
            try { doc.artboards.setActiveArtboardIndex(priorActive); } catch (x) {}
            if (exportComplete) { __mcp_removeTree(tmp); }
        }

        var written = new File(file.fsName);
        if (!written.exists) { throw new Error("No file appeared at " + file.fsName); }
        return {
            path: written.fsName, format: format, artboard: abIndex,
            bytes: written.length, ms: new Date().getTime() - t0
        };
    }
};
