# Media Encoder: recipes and gotchas

## Start

`ame_diagnostics health` shows the relay in use and Media Encoder's build.
`ame_query presets {match:"H264"}` lists export presets (`.epr`); pass the path
as `preset`. `ame_query sessionInfo` lists the format names.

## Queue a file

```
ame_queue {command:"file", source:"/abs/in.mp4", preset:"/abs/H264 Match Source - High bitrate.epr", path:"/abs/out.mp4"}
```

Returns a `jobId` and starts the queue. `start:false` only queues; start later
with `ame_batch start`. Starting runs the whole Media Encoder queue, including
items you did not add.

## Queue a comp

Media Encoder renders the SAVED project, so save the .aep first.

1. `ame_query compItems {projectPath}` lists each comp's `guid` and `itemId`.
   Media Encoder hands back guids only, never names. Measured on a test project
   (one comp, After Effects item id 1): it returned one guid,
   `00000001-0000-0000-0000-000000000000`, and no solids. So the first 8 hex
   digits are the After Effects item id that `ae_query sessionInfo` shows for
   the comp; `itemId` is that number. Match guids to comps that way. A guid
   Media Encoder does not know is refused with `bad_guid` (it returned null for
   an unknown guid).
2. `ame_queue {command:"comp", projectPath, guid, preset, path}`. `comp` is an
   optional label that is only kept in the job record.

## Follow it

`ame_status` lists the newest 200 jobs this server queued as queued, encoding,
done, failed, stopped or cleared, with the output file and size, plus Media Encoder's batch
status and counters. Media Encoder's events carry no item id, so a job's state
is inferred from its output file and the batch status rather than reported per
item. A file that was already at the output path, or another format with the
same name that already existed, is never counted as the job's output. `done`
is only said while the batch is idle; while it runs a file is `encoding`.
After `ame_batch stop`, a job that was not already done shows `stopped`, and
after a failed encode the newest job shows `failed`; neither is listed as
finished.

`ame_status finished` lists jobs whose output is complete: the file is there,
its size did not change over a second, and Media Encoder is not still writing
it. It gives the size and sha256, computed here.

## The output extension

Some presets write `.mov` whatever extension you asked for. The status and
finished commands find the output by name with any extension, and report the
real path.

## Expression libraries render frozen

A comp whose expressions read a script or data file, for example
`footage("rig.jsx").sourceData`, renders frozen in Media Encoder. Media Encoder
and aerender use After Effects' headless engine, which returns nothing for
`.jsx`, `.js` and `.json` footage, silently: no error, the comp just does not
move. Code written inline in the expression works.

So `ame_queue comp` scans the project for any `footage("x.jsx")`, `.js` or `.json`
file and for `$.evalFile`, and refuses with `expression_library`, naming the files. Render
those comps in After Effects' Render Queue (`ae_render`). The scan covers the
whole project, not just the comp you queue, so one library anywhere refuses
every comp in it; `allowExpressionLibrary:true` overrides that when you know
the queued comp does not use it.

## Clearing

`ame_batch clear {all:true}` empties Media Encoder's whole queue, yours or not.
`stop` halts the running batch and leaves the items.
