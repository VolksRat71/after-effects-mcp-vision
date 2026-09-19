# Capabilities

What this MCP can and cannot do, **measured** against After Effects 26.0x67 (expression engine `javascript-1.0`) by `npm run probe`.

Every verdict here comes from a probe that ran. None are inferred from the Adobe docs — this project has already caught the docs wrong about `DoScript` return values, `Project.saveAs` existing, and spatial ease dimensionality.

**45 pass · 12 fail · 6 review** across 63 probes.

- **pass** — an agent can do it with the shipped tools, no escape hatch.
- **fail** — not reachable. Needs a named tool or command.
- **review** — reachable but depends on machine state, or the tool does not compose it so the caller does the work by hand.


## Layout and positioning

| | ID | Finding |
|---|---|---|
| ❌ fail | `A1` | no centre op; naive set leaves anchor at 0,0,0 while ink centre is 84.0,-12.9<br>*bounds is readable, but nothing composes measure+place. Caller does the maths.* |
| ❌ fail | `A2` | op 'align' present: false<br>*AE Align panel is not scriptable at all; this must be computed from sourceRectAtTime* |
| ❌ fail | `A3` | op 'distribute' present: false<br>*two valid semantics (equal gaps vs equal centres); neither is offered* |
| ❌ fail | `A4` | ops grid/stack present: false/false |
| ❌ fail | `A5` | layer left edge moved 400.0 -> 500.0 (jumped: true)<br>*ae_set moves the anchor with no Position compensation, so the layer visibly jumps* |
| ❌ fail | `A6` | no safe-area concept in any tool<br>*needs per-platform inset tables (TikTok/Reels reserve top 10-15%, bottom 20-25%), not a generic 80%* |
| ❌ fail | `A7` | op 'pin' present: false<br>*padding/inset from a comp edge is pure arithmetic the caller must do* |
| ❌ fail | `A8` | comp resize works (true) but no layer reflows<br>*multi-format delivery is P0 for ad work; resize alone letterboxes* |
| ✅ pass | `A9` | edge-pin expression applied, evaluated to 1840,1000<br>*reachable via ae_set expressions, but the caller writes the expression string by hand* |
| ✅ pass | `A10` | parent set: true |

## Timing and choreography

| | ID | Finding |
|---|---|---|
| ❌ fail | `B1` | op 'stagger' present: false<br>*the accordion build hand-computed N*3.75+0.25 across 48 keyframes* |
| ✅ pass | `B2` | ease influence 60.0 -> 60.0 on re-apply; re-adding same-time keys left numKeys=2<br>*AE replaces a key at an identical time, so add is naturally idempotent. A stagger op would not be.* |
| ✅ pass | `B3` | requested influence 75, AE reports 75.00, keysEased=2 |
| ✅ pass | `B4` | 3-key overshoot written, numKeys=3<br>*expressible, but the caller invents the 108% and the timing; no overshoot primitive* |
| ✅ pass | `B5` | community bounce expression applied, expressionError=none<br>*works, but the caller supplies the whole expression; no bounce primitive* |
| ✅ pass | `B6` | loopOut enabled=true error=none |
| ✅ pass | `B7` | enabled=true autoKeys=2 outPoint 4->4<br>*enabling auto-creates two keys and changes outPoint; both are reported back* |
| ✅ pass | `B8` | key 1 out-interpolation is HOLD: true |
| ✅ pass | `B9` | read back 1 marker(s); 'beat' at t=2 protectedRegion=true<br>*protectedRegion is Responsive Design - Time, so a retimed template keeps its intro intact* |
| ✅ pass | `B10` | Position dimensionsSeparated=true<br>*required to ease X and Y independently* |
| ✅ pass | `B11` | layer=true comp=true<br>*the layer flag alone does nothing; the comp switch is set too* |
| ❌ fail | `B12` | op 'retime' present: false<br>*'make this 20% faster' needs keyframe-time scaling that preserves eases* |

## Text

| | ID | Finding |
|---|---|---|
| ✅ pass | `C1` | text='Styled' size=64 tracking=20 |
| ✅ pass | `C2` | justification 7415 -> 7415 after a text-only write (kept: true)<br>*read-modify-write of the live TextDocument preserves it* |
| ✅ pass | `C3` | box text created 300x200, TextDocument.boxText=true |
| ✅ pass | `C4` | animator 'Reveal' with opacity+position; keyframed selector Offset -> numKeys=2 |
| ✅ pass | `C5` | requested basedOn=words; AE stored range type 3 (3=Words) |
| ✅ pass | `C6` | opacity-0 animator + square selector, Start keyframed 0->100, numKeys=2<br>*the standard typewriter, not a per-frame sourceText hack* |
| ⚠️ review | `C7` | bounds readable (w=361), but no fit op<br>*measurable, so an agent CAN iterate fontSize by hand; there is no autoFit primitive* |
| ⚠️ review | `C8` | requested a nonexistent font, AE reports font='ThisFontDoesNotExist-Regular'; diagnostics fonts[]=0<br>*silent substitution - the write appears to succeed* |

## Shape layers

| | ID | Finding |
|---|---|---|
| ✅ pass | `D1` | created shape 60 with size path ADBE Root Vectors Group > Shape > ADBE Vectors Group > ADBE Vector Shape - Rect > ADBE Vector Rect Size |
| ✅ pass | `D2` | trim added in group 1; keyframed End via ADBE Root Vectors Group > Shape > ADBE Vectors Group > Trim Paths 1 > ADBE Vector Trim End -> numKeys=2 |
| ✅ pass | `D3` | repeater added with copies applied: copies; drivable paths: Copies, Offset, Composite, Transform |
| ✅ pass | `D4` | merge paths added: ADBE Vector Filter - Merge<br>*unsupported by Lottie - worth flagging at generation time if the target is Lottie* |
| ❌ fail | `D5` | G-Fill added=true; ADBE Vector Grad Colors propertyValueType=6412 (NO_VALUE=6412, match=true)<br>*CONFIRMED unreachable by design. The tool must refuse and redirect to the Gradient Ramp effect.* |
| ✅ pass | `D6` | dash elements created: 7; drivable: Dash, Gap, Dash 2, Gap 2, Dash 3, Gap 3, Offset<br>*dashes are an INDEXED group - a Dash element must be added before any value can be set* |
| ⚠️ review | `D7` | measured text 122x34 and built a pill; caller did the padding maths and the centring<br>*possible but not composed: no op does measure->size->centre, and it does not follow a text change* |
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
| ✅ pass | `F4` | precomp 102 holds 2 layers |
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
| ✅ pass | `H2` | mutating ops are wrapped in beginUndoGroup/endUndoGroup by __mcp_exec (layers 43 -> 44)<br>*implemented in the host dispatcher, verified by code path not by pressing Cmd-Z* |
| ⚠️ review | `H3` | selection reports 2 layers<br>*AE exposes selectedLayers but not the ORDER the user clicked; designers assume click order for staggers* |
| ✅ pass | `H4` | solid colour reads back as [1, 0, 0] - 0-1 convention |
| ✅ pass | `H5` | bad expression reported as invalid_expression<br>*AE disables a bad expression silently; surfacing it is the correct behaviour* |
| ✅ pass | `H6` | AE 26.0x67, expression engine 'javascript-1.0'<br>*version-gated APIs in play: Layer.id (22.0), setTrackMatte (23.0), app.fonts (24.0)* |

## What this means in practice

**Layout is the weak point — 8 of 10 layout probes fail.** There is no align, no
distribute, no grid, no stack, no safe-area concept, and moving an anchor point jumps the
layer by exactly the anchor delta (`A5`: left edge went 400 → 500). Every layout decision
is absolute arithmetic the caller performs. This is why translating a Rive accordion
carried `419.18` through 48 hand-written keyframes.

**Shape geometry is half-built.** Creating shapes works; the *operators* that make shapes
useful in motion graphics do not exist — trim paths (draw-on), repeaters, merge paths,
dashes. All four are fully scriptable; they are simply not exposed.

**Text animators are absent entirely**, which rules out per-character and per-word
reveals — the most common text technique in this kind of work.

**Templating is closer than expected.** Expression controls already work, because they
are just effects (`F1`). Essential Graphics is fully scriptable and merely unexposed.

**Two things are permanently impossible, not merely missing:**

- **Shape gradient colours** (`D5`). `ADBE Vector Grad Colors` reports
  `propertyValueType = 6412` = `NO_VALUE`, confirmed on this machine. Stops cannot be read,
  written, or expressed. The Gradient Ramp *effect* is the only route, and it works (`E3`).
- **Layer styles** (`E5`). `canAddProperty("dropShadow/enabled")` returns false. Use the
  Drop Shadow effect.

**One silent failure worth knowing about:** requesting a font that is not installed
appears to succeed — After Effects reports the requested name back and diagnostics does
not flag it (`C8`). A build can therefore render with substituted type and report success.

## Notes on reading this

`C2` is a pass worth calling out: After Effects is documented to reset justification when
`sourceText` is replaced, and this tool does not, because it reads, modifies and writes
back the live `TextDocument` rather than constructing a new one.

`B2` passes for a reason that will not generalise. Re-adding a keyframe at an identical
time is naturally idempotent because AE replaces it. A `stagger` operation would not be —
running it twice would compound. Any future op that computes offsets must be explicitly
idempotent.
