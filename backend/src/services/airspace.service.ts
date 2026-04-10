import axios from 'axios';

export interface AirspaceZone {
    id: string;
    name: string;
    type: number;           // 1=restricted, 2=danger, 3=prohibited
    typeName: string;
    upperLimit: number;
    lowerLimit: number;
    geometry: [number, number][][];  // [lat,lng][][] polygon rings
}

const TYPE_NAMES: Record<number, string> = {
    1: 'Restricted',
    2: 'Danger',
    3: 'Prohibited',
    17: 'Alert',
    18: 'Warning',
};

export class AirspaceService {
    private zones: AirspaceZone[] = [];
    private refreshTimer: NodeJS.Timeout | null = null;
    private lastFetch: number = 0;

    start() {
        const apiKey = process.env.OPENAIP_API_KEY;
        if (!apiKey) {
            console.warn('[Airspace] OPENAIP_API_KEY not set — airspace layer disabled');
            return;
        }

        console.log('[Airspace] Starting airspace/no-fly zone monitoring...');
        this.fetchZones();
        this.refreshTimer = setInterval(() => this.fetchZones(), 60 * 60 * 1000);
    }

    getZones(): AirspaceZone[] {
        return this.zones;
    }

    private parseItems(items: any[]): AirspaceZone[] {
        const records: AirspaceZone[] = [];
        for (const item of items) {
            const geom = item.geometry;
            if (!geom || !geom.coordinates) continue;

            const geometry: [number, number][][] = [];
            const coords = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
            for (const polygon of coords) {
                for (const ring of polygon) {
                    const mapped: [number, number][] = ring.map((pt: number[]) => [pt[1], pt[0]]);
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
        return records;
    }

    private async fetchZones() {
        const apiKey = process.env.OPENAIP_API_KEY;
        if (!apiKey) return;

        if (Date.now() - this.lastFetch < 55 * 60 * 1000 && this.zones.length > 0) return;

        try {
            const allRecords: AirspaceZone[] = [];
            let page = 1;
            const limit = 1000;

            while (true) {
                const url = `https://api.core.openaip.net/api/airspaces?apiKey=${encodeURIComponent(apiKey)}&limit=${limit}&page=${page}&type=1,2,3,17,18`;
                const res = await axios.get(url, { timeout: 30000 });

                const items = res.data?.items || res.data;
                if (!Array.isArray(items) || items.length === 0) break;

                allRecords.push(...this.parseItems(items));

                const totalPages = res.data?.totalPages || 1;
                if (page >= totalPages) break;
                page++;
            }

            this.zones = allRecords;
            this.lastFetch = Date.now();
            console.log(`[Airspace] ${allRecords.length} restricted/danger/prohibited/alert/warning zones loaded (${page} pages)`);
        } catch (err: any) {
            console.error('[Airspace] Fetch failed:', err.message);
        }
    }
}
