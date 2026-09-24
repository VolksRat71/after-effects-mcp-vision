# Authoring recipes and gotchas

The tool schemas say what arguments exist. They cannot say that
`sourceRectAtTime` ignores Scale, or that a shape gradient is permanently
unreachable. That is what this file is for. It is served over MCP as
`ae-vision://recipes`.

Everything here was measured against a live After Effects session. Where a
verdict came from a probe, the probe id is cited.

---

## 1. The authoring chain

Creation and styling are separate calls. `ae_layers createText` takes only
`text` and `name` - no position, no size, no colour. That is deliberate: AE
models them as different property groups, and pretending otherwise would hide
where a write actually landed.

```
ae_layers createText   -> returns { id }
ae_set values          -> style it   (Source Text document)
ae_layout pin/align    -> place it   (Transform Position)
ae_animate keyframes   -> move it
ae_capture frame       -> look at it
```

**Always finish with `ae_capture`.** The object tree can be entirely correct
while the frame is wrong - a substituted font, a disabled expression and a
clipped layer all look fine in `propertyValues`.

---

## 2. `ae_set values` - the accepted value shapes

`value` is untyped in the schema because it depends on the property. The shapes
that are actually accepted:

| Property | Shape |
|---|---|
| Position, Anchor Point, Scale | `[x, y]` or `[x, y, z]` |
| Opacity, Rotation, any 1-D | a number |
| Colour (effects, shape fills) | `[r, g, b]` or `[r, g, b, a]`, **0-1 not 0-255** |
| Source Text | a string, **or** the document object below |

The Source Text document object - this is the one that is otherwise only
discoverable by triggering an error:

```json
{
  "text": "Share S'more Together",
  "fontSize": 96,
  "font": "HelveticaNeue-Bold",
  "fillColor": [1, 1, 1],
  "justification": "left",
  "tracking": -20,
  "leading": 104
}
```

Every field is optional except that you must pass either a bare string or this
object. `justification` accepts `left`, `center` (or `centre`) and `right`.

Setting a bare string rewrites `sourceText` wholesale, and AE is documented to
reset justification when that happens - pass the object form if you have
already styled the layer.

`font` is a **PostScript** name, not the menu name. A wrong name substitutes
silently; `ae_diagnostics problems` is the only thing that reports it.

### Batch shape

`ae_set` is batch-shaped and the array is called `writes`:

```json
{ "command": "values",
  "writes": [ { "layerId": 12, "path": ["ADBE Transform Group","ADBE Opacity"], "value": 50 } ] }
```

Passing the wrong key name used to return `appliedCount: 0` with an empty
`errors` array - a success-shaped reply for a no-op. Both `set` and
`setExpression` now reject an empty `writes`.

---

## 3. Measurement traps

`ae_layout measure` exists because `sourceRectAtTime` is wrong in four distinct
ways. If you call it yourself through an expression, you inherit all four.

- **It ignores the layer's own Scale.** It returns the *source* box, pre-transform.
  `measure` multiplies by Scale; a raw call does not.
- **It returns layer space, not comp space.** Anchor and Position have to be
  folded in, which is what the `left`/`top` fields of `measure` already do.
- **It desyncs on time-stretched or offset layers.** The correct call is
  `layer.sourceRectAtTime(layer.sourceTime(t), false)`.
- **It reports 0x0 on a freshly created shape layer** until AE has evaluated it.
  `measure` returns `reliable: false` for this; treat that as "try again after
  another write", not as "the layer is empty".

Accents and descenders change the ink box, so a pill sized to hug text will
jump between strings. Measure a fixed reference string if you need stability.

---

## 4. Static vs rigged layout

`ae_layout` commands take `mode: "static" | "rigged"`.

AE stores a property's **static value and its expression separately**, so the
tools write both: the solved pixel value first, then the expression on top. If
the expression errors it is removed and the baked value remains. Every failure
degrades to "correct but frozen", never to "destroyed".

Use **rigged** when one build has to survive a comp resize (16:9 to 1:1 to 9:16)
or a text change. Use **static** when the result is going to Lottie or Rive.

> **Rigged output does not survive export.** Rive ignores AE expressions
> entirely, and native Lottie players do not evaluate them either. Bake before
> delivery.

---

## 5. Writing expressions by hand

Assert the project is on the JavaScript engine before emitting anything modern.

Do **not** reference a layer by bare name from a repeated element - a rename
breaks it, and so does a camera changing the index. Use a `CTRL_*` null with a
Layer Control effect, and `index - firstIndex` for member maths.

Layout graphs must be one-way. AE's cycle detection means a mutual constraint
like `align-items: center` cannot be expressed; pick one layer as the
measurement source and derive the rest downstream.

---

## 6. ExtendScript hazards that produce silently wrong output

These bit this codebase and cost real debugging time.

- **A chained ternary split across newlines inside a string concatenation
  mis-associates.** `a ? x : b ? y : z` written over three lines took the wrong
  arm: `ae_layout pin topRight` generated the *bottom*-right expression while
  the baked value was correctly top-right. Use explicit `if`/`else`. Probe A11
  now pins all four corners, because the original probes only tested
  `bottomRight` - `f=[1,1]`, the one preset where both axes take the same branch
  and the bug cancels out.
- **The host is ES3.** No `const`/`let`, no arrow functions, no template
  literals, no `JSON` (there is a polyfill), and none of `map`/`filter`/
  `forEach`/`Object.keys`. `npm run lint` enforces this.
- **`"text " + errorObject` throws.** Always `String(e)`.
- **Spatial properties take one temporal ease, not one per dimension.** Position
  is spatial; Scale is not. Passing three eases to Position fails.

---

## 7. Known impossible

Do not promise these. Both are permanent, not missing features.

- **Shape-layer gradient colours.** `ADBE Vector Grad Colors` has
  `propertyValueType = NO_VALUE`, so the stops cannot be read or written from
  ExtendScript at all. Use the **Gradient Ramp effect** instead (D5).
- **Layer styles.** `addProperty` rejects them outright (E5).

Also worth knowing: the **Align panel is not scriptable**. `ae_layout align`
and `distribute` compute the arithmetic from measured bounds - they are not
wrapping an AE command, so they behave differently from the panel on rotated
layers.

---

## 7a. Roto and animated masks

Use `ae_masks setPathKeys`, never `setPath` in a loop. It writes a whole animated
path in one call and one undo step - a 693-frame, six-mask roto is 12 calls
(one `add` and one `setPathKeys` per mask), not ~4,000.

```json
{ "command": "setPathKeys", "layerId": 29, "maskName": "add_0", "hold": true,
  "keys": [ { "time": 0.0,     "vertices": [[654,1073], [660,1068], "..."] },
            { "time": 0.04167, "vertices": null } ] }
```

- **`time` is comp seconds** (`frame / fps`); **vertices are layer pixels**, the
  same space as `setPath`.
- **`hold: true`** for traced or tracked outlines. Their point count changes
  every frame, and linear interpolation between mismatched outlines morphs.
- **`vertices: null`** (or fewer than 3 points) marks a frame with nothing in
  it. The tool keys Mask Opacity to 0 there and back to 100 afterwards, always as
  holds, transitions only. It also collapses the path to a point on the first and
  last frame of each empty run: AE draws every mask outline on a selected layer
  whatever its opacity, so a held shape would clutter the viewer while the render
  stayed clean.
- **Holes** - the gap between an arm and a torso - are their own mask with
  `mode: "subtract"`, set on `add` or later with `setMode`. Inverting a mask is
  not the same thing.
- **Read keys from disk** with `keysPath` (absolute) instead of `keys`, so
  tracker output costs no tokens. `keysPointer` is a JSON pointer into the file
  (`"/add/0"`); per-frame vertex arrays take their times from `fps` (argument,
  node or file root). `{ "command": "setPathKeys", "layerId": 29,
  "maskName": "add_0", "keysPath": "/abs/shapes.json", "keysPointer": "/add/0",
  "hold": true }`
- **A call replaces its own time range.** Keys inside `[first, last]` that the
  call does not rewrite are removed, so a re-run gives exactly what was sent;
  `clearedPathKeys` and `opacityNumKeys` let you check. Split a big job by time
  range: each call owns the opacity keys in its range and hands back to the
  frame after it.
- **Check your work** with `ae_query propertyValues` and a `time`: a mask path
  reads as `{vertexCount, closed, bbox, collapsed}`.
- A request body is capped at 5 MB (about 490,000 integer vertices); `keysPath`
  has no such limit up to 50 MB of JSON.

## 8. Reloading after a host edit

CEP evaluates the ExtendScript host **once**, when the extension starts, so
editing a `host/*.jsx` file changes nothing in a running session. This caused a
long misdiagnosis: on-disk source and observed behaviour disagreed, and file
mtimes alone did not prove which code was compiled.

`ae_diagnostics {command: "reloadHost"}` re-evaluates the host from disk and
proves it: it reports `reloaded: true` only if the host's load stamp changed,
and otherwise says the host was not re-evaluated. (Before 2.0.4 it always said
`true` and reloaded nothing - `$.evalFile` inside a function defines everything
as locals of that function.) Changes to the **Node** side (`server/*.js`) still
need an After Effects restart.

A host file that fails to parse does not raise an error anywhere visible in
After Effects - the host simply never loads and every call times out. Run
`npm run lint`, which parses every `.jsx`, before reloading.
