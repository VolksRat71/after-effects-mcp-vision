# Recipes and gotchas

How to build things in Illustrator through this server, and the traps that the
tool schemas cannot express. Every "measured" note below was observed on
Illustrator 30.8.1, not read off the scripting docs.

## The loop

1. `ai_query sessionInfo` - what is open, which artboards, their sizes.
2. `ai_query tree` (depth 1) - what is already there. **Reuse it.** Build into
   the document and layers the user has, not a new one.
3. Create and change with `ai_create`, `ai_set`, `ai_items`, `ai_layout`. Every
   create returns the item's uuid and its real box.
4. `ai_capture` - look at it. Do not judge a layout from numbers alone: a text
   box's width depends on the font, and overlaps only show up in pixels.
5. `ai_diagnostics` before handing off.

Each tool call is one undo step for the user (measured: a three-write `ai_set`
batch was reverted by a single Cmd-Z), so batch related changes into one call.

## Coordinates

**Artboard space: points, origin at the artboard's top-left, y grows DOWN** -
the numbers the rulers and Transform panel show. `x,y` is always the top-left
of the item's **geometric** bounds (the path, not including stroke).
`visibleBox` in responses includes stroke width.

Scripting's own frame is different: y grows UP, and on a new 800x600 document
the first artboard measured `[0, 600, 800, 0]`. The server converts; never pass
raw scripting coordinates.

Items on the pasteboard (on no artboard) report `artboard: null` and a box
relative to the active artboard, so a y of 900 on a 600pt artboard means
"300pt below it".

Artboard positions in `ai_document` are relative to artboard 0's top-left.
**The canvas is a fixed size** (16,383pt square). An artboard past its edge is
refused - measured: a ninth artboard to the right of a row ~8,200pt wide. Start
a new row below instead.
Artboard 0 cannot be moved or removed for that reason.

## Colour

- `"#RRGGBB"`, `"#RGB"`, or `[r, g, b]` on **0-255** - Illustrator's scale, not
  0-1.
- `{cmyk: [c, m, y, k]}` in percent. `{gray: n}` in percent.
- `{swatch: "Name"}` for a document swatch, including spot colours.
- `"none"` for no paint.

In a CMYK document an RGB value is converted by Illustrator. For print work use
CMYK or swatches directly.

Fill defaults to black and stroke to none on every create. Nothing inherits the
user's current toolbar colours.

## Text

- **Point text** (`kind: "text"`) is one line per paragraph and never wraps.
  `"\r"` starts a new paragraph.
- **Area text** (`kind: "areaText"`) wraps inside a box. When it does not fit,
  the rest is **hidden, not shrunk**, and a capture cannot show you what is
  missing. `ai_query item` reports `text.overflows`; `ai_diagnostics` lists
  every overflowing frame.
- **Point text re-anchors itself.** Illustrator anchors point text at its
  baseline point, so centring a 48pt line moved its box 113pt left (measured).
  The server puts the top-left back after every contents, size or
  justification change, so `x,y` keeps meaning top-left.
- **Reading text attributes needs one text range.** Asking a frame for
  `textRange` a second time invalidates attributes taken from the first
  (measured: "the value would result in an illegal text range"). The server
  handles it; anyone extending the host must too.
- **Fonts are addressed by PostScript name** (`Helvetica-Bold`, not
  `Helvetica Bold`). Look them up with `ai_query fonts {name: "helv"}`. A name
  that is not installed fails the call, and the half-made item is removed.
- **Never enumerate every font.** `app.textFonts` on this machine took longer
  than a 120s AppleEvent timeout to count. `ai_query fonts` requires a filter
  and stops at `limit`.

## Images

`ai_create` with `kind: "image"` places a png, jpg, psd, tif, svg, pdf or ai
file. Give `width` AND `height` to fit it inside that box, proportions kept and
centred - how a logo drops into a slot. It is **embedded** by default, so the
document does not break when it leaves this machine; `embed: false` links.

The response reports `scale`. Above 100 the file is being enlarged - a 170px
logo filling a 320pt slot came back at 188%, and will look soft. Tell the user
rather than guessing.

A logo PNG often carries transparent padding around the artwork, so it reads
smaller than its box. Compare it against its neighbours in a capture.

## Structure

- **Groups and compound paths have no paint of their own.** A fill on a group
  is applied to every path inside it.
- **Clipping mask:** `ai_items clip` with the mask shape's uuid FIRST. Use it to
  crop artwork to a shape without editing the artwork.
- **Ungroup** keeps the children's stacking order and returns their uuids.
- **`find` searches every item, including ones inside groups**, which carry
  `parentUuid`. Pass `topLevel: true` to get only what sits directly on a
  layer - the items to duplicate when copying a whole piece of artwork.
- **Rotation is relative only.** Illustrator does not store an absolute angle,
  so there is `rotateBy`, not "rotation = 30".
- **Resizing keeps stroke weight** unless `scaleStrokes: true`.

## Layout

Illustrator's Align panel is not scriptable, so `ai_layout` does the arithmetic.
It measures geometric bounds, like the Align panel with *Use Preview Bounds*
off; pass `bounds: "visible"` to include strokes.

- Evenly spaced items of different sizes: `distribute` with `by: "gaps"`.
- A row of cards with a fixed gutter: `stack` with `direction: "row", gap`.
- Centre one item on its artboard: `align` with `edge: "center"`, one uuid -
  a single item aligns to its artboard by default.

## Capture

- `imageCapture` cannot render below **72 ppi** (measured: 71 is refused with
  "Specified value less than minimum allowed value"). A large artboard is
  rendered at 72 and scaled down to `longEdge` in the extension, so the image
  size you get back is what you asked for.
- Captures render on mid grey by default, so "nothing drawn" is not mistaken
  for "white fill". Pass `background: "white"` to see it as it looks on screen.
- `item` with `isolated` (default) hides everything else for the shot and
  restores it. It answers "is this drawn at all, or just covered". Locked art
  (usually the background) is unlocked, hidden and relocked; a hidden target or
  hidden group around it is shown for the shot. Anything that still could not be
  hidden comes back in `couldNotHide`, and then `isolated` is `false`.
- `artboards` puts every artboard on one sheet - the cheapest way to review a
  set of ad sizes together.

## Export

- `ai_export` writes png, jpg or svg from one artboard. The path must be
  absolute and is never overwritten without `overwrite: true`.
- **SVG re-points the document if done the obvious way.** Measured:
  `exportFile(ExportType.SVG)` renamed the open document to the `.svg` and
  marked it saved - a later save would write somewhere the user never chose, and
  the unsaved-changes guard on close was disarmed. The server exports SVG
  through Export for Screens instead, which leaves the document alone.
- **No PDF**, for the same reason: scripting can only produce a PDF with
  `saveAs`, which re-points the document.
- **You get exactly the file name you asked for.** Illustrator itself does not
  write the name it is given - PNG export turned `Campaign Tech Award 2026.png`
  into `Campaign-Tech-Award-2026.png` - so every format renders into a private
  folder and is moved to your path. The overwrite guard is checked against that
  path, and nearby files such as `logo-old.png` are never touched or reported.
- Exporting switches the active artboard, which Illustrator counts as a change,
  so the document reads as unsaved afterwards even though no artwork changed.
- SVG references fonts by name; `outlineText: true` converts text to outlines in
  the file (not in the document).

## Safety rails

- **Uuids belong to one document.** They are small integers, so a uuid read in
  one document can name an unrelated item in another. Pass `document` (the name
  from `sessionInfo`) on any call and it is refused if a different document is
  active; every result reports the document it ran in.
- **Uuids do not survive closing and reopening a file.** Reopening the same
  saved `.ai` gives its items new uuids (measured on Illustrator 30.3.0: a
  headline went from 518 to 438), while the artwork and names are unchanged.
  Passing the same `document` name does not catch this. After any open or
  reopen, discard cached uuids and look items up again with `ai_query tree`
  or `ai_query find`; the new ones then stay stable through editing and export.
- `ai_document close` takes `name` to close exactly that document - without it,
  close acts on whichever is active.
- `ai_document close` refuses unsaved changes without `discardUnsaved: true`,
  and never saves on close.
- `ai_document save` without a path only works for a document that already has
  a file, and never overwrites without `overwrite: true`.
- `ai_layers delete` refuses a layer holding artwork - counting its
  sublayers - without `deleteContents: true`.
- A locked item refuses changes unless the same write sets `locked: false`.
- Creating into a locked or hidden layer fails with the layer's name.

## Developing

CEP loads the ExtendScript host once per start. After editing `cep/host/*.jsx`,
run `ai_diagnostics {command: "reloadHost"}`; it reports `reloaded: true` only
when the host was really re-evaluated. Changes under `cep/server/` or
`cep/client/` need an Illustrator restart.
