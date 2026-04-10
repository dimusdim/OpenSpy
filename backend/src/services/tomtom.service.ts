import axios from 'axios';
import { Request, Response } from 'express';

/**
 * TomTom Traffic Flow — proxies raster (PNG) and vector (PBF) flow tiles
 * from the TomTom Traffic API v4.
 *
 * If TOMTOM_API_KEY is not set the service logs a warning and all endpoints
 * return 404 with a descriptive message.
 */
export class TomTomService {
    private apiKey: string;
    private enabled: boolean;

    constructor() {
        this.apiKey = process.env.TOMTOM_API_KEY ?? '';
        this.enabled = this.apiKey.length > 0;

        if (!this.enabled) {
            console.warn('[TomTom] TOMTOM_API_KEY is not set — traffic tile endpoints will return 404');
        } else {
            console.log('[TomTom] Service ready (key present)');
        }
    }

    /** GET /api/traffic/tile/:z/:x/:y — proxy protobuf vector tiles */
    async proxyVectorTile(req: Request, res: Response): Promise<void> {
        if (!this.enabled) {
            res.status(404).json({ error: 'TomTom API key not configured' });
            return;
        }

        const { z, x, y } = req.params;
        const url = `https://api.tomtom.com/traffic/map/4/tile/flow/relative0/${z}/${x}/${y}.pbf?key=${this.apiKey}`;

        try {
            const response = await axios.get(url, {
                responseType: 'arraybuffer',
                timeout: 10_000,
            });
            res.set('Content-Type', 'application/x-protobuf');
            res.set('Cache-Control', 'public, max-age=60');
            res.send(Buffer.from(response.data));
        } catch (err: any) {
            const status = err.response?.status || 502;
            console.error(`[TomTom] Vector tile ${z}/${x}/${y} failed:`, err.message);
            res.status(status).json({ error: 'Failed to fetch TomTom vector tile' });
        }
    }

    /** GET /api/traffic/raster/:z/:x/:y — proxy PNG raster flow tiles */
    async proxyRasterTile(req: Request, res: Response): Promise<void> {
        if (!this.enabled) {
            res.status(404).json({ error: 'TomTom API key not configured' });
            return;
        }

        const { z, x, y } = req.params;
        const url = `https://api.tomtom.com/traffic/map/4/tile/flow/relative0/${z}/${x}/${y}.png?key=${this.apiKey}`;

        try {
            const response = await axios.get(url, {
                responseType: 'arraybuffer',
                timeout: 10_000,
            });
            res.set('Content-Type', 'image/png');
            res.set('Cache-Control', 'public, max-age=60');
            res.send(Buffer.from(response.data));
        } catch (err: any) {
            const status = err.response?.status || 502;
            console.error(`[TomTom] Raster tile ${z}/${x}/${y} failed:`, err.message);
            res.status(status).json({ error: 'Failed to fetch TomTom raster tile' });
        }
    }
}
