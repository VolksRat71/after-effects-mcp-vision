# Premiere Pro: recipes and gotchas

## Addressing

- Project items (clips, stills, bins, sequences in the project panel) and
  timeline clips both carry a `nodeId`. Sequences carry a `sequenceId`.
- Tracks are named, not numbered from zero: `V1` is the bottom video track,
  `A1` the top audio track.
- Start every session with `pr_query sessionInfo`, then `pr_query tree`
  (the project panel) and `pr_query tree {sequenceId}` (one timeline).

## Time

- Every time is seconds on the sequence timeline and is snapped to the
  sequence's frame grid. Results carry both `seconds` and `frame`.
- Keyframe `at` is seconds from the clip's own first frame on the timeline,
  whatever the clip's source in-point is.

## The ownership guard

Every write refuses with `not_owned` on a project this bridge did not create or
open. That protects a project the user has open with unsaved work, which a
script cannot tell apart from its own changes. `pr_project adopt` lifts it for
the active project: use it only when the user asked for that project to be
edited. `open` refuses (`already_open`) a project that is already open, for the
same reason. The list survives `reloadHost` but not a Premiere restart.

## Keyframes are never deleted by accident

A fixed value on a property that has keyframes would delete them, so it is
refused with `keyframed`; pass `clearKeys:true` to mean it.

## The active sequence

QE and frame capture only see the active sequence. The bridge switches with
`openSequence` (which also brings that sequence's timeline tab forward), reads
it back, and switches back afterwards.

## Building an edit

1. `pr_project new {path}` (or `open`), then `pr_project import {paths}`.
   Media is referenced in place, never copied.
2. `pr_sequence create {name, preset}`. No dialog appears: the sequence is made
   from a `.sqpreset` through QE. `pr_query sequencePresets {match:"1080p"}`
   lists them.
3. `pr_clips insert {items:[{projectItem, track:"V1", at:0, duration:5}]}`.
   `duration` is how a still gets its length; `sourceIn`/`sourceOut` pick a
   range of a video clip. A video item brings its linked audio.
4. Look: `pr_capture frames {times:[0, 2.5, 5]}` puts several moments on one
   contact sheet.

## Photo moves

`pr_motion {items:[{nodeId, keys:[{at:0, scale:100}, {at:5, scale:115}]}]}`.
Position and anchor are pixels of the sequence frame from its top-left
(`[960, 540]` is the centre of 1080p); the host converts to the fractions
Premiere's scripting uses.

## Audio

`pr_audio level {items:[{nodeId, keys:[{at:0, value:-60}, {at:1, value:0}]}]}`
fades a clip in over a second. Values are dB; silence reads back as `null`. Premiere's scripting value for
Volume Level is a gain where +15 dB is 1.0 (0 dB is about 0.178); the host
converts both ways. Track faders are out of reach of the scripting API.

## Timeline files (FCP7 XML)

`pr_timeline import` brings in a Final Cut Pro 7 XML (`xmeml`) as a new
sequence; `export` writes one. Re-importing a revised XML into the same project
duplicates its media, so import each revision into a fresh bin or project.
`test/verify-live-premiere.sh` imports a small probe file and reports which
parts survive (tracks, a still with a duration, an audio level keyframe, a
cross dissolve, a marker, a Motion scale keyframe).

## Experimental (QE)

`pr_effects add` / `transition`, `pr_sequence addTracks` and `create` from a
preset, and `pr_capture` go through Premiere's undocumented QE DOM. Check the
result each time with `pr_query clip` or `pr_capture`.

## Verified live versus offline

`test/verify-live-premiere.sh` passed 34/34 on Premiere Pro 26.0.2 (macOS,
2026-11-21), through the real server with nothing stubbed:

- The headless server starts by itself about 20 s after Premiere launches; no
  panel click was needed.
- `pr_project` new, import (nodeIds returned), close with save; `open` of a
  closed project.
- `pr_sequence create` (QE, from a preset, no dialog) and `addTracks` (QE).
- `pr_clips` overwrite with a source range and a still duration landing on the
  exact frames; trim, move, lift with a per-item `unknown_clip` error.
- `pr_markers` chapter marker; `pr_motion` scale keys and `pr_audio` level keys
  read back at the clip-relative times and in dB. A capture one second into a
  50-to-80% scale move shows the card at 60%, so the keyframe time base is right.
- `pr_effects` list, transition (Cross Dissolve, QE), add (Gaussian Blur, QE)
  and params.
- `pr_capture` frame and a three-frame contact sheet; `pr_timeline` export and
  import; `pr_render` direct (a 1 s H.264 file) and queue through Media Encoder.
- The FCP7 XML probe: two video tracks, the tone, a still with a 150-frame
  duration, a cross dissolve, a marker, Motion scale keyframes and audio level
  keyframes all SURVIVED import (checked in Premiere's own re-export).

Learned live:

- QE does not follow `app.project`. After the first project was closed and a
  second created, QE still pointed at the closed one and its `newSequence`
  went there. Every QE call now re-attaches QE with `qe.project.init()` first
  and refuses with `qe_stale` if it will not follow. `pr_query sessionInfo`
  reports `qeProject`.
- In 26.0, "Gaussian Blur" is `AE.Impact_Blur_FX`; its strength parameter is
  `Amount`. Read names with `pr_query propertyKeys` rather than guessing.
- When Media Encoder starts cold, the first queued job's `status` can read
  `queued-or-running` until Media Encoder is up; check the file with `path`.

Offline only (unit tests against a fake DOM): `pr_project saveAs`, `adopt`,
`importAE`, `bin`; `pr_sequence duplicate`, `rename`, `setPlayhead`;
`pr_clips` insert (as opposed to overwrite), `rippleDelete`, `enable`/`disable`,
`link`/`unlink`; `pr_audio` mute; `pr_markers` update/delete and clip markers;
`pr_render` workArea range; the protected-folder and free-disk guards (unit
tests only, by design).
