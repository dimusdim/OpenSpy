import axios from 'axios';

export interface WindyWebcam {
    id: string;
    title: string;
    lat: number;
    lng: number;
    playerUrl: string;
    imageUrl: string;
}

/**
 * Windy Webcams API v3
 * Free tier: max 50 per request, max offset 1000, image URLs expire in 10 min.
 * On start, fetches up to 1000 global webcams via pagination.
 * Also supports nearby queries for viewport-based requests.
 */
export class WindyService {
    private apiKey: string;
    private globalWebcams: WindyWebcam[] = [];
    private lastGlobalFetch: number = 0;
    private health: 'streaming' | 'error' | 'auth-missing' = 'streaming';
    private lastError: string | null = null;

    constructor() {
        this.apiKey = process.env.WINDY_API_KEY ?? '';
        if (!this.apiKey) {
            console.warn('[Windy] WINDY_API_KEY not set — Windy webcams disabled');
            this.health = 'auth-missing';
        }
    }

    getHealth() {
        return { status: this.health, note: this.lastError || undefined, count: this.globalWebcams.length };
    }

    /** Fetch global webcams on startup (called from WebcamsService or bootstrap) */
    async fetchGlobalWebcams(): Promise<WindyWebcam[]> {
        if (!this.apiKey) return [];

        // Cache for 30 minutes (image URLs expire in 10 min on free tier,
        // but we re-fetch more often than the 1h webcams cycle)
        if (Date.now() - this.lastGlobalFetch < 30 * 60 * 1000 && this.globalWebcams.length > 0) {
            return this.globalWebcams;
        }

        const all: WindyWebcam[] = [];
        const limit = 50; // max per request on free tier
        const maxOffset = 1000; // free tier cap

        try {
            for (let offset = 0; offset < maxOffset; offset += limit) {
                const url = `https://api.windy.com/webcams/api/v3/webcams?include=images,location,player&limit=${limit}&offset=${offset}`;
                const res = await axios.get(url, {
                    headers: { 'x-windy-api-key': this.apiKey },
                    timeout: 15_000,
                });

                const webcams: any[] = res.data?.webcams ?? [];
                if (webcams.length === 0) break;

                for (const cam of webcams) {
                    all.push(this.mapWebcam(cam));
                }

                // If we got fewer than limit, no more pages
                if (webcams.length < limit) break;
            }

            this.globalWebcams = all;
            this.lastGlobalFetch = Date.now();
            this.health = 'streaming';
            this.lastError = null;
            console.log(`[Windy] Fetched ${all.length} global webcams`);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[Windy] Global fetch failed: ${msg}`);
            this.health = 'error';
            this.lastError = msg;
        }

        return this.globalWebcams;
    }

    /** Get cached global webcams (non-async, for use by WebcamsService) */
    getGlobalWebcams(): WindyWebcam[] {
        return this.globalWebcams;
    }

    /** Nearby webcams for viewport-based requests */
    async getWebcams(lat: number, lng: number, radius: number): Promise<WindyWebcam[]> {
        if (!this.apiKey) return [];

        try {
            const url = `https://api.windy.com/webcams/api/v3/webcams?nearby=${lat},${lng},${radius}&include=images,location,player&limit=50`;
            const res = await axios.get(url, {
                headers: { 'x-windy-api-key': this.apiKey },
                timeout: 15_000,
            });

            const webcams: any[] = res.data?.webcams ?? [];
            return webcams.map((cam: any) => this.mapWebcam(cam));
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[Windy] Nearby fetch failed: ${msg}`);
            return [];
        }
    }

    private mapWebcam(cam: any): WindyWebcam {
        return {
            id: String(cam.webcamId ?? cam.id ?? ''),
            title: cam.title ?? '',
            lat: cam.location?.latitude ?? 0,
            lng: cam.location?.longitude ?? 0,
            playerUrl: cam.player?.live?.available
                ? cam.player.live.embed
                : (cam.player?.day?.embed ?? ''),
            imageUrl: cam.images?.current?.preview
                ?? cam.images?.current?.thumbnail
                ?? '',
        };
    }
}
