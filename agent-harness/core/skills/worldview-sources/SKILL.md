---
name: worldview-sources
description: Use when deciding whether missing historical OSINT data can be fetched from an upstream provider API, archive, paid plan, or local cache.
allowed-tools: Bash(./tools/source-fetch.sh *)
---

# Worldview Sources Skill

Use this skill when the local database does not contain enough history or when
the user asks what a provider can supply.

## Rules

- Provider credentials stay in backend-owned code and environment.
- Do not read `.env`.
- Call `./tools/source-fetch.sh capabilities` first in product OSINT
  runs before source, imagery, storage or replay capability claims. It is the
  agent's visible view of configured connectors, account status,
  storage/replay support, source-fetch statuses and latest ingest.
- Use `available` provider-side operations that are directly relevant to the
  user's question before finalizing the analysis. Do not move a relevant
  available operation into "possible expansion" just because local rows were
  already checked.
- Use `source-fetch.sh` or documented backend source endpoints.
- If the provider does not support history on the configured plan, say so.
- If a provider is live-only, say live-only.
- Use "historical data import" in English for provider-side history requests.

## Command

```bash
./tools/source-fetch.sh <source-operation> [flags]
```

Examples:

```bash
./tools/source-fetch.sh capabilities
./tools/source-fetch.sh cloudflare-outages --from <iso> --to <iso> --location <country-or-region>
./tools/source-fetch.sh gfw-events --from <iso> --to <iso> --bbox <west,south,east,north>
./tools/source-fetch.sh acled-conflicts --from <iso> --to <iso>
./tools/source-fetch.sh gpsjam-history --date <yyyy-mm-dd>
./tools/source-fetch.sh usgs-earthquakes --from <iso> --to <iso>
./tools/source-fetch.sh eonet-events --from <iso> --to <iso>
./tools/source-fetch.sh ioda-outages --from <iso> --to <iso>
./tools/source-fetch.sh imagery-search-latest --bbox <west,south,east,north> --layer <layer>
./tools/source-fetch.sh copernicus-sentinel-imagery --bbox <west,south,east,north> --from <iso> --to <iso> --max-cloud-cover <0-100>
./tools/source-fetch.sh landsat-stac-imagery --bbox <west,south,east,north> --from <iso> --to <iso> --max-cloud-cover <0-100>
./tools/source-fetch.sh opensky-tracks --icao24 <icao24> --time <iso>
./tools/source-fetch.sh spacetrack-gp-history --norad <norad_id> --from <iso> --to <iso>
./tools/source-fetch.sh imagery-evidence-artifact --source <source_id> --bbox <west,south,east,north> --layer <layer>
```

Implemented backend operations:

- `gpsjam-history`: daily GPSJam CSV by `--date YYYY-MM-DD`; persists unless
  `--dry-run` is used.
- `cloudflare-outages`: Cloudflare Radar outage annotations by `--from` and
  optional `--to`; requires backend `CLOUDFLARE_API_TOKEN`.
- `gfw-events`: Global Fishing Watch events by `--from` and `--to`; requires
  backend `GFW_TOKEN`.
- `acled-conflicts`: explicit ACLED capability answer. ACLED incremental ingest
  exists when credentials are configured, but arbitrary user-triggered ACLED
  historical data import is still planned/auth-required until the connector is
  completed.
- `firms-fires`: NASA FIRMS area CSV by `--date` or `--from`; requires backend
  `FIRMS_MAP_KEY` or `NASA_FIRMS_MAP_KEY`. It also returns a FIRMS WMS overlay
  action payload; the backend proxies WMS tiles so the MAP_KEY is not exposed.
- `usgs-earthquakes`: public USGS FDSN GeoJSON earthquake search by `--from`,
  `--to`, optional `--bbox` and optional `--min-magnitude`.
- `eonet-events`: public NASA EONET events by `--from`, `--to`, optional
  `--bbox` and optional status.
- `gdacs-disasters`: public GDACS historical `SEARCH` API by `--from`,
  `--to`, optional `--bbox`, optional event/alert filters and provider
  pagination. Without `--from`/`--to`, it uses the current/recent `MAP` feed.
- `ioda-outages`: country-level IODA outage alerts by `--from` and `--to`.
- `nasa-gibs-imagery`: available metadata/capability answer for public
  date-addressable NASA GIBS/Worldview imagery. The browser can show GIBS
  imagery through map actions; this source operation does not fetch raw pixels.
- `imagery-search-latest`: lightweight latest-scene metadata for NASA
  GIBS/Worldview. It returns a `scene_id`, selected date, WMTS metadata and
  ready-to-use `imagery.show_layer` / `imagery.show_scene` action payloads.
- `copernicus-sentinel-imagery`: Sentinel scene metadata search through
  backend-owned Copernicus Data Space / Sentinel Hub credentials. It returns
  bounded Sentinel-2 optical and Sentinel-1 GRD VV radar scene descriptors and
  `imagery.show_scene` action payloads; browser rendering goes through the
  backend so OAuth secrets are never sent to the frontend or agent process.
- `landsat-stac-imagery`: public USGS Landsat STAC scene metadata search by
  `--bbox`, optional `--from`, `--to`, `--collection`, `--limit` and
  `--max-cloud-cover`. It returns scene descriptors and `imagery.show_scene`
  payloads for browse/thumbnail overlays when present; raw multiband COG
  rendering is not implemented.
- `opensky-tracks`: authenticated OpenSky per-aircraft trajectory fetch by
  `--icao24` and `--time`/`--at` or a `--from`/`--to` window. It persists
  returned waypoints into aircraft position fixes. Treat it as a targeted,
  experimental track endpoint, not a bulk AOI history API.
- `spacetrack-gp-history`: Space-Track GP_HISTORY fetch by targeted
  `--norad` and `--from`/`--to`; stores historical TLE epochs for satellite
  replay. It currently imports TLE/3LE records; OMM-only Alpha-5 handling is a
  separate renderer/parser task.
- `imagery-evidence-artifact`: creates one evidence image artifact from a
  supported imagery payload/source (`copernicus`, `landsat` browse/thumbnail,
  or `firms`). It returns `artifact_url` and `metadata_url`. The operation does
  not claim pixel-level analysis; use a vision-capable model/tool on the
  artifact when actual image interpretation is required.

Treat `auth_required` and `unsupported` as final capability answers for the
current environment. Do not describe them as successful partial fetches.

## Source Capability Workflow

1. Before making source, imagery, storage or replay capability claims, or
   before calling provider operations, run
   `./tools/source-fetch.sh capabilities`. The product may store request
   context as run data, but source capabilities are not injected into the
   prompt; the visible capabilities tool result is the source of truth.
2. Build a source-use plan from the user request and the capability statuses.
   Treat operation families as candidate evidence dimensions, not hard-coded
   request routes. Evaluate each source by what it directly observes,
   AOI/window support, freshness/history, resolution or granularity, auth state,
   provider limits, and whether the result can materially test, corroborate,
   contradict or visualize the claim. Imagery sources observe surface-visible
   context; event/catalog sources observe provider-specific event records;
   network, GNSS, vessel, aircraft, satellite and orbital sources observe their
   own measured phenomena. Any available source operation may be used when you
   judge that it improves analysis, confidence assessment, contradiction checks
   or visualization. Explain source-specific relevance only when it affects the
   finding, and do not claim a skipped source was checked.
   Do not write that an available source can be checked later or by request
   after you made that source relevant in the answer. Either execute it, state
   a concrete current-run blocker, or omit it from the user-facing answer.
   Do not include a generic "what else to check" or "next sources" paragraph in
   normal product answers unless the user asks for next steps.
3. Read both `data.operations` and `data.sources` when you call the full
   capabilities command.
4. Use `data.sources` to identify local storage bindings, replay support,
   refresh cadence, auth state, latest ingest metrics, live-only status and
   inactive catalog entries.
5. Check whether the source operation is `available`, `auth_required`,
   `planned` or `unsupported`.
6. Use local data tools first for already-ingested evidence, but still call a
   directly relevant `available` provider operation when the user asks for a
   complete source-backed check.
7. If local data is missing and the provider can import history, call the
   source operation only through backend-owned `source-fetch.sh`.
8. If credentials or plan are missing, report exactly what is missing.

Do not write "if credentials are configured" when the visible capabilities
result already shows a current status. Say "configured and available",
"`auth_required`", "`planned`" or "`unsupported`" as appropriate.
In the final user-facing report, put the plain meaning before any raw status
token: "credentials/access are missing", "planned but not executable here",
"not supported by this connector", or "available and checked". Raw capability
tokens are useful for auditability, but they should not be the headline wording.

The default `capabilities` result is compact enough for the agent to read
directly. Use `./tools/source-fetch.sh capabilities --detail full` only
when the verbose operator matrix is required. In product OSINT runs, Bash calls
are direct OpenSpy tool calls, not general shell sessions: do not pipe,
redirect, chain commands, create temporary files, or read internal harness
`tool-results` files to post-process JSON. Python/jq are acceptable only in
contexts where they are explicitly available as tools; otherwise use the
visible JSON result or a semantic OpenSpy command.

`capabilities` returns one envelope:

- `data.operations`: executable or planned provider-side operations.
- `data.sources`: compact source capability matrix for active, auth-relevant
  or source-fetch-relevant catalog sources. Use `--detail full` for every
  catalog source.
- `data.summary`: counts for sources, bindings, auth gaps and operations.

Each `data.sources[]` row includes `local_storage.layers[]` and
`latest_ingest[]`. Use these fields in user-facing answers when source
completeness matters:

- `raw_capture_mode`: whether raw provider payloads are retained for that
  source (`snapshot`) or intentionally not stored (`none`).
- `provider_policy`: account tier, local cadence, source-fetch limits, storage
  rule and replay rule for sources with configured policy.
- `storage_policy_id`: normalized storage family used by replay and audit.
- `latest_ingest.status` and `latest_ingest.completeness`: whether the latest
  run completed and whether pagination/window data was complete.
- `latest_ingest.upstream_bytes`, `raw_count`, `normalized_count`,
  `changed_count` and `total_ms`: the operator-facing ingest metrics.

Do not recommend `planned` or `unsupported` operations as immediate user
actions. Treat them as roadmap or limitation unless the user explicitly asks
about future integrations.

Do not recommend a relevant `available` operation as a future expansion without
having called it in the same run. If it was not called, either call it or remove
the recommendation and limit the conclusion to local OpenSpy coverage.

## Current Capability Matrix

This is the agent-facing summary. The detailed architecture source is
`ops/specs/source-data-contracts-and-replay-architecture.md`. Operator setup,
credential pages, free/auth/paid status, environment variables and product-code
readiness are tracked in `docs/api-keys.md`.

- OpenSky aircraft: live/current state is ingested into `core.position_fixes`.
  Historical aircraft replay comes from our DB. `opensky-tracks` is executable
  for targeted ICAO24/time trajectory checks when OpenSky credentials are
  configured. It is not a bulk AOI history API; deeper bulk history remains
  account/licensing dependent.
- AISStream vessels: current WebSocket ingest only. No native historical replay
  API in the current integration. Deep historical AIS requires a separate
  historical AIS provider manifest writing the same vessel position table.
- Space-Track satellites: current GP and GP_HISTORY are account based. Replay
  uses stored orbital elements and SGP4 propagation. `spacetrack-gp-history`
  can import targeted historical TLE/3LE epochs when credentials are
  configured; raw OMM/Alpha-5 parsing remains separate.
- CelesTrak satellites: current GP fallback, not a historical observation
  source.
- NASA FIRMS fires: public MAP_KEY supports date/day-range products. Current
  product ingests recent fire events. `firms-fires` is an executable
  source-fetch operation when `FIRMS_MAP_KEY` or `NASA_FIRMS_MAP_KEY` is
  configured; without that key it returns `auth_required`. The same configured
  key enables a backend-proxied FIRMS WMS thermal/hotspot overlay.
- NASA GIBS / NASA Worldview imagery: public date-addressable WMTS/WMS imagery.
  Current UI can show time-aware GIBS overlays through `imagery.show_layer`.
  It is context/evidence imagery, not canonical vector replay hydration and not
  a raw-pixel download path.
- Copernicus/Sentinel imagery: high-value open imagery after registration/auth.
  Current product can search bounded Sentinel-2 optical and Sentinel-1 GRD
  metadata and render bounded Sentinel-2 true/false-color previews plus
  Sentinel-1 VV radar previews through backend-owned Sentinel Hub APIs when
  `COPERNICUS_CLIENT_ID` and `COPERNICUS_CLIENT_SECRET` are configured. Use it
  for targeted AOIs, not global polling.
- USGS Landsat STAC imagery: useful historical scene search and before/after
  corroboration. `landsat-stac-imagery` is executable for public scene
  metadata and browse/thumbnail overlays. Treat raw multiband COG rendering as
  not implemented.
- GDACS, USGS and NASA EONET disasters: public event sources. Replay comes
  from stored event snapshots. `usgs-earthquakes`, `eonet-events` and
  `gdacs-disasters` are executable source-fetch operations. GDACS uses
  historical `SEARCH` when an explicit `--from`/`--to` window is supplied and
  the current/recent `MAP` feed when no window is supplied.
- ACLED/GDELT conflicts: event snapshot model fits. ACLED depends on account
  and license. Current ACLED code performs incremental ingest every 30 minutes
  when credentials are configured, with timestamp overlap and page caps.
  `acled-conflicts` is a capability answer, not an executable arbitrary
  historical import yet. GDELT archives are public but high-volume.
- IODA outages: `ioda-outages` is an executable country-level outage-alert
  source-fetch operation. Treat it as event evidence and report its
  country/alert granularity; do not claim it is a raw BGP/probe timeseries
  replay source.
- Cloudflare Radar outages: historical date ranges are supported by the API,
  but backend token is required. The tool returns `auth_required` if the token
  is not configured. Capability metadata exposes provider window limits when
  they apply.
- GPSJam: daily historical CSV products. Missing dates can be normal source
  behavior; report date availability honestly.
- Global Fishing Watch: token and non-commercial terms. Date-range events can
  be fetched when credentials are configured.
- OpenAIP airspace, TeleGeography cables, Overture infrastructure and Natural
  Earth: static or versioned assets. Replay uses our stored snapshots/releases.
- WiGLE Wi-Fi: live viewport/context layer. Stored history is for dedupe/audit,
  not current replay hydration. No passwords. Raw BSSID must not be sent to the
  browser.
- Webcams, traffic, clouds and live viewport infrastructure: live-only or
  context overlays unless a specific historical storage/replay contract is
  added. NASA GIBS imagery is date-addressable context imagery, but it must not
  block replay hydration.
- Oil/energy widgets and inactive catalog entries such as OpenAQ, Road511 and
  GEM are not current map replay capabilities. Copernicus/Sentinel imagery can
  still be available as source-fetch imagery when capabilities expose an
  executable operation.

## Reporting Rules

Always distinguish:

- local DB coverage
- provider historical capability
- current configured credentials
- free/current account limits
- paid or extra-registration requirements
- product code readiness

Never say "no event happened" only because local rows are absent. Say "the local
database has no rows for this window" and then state whether a provider can
import history for that window.

## Rate-Limit And Cadence Rules

- Provider source-fetch commands are user/action driven, not replay-clock
  driven. High replay speed must never increase upstream request frequency.
- Use local database coverage first for already-ingested evidence. Also use
  provider source-fetch when the operation is `available` and directly relevant
  to the user's requested analysis, even if local rows exist; the provider
  result is a corroborating source check, not a replay-clock fetch.
- Prefer narrow AOIs and short time windows when that is the analytically right
  query shape or when a visible provider/account policy requires it. Do not add
  hidden caps or arbitrary "safety" limits on behalf of the agent.
- Respect operation `policy` and source-level `provider_policy` fields from
  `source capabilities`; report them to the user when freshness or precision
  matters.
- Copernicus search should expose any real AOI, time-window, result-count,
  token/cache or provider-request constraints in the tool result/capability
  metadata.
- Cloudflare Radar source-fetch should expose any real window, pagination or
  provider-request constraints in the tool result/capability metadata.
- ACLED ingest is incremental with 30-minute local cadence, timestamp overlap
  and page caps. It is not a replay-clock fetcher and arbitrary user-triggered
  ACLED historical import remains planned/auth-required.
- NASA GIBS is date-addressable public context imagery. It may use yesterday
  UTC by default because same-day true-color tiles can be incomplete.
