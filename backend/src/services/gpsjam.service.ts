import axios from 'axios';
import { cellToBoundary, cellToLatLng } from 'h3-js';

export interface JammingZone {
    id: string;
    lat: number;
    lng: number;
    boundary: [number, number][];  // [lat, lng][] polygon vertices
    countGood: number;
    countBad: number;
    ratio: number;        // bad / (good+bad), 0..1
    intensity: 'high' | 'medium' | 'low';
    h3Index: string;
}

export class GPSJamService {
    private zones: JammingZone[] = [];
    private lastDate: string | null = null;
    private interval: ReturnType<typeof setInterval> | null = null;

    async start(): Promise<void> {
        console.log('[GPSJam] Starting GPSJam feed...');
        await this.fetchLatest();
        // Re-fetch every 6 hours (data updates daily, but we don't know exactly when)
        this.interval = setInterval(() => this.fetchLatest().catch(() => {}), 6 * 3600 * 1000);
    }

    getZones(): JammingZone[] {
        return this.zones;
    }

    private async fetchLatest(): Promise<void> {
        try {
            // Try today first, then yesterday (data may not be ready yet)
            const today = new Date();
            for (let daysBack = 0; daysBack <= 2; daysBack++) {
                const d = new Date(today);
                d.setDate(d.getDate() - daysBack);
                const dateStr = d.toISOString().slice(0, 10);

                if (dateStr === this.lastDate) {
                    console.log(`[GPSJam] Already have data for ${dateStr}, skipping`);
                    return;
                }

                const url = `https://gpsjam.org/data/${dateStr}-h3_4.csv`;
                try {
                    const { data } = await axios.get<string>(url, {
                        timeout: 30_000,
                        responseType: 'text',
                        headers: { 'Accept-Encoding': 'gzip' },
                    });

                    const zones = this.parseCSV(data);
                    if (zones.length > 0) {
                        this.zones = zones;
                        this.lastDate = dateStr;
                        console.log(`[GPSJam] Loaded ${zones.length} jamming zones for ${dateStr} (of which ${zones.filter(z => z.intensity === 'high').length} high)`);
                        return;
                    }
                } catch (err: any) {
                    if (err.response?.status === 404) {
                        continue; // Try previous day
                    }
                    throw err;
                }
            }
            console.warn('[GPSJam] No data available for last 3 days');
        } catch (err: any) {
            console.error(`[GPSJam] Failed to fetch: ${err.message}`);
        }
    }

    private parseCSV(csv: string): JammingZone[] {
        const lines = csv.split('\n');
        if (lines.length < 2) return [];

        const header = lines[0].split(',').map(s => s.trim());
        const hexIdx = header.indexOf('hex');
        const goodIdx = header.indexOf('count_good_aircraft');
        const badIdx = header.indexOf('count_bad_aircraft');

        if (hexIdx === -1 || goodIdx === -1 || badIdx === -1) {
            console.warn('[GPSJam] CSV missing required columns:', header);
            return [];
        }

        const zones: JammingZone[] = [];

        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;

            const cols = line.split(',');
            const h3Index = cols[hexIdx]?.trim();
            const countGood = parseInt(cols[goodIdx], 10) || 0;
            const countBad = parseInt(cols[badIdx], 10) || 0;

            // Only include hexes where there's actual interference
            if (countBad === 0) continue;

            const total = countGood + countBad;
            const ratio = total > 0 ? countBad / total : 0;

            // Filter: at least 5% bad and at least 2 bad aircraft to avoid noise
            if (ratio < 0.05 || countBad < 2) continue;

            try {
                const [lat, lng] = cellToLatLng(h3Index);
                const boundary = cellToBoundary(h3Index) as [number, number][];

                const intensity: 'high' | 'medium' | 'low' =
                    ratio >= 0.5 ? 'high' :
                    ratio >= 0.2 ? 'medium' : 'low';

                zones.push({
                    id: `jam-${h3Index}`,
                    lat,
                    lng,
                    boundary,
                    countGood,
                    countBad,
                    ratio,
                    intensity,
                    h3Index,
                });
            } catch {
                // Invalid H3 index, skip
            }
        }

        return zones;
    }
}
