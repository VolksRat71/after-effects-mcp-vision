/*
 * Diagnostics.
 *
 * AE has no project-problems API. "What is wrong with this project" has to be
 * assembled from three unrelated corners: app.fonts for substitutions, per-item
 * footageMissing, and per-property expressionError. This does that in one pass
 * so a model can self-correct without three round trips.
 */

var __mcp_diagnosticOps = {

    problems: function (args) {
        var p = app.project;
        var maxLayers = Number(args && args.maxLayers ? args.maxLayers : 400);
        var out = { missingFootage: [], fonts: [], expressionErrors: [], scanned: { items: 0, layers: 0 } };

        for (var i = 1; i <= p.numItems; i++) {
            var it = p.item(i);
            out.scanned.items++;
            try {
                if (it instanceof FootageItem && it.footageMissing) {
                    out.missingFootage.push({
                        id: it.id, name: it.name,
                        path: (it.mainSource && it.mainSource.file) ? it.mainSource.file.fsName : null
                    });
                }
            } catch (e) {}
        }

        try {
            if (app.fonts) {
                var missing = app.fonts.missingFonts || [];
                for (var m = 0; m < missing.length; m++) {
                    out.fonts.push({
                        state: "missing",
                        requested: String(missing[m].fontName || missing[m]),
                        replacement: missing[m].replacementFontName ? String(missing[m].replacementFontName) : null
                    });
                }
            }
        } catch (e) { out.fonts.push({ state: "unavailable", message: String(e) }); }

        // Expression errors live on properties, so this needs a bounded walk.
        for (var c = 1; c <= p.numItems && out.scanned.layers < maxLayers; c++) {
            var comp = p.item(c);
            if (!(comp instanceof CompItem)) { continue; }
            for (var L = 1; L <= comp.numLayers && out.scanned.layers < maxLayers; L++) {
                var layer = comp.layer(L);
                out.scanned.layers++;
                var props = [];
                __mcp_walkProps(layer, [], 1, 3, props, false);
                for (var q = 0; q < props.length; q++) {
                    if (props[q].expressionError) {
                        out.expressionErrors.push({
                            compId: comp.id, compName: comp.name,
                            layerId: layer.id, layerName: layer.name,
                            path: props[q].path, error: props[q].expressionError
                        });
                    }
                }
            }
        }

        out.healthy = (out.missingFootage.length === 0 &&
                       out.expressionErrors.length === 0 &&
                       out.fonts.length === 0);
        return out;
    }
};
