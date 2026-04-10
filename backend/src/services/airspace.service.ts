import axios from 'axios';

export interface AirspaceZone {
    id: string;
    name: string;
    type: number;           // 1=restricted, 4=danger, 6=prohibited, 8=TFR
    typeName: string;
    upperLimit: number;
    lowerLimit: number;
    geometry: [number, number][][];  // [lat,lng][][] polygon rings
}

const TYPE_NAMES: Record<number, string> = {
    1: 'Restricted',
    4: 'Danger',
    6: 'Prohibited',
    8: 'TFR',
};

export class AirspaceService {
    private zones: AirspaceZone[] = [];
    private timer: NodeJS.Timeout | null = null;
    private lastFetch: number = 0;

    start() {
        const apiKey = process.env.OPENAIP_API_KEY;
        if (!apiKey) {
            console.warn('[Airspace] API key not configured, skipping');
            return;
        }

        console.log('[Airspace] Starting airspace/no-fly zone monitoring...');
        this.fetchZones();
        this.timer = setInterval(() => this.fetchZones(), 60 * 60 * 1000); // every 1h
    }

    getZones(): AirspaceZone[] {
        return this.zones;
    }

    private async fetchZones() {
        const apiKey = process.env.OPENAIP_API_KEY;
        if (!apiKey) return;

        // Cache for 1h
        if (Date.now() - this.lastFetch < 55 * 60 * 1000 && this.zones.length > 0) return;

        try {
            const url = `https://api.core.openaip.net/api/airspaces?apiKey=${encodeURIComponent(apiKey)}&limit=500&type=1,4,6,8`;

            const res = await axios.get(url, { timeout: 30000 });

            const items = res.data?.items || res.data;
            if (!Array.isArray(items)) {
                console.warn('[Airspace] Unexpected response shape');
                return;
            }

            const records: AirspaceZone[] = [];
            for (const item of items) {
                const geom = item.geometry;
                if (!geom || !geom.coordinates) continue;

                // GeoJSON polygon: coordinates is [ring][point][lng,lat]
                const geometry: [number, number][][] = [];
                const coords = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
                for (const polygon of coords) {
                    for (const ring of polygon) {
                        const mapped: [number, number][] = ring.map((pt: number[]) => [pt[1], pt[0]]); // [lat, lng]
                        geometry.push(mapped);
                    }
                }

                const typeNum = item.type ?? 0;
                records.push({
                    id: `airspace-${item._id || item.id || records.length}`,
                    name: item.name || 'Unknown Airspace',
                    type: typeNum,
                    typeName: TYPE_NAMES[typeNum] || 'Other',
                    upperLimit: item.upperLimit?.value || 0,
                    lowerLimit: item.lowerLimit?.value || 0,
                    geometry,
                });
            }

            this.zones = records;
            this.lastFetch = Date.now();
            console.log(`[Airspace] ${records.length} restricted/danger/prohibited zones loaded`);
        } catch (err: any) {
            console.error('[Airspace] Fetch failed:', err.message);
        }
    }
}
