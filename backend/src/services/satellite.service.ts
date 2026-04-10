import axios from 'axios';
import fs from 'fs';
import path from 'path';

const CACHE_FILE = path.join(__dirname, '../../satellites_cache.json');
const CACHE_TTL = 1000 * 60 * 60 * 24; // 24 hours

const CELESTRAK_URL = 'https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=tle';

export interface ReconMeta {
    noradId: number;
    name: string;
    country: string;
    sensorType: string;
    resolution: string;
}

export interface SatelliteRecord {
    name: string;
    tleLine1: string;
    tleLine2: string;
    type: 'military' | 'civilian' | 'commercial';
    recon?: boolean;
    reconMeta?: ReconMeta;
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

    async init() {
        await this.loadSatellites();
    }

    private async loadSatellites() {
        try {
            if (fs.existsSync(CACHE_FILE)) {
                const stat = fs.statSync(CACHE_FILE);
                if (Date.now() - stat.mtimeMs < CACHE_TTL) {
                    const data = fs.readFileSync(CACHE_FILE, 'utf-8');
                    this.satellites = JSON.parse(data);
                    console.log(`Loaded ${this.satellites.length} satellites from cache.`);
                    return;
                }
            }
            console.log('Fetching new TLE data from CelesTrak...');
            const response = await axios.get(CELESTRAK_URL);
            const lines = response.data.split('\n').map((l: string) => l.trim());
            const parsed: SatelliteRecord[] = [];
            
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

                // Filter down to an interesting subset to avoid lag
                if (type === 'military' || type === 'commercial' || nameUpper.includes('ISS') || isRecon) {
                    const record: SatelliteRecord = { name, tleLine1, tleLine2, type };
                    if (isRecon) {
                        record.recon = true;
                        record.reconMeta = reconMeta;
                    }
                    parsed.push(record);
                }
            }
            
            // Limit amount for the demo
            this.satellites = parsed.slice(0, 300);
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
                    type: 'civilian'
                }
            ]
        }
    }

    getSatellites() {
        return this.satellites;
    }

    getReconSatellites() {
        return this.satellites.filter(s => s.recon === true);
    }
}
