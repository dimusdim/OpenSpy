import { Server, type Socket } from 'socket.io';
import axios from 'axios';
import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';
import { SourcePersistenceService } from './source-persistence.service';
import { LiveProjectionService, type LiveAircraftRecord, type LiveVesselRecord } from './live-projection.service';

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
 * Cached static data from AIS ShipStaticData messages.
 * PositionReport arrives frequently but carries no name/destination;
 * ShipStaticData arrives ~once every 6 min per vessel and fills these.
 */
interface VesselStaticData {
    cls: string;
    name?: string;
    callSign?: string;
    imo?: number;
    destination?: string;
    eta?: string;
    draught?: number;
    length?: number;
    beam?: number;
}

/**
 * Map AIS NavigationalStatus integer (ITU-R M.1371) to human-readable text.
 */
function mapNavStatus(status: number | null | undefined): string {
    if (status == null || status === 15) return '';
    const map: Record<number, string> = {
        0: 'Under way using engine',
        1: 'At anchor',
        2: 'Not under command',
        3: 'Restricted manoeuvrability',
        4: 'Constrained by draught',
        5: 'Moored',
        6: 'Aground',
        7: 'Engaged in fishing',
        8: 'Under way sailing',
        9: 'Reserved (HSC)',
        10: 'Reserved (WIG)',
        11: 'Power-driven towing astern',
        12: 'Power-driven pushing/towing',
        13: 'Reserved',
        14: 'AIS-SART/MOB/EPIRB',
    };
    return map[status] || '';
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

export interface DisasterEvent {
    id: string;
    type: string;
    source: string;
    eventType: string;
    alertLevel: string;
    radiusKm?: number;
    lat: number;
    lng: number;
    startTime: string;
    endTime: string;
    description: string;
    geometry?: {
        type: string;
        coordinates: any;
    } | null;
}

type DisasterFeedSnapshot = {
    sourceId: string;
    events: DisasterEvent[];
    rawPayload: unknown;
};

export class LiveStreamService {
    private io: Server;
    private timer: NodeJS.Timeout | null = null;
    private broadcastInFlight = false;

    private aircrafts = new Map<string, any>();
    private aircraftsDirty = false;  // true after fetchOpenSky refresh, false after broadcast
    private vesselsDirty = false;
    private liveAircraftCache: LiveAircraftRecord[] = [];
    private liveVesselCache: LiveVesselRecord[] = [];
    private lastAircraftCacheRefreshAt = 0;
    private lastVesselCacheRefreshAt = 0;
    // Health tracking — consumed by /api/status via getHealth().
    private openSkyHealth: 'streaming' | 'error' | 'auth-missing' | 'rate-limited' = 'streaming';
    private openSkyLastError: string | null = null;
    private openSkyNextRetry: string | null = null;
    private aisStreamHealth: 'streaming' | 'error' | 'auth-missing' | 'rate-limited' = 'streaming';
    private aisStreamLastError: string | null = null;
    private aisStreamNextRetry: string | null = null;
    private vessels = new Map<string, any>();
    // MMSI → vessel class string. Populated lazily from ShipStaticData messages,
    // which arrive far less frequently than PositionReport. Backed by a disk
    // cache (see VESSEL_TYPES_CACHE_FILE) so restarts retain learned classes.
    private vesselTypes = new Map<string, VesselStaticData>();
    private vesselTypesDirty = false;

    // Dark vessel detection: track last-seen time + report count per MMSI
    private vesselLastSeen = new Map<string, number>();       // MMSI → timestamp ms
    private vesselReportCount = new Map<string, number>();    // MMSI → # position reports received
    private darkVessels = new Map<string, DarkVessel>();
    
    constructor(
        io: Server,
        private readonly persistence?: SourcePersistenceService,
        private readonly liveProjection?: LiveProjectionService,
    ) {
        this.io = io;
    }

    start() {
        console.log('Initializing Real Data Streams (OpenSky, AISStream, GDACS+USGS+EONET)...');
        this.loadVesselTypesCache();
        this.initOpenSky();
        this.initAisStream();
        this.initDisasterFeeds();
        void this.refreshLiveCaches(true);

        // DB is the source of truth; this transport cache is derived from DB
        // snapshots and only exists to keep socket fanout cheap for the
        // frontend.
        this.timer = setInterval(() => {
            void this.broadcastLiveSnapshot();
        }, 2000);

        // When a new client connects, send the current full snapshot immediately —
        // aircraft + vessels + darkVessels — otherwise the client would either
        // wait for the next 2s tick (vessels-only, no aircraft/dark) or for the
        // next OpenSky refresh (up to 90s). Also prevents frontend reconciliation
        // from removing dark vessels it already tracks.
        this.io.on('connection', (socket) => {
            socket.data.needsInitialLiveSnapshot = true;
            void this.emitInitialSnapshot(socket);
        });

        // Periodic disk flush of the vessel-type cache (only when dirty).
        setInterval(() => this.flushVesselTypesCache(), VESSEL_TYPES_FLUSH_INTERVAL_MS);

        // Dark vessel detection: every 30s, scan vesselLastSeen for vessels
        // that haven't reported in >1h despite having had >3 position reports.
        setInterval(() => this.detectDarkVessels(), 30_000);
    }

    private countBySubtype(items: Array<{ type?: string | null }>): Record<string, number> {
        const counts: Record<string, number> = {};
        for (const item of items) {
            const subtype = item.type || 'unknown';
            counts[subtype] = (counts[subtype] || 0) + 1;
        }
        return counts;
    }

    private async refreshLiveCaches(force = false): Promise<void> {
        if (!this.liveProjection?.isReady()) return;

        const now = Date.now();

        if (
            force ||
            this.aircraftsDirty ||
            this.liveAircraftCache.length === 0 ||
            now - this.lastAircraftCacheRefreshAt >= 30_000
        ) {
            this.liveAircraftCache = await this.liveProjection.getAircraftLive();
            this.lastAircraftCacheRefreshAt = now;
            this.aircraftsDirty = false;
        }

        if (this.persistence) {
            await this.persistence.flushPendingVesselPositions();
        }
        if (
            force ||
            this.vesselsDirty ||
            this.liveVesselCache.length === 0 ||
            now - this.lastVesselCacheRefreshAt >= 30_000
        ) {
            this.liveVesselCache = await this.liveProjection.getVesselsLive();
            this.lastVesselCacheRefreshAt = now;
            this.vesselsDirty = false;
        }
    }

    private async broadcastLiveSnapshot(): Promise<void> {
        if (this.broadcastInFlight) return;
        this.broadcastInFlight = true;

        const shouldIncludeAircraft = this.aircraftsDirty || this.liveAircraftCache.length === 0;

        try {
            await this.refreshLiveCaches(false);

            const darkVesselsArr = Array.from(this.darkVessels.values());
            for (const socket of this.io.sockets.sockets.values()) {
                const includeAircraft = shouldIncludeAircraft || socket.data?.needsInitialLiveSnapshot === true;
                socket.emit('live-update', this.buildLivePayload(darkVesselsArr, includeAircraft));
                if (includeAircraft) {
                    socket.data.needsInitialLiveSnapshot = false;
                }
            }
        } catch (err: any) {
            console.warn('[LiveSocket] failed to build DB-backed live snapshot:', err?.message || err);
        } finally {
            this.broadcastInFlight = false;
        }
    }

    private buildLivePayload(darkVesselsArr: DarkVessel[], includeAircraft: boolean): any {
        const aircraftPayload = this.liveAircraftCache.length > 0
            ? this.liveAircraftCache
            : Array.from(this.aircrafts.values());
        const vesselPayload = this.liveVesselCache.length > 0
            ? this.liveVesselCache
            : Array.from(this.vessels.values());
        const payload: any = {
            vessels: vesselPayload,
            darkVessels: darkVesselsArr,
            meta: {
                aviationTotal: aircraftPayload.length,
                maritimeTotal: vesselPayload.length,
                aviationCounts: this.countBySubtype(aircraftPayload),
                maritimeCounts: this.countBySubtype(vesselPayload),
                darkVesselCount: darkVesselsArr.length,
            },
        };

        if (includeAircraft) {
            payload.aircrafts = aircraftPayload;
        }

        return payload;
    }

    private async emitInitialSnapshot(socket: Socket): Promise<void> {
        try {
            await this.refreshLiveCaches(true);
            const darkVesselsArr = Array.from(this.darkVessels.values());
            socket.emit('live-update', this.buildLivePayload(darkVesselsArr, true));
            socket.data.needsInitialLiveSnapshot = false;
        } catch (err: any) {
            console.warn('[LiveSocket] failed to send initial DB-backed snapshot:', err?.message || err);
        }
    }

    private loadVesselTypesCache() {
        try {
            if (fs.existsSync(VESSEL_TYPES_CACHE_FILE)) {
                const raw = fs.readFileSync(VESSEL_TYPES_CACHE_FILE, 'utf-8');
                const parsed = JSON.parse(raw) as Record<string, string | VesselStaticData>;
                for (const [mmsi, val] of Object.entries(parsed)) {
                    // Backward compat: old cache stored plain class string
                    if (typeof val === 'string') {
                        this.vesselTypes.set(mmsi, { cls: val });
                    } else {
                        this.vesselTypes.set(mmsi, val);
                    }
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
            const obj: Record<string, VesselStaticData> = {};
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

        // Prune stale vessels from the live map (no update in >30 min).
        // Prevents showing ghost ships at old positions indefinitely.
        const STALE_VESSEL_MS = 1800_000; // 30 min
        for (const [id, lastSeen] of this.vesselLastSeen) {
            if (now - lastSeen > STALE_VESSEL_MS && !this.darkVessels.has(id)) {
                this.vessels.delete(id);
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
            console.log(`[AISLost] ${this.darkVessels.size} vessels flagged dark`);
        }
    }

    private openSkyToken: string | null = null;
    private openSkyTokenExpiry: number = 0;

    private async getOpenSkyAuthHeader() {
        const clientId = process.env.OPENSKY_USERNAME;
        const clientSecret = process.env.OPENSKY_PASSWORD;

        if (!clientId || !clientSecret) {
            this.openSkyHealth = 'auth-missing';
            return {};
        }

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
            const errMsg = authError.response?.data
                ? (typeof authError.response.data === 'string' ? authError.response.data : JSON.stringify(authError.response.data))
                : (authError.message || 'auth failed');
            console.error('[OpenSky] OAuth2 Token Error:', errMsg);
            // Auth failure must propagate into health state — otherwise
            // /api/status will keep reporting 'streaming' while every fetch
            // silently falls back to anonymous credits and may be rate-limited.
            this.openSkyHealth = 'error';
            this.openSkyLastError = `OAuth: ${errMsg}`;
            this.openSkyToken = null;
            this.openSkyTokenExpiry = 0;
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
                    // Recovery path: if the previous fetch (or auth) failed,
                    // this successful response restores 'streaming' and clears
                    // stale error details so /api/status stops lying.
                    if (this.openSkyHealth !== 'streaming') {
                        this.openSkyHealth = 'streaming';
                        this.openSkyLastError = null;
                        this.openSkyNextRetry = null;
                    }
                    const states = res.data.states;
                    const newAircrafts = new Map<string, any>();
                    
                    states.forEach((s: any) => {
                        const icao24 = s[0]; // ICAO 24-bit hex address — unique per airframe
                        const callsign = s[1]?.trim() || icao24;
                        const lng = s[5];
                        const lat = s[6];
                        const alt = s[7] || s[13] || 10000;
                        const velocity = s[9];
                        const heading = s[10];
                        const origin = s[2] || ''; // origin country

                        if (lng === null || lat === null || !icao24) return;

                        // Primary key is icao24 (unique airframe). Callsign is display-only —
                        // multiple airframes can share the same callsign (rotating crew, empty callsign, etc.)
                        newAircrafts.set(icao24, {
                            id: icao24,
                            icao24,
                            callsign,
                            origin,
                            lat,
                            lng,
                            altMeters: alt,
                            alt: alt * 3.28084,
                            heading: heading || 0,
                            type: classifyAircraft(callsign, alt, velocity),
                            speedMps: velocity ?? null,
                            speed: velocity ? velocity * 3.6 : 0,
                            // New fields from state vector
                            onGround: s[8] === true,
                            verticalRate: s[11] ?? null,    // m/s
                            squawk: s[14] || null,           // 4-digit string
                            lastContact: s[4] || null,       // unix timestamp
                        });
                    });
                    
                    try {
                        await this.persistence?.persistAircraftPositions(Array.from(newAircrafts.values()));
                        this.aircrafts = newAircrafts;
                        this.aircraftsDirty = true;
                    } catch (err: any) {
                        console.warn('[OpenSky] failed to persist aircraft positions:', err?.message || err);
                        this.aircrafts = newAircrafts;
                    }
                    console.log(`[OpenSky] Updated ${this.aircrafts.size} real aircraft.`);
                }
            } catch (err: any) {
                const is429 = err?.response?.status === 429 || /429/.test(err.message);
                console.error(`[OpenSky] fetch failed (${is429 ? 'rate limited' : 'error'}):`, err.message);
                // Keep existing aircraft data on transient errors.
                if (is429) {
                    this.openSkyHealth = 'rate-limited';
                    this.openSkyLastError = 'Rate limited by OpenSky (429)';
                    this.openSkyNextRetry = new Date(Date.now() + OPENSKY_INTERVAL_MS).toISOString();
                } else {
                    this.openSkyHealth = 'error';
                    this.openSkyLastError = err.message || 'fetch failed';
                    this.openSkyNextRetry = null;
                }
            }
        };

        fetchOpenSky();
        setInterval(fetchOpenSky, OPENSKY_INTERVAL_MS);
    }

    // Per-vessel throttle: accept position update at most once per 20s.
    // At ~160 msg/s globally this cuts processing ~10x while keeping
    // positions fresh enough (20s ≈ 200m drift at 20 knots).
    private static AIS_VESSEL_THROTTLE_MS = 160_000; // ~2.5 min per vessel

    // Singleton guard — prevents duplicate WebSocket connections if
    // multiple frontends or hot-reloads trigger initAisStream.
    private aisWs: WebSocket | null = null;

    private initAisStream() {
        const apiKey = process.env.AISSTREAM_API_KEY;

        if (!apiKey) {
            console.warn('[AISStream] WARN: Missing AISSTREAM_API_KEY in .env. Maritime feed suspended.');
            this.aisStreamHealth = 'auth-missing';
            return;
        }

        // Singleton: if a WebSocket is already open, don't create another
        if (this.aisWs && this.aisWs.readyState === WebSocket.OPEN) {
            console.warn('[AISStream] WebSocket already connected — skipping duplicate init');
            return;
        }

        const connectWS = () => {
             // Guard again before reconnect
             if (this.aisWs && this.aisWs.readyState === WebSocket.OPEN) return;

             console.log('[AISStream] Connecting WebSocket (global, persistent)...');
             const ws = new WebSocket("wss://stream.aisstream.io/v0/stream");
             this.aisWs = ws;

             ws.on('open', () => {
                 console.log('[AISStream] Connected — streaming global AIS');
                 this.aisStreamHealth = 'streaming';
                 this.aisStreamLastError = null;
                 this.aisStreamNextRetry = null as any;
                 ws.send(JSON.stringify({
                     Apikey: apiKey,
                     BoundingBoxes: [[[-90.0, -180.0], [90.0, 180.0]]],
                     FiltersShipMMSI: [],
                     FilterMessageTypes: ["PositionReport", "ShipStaticData"]
                 }));
             });

             ws.on('message', (data) => {
                 try {
                     const parsed = JSON.parse(data.toString());

                     if (parsed.MessageType === 'ShipStaticData' && parsed.Message?.ShipStaticData) {
                         const stat = parsed.Message.ShipStaticData;
                         const id = String(stat.UserID);
                         const cls = aisTypeToClass(stat.Type);
                         const dim = stat.Dimension || {};
                         const staticData: VesselStaticData = {
                             cls,
                             name: stat.Name || undefined,
                             callSign: stat.CallSign || undefined,
                             imo: stat.ImoNumber || undefined,
                             destination: stat.Destination || undefined,
                             eta: stat.Eta ? `${stat.Eta.Month}/${stat.Eta.Day} ${stat.Eta.Hour}:${String(stat.Eta.Minute).padStart(2,'0')}` : undefined,
                             draught: stat.MaximumStaticDraught || undefined,
                             length: (dim.A && dim.B) ? dim.A + dim.B : undefined,
                             beam: (dim.C && dim.D) ? dim.C + dim.D : undefined,
                         };
                         this.vesselTypes.set(id, staticData);
                         this.vesselTypesDirty = true;
                         // Update live vessel with new static data
                         const existing = this.vessels.get(id);
                         if (existing) {
                             existing.type = cls;
                             existing.name = staticData.name;
                             existing.callSign = staticData.callSign;
                             existing.imo = staticData.imo;
                             existing.destination = staticData.destination;
                             existing.eta = staticData.eta;
                             existing.draught = staticData.draught;
                             existing.length = staticData.length;
                             existing.beam = staticData.beam;
                         }
                         return;
                     }

                     if (parsed.MessageType === 'PositionReport' && parsed.Message?.PositionReport) {
                         const report = parsed.Message.PositionReport;
                         const id = String(report.UserID);

                         // Per-vessel throttle: skip if updated less than 20s ago
                         const now = Date.now();
                        const lastSeen = this.vesselLastSeen.get(id);
                         if (lastSeen && now - lastSeen < LiveStreamService.AIS_VESSEL_THROTTLE_MS) return;

                         const cached = this.vesselTypes.get(id);
                         this.vessels.set(id, {
                             id,
                             lat: report.Latitude,
                             lng: report.Longitude,
                             heading: report.TrueHeading || 0,
                             type: cached?.cls || 'unknown',
                             speed: report.Sog || 0,
                             // AIS PositionReport fields
                             navigationStatus: mapNavStatus(report.NavigationalStatus),
                             rateOfTurn: report.RateOfTurn ?? null,
                             cog: report.Cog ?? null,
                             // Static data from ShipStaticData cache
                             name: cached?.name || null,
                             callSign: cached?.callSign || null,
                             imo: cached?.imo || null,
                             destination: cached?.destination || null,
                             eta: cached?.eta || null,
                             draught: cached?.draught || null,
                             length: cached?.length || null,
                             beam: cached?.beam || null,
                         });
                         this.persistence?.queueVesselPosition({
                             id,
                             lat: report.Latitude,
                             lng: report.Longitude,
                             heading: report.TrueHeading || 0,
                             type: cached?.cls || 'unknown',
                             speedKnots: report.Sog ?? null,
                             navigationStatus: mapNavStatus(report.NavigationalStatus),
                             rateOfTurn: report.RateOfTurn ?? null,
                             cog: report.Cog ?? null,
                             name: cached?.name || null,
                             callSign: cached?.callSign || null,
                             imo: cached?.imo || null,
                             destination: cached?.destination || null,
                             eta: cached?.eta || null,
                             draught: cached?.draught ?? null,
                             length: cached?.length ?? null,
                             beam: cached?.beam ?? null,
                             observedAt: new Date().toISOString(),
                         });
                         this.vesselsDirty = true;

                         this.vesselLastSeen.set(id, now);
                         this.vesselReportCount.set(id, (this.vesselReportCount.get(id) || 0) + 1);

                         if (this.darkVessels.has(id)) {
                             console.log(`[AISLost] ${id} reappeared after ${Math.round((now - this.darkVessels.get(id)!.darkSince) / 60000)}m dark`);
                             this.darkVessels.delete(id);
                         }

                         // Hard cap — 50k vessels ≈ 5 MB RAM, safe
                         if (this.vessels.size > 50000) {
                             const firstKey = this.vessels.keys().next().value;
                             if (firstKey !== undefined) {
                                 this.vessels.delete(firstKey);
                                 this.vesselTypes.delete(firstKey);
                                 this.vesselLastSeen.delete(firstKey);
                                 this.vesselReportCount.delete(firstKey);
                                 this.darkVessels.delete(firstKey);
                             }
                         }
                     }
                 } catch (err: any) {
                     console.warn('[AISStream] malformed message ignored:', err?.message || err);
                 }
             });

             // Track whether close was triggered by a 429 so we don't
             // wipe preserved vessel data in the close handler.
             let closedDueToRateLimit = false;

             ws.on('close', () => {
                 this.aisWs = null;
                 const delay = closedDueToRateLimit ? 300_000 : 5_000;
                 const delayLabel = closedDueToRateLimit ? '5 min' : '5s';
                 console.log(`[AISStream] Disconnected. Reconnecting in ${delayLabel}...`);
                 if (!closedDueToRateLimit) {
                     // Keep vessel data on normal disconnect — don't wipe
                     this.aisStreamHealth = 'error';
                 }
                 this.aisStreamNextRetry = new Date(Date.now() + delay).toISOString();
                 closedDueToRateLimit = false;
                 setTimeout(connectWS, delay);
             });

             ws.on('error', (err) => {
                 const is429 = /429/.test(err.message);
                 console.error(`[AISStream] WS Error (${is429 ? 'rate limited' : 'error'}):`, err.message);
                 if (is429) {
                     closedDueToRateLimit = true;
                     this.aisStreamHealth = 'rate-limited';
                     this.aisStreamLastError = 'Rate limited (429). Retry in 5 min';
                 } else {
                     this.aisStreamHealth = 'error';
                     this.aisStreamLastError = err.message;
                 }
                 ws.close();
             });
        };

        connectWS();
    }

    private initDisasterFeeds() {
        // Derived disaster view over three real sources. We refresh them on
        // separate intervals because their upstream cadences differ wildly:
        //   GDACS  — disaster bulletins,        ~5 min     (robots.txt 1/60s)
        //   USGS   — earthquakes >M2.5 / week,  ~5 min     (no rate limit doc)
        //   EONET  — NASA natural events,       ~15 min    (curated, slow)
        // All three return GeoJSON-ish feature collections. We normalize them
        // into one derived disaster view keyed by source_id in storage.
        const fetchAll = async () => {
            const merged: DisasterEvent[] = [];
            const rawPayloads: Array<{ source_id: string; payload: unknown; metadata: Record<string, any> }> = [];
            const [gdacs, usgs, eonet] = await Promise.allSettled([
                this.fetchGdacs(),
                this.fetchUsgs(),
                this.fetchEonet(),
            ]);
            if (gdacs.status === 'fulfilled') {
                merged.push(...gdacs.value.events);
                rawPayloads.push({
                    source_id: gdacs.value.sourceId,
                    payload: gdacs.value.rawPayload,
                    metadata: { format: 'json', payloadKind: 'upstream_response' },
                });
            }
            if (usgs.status === 'fulfilled')  {
                merged.push(...usgs.value.events);
                rawPayloads.push({
                    source_id: usgs.value.sourceId,
                    payload: usgs.value.rawPayload,
                    metadata: { format: 'json', payloadKind: 'upstream_response' },
                });
            }
            if (eonet.status === 'fulfilled') {
                merged.push(...eonet.value.events);
                rawPayloads.push({
                    source_id: eonet.value.sourceId,
                    payload: eonet.value.rawPayload,
                    metadata: { format: 'json', payloadKind: 'upstream_response' },
                });
            }
            try {
                await this.persistence?.persistDisasterEvents(merged, { rawPayloads });
            } catch (err: any) {
                console.warn('[Disasters] failed to persist snapshot:', err?.message || err);
            }
            console.log(`[Disasters] Aggregated ${merged.length} events ` +
                        `(GDACS=${gdacs.status === 'fulfilled' ? gdacs.value.events.length : 'err'}, ` +
                        `USGS=${usgs.status === 'fulfilled' ? usgs.value.events.length : 'err'}, ` +
                        `EONET=${eonet.status === 'fulfilled' ? eonet.value.events.length : 'err'})`);
        };

        fetchAll();
        // 5 minutes is our slowest source's polite rate; the others are fine
        // with this too. GDACS robots.txt caps at 1 request per 60s; we sit
        // at 5 min for headroom and to match upstream's actual update cadence.
        setInterval(fetchAll, 300_000);
    }

    private extractPointLikeCoordinates(geometry: any): [number, number] | null {
        if (!geometry?.coordinates) return null;

        if (
            geometry.type === 'Point' &&
            Array.isArray(geometry.coordinates) &&
            geometry.coordinates.length >= 2
        ) {
            return [Number(geometry.coordinates[0]), Number(geometry.coordinates[1])];
        }

        const flat = (geometry.coordinates.flat(Infinity) as unknown[]).filter((value) => typeof value === 'number');
        if (flat.length < 2) return null;
        return [Number(flat[0]), Number(flat[1])];
    }

    private async fetchGdacs(): Promise<DisasterFeedSnapshot> {
        const res = await axios.get('https://www.gdacs.org/gdacsapi/api/events/geteventlist/MAP', { timeout: 15000 });
        if (!res.data?.features) return { sourceId: 'gdacs', events: [], rawPayload: res.data ?? null };
        // Approximate impact radius by event type (km). GDACS's per-event
        // severity endpoint has precise values but requires N individual
        // requests — too expensive. These fixed radii give a reasonable
        // visual feel on the globe.
        const defaultRadii: Record<string, number> = {
            EQ: 100, TC: 300, FL: 150, VO: 50, WF: 80, DR: 200,
        };
        const out: DisasterEvent[] = [];
        for (const f of res.data.features) {
            const coords = this.extractPointLikeCoordinates(f.geometry);
            if (!coords) continue;
            const et = (f.properties.eventtype || 'XX').toUpperCase();
            const [lng, lat] = coords;
            out.push({
                id: `gdacs-${f.properties.eventid}`,
                type: 'strike',
                source: 'GDACS',
                eventType: et,
                alertLevel: f.properties.alertlevel || 'Green',
                radiusKm: defaultRadii[et] || 100,
                lat,
                lng,
                startTime: new Date(f.properties.fromdate).toISOString(),
                endTime: new Date(Date.now() + 86400000).toISOString(),
                description: f.properties.name,
                geometry: f.geometry || null,
            });
        }
        return {
            sourceId: 'gdacs',
            events: out,
            rawPayload: res.data,
        };
    }

    private async fetchUsgs(): Promise<DisasterFeedSnapshot> {
        // Past-week M2.5+ earthquakes, GeoJSON, no auth needed.
        // https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_week.geojson
        const res = await axios.get('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_week.geojson', { timeout: 15000 });
        if (!res.data?.features) return { sourceId: 'usgs', events: [], rawPayload: res.data ?? null };
        const events = res.data.features.map((f: any) => {
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
                geometry: f.geometry || null,
            };
        });
        return {
            sourceId: 'usgs',
            events,
            rawPayload: res.data,
        };
    }

    private async fetchEonet(): Promise<DisasterFeedSnapshot> {
        // NASA EONET — wildfires, volcanoes, severe storms, icebergs etc.
        // https://eonet.gsfc.nasa.gov/api/v3/events?status=open
        const res = await axios.get('https://eonet.gsfc.nasa.gov/api/v3/events?status=open&limit=200', { timeout: 15000 });
        if (!res.data?.events) return { sourceId: 'eonet', events: [], rawPayload: res.data ?? null };
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
        const out: DisasterEvent[] = [];
        for (const ev of res.data.events) {
            const cat = ev.categories?.[0]?.id || '';
            const code = catToCode[cat] || 'XX';
            const lastGeom = ev.geometry?.[ev.geometry.length - 1];
            const coords = this.extractPointLikeCoordinates(lastGeom);
            if (!coords) continue;
            const [lng, lat] = coords;
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
                geometry: lastGeom || null,
            });
        }
        return {
            sourceId: 'eonet',
            events: out,
            rawPayload: res.data,
        };
    }

    // Real health state — consumed by /api/status so the frontend can
    // distinguish "streaming", "error" (upstream failing), and "auth-missing"
    // (no API key) instead of guessing from env presence.
    getHealth() {
        return {
            aviation: {
                status: this.openSkyHealth,
                note: this.openSkyLastError || undefined,
                count: this.liveAircraftCache.length,
                nextRetry: this.openSkyNextRetry || undefined,
            },
            maritime: {
                status: this.aisStreamHealth,
                note: this.aisStreamLastError || undefined,
                count: this.liveVesselCache.length,
                nextRetry: this.aisStreamNextRetry || undefined,
            },
        };
    }
}
