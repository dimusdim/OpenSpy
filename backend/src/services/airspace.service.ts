import axios from 'axios';
import { SourcePersistenceService } from './source-persistence.service';

/**
 * One polygon (outer ring + optional holes) in [lat,lng] format. Cesium's
 * PolygonHierarchy needs this shape directly: outer is the main boundary,
 * holes are cut-outs inside it. MultiPolygon zones give multiple of these.
 */
export interface AirspacePolygon {
    outer: [number, number][];
    holes: [number, number][][];
}

export interface AirspaceZone {
    id: string;
    name: string;
    type: number;           // 1=restricted, 2=danger, 3=prohibited, 17=alert, 18=warning
    typeName: string;
    upperLimit: number;
    lowerLimit: number;
    // Array of polygons. A simple Polygon zone has exactly one entry.
    // A MultiPolygon zone (e.g. a restricted area split by a gap) has
    // several. Each entry carries its own outer boundary + holes.
    geometry: AirspacePolygon[];
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
    private health: 'streaming' | 'error' | 'auth-missing' = 'streaming';
    private lastError: string | null = null;

    constructor(private readonly persistence?: SourcePersistenceService) {}

    start() {
        const apiKey = process.env.OPENAIP_API_KEY;
        if (!apiKey) {
            console.warn('[Airspace] OPENAIP_API_KEY not set — airspace layer disabled');
            this.health = 'auth-missing';
            return;
        }

        console.log('[Airspace] Starting airspace/no-fly zone monitoring...');
        this.fetchZones();
        this.refreshTimer = setInterval(() => this.fetchZones(), 60 * 60 * 1000);
    }

    getZones(): AirspaceZone[] {
        return this.zones;
    }

    getHealth() {
        return { status: this.health, note: this.lastError || undefined, count: this.zones.length };
    }

    /**
     * Parse a GeoJSON ring (array of [lng,lat] points) into our
     * [lat,lng] convention. Filters out degenerate rings with < 3 points.
     */
    private ringToLatLng(ring: any[]): [number, number][] | null {
        if (!Array.isArray(ring) || ring.length < 3) return null;
        const mapped: [number, number][] = [];
        for (const pt of ring) {
            if (!Array.isArray(pt) || pt.length < 2) continue;
            // GeoJSON: [lng, lat]. Our convention: [lat, lng].
            mapped.push([pt[1], pt[0]]);
        }
        return mapped.length >= 3 ? mapped : null;
    }

    /**
     * Convert a GeoJSON Polygon (outer + optional holes) into our
     * AirspacePolygon. GeoJSON Polygon coordinates are:
     *   [outerRing, hole1, hole2, ...]
     * where each ring is an array of [lng,lat] points.
     */
    private parsePolygon(poly: any[]): AirspacePolygon | null {
        if (!Array.isArray(poly) || poly.length === 0) return null;
        const outer = this.ringToLatLng(poly[0]);
        if (!outer) return null;
        const holes: [number, number][][] = [];
        for (let i = 1; i < poly.length; i++) {
            const hole = this.ringToLatLng(poly[i]);
            if (hole) holes.push(hole);
        }
        return { outer, holes };
    }

    private parseItems(items: any[]): AirspaceZone[] {
        const records: AirspaceZone[] = [];
        for (const item of items) {
            const geom = item.geometry;
            if (!geom || !geom.coordinates) continue;

            // GeoJSON Polygon: coordinates = [outer, hole1, hole2, ...]
            // GeoJSON MultiPolygon: coordinates = [polygon1, polygon2, ...]
            //   where each polygonN = [outer, hole1, hole2, ...]
            // We normalise both into AirspacePolygon[] so downstream code
            // doesn't branch on geometry.type.
            const geometry: AirspacePolygon[] = [];
            if (geom.type === 'Polygon') {
                const parsed = this.parsePolygon(geom.coordinates);
                if (parsed) geometry.push(parsed);
            } else if (geom.type === 'MultiPolygon') {
                for (const poly of geom.coordinates) {
                    const parsed = this.parsePolygon(poly);
                    if (parsed) geometry.push(parsed);
                }
            } else {
                // Unsupported geometry type — skip silently, OpenAIP should
                // only ever return Polygon or MultiPolygon for airspaces.
                continue;
            }

            if (geometry.length === 0) continue;

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
            this.health = 'streaming';
            this.lastError = null;
            await this.persistence?.persistAirspaceZones(allRecords);
            console.log(`[Airspace] ${allRecords.length} restricted/danger/prohibited/alert/warning zones loaded (${page} pages)`);
        } catch (err: any) {
            console.error('[Airspace] Fetch failed:', err.message);
            this.health = 'error';
            this.lastError = err.message;
        }
    }
}
