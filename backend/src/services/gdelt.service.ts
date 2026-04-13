import axios from 'axios';
import * as zlib from 'zlib';
import { promisify } from 'util';

const unzip = promisify(zlib.unzip);

// ---------------------------------------------------------------------------
// GDELT Event Database 2.0 — real-time global conflict events
//
// Source: http://data.gdeltproject.org/gdeltv2/lastupdate.txt
// Updates every 15 minutes, free, no auth required.
//
// We download the latest 15-min CSV export, filter for conflict-related
// CAMEO root codes (14=PROTEST, 18=ASSAULT, 19=FIGHT, 20=MASS_VIOLENCE),
// and serve them as GeoJSON-like objects to the frontend.
// ---------------------------------------------------------------------------

const GDELT_LAST_UPDATE_URL = 'http://data.gdeltproject.org/gdeltv2/lastupdate.txt';

// CAMEO root codes: conflicts (14,18,19,20) + threats & coercion (13,15,17)
const CONFLICT_ROOT_CODES = new Set(['13', '14', '15', '17', '18', '19', '20']);

// CAMEO root code → human-readable label
const ROOT_LABELS: Record<string, string> = {
    '13': 'Threaten',
    '14': 'Protest',
    '15': 'Force posture',
    '17': 'Coerce',
    '18': 'Assault',
    '19': 'Fight',
    '20': 'Mass Violence',
};

// CAMEO event codes → detailed subtypes
const EVENT_SUBTYPES: Record<string, string> = {
    '140': 'Protest (general)',
    '141': 'Demonstrate',
    '142': 'Hunger strike',
    '143': 'Strike',
    '144': 'Obstruct passage',
    '145': 'Protest with violence',
    '130': 'Threaten (general)',
    '131': 'Threaten with sanctions',
    '132': 'Threaten to boycott',
    '133': 'Threaten military action',
    '134': 'Threaten nuclear weapons',
    '135': 'Threaten non-force action',
    '136': 'Threaten with political action',
    '137': 'Threaten with force',
    '138': 'Threaten unconventional violence',
    '139': 'Threaten with WMD',
    '150': 'Exhibit force posture',
    '151': 'Increase military alert',
    '152': 'Mobilize armed forces',
    '153': 'Military build-up',
    '154': 'Fortify border',
    '155': 'Troops display',
    '170': 'Coerce (general)',
    '171': 'Seize property/assets',
    '172': 'Impose sanctions',
    '173': 'Impose curfew',
    '174': 'Arrest/detain',
    '175': 'Use tactics of violent repression',
    '180': 'Assault (general)',
    '181': 'Abduct/hijack',
    '182': 'Physically assault',
    '183': 'Conduct suicide/car bombing',
    '184': 'Use chemical/bio weapons',
    '185': 'Assassinate',
    '186': 'Sexual assault',
    '190': 'Use conventional military force',
    '191': 'Impose blockade',
    '192': 'Occupy territory',
    '193': 'Fight with small arms',
    '194': 'Fight with artillery/tanks',
    '195': 'Employ aerial weapons',
    '196': 'Violate ceasefire',
    '200': 'Mass violence (general)',
    '201': 'Mass expulsion',
    '202': 'Mass killing',
    '203': 'Ethnic cleansing',
    '204': 'Use weapons of mass destruction',
};

export interface GdeltConflictEvent {
    id: string;
    lat: number;
    lng: number;
    date: string;           // YYYYMMDD
    eventCode: string;       // CAMEO event code
    rootCode: string;        // CAMEO root code
    eventType: string;       // human label: "Fight", "Assault", etc.
    subEventType: string;    // detailed: "Employ aerial weapons"
    actor1: string;
    actor2: string;
    goldstein: number;       // Goldstein scale (-10 to +10, negative = conflict)
    numMentions: number;
    numSources: number;
    sourceUrl: string;
    country: string;         // ActionGeo country code
    location: string;        // ActionGeo full name
}

export class GDELTService {
    private events: GdeltConflictEvent[] = [];
    private timer: NodeJS.Timeout | null = null;
    private health: 'streaming' | 'error' | 'connecting' = 'connecting';
    private lastError: string | null = null;
    private lastFetchUrl: string = '';

    start() {
        console.log('[GDELT] Starting conflict event monitoring (15-min cycle)...');
        this.fetchLatest();
        // Poll every 15 minutes (matches GDELT update frequency)
        this.timer = setInterval(() => this.fetchLatest(), 15 * 60 * 1000);
    }

    getEvents(): GdeltConflictEvent[] {
        return this.events;
    }

    getHealth() {
        return {
            status: this.health,
            note: this.lastError || undefined,
            count: this.events.length,
        };
    }

    private async fetchLatest() {
        try {
            // Step 1: get URL of latest 15-min export
            const indexRes = await axios.get(GDELT_LAST_UPDATE_URL, {
                timeout: 10_000,
                responseType: 'text',
            });
            const lines = indexRes.data.trim().split('\n');
            // First line is the events export
            const exportLine = lines.find((l: string) => l.includes('.export.CSV.zip'));
            if (!exportLine) throw new Error('No export CSV in lastupdate.txt');

            const parts = exportLine.trim().split(/\s+/);
            const url = parts[parts.length - 1];

            // Skip if same URL as last fetch
            if (url === this.lastFetchUrl && this.events.length > 0) return;

            // Step 2: download and decompress ZIP
            const zipRes = await axios.get(url, {
                timeout: 30_000,
                responseType: 'arraybuffer',
            });

            // The ZIP contains one CSV file. Node's zlib can handle the
            // deflate stream, but ZIP has a wrapper. Use AdmZip-like
            // approach: find the local file header and decompress.
            const csvText = await this.extractCsvFromZip(Buffer.from(zipRes.data));

            // Step 3: parse conflict events
            const parsed: GdeltConflictEvent[] = [];
            const rows = csvText.split('\n');

            for (const row of rows) {
                const cols = row.split('\t');
                if (cols.length < 61) continue;

                const rootCode = cols[28];
                if (!CONFLICT_ROOT_CODES.has(rootCode)) continue;

                const lat = parseFloat(cols[56]);
                const lon = parseFloat(cols[57]);
                if (isNaN(lat) || isNaN(lon) || (lat === 0 && lon === 0)) continue;

                const eventCode = cols[26];
                parsed.push({
                    id: `gdelt-${cols[0]}`,
                    lat,
                    lng: lon,
                    date: cols[1],
                    eventCode,
                    rootCode,
                    eventType: ROOT_LABELS[rootCode] || 'Unknown',
                    subEventType: EVENT_SUBTYPES[eventCode] || ROOT_LABELS[rootCode] || eventCode,
                    actor1: cols[5] || '',
                    actor2: cols[15] || '',
                    goldstein: parseFloat(cols[30]) || 0,
                    numMentions: parseInt(cols[31], 10) || 0,
                    numSources: parseInt(cols[32], 10) || 0,
                    sourceUrl: cols[60] || '',
                    country: cols[53] || '',
                    location: cols[52] || '',
                });
            }

            this.events = parsed;
            this.lastFetchUrl = url;
            this.health = 'streaming';
            this.lastError = null;

            const fights = parsed.filter(e => e.rootCode === '19').length;
            const assaults = parsed.filter(e => e.rootCode === '18').length;
            const protests = parsed.filter(e => e.rootCode === '14').length;
            const massViolence = parsed.filter(e => e.rootCode === '20').length;
            console.log(
                `[GDELT] ${parsed.length} conflict events ` +
                `(${fights} fights, ${assaults} assaults, ${protests} protests, ${massViolence} mass violence)`
            );
        } catch (err: any) {
            console.error('[GDELT] Fetch failed:', err.message);
            this.health = 'error';
            this.lastError = err.message;
        }
    }

    /**
     * Extract CSV text from a ZIP buffer.
     * GDELT ZIP files contain a single CSV. We locate the local file
     * header, extract the compressed data, and inflate it.
     */
    private async extractCsvFromZip(buf: Buffer): Promise<string> {
        // ZIP local file header signature: PK\x03\x04
        const sig = buf.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
        if (sig < 0) throw new Error('Not a valid ZIP file');

        // Parse local file header
        const compressionMethod = buf.readUInt16LE(sig + 8);
        const compressedSize = buf.readUInt32LE(sig + 18);
        const fileNameLen = buf.readUInt16LE(sig + 26);
        const extraLen = buf.readUInt16LE(sig + 28);
        const dataStart = sig + 30 + fileNameLen + extraLen;

        if (compressionMethod === 0) {
            // Stored (no compression)
            return buf.subarray(dataStart, dataStart + compressedSize).toString('utf-8');
        } else if (compressionMethod === 8) {
            // Deflate
            const compressed = buf.subarray(dataStart, dataStart + compressedSize);
            const decompressed = await promisify(zlib.inflateRaw)(compressed);
            return decompressed.toString('utf-8');
        } else {
            throw new Error(`Unsupported ZIP compression method: ${compressionMethod}`);
        }
    }
}
