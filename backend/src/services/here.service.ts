import axios from 'axios';

/**
 * HERE Traffic Flow v7 — proxies real-time road-segment flow data
 * (speed, jam factor, coordinates) from the HERE Traffic API.
 *
 * If HERE_API_KEY is not set the service logs a warning and the endpoint
 * returns an empty result.
 */

export interface HereFlowResponse {
    results?: any[];
    [key: string]: any;
}

export class HereTrafficService {
    private apiKey: string;
    private enabled: boolean;

    constructor() {
        this.apiKey = process.env.HERE_API_KEY ?? '';
        this.enabled = this.apiKey.length > 0;

        if (!this.enabled) {
            console.warn('[HERE] HERE_API_KEY is not set — traffic flow endpoint will return empty');
        } else {
            console.log('[HERE] Service ready (key present)');
        }
    }

    /** Fetch flow data for a bounding box (west,south,east,north) */
    async getFlow(bbox: string): Promise<HereFlowResponse> {
        if (!this.enabled) {
            return { results: [] };
        }

        const url = `https://data.traffic.hereapi.com/v7/flow?in=bbox:${bbox}&locationReferencing=shape&functionalClasses=1,2,3&apiKey=${this.apiKey}`;

        try {
            const response = await axios.get(url, { timeout: 15_000 });
            return response.data;
        } catch (err: any) {
            console.error('[HERE] Flow fetch failed:', err.message);
            return { results: [], error: err.message };
        }
    }
}
