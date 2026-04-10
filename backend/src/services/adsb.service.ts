import { Server } from 'socket.io';
import axios from 'axios';
import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';

// Persistent disk cache for vessel-class lookups. AISStream's ShipStaticData
// arrives ~once every 6 minutes per vessel, so without persistence every
// restart shows tens of minutes of generic 'unknown' icons until static data
// trickles back in. With this cache, the moment a fresh PositionReport comes
// in for a previously-seen MMSI we already know its class.
const VESSEL_TYPES_CACHE_FILE = path.join(__dirname, '../../vessel_types_cache.json');
const VESSEL_TYPES_CACHE_MAX = 50_000;
// Debounce disk writes — we don't need to fsync every static-data message.
const VESSEL_TYPES_FLUSH_INTERVAL_MS = 60_000;

// Common military / state-aircraft callsign prefixes (USAF, RAF, Russian VKS,
// FrAF, NATO, transport tankers, AWACS, recon, training). Not exhaustive but
// covers the bulk of what shows up in the European bbox.
const MIL_CALLSIGN_RE = /^(RCH|RRR|REACH|FORTE|BLOCK|MAGMA|HOIST|KING|NAVY|AF|VKS|RFF|GAF|GAFAIR|FRAF|RFR|RRF|RFAF|NATO|AWACS|SENTRY|JAKE|DUKE|HOMER|NCR|NORAD)/;


/**
 * Map an AIS Type code (ITU-R M.1371) to a coarse class our frontend renders.
 * Codes 30..89 are standardised; everything else falls back to 'unknown'.
 *   30..39 → fishing / SAR / tug etc. ⇒ fishing/military depending on subclass
 *   60..69 → passenger ships          ⇒ passenger
 *   70..79 → cargo ships              ⇒ cargo
 *   80..89 → tankers                  ⇒ tanker
 *   35     → military ops             ⇒ military
 */
function aisTypeToClass(t: number | null | undefined): 'cargo' | 'tanker' | 'passenger' | 'fishing' | 'military' | 'unknown' {
    if (t == null) return 'unknown';
    if (t === 35) return 'military';
    if (t === 30) return 'fishing';
    if (t >= 60 && t <= 69) return 'passenger';
    if (t >= 70 && t <= 79) return 'cargo';
    if (t >= 80 && t <= 89) return 'tanker';
    return 'unknown';
}

/**
 * Classify an aircraft from its callsign + altitude (m) + ground speed (m/s).
 * Heuristic only — OpenSky's free /states/all does not include the ADS-B
 * emitter category, so we infer from flight envelope. Order matters:
 *   1. Callsign-based military match wins outright.
 *   2. Cruise envelope (>=8 km, >=180 m/s ≈ 350 kt) → airliner.
 *   3. Slow + low → light (GA piston / turboprop / heli).
 *   4. Anything else → general aviation.
 */
function classifyAircraft(callsign: string, altMeters: number | null, speedMps: number | null): 'military' | 'airliner' | 'light' | 'general' {
    const cs = (callsign || '').toUpperCase().trim();
    if (cs && MIL_CALLSIGN_RE.test(cs)) return 'military';
    const alt = altMeters || 0;
    const spd = speedMps || 0;
    if (alt >= 8000 && spd >= 180) return 'airliner';
    if (alt < 2000 && spd < 80) return 'light';
    return 'general';
}

export interface DarkVessel {
    id: string;
    lat: number;
    lng: number;
    heading: number;
    speed: number;
    type: string;
    lastSeen: number;    // unix ms
    darkSince: number;   // unix ms
}

export class SimulatorService { // Keeping name SimulatorService for index.ts compatibility, but it uses real data
    private io: Server;
    private timer: NodeJS.Timeout | null = null;

    private aircrafts = new Map<string, any>();
    private vessels = new Map<string, any>();
    // MMSI → vessel class string. Populated lazily from ShipStaticData messages,
    // which arrive far less frequently than PositionReport. Backed by a disk
    // cache (see VESSEL_TYPES_CACHE_FILE) so restarts retain learned classes.
    private vesselTypes = new Map<string, string>();
    private vesselTypesDirty = false;
    private osintEvents: any[] = [];

    // Dark vessel detection: track last-seen time + report count per MMSI
    private vesselLastSeen = new Map<string, number>();       // MMSI → timestamp ms
    private vesselReportCount = new Map<string, number>();    // MMSI → # position reports received
    private darkVessels = new Map<string, DarkVessel>();
    
    constructor(io: Server) {
        this.io = io;
    }

    start() {
        console.log('Initializing Real Data Streams (OpenSky, AISStream, GDACS+USGS+EONET)...');
        this.loadVesselTypesCache();
        this.initOpenSky();
        this.initAisStream();
        this.initOsint();

        // Broadcast every 2 seconds, but ONLY include aircraft when OpenSky
        // has actually updated (dirty flag). Between updates (44 out of 45
        // ticks in a 90-second cycle), we skip the 1.1 MB aircraft array
        // entirely — the frontend already has the positions and they haven't
        // changed. Vessels are always included (AIS streams continuously).
        // Jamming zones sent only on first tick (static data).
        let tickCount = 0;
        this.timer = setInterval(() => {
            tickCount++;
            const vessels = Array.from(this.vessels.values());

            const maritimeCounts: Record<string, number> = {};
            for (const v of vessels) {
                maritimeCounts[v.type] = (maritimeCounts[v.type] || 0) + 1;
            }

            const darkVesselsArr = Array.from(this.darkVessels.values());

            const payload: any = {
                vessels,
                darkVessels: darkVesselsArr,
                meta: {
                    aviationTotal: this.aircrafts.size,
                    maritimeTotal: vessels.length,
                    maritimeCounts,
                    darkVesselCount: darkVesselsArr.length,
                },
            };


            // Always include aircraft when we have data. BillboardCollection
            // on the frontend handles 11K updates efficiently (direct position
            // set, no per-frame property evaluation). The 1.1MB JSON parse
            // takes ~5ms — acceptable vs the UX cost of delayed aircraft.
            if (this.aircrafts.size > 0) {
                const aircrafts = Array.from(this.aircrafts.values());
                payload.aircrafts = aircrafts;
                const aviationCounts: Record<string, number> = {};
                for (const ac of aircrafts) {
                    aviationCounts[ac.type] = (aviationCounts[ac.type] || 0) + 1;
                }
                payload.meta.aviationCounts = aviationCounts;
            }

            this.io.emit('simulator-update', payload);
        }, 2000);

        // Periodic disk flush of the vessel-type cache (only when dirty).
        setInterval(() => this.flushVesselTypesCache(), VESSEL_TYPES_FLUSH_INTERVAL_MS);

        // Dark vessel detection: every 30s, scan vesselLastSeen for vessels
        // that haven't reported in >1h despite having had >3 position reports.
        setInterval(() => this.detectDarkVessels(), 30_000);
    }

    private loadVesselTypesCache() {
        try {
            if (fs.existsSync(VESSEL_TYPES_CACHE_FILE)) {
                const raw = fs.readFileSync(VESSEL_TYPES_CACHE_FILE, 'utf-8');
                const parsed = JSON.parse(raw) as Record<string, string>;
                for (const [mmsi, cls] of Object.entries(parsed)) {
                    this.vesselTypes.set(mmsi, cls);
                }
                console.log(`[VesselCache] Loaded ${this.vesselTypes.size} cached vessel classes from disk.`);
            }
        } catch (err: any) {
            console.warn('[VesselCache] Failed to load cache:', err.message);
        }
    }

    private flushVesselTypesCache() {
        if (!this.vesselTypesDirty) return;
        try {
            // FIFO trim if oversized
            if (this.vesselTypes.size > VESSEL_TYPES_CACHE_MAX) {
                const overflow = this.vesselTypes.size - VESSEL_TYPES_CACHE_MAX;
                const it = this.vesselTypes.keys();
                for (let i = 0; i < overflow; i++) {
                    const k = it.next().value;
                    if (k !== undefined) this.vesselTypes.delete(k);
                }
            }
            const obj: Record<string, string> = {};
            this.vesselTypes.forEach((v, k) => { obj[k] = v; });
            fs.writeFileSync(VESSEL_TYPES_CACHE_FILE, JSON.stringify(obj));
            this.vesselTypesDirty = false;
            console.log(`[VesselCache] Flushed ${this.vesselTypes.size} entries to disk.`);
        } catch (err: any) {
            console.warn('[VesselCache] Failed to flush:', err.message);
        }
    }
    
    private detectDarkVessels() {
        const now = Date.now();
        const DARK_THRESHOLD_MS = 3600_000; // 1 hour
        const MIN_REPORTS = 3;              // must have been actively tracked

        for (const [id, lastSeen] of this.vesselLastSeen) {
            if (now - lastSeen > DARK_THRESHOLD_MS && !this.darkVessels.has(id)) {
                const reportCount = this.vesselReportCount.get(id) || 0;
                if (reportCount < MIN_REPORTS) continue;

                // Vessel was actively tracked but went silent — flag as dark.
                // Use last known position from the vessels map (may have been
                // evicted by FIFO, in which case skip).
                const vessel = this.vessels.get(id);
                if (!vessel) continue;

                this.darkVessels.set(id, {
                    id,
                    lat: vessel.lat,
                    lng: vessel.lng,
                    heading: vessel.heading || 0,
                    speed: vessel.speed || 0,
                    type: vessel.type || 'unknown',
                    lastSeen,
                    darkSince: now,
                });
            }
        }

        // Prune stale dark vessels (gone dark > 24h — likely just left the area)
        for (const [id, dv] of this.darkVessels) {
            if (now - dv.darkSince > 86400_000) {
                this.darkVessels.delete(id);
                this.vesselLastSeen.delete(id);
                this.vesselReportCount.delete(id);
            }
        }

        if (this.darkVessels.size > 0) {
            console.log(`[DarkVessel] ${this.darkVessels.size} vessels flagged dark`);
        }
    }

    private openSkyToken: string | null = null;
    private openSkyTokenExpiry: number = 0;

    private async getOpenSkyAuthHeader() {
        const clientId = process.env.OPENSKY_USERNAME;
        const clientSecret = process.env.OPENSKY_PASSWORD;

        if (!clientId || !clientSecret) return {};

        if (this.openSkyToken && Date.now() < this.openSkyTokenExpiry) {
            return { headers: { Authorization: `Bearer ${this.openSkyToken}` } };
        }

        try {
            console.log('[OpenSky] Requesting OAuth2 Token...');
            const params = new URLSearchParams({
                grant_type: 'client_credentials',
                client_id: clientId,
                client_secret: clientSecret
            });

            const res = await axios.post('https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token', params.toString(), {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            });

            this.openSkyToken = res.data.access_token;
            // Buffer expiration by 1 minute
            this.openSkyTokenExpiry = Date.now() + (res.data.expires_in * 1000) - 60000;
            
            console.log('[OpenSky] OAuth2 Token acquired successfully. Unlocking 4000 Credits.');
            return { headers: { Authorization: `Bearer ${this.openSkyToken}` } };
        } catch (authError: any) {
            console.error('[OpenSky] OAuth2 Token Error:', authError.response?.data || authError.message);
            return {};
        }
    }

    private async initOpenSky() {
        // OpenSky credit budget: OAuth2 standard tier = 4000 credits/day.
        // /states/all with a bbox > 400 sq.deg costs 4 credits/call. Our Europe
        // bbox is ~1000 sq.deg => 4 credits. 4000 / 4 = 1000 calls/day max =
        // one call every ~86s. We use 90s to leave headroom for token refresh
        // retries. Going faster (e.g. the previous 15s) burns the daily quota
        // in ~4 hours and triggers HTTP 429s for the rest of the day.
        const OPENSKY_INTERVAL_MS = 90_000;
        const fetchOpenSky = async () => {
            try {
                const config = await this.getOpenSkyAuthHeader();
                // Global query (no bbox). Per OpenSky pricing, anything > 400
                // sq.deg costs the same 4 credits/call as a global request, so
                // we may as well take the whole world. 86400 / 90 = 960 calls
                // /day × 4 credits = 3840 credits/day, still under the 4000/day
                // OAuth2 standard-tier ceiling.
                const res = await axios.get('https://opensky-network.org/api/states/all', config);
                if (res.data && res.data.states) {
                    const states = res.data.states;
                    const newAircrafts = new Map<string, any>();
                    
                    states.forEach((s: any) => {
                        const icao24 = s[0]; // ICAO 24-bit hex address
                        const callsign = s[1]?.trim() || icao24;
                        const lng = s[5];
                        const lat = s[6];
                        const alt = s[7] || s[13] || 10000;
                        const velocity = s[9];
                        const heading = s[10];
                        const origin = s[2] || ''; // origin country

                        if (lng === null || lat === null) return;

                        newAircrafts.set(callsign, {
                            id: callsign,
                            icao24,
                            origin,
                            lat,
                            lng,
                            alt: alt * 3.28084,
                            heading: heading || 0,
                            type: classifyAircraft(callsign, alt, velocity),
                            speed: velocity ? velocity * 3.6 : 0
                        });
                    });
                    
                    this.aircrafts = newAircrafts;
                    console.log(`[OpenSky] Updated ${this.aircrafts.size} real aircraft.`);
                }
            } catch (err: any) {
                console.error('[OpenSky] fetch failed (rate limit or timeout):', err.message);
                this.aircrafts.clear(); // Ensure 0 entities if stream is dead
            }
        };

        fetchOpenSky();
        setInterval(fetchOpenSky, OPENSKY_INTERVAL_MS);
    }

    private initAisStream() {
        const apiKey = process.env.AISSTREAM_API_KEY;
        
        if (!apiKey) {
            console.warn('[AISStream] WARN: Missing AISSTREAM_API_KEY in .env. Maritime feed suspended.');
            return;
        }

        const connectWS = () => {
             console.log('[AISStream] Connecting WS with Token...');
             const ws = new WebSocket("wss://stream.aisstream.io/v0/stream");

             ws.on('open', () => {
                 console.log('[AISStream] Connected to WebSocket');
                 // Subscribe to BOTH position and static-data messages so we
                 // can resolve real vessel types instead of hard-coding 'cargo'.
                 // ShipStaticData arrives every ~6 minutes per vessel, so the
                 // extra bandwidth is negligible compared to PositionReport.
                 const subscriptionMessage = {
                     Apikey: apiKey,
                     BoundingBoxes: [[[-10.0, -10.0], [50.0, 50.0]]],
                     FiltersShipMMSI: [],
                     FilterMessageTypes: ["PositionReport", "ShipStaticData"]
                 };
                 ws.send(JSON.stringify(subscriptionMessage));
             });

             ws.on('message', (data) => {
                 try {
                     const parsed = JSON.parse(data.toString());

                     // Cache vessel class from static data so subsequent
                     // PositionReports can render the right icon.
                     if (parsed.MessageType === 'ShipStaticData' && parsed.Message?.ShipStaticData) {
                         const stat = parsed.Message.ShipStaticData;
                         const id = String(stat.UserID);
                         const cls = aisTypeToClass(stat.Type);
                         const prev = this.vesselTypes.get(id);
                         if (prev !== cls) {
                             this.vesselTypes.set(id, cls);
                             this.vesselTypesDirty = true;
                         }
                         // Patch already-tracked vessel in place if present.
                         const existing = this.vessels.get(id);
                         if (existing) existing.type = cls;
                         return;
                     }

                     if (parsed.MessageType === 'PositionReport' && parsed.Message?.PositionReport) {
                         const report = parsed.Message.PositionReport;
                         const id = String(report.UserID);
                         this.vessels.set(id, {
                             id,
                             lat: report.Latitude,
                             lng: report.Longitude,
                             heading: report.TrueHeading || 0,
                             type: this.vesselTypes.get(id) || 'unknown',
                             speed: report.Sog || 0
                         });

                         // Dark vessel tracking: record last-seen time + increment report count
                         this.vesselLastSeen.set(id, Date.now());
                         this.vesselReportCount.set(id, (this.vesselReportCount.get(id) || 0) + 1);

                         // If this vessel was flagged dark, it just reappeared — remove from dark list
                         if (this.darkVessels.has(id)) {
                             console.log(`[DarkVessel] ${id} reappeared after ${Math.round((Date.now() - this.darkVessels.get(id)!.darkSince) / 60000)}m dark`);
                             this.darkVessels.delete(id);
                         }

                         if (this.vessels.size > 2000) {
                             const firstKey = this.vessels.keys().next().value;
                             if (firstKey !== undefined) {
                                 this.vessels.delete(firstKey);
                                 this.vesselTypes.delete(firstKey);
                             }
                         }
                     }
                 } catch(err) {}
             });

             ws.on('close', () => {
                 console.log('[AISStream] Disconnected. Reconnecting in 5s...');
                 // Clear positions but KEEP vesselTypes — that cache is the
                 // entire point of persistence; otherwise icons reset to
                 // 'unknown' on every reconnect.
                 this.vessels.clear();
                 setTimeout(connectWS, 5000);
             });

             ws.on('error', (err) => {
                 console.error('[AISStream] WS Error:', err.message);
                 this.vessels.clear();
                 ws.close();
             });
        };

        connectWS();
    }

    private initOsint() {
        // OSINT layer aggregates three free open feeds. We refresh them on
        // separate intervals because their upstream cadences differ wildly:
        //   GDACS  — disaster bulletins,        ~5 min     (robots.txt 1/60s)
        //   USGS   — earthquakes >M2.5 / week,  ~5 min     (no rate limit doc)
        //   EONET  — NASA natural events,       ~15 min    (curated, slow)
        // All three return GeoJSON-ish feature collections. We normalise them
        // into a single shape with `source`/`eventType`/`alertLevel`/coords.
        const fetchAll = async () => {
            const merged: any[] = [];
            const [gdacs, usgs, eonet] = await Promise.allSettled([
                this.fetchGdacs(),
                this.fetchUsgs(),
                this.fetchEonet(),
            ]);
            if (gdacs.status === 'fulfilled') merged.push(...gdacs.value);
            if (usgs.status === 'fulfilled')  merged.push(...usgs.value);
            if (eonet.status === 'fulfilled') merged.push(...eonet.value);
            this.osintEvents = merged;
            console.log(`[OSINT] Aggregated ${merged.length} events ` +
                        `(GDACS=${gdacs.status === 'fulfilled' ? gdacs.value.length : 'err'}, ` +
                        `USGS=${usgs.status === 'fulfilled' ? usgs.value.length : 'err'}, ` +
                        `EONET=${eonet.status === 'fulfilled' ? eonet.value.length : 'err'})`);
        };

        fetchAll();
        // 5 minutes is our slowest source's polite rate; the others are fine
        // with this too. GDACS robots.txt caps at 1 request per 60s; we sit
        // at 5 min for headroom and to match upstream's actual update cadence.
        setInterval(fetchAll, 300_000);
    }

    private async fetchGdacs(): Promise<any[]> {
        const res = await axios.get('https://www.gdacs.org/gdacsapi/api/events/geteventlist/MAP', { timeout: 15000 });
        if (!res.data?.features) return [];
        // Approximate impact radius by event type (km). GDACS's per-event
        // severity endpoint has precise values but requires N individual
        // requests — too expensive. These fixed radii give a reasonable
        // visual feel on the globe.
        const defaultRadii: Record<string, number> = {
            EQ: 100, TC: 300, FL: 150, VO: 50, WF: 80, DR: 200,
        };
        return res.data.features.map((f: any) => {
            const et = (f.properties.eventtype || 'XX').toUpperCase();
            return {
                id: `gdacs-${f.properties.eventid}`,
                type: 'strike',
                source: 'GDACS',
                eventType: et,
                alertLevel: f.properties.alertlevel || 'Green',
                radiusKm: defaultRadii[et] || 100,
                lat: f.geometry.coordinates[1],
                lng: f.geometry.coordinates[0],
                startTime: new Date(f.properties.fromdate).toISOString(),
                endTime: new Date(Date.now() + 86400000).toISOString(),
                description: f.properties.name,
            };
        });
    }

    private async fetchUsgs(): Promise<any[]> {
        // Past-week M2.5+ earthquakes, GeoJSON, no auth needed.
        // https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_week.geojson
        const res = await axios.get('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_week.geojson', { timeout: 15000 });
        if (!res.data?.features) return [];
        return res.data.features.map((f: any) => {
            const mag = f.properties.mag ?? 0;
            // Map magnitude to GDACS-style alert level for shared colour code:
            //   M < 5.5 → Green, 5.5–6.5 → Orange, ≥ 6.5 → Red
            const alertLevel = mag >= 6.5 ? 'Red' : mag >= 5.5 ? 'Orange' : 'Green';
            // Approximate "felt" radius: scales exponentially with magnitude.
            // M3 ≈ 30 km, M5 ≈ 100 km, M7 ≈ 300 km — rough but visually useful.
            const radiusKm = Math.round(10 * Math.pow(10, (mag - 2) / 3));
            return {
                id: `usgs-${f.id}`,
                type: 'strike',
                source: 'USGS',
                eventType: 'EQ',
                alertLevel,
                radiusKm,
                lat: f.geometry.coordinates[1],
                lng: f.geometry.coordinates[0],
                startTime: new Date(f.properties.time).toISOString(),
                endTime: new Date(f.properties.time + 7 * 86400_000).toISOString(),
                description: `M${mag.toFixed(1)} — ${f.properties.place || 'unknown location'}`,
            };
        });
    }

    private async fetchEonet(): Promise<any[]> {
        // NASA EONET — wildfires, volcanoes, severe storms, icebergs etc.
        // https://eonet.gsfc.nasa.gov/api/v3/events?status=open
        const res = await axios.get('https://eonet.gsfc.nasa.gov/api/v3/events?status=open&limit=200', { timeout: 15000 });
        if (!res.data?.events) return [];
        // EONET categories → GDACS-style codes (best effort)
        const catToCode: Record<string, string> = {
            wildfires: 'WF',
            volcanoes: 'VO',
            severeStorms: 'TC',
            floods: 'FL',
            drought: 'DR',
            earthquakes: 'EQ',
            seaLakeIce: 'XX',
            snow: 'XX',
            dustHaze: 'XX',
            manmade: 'XX',
            landslides: 'XX',
            waterColor: 'XX',
            tempExtremes: 'XX',
        };
        const out: any[] = [];
        for (const ev of res.data.events) {
            const cat = ev.categories?.[0]?.id || '';
            const code = catToCode[cat] || 'XX';
            const lastGeom = ev.geometry?.[ev.geometry.length - 1];
            if (!lastGeom?.coordinates) continue;
            // EONET geometry coords are [lng, lat] for Point, but Polygon for some events.
            let lng: number, lat: number;
            if (lastGeom.type === 'Point') {
                [lng, lat] = lastGeom.coordinates;
            } else {
                // Take centroid-ish first vertex of polygon
                const flat = (lastGeom.coordinates.flat(Infinity) as number[]);
                if (flat.length < 2) continue;
                lng = flat[0]; lat = flat[1];
            }
            out.push({
                id: `eonet-${ev.id}`,
                type: 'strike',
                source: 'NASA EONET',
                eventType: code,
                alertLevel: 'Orange', // EONET doesn't grade; default mid-tier
                lat,
                lng,
                startTime: lastGeom.date || new Date().toISOString(),
                endTime: new Date(Date.now() + 7 * 86400_000).toISOString(),
                description: ev.title,
            });
        }
        return out;
    }

    getOsintEvents() {
        return this.osintEvents;
    }
}
