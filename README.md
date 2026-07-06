<div align="center">

# 🌍 OpenSpy

### The open-source AI intelligence globe

**Ask an AI what's happening anywhere on Earth. It runs the investigation and shows you, on a live 3D globe.**

[![License](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-20%2B-brightgreen)](package.json)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-orange)](CONTRIBUTING.md)
[![Stars](https://img.shields.io/github/stars/dimusdim/OpenSpy?style=social)](https://github.com/dimusdim/OpenSpy)

[Quick start](#-quick-start-60-seconds) · [AI agents](#%EF%B8%8F-ai-does-your-osint) · [Satellites](#%EF%B8%8F-satellites--live-orbits) · [Time machine](#-time-machine) · [Image lab](#-ai-image-lab) · [Data sources](#%EF%B8%8F-data-sources)

<!-- TODO: 15-second demo GIF here: question typed -> camera flies -> layers light up -> replay scrubs -> briefing appears. This single GIF matters more than any text below. -->

</div>

---

## ✨ Features

- 🕵️ **AI runs your OSINT** — agents investigate live and recorded data, correlate events, deliver intel briefings on the globe
- 🌐 **40+ data sources, 20 live map layers** — one globe: planes, ships, satellites, fires, wars, disasters, blackouts, airspace, traffic, infrastructure
- 🛰️ **19,000 satellites, live** — real orbits (SGP4), classes, moving sensor footprints
- 🖼️ **Satellite imagery on demand** — daily NASA MODIS, fresh Sentinel-2 and Landsat scenes for any area
- ⏪ **Time machine** — every position recorded; scrub any region back through time
- 🚢 **Dark ship detection** — vessels that go AIS-silent get flagged automatically, with Global Fishing Watch evidence on top
- 🪪 **Ship dossiers** — click a vessel: photo, registry identity, owner, flag
- 📡 **GNSS jamming map** — live GPS interference cells over conflict zones
- 🧠 **AI image lab** — reconstruct and reimagine any globe view with image models, in full geographic context
- 📶 **Signals & infrastructure** — Wi-Fi access points, 6K+ live webcams, submarine cables, power grids, pipelines
- 🗺️ **Photoreal 3D basemaps** — Google 3D cities, terrain, daily satellite imagery
- 🔌 **AI-extendable by design** — open data contracts: new sources, new agents, new tools plug in fast

## 🚀 Quick start (60 seconds)

```bash
git clone https://github.com/dimusdim/OpenSpy.git
cd OpenSpy
npm run install:all
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env.local
npm run dev
```

Open **http://localhost:3737** — the globe is already alive. The backend brings up its own PostgreSQL, migrates, and starts live ingest. Or run `npm run docker:up`.

## 🕵️ AI does your OSINT

The OpenSpy data layer integrates with any AI agentic harness — **Claude Code** and **Codex CLI** work out of the box, and the integration contract is open for whatever harness you already run.

The AI conducts open-source intelligence for you. It replays everything recorded over time, correlates events across every layer, pulls fresh data from the connected sources, and ships with analyst skills for building intelligence reports — delivered as visual briefings right on the globe, not as a wall of chat text.

> **You:** *anything unusual around Suez in the last 12 hours?*
>
> The agent pulls AIS tracks, flags vessels with transponder gaps, cross-checks conflict events and this morning's satellite passes, replays the suspicious window on the globe and delivers a briefing where every claim links to a layer, a time window and a source.

## 🛰️ Satellites & live orbits

19,000+ satellites from the Space-Track / CelesTrak TLE chain, propagated live with SGP4 in parallel Web Workers. Classified into military, recon, commercial and civilian, with orbital trails and click-through details.

Imaging satellites get moving sensor footprints projected on the ground, sized to the real sensor swath (Spectator Earth) — not a guessed cone.

## 🖼️ Satellite imagery

Pull real imagery onto the globe:

- daily global MODIS true-color from NASA GIBS, with cloud cover
- search and render fresh **Sentinel-2** scenes (Copernicus) for any area, overlay with adjustable opacity, attach to an investigation
- historical **Landsat** browse imagery for context

The agent can fetch a fresh pass for an area on demand and drop it on the scene as evidence.

## ⏪ Time machine

A specialized geo time-series backend (PostgreSQL + PostGIS, time-partitioned storage, binary playback chunks) records every position the globe sees.

- **~600K position updates ingested per hour** → **~200 MB/hour** of database growth (~5 GB/day at full uptime)
- drag the timeline and any region replays itself, with trails and per-interval data coverage shown right on the scrub bar
- the AI can build the replay for you: fly to, select, scrub to a moment, leave trails, play a window

## 🧠 AI image lab

Point an image model at the globe itself.

- capture any camera view and reconstruct it as a high-quality Earth scene
- build context-aware scenario visuals — the model sees exactly what the globe sees, real geography included
- overlay the generated result back on the original frame and compare

Turn a raw satellite chip into a presentation-ready visual, or explore "what would this look like if…" on top of real terrain.

## 🚢 Dark ships

Vessels that were actively transmitting and then go silent for over an hour get flagged automatically by the built-in detector. Global Fishing Watch gap events add independent evidence. Click any flagged ship and the dossier opens: photo, registry identity, owner, flag — assembled live from open registries.

## 📊 Objects on the globe

| | |
|---|---:|
| Aircraft tracked | 11K+ |
| Vessels tracked | 17K+ |
| Satellites on orbit | 19K+ |
| Fire hotspots | 30K+ |
| Airspace zones | 9K+ |
| Live webcams | 6K+ |
| Infrastructure objects | 5M+ |
| **Live data ingested** | **~600K updates / hr → ~200 MB / hr** |
| **Database growth** | **~5 GB / day** |

## 🗂️ Data sources

Access column: ✅ no key · 🆓 free key/account · 💳 paid.

| Source | What OpenSpy gets from it | Where it shows up | Access |
|---|---|---|---|
| ✈️ OpenSky Network | live aircraft: position, altitude, speed, heading, callsign, route | aircraft layer, per-class icons, flight cards | 🆓 free account, ~4K credits/day |
| 🚢 AISStream | live AIS: position, course, speed, vessel class, destination, IMO | vessel layer, vessel cards, tracks | 🆓 free key, unlimited stream |
| 🕶️ Built-in dark-ship detector | vessels that stop transmitting AIS after being tracked | "AIS signal lost" markers on last known position | ✅ built in |
| 🎣 Global Fishing Watch | AIS gap events — suspected dark activity at sea | dark vessel event markers with gap details | 🆓 free, non-commercial |
| 🛰️ Space-Track / CelesTrak | orbital elements for 19K+ satellites | live satellites propagated with SGP4, orbits, classes | 🆓 free account (CelesTrak keyless fallback) |
| 📷 Spectator Earth | imaging satellite sensor metadata | moving sensor footprints over the ground | 🆓 free account |
| 🛂 OpenAIP | restricted, prohibited, danger and warning airspace | altitude-aware 3D airspace volumes | 🆓 free key |
| 🔥 NASA FIRMS | active fire hotspots: brightness, radiative power, confidence, history | fire layer with severity colors | ✅ live feed · 🆓 free key for history (5K req / 10 min) |
| 🌪️ GDACS | disaster alerts: earthquakes, cyclones, floods, volcanoes, droughts | disaster badges with alert level | ✅ no key |
| 🌍 USGS | M2.5+ earthquakes worldwide | earthquake events on the globe | ✅ no key |
| 🌋 NASA EONET | natural events: wildfires, storms, volcanoes, icebergs | disaster layer | ✅ no key |
| ⚔️ ACLED | armed conflict events: battles, explosions, violence | conflict markers by event type | 🆓 free account |
| 📰 GDELT 2.0 | global conflict and security events mined from news | conflict layer, agent analytics | ✅ no key |
| 📡 GPSJam | GNSS interference derived from aircraft navigation integrity | hex jamming cells by severity | ✅ no key |
| 🌐 IODA | internet outages from BGP and active probing | outage events per country/region | ✅ no key |
| ☁️ Cloudflare Radar | internet outage annotations from the Cloudflare edge | outage layer | 🆓 free token |
| 📶 WiGLE | crowdsourced Wi-Fi access point observations | Wi-Fi layer: open / encrypted / unknown points | 🆓 free account, daily query cap |
| 🎥 Live Environment Streams, Windy, Caltrans | 6K+ live webcams worldwide | camera markers with live view | ✅ no key (Windy: free key) |
| 🌊 TeleGeography | global submarine cable network | cable routes on the seafloor | ✅ no key |
| 🏭 Overture Maps + OSM Overpass | 5M+ infrastructure objects: power plants, substations, oil/gas/water pipelines, refineries, dams, military areas, towers | infrastructure layer with per-type icons | ✅ no key |
| 🚗 TomTom / HERE | live road traffic flow | traffic overlay | 🆓 free tier |
| 🗺️ NASA GIBS / Worldview | daily MODIS true-color imagery and clouds | satellite basemap and cloud layer | ✅ no key |
| 🛰️ Copernicus / Sentinel Hub | Sentinel-2 scene search and rendered imagery chips | investigation overlays, before/after evidence | 🆓 free account |
| 🛰️ USGS Landsat STAC | historical Landsat browse imagery | historical visual context | ✅ no key |
| 🏙️ Google Photorealistic 3D Tiles | photoreal 3D cities | basemap mode | 💳 Google Cloud billing |
| 🏔️ Cesium ion | world terrain, aerial imagery, OSM 3D buildings | basemap mode | 🆓 free token |
| 🪪 Wikimedia Commons | vessel photos keyed by IMO number | ship dossier cards | ✅ no key |
| 🛢️ Yahoo Finance, EIA, OWID, World Bank | oil prices and energy context | analytics widgets | ✅ no key |
| 🧠 OpenRouter | image and vision models | AI image lab | 💳 pay-per-use |
| 🗺️ Natural Earth | country borders and reference geography | border layer | ✅ no key |

**More than half the sources need no key at all** — clone and the globe is alive. The rest take free accounts; the settings panel shows the live status of every key (including expired tokens) with a registration link for each.

## 🏗️ Built with

**Frontend** Next.js 14 · React · CesiumJS · Zustand — **Backend** Express + TypeScript · PostgreSQL/PostGIS · DuckDB — **AI** versioned agentic harness, open tool contracts.

The whole stack runs on a MacBook Air M4 and scales to the cloud — Docker images included. The backend is a tool provider: it serves data and capabilities, the AI decides what to do with them.

## 🧭 Roadmap

- more AI harness targets beyond Claude Code and Codex CLI
- paid API connectors — the source framework is built to plug them in fast
- cloud deployment recipes
- temporal joins for moving objects — *"which vessels crossed this zone while it was jammed?"*
- deeper entity dossiers: aircraft, satellites, per-entity imagery timelines

## 🤝 Contributing

PRs welcome — highest-value areas: new data connectors, Cesium performance, replay UX, agent tools, example investigations. See [CONTRIBUTING.md](CONTRIBUTING.md).

**If OpenSpy is useful or interesting to you, star the repo** — it helps other researchers find it.

## 🙏 Credits

Inspired by [Bilawal Sidhu's](https://x.com/bilawalsidhu) **GodEyeView** — a conceptual demo of a live real-time globe visualization.

## 📜 License

Apache 2.0 — see [LICENSE](LICENSE).

---

<div align="center">

Built by **Dmitry Alekhin** as an AI-first product, end to end: data engineering, 3D rendering, agentic AI.

[LinkedIn](https://www.linkedin.com/in/dmitryalekhin/) · [YouTube](https://www.youtube.com/@DimaAlekhin) · [X / Twitter](https://x.com/Dmitry_Alekhin)

</div>
