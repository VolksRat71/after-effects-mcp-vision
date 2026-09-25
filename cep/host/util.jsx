/*
 * Addressing and coercion helpers.
 *
 * AE gives stable ids for two things and nothing else:
 *   Item.id   -> app.project.itemByID()   (AE 13.0+)
 *   Layer.id  -> app.project.layerByID()  (AE 22.0+, the manifest's version floor)
 *
 * Properties have NO id. They are addressed by a matchName PATH from their
 * layer - matchName being stable across AE versions and independent of UI
 * language, unlike the display name. So a property's identity here is the
 * synthesized pair (layerId, matchName path), and that is what every tool
 * takes and returns.
 */

/*
 * Capture output is confined to one app-owned directory and callers pass a bare
 * filename, never a path. Accepting an arbitrary outPath made this an arbitrary
 * file write: anything that could reach the RPC port could drop a PNG anywhere
 * the AE process can write, including startup script folders.
 */
function __mcp_captureDir() {
    var dir = new Folder(Folder.temp.fsName + "/ae-mcp-vision");
    if (!dir.exists) { dir.create(); }
    return dir;
}

function __mcp_safeCaptureFile(fileName) {
    if (!fileName) { throw new Error("capture requires fileName"); }
    fileName = String(fileName);
    if (fileName.indexOf("/") !== -1 || fileName.indexOf("\\") !== -1 ||
        fileName.indexOf("..") !== -1 || fileName.indexOf(":") !== -1) {
        throw new Error("fileName must be a bare filename with no path separators");
    }
    if (!/^[A-Za-z0-9._-]+\.png$/.test(fileName)) {
        throw new Error("fileName must match [A-Za-z0-9._-]+.png");
    }
    return new File(__mcp_captureDir().fsName + "/" + fileName);
}

// e.line is not always present and touching it can itself throw.
function __mcp_line(e) {
    try { return (e && e.line !== undefined) ? e.line : null; } catch (x) { return null; }
}

function __mcp_isCompItem(it) { return it instanceof CompItem; }

function __mcp_itemById(id) {
    var it = app.project.itemByID(Number(id));
    if (!it) { throw new Error("No project item with id " + id); }
    return it;
}

function __mcp_compById(id) {
    var it = __mcp_itemById(id);
    if (!__mcp_isCompItem(it)) { throw new Error("Item " + id + " is not a composition"); }
    return it;
}

function __mcp_layerById(id) {
    var l = app.project.layerByID(Number(id));
    if (!l) { throw new Error("No layer with id " + id); }
    return l;
}

/* Resolve a comp from explicit id, else the active item, else the first comp. */
function __mcp_resolveComp(args) {
    if (args && args.compId !== undefined && args.compId !== null) {
        return __mcp_compById(args.compId);
    }
    var p = app.project;
    if (__mcp_isCompItem(p.activeItem)) { return p.activeItem; }
    for (var i = 1; i <= p.numItems; i++) {
        if (__mcp_isCompItem(p.item(i))) { return p.item(i); }
    }
    throw new Error("No composition available - pass compId or open a comp");
}

/*
 * Walk a matchName path from a layer. Accepts an array of matchNames or a
 * single string. Falls back to display-name lookup only if the matchName misses,
 * because third-party effect params are not always addressable by matchName.
 */
function __mcp_propByPath(layer, pathParts) {
    if (typeof pathParts === "string") { pathParts = [pathParts]; }
    if (!pathParts || !pathParts.length) { throw new Error("Empty property path"); }
    var node = layer;
    for (var i = 0; i < pathParts.length; i++) {
        var seg = pathParts[i];
        var next = null;
        try { next = node.property(seg); } catch (e) { next = null; }
        if (!next) {
            throw new Error("No property '" + seg + "' at path position " + i +
                            " (from " + (node.name || "layer") + ")");
        }
        node = next;
    }
    return node;
}

var __MCP_PROPERTY_TYPE = {};
__MCP_PROPERTY_TYPE[PropertyType.PROPERTY] = "PROPERTY";
__MCP_PROPERTY_TYPE[PropertyType.INDEXED_GROUP] = "INDEXED_GROUP";
__MCP_PROPERTY_TYPE[PropertyType.NAMED_GROUP] = "NAMED_GROUP";

var __MCP_VALUE_TYPE = {};
(function () {
    var v = PropertyValueType;
    __MCP_VALUE_TYPE[v.NO_VALUE] = "NO_VALUE";
    __MCP_VALUE_TYPE[v.ThreeD_SPATIAL] = "ThreeD_SPATIAL";
    __MCP_VALUE_TYPE[v.ThreeD] = "ThreeD";
    __MCP_VALUE_TYPE[v.TwoD_SPATIAL] = "TwoD_SPATIAL";
    __MCP_VALUE_TYPE[v.TwoD] = "TwoD";
    __MCP_VALUE_TYPE[v.OneD] = "OneD";
    __MCP_VALUE_TYPE[v.COLOR] = "COLOR";
    __MCP_VALUE_TYPE[v.CUSTOM_VALUE] = "CUSTOM_VALUE";
    __MCP_VALUE_TYPE[v.MARKER] = "MARKER";
    __MCP_VALUE_TYPE[v.LAYER_INDEX] = "LAYER_INDEX";
    __MCP_VALUE_TYPE[v.MASK_INDEX] = "MASK_INDEX";
    __MCP_VALUE_TYPE[v.SHAPE] = "SHAPE";
    __MCP_VALUE_TYPE[v.TEXT_DOCUMENT] = "TEXT_DOCUMENT";
})();

function __mcp_valueTypeName(p) {
    try { return __MCP_VALUE_TYPE[p.propertyValueType] || String(p.propertyValueType); }
    catch (e) { return null; }
}

function __mcp_propTypeName(p) {
    try { return __MCP_PROPERTY_TYPE[p.propertyType] || String(p.propertyType); }
    catch (e) { return null; }
}

/* Values cross the wire as JSON. Arrays and numbers pass through; anything
   exotic (shape, text document) is described rather than serialized raw. */
function __mcp_readValue(p, time) {
    try {
        var vt = p.propertyValueType;
        if (vt === PropertyValueType.NO_VALUE) { return null; }
        var atTime = (time !== undefined && time !== null);
        if (vt === PropertyValueType.TEXT_DOCUMENT) {
            var td = atTime ? p.valueAtTime(time, false) : p.value;
            return { _type: "TextDocument", text: td.text, fontSize: td.fontSize, font: td.font };
        }
        if (vt === PropertyValueType.SHAPE) {
            // A summary, not the vertex list: a roto path can hold hundreds of points.
            var shp = atTime ? p.valueAtTime(time, false) : p.value;
            var sv = shp.vertices, l = null, t = null, r = null, b = null;
            for (var si = 0; si < sv.length; si++) {
                var x = sv[si][0], y = sv[si][1];
                if (l === null || x < l) { l = x; } if (r === null || x > r) { r = x; }
                if (t === null || y < t) { t = y; } if (b === null || y > b) { b = y; }
            }
            return { _type: "Shape", vertexCount: sv.length, closed: shp.closed,
                     bbox: sv.length ? [l, t, r, b] : null,
                     collapsed: sv.length > 0 && r - l < 1e-6 && b - t < 1e-6 };
        }
        if (vt === PropertyValueType.MARKER) { return { _type: "Marker", unsupported: true }; }
        var v = atTime ? p.valueAtTime(time, false) : p.value;
        if (v instanceof Array) {
            var out = [];
            for (var i = 0; i < v.length; i++) { out.push(Number(v[i])); }
            return out;
        }
        return (typeof v === "number") ? Number(v) : v;
    } catch (e) {
        return { _unreadable: String(e) };
    }
}

/*
 * The text AE shows for a value (AE 26.0+). For a popup parameter such as
 * Stroke's Paint Style this is the menu label ("On Transparent") where .value
 * is only an integer - an agent guessed that integer backwards and silently
 * discarded the footage under every highlight. Returned only when it is not
 * just the number again, so plain sliders stay quiet.
 */
function __mcp_valueLabel(p) {
    try {
        if (p.propertyValueType !== PropertyValueType.OneD) { return null; }
        var vt = p.valueText;
        if (vt === undefined || vt === null || vt === "") { return null; }
        vt = String(vt);
        if (/^\s*[+\-]?[\d.]/.test(vt)) { return null; }   // sliders, angles ("0x+0.0 deg"), "50.0 px"
        return vt;
    } catch (e) { return null; }
}

/*
 * TextDocument.font takes a PostScript name ("CourierNewPSMT"); agents and
 * people write the family ("Courier New") or "Family Style". app.fonts (AE
 * 24+) maps between them. Resolves in that order, preferring a Regular style
 * for a bare family, and fails with near matches rather than letting AE
 * reject or silently substitute.
 */
function __mcp_resolveFont(name) {
    var fonts = null;
    try { fonts = app.fonts; } catch (e) {}
    if (!fonts || !fonts.allFonts) { return name; }   // before AE 24: pass through
    try {
        var byPs = fonts.getFontsByPostScriptName(name);
        if (byPs && byPs.length) { return name; }
    } catch (e1) {}
    var want = name.toLowerCase(), family = null, full = null, near = [];
    var groups = fonts.allFonts;
    for (var g = 0; g < groups.length; g++) {
        var grp = groups[g];
        for (var f = 0; f < grp.length; f++) {
            var ft = grp[f], fam = String(ft.familyName), sty = String(ft.styleName);
            if ((fam + " " + sty).toLowerCase() === want) { full = ft.postScriptName; }
            if (fam.toLowerCase() === want) {
                if (!family || /^(regular|roman|book|normal)$/i.test(sty)) { family = ft.postScriptName; }
            }
            if (near.length < 8 && fam.toLowerCase().indexOf(want.split(" ")[0]) !== -1 &&
                ("|" + near.join("|") + "|").indexOf("|" + fam + "|") === -1) { near.push(fam); }
        }
    }
    if (full) { return full; }
    if (family) { return family; }
    throw new Error("No installed font '" + name + "' (tried PostScript name, family, and 'Family Style')" +
                    (near.length ? " - similar families: " + near.join(", ") : ""));
}

/* A popup's options, 1-based as AE stores them. Dropdown Menu Control is the
   one place AE exposes its own table (propertyParameters, 17.0.1+); built-in
   effect popups come from the generated table in effect-enums.jsx. */
function __mcp_enumOptions(p) {
    try {
        if (p.isDropdownEffect && p.propertyParameters) {
            var items = p.propertyParameters;
            var out = [];
            for (var i = 0; i < items.length; i++) { out.push(String(items[i])); }
            return out;
        }
    } catch (e) {}
    try {
        if (typeof __mcp_effectEnums !== "undefined" && __mcp_effectEnums.hasOwnProperty(p.matchName)) {
            return __mcp_effectEnums[p.matchName].slice(0);
        }
    } catch (e2) {}
    return null;
}

/*
 * Close the open project WITHOUT saving, so a later app.open()/newProject()
 * cannot trigger AE's suppressed "Save changes?" prompt - whose default
 * button is Save. See projectFile in ops-build.jsx.
 */
function __mcp_closeWithoutSaving() {
    try {
        if (app.project) { app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES); }
    } catch (e) {}
}
