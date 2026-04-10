import axios from 'axios';
import { WindyService } from './windy.service';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WebcamRecord {
    id: string;
    lat: number;
    lng: number;
    name: string;
    url: string;        // HLS .m3u8 stream URL (or empty for Windy — uses playerUrl/imageUrl)
    source: string;     // 'live-env-streams' | 'caltrans' | 'windy'
    quality?: string;
    country?: string;
    playerUrl?: string; // Windy embed player
    imageUrl?: string;  // Windy preview image
}

// ---------------------------------------------------------------------------
// WebcamsService — aggregates webcam sources into a unified list
// Sources: Live-Environment-Streams (GitHub), Caltrans CCTV, Windy API
// ---------------------------------------------------------------------------

export class WebcamsService {
    private webcams: WebcamRecord[] = [];
    private refreshInterval: ReturnType<typeof setInterval> | null = null;
    private windyService: WindyService;

    constructor(windyService: WindyService) {
        this.windyService = windyService;
    }

    // -- Public API ----------------------------------------------------------

    start(): void {
        console.log('[WebcamsService] Starting webcam aggregation...');
        this.fetchAll().catch(() => {});
        // Re-fetch every 1 hour
        this.refreshInterval = setInterval(() => {
            this.fetchAll().catch(() => {});
        }, 60 * 60 * 1000);
    }

    getWebcams(): WebcamRecord[] {
        return this.webcams;
    }

    // -- Fetch Logic ---------------------------------------------------------

    private async fetchAll(): Promise<void> {
        const results = await Promise.allSettled([
            this.fetchLiveEnvStreams(),
            this.fetchCaltrans(),
            this.fetchWindyGlobal(),
        ]);

        const merged: WebcamRecord[] = [];
        for (const r of results) {
            if (r.status === 'fulfilled') merged.push(...r.value);
        }

        this.webcams = merged;
        console.log(`[WebcamsService] Total webcams: ${merged.length}`);
    }

    // Source 3: Windy Webcams API (global, up to 1000 on free tier)
    private async fetchWindyGlobal(): Promise<WebcamRecord[]> {
        try {
            const windyCams = await this.windyService.fetchGlobalWebcams();
            return windyCams.map((cam) => ({
                id: `windy-${cam.id}`,
                lat: cam.lat,
                lng: cam.lng,
                name: cam.title || 'Windy Webcam',
                url: cam.playerUrl || '',
                source: 'windy',
                playerUrl: cam.playerUrl,
                imageUrl: cam.imageUrl,
            }));
        } catch (err: any) {
            console.error('[WebcamsService] Windy global fetch failed:', err.message);
            return [];
        }
    }

    // Source 1: Live-Environment-Streams GeoJSON from GitHub
    private async fetchLiveEnvStreams(): Promise<WebcamRecord[]> {
        try {
            const url = 'https://raw.githubusercontent.com/willytop8/Live-Environment-Streams/main/streams.geojson';
            const res = await axios.get(url, { timeout: 30_000 });
            const geojson = res.data;

            if (!geojson?.features?.length) {
                console.warn('[WebcamsService] Live-Environment-Streams: no features');
                return [];
            }

            const records: WebcamRecord[] = [];
            for (const feature of geojson.features) {
                const props = feature.properties;
                const coords = feature.geometry?.coordinates;
                if (!coords || coords.length < 2 || !props?.url) continue;

                records.push({
                    id: `les-${records.length}`,
                    lng: coords[0],
                    lat: coords[1],
                    name: props.name || 'Unnamed Stream',
                    url: props.url,
                    source: 'live-env-streams',
                    quality: props.quality,
                    country: props.country,
                });
            }

            console.log(`[WebcamsService] Live-Environment-Streams: ${records.length} cameras`);
            return records;
        } catch (err: any) {
            console.error('[WebcamsService] Live-Environment-Streams fetch failed:', err.message);
            return [];
        }
    }

    // Source 2: Caltrans CCTV — 12 districts
    private async fetchCaltrans(): Promise<WebcamRecord[]> {
        const districts = Array.from({ length: 12 }, (_, i) => i + 1);
        const allRecords: WebcamRecord[] = [];

        const results = await Promise.allSettled(
            districts.map(d => this.fetchCaltransDistrict(d))
        );

        for (const r of results) {
            if (r.status === 'fulfilled') allRecords.push(...r.value);
        }

        console.log(`[WebcamsService] Caltrans: ${allRecords.length} cameras across 12 districts`);
        return allRecords;
    }

    private async fetchCaltransDistrict(district: number): Promise<WebcamRecord[]> {
        const padded = String(district).padStart(2, '0');
        const url = `https://cwwp2.dot.ca.gov/data/d${district}/cctv/cctvStatusD${padded}.json`;

        try {
            const res = await axios.get(url, { timeout: 15_000 });
            const data = res.data;

            // Caltrans JSON has a root array or a .data array depending on district
            const cameras: any[] = Array.isArray(data) ? data
                : data?.data ? data.data
                : [];

            const records: WebcamRecord[] = [];
            for (const cam of cameras) {
                const lat = cam?.location?.latitude;
                const lng = cam?.location?.longitude;
                const streamUrl = cam?.imageData?.streamingVideoURL;
                if (!lat || !lng || !streamUrl) continue;

                records.push({
                    id: `caltrans-d${padded}-${records.length}`,
                    lat: Number(lat),
                    lng: Number(lng),
                    name: cam.location?.description || cam.location?.locationName || `Caltrans D${padded}`,
                    url: streamUrl,
                    source: 'caltrans',
                    country: 'US',
                });
            }

            return records;
        } catch (err: any) {
            console.warn(`[WebcamsService] Caltrans D${padded} fetch failed: ${err.message}`);
            return [];
        }
    }
}
