# OpenSpy

Ask questions about the world and watch the answer unfold on a live 3D globe.

OpenSpy is an AI-first OSINT workspace for live world data, replay, satellite imagery, and visual investigations. It turns aircraft, ships, satellites, fires, outages, disasters, infrastructure, traffic, webcams, cables, conflicts, GNSS interference, and satellite imagery into one live scene.

Ask the AI agent what is happening in a region and it works directly with the globe: it queries data, checks coverage, fetches history, moves the camera, builds selections, creates replay steps, and explains the evidence visually.

It is built around the product idea behind Bilawal Sidhu's GodEyeView video: an AI analyst working directly on a live globe instead of answering in a disconnected chat box.

## Contents

- [Why OpenSpy](#why-openspy)
- [What it can do](#what-it-can-do)
- [Live data snapshot](#live-data-snapshot)
- [AI workflows](#ai-workflows)
- [Data sources](#data-sources)
- [Quick start](#quick-start)
- [Environment keys](#environment-keys)
- [Agent harness](#agent-harness)
- [Architecture](#architecture)
- [Contributing](#contributing)
- [License](#license)

## Why OpenSpy

Most OSINT tools show one slice of the world. Aircraft here. Ships there. Fires in another tab. Satellite imagery somewhere else. OpenSpy puts those layers into one scene and gives an AI agent tools to work with them.

You can:

- watch aircraft, vessels, satellites, fires, outages, disasters, traffic, webcams, cables, airspace, and infrastructure on one globe;
- replay history with timeline controls, trails, selected objects, and presentation steps;
- search for fresh satellite imagery, show it on the map, compare opacity, and attach it to an investigation;
- capture a globe view, transform it with an AI image model, and compare the generated result against the original view;
- let Codex CLI or Claude Code inspect the same data through the versioned OpenSpy agent harness;
- build visual briefings with camera moves, annotations, selections, replay cards, icon packs, and shader modes.

## What it can do

### Live world layers

- Aircraft from OpenSky, with altitude, speed, heading, callsign, route lookup, class, and photo enrichment.
- Vessels from AISStream, with heading, speed, type, tracks, replay, and local AIS gap detection.
- Satellites from the Space-Track/CelesTrak/Ivan TLE chain, with SGP4 propagation, orbital trails, classes, and moving sensor footprints.
- Restricted, danger, prohibited, alert, and warning airspace from OpenAIP as altitude-aware 3D volumes.
- Active fires from NASA FIRMS with brightness, confidence, FRP, time, and area/history fetch.
- Conflict and security events from GDELT and ACLED.
- Disasters from GDACS, USGS, and NASA EONET.
- GPS/GNSS interference cells from GPSJam.
- Internet outage evidence from IODA and Cloudflare Radar.
- Webcams from Live-Environment-Streams, Windy, and Caltrans.
- Submarine cables from TeleGeography.
- Infrastructure from OpenStreetMap Overpass and Overture Maps: power, pipelines, substations, refineries, desalination, military areas, dams, towers, and related assets.
- Traffic from TomTom and HERE flow data.
- Oil and energy context from Yahoo Finance, EIA, Our World in Data, and World Bank data.

### Satellite imagery

- NASA GIBS/Worldview daily global imagery, including MODIS true-color and cloud context.
- NASA FIRMS WMS and Area API for fire-focused imagery and historical fire context.
- Copernicus/Sentinel Hub search and render flow for targeted Sentinel evidence overlays.
- USGS Landsat STAC metadata and browse imagery for historical visual context.
- Local imagery artifacts so the user and agent can reference the same rendered evidence.

### Replay and presentation

- Local PostgreSQL/PostGIS replay store for aircraft, vessels, events, snapshots, selections, and source metrics.
- Render chunks for fast timeline playback.
- Trails, selected object focus, exact-time cards, and detail-on-click.
- Agent-created presentation steps: fly-to, annotate, highlight, filter, select, open card, seek replay, play window, and draw investigation geometry.
- Icon packs, layer styles, shader modes, and replay cards for visual demos.

### AI image workflow

OpenSpy can capture the current globe view, send it through an OpenRouter-backed image or vision workflow, store the result, and place it back over the scene for comparison. This is useful for:

- visual what-if exploration;
- turning a raw satellite/map view into a more legible briefing image;
- checking generated imagery against the original camera view;
- building before/after visuals from the same geographic frame.

## Live data snapshot

Measured during an OpenSpy live ingest run on 2026-05-18 14:10 UTC.

| Area | Runtime count |
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
| GDACS/USGS/EONET disaster feed | 542 events |
| Internet outage alerts/annotations | 3 |
| Live webcams in current run | 6,172 |
| Submarine cable features | 712 |
| Overture cache records | 5,749,234 |
| Local PostgreSQL database size in this run | 42.9 GB |

The same database retained 16.7M aircraft position fixes, 16.8M vessel position fixes, 552K fire events, 95K GDELT conflict events, 23.5K GFW events, 132K aircraft entities, 72K vessel entities, and 22K satellite entities.

## AI workflows

OpenSpy ships a versioned product-agent harness under `agent-harness/`.

The agent can:

- read the live source capability matrix;
- query entities, events, assets, tracks, regions, timelines, selections, and layer status;
- run guarded read-only SQL against the OpenSpy database;
- fetch source history through backend tool endpoints;
- inspect freshness and provider metadata;
- control the globe through OpenSpy map commands;
- create selections and replay windows;
- produce evidence-first visual reports in chat.

Agent harness targets:

- Codex CLI
- Claude Code

OpenSpy provides the product harness, tools, and data contracts. Codex CLI and Claude Code keep using their normal local authentication and model settings.

## Data sources

OpenSpy combines public feeds with user-connected provider accounts.

| Source | Layer / use |
|---|---|
| OpenSky Network | Live aircraft |
| AISStream | Live vessels |
| Local AIS gap detector | Maritime anomaly signal |
| Space-Track / CelesTrak / Ivan TLE chain | Satellite TLEs |
| Space-Track GP_HISTORY | Targeted historical satellite tracks |
| Spectator Earth | Satellite sensor metadata |
| GDACS | Disaster alerts |
| USGS | Earthquakes |
| NASA EONET | Natural events |
| GDELT 2.0 | Conflict/security events |
| ACLED | Conflict events |
| GPSJam.org | GNSS interference |
| NASA FIRMS | Active fires and fire history |
| NASA GIBS / Worldview | MODIS/cloud/true-color imagery |
| Copernicus / Sentinel Hub | Sentinel imagery search/render |
| USGS Landsat STAC | Historical browse imagery |
| TeleGeography | Submarine cables |
| Natural Earth | Borders/reference |
| OpenAIP | Restricted airspace |
| Global Fishing Watch | AIS gap events |
| IODA / CAIDA | Internet outage alerts |
| Cloudflare Radar | Internet outages |
| WiGLE | Wi-Fi observations |
| OpenStreetMap Overpass | Infrastructure and pipelines |
| Overture Maps | Infrastructure enrichment |
| TomTom | Traffic tiles |
| HERE | Traffic flow |
| Live-Environment-Streams | Webcams |
| Caltrans | Traffic cameras |
| Windy Webcams | Global webcams |
| Yahoo Finance | Oil prices |
| EIA | Official energy/oil data |
| Our World in Data | Country energy statistics |
| Google Photorealistic 3D Tiles | 3D globe terrain/buildings |
| OpenStreetMap 3D Buildings | Building fallback |
| OpenRouter | AI image/vision workflow |

## Quick start

### Local development

Prerequisites:

- Node.js 20+
- npm
- PostgreSQL with PostGIS for local non-Docker runs
- provider accounts for data feeds and AI image workflows

```bash
git clone https://github.com/dimusdim/OpenSpy.git
cd OpenSpy

npm run install:all

cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env.local

npm run dev
```

Open `http://localhost:3737`.

The backend runs on `http://localhost:3055`. The backend dev script starts a project-local PostgreSQL cluster under `.local/postgres`, applies migrations automatically, and starts live ingest.

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

## Environment keys

Add provider credentials to `backend/.env` and frontend public keys to `frontend/.env.local`.

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

Imagery, space, enrichment, and AI:

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

## Agent harness

The product agent runs from the versioned harness in `agent-harness/`.

The backend treats the agent as a tool user:

- APIs return facts, diagnostics, provider metadata, and tool contracts;
- product behavior belongs in harness instructions and skills;
- map and replay actions go through OpenSpy commands;
- source access is visible through capability metadata.

## Architecture

- `frontend/` - Next.js 14, React, Cesium, Zustand, map layers, replay UI, AI image panel, settings, icon packs, shader controls.
- `backend/` - Express/TypeScript API, live ingest services, source-fetch tools, replay/query APIs, agent runtime, Postgres persistence.
- `backend/src/db/migrations/` - database schema for catalog, live states, snapshots, render chunks, selections, agents, and source metrics.
- `agent-harness/core/` - versioned OpenSpy product-agent instructions and skills.
- `agent-harness/tools/` - shell entrypoints exposed to local agent harnesses.
- `config/` - source/layer binding and icon target contracts.
- `sources-catalog.json` - source manifest used by catalog bootstrap.
- `layer-settings-schema.json` - layer tree and settings model.

Storage:

- PostgreSQL/PostGIS stores live state, snapshots, source metrics, selections, replay data, and agent sessions.
- DuckDB stores the local Overture Maps cache.
- Render chunks and runtime artifacts stay under local runtime paths.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

Useful areas to work on:

- data source connectors;
- source quality and provenance metadata;
- Cesium rendering performance;
- replay and timeline UX;
- agent tools and harness behavior;
- Docker and install flow;
- examples and product demos.

## Credits and inspiration

OpenSpy was inspired by Bilawal Sidhu's GodEyeView concept and the idea of an AI analyst working directly with an interactive globe.

## License

OpenSpy is licensed under the [Apache License 2.0](LICENSE).

## Follow

[LinkedIn](https://www.linkedin.com/in/dmitryalekhin/) · [YouTube](https://www.youtube.com/@DimaAlekhin) · [X / Twitter](https://x.com/Dmitry_Alekhin)
