export interface Notam {
    id: string;
    text: string;
    location: string;
    effectiveStart: string;
    effectiveEnd: string;
    lat?: number;
    lng?: number;
}

export class NotamService {
    private token: string;

    constructor() {
        this.token = process.env.NASA_DIP_TOKEN ?? '';
    }

    async getNotams(): Promise<Notam[]> {
        if (!this.token) {
            console.warn('[NotamService] NASA_DIP_TOKEN not configured, skipping');
            return [];
        }

        // TODO: Implement actual NASA DIP API call once endpoint documentation is confirmed.
        // The NASA Digital Information Platform (DIP) API requires specific credentials
        // and endpoint configuration. The token is present but the exact API contract
        // needs to be verified.
        console.log('[NotamService] Token configured but DIP endpoint not yet implemented. Returning empty.');
        return [];
    }
}
