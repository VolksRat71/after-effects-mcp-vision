/*
 * Layout: align, distribute, stack.
 *
 * Illustrator's Align panel is not reachable from scripting, so these are the
 * arithmetic, done once and done right. Everything measures GEOMETRIC bounds
 * by default - the Align panel's own default, with "Use Preview Bounds" off -
 * and bounds:"visible" switches to bounds that include stroke width.
 */

function __mcp_boundsOf(it, mode) {
    return mode === "visible" ? it.visibleBounds : it.geometricBounds;
}

function __mcp_union(list, mode) {
    var u = null;
    for (var i = 0; i < list.length; i++) {
        var b = __mcp_boundsOf(list[i], mode);
        if (!u) { u = [b[0], b[1], b[2], b[3]]; continue; }
        u[0] = Math.min(u[0], b[0]); u[1] = Math.max(u[1], b[1]);
        u[2] = Math.max(u[2], b[2]); u[3] = Math.min(u[3], b[3]);
    }
    return u;
}

function __mcp_layoutResult(doc, list, abIndex) {
    var out = [];
    for (var i = 0; i < list.length; i++) {
        out.push({ uuid: list[i].uuid, box: __mcp_boxFromBounds(doc, abIndex, list[i].geometricBounds) });
    }
    return { count: out.length, items: out };
}

var __mcp_layoutOps = {

    /*
     * edge: left, centerX, right, top, centerY, bottom, or center (both axes).
     * relativeTo: "selection" (the union of the items), "artboard", or a
     * key item's uuid, which stays put while the others move to it.
     */
    align: function (args) {
        var doc = __mcp_doc();
        var list = __mcp_items(args.uuids);
        var mode = args.bounds;
        var rel = args.relativeTo || (list.length > 1 ? "selection" : "artboard");
        var ref, abIndex;

        if (rel === "artboard") {
            abIndex = __mcp_artboardIndex(doc, __mcp_has(args.artboard) ? args.artboard : __mcp_artboardOf(doc, list[0].geometricBounds));
            ref = doc.artboards[abIndex].artboardRect;
        } else if (rel === "selection") {
            ref = __mcp_union(list, mode);
        } else {
            var key = __mcp_item(rel);
            ref = __mcp_boundsOf(key, mode);
        }
        if (!__mcp_has(abIndex)) { abIndex = __mcp_artboardOf(doc, ref); if (abIndex === null) { abIndex = undefined; } }

        var edge = args.edge;
        var edges = { left: 1, centerX: 1, right: 1, top: 1, centerY: 1, bottom: 1, center: 1 };
        if (!edges[edge]) { throw new Error("edge must be left, centerX, right, top, centerY, bottom or center"); }

        for (var i = 0; i < list.length; i++) {
            var it = list[i];
            if (rel !== "artboard" && rel !== "selection" && String(it.uuid) === String(rel)) { continue; }
            var b = __mcp_boundsOf(it, mode), dx = 0, dy = 0;
            if (edge === "left") { dx = ref[0] - b[0]; }
            if (edge === "right") { dx = ref[2] - b[2]; }
            if (edge === "centerX" || edge === "center") { dx = (ref[0] + ref[2]) / 2 - (b[0] + b[2]) / 2; }
            if (edge === "top") { dy = ref[1] - b[1]; }
            if (edge === "bottom") { dy = ref[3] - b[3]; }
            if (edge === "centerY" || edge === "center") { dy = (ref[1] + ref[3]) / 2 - (b[1] + b[3]) / 2; }
            it.translate(dx, dy);
        }
        return __mcp_layoutResult(doc, list, abIndex);
    },

    /*
     * by:"gaps" makes the space BETWEEN boxes equal - usually what "evenly
     * spaced" means for items of different sizes. by:"centers" spaces their
     * centres. The outermost two items stay put unless gap is given, in which
     * case the first stays put and the rest follow at exactly that gap.
     */
    distribute: function (args) {
        var doc = __mcp_doc();
        var list = __mcp_items(args.uuids);
        if (list.length < 2) { throw new Error("distribute needs at least 2 items"); }
        var mode = args.bounds;
        var horiz = (args.axis || "horizontal") === "horizontal";
        var by = args.by || "gaps";

        var lo = function (b) { return horiz ? b[0] : -b[1]; };
        var hi = function (b) { return horiz ? b[2] : -b[3]; };
        // Order by whatever is being spaced: by centres for "centers", so the
        // outer two CENTRES stay put even when a wide item starts further left.
        var key = function (it) {
            var bb = __mcp_boundsOf(it, mode);
            return by === "centers" ? (lo(bb) + hi(bb)) / 2 : lo(bb);
        };
        var sorted = list.slice(0).sort(function (a, c) { return key(a) - key(c); });

        var moveTo = function (it, start) {
            var d = start - lo(__mcp_boundsOf(it, mode));
            if (horiz) { it.translate(d, 0); } else { it.translate(0, -d); }
        };

        var i, b;
        if (by === "centers") {
            var c0 = (lo(__mcp_boundsOf(sorted[0], mode)) + hi(__mcp_boundsOf(sorted[0], mode))) / 2;
            var last = sorted[sorted.length - 1];
            var c1 = (lo(__mcp_boundsOf(last, mode)) + hi(__mcp_boundsOf(last, mode))) / 2;
            var stepC = __mcp_has(args.gap) ? Number(args.gap) : (c1 - c0) / (sorted.length - 1);
            for (i = 1; i < sorted.length; i++) {
                b = __mcp_boundsOf(sorted[i], mode);
                moveTo(sorted[i], c0 + stepC * i - (hi(b) - lo(b)) / 2);
            }
        } else {
            var gap;
            if (__mcp_has(args.gap)) {
                gap = Number(args.gap);
            } else {
                var total = 0;
                for (i = 0; i < sorted.length; i++) { b = __mcp_boundsOf(sorted[i], mode); total += hi(b) - lo(b); }
                var span = hi(__mcp_boundsOf(sorted[sorted.length - 1], mode)) - lo(__mcp_boundsOf(sorted[0], mode));
                gap = (span - total) / (sorted.length - 1);
            }
            var cursor = hi(__mcp_boundsOf(sorted[0], mode));
            for (i = 1; i < sorted.length; i++) {
                moveTo(sorted[i], cursor + gap);
                b = __mcp_boundsOf(sorted[i], mode);
                cursor = hi(b);
            }
        }
        var ab = __mcp_artboardOf(doc, sorted[0].geometricBounds);
        var res = __mcp_layoutResult(doc, list, ab === null ? undefined : ab);
        res.gap = by === "gaps" ? __mcp_round(gap) : undefined;
        return res;
    },

    /*
     * Lay items out in the order given: a row, a column, or a grid, starting
     * at x,y (artboard space) or where the first item already is. Cells in a
     * grid are the size of the largest item, and items sit top-left in them.
     */
    stack: function (args) {
        var doc = __mcp_doc();
        var list = __mcp_items(args.uuids);
        var mode = args.bounds;
        var dir = args.direction || "row";
        var gap = Number(args.gap || 0);
        var gapY = __mcp_has(args.gapY) ? Number(args.gapY) : gap;
        var abIndex = __mcp_artboardIndex(doc, __mcp_has(args.artboard) ? args.artboard : __mcp_artboardOf(doc, list[0].geometricBounds));
        var first = __mcp_boxFromBounds(doc, abIndex, __mcp_boundsOf(list[0], mode));
        var x0 = __mcp_has(args.x) ? Number(args.x) : first.x;
        var y0 = __mcp_has(args.y) ? Number(args.y) : first.y;

        var sizes = [], maxW = 0, maxH = 0, i;
        for (i = 0; i < list.length; i++) {
            var bx = __mcp_boxFromBounds(doc, abIndex, __mcp_boundsOf(list[i], mode));
            sizes.push(bx); maxW = Math.max(maxW, bx.width); maxH = Math.max(maxH, bx.height);
        }
        var cols = dir === "grid" ? Math.max(1, Number(args.columns || Math.ceil(Math.sqrt(list.length)))) : 0;

        var place = function (it, x, y) {
            var b = __mcp_boundsOf(it, mode);
            var target = __mcp_toDoc(doc, abIndex, x, y);
            it.translate(target[0] - b[0], target[1] - b[1]);
        };

        var cx = x0, cy = y0;
        for (i = 0; i < list.length; i++) {
            if (dir === "row") { place(list[i], cx, y0); cx += sizes[i].width + gap; }
            else if (dir === "column") { place(list[i], x0, cy); cy += sizes[i].height + gapY; }
            else if (dir === "grid") {
                var col = i % cols, row = Math.floor(i / cols);
                place(list[i], x0 + col * (maxW + gap), y0 + row * (maxH + gapY));
            } else { throw new Error("direction must be row, column or grid"); }
        }
        return __mcp_layoutResult(doc, list, abIndex);
    }
};
