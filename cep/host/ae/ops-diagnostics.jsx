/*
 * Diagnostics.
 *
 * AE has no project-problems API. "What is wrong with this project" has to be
 * assembled from three unrelated corners: app.fonts for substitutions, per-item
 * footageMissing, and per-property expressionError. This does that in one pass
 * so a model can self-correct without three round trips.
 */

var __mcp_diagnosticOps = {

    /*
     * Maintainer tool: build the popup option table (effect-enums.jsx).
     * AE has no API that lists a built-in popup's options; valueText only
     * names the CURRENT one. So each effect goes on a solid in a throwaway
     * comp and every popup is stepped 1, 2, 3... until AE clamps or refuses,
     * reading valueText each time. Run it in a scratch project: it adds and
     * removes a comp. Batched by offset/limit so one call stays short.
     */
    effectEnums: function (args) {
        var all = [];
        for (var e = 0; e < app.effects.length; e++) {
            var mn = app.effects[e].matchName;
            if (/^(ADBE|CC|APC) /.test(mn) || /^ADBE/.test(mn)) { all.push(app.effects[e]); }
        }
        var offset = Number(args.offset || 0), limit = Number(args.limit || 25);
        if (args.listOnly === true) {
            var names = [];
            for (var n = offset; n < Math.min(all.length, offset + limit); n++) {
                names.push({ index: n, matchName: all[n].matchName, name: all[n].displayName, category: all[n].category });
            }
            return { total: all.length, effects: names };
        }
        var results = {}, skipped = [];
        var comp = app.project.items.addComp("__mcp_enum_probe", 64, 64, 1, 1, 24);
        try {
            var solid = comp.layers.addSolid([0.5, 0.5, 0.5], "probe", 64, 64, 1);
            for (var i = offset; i < Math.min(all.length, offset + limit); i++) {
                var fxInfo = all[i], fx = null;
                // These open a window that beginSuppressDialogs cannot stop (a LUT
                // file picker) or start a long analysis the moment they are applied.
                var SKIP = { "ADBE Apply Color LUT2": "opens a LUT file picker", "ADBE Apply Color LUT": "opens a LUT file picker",
                             "ADBE 3D Tracker": "starts camera analysis", "ADBE SubspaceStabilizer": "starts stabilizer analysis",
                             "ADBE Samurai": "Roto Brush session" };
                if (SKIP.hasOwnProperty(fxInfo.matchName)) { skipped.push({ matchName: fxInfo.matchName, why: SKIP[fxInfo.matchName] }); continue; }
                try { fx = solid.property("ADBE Effect Parade").addProperty(fxInfo.matchName); }
                catch (ex) { skipped.push({ matchName: fxInfo.matchName, why: String(ex) }); continue; }
                if (!fx) { skipped.push({ matchName: fxInfo.matchName, why: "addProperty returned nothing" }); continue; }
                var params = {};
                var walk = function (g) {
                    for (var k = 1; k <= g.numProperties; k++) {
                        var p = g.property(k);
                        if (p.propertyType !== PropertyType.PROPERTY) {
                            if (p.matchName !== "ADBE Effect Built In Params") { walk(p); }
                            continue;
                        }
                        if (__mcp_valueLabel(p) === null) { continue; }
                        try { if (p.isDropdownEffect) { continue; } } catch (x0) {}
                        var orig = p.value, opts = [];
                        for (var v = 1; v <= 64; v++) {
                            try { p.setValue(v); } catch (x1) { break; }
                            if (p.value !== v) { break; }
                            opts.push(String(p.valueText));
                        }
                        try { p.setValue(orig); } catch (x2) {}
                        if (opts.length >= 2) { params[p.matchName] = { name: p.name, options: opts }; }
                    }
                };
                try { walk(fx); } catch (ex2) { skipped.push({ matchName: fxInfo.matchName, why: "walk: " + ex2 }); }
                var hasAny = false; for (var q in params) { if (params.hasOwnProperty(q)) { hasAny = true; break; } }
                if (hasAny) { results[fxInfo.matchName] = { name: fxInfo.displayName, params: params }; }
                try { fx.remove(); } catch (ex3) {}
            }
        } finally {
            var src = null;
            try { src = comp.layer(1).source; } catch (ex4) {}
            try { comp.remove(); } catch (ex5) {}
            try { if (src) { src.remove(); } } catch (ex6) {}
        }
        return { total: all.length, offset: offset, next: (offset + limit < all.length) ? offset + limit : null,
                 aeVersion: app.version, results: results, skipped: skipped };
    },

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

        /*
         * Expression errors live on properties, at ANY depth: a shape fill's
         * Opacity is five groups down and a text animator deeper still, which a
         * depth-3 walk never reached (AE flagged an error this reported as
         * healthy). AE also switches an expression off when it errors, so an
         * expression that is present but disabled is reported too. Bounded by a
         * property budget, not depth.
         */
        out.disabledExpressions = [];
        var budget = Number(args && args.maxProperties ? args.maxProperties : 200000), seen = 0;
        var scanGroup = function (g, path, hit) {
            var n = 0;
            try { n = g.numProperties; } catch (e) { return; }
            for (var k = 1; k <= n && seen < budget; k++) {
                var pr = null;
                try { pr = g.property(k); } catch (e2) { continue; }
                if (!pr) { continue; }
                seen++;
                var seg = null;
                try { seg = pr.matchName; } catch (e3) {}
                var here = path.concat([seg]);
                if (pr.propertyType === PropertyType.PROPERTY) {
                    var expr = "";
                    try { if (pr.canSetExpression) { expr = pr.expression; } } catch (e4) {}
                    if (expr) {
                        var err = "";
                        try { err = pr.expressionError; } catch (e5) {}
                        var enabled = true;
                        try { enabled = pr.expressionEnabled; } catch (e6) {}
                        if (err) { hit(here, err, expr, "error"); }
                        else if (!enabled) { hit(here, null, expr, "disabled"); }
                    }
                } else {
                    scanGroup(pr, here, hit);
                }
            }
        };
        for (var c = 1; c <= p.numItems && out.scanned.layers < maxLayers; c++) {
            var comp = p.item(c);
            if (!(comp instanceof CompItem)) { continue; }
            for (var L = 1; L <= comp.numLayers && out.scanned.layers < maxLayers; L++) {
                var layer = comp.layer(L);
                out.scanned.layers++;
                scanGroup(layer, [], function (path, err, expr, kind) {
                    var rec = { compId: comp.id, compName: comp.name, layerId: layer.id, layerName: layer.name,
                                path: path, expression: String(expr).slice(0, 200) };
                    if (kind === "error") { rec.error = err; out.expressionErrors.push(rec); }
                    else { out.disabledExpressions.push(rec); }
                });
            }
        }
        out.scanned.properties = seen;
        out.scanned.truncated = (seen >= budget || out.scanned.layers >= maxLayers);

        out.healthy = (out.missingFootage.length === 0 &&
                       out.expressionErrors.length === 0 && out.disabledExpressions.length === 0 &&
                       out.fonts.length === 0);
        return out;
    }
};
