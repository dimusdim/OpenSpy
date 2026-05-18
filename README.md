# OpenSpy

Real-time 3D OSINT workspace. 42 source connectors, 26 map/data layers, local replay, satellite imagery, AI image workflows, and a local agent harness for Codex CLI or Claude Code.

OpenSpy is an open-source, self-hosted intelligence interface for watching public activity on Earth in real time. It combines aviation, maritime, satellite, conflict, disaster, infrastructure, outage, traffic, webcam, fire, GNSS interference, and imagery data on a Cesium globe, then lets a local AI agent investigate that same data through controlled OpenSpy tools.

It is built for OSINT exploration, situational awareness, visual briefings, and interactive geospatial analysis. It is not a hosted intelligence service and it is not a source of classified data. Every layer is backed by public, user-configured, or locally derived sources.

> **Credits:** OpenSpy was inspired by Bilawal Sidhu's GodEyeView concept: an AI-native OSINT interface centered on a live globe. OpenSpy is a separate open-source implementation focused on self-hosted public-source data, local analysis, and extensible agent tooling.

## Feature Highlights

- ✈️ **Live aircraft tracking** - OpenSky aircraft positions, class, callsign, altitude, speed, heading, route lookup, and aircraft photo enrichment.
- 🚢 **Live vessel tracking** - AISStream vessels with heading, speed, type, tracks, and local AIS gap detection.
- 🛰️ **Satellite tracking** - TLE ingestion, SGP4 propagation, orbital trails, satellite classes, and moving sensor footprints.
- 🛰️ **Satellite imagery** - NASA GIBS/MODIS, NASA FIRMS WMS, Copernicus/Sentinel Hub, and USGS Landsat browse imagery.
- 💥 **Conflict mapping** - GDELT security events live, with ACLED support when credentials are configured.
- ⚠️ **GNSS interference** - GPSJam cells rendered as severity-coded 3D regions.
- 🔥 **Active fires** - NASA FIRMS fire hotspots with FRP, brightness, confidence, and time metadata.
- 🌐 **Internet outages** - IODA and Cloudflare Radar outage evidence in the same map workspace.
- 📹 **Live webcams** - HLS/image camera feeds from Live-Environment-Streams, Windy, and Caltrans.
- 🏭 **Critical infrastructure** - OSM/Overpass plus Overture power, pipelines, substations, refineries, military areas, dams, towers, and related assets.
- 🚫 **Restricted airspace** - OpenAIP restricted, danger, prohibited, alert, and warning zones with altitude-aware 3D rendering.
- 🌊 **Submarine cables** - TeleGeography cable routes for internet backbone context.
- 🚗 **Road traffic** - TomTom traffic tiles and optional HERE flow data.
- 📈 **Energy and oil context** - Yahoo Finance, EIA, and Our World in Data energy statistics.
- 🧭 **Timeline replay** - Local snapshot/replay pipeline with render chunks, trails, and timeline controls.
- 🗺️ **Presentation layer** - Map annotations, selections, replay cards, camera moves, icon packs, and visual shader modes.
- 🎨 **AI image transformation** - Capture a globe view, send it through OpenRouter-backed image/vision workflows, compare the generated result as an overlay, and return to the exact viewpoint.
- 🤖 **Integrated local agent** - Codex CLI or Claude Code can query OpenSpy data, read source capabilities, fetch supported upstream history, control the map, create selections, and produce visual analysis.

## Current Runtime Snapshot

Measured on a local OpenSpy dev instance after live ingest warm-up on 2026-05-18 14:10 UTC. Counts vary by API keys, upstream availability, viewport, cache state, and retention.

| Area | Fresh runtime count |
|---|---:|
| Catalog sources exposed by OpenSpy | 42 |
| Catalog layers | 26 |
| Live/source-fetch sources | 36 |
| Sources requiring no OpenSpy key | 26 |
| Sources requiring a free account, token, or paid provider key | 16 |
| Aircraft in live snapshot | 11,162 |
| Vessels in live snapshot | 17,260 |
| Satellites loaded from TLE chain | 19,059 |
| OpenAIP airspace zones | 9,976 |
| NASA FIRMS active fire hotspots | 30,447 |
| GPSJam interference cells | 963 |
| GFW AIS gap events | 1,260 |
| GDELT conflict events in latest fetch | 148 |
| GDACS/USGS/EONET disaster feed | about 542 events |
| Internet outage alerts/annotations | 3 |
| Live webcams in current run | 6,172 |
| Submarine cable features | 712 |
| Overture cache records | 5,749,234 |
| Local PostgreSQL database size in this run | 42.9 GB |

Local retained history in the same database included roughly 16.7M aircraft position fixes, 16.8M vessel position fixes, 552K fire events, 95K GDELT conflict events, 23.5K GFW events, 132K aircraft entities, 72K vessel entities, and 22K satellite entities.

## Features

### ✈️ Aerospace

**Aircraft tracking** - Live aircraft from OpenSky Network. OpenSpy shows positions, altitude, speed, heading, callsign, aircraft class, route enrichment, and photo enrichment by ICAO24 where available. Aircraft are classified into airliner, military, light/general aviation, and general categories.

**Restricted airspace** - OpenAIP restricted, danger, prohibited, alert, and warning areas. The frontend renders zones as altitude-aware 3D volumes rather than flat polygons.

**Historical tracks** - Selected aircraft can be queried through track endpoints and replayed in the globe/timeline workflow when provider history is available.

### 🚢 Maritime

**Vessel tracking** - Live AIS positions from AISStream, rendered with vessel subtype icons for cargo, tanker, passenger, fishing, military, and unknown vessels. Tracks and heading-aware sprites are available in live and replay views.

**Local AIS gap detection** - OpenSpy can flag vessels that were actively tracked and then stop sending accepted AIS fixes. This is a local heuristic over AISStream data, not an external sanctions or shadow-fleet dataset.

**Global Fishing Watch events** - GFW AIS gap events provide an independent public-source signal for AIS-disabling and maritime anomaly analysis when a GFW token is configured.

### 🛰️ Space

**Satellite tracking** - Space-Track/CelesTrak/Ivan TLE chain, SGP4 propagation, orbital trails, and satellite categories. The current runtime loaded 19,059 objects.

**Sensor footprint projection** - Spectator Earth metadata enriches selected Earth-observation and reconnaissance satellites with sensor type, swath, and footprint data. Footprints move with the satellite over the globe.

**Targeted satellite history** - Space-Track GP_HISTORY support exists as a source-fetch path for targeted NORAD/time-window orbital history when Space-Track credentials are configured.

### 🛰️ Imagery

**MODIS and cloud context** - NASA GIBS/Worldview provides public daily global imagery layers, including MODIS true-color and cloud context.

**FIRMS fire imagery** - NASA FIRMS WMS and Area API support active fire context and targeted historical fire fetches when a FIRMS MAP_KEY is configured.

**Copernicus/Sentinel Hub** - Sentinel imagery search/render paths are wired through Copernicus/Sentinel Hub credentials. This is for targeted evidence overlays, not a full global live raster replacement.

**Landsat browse imagery** - USGS Landsat STAC metadata and browse imagery can be used for historical visual context.

**Imagery evidence artifacts** - The backend can create local image artifacts from selected imagery sources or preview payloads so agents and users can reference the same visual evidence.

### 💥 Conflict, Risk, And Disasters

**Conflict events** - GDELT provides live conflict/security event context. ACLED is supported when account credentials are configured.

**Disasters** - GDACS, USGS, and NASA EONET are combined for earthquakes, cyclones, floods, volcanoes, wildfires, droughts, and related natural events.

**GPS/GNSS jamming** - GPSJam interference cells are rendered as severity-coded areas, giving fast context for degraded navigation environments.

### 🏭 Infrastructure

**Critical infrastructure** - OpenStreetMap Overpass and Overture Maps provide power plants, substations, transmission lines, pipelines, refineries, desalination facilities, military areas, dams, communication towers, and related infrastructure.

**Overture cache** - Overture data is kept in a local DuckDB cache. The current local cache contains 5.7M records and is queried by viewport.

**Pipelines** - OSM/Overpass and Overture pipeline geometry support oil, gas, water, and other utility routes where available.

**Submarine cables** - TeleGeography cable routes provide physical internet backbone context.

### 🌐 Connectivity And Monitoring

**Internet outages** - IODA and Cloudflare Radar are surfaced together so outages can be cross-checked between independent sources.

**Webcams** - OpenSpy aggregates Live-Environment-Streams, Windy, and Caltrans camera feeds. Camera cards can show live/preview media directly in the app.

**Wi-Fi observations** - WiGLE lookup is available at street-level zoom when credentials are configured.

### 🚗 Traffic, Energy, And Markets

**Traffic** - TomTom traffic tiles are available for road-flow context, with optional HERE flow support.

**Oil prices** - Yahoo Finance provides Brent/WTI market context, with optional EIA official data.

**Country energy context** - Our World in Data and World Bank enrichment support country-level energy statistics used by the backend.

### 🧭 Replay And Presentation

**Timeline replay** - OpenSpy persists live data into local PostgreSQL/PostGIS and serves replay render chunks for timeline playback, tracks, trails, and feature detail lookup.

**Presentation controls** - Map commands can move the camera, apply selections, annotate places, and build step-by-step visual explanations.

**Icon packs and styles** - The UI supports icon pack configuration, layer styling, visibility controls, and shader modes.

### 🤖 AI And Agent Workflows

**Local product agent** - OpenSpy ships a versioned product-agent harness under `agent-harness/`. The harness can be instantiated for Codex CLI or Claude Code and uses OpenSpy tools rather than private backend prompt logic.

**Agent data tools** - The agent can read source capabilities, run read-only SQL, query entities/events/assets/tracks, fetch supported provider history, control the map, and materialize selections.

**AI image workflow** - The UI can capture a map view, submit it to an OpenRouter-backed model, store the generated result, and compare it against the original globe view as an overlay.

## Quick Start

### Local Development

Prerequisites:

- Node.js 20+
- npm
- PostgreSQL with PostGIS for local non-Docker runs
- Optional provider accounts for the layers you want to enable

```bash
git clone https://github.com/dimusdim/openspy.git
cd openspy

npm run install:all

cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env.local

# Add provider keys to backend/.env and frontend/.env.local as needed.
npm run dev
```

Open `http://localhost:3737`.

The backend runs on `http://localhost:3055`. The default backend dev script starts a project-local PostgreSQL cluster under `.local/postgres`, applies migrations automatically, and enables live ingest unless `DISABLE_LIVE_INGEST=true`.

### Docker Compose

Docker Compose runs PostgreSQL/PostGIS, backend, and frontend together.

```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env.local

npm run docker:up
```

Open `http://localhost:3737`.

Stop the stack:

```bash
npm run docker:down
```

The Docker setup is intended as a development bootstrap. Production hardening, managed secrets, persistent backup policy, and deployment manifests are still future work.

## Important Environment Keys

Most layers work without keys, but the best experience needs provider credentials. Put backend keys in `backend/.env` and frontend public keys in `frontend/.env.local`.

Core live layers:

```bash
OPENSKY_USERNAME=
OPENSKY_PASSWORD=
AISSTREAM_API_KEY=
OPENAIP_API_KEY=
TOMTOM_API_KEY=
GFW_TOKEN=
CLOUDFLARE_API_TOKEN=
WINDY_API_KEY=
```

Imagery and enrichment:

```bash
FIRMS_MAP_KEY=
COPERNICUS_CLIENT_ID=
COPERNICUS_CLIENT_SECRET=
SPACETRACK_EMAIL=
SPACETRACK_PASSWORD=
SPECTATOR_EARTH_API_KEY=
WIGLE_API_NAME=
WIGLE_API_TOKEN=
OPENROUTER_API_KEY=
```

Frontend map rendering:

```bash
NEXT_PUBLIC_API_URL=http://localhost:3055
NEXT_PUBLIC_CESIUM_ION_TOKEN=
NEXT_PUBLIC_GOOGLE_MAPS_KEY=
```

Local agent runtime:

```bash
AGENT_ENABLE_CODEX_PROVIDER=true
AGENT_CODEX_COMMAND=codex
AGENT_CLAUDE_COMMAND=claude
```

The agent providers inherit the user's locally installed CLI authentication and model settings. OpenSpy does not ship model credentials.

## Data Sources

OpenSpy separates public/no-key sources, free-registration sources, optional paid/pay-per-use providers, and planned connectors. Provider limits are surfaced in the app where available.

| Source | Layer / use | Auth | Notes and limits |
|---|---|---|---|
| OpenSky Network | Live aircraft | Free account | About 4,000 credits/day; current polling target is 90s. |
| AISStream | Live vessels | Free API key | WebSocket AIS stream; local throttling and WAL-backed accepted fixes. |
| Local dark-vessel detector | Maritime anomaly layer | No extra key | Derived from AIS gaps; not a sanctions or shadow-fleet dataset. |
| Space-Track / CelesTrak / Ivan TLE chain | Satellite TLEs | Space-Track optional, public fallback | TLE cache, SGP4 propagation, satellite classes. |
| Space-Track GP_HISTORY | Targeted historical satellite tracks | Free account | Agent/source-fetch operation for specific NORAD/time windows. |
| Spectator Earth | Satellite sensor metadata | Free key | Sensor type, swath, and footprint enrichment. |
| GDACS | Disaster alerts | No key | Uses public event APIs; refresh target 5 min. |
| USGS | Earthquakes | No key | Public earthquake catalog. |
| NASA EONET | Natural events | No key | Wildfires, storms, volcanoes, icebergs, and related events. |
| GDELT 2.0 | Conflict/security events | No key | 15-minute public export cadence. |
| ACLED | Conflict events | Free/account-dependent | Requires ACLED credentials and account terms. |
| GPSJam.org | GNSS interference | No key | Daily CSV; rendered as interference regions. |
| NASA FIRMS | Active fires | No key for live feed; MAP_KEY for area/history API | Free FIRMS MAP_KEY supports targeted historical/area fetches. |
| NASA GIBS / Worldview | MODIS/cloud/true-color imagery | No key | Daily global context imagery. |
| Copernicus / Sentinel Hub | Sentinel imagery search/render | Free registration with quotas | Higher-resolution targeted imagery; processing-unit limits apply. |
| USGS Landsat STAC | Historical browse imagery | No key | Metadata and browse imagery for historical context. |
| OpenSpy imagery artifact store | Evidence image artifacts | No external key | Stores bounded rendered/downloaded imagery artifacts locally. |
| TeleGeography | Submarine cables | No key | Cable route GeoJSON. |
| Natural Earth | Borders/reference | No key | Public-domain boundaries. |
| OpenAIP | Restricted airspace | Free API key | Paginated airspace API. |
| Global Fishing Watch | AIS gap events | Free token | Non-commercial access; GFW provider terms apply. |
| IODA / CAIDA | Internet outage alerts | No key | Country-level outage evidence. |
| Cloudflare Radar | Internet outages | Free account token | Radar API token with read access. |
| WiGLE | Wi-Fi observations | Free account token | Viewport/street-level fetches; provider limits apply. |
| OpenStreetMap Overpass | Infrastructure and pipelines | No key | Viewport-tiled queries; upstream soft limits apply. |
| Overture Maps | Infrastructure enrichment | No key, opt-in cache | Local DuckDB cache; current cache has 5.7M records. |
| TomTom | Traffic tiles | Free API key | 50,000 tiles/day free tier. |
| HERE | Traffic flow fallback | Free API key | Optional flow endpoint. |
| Live-Environment-Streams | Webcams | No key | Static community camera feed. |
| Caltrans | Traffic cameras | No key | California public camera data. |
| Windy Webcams | Global webcams | Free API key | API image URLs expire; free-tier paging limits. |
| Yahoo Finance | Oil prices | No key | Unofficial market data access through npm package. |
| EIA | Official energy/oil data | Free API key | Optional official petroleum data. |
| Our World in Data | Country energy statistics | No key | Loaded at startup. |
| Google Photorealistic 3D Tiles | 3D globe terrain/buildings | Cesium Ion token | Streamed on demand through Cesium. |
| OpenStreetMap 3D Buildings | Building fallback | No key | OSM-derived building visualization. |
| OpenRouter | AI image/vision workflow | Pay-per-use key | Used for AI image generation/analysis path. |
| OpenAQ | Air quality | No key planned | Code exists, not enabled in startup ingest yet. |
| Road511 | US/Canada traffic cameras | Free key planned | Connector placeholder. |
| NASA DIP NOTAMs | Structured NOTAMs | Free registration planned | Connector placeholder. |
| Global Energy Monitor | Major facilities | No key planned | Connector placeholder. |

## Agent Integration

OpenSpy includes a versioned product-agent harness under `agent-harness/`.

The agent can:

- read source capabilities through OpenSpy tools;
- run read-only SQL against the local OpenSpy database;
- fetch supported historical/source data through backend tool endpoints;
- inspect layer status and catalog metadata;
- create map commands, selections, camera moves, annotations, and replay steps;
- use the same visual layers the user sees in the app.

The backend treats the agent as a tool user. Product behavior belongs in the harness and skills, not in backend prompt heuristics. Backend APIs return facts, diagnostics, provider limitations, and tool contracts.

Supported local harness targets:

- Codex CLI
- Claude Code

The current public repo ships the OpenSpy harness files. It does not ship user credentials, global agent memory, or private local CLI configuration.

## Architecture

- `frontend/` - Next.js 14, React, Cesium, Zustand, map layers, replay UI, AI image panel, settings, icon packs, shader controls.
- `backend/` - Express/TypeScript API, live ingest services, source-fetch tools, replay/query APIs, agent runtime, Postgres persistence.
- `backend/src/db/migrations/` - database schema for catalog, live states, snapshots, render chunks, selections, agents, and source metrics.
- `agent-harness/core/` - versioned OpenSpy product-agent instructions and skills.
- `agent-harness/tools/` - shell entrypoints exposed to local agent harnesses.
- `config/` - source/layer binding and icon target contracts.
- `sources-catalog.json` - source manifest used by catalog bootstrap and documentation.
- `layer-settings-schema.json` - layer tree and settings model.

Storage:

- PostgreSQL/PostGIS is the canonical local store for live state, snapshots, source metrics, selections, and replay data.
- DuckDB is used for the local Overture Maps cache.
- Render chunks and local runtime artifacts are stored under ignored runtime paths.

## What Is Not Ready Yet

These are known public-release gaps rather than hidden features:

- One-command installer is not done. A fresh clone currently uses manual env setup plus `npm run install:all` or Docker Compose.
- Docker Compose now has backend/frontend Dockerfiles, but it is still a development stack, not a production deployment.
- Public CI and public test harnesses are not included yet. Internal tests are local-only while the public repo is being cleaned up.
- Contribution governance is intentionally lightweight for the first public release.
- Some connectors are planned or partially wired: OpenAQ, Road511, NASA DIP NOTAMs, Global Energy Monitor, and some deeper historical provider paths.
- ACLED, OpenAIP, GFW, TomTom, Windy, Cloudflare, Copernicus, WiGLE, OpenRouter, and some satellite enrichment paths require user-provided accounts or tokens.
- OpenSpy is not a managed data provider. Upstream API availability, provider terms, account quotas, and source freshness remain provider-dependent.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

High-value areas:

- new public data sources;
- source quality and provenance metadata;
- Cesium rendering performance;
- replay and timeline UX;
- agent tools and harness behavior;
- Docker/install improvements;
- docs and examples that are safe for a public repository.

## Credits And Inspiration

OpenSpy was inspired by Bilawal Sidhu's GodEyeView concept and the idea of an AI-native OSINT interface centered on an interactive globe.

OpenSpy is a separate open-source implementation focused on self-hosted public-source data, local analysis, and extensible agent tooling.

## License

OpenSpy is licensed under the [Apache License 2.0](LICENSE).

Third-party data sources, map providers, and AI/model providers are governed by their own terms. Users are responsible for configuring and using provider credentials within those terms.

## Follow

[LinkedIn](https://www.linkedin.com/in/dmitryalekhin/) · [YouTube](https://www.youtube.com/@DimaAlekhin) · [X / Twitter](https://x.com/Dmitry_Alekhin)
