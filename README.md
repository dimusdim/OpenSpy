# OpenSpy

OpenSpy is an open-source, self-hosted 3D intelligence workspace for watching the world in real time. It combines live aviation, maritime, satellite, conflict, disaster, infrastructure, outage, traffic, webcam, fire, GNSS interference, and satellite imagery data on a Cesium globe, then lets a local AI agent investigate the same data through controlled OpenSpy tools.

OpenSpy is built for OSINT exploration, situational awareness, visual briefings, and interactive geospatial analysis. It is not a hosted intelligence service and it is not a source of classified data. Every layer is backed by public, user-configured, or locally derived sources.

## What It Can Show

- Real-time aircraft from OpenSky, with aircraft class, callsign, altitude, speed, heading, route lookup, and aircraft photo enrichment.
- Real-time AIS vessels from AISStream, with ship class, heading, speed, tracks, and local dark-vessel gap detection.
- Satellite tracking with SGP4 propagation, orbital trails, reconnaissance/commercial/civilian/military classes, and sensor footprint metadata.
- GNSS/GPS jamming zones from GPSJam, rendered as severity-coded 3D regions.
- Active fires from NASA FIRMS, including FRP/brightness/confidence metadata.
- Armed conflict and security events from GDELT, with ACLED support when credentials are configured.
- Disaster and natural-hazard events from GDACS, USGS, and NASA EONET.
- Internet outage evidence from IODA and Cloudflare Radar.
- Global webcams from Live-Environment-Streams, Windy, and Caltrans.
- Critical infrastructure from OpenStreetMap/Overpass and Overture Maps: power plants, substations, lines, cables, refineries, military areas, pipelines, dams, communication towers, and related assets.
- Restricted and controlled airspace from OpenAIP.
- Submarine cable routes from TeleGeography.
- Road traffic from TomTom tiles, with optional HERE flow support.
- Oil prices and country energy context from Yahoo Finance, EIA, and Our World in Data.
- Wi-Fi observation lookup through WiGLE at street-level zoom when credentials are configured.
- Satellite imagery overlays from NASA GIBS/MODIS, NASA FIRMS WMS, Copernicus/Sentinel Hub, and USGS Landsat browse imagery.
- Google Photorealistic 3D Tiles and OpenStreetMap 3D building modes.
- Timeline replay from locally persisted snapshots and render chunks.
- Presentation controls, map annotations, selectable entities, replay cards, icon packs, and visual shader modes.
- AI image workflow: capture the globe view, send it to a vision/image model through OpenRouter, generate transformed imagery, compare it as a map overlay, and return to the original viewpoint.
- Local AI agent harness that can run through Codex CLI or Claude Code, read OpenSpy source capabilities, query local data, fetch supported upstream history, control the map, create selections, and prepare visual analysis.

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
- Docker Compose now has the missing Dockerfiles, but it is still a development stack, not a production deployment.
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

## Credits

OpenSpy was inspired by Bilawal Sidhu's GodEyeView concept and the idea of an AI-native OSINT interface centered on an interactive globe.

OpenSpy is a separate open-source implementation focused on self-hosted public-source data, local analysis, and extensible agent tooling.

## License

OpenSpy is licensed under the [Apache License 2.0](LICENSE).

Third-party data sources, map providers, and AI/model providers are governed by their own terms. Users are responsible for configuring and using provider credentials within those terms.
