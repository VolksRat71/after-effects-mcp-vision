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
function __mcp_readValue(p) {
    try {
        var vt = p.propertyValueType;
        if (vt === PropertyValueType.NO_VALUE) { return null; }
        if (vt === PropertyValueType.TEXT_DOCUMENT) {
            var td = p.value;
            return { _type: "TextDocument", text: td.text, fontSize: td.fontSize, font: td.font };
        }
        if (vt === PropertyValueType.SHAPE) { return { _type: "Shape", unsupported: true }; }
        if (vt === PropertyValueType.MARKER) { return { _type: "Marker", unsupported: true }; }
        var v = p.value;
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

/* Dropdown Menu Control is the ONE place AE exposes an enum option table.
   propertyParameters landed in 17.0.1; valueText in 26.0. */
function __mcp_enumOptions(p) {
    try {
        if (p.isDropdownEffect && p.propertyParameters) {
            var items = p.propertyParameters;
            var out = [];
            for (var i = 0; i < items.length; i++) { out.push(String(items[i])); }
            return out;
        }
    } catch (e) {}
    return null;
}
