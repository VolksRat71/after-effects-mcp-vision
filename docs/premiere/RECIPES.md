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
edited. The list survives `reloadHost` but not a Premiere restart.

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
fades a clip in over a second. Values are dB. Premiere's scripting value for
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

The host was written against Premiere 26.0.2 and is unit-tested against fakes
of Premiere's DOM. What has been checked against the running app is recorded in
`test/verify-live-premiere.sh` and its last run's output; anything not covered
there is offline-only.
