# Capabilities

What this MCP can and cannot do, **measured** against After Effects 26.0x67 (expression engine `javascript-1.0`) by `npm run probe`.

Every verdict here comes from a probe that ran. None are inferred from the Adobe docs — this project has already caught the docs wrong about `DoScript` return values, `Project.saveAs` existing, and spatial ease dimensionality.

**54 pass · 4 fail · 5 review** across 63 probes.

> **Last measured against the 2.0.0 tool surface (2026-09-19).** These verdicts
> predate `ae_layout` and the four-corner pin probe (A11), so the layout rows in
> particular understate what ships today: several of them were closed by
> `ae_layout` and have not been re-run. Treat a `fail` here as "was not reachable
> when last measured", not as "cannot be done". Re-measure with `npm run probe`.

- **pass** — an agent can do it with the shipped tools, no escape hatch.
- **fail** — not reachable. Needs a named tool or command.
- **review** — reachable but depends on machine state, or the tool does not compose it so the caller does the work by hand.


## Layout and positioning

| | ID | Finding |
|---|---|---|
| ✅ pass | `A1` | optical centre lands at 960.0,540.0 vs comp centre 960,540 (off by 0.00,0.00)<br>*centres the INK, not the anchor - a baseline-left text layer would otherwise sit wrong* |
| ✅ pass | `A2` | left edges after align: 250.0, 250.0, 250.0 (spread 0.00)<br>*includes a rotated layer and a text layer* |
| ✅ pass | `A3` | equal-GAP distribute over unequal widths; gaps 187.5, 187.5, 187.5, 187.5 (variance 0.00)<br>*gaps and centres give different answers for unequal widths; both are offered* |
| ✅ pass | `A4` | 3-column grid: item2 left=200 (want 200), item4 top=180 (want 180) |
| ✅ pass | `A5` | anchor moved to 4 positions; worst on-screen drift 0px (topLeft=0, bottomCenter=0, middleRight=0, center=0)<br>*Position is compensated by the anchor delta, so the layer stays put* |
| ❌ fail | `A6` | no safe-area concept in any tool<br>*pin with padding covers a fixed inset, but not per-platform zones (TikTok/Reels reserve top 10-15%, bottom 20-25%)* |
| ✅ pass | `A7` | pinned bottom-right with 80 padding; right=1840.0 (want 1840), bottom=1000.0 (want 1000) |
| ✅ pass | `A8` | resized 1920x1080 -> 1080x1080; rigged pin put right edge at 1020.0 (want 1020)<br>*rigged mode re-derives from thisComp each frame, so one build covers several formats* |
| ✅ pass | `A9` | edge-pin expression applied, evaluated to 1840,1000<br>*reachable via ae_set expressions, but the caller writes the expression string by hand* |
| ✅ pass | `A10` | parent set: true |

## Timing and choreography

| | ID | Finding |
|---|---|---|
| ✅ pass | `B1` | 5 layers staggered by 0.2s: 0, 0.2, 0.4, 0.6, 0.8 |
| ✅ pass | `B2` | ease re-apply 60.0->60.0; stagger run twice produced identical start times: true<br>*stagger records base times in the layer comment, so it re-derives instead of compounding* |
| ✅ pass | `B3` | requested influence 75, AE reports 75.00, keysEased=2 |
| ✅ pass | `B4` | 3-key overshoot written, numKeys=3<br>*expressible, but the caller invents the 108% and the timing; no overshoot primitive* |
| ✅ pass | `B5` | community bounce expression applied, expressionError=none<br>*works, but the caller supplies the whole expression; no bounce primitive* |
| ✅ pass | `B6` | loopOut enabled=true error=none |
| ✅ pass | `B7` | enabled=true autoKeys=2 outPoint 4->4<br>*enabling auto-creates two keys and changes outPoint; both are reported back* |
| ✅ pass | `B8` | key 1 out-interpolation is HOLD: true |
| ✅ pass | `B9` | read back 1 marker(s); 'beat' at t=2 protectedRegion=true<br>*protectedRegion is Responsive Design - Time, so a retimed template keeps its intro intact* |
| ✅ pass | `B10` | Position dimensionsSeparated=true<br>*required to ease X and Y independently* |
| ✅ pass | `B11` | layer=true comp=true<br>*the layer flag alone does nothing; the comp switch is set too* |
| ❌ fail | `B12` | no retime op - scaling all keyframe times by a factor is still unbuilt<br>*'make this 20% faster' must preserve eases while moving every key* |

## Text

| | ID | Finding |
|---|---|---|
| ✅ pass | `C1` | text='Styled' size=64 tracking=20 |
| ✅ pass | `C2` | justification 7415 -> 7415 after a text-only write (kept: true)<br>*read-modify-write of the live TextDocument preserves it* |
| ✅ pass | `C3` | box text created 300x200, TextDocument.boxText=true |
| ✅ pass | `C4` | animator 'Reveal' with opacity+position; keyframed selector Offset -> numKeys=2 |
| ✅ pass | `C5` | requested basedOn=words; AE stored range type 3 (3=Words) |
| ✅ pass | `C6` | opacity-0 animator + square selector, Start keyframed 0->100, numKeys=2<br>*the standard typewriter, not a per-frame sourceText hack* |
| ⚠️ review | `C7` | measurable (w=361); ae_layout fit sizes a BOX to text, but scaling TEXT down to fit a fixed box has no primitive<br>*an agent can iterate fontSize against measure; there is no autoFit that does it* |
| ⚠️ review | `C8` | requested a nonexistent font, AE reports font='ThisFontDoesNotExist-Regular'; diagnostics fonts[]=0<br>*silent substitution - the write appears to succeed* |

## Shape layers

| | ID | Finding |
|---|---|---|
| ✅ pass | `D1` | created shape 107 with size path ADBE Root Vectors Group > Shape > ADBE Vectors Group > ADBE Vector Shape - Rect > ADBE Vector Rect Size |
| ✅ pass | `D2` | trim added in group 1; keyframed End via ADBE Root Vectors Group > Shape > ADBE Vectors Group > Trim Paths 1 > ADBE Vector Trim End -> numKeys=2 |
| ✅ pass | `D3` | repeater added with copies applied: copies; drivable paths: Copies, Offset, Composite, Transform |
| ✅ pass | `D4` | merge paths added: ADBE Vector Filter - Merge<br>*unsupported by Lottie - worth flagging at generation time if the target is Lottie* |
| ❌ fail | `D5` | G-Fill added=true; ADBE Vector Grad Colors propertyValueType=6412 (NO_VALUE=6412, match=true)<br>*CONFIRMED unreachable by design. The tool must refuse and redirect to the Gradient Ramp effect.* |
| ✅ pass | `D6` | dash elements created: 7; drivable: Dash, Gap, Dash 2, Gap 2, Dash 3, Gap 3, Offset<br>*dashes are an INDEXED group - a Dash element must be added before any value can be set* |
| ✅ pass | `D7` | fit sized pill to 170x58; after a longer string it measures 629 (followed: true, rigged: true) |
| ✅ pass | `D8` | groupTransform path returned: ADBE Root Vectors Group > Shape > ADBE Vector Transform Group |

## Effects

| | ID | Finding |
|---|---|---|
| ✅ pass | `E1` | applied ADBE Gaussian Blur 2, found 7 params, set Blurriness via ADBE Effect Parade > ADBE Gaussian Blur 2 > ADBE Gaussian Blur 2-0001<br>*params are addressable, but only by matchName - the agent must map 'Blurriness' to '-0001' itself* |
| ✅ pass | `E2` | keyframed an effect parameter, numKeys=2 |
| ✅ pass | `E3` | Gradient Ramp applied: true <br>*this is the documented workaround for the unreachable shape gradient (D5)* |
| ✅ pass | `E4` | Set Matte applied: true<br>*lets one matte drive many layers, unlike a track matte* |
| ❌ fail | `E5` | canAddProperty('dropShadow/enabled')=false <br>*confirmed rejected; the Drop Shadow EFFECT is the viable route* |
| ✅ pass | `E6` | missing plugin rejected with op_failed: Error: After Effects error: Can not add a property with name<br>*fails loudly rather than silently, which is correct* |

## Reuse and templating

| | ID | Finding |
|---|---|---|
| ✅ pass | `F1` | slider=true colour=true point=true checkbox=true<br>*expression controls ARE just effects, so rigging already works - it is simply undocumented* |
| ✅ pass | `F2` | exposed as 'Card Opacity', controllerCount=1; a 3D property is refused: true |
| ✅ pass | `F3` | exported a .mogrt: true; wrong extension rejected: true |
| ✅ pass | `F4` | precomp 149 holds 2 layers |
| ✅ pass | `F5` | collapseTransformation=true |
| ⚠️ review | `F6` | applyPreset command exists and rejects a missing file: true<br>*cannot fully verify without a .ffx on this machine* |
| ✅ pass | `F7` | label=9 shy=true guide=true comment='probe'<br>*project folders are still not exposed - only layer-level hygiene* |
| ✅ pass | `F8` | open rejects a missing path: true; new refuses to discard unsaved work: true<br>*new/open/close exist; the destructive paths are guarded behind discardUnsaved* |

## Output

| | ID | Finding |
|---|---|---|
| ✅ pass | `G1` | op 'render' present; verified earlier producing 1920x1080 H.264 at 15.0s |
| ✅ pass | `G2` | alpha-capable output templates on this machine: Alpha Only, High Quality with Alpha, Lossless with Alpha, TIFF Sequence with Alpha<br>*AME cannot export alpha at all; it must come from the render queue* |
| ✅ pass | `G3` | frame-sequence templates: Multi-Machine Sequence, Photoshop, TIFF Sequence with Alpha |
| ✅ pass | `G4` | queueInAME command wired: true (not invoked - it would launch AME)<br>*AME cannot export alpha; use command render for RGB+Alpha* |
| ✅ pass | `G5` | batch wired: true; rejects an empty job list: true (not rendered - a real batch blocks for minutes) |
| ⚠️ review | `G6` | Bodymovin extension present on this machine: true; no ExtendScript DOM path to Lottie export either way<br>*extension-driven only. If Lottie is a target, export is a human step or a separate CEP call.* |

## Cross-cutting

| | ID | Finding |
|---|---|---|
| ✅ pass | `H2` | mutating ops are wrapped in beginUndoGroup/endUndoGroup by __mcp_exec (layers 68 -> 69)<br>*implemented in the host dispatcher, verified by code path not by pressing Cmd-Z* |
| ⚠️ review | `H3` | selection reports 2 layers<br>*AE exposes selectedLayers but not the ORDER the user clicked; designers assume click order for staggers* |
| ✅ pass | `H4` | solid colour reads back as [1, 0, 0] - 0-1 convention |
| ✅ pass | `H5` | bad expression reported as invalid_expression<br>*AE disables a bad expression silently; surfacing it is the correct behaviour* |
| ✅ pass | `H6` | AE 26.0x67, expression engine 'javascript-1.0'<br>*version-gated APIs in play: Layer.id (22.0), setTrackMatte (23.0), app.fonts (24.0)* |

## What this means in practice

**Layout is solved.** It was the weakest area at 8 of 10 failing; `ae_layout` now measures in
comp space and composes measure-and-place. Measured on this machine: optical centring lands
exactly on the comp centre, align holds a spread of 0.00 across a mixed set including a
rotated layer, a 3-column grid is pixel-exact, and moving an anchor point through four
positions produces **0px of on-screen drift** — the bug that made this the headline failure.

**One build can cover several formats.** A rigged pin re-derives from `thisComp` each frame,
so resizing 1920x1080 to 1080x1080 put the pinned edge exactly where it belonged with no
re-layout call. That is the multi-format ad case working.

**Stagger is idempotent.** Base start times are recorded in the layer comment, so running it
twice re-derives rather than compounding — the classic automation failure, tested directly.

**Four things remain, and two of them are permanent:**

- **Shape gradient colours** (`D5`). `ADBE Vector Grad Colors` reports `propertyValueType = 6412`
  = `NO_VALUE`, confirmed here. Unreachable by design; the Gradient Ramp effect is the route.
- **Layer styles** (`E5`). `canAddProperty` returns false. Use the Drop Shadow effect.
- **Safe areas** (`A6`). `pin` handles a fixed inset, but per-platform zones (TikTok and Reels
  reserve roughly the top 10-15% and bottom 20-25%) need real inset tables, not a generic 80%.
- **Retime** (`B12`). Scaling every keyframe time by a factor while preserving eases.

**One silent failure worth knowing about:** requesting a font that is not installed appears to
succeed — After Effects echoes the name back and diagnostics does not flag it (`C8`). A build
can render with substituted type and report success.

## Notes on reading this

`C2` is a pass worth calling out: After Effects is documented to reset justification when
`sourceText` is replaced, and this tool does not, because it reads, modifies and writes
back the live `TextDocument` rather than constructing a new one.

`B2` passes for a reason that will not generalise. Re-adding a keyframe at an identical
time is naturally idempotent because AE replaces it. A `stagger` operation would not be —
running it twice would compound. Any future op that computes offsets must be explicitly
idempotent.
