---
name: worldview-data
description: Use for OpenSpy catalog, query, read-only SQL, layer status, entity/event/asset search, tracks, and OSINT data completeness checks.
allowed-tools: Bash(./tools/worldview-cli.sh *) Bash(./tools/source-fetch.sh *) Bash(./tools/sql-readonly.sh *) Bash(./tools/backend-api.sh *) Bash(./tools/map-command.sh *)
---

# Worldview Data Skill

Use this skill when the task requires data from OpenSpy.

## Order Of Operations

1. Before making source, imagery, storage or replay capability claims, or
   before calling provider operations, call
   `./tools/source-fetch.sh capabilities` so source/storage/replay/auth facts
   are visible.
2. Use provider-side source-fetch operations when they can materially test,
   corroborate, contradict, or visualize a source-backed conclusion. Available
   operations are candidates, not requirements.
   If an unexecuted source affects confidence, state the concrete reason it was
   not used, such as capability status, missing credentials, provider policy,
   time budget, user scope, or lack of material relevance. Do not imply that a
   source was checked unless the visible trace contains the call.
   Do not write that an available source can be checked later or by request
   after you made that source relevant in the answer. Either execute it, state
   a concrete current-run blocker, or omit it from the user-facing answer.
   Do not include a generic "what else to check" or "next sources" paragraph in
   normal product answers unless the user asks for next steps.
   Evaluate each available operation by what it directly observes, AOI/window
   support, freshness/history, resolution or granularity, auth state, provider
   limits, and whether its output can change the answer or visual story. Do not
   route from broad request categories. Use imagery when surface-visible context
   can help; use event/catalog sources when their event semantics match the
   claim; use network, GNSS, vessel, aircraft, satellite or orbital sources when
   those observed phenomena are material. Any available source operation may be
   used when you judge that it improves analysis, confidence assessment,
   contradiction checks or visualization. Do not claim a skipped source was
   checked.
3. Inspect catalog/status before analysis when layer/source availability is
   unclear.
4. Inspect local data coverage before choosing a historical replay window.
5. Use read-only SQL when it is the clearest way to analyze local data.
6. Use semantic CLI commands for stable product workflows such as selections,
   replay, source capability checks and common geospatial queries.
7. Report data limitations explicitly and attach them to the affected finding.
8. Treat missing rows as missing local coverage, not proof that no real-world
   event happened.
   Sparse or absent observations are still analytically useful when checked
   against controls. For live/current tracking layers, compare the AOI with
   global ingest recency, adjacent control areas, prior local baseline, or
   another relevant layer before interpreting the absence. If the AOI goes quiet
   while the control is alive, present it as an observed anomaly such as an
   suppressed signal, avoidance pattern, coverage gap, or operational
   disruption according to the source semantics. Do not make the main
   conclusion "there is no data"; extract the strongest insight supported by
   the pattern and put limitations after that insight.
9. Do not make provider-side absence claims for sources such as GFW,
   Cloudflare, ACLED or imagery unless a visible tool call checked that source
   or layer for the same AOI/window. If only local rows were queried, describe
   it as local OpenSpy coverage.
10. Keep the visible answer as a finished analyst report. Tool-call rows are the
   execution trace; prose should focus on evidence, conclusions, confidence and
   next visual actions.
11. Do not use provider file tools or create temporary files during product
   OSINT analysis. Use direct `--sql "select ..."` arguments for SQL.

When source or imagery capability matters, use the visible
`source-fetch capabilities` tool result before saying what can be fetched.
Do not rely on prompt bootstrap blocks for capabilities.
The default capabilities result is compact; it includes all operations plus
active, auth-relevant or source-fetch-relevant sources. Request
`source-fetch capabilities --detail full` only for the verbose operator matrix
for every catalog source.
In product OSINT runs, call one direct OpenSpy entrypoint per Bash tool call.
Do not pipe, redirect, chain commands, create temporary files, or read internal
harness `tool-results`, `/private/tmp/*/tasks/*.output`, or similar files to
post-process JSON.
When the shell tool supports a wait/yield parameter, give OpenSpy CLI commands
enough time to finish, normally at least 10 seconds. If a command returns a live
session id or says it is still running, poll that same session with the shell
continuation tool until it reaches a terminal exit code before using the
result, starting dependent commands, or finalizing the answer.
Python/jq are acceptable only when the active harness explicitly grants them as tools; otherwise use the visible JSON result or a semantic OpenSpy command.
If a source result was clipped or unclear, rerun the relevant OpenSpy tool with a
narrower AOI/window/query instead of reading internal task files.

For local-data investigations, do not start from an arbitrary public
incident date unless the task is explicitly about missing provider history. Use
`coverage report` to find time windows where local evidence actually exists
only when the user did not provide a concrete time window or when you are
choosing an illustrative covered example.

If the user gives an explicit time window, use that window and check local
coverage for it with targeted `query search`, `query aggregate`,
`query timeline`, `query live-status` or read-only SQL for the named layers and
area. Do not start with global `coverage report` for a normal user
investigation that already names a place and time. Do not silently replace the
requested interval with another interval. If coverage is too thin, say that
directly and then propose a nearby covered interval only as a separate option.

When citing named vessels, aircraft, satellites, events or assets as evidence
for an explicit historical window, use records from that same window. Do not
answer an in-window evidence request with latest/live rows from another date
unless you clearly separate them as current-context data with their own
timestamp.

When the user names a place, use `resolver region` instead of asking for
coordinates. When the user says "here", call
`./tools/worldview-cli.sh view request_context`; it returns the current
camera, ground target and visible bbox captured at Send time.
Use one primary analysis AOI for the main findings, counts, selections and
replay. This is an analyst-chosen evidence scope for the current run, not a
fixed product boundary. Derive it from the user's explicit place, current view
context, selected object/corridor, or resolver output for the named place. You
remain free to widen, narrow or add controls when the evidence requires it; just
keep the main counts tied to the primary AOI you report.
Sub-AOIs are allowed for chokepoints, port approaches, anchorages or corridors,
but label them as sub-AOIs and do not compare or merge counts from different
AOIs as if they were the same evidence set.
If the visible bbox is much wider than the task, narrow the AOI with the named
place, ground target, corridor/asset context, or `resolver region` before
making local data claims. Keep raw bbox tuples and numeric AOI coordinate
ranges out of visible prose unless the user asks for exact coordinates.

For user-facing OSINT answers, make the first screen product-readable:
state what happened or what the data shows, separate corroborated findings from
single-source/uncertain claims, then say what was put on the map or replay.
Put provider mechanics, policy fields, CLI names, raw counts and detailed
limitations after the main conclusion. Do not expose bbox tuples or source
payload parameters in link text; keep them inside `ospy://` URLs or
`ACTIONS_JSON`. Only describe visual steps that are backed by a matching
map/replay action or inline `ospy://` link in the same answer.
When source/tool status matters, translate it for a product user first: say the
connector is unavailable, credentials/access are missing, the provider only
offers a coarser granularity, or the image is a preview/context layer. Raw
tokens such as `auth_required`, `WMS`, CLI command names, payload keys and
provider policy fields belong only in a short sources/limits note when they
change the confidence statement.

## Canonical Storage Summary

Schemas:

- `catalog`: source, layer, field, relation and UI taxonomy metadata.
- `raw`: ingest runs and raw payload capture where the source contract allows
  it.
- `core`: normalized intelligence data.
- `app`: source/layer state, selections, view state, render metadata, Wi-Fi tile
  state and agent sessions.

Core tables:

- `core.entities`: stable moving or named things.
- `core.entity_aliases`: identifiers such as IMO, MMSI, ICAO24, callsign,
  NORAD ID, COSPAR ID and source-specific aliases.
- `core.position_fixes`: observed positions for aircraft and vessels.
- `core.entity_snapshots`: historical descriptive state for entities.
- `core.events` and `core.event_snapshots`: discrete events such as fires,
  conflicts, disasters, outages, jamming and GFW events.
- `core.assets` and `core.asset_snapshots`: static or versioned infrastructure
  such as airspace, cables, pipelines, borders and Overture-derived assets.
- `core.observations`: metric or gridded observations.
- `core.orbital_elements`: TLE/OMM snapshots for satellite replay.

Runtime tables that matter to agents:

- `app.entity_live_states`: latest known entity position for live/latest search.
- `app.layer_runtime_states`: source/layer status.
- `app.selections`: saved object selections.
- `app.view_states`: persisted map/control-plane state.
- `app.feature_metadata_cache`: details-on-click cache; historical key includes
  layer and `as_of`.

Do not query internal agent transcript tables through SQL:
`app.agent_sessions`, `app.agent_messages`, `app.agent_runs`,
`app.agent_run_events`.

Geometry storage:

- `core.entities` does not store geometry. Do not use `e.geom` or
  `ST_PointOnSurface(e.geom)` on `core.entities`. Join to
  `core.position_fixes`, use `app.entity_live_states`, or call semantic
  `query track`, `query live-status`, `query search` or `replay evidence`
  tools when an entity coordinate is needed.
- `core.position_fixes` stores moving coordinates only in `geom`
  (`geometry(Point, 4326)`).
- There are no `lat` or `lng` columns on `core.position_fixes`.
- Use `ST_Y(pf.geom) AS lat` and `ST_X(pf.geom) AS lng` for coordinates.
- Do not use `MIN(pf.geom)`, `MAX(pf.geom)`, `MIN(geom)` or `MAX(geom)`;
  geometry has no meaningful min/max aggregate. For a representative grouped
  fix coordinate, use a concrete ordered geometry such as
  `ST_Y((array_agg(pf.geom ORDER BY pf.observed_at))[1]) AS sample_lat` and
  `ST_X((array_agg(pf.geom ORDER BY pf.observed_at))[1]) AS sample_lng`, or
  use semantic `query track` / `replay evidence` tools.
- For bbox predicates, use
  `ST_Intersects(pf.geom, ST_MakeEnvelope(west, south, east, north, 4326))`.
- Events/assets/areas/lines use `geom` too; use `ST_PointOnSurface(geom)` when
  a representative point is needed for non-point geometry.

Alias storage:

- `core.entity_aliases` columns are `entity_alias_id`, `entity_id`,
  `alias_type`, `alias_value` and `created_at`.
- There is no `alias_kind` column.
- There is no `source_id` column on `core.entity_aliases`; join back to
  `core.entities` when source information is needed.
- Use `alias_type` for identifiers such as `imo`, `mmsi`, `icao24`,
  `callsign` and `norad_id`.

Agent-facing core column reference:

- `core.entities`: `entity_id`, `layer_id`, `source_id`, `entity_kind`,
  `subtype`, `display_name`, `first_observed_at`, `last_observed_at`,
  `properties`, `created_at`, `updated_at`, `latest_snapshot_id`.
- `core.position_fixes`: `position_fix_id`, `entity_id`, `layer_id`,
  `source_id`, `observed_at`, `geom`, `altitude_m`, `heading_deg`,
  `speed_mps`, `properties`, `created_at`.
- `core.events`: `event_id`, `layer_id`, `source_id`, `event_kind`,
  `subtype`, `observed_at`, `valid_from`, `valid_to`, `geom`, `properties`,
  `created_at`, `updated_at`, `first_observed_at`, `last_observed_at`,
  `latest_snapshot_id`.
- `core.event_snapshots`: `event_snapshot_id`, `event_id`, `ingest_run_id`,
  `layer_id`, `source_id`, `event_kind`, `subtype`, `observed_at`,
  `valid_from`, `valid_to`, `geom`, `properties`, `created_at`,
  `geom_render_low`.
- `core.assets`: `asset_id`, `layer_id`, `source_id`, `asset_kind`,
  `subtype`, `display_name`, `geom`, `properties`, `created_at`,
  `updated_at`, `first_observed_at`, `last_observed_at`,
  `latest_snapshot_id`, `geom_render_low`.

There is no `canonical_name` column on entities or assets. Use
`display_name`. When joining tables that share common column names, qualify
columns with table aliases: `pf.observed_at`, `e.display_name`,
`es.properties`, `ev.layer_id`, and so on.

## Replay Semantics

- Aircraft and vessels replay from stored `core.position_fixes`.
- For a vessel or aircraft object used as visible replay evidence, verify at
  least two `core.position_fixes` rows for the same `entity_id` inside the
  visual `replay.play_window` interval and verify that the coordinates are not
  identical. One fix can open a card, and two near-identical fixes can prove
  presence, but neither is enough to prove visually useful motion in replay.
- Satellites replay from `core.orbital_elements`; positions are computed for a
  replay timestamp from the newest orbital element epoch `<= T`.
- Static assets replay from versioned asset snapshots when available; many
  infrastructure layers are effectively static for current product use.
- Events replay from event snapshots and validity windows.
- Live-only/context layers do not block replay hydration.

Satellite positions should be queried through `replay state`, not through normal
latest entity search. A latest entity query can return zero satellites even when
replay can compute satellite positions from TLE data.

## Commands

```bash
./tools/worldview-cli.sh layers list
./tools/worldview-cli.sh sources list
./tools/worldview-cli.sh sources status
./tools/worldview-cli.sh sources describe --source <source_id>
./tools/worldview-cli.sh diagnostics list_layer_statuses
./tools/worldview-cli.sh diagnostics get_layer_status --layer <layer>
./tools/worldview-cli.sh coverage report
./tools/worldview-cli.sh catalog describe --layer <layer>
./tools/worldview-cli.sh resolver region --query "<place name>"
./tools/worldview-cli.sh resolver entity --query <imo|mmsi|icao|name>
./tools/worldview-cli.sh geometry create_aoi --bbox "<west>,<south>,<east>,<north>" --label "<name>"
./tools/worldview-cli.sh query search --kind entities --layer vessel --limit 20
./tools/worldview-cli.sh query live-status --layer vessel --bbox <west,south,east,north> --freshnessMinutes 30 --limit 20
./tools/worldview-cli.sh query aggregate --kind entities --layer vessel --group_by hour
./tools/worldview-cli.sh query timeline --kind events --layer outage --group_by hour --limit 20
./tools/worldview-cli.sh query related --id <entity_id|event_id|asset_id> --radius_m 50000 --limit 20
./tools/worldview-cli.sh query track --entity <entity_id> --from <iso> --to <iso>
./tools/worldview-cli.sh query satellite-overpasses --bbox <west,south,east,north> --from <iso> --to <iso> --step-seconds 180 --limit 20
./tools/worldview-cli.sh replay state --at <iso> --layers satellite --layerLimits satellite:20
./tools/worldview-cli.sh replay evidence --entity <entity_id> --layer <vessel|aircraft|satellite> --from <iso> --to <iso>
./tools/worldview-cli.sh geo nearest --kind assets --lat <lat> --lng <lng> --layer cable --limit 20
./tools/worldview-cli.sh geo corridor --kind assets --coordinates '[[lng,lat],[lng,lat]]' --radius_m 50000
./tools/worldview-cli.sh geo spatial_join --left_kind events --left_layer outage --right_kind assets --right_layer cable --radius_m 100000 --limit 20
./tools/worldview-cli.sh geo simplify --kind assets --layer cable --tolerance_m 500 --limit 20
./tools/worldview-cli.sh selection create --json '<json>'
./tools/worldview-cli.sh selection preview --selection <selection_id>
./tools/worldview-cli.sh selection materialize --selection <selection_id>
./tools/worldview-cli.sh selection items --selection <selection_id> --limit 100
./tools/worldview-cli.sh selection items --selection <selection_id> --limit all
./tools/worldview-cli.sh legend tree
./tools/worldview-cli.sh view summary
./tools/worldview-cli.sh sql query --reason "<why>" --sql "<select>"
```

Use `sources describe --source <source_id>` when you need one provider/source
contract, auth mode, policy or operational notes. Do not call `sources show`;
that command does not exist.

All commands return JSON.
If a command contract is unclear, use the JSON help surface for the relevant
wrapper or family, for example `./tools/worldview-cli.sh selection create
--help`, `./tools/source-fetch.sh <operation> --help`,
`./tools/map-command.sh --help` or `./tools/sql-readonly.sh --help`. Help is
tool-orientation metadata, not evidence for the user's case.

`query search` returns `status`, `query_status`, `pagination`, `coverage`,
`count`, `items` and `warnings`. If it returns `status: "empty"`, treat that
as "nothing matched local OpenSpy storage under these filters", not as proof of
real-world absence.
The agent CLI defaults `query search` to compact item detail so tool output
stays readable: concrete ids, layer/source, labels, timestamps and display
coordinates are kept, while heavy geometry/properties are omitted. Use
`--detail full` only when the full row payload is analytically needed. For
geometry inspection, prefer `geo simplify`, `query related`, `object.open`, or
map actions instead of asking a search result to carry large geometries.
Query response `filters.bbox` is reported in canonical OpenSpy
`west,south,east,north` order.

Use `query aggregate` or `query timeline` for hourly/daily counts and coverage
summaries. For vessel/aircraft `core.position_fixes` coverage, prefer
`query aggregate --kind entities --layer <layer> --bbox <west,south,east,north>
--from <iso> --to <iso> --group_by hour|day`; do not hand-roll `DATE_TRUNC`,
epoch conversion, or broad `position_fixes` coverage SQL when this semantic
command answers the question. Use `query related` after citing a concrete
object to find nearby events, assets and live entities around the object's
representative geometry. Use
`query satellite-overpasses` when the analysis asks which satellites may have
passed over an AOI during a time window. It samples propagated TLE ground-track
positions from local `core.orbital_elements`; it is not a sensor-specific
field-of-view, tasking, cloud-cover, downlink or imagery-availability proof.
Use imagery source tools separately when the user asks for actual imagery.
Use `replay evidence` to validate a concrete moving entity for the exact final
visual replay window before returning `ACTIONS_JSON` that opens, focuses,
follows or animates that object. Required flags are `--entity`, `--from` and
`--to`; `--layer` is optional when the entity id has a clear prefix. Important
output fields are `fix_count`, `has_motion`, `first_fix_at`, `last_fix_at`,
`max_displacement_m`, `endpoint_displacement_m`, `first_lat/lng` and
`last_lat/lng`. If the result has too few fixes or no visually useful
displacement, choose another object or a better replay window.
Use
`geo spatial_join` when the analysis asks whether two layers co-occur
geographically. For historical moving-object proximity to static
infrastructure, use
`geo spatial_join --moving_layer vessel --static_layer cable --bbox <west,south,east,north> --from <iso> --to <iso> --radius_m <meters> --limit <n>`;
it reads historical `core.position_fixes` and returns fix timestamps as
`left_observed_at`. Distances are measured from the moving fix to the returned
static geometry. In prose, round sub-meter results to "intersected the
geometry" or "within <1 m"; do not describe them as distances to a
representative point or print false precision such as `0.001 m`. Use
`geo simplify` before sending line/polygon geometry to map actions; it
clips/simplifies server-side and enforces result limits.

Selections are the stable way to pass groups from analysis to the map. For
large groups, create a selection with a predicate/bbox/time window and use
`selection materialize` so the backend stores matching object handles in
`app.selection_items`. If the analysis needs all matching handles, do not pass
a materialization limit. If it needs an explicit subset, pass `--limit` and
treat that subset as the agent's own sampling decision. Do not embed thousands
of ids in prose or action JSON. Use `selection items` with an explicit page
size for previews, or `--limit all` when the agent needs the full materialized
set. When creating a selection,
prefer canonical JSON fields: `selectionId`, `layerId`, `selectionMode`,
`predicate`, `metadata`. Put `bbox`, `from`, `to`, `ids`, `subtype`,
`source_id` and other filters inside `predicate`, not as top-level fields. The
backend accepts aliases such as `selection_id`, `layer` and `layer_id`, but
canonical fields make the saved object easier to debug. Selection predicate
bboxes use `west,south,east,north`, the same order returned by
`resolver region`. Selection item paging exposes
`pagination.has_more` and `pagination.next_offset`; explicit `limit=all`
returns the full materialized set. Materialization returns
`limits.agent_requested_subset` when the agent chose a subset. Do not infer
real-world completeness from a subset the agent explicitly requested.
Do not put synthetic selector modes such as `type`, `kind` or `mode` inside a
selection predicate unless a tool result explicitly returned that contract. Use
concrete predicate keys such as `bbox`, `from`, `to`, `ids`, `subtype` and
`source_id`.

For "right now", "current", "live", "what do you see here" and similar user
requests, start with `query live-status`, not historical `position_fixes`.
`query live-status` reads `app.entity_live_states` and reports the latest
observed timestamp, fresh count inside the source freshness window and sample
objects. Treat "now" as source-freshness time, not as a literal millisecond.

Call one exact OpenSpy CLI command inside each Bash tool call.
Independent tool calls may run in parallel when the runtime supports parallel
tool use. Do not chain several commands inside one shell string or call action
type names as CLI subcommands. Actions such as `map.fly_to`, `layer.filter`,
`object.open` and `replay.play_window` belong in `ACTIONS_JSON` unless the CLI
reference explicitly documents a corresponding command family.

For SQL, use one direct tool call:

```bash
./tools/worldview-cli.sh sql query --reason "<why>" --sql "<select>"
./tools/sql-readonly.sh --reason "<why>" --sql "<select>"
```

Do not generate base64 inside Bash. Do not use `$(...)`, `printf`, `base64`,
pipes, heredocs or temporary files to pass SQL. `--sql-b64` is allowed only when
the prompt or another OpenSpy tool already returned a literal base64 SQL
value. If quoting becomes fragile, simplify the SQL or use a semantic query
command instead of shell construction.

Coordinate conventions:

- `query`, `replay`, `geometry create_aoi` and visual AOI payload bboxes use
  `west,south,east,north`.
- GeoJSON-style coordinates use `[lng, lat]`.

## Choosing A Covered Historical Window

Use this pattern before a historical OSINT investigation when the user did not
give a fixed time window:

1. Run `coverage report`.
2. Pick a layer/storage row with `coverage_role = local_history` or
   `computed_replay_input` and non-zero `record_count`.
3. Prefer `recommended_hour_start` or `recommended_day_start`.
   `record_count_basis` and `time_basis` explain how the coverage row was
   computed. Moving-entity history uses ingest counters when available,
   otherwise entity counts, plus `time_basis = entity_observation_bounds`, so
   the command does not repeatedly scan the full `core.position_fixes` history.
4. Use that interval for local analysis.
5. Call relevant available provider source-fetch operations for the same AOI or
   date/window when the user asks for complete source-backed analysis.
6. Report counts, concrete examples and coverage limits in the visible answer.

## Visible Answer Style

Use data tools to do the work, then answer in final-state language:

- what local coverage contains and what pattern or anomaly it implies
- which rows/entities/events/assets were found
- which interpretation is direct evidence and which is correlation
- what confidence limits come from coverage, provider status or source cadence
- what map/replay actions were prepared

If a user asked for insight, do not lead with apologies, "no data", or a generic
request for more sources. Lead with the operational interpretation supported by
the available OpenSpy evidence. State the observed pattern, the control check
that makes it meaningful, and the plausible interpretations. Mention extra
sources only as confidence boundaries or when the user asks for follow-up
collection.

Avoid turning the final answer into a command transcript. If a tool path needs a
retry or an alternate entrypoint, the user should see the relevant data outcome,
not shell mechanics.

When evidence must be collected first, start with tool calls and write visible
prose after the evidence is ready. The final report should be coherent and
should not include earlier progress notes.

Do not include preparation/status lines such as "checking coverage", "creating
selection", "now I have the data", "building the final analyst report",
"building the visual presentation", or browser/runtime status notes in the
visible report. The UI shows tool-call rows separately; prose should focus on
the analyst result.
Do not begin with "Done", "Готово", "всё проверено", "selection created",
"селекции созданы", or similar completion summaries. Those are execution
status, not OSINT findings.

Before the evidence is ready, do not emit visible assistant text. Use tool
calls first, then write the report once. The first visible line must be the
report heading or the analyst conclusion itself. Continue directly into the
report body. Operational readiness lines such as "data collected", "coverage
confirmed", "ready to report" or "moving to the report" are not part of the
analyst report and should not be written.

Avoid parenthetical coordinate pairs in user-facing place prose, including
cluster summaries such as `<place> (<lat>, <lng>)`. Use the place or
corridor name and keep exact coordinates inside links/actions. For event-like
cells such as GPSJam, fires, outages or disasters, do not infer cardinal
phrases relative to a named city from raw coordinates unless a tool or resolver
returned that place relationship. Prefer neutral area labels or a precise
`ospy://event` link.

When a concrete object is cited in the report, retain its stable id, layer,
timestamp and representative coordinates so map-control actions can open that
object in the UI.

For public incidents outside local coverage, create a provider-history check:
the expected result is not "no event happened", but "local DB has no coverage;
source X can/cannot import history under current credentials".

## Safety

SQL must be read-only. Never attempt writes, DDL, credential reads, or direct
mutation of product tables. Do not look for `DATABASE_URL`; the SQL tool calls
the backend read-only SQL endpoint, which runs as PostgreSQL role
`app_agent_readonly`.

Do not query `app.agent_sessions`, `app.agent_messages`, `app.agent_runs`, or
`app.agent_run_events` through SQL.

The SQL path is a fallback. Prefer semantic CLI commands for catalog, search,
tracks, nearest, selections, replay state and source capability checks.
For proximity between moving tracks and infrastructure/events, use semantic
geo tools such as `geo spatial_join`, `geo corridor`, `query related`,
selection predicates or narrowed track queries. Do not run broad raw SQL
`ST_DWithin(...geom::geography, ...geom::geography, ...)` joins across
`core.position_fixes` and `core.assets`/`core.events`; that pattern can bypass
spatial indexes and stall the product. If SQL is necessary, first narrow by
time, bbox and indexed geometry prefilters, then compute exact distances on the
small candidate set.
When you need modulo arithmetic in SQL, use PostgreSQL syntax with a single
`%` operator. Do not write `%%`.
