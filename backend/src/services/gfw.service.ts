import axios from 'axios';

export interface GFWEvent {
    id: string;
    lat: number;
    lng: number;
    type: string;
    start: string;
    end: string;
    vesselId: string;
    vesselName: string;
    flagState: string;
}

export class GFWService {
    private events: GFWEvent[] = [];
    private timer: NodeJS.Timeout | null = null;
    private health: 'streaming' | 'error' | 'auth-missing' = 'streaming';
    private lastError: string | null = null;

    start() {
        const token = process.env.GFW_TOKEN;
        if (!token) {
            console.warn('[GFW] API key not configured, skipping');
            this.health = 'auth-missing';
            return;
        }

        console.log('[GFW] Starting Global Fishing Watch event monitoring...');
        this.fetchEvents();
        this.timer = setInterval(() => this.fetchEvents(), 60 * 60 * 1000); // every 1h
    }

    getEvents(): GFWEvent[] {
        return this.events;
    }

    getHealth() {
        return { status: this.health, note: this.lastError || undefined, count: this.events.length };
    }

    private async fetchEvents() {
        const token = process.env.GFW_TOKEN;
        if (!token) return;

        try {
            const url = `https://gateway.api.globalfishingwatch.org/v3/events?datasets[0]=public-global-gaps-events:latest&limit=100`;

            const res = await axios.get(url, {
                timeout: 30000,
                headers: {
                    'Authorization': `Bearer ${token}`,
                },
            });

            const entries = res.data?.entries || res.data;
            if (!Array.isArray(entries)) {
                console.warn('[GFW] Unexpected response shape');
                return;
            }

            const records: GFWEvent[] = [];
            for (const ev of entries) {
                const pos = ev.position || ev.start_position || {};
                const lat = pos.lat ?? pos.latitude;
                const lng = pos.lon ?? pos.lng ?? pos.longitude;
                if (lat == null || lng == null) continue;

                records.push({
                    id: `gfw-${ev.id || records.length}`,
                    lat: parseFloat(lat),
                    lng: parseFloat(lng),
                    type: ev.type || 'gap',
                    start: ev.start || '',
                    end: ev.end || '',
                    vesselId: ev.vessel?.id || '',
                    vesselName: ev.vessel?.name || '',
                    flagState: ev.vessel?.flag || ev.vessel?.flagState || '',
                });
            }

            this.events = records;
            this.health = 'streaming';
            this.lastError = null;
            console.log(`[GFW] ${records.length} dark vessel / gap events loaded`);
        } catch (err: any) {
            console.error('[GFW] Fetch failed:', err.message);
            this.health = 'error';
            this.lastError = err.message;
        }
    }
}
