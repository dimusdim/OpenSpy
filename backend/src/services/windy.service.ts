import axios from 'axios';

export interface WindyWebcam {
    id: string;
    title: string;
    lat: number;
    lng: number;
    playerUrl: string;
    imageUrl: string;
}

export class WindyService {
    private apiKey: string;

    constructor() {
        this.apiKey = process.env.WINDY_API_KEY ?? '';
    }

    async getWebcams(lat: number, lng: number, radius: number): Promise<WindyWebcam[]> {
        if (!this.apiKey) {
            console.warn('[WindyService] API key not configured, skipping');
            return [];
        }

        try {
            const url = `https://api.windy.com/webcams/api/v3/webcams?nearby=${lat},${lng},${radius}&include=images,location,player&limit=50`;
            const res = await axios.get(url, {
                headers: { 'x-windy-api-key': this.apiKey },
                timeout: 15_000,
            });

            const webcams: any[] = res.data?.webcams ?? [];
            return webcams.map((cam: any) => ({
                id: cam.webcamId ?? cam.id ?? '',
                title: cam.title ?? '',
                lat: cam.location?.latitude ?? 0,
                lng: cam.location?.longitude ?? 0,
                playerUrl: cam.player?.live?.available ? cam.player.live.embed : (cam.player?.day?.embed ?? ''),
                imageUrl: cam.images?.current?.preview ?? cam.images?.current?.thumbnail ?? '',
            }));
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[WindyService] Failed to fetch webcams: ${msg}`);
            return [];
        }
    }
}
