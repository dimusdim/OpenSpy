# OpenSpy

Real-time 3D global intelligence platform. 29 live data sources. 60,000+ tracked entities. Self-hosted with one command.

<!-- Replace with demo GIF or video embed -->
<!-- ![OpenSpy Demo](docs/media/demo.gif) -->

> **Credits:** This project was inspired by an amazing idea from Bilawal Sidhu, whose GodEyeView concept showed what a real-time global intelligence view could look like. Huge respect for putting that vision out there. OpenSpy is an open-source implementation that takes the idea further with more data sources and AI analysis.

---

See everything happening on Earth, in real time, on one screen. Open source. Free.

- ✈️ **Military flight tracking** — 11,000 aircraft with automatic military callsign detection
- 🚢 **Dark vessel alerts** — Ships that stop broadcasting get flagged instantly
- 🛰️ **Spy satellite footprints** — 300 satellites with sensor cones projected on the ground (KH-11, WorldView, Capella SAR, Gaofen, Persona)
- 💥 **Armed conflict mapping** — Battles, explosions, fatality counts, actor names, live coordinates
- ⚠️ **GPS jamming zones** — 840+ interference zones as 3D hexagonal columns, color-scaled by severity
- 🔥 **66,000 fire hotspots** — NASA data refreshed every 30 minutes, intensity-scaled
- 🌐 **Internet outage detection** — Country-level monitoring, cross-verified by two independent systems
- 📹 **70,000+ live webcams** — Streams from 80 countries play right inside the globe
- 🏭 **Critical infrastructure** — Power plants, refineries, military bases, pipelines, 710 submarine cables
- 🚫 **10,000+ restricted airspace** — Full 3D volumes with altitude floors and ceilings
- 🤖 **AI vision analysis** — Screenshot any view, get an intelligence report, fly back to it later
- 🌍 **Google 3D Tiles + OSM Buildings** — Photorealistic terrain, switchable on the fly
- 📈 **Oil prices live** — Brent and WTI, real-time
- 🚗 **Road traffic** — TomTom flow tiles, speed per segment
- ⏱️ **Timeline replay** — Scrub through time at 0.001x to 3600x speed

---

## Features

### ✈️ Aerospace

**Aircraft tracking** — 11,000 aircraft via ADS-B (OpenSky Network). Military callsign detection. Real-time positions, altitude, speed, heading. Aircraft classified as airliner, military, light, or general aviation. Photos pulled from Planespotters by ICAO24 hex code. Route origin/destination lookup by callsign.

**Restricted airspace** — 10,000+ zones rendered as 3D volumes with altitude limits. Restricted, Danger, Prohibited, Alert, Warning types from OpenAIP. Full vertical extent visualization so you see the actual shape of no-fly zones in three dimensions.

**Historical flight replay** — Enter any ICAO24 hex code, load a past flight track, and replay it on the globe with timeline scrubbing.

### 🚢 Maritime

**Vessel tracking** — 2,000 vessels via real-time AIS WebSocket push (AISStream). 30-minute path trails. Cargo, tanker, passenger, fishing, and military classification with distinct iconography for each type.

**Dark vessel detection** — Automatic flagging when a vessel's AIS signal drops for more than one hour. Last known position and heading interpolated. Separate dark-vessel markers rendered on the globe.

**Dark vessel events (Global Fishing Watch)** — AIS-disabling events, at-sea encounters, suspicious loitering, fishing activity gaps. Independent detection from a global monitoring authority.

### 🛰️ Space

**Satellite tracking** — 300 classified satellites with SGP4 orbital propagation. Military, commercial, civilian, and reconnaissance categories. Precomputed orbital trails. NORAD IDs, country of origin, orbit type (LEO/MEO/GEO).

**Sensor footprint projection** — Reconnaissance and Earth-observation satellites get projected ground coverage cones based on real Spectator Earth sensor metadata. Swath width, sensor type (Optical/SAR), resolution. The footprint moves with the satellite in real time. Tracked platforms include KH-11 series (USA-224, USA-245, USA-290, USA-314), WorldView-1/2/3, GeoEye-1, Capella-2/3 SAR, Gaofen-1/2/11, and Persona (Bars-M).

### 💥 Conflicts and Threats

**Armed conflicts** — ACLED data. Battles, explosions/remote violence, violence against civilians. Each event carries coordinates, fatality count, actor names, event date. Markers scaled by severity, color-coded by type.

**GPS/GNSS jamming** — 840+ interference zones from GPSJam.org. H3 hexagonal cells extruded into 3D columns by interference intensity. Red for severe (50%+), orange for moderate, yellow for low.

**OSINT events** — Earthquakes, cyclones, floods, volcanoes, wildfires, droughts aggregated from GDACS, USGS, and NASA EONET. Impact zone ellipses. Alert level color coding (Red/Orange/Green).

### 🏭 Infrastructure

**Critical infrastructure** — Power plants, substations, refineries, desalination plants, military bases. Dual-source: OpenStreetMap Overpass API + Overture Maps with automatic deduplication. Viewport-based progressive loading.

**Oil and gas pipelines** — Global pipeline network. Oil (red) vs gas (blue) substance classification. Full route polylines.

**Submarine cables** — 710 undersea cable routes from TeleGeography. The physical internet backbone.

**Power grid** — Plants, substations, transmission lines from OpenStreetMap.

### 🔥 Environment

**Active fires** — 66,000+ hotspots from NASA FIRMS VIIRS. 30-minute refresh. Fire Radiative Power (FRP) determines marker intensity: high, medium, low. Brightness and confidence metadata on click.

**Cloud cover** — MODIS satellite imagery overlay from NASA GIBS.

**Satellite imagery** — MODIS Terra true-color daily imagery at 250m resolution.

### 🌐 Connectivity

**Internet outages** — Dual-source detection. IODA (country-level BGP monitoring and active probing) cross-verified with Cloudflare Radar (confirmed outages with cause analysis). Two independent systems agreeing means a real outage.

**Oil prices** — Brent crude and WTI spot prices, live. Daily change, spread. EIA + Yahoo Finance.

### 📹 Surveillance

**Live webcams** — 70,000+ cameras from three aggregated sources: Live-Environment-Streams (5,242 cameras across 80 countries), Windy (65,000 cameras), and Caltrans (2,000 California cameras). HLS stream playback directly in the interface. Click any camera on the globe and the live feed opens.

**AI vision analysis** — Screenshot the current globe view. AI analyzes the scene and writes an intelligence report describing what it sees. Every screenshot is saved to a gallery with the exact viewport coordinates, so you can fly back to the same camera angle later.

---

## Data Sources

Every layer pulls from a real, documented source. You should know exactly where the data comes from.

Out of 29 sources below, **17 require no authentication at all**. The remaining 12 offer free tiers or free registration. No paid API keys are required to run OpenSpy. Rate limits are respected on every source to avoid overloading upstream providers.

| Source | Data | Auth | Update Frequency |
|--------|------|------|-----------------|
| OpenSky Network | Aircraft positions, callsigns, ICAO24, altitude, speed, heading, origin | Free account | Polled every 90s |
| Planespotters | Aircraft photos by ICAO24 | None | On demand |
| AISStream | Vessel positions, MMSI, type, heading, speed via WebSocket | Free API key | Real-time push (2-10s) |
| CelesTrak | Satellite TLEs, NORAD IDs, orbital elements | None | Cached 24h, upstream 2-3x/day |
| Spectator Earth | Satellite sensor metadata (swath, type, resolution) | None | On load, 24h TTL |
| satellite.js | SGP4 orbital propagation (client-side) | None | Computed per frame |
| ACLED | Armed conflict events: battles, explosions, violence, fatalities, actors | Free account | Polled every 30m |
| GPSJam.org | GNSS interference zones, H3 resolution 4 | None | Daily CSV, fetched every 6h |
| GDACS | Earthquakes, cyclones, floods, volcanoes, droughts | None | Polled every 5m |
| USGS | Earthquake data | None | Polled every 5m |
| NASA EONET | Natural events (wildfires, storms, icebergs) | None | Polled every 5m |
| NASA FIRMS | Active fire hotspots (VIIRS), FRP, brightness, confidence | None | CSV every 30m |
| NASA GIBS | MODIS cloud cover + true-color satellite imagery | None | Daily tiles |
| TeleGeography | Submarine cable routes (710 cables) | None | Static GeoJSON |
| Natural Earth | Country borders (110m resolution) | None | Static GeoJSON |
| OpenStreetMap (Overpass) | Infrastructure: refineries, power plants, substations, military bases, pipelines, power lines | None | Viewport-triggered, 1h cache |
| Overture Maps | Infrastructure dedup layer (via DuckDB) | None | On viewport |
| OpenAIP | Restricted airspace polygons with altitude limits | Free API key | Polled every 1h |
| Global Fishing Watch | Dark vessel events: AIS gaps, encounters, loitering, fishing | Free token | Polled every 1h |
| IODA (CAIDA) | Internet outages: BGP, active probing, darknet | None | Polled every 5m |
| Cloudflare Radar | Confirmed internet outages with cause/scope | Free account | Polled every 5m |
| TomTom | Road traffic flow tiles (speed per segment) | Free API key (50K tiles/day) | Real-time (~1 min) |
| Live-Environment-Streams | 5,242 webcams in 80 countries (HLS) | None | Live streams |
| Windy Webcams | 65,000 webcams worldwide | Free API key | Preview images, 10-min expiry |
| Caltrans | 2,000 California traffic cameras (HLS) | None | Live streams |
| EIA | Oil prices: Brent, WTI, petroleum data | Free API key | Daily |
| Yahoo Finance | Oil futures (BZ=F, CL=F), real-time quotes | None (npm lib) | 15-min delay |
| Google 3D Tiles | Photorealistic 3D terrain and buildings | Cesium Ion token | Streamed on demand |
| OpenStreetMap Buildings | 3D building footprints (fallback) | None | Streamed on demand |

---

## Quick Start

```bash
git clone https://github.com/dimusdim/openspy.git
cd openspy

# Install dependencies
npm run install:all

# Configure
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env.local
# Edit .env files to add API keys (most layers work without any)

# Run
npm run dev
```

Open `http://localhost:3737`.

With Docker:

```bash
docker-compose up
```

Most layers work out of the box with zero API keys. For the full experience, register free accounts for: OpenSky, AISStream, ACLED, OpenAIP, and optionally TomTom, Windy, Cloudflare, Global Fishing Watch. Signup links are in `SOURCES.md`.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). New data layers, performance improvements, UI work, bug fixes, all welcome.

---

## Coming Next

AI agent integration. Ask questions about what you see in natural language. The agent queries historical intelligence data, runs cross-layer analysis, and generates reports.

---

## Credits & Inspiration

OpenSpy is an open-source reimplementation of the vision originally presented by [Bilawal Sidhu](https://www.youtube.com/@BilaSidhu) in his project GodEyeView. The idea of an AI-native OSINT interface centered on an interactive globe belongs to him. This project is my attempt to bring that vision to the open-source community under a permissive license.

Huge respect to [Bilawal Sidhu](https://www.youtube.com/@BilaSidhu) for pushing this space forward.

— Dima Alekhin

---

## License

[Apache 2.0](LICENSE)

---

## Follow

[LinkedIn](https://www.linkedin.com/in/dmitryalekhin/) · [YouTube](https://www.youtube.com/@DimaAlekhin) · [X / Twitter](https://x.com/Dmitry_Alekhin)
