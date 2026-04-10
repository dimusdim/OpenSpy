import axios from 'axios';

export interface Road511Camera {
    id: string;
    title: string;
    lat: number;
    lng: number;
    playerUrl: string;
    imageUrl: string;
}

export class Road511Service {
    private apiKey: string;

    constructor() {
        this.apiKey = process.env.ROAD511_API_KEY ?? '';
    }

    async getCameras(): Promise<Road511Camera[]> {
        if (!this.apiKey) {
            console.warn('[Road511Service] API key not configured, skipping');
            return [];
        }

        try {
            // Road511 aggregator API — fetch camera feeds
            const url = `https://api.road511.com/v1/cameras`;
            const res = await axios.get(url, {
                headers: { 'Authorization': `Bearer ${this.apiKey}` },
                timeout: 15_000,
            });

            const cameras: any[] = Array.isArray(res.data) ? res.data : (res.data?.cameras ?? []);
            return cameras.map((cam: any) => ({
                id: cam.id ?? '',
                title: cam.name ?? cam.title ?? '',
                lat: cam.latitude ?? cam.lat ?? 0,
                lng: cam.longitude ?? cam.lng ?? 0,
                playerUrl: cam.streamUrl ?? cam.playerUrl ?? '',
                imageUrl: cam.imageUrl ?? cam.snapshotUrl ?? '',
            }));
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[Road511Service] Failed to fetch cameras: ${msg}`);
            return [];
        }
    }
}
