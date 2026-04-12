import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { SpectatorService } from './spectator.service';

const CACHE_FILE = path.join(__dirname, '../../satellites_cache.json');
const CACHE_TTL = 1000 * 60 * 60 * 24; // 24 hours

// TLE provider chain — tried in order until one succeeds.
// 1. Space-Track.org  — US Space Command, primary source, needs login
// 2. CelesTrak.org    — popular mirror, rate-limits aggressively (403 bans)
// 3. tle.ivanstanojevic.me — free JSON API, 24K+ sats, no auth needed
const SPACETRACK_LOGIN_URL = 'https://www.space-track.org/ajaxauth/login';
// format/3le gives 3-line elements (name + line1 + line2), same as CelesTrak
const SPACETRACK_TLE_URL = 'https://www.space-track.org/basicspacedata/query/class/gp/EPOCH/%3Enow-30/orderby/NORAD_CAT_ID/format/3le';
const CELESTRAK_URLS = [
    'https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=tle',
    'https://celestrak.com/NORAD/elements/gp.php?GROUP=active&FORMAT=tle',
];
const IVAN_TLE_URL = 'https://tle.ivanstanojevic.me/api/tle';

export interface ReconMeta {
    noradId: number;
    name: string;
    country: string;
    sensorType: string;
    resolution: string;
}

/**
 * Spectator Earth sensor metadata attached to a satellite record when
 * Spectator's catalog has an entry for the matching NORAD id. Frontend
 * uses this to render an honest projected footprint cone (nadir + rays
 * + ground ellipse) sized to the real sensor swath; satellites without
 * this field simply don't get a footprint.
 */
export interface SatelliteSensorMeta {
    sensorName: string;
    swathMeters: number;
    sensorType: 'OPTICAL' | 'SAR' | 'OTHER';
    platform: string | null;
    source: 'spectator-earth';
}

export interface SatelliteRecord {
    name: string;
    tleLine1: string;
    tleLine2: string;
    type: 'military' | 'civilian' | 'commercial';
    // NORAD catalog number — extracted from TLE line 1. Exposed to the
    // frontend so client code can join with external catalogs (e.g.
    // Spectator Earth sensor metadata).
    noradId: number;
    recon?: boolean;
    reconMeta?: ReconMeta;
    // Present only when Spectator Earth has sensor metadata for this
    // NORAD id. Frontend uses it to render the projected footprint.
    sensor?: SatelliteSensorMeta;
}

const RECON_SATELLITES: ReconMeta[] = [
    { noradId: 32060, name: 'WorldView-1', country: 'US', sensorType: 'Optical', resolution: '0.5m' },
    { noradId: 35946, name: 'WorldView-2', country: 'US', sensorType: 'Optical', resolution: '0.46m' },
    { noradId: 40115, name: 'WorldView-3', country: 'US', sensorType: 'Optical', resolution: '0.31m' },
    { noradId: 33331, name: 'GeoEye-1', country: 'US', sensorType: 'Optical', resolution: '0.41m' },
    { noradId: 39150, name: 'Gaofen-1', country: 'China', sensorType: 'Optical', resolution: '2m' },
    { noradId: 40118, name: 'Gaofen-2', country: 'China', sensorType: 'Optical', resolution: '0.8m' },
    { noradId: 37348, name: 'USA-224 (KH-11)', country: 'US', sensorType: 'Optical', resolution: '~0.1m' },
    { noradId: 40258, name: 'USA-245 (KH-11)', country: 'US', sensorType: 'Optical', resolution: '~0.1m' },
    { noradId: 40420, name: 'Persona (Bars-M)', country: 'Russia', sensorType: 'Optical', resolution: '~0.5m' },
];

/** Extract NORAD catalog number from TLE line 1 (columns 3–7) */
function extractNoradId(tleLine1: string): number {
    // TLE line 1 format: 1 NNNNN ...
    const match = tleLine1.match(/^1\s+(\d+)/);
    return match ? parseInt(match[1], 10) : -1;
}

/** Build a lookup map from NORAD ID to recon metadata */
const RECON_BY_NORAD = new Map(RECON_SATELLITES.map(r => [r.noradId, r]));

export class SatelliteService {
    private satellites: SatelliteRecord[] = [];
    // Timestamp of the Spectator catalog that was used the last time we
    // enriched `this.satellites`. When SpectatorService.getLastFetchTime()
    // returns a newer value (because a lazy TTL refresh landed between
    // requests), `reEnrichAllIfNeeded()` walks every record and rebuilds
    // its `sensor` field from the fresh catalog. Without this, a TTL
    // refresh that completed in the background would be invisible to
    // /api/satellites because `this.satellites` is a frozen snapshot.
    private lastEnrichedSpectatorFetch = 0;
    // Injected so the same Spectator instance stays shared across services —
    // avoids a double catalog fetch at boot and keeps TTL state in one place.
    constructor(private spectator: SpectatorService | null = null) {}

    async init() {
        await this.loadSatellites();
        // Record the Spectator catalog version that matches the enrichment
        // already baked into `this.satellites` by loadSatellites(). Any
        // subsequent refresh bumps Spectator's lastFetch past this value
        // and `reEnrichAllIfNeeded()` rebuilds the sensor fields.
        if (this.spectator) {
            this.lastEnrichedSpectatorFetch = this.spectator.getLastFetchTime();
        }
    }

    /**
     * Rebuild the `sensor` field on every satellite record when the
     * Spectator catalog has been refreshed since we last enriched.
     *
     * This runs on every `/api/satellites` request (via `getSatellites()`)
     * so lazy TTL refreshes fired by `SpectatorService.getMeta` during an
     * earlier request get picked up on the NEXT request without any
     * background workers. The check itself is O(1) — just a timestamp
     * comparison — so there's no cost in the steady state.
     */
    private reEnrichAllIfNeeded() {
        if (!this.spectator) return;
        const specFetch = this.spectator.getLastFetchTime();
        if (specFetch === 0) return;
        if (specFetch <= this.lastEnrichedSpectatorFetch) return;

        for (const rec of this.satellites) {
            delete rec.sensor;
            this.enrichWithSpectator(rec);
        }
        this.lastEnrichedSpectatorFetch = specFetch;
        const withSensor = this.satellites.filter((r) => !!r.sensor).length;
        console.log(
            `[SatelliteService] Re-enriched ${this.satellites.length} satellites ` +
            `(${withSensor} with sensor data) from Spectator catalog refreshed at ` +
            `${new Date(specFetch).toISOString()}`
        );
    }

    /**
     * Attach Spectator Earth sensor metadata (swath, sensor type, platform)
     * to a record when Spectator's catalog knows about the NORAD id. Called
     * both during fresh TLE parsing and after reading from the on-disk
     * cache, so a cached JSON produced before Spectator was wired in still
     * gets enriched on boot without touching CelesTrak.
     */
    private enrichWithSpectator(rec: SatelliteRecord): void {
        if (!this.spectator) return;
        const meta = this.spectator.getMeta(rec.noradId);
        if (!meta) return;
        // Only attach when swath is meaningful — a zero swath means
        // Spectator knows the satellite but doesn't have a usable sensor
        // mode, which is effectively the same as "no data" for footprint
        // rendering purposes.
        if (meta.sensorSwathMeters <= 0) return;
        rec.sensor = {
            sensorName: meta.sensorName,
            swathMeters: meta.sensorSwathMeters,
            sensorType: meta.sensorType,
            platform: meta.platform,
            source: 'spectator-earth',
        };
    }

    /**
     * TLE provider chain: Space-Track → CelesTrak → ivanstanojevic.me
     * Returns raw TLE text (name\nline1\nline2 triples).
     */
    private async fetchTLEChain(): Promise<string> {
        // 1. Space-Track.org (primary — US Space Command)
        const stEmail = process.env.SPACETRACK_EMAIL;
        const stPass = process.env.SPACETRACK_PASSWORD;
        if (stEmail && stPass) {
            try {
                // Login to get session cookie
                const login = await axios.post(SPACETRACK_LOGIN_URL,
                    `identity=${encodeURIComponent(stEmail)}&password=${encodeURIComponent(stPass)}`,
                    { timeout: 15_000, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
                );
                const cookies = login.headers['set-cookie'];
                if (cookies) {
                    const cookie = cookies.map((c: string) => c.split(';')[0]).join('; ');
                    const res = await axios.get(SPACETRACK_TLE_URL, {
                        timeout: 60_000,
                        headers: { Cookie: cookie },
                    });
                    if (res.data && typeof res.data === 'string' && res.data.includes('1 ')) {
                        // Space-Track 3le prefixes names with "0 " — strip it
                        const cleaned = res.data.replace(/^0 /gm, '');
                        console.log('[Satellites] TLE from Space-Track.org');
                        return cleaned;
                    }
                }
            } catch (err: any) {
                console.warn('[Satellites] Space-Track failed:', err.message);
            }
        }

        // 2. CelesTrak mirrors
        for (const url of CELESTRAK_URLS) {
            try {
                const res = await axios.get(url, { timeout: 30_000 });
                if (res.data && typeof res.data === 'string' && res.data.includes('1 ')) {
                    console.log(`[Satellites] TLE from ${new URL(url).hostname}`);
                    return res.data;
                }
            } catch (err: any) {
                console.warn(`[Satellites] ${new URL(url).hostname} failed: ${err.message}`);
            }
        }

        // 3. ivanstanojevic.me (JSON API — convert to TLE text)
        try {
            console.log('[Satellites] Trying tle.ivanstanojevic.me fallback...');
            const allLines: string[] = [];
            // Paginate — API returns max 100 per page
            for (let page = 1; page <= 50; page++) {
                const res = await axios.get(`${IVAN_TLE_URL}?page=${page}&page_size=100`, {
                    timeout: 15_000,
                });
                const members = res.data?.member ?? [];
                if (members.length === 0) break;
                for (const m of members) {
                    if (m.name && m.line1 && m.line2) {
                        allLines.push(m.name, m.line1, m.line2);
                    }
                }
                // Stop after ~5000 sats (enough for our 300 cap)
                if (allLines.length > 15000) break;
            }
            if (allLines.length > 0) {
                console.log(`[Satellites] TLE from ivanstanojevic.me (${allLines.length / 3} sats)`);
                return allLines.join('\n');
            }
        } catch (err: any) {
            console.warn('[Satellites] ivanstanojevic.me failed:', err.message);
        }

        throw new Error('All TLE providers failed (Space-Track, CelesTrak, ivanstanojevic.me)');
    }

    private async loadSatellites() {
        try {
            if (fs.existsSync(CACHE_FILE)) {
                const stat = fs.statSync(CACHE_FILE);
                if (Date.now() - stat.mtimeMs < CACHE_TTL) {
                    const data = fs.readFileSync(CACHE_FILE, 'utf-8');
                    const parsed = JSON.parse(data);
                    if (!Array.isArray(parsed)) throw new Error('corrupt cache');
                    this.satellites = parsed;
                    // Backfill noradId on records cached before the field
                    // was added — preserves cache validity across the
                    // schema change without forcing a CelesTrak refetch.
                    for (const rec of this.satellites) {
                        if (typeof rec.noradId !== 'number' || rec.noradId < 0) {
                            rec.noradId = extractNoradId(rec.tleLine1);
                        }
                        // Clear any stale sensor data — we'll re-derive it
                        // from the currently-known Spectator catalog below.
                        delete rec.sensor;
                        this.enrichWithSpectator(rec);
                    }
                    console.log(`Loaded ${this.satellites.length} satellites from cache.`);
                    return;
                }
            }
            console.log('[Satellites] Fetching TLE data (Space-Track → CelesTrak → ivanstanojevic)...');
            const tleText = await this.fetchTLEChain();
            const lines = tleText.split('\n').map((l: string) => l.trim());
            const parsed: SatelliteRecord[] = [];
            // Known Spectator NORADs — force-include these into the 300
            // cap so we always keep the satellites with real sensor data,
            // even if they'd be filtered out by the classification check
            // below (Spectator's catalog is mostly civilian EO, which
            // our default filter otherwise drops).
            const spectatorNorads = this.spectator
                ? new Set(this.spectator.getKnownNorads())
                : new Set<number>();

            for (let i = 0; i < lines.length - 2; i += 3) {
                const name = lines[i];
                const tleLine1 = lines[i+1];
                const tleLine2 = lines[i+2];

                if (!name || !tleLine1 || !tleLine2) continue;

                let type: 'military' | 'civilian' | 'commercial' = 'civilian';
                const nameUpper = name.toUpperCase();
                // Basic classification based on well-known names
                if (nameUpper.includes('USA') || nameUpper.includes('COSMOS') || nameUpper.includes('YAOGAN')) {
                    type = 'military';
                } else if (nameUpper.includes('STARLINK') || nameUpper.includes('ONEWEB') || nameUpper.includes('WORLDVIEW') || nameUpper.includes('CAPELLA')) {
                    type = 'commercial';
                }

                // Check if this is a known reconnaissance satellite
                const noradId = extractNoradId(tleLine1);
                const reconMeta = RECON_BY_NORAD.get(noradId);
                const isRecon = !!reconMeta;
                // Force-include satellites present in the Spectator catalog
                // so their sensor metadata can be surfaced to the frontend.
                const hasSensorData = spectatorNorads.has(noradId);

                // Filter down to an interesting subset to avoid lag
                if (type === 'military' || type === 'commercial' || nameUpper.includes('ISS') || isRecon || hasSensorData) {
                    const record: SatelliteRecord = { name, tleLine1, tleLine2, type, noradId };
                    if (isRecon) {
                        record.recon = true;
                        record.reconMeta = reconMeta;
                    }
                    this.enrichWithSpectator(record);
                    parsed.push(record);
                }
            }

            // Priority ordering: sensor-equipped + recon + ISS first,
            // then military, then commercial. This ensures Spectator-
            // enriched and recon sats aren't pushed out by thousands of
            // old COSMOS debris when the source is sorted by NORAD ID.
            const priority = parsed.filter(s => !!s.sensor || s.recon || s.name.toUpperCase().includes('ISS'));
            const rest = parsed.filter(s => !s.sensor && !s.recon && !s.name.toUpperCase().includes('ISS'));
            this.satellites = [...priority, ...rest].slice(0, 300);
            fs.writeFileSync(CACHE_FILE, JSON.stringify(this.satellites, null, 2));
            console.log(`Loaded ${this.satellites.length} filtered satellites and cached.`);
        } catch (error) {
            console.error('Failed to load TLEs:', error);
            // Fallback mock
            this.satellites = [
                {
                    name: 'ISS (ZARYA)',
                    tleLine1: '1 25544U 98067A   23023.53580555  .00010992  00000-0  20042-3 0  9997',
                    tleLine2: '2 25544  51.6428 171.1895 0004909 238.1633 194.2497 15.49842521379109',
                    type: 'civilian',
                    noradId: 25544,
                }
            ]
        }
    }

    getSatellites() {
        // Lazy re-enrichment: picks up Spectator TTL refreshes that
        // completed asynchronously between requests.
        this.reEnrichAllIfNeeded();
        return this.satellites;
    }

    getReconSatellites() {
        this.reEnrichAllIfNeeded();
        return this.satellites.filter(s => s.recon === true);
    }
}
