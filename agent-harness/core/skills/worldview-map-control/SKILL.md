---
name: worldview-map-control
description: Use when an answer should control the OpenSpy map, replay timeline, selections, filters, annotations, or camera.
allowed-tools: Bash(./tools/map-command.sh *) Bash(./tools/worldview-cli.sh *) Bash(./tools/source-fetch.sh *) Bash(./tools/sql-readonly.sh *) Bash(./tools/backend-api.sh *)
---

# Worldview Map Control Skill

Use this skill when the user should inspect a result on the globe or timeline.

## Preferred Pattern

1. Create or identify a selection with data tools.
2. Move the camera and replay clock only through explicit actions.
3. Return an `ACTIONS_JSON` block with one or more UI actions after the human
   explanation.
4. Keep the human-readable explanation separate from the machine actions.
5. Do not claim that a visual action already happened unless the user or
   browser executed it. Otherwise describe the action as prepared for the map.

The frontend renders action buttons from `ACTIONS_JSON`, and the user can click
those buttons. Each assistant answer with actions also gets one product-level
`Replay presentation` button that replays the actions in order. Individual
action buttons remain available for inspection.

When the user's request asks to show the result on the globe, replay a time
window, animate evidence, highlight/focus objects, filter layers, or prepare a
presentation, the answer must include `ACTIONS_JSON`. A prose-only answer is
not complete for a visual request. A normal investigation presentation contains
4-8 actions:
Do not emit a visible planning/status message before the investigation is
finished. If tools are needed to prepare the map or replay, keep the visible
assistant answer for the final report plus action block; the UI already shows
tool execution separately. Do not write partial findings and then continue
calling tools; finish the tool work first, then answer once.

- camera or context geometry: `map.fly_to`, `map.add_aoi`, `map.annotate` or
  `map.highlight`;
- relevant layer state: `map.set_layers`, `legend.set_node_state` and source
  or subtype visibility so the map shows the same evidence types the report
  discusses;
- group visibility: `selection.apply` when a selection exists, or
  `layer.filter` when the UI should create/apply a filter from a predicate;
- representative object: `object.open`, `object.focus` or `entity.open` for
  one concrete object cited in the report;
- time or motion: `replay.seek`, `replay.play_window`,
  `entity.animate_track` or `track.animate`;
- cleanup/end state: `selection.clear` when needed. Do not put
  `replay.pause`, `replay.stop`, seek, card-open, selection or filter actions
  after `replay.play_window`; the browser must be able to show visible motion,
  and the user can pause after motion is observed. Use
  `imagery.clear` only when the user explicitly asked to remove imagery or the
  intended final state is no-imagery.
  When the user asks to show imagery, the final selected imagery overlay must
  remain visible after replay/presentation completes.
  For opened/focused/followed moving objects, make the replay window reach that
  object quickly: `(first_opened_object_time - replay.play_window.from) / speed`
  should be comfortably under 30 seconds, preferably under 20 seconds. If
  uncertain, start the replay 3-10 minutes before the opened object's cited
  fix, not at the start of the broad analytic interval.
  After choosing the final `replay.play_window.from` and `to`, run an exact
  moving-object preflight for each opened/focused vessel, aircraft or satellite:
  `./tools/worldview-cli.sh replay evidence --entity <entity_id> --layer <layer> --from <final-from> --to <final-to>`.
  The exact final window must return `has_motion: true`, `fix_count >= 2` and
  non-identical coordinates for the representative object. Two near-identical
  fixes are not visual motion; choose the camera zoom and object so movement is
  understandable to a user, without relying on a hidden numeric threshold.
  Broad exploratory checks over a wider range do not validate a narrower
  replay window. If the check fails, change the window or choose another
  moving object before returning `ACTIONS_JSON`.
  Use the returned `first_fix_at` as the preferred `object.open.at` / inline
  entity-link time for the representative moving object. If you choose a later
  fix for the card, make sure `(object.open.at - replay.play_window.from) /
  speed` is under 30 seconds of wall-clock playback; otherwise move
  `replay.play_window.from` closer to that object or open the earlier fix.
  After opening individual moving objects, restore the shared view before
  playback: if `replay.play_window` is present, inspect the final action order
  and add a `map.fly_to` immediately before it whenever the previous
  camera-changing action is an object/card open. Multi-moving-layer replay must
  start from a shared AOI/corridor view, not from one vessel/aircraft card.
  For a historical map presentation with an explicit time window, include a
  `replay.play_window` action when temporal playback helps the user understand
  the evidence. Static-only event presentations may instead use
  `replay.seek`, selections, event links, highlights, AOIs, callouts and
  imagery overlays when those actions make the story clearer than playback.
  For static event layers such as fires, conflicts, outages or disasters, do
  not claim that events animate, appear by hour, pulse through the replay, or
  move on the timeline unless a visible OpenSpy tool or replay state confirms
  that those exact layers render inside the replay window. If you only have
  static selections, event links or imagery overlays, describe the replay as a
  temporal frame and say that the selected static evidence remains visible.

A presentation should be readable as a visual story, not only as a data dump.
For investigation or presentation-style requests, prefer visible AOIs, callouts
(`map.add_aoi`, `map.annotate`, or `map.highlight`) and representative
object/card actions when they make the case easier to follow. If the main evidence is a
vessel, aircraft or satellite track, also use `track.draw`,
`entity.track`, `track.animate` or `entity.animate_track` for a small
representative path unless the full replay already makes that exact object
visibly move. Enable and filter the relevant layers before the replay, so the
presentation does not rely on the user's current ad-hoc layer state. The
written report should state the story in plain steps:
what happened, where, what source supports it, what the map will show, and
what remains only a correlation.

For several small visual operations that belong to one narrative moment, use a
batch action instead of emitting many top-level buttons. Supported batch action
types are `presentation.step`, `presentation.group`, `presentation.sequence`,
`actions.batch` and `action.batch`. Put the nested action array in
`payload.actions` or top-level `actions`; include a short `label` and optional
`payload.narration`. The browser executes the nested actions in order when the
step is clicked or replayed. Keep large object sets behind selection handles;
batching is for UI actions, not bulk data transport.
For user-facing replay/presentation answers, use a few `presentation.step`
beats when it makes the visual story easier to follow. Each step should have a
short human label, a one-sentence `payload.narration`, and either coordinates on
the step payload or nested `map.annotate` / `map.highlight` / object actions
that anchor the step on the globe. Keep narration factual and brief; do not
repeat the full report in the overlay.

The visible answer should describe the intended visual story in normal product
language. The raw action contract is for the UI parser; users should see
buttons, a concise explanation and inline tool-call rows, not action JSON as
reading material.
Keep rendering terms user-facing: prefer "map layer", "satellite image",
"thermal fire overlay", "stored track", "selected group" and "replay window" in
prose. Put raw action types, bbox tuples, provider payload fields, WMS/WMTS
mechanics and exact status tokens inside links/actions or a compact
sources/limits note, not in the main narrative.
Do not include execution chatter such as "I have enough evidence", "building
the report", "now I will", or similar workflow narration in the final answer.
Do not leave empty Markdown fences or placeholder code blocks in the final
answer. Only include fenced blocks when they contain required machine-readable
content such as a valid `ACTIONS_JSON` block.

Use inline OpenSpy Markdown links for concrete references inside the prose.
`ACTIONS_JSON` is for full presentations and batched actions; it is not the only
interactive surface. The frontend does not infer object identity from free-form
text. If a vessel, aircraft, satellite, event, asset, AOI, replay window or
selection should be clickable, write an explicit link:

- `[object label](ospy://entity?entity_id=<id>&layer=<layer>&at=<iso>&lat=<lat>&lng=<lng>)`
- `[asset label](ospy://asset?asset_id=<id>&layer=<layer>&lat=<lat>&lng=<lng>)`
- `[event label](ospy://event?event_id=<id>&layer=<layer>&at=<iso>&lat=<lat>&lng=<lng>)`
- `[area label](ospy://map?type=map.fly_to&lat=<lat>&lng=<lng>&height=<meters>)`
- `[play window](ospy://replay?from=<iso>&to=<iso>&speed=32)`
- `[selection label](ospy://selection?selection_id=<selection_id>&layer=<layer>&mode=only)`
- `[imagery label](ospy://imagery?source=<nasa_gibs|copernicus|landsat|firms>&layer=<layer>&date=<iso-or-day>&opacity=0.72)`
- `[action label](ospy://action?type=map.highlight&lat=<lat>&lng=<lng>&label=<label>)`

Use URL encoding for IDs, timestamps and labels. Include exact IDs and
coordinates returned by tools when available. Preserve layer prefixes exactly:
`cable:abc`, `vessel:123`, `conflict:...`, `outage:...` are object IDs, not
display strings to shorten. Do not assume the UI will
autolink IMO, MMSI, ICAO, names, event IDs or asset IDs from plain text.
When the answer includes a map presentation, AOI, camera move, map filter or
visual replay, include an inline `ospy://map` Markdown link for the
investigation area. A `map.fly_to`, `map.add_aoi` or `layer.filter` action in
`ACTIONS_JSON` is not a substitute for the written area link.
When `ACTIONS_JSON` includes `replay.play_window`, include an inline
`ospy://replay` Markdown link for the same `from`, `to` and `speed` window.
The replay action creates the presentation button; the written replay link is
the user's direct clickable reference.
Use `payload_json` on `ospy://imagery` links when a scene requires nested
fields such as `scene`, `bbox`, `bbox_order`, `from` and `to`.
Copernicus/Sentinel imagery links must be complete executable links, not scene
labels. Include the bounded scene payload returned by
`copernicus-sentinel-imagery` with `source: "copernicus"`, `bbox`,
`bbox_order`, `from`, `to`, `layer` and opacity. A link with only `scene_id`,
`title` or `source=copernicus` is not enough for the browser to render the
image; use `payload_json` for the full scene payload.

Do not write browser/runtime status text in a normal OSINT answer. If the
user asks for validation results, report those separately from the analyst
answer.

Users normally speak in places and current-view phrases, not bbox coordinates.
For named places, use data tools such as `resolver region` to create the AOI.
For "here" or "this area", call
`./tools/worldview-cli.sh view request_context` and use the context
captured when the user sent the message.
Keep raw bbox/coordinates inside action payloads; describe the place naturally
in the report.
If the captured visible bbox is much wider than the task, narrow the AOI with
the named place, ground target, corridor/asset context, or `resolver region`
before querying and presenting the map state.

Keep raw bbox coordinates out of visible prose unless the user asks for exact
bounds or the coordinate values are analytically important.
Do not describe an AOI as a numeric longitude/latitude range in the report when
a place, corridor, asset cluster, or map link can name it naturally.

Multiple agent sessions may run at the same time. Only the currently active UI
session is allowed to execute visual actions on the map. Background sessions may
stream text and prepare actions, but their actions must not take over the globe
until the user switches to that session and clicks an action or presentation
button.

## Action Semantics

Actions are product UI instructions, not raw data transport. Keep each action
small and reference backend handles for groups.

- Camera actions: use `map.fly_to` to move the globe to an AOI or object. The
  payload accepts `lat`, `lng`, optional `height`, or `center: [lng, lat]`.
- Visual investigation geometry: use `map.add_aoi` for a bbox, circle,
  polygon, or GeoJSON area; use `map.add_corridor` for a line corridor. The
  alias `overlay.draw_geometry` is accepted for generic geometry overlays.
  These actions draw context on the globe and do not filter data by themselves.
- Text and emphasis: use `map.annotate` for a labeled note and `map.highlight`
  for a temporary point/geometry emphasis.
- Layer visibility: use `map.set_layers` when you know layer keys such as
  `maritime`, `aviation`, `jamming`, `cables`, or `pipelines`. The alias
  `layer.set_visibility` is accepted. Use `legend.set_node_state` when you know
  a semantic legend node such as `maritime/vessels`. The canonical payload is a
  `visibility` object such as
  `{ "visibility": { "maritime": true, "aviation": true, "jamming": true } }`;
  do not emit `visible: ["maritime", ...]`.
- Layer filtering: use `layer.filter` when a layer should be constrained by
  bbox, time, subtype, IDs, or geometry. The backend turns the filter into a
  saved selection handle and applies it to the map.
- Saved selections: use `selection.apply` with `layer`, `selection_id`, and
  optional `mode` to show a previously created group. Use `selection.clear` to
  remove it. A selection is the normal handle for a group of objects. For large
  groups, materialize the selection server-side and reference the
  `selection_id`; do not put the full object list into `ACTIONS_JSON`.
  Never invent a `selection_id` from prose. If a data/map tool did not return
  the handle in this run or a visible tool result, use `layer.filter` with the
  layer, bbox/time/predicate fields and let OpenSpy create the selection.
  When creating a selection through the CLI/API, prefer canonical JSON fields:
  `selectionId`, `layerId`, `selectionMode`, `predicate`, `metadata`.
  Put `bbox`, `from`, `to`, `ids`, `subtype`, `source_id` and other filters
  inside `predicate`, not as top-level fields. Selection predicate bboxes use
  `west,south,east,north`, the same order returned by `resolver region`.
- Object/card actions: use `object.open`, `object.focus`, or `entity.open` to
  select one object, optionally seek replay to `at`, and optionally fly to
  `lat`/`lng`.
  When the written report names a concrete vessel, aircraft, satellite, event,
  asset or infrastructure object as evidence, make that mention an explicit
  `ospy://entity`, `ospy://asset` or `ospy://event` Markdown link when you have
  a concrete ID. Also include at
  least one object/card action for a representative object when the full
  presentation should open a card. Use the exact object id returned by data
  tools, the observation timestamp and coordinates when available. This
  applies to aircraft and satellites as much as vessels: if a tool returned
  `lat`/`lng`, include those coordinates in the link/action so the browser can
  focus the object without guessing from its name or identifier.
  If the report elevates several concrete objects as key evidence, include
  object/card actions for the important ones or explicitly choose one as the
  representative card.
  Every concrete vessel, aircraft or satellite named with IMO, MMSI, ICAO,
  callsign or NORAD/COSPAR evidence identifiers must be an explicit `ospy://`
  Markdown link when a tool returned a matching object id.
  If linking every object would make the report too noisy, summarize the group
  count and link only representative objects instead of listing unlinked names.
  Every named infrastructure asset or event with a returned `asset_id` or
  `event_id` must use `ospy://asset` or `ospy://event`; a generic
  `ospy://action?type=map.highlight` link is only an extra visual emphasis, not
  the evidence object link.
  For vessel/aircraft-to-infrastructure proximity from `geo spatial_join`, the
  infrastructure object is in `right_id`, `right_label`, `right_layer_id`,
  `right_lat` and `right_lng`. If the report names that cable, pipeline or
  other infrastructure object, link it as
  `[right_label](ospy://asset?asset_id=<right_id>&layer=<right_layer_id>&lat=<right_lat>&lng=<right_lng>)`.
  Do not strip the layer prefix from `right_id`; if the tool returned
  `cable:ffaeddf8c005b14f`, the link must use that full value.
  Selection links and map highlights do not replace this concrete asset link.
  Distances from `geo spatial_join` are geometric proximity measurements from
  the moving fix to the returned infrastructure geometry, not distances to a
  representative point. Round sub-meter values to a readable statement such as
  "intersected the cable geometry" or "within <1 m"; do not report false
  precision like `0.001 m` in user-facing prose.
- Lightweight object presentation: use `entity.place` or `entity.show_marker`
  for a temporary marker; use `track.draw` or `entity.track` for a small track;
  use `track.animate` or `entity.animate_track` to animate one or a few objects
  without loading the whole replay world.
- Batched presentation steps: use `presentation.step` or `actions.batch` when
  one narrative beat needs multiple UI changes, such as add AOI + annotate +
  open one representative object. Do not put thousands of objects into the
  batch; create a selection or filter first and reference its handle. Include
  `payload.narration` for important presentation beats so the browser can show a
  readable step overlay with Previous/Next controls during replay.
- Imagery actions: use source tool `imagery-search-latest` for NASA
  GIBS/Worldview context imagery, `copernicus-sentinel-imagery` for bounded
  Sentinel scene search, `landsat-stac-imagery` for historical
  browse/thumbnail context, or `firms-fires` for FIRMS thermal/hotspot WMS
  context. Then use `imagery.show_layer` or `imagery.show_scene` from the
  returned action payload; use `imagery.compare` for before/after overlays;
  use `imagery.clear` only to remove imagery when the user explicitly asks for
  clearing/removal. Do not end a "show imagery" presentation by clearing the
  imagery.
- Replay actions: use `replay.seek` for one timestamp, `replay.play_window` for
  a time interval, `replay.set_speed` to change clock speed,
  `replay.follow_entity` to follow one selected object, and `replay.pause` or
  `replay.stop` only for explicit stop/pause requests or non-playing cleanup.
  Keep at least one visible moving replay segment in a presentation. Prefer
  opening representative cards before `replay.play_window`; do not place
  `replay.pause`, `replay.stop`, `replay.seek`, `object.open`, `object.focus`,
  `entity.open`, `asset.open`, `event.open`, `selection.apply`,
  `selection.clear` or `layer.filter` after `replay.play_window`, because those
  actions can halt, jump or visually replace the replay before motion has been
  observed.
  If you open a static event or asset card such as jamming, outage, fire,
  conflict, cable or pipeline before the moving replay, restore the camera
  before `replay.play_window`: add a `map.fly_to` for the AOI/corridor or an
  `object.focus`/`entity.open` for moving vessel/aircraft/satellite evidence.
  The last camera-changing action before `replay.play_window` must show the
  AOI or moving evidence, not a static event/asset card that narrows the replay
  viewport away from the moving objects.
  For multi-layer moving replay such as vessels plus aircraft, the last
  camera-changing action before `replay.play_window` must be a `map.fly_to`
  that covers the shared AOI/corridor. Do not leave the camera focused on a
  single vessel or aircraft before starting a multi-layer replay; that can hide
  the other moving layer.
  Concretely, if your action order ends `object.open`/`entity.open`/`track.draw`
  followed by `replay.set_speed` and `replay.play_window`, insert `map.fly_to`
  for the shared AOI/corridor between the object/card actions and playback.
  If the requested analysis window begins before the relevant replay objects
  exist, choose a replay sub-window inside the requested interval where the
  cited objects/events are visible and say that it is the visual sub-window.
  Do not play an empty beginning and pause before the evidence appears.
  If a concrete moving vessel, aircraft or satellite is opened or cited at a
  specific timestamp, start the play window close enough to that timestamp that
  the object appears within about 30 seconds of wall-clock playback at the
  chosen speed. Keep the wider user interval in the written analysis; use the
  replay action for the visual evidence segment.
  When the report names or summarizes multiple moving layers such as vessels
  and aircraft, include an `object.open`, `object.focus`, `entity.open` or
  `replay.follow_entity` action for one concrete representative object from
  each moving layer before `replay.play_window`. A layer filter or saved
  selection alone is not enough to show that layer's evidence object to the
  user.
  Verify the object can actually move in that visual segment before selecting
  it: vessels and aircraft need at least two `core.position_fixes` rows for the
  same `entity_id` inside the `replay.play_window` interval; satellites need
  replay-state/orbital evidence at two timestamps inside the interval. If a
  moving layer is required by the presentation, cite or open at least one
  concrete object from that layer that satisfies this check.
  Events outside that replay segment should be represented as static context:
  use explicit `ospy://event` links and, when useful, `event.open` or
  `map.highlight` before the play window. Do not imply those event layers are
  animated inside the moving replay segment unless their timestamps overlap it.

Backend state versus browser presentation:

- `selection.apply`, `selection.clear`, `layer.filter`,
  `legend.set_node_state`, `view.patch`, `map.set_layers`,
  `source.set_enabled` and `layer.set_visibility` are backend-backed view-state
  operations.
- Backend-backed view-state operations return `requested`, `effective`,
  `changed`, `explanation` and `state`. Use those fields when explaining why a
  semantic legend request affected multiple concrete layers or why a requested
  layer key was normalized.
- Camera, replay playback, object-card, annotation, track and imagery actions
  are executed by the active browser session from `ACTIONS_JSON`.
- If a CLI/map command reports `UNKNOWN_MAP_COMMAND`, use a supported action
  type instead of claiming the visual step is ready.

Every action should include `type`, `label`, and `payload`. Put coordinates,
layer names, IDs, time windows and handles inside `payload`.

`Replay presentation` is generated by the UI from the action array; do not
invent a separate `presentation.replay` action unless the product contract is
explicitly extended later.

## Choosing The Right Action

- Use `map.add_aoi` or `map.add_corridor` when the user needs to see the
  investigation geometry.
- Use `layer.filter` when the UI should show only records matching a bbox,
  time window, subtype, IDs, or geometry and the group can be represented as a
  saved selection.
- Use `selection.apply` when the user needs the map filtered to a found object
  set that already has a `selection_id`.
- Use `object.open` when the user should inspect one object's card at a known
  timestamp.
- Use `object.open` or `entity.open` after `layer.filter` when the
  presentation should both show a group and open a representative object from
  that group.
- Use `entity.track` or `entity.animate_track` when the agent has already
  identified a few concrete objects and needs to tell a visual story without
  loading every replay layer.
- Use `imagery.show_layer` or `imagery.show_scene` when the user needs fresh
  satellite context. NASA GIBS/Worldview is public daily context imagery.
  Copernicus Sentinel is a bounded scene-search/render path when credentials
  are configured: Sentinel-2 is optical true/false color, Sentinel-1 GRD VV is
  radar and should not be described as a natural-color photo. Landsat STAC
  browse/thumbnail overlays and FIRMS WMS thermal/hotspot overlays are
  executable when their source-fetch payloads are returned.
- Use `legend.set_node_state` for semantic legend nodes such as
  `maritime/vessels`; use `map.set_layers` only when you already know the exact
  layer keys.
- Use `view.patch` only for view-state changes that do not have a narrower
  action.

## Payload Notes

Use ISO timestamps in UTC. Do not use vague relative times in action payloads.

Common payload fields:

- `lat`, `lng`, `height` for `map.fly_to`.
- `from`, `to`, `speed` for `replay.play_window`.
- `at` for `replay.seek`.
- no payload is required for `replay.pause` or `replay.stop`.
- `entity_id` for `replay.follow_entity`.
- `entity_id`, `from`, `to`, optional `limit` and `stepSeconds` for track
  actions that fetch points from `/api/replay/track/:entityId`.
- `points`, `samples`, `track`, `items` or `coordinates` for track actions
  that already have sampled `[lng, lat]` coordinates.
- `source: "nasa_gibs"`, optional `scene_id`, `layer`/`gibsLayer`,
  `date`/`time`, and `opacity` for NASA GIBS imagery actions. Friendly layer
  aliases such as `modis_true_color`, `viirs_true_color`,
  `viirs_noaa20_true_color`, and `viirs_noaa21_true_color` are accepted by the
  UI.
- `source: "copernicus"`, `bbox` in `west,south,east,north` order,
  `bbox_order`, `from`, `to`, `layer`, `maxCloudCover` and `opacity` for
  Sentinel scene actions returned by source tools. The browser calls the
  backend render endpoint; do not include provider secrets in action payloads.
- `layer`, `selection_id`, `mode` for `selection.apply`.
- `layer`, `filter` or `predicate`, optional `bbox`, `from`, `to`, `ids`,
  `subtype`, `subtype_in`, `geometry`, `mode` for `layer.filter`.
- `label`, `lat`, `lng` or geometry fields for annotations/highlights.
- `bbox` as `[west, south, east, north]` for visual AOI/map payloads.
- `coordinates` as GeoJSON-style `[lng, lat]` pairs for corridor actions.
- `node`, `enabled`, `target` for `legend.set_node_state`.
- `visibility` or `sources` object for `map.set_layers`, for example
  `{ "visibility": { "maritime": true, "aviation": true } }`.

Use one bbox order across OpenSpy query, replay, imagery and map/AOI payloads:
`west,south,east,north`.

High replay speed means the replay clock advances faster. It must not mean
calling upstream providers more often or flooding the backend with requests.

Batching and groups:

- Do not embed large object arrays in `ACTIONS_JSON`.
- For object sets, use `layer.filter` when you only have predicates such as
  bbox/time/subtype/ids. Use `selection.apply` only after a tool returns a real
  `selection_id`.
- For large object sets, use data tool `selection materialize` before
  `selection.apply`. The browser receives a stable handle and can page details
  from the backend instead of receiving thousands of ids in the chat payload.
  If materialization returns `partial`, `truncated`, `has_more`, or a partial
  warning, state that limitation in the visible answer beside the affected
  finding.
- For areas, reference `geometry_ref` or provide compact bbox/GeoJSON.
- For tracks, reference `entity_id + from/to` or a compact sampled track.

## Example

The placeholders are a schema template; actual actions must use numeric
coordinates, real IDs and ISO timestamps returned by tools.

```text
<ACTIONS_JSON>
{
  "actions": [
    {
      "type": "layer.filter",
      "label": "Show selected vessels in the corridor",
      "payload": {
        "layer": "vessel",
        "bbox": ["<west>", "<south>", "<east>", "<north>"],
        "from": "<iso>",
        "to": "<iso>",
        "mode": "only"
      }
    },
    {
      "type": "object.open",
      "label": "Open representative vessel",
      "payload": {
        "entity_id": "vessel:example",
        "layer": "vessel",
        "at": "<iso>",
        "lat": "<lat>",
        "lng": "<lng>"
      }
    },
    {
      "type": "replay.play_window",
      "label": "Play relevant window",
      "payload": {
        "from": "<iso>",
        "to": "<iso>",
        "speed": 32
      }
    }
  ]
}
</ACTIONS_JSON>
```

## Full Investigation Action Example

The placeholders are a schema template; actual actions must use numeric
coordinates, real IDs and ISO timestamps returned by tools.

```text
<ACTIONS_JSON>
{
  "actions": [
    {
      "type": "map.fly_to",
      "label": "Go to investigation area",
      "payload": { "lat": "<lat>", "lng": "<lng>", "height": "<meters>" }
    },
    {
      "type": "replay.seek",
      "label": "Jump to first relevant point",
      "payload": { "at": "<iso>" }
    },
    {
      "type": "selection.apply",
      "label": "Filter to selected vessels",
      "payload": {
        "layer": "vessel",
        "selection_id": "sel:investigation:vessels",
        "mode": "only"
      }
    },
    {
      "type": "map.annotate",
      "label": "Add note",
      "payload": {
        "lat": "<lat>",
        "lng": "<lng>",
        "text": "Selected vessels inside the investigation area"
      }
    }
  ]
}
</ACTIONS_JSON>
```
