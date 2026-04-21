import axios from 'axios';
import { SourcePersistenceService } from './source-persistence.service';

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
    confidence: number | null;
    duration: number | null;       // seconds
    vesselOwner: string | null;
    vesselMmsi: string | null;
    vesselType: string | null;
}

export class GFWService {
    private events: GFWEvent[] = [];
    private timer: NodeJS.Timeout | null = null;
    private health: 'streaming' | 'error' | 'auth-missing' = 'streaming';
    private lastError: string | null = null;

    constructor(private readonly persistence?: SourcePersistenceService) {}

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
            // Build date range: last 30 days
            const end = new Date();
            const start = new Date();
            start.setDate(start.getDate() - 30);
            const startDate = start.toISOString().slice(0, 10);
            const endDate = end.toISOString().slice(0, 10);

            // Paginate through all pages. The v3 API caps a single call
            // at 100 events — without pagination we only see the most
            // recent slice and older events silently drop off.
            const pageSize = 100;
            const maxPages = 50;
            const entries: any[] = [];
            const rawPages: unknown[] = [];
            let hitPageLimit = false;
            let malformedPage = false;
            for (let page = 0; page < maxPages; page += 1) {
                const offset = page * pageSize;
                const url = `https://gateway.api.globalfishingwatch.org/v3/events?datasets[0]=public-global-gaps-events:latest&limit=${pageSize}&offset=${offset}&start-date=${startDate}&end-date=${endDate}&sort=-start`;
                const res = await axios.get(url, {
                    timeout: 30000,
                    headers: { 'Authorization': `Bearer ${token}` },
                });
                rawPages.push(res.data);
                const pageEntries = res.data?.entries || res.data;
                if (!Array.isArray(pageEntries)) {
                    console.warn(`[GFW] Malformed response on page ${page} (offset=${offset}); aborting pagination`);
                    malformedPage = true;
                    break;
                }
                if (pageEntries.length === 0) break;
                entries.push(...pageEntries);
                if (pageEntries.length < pageSize) break;
                if (page === maxPages - 1) hitPageLimit = true;
            }
            if (hitPageLimit) {
                console.warn(
                    `[GFW] hit pagination cap (${maxPages} × ${pageSize} = ${maxPages * pageSize} events); older AIS gap events may be truncated — consider narrowing the 30-day window or raising maxPages`,
                );
            }

            const records: GFWEvent[] = [];
            for (const ev of entries) {
                const pos = ev.position || ev.start_position || {};
                const lat = pos.lat ?? pos.latitude;
                const lng = pos.lon ?? pos.lng ?? pos.longitude;
                if (lat == null || lng == null) continue;

                // Compute duration in seconds if both timestamps exist
                let duration: number | null = null;
                if (ev.start && ev.end) {
                    const ms = new Date(ev.end).getTime() - new Date(ev.start).getTime();
                    if (!isNaN(ms) && ms > 0) duration = Math.round(ms / 1000);
                }

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
                    confidence: ev.confidence ?? ev.score ?? null,
                    duration,
                    vesselOwner: ev.vessel?.owner || null,
                    vesselMmsi: ev.vessel?.mmsi || ev.vessel?.ssvid || null,
                    vesselType: ev.vessel?.vesselType || ev.vessel?.type || null,
                });
            }

            this.events = records;
            this.health = malformedPage ? 'error' : 'streaming';
            this.lastError = malformedPage ? 'Malformed page in GFW pagination' : null;
            await this.persistence?.persistGfwEvents(records, { rawPayload: rawPages });
            console.log(`[GFW] ${records.length} AIS gap events loaded (${entries.length} raw across ${rawPages.length} pages)`);
        } catch (err: any) {
            const body = err.response?.data;
            const detail = body ? JSON.stringify(body) : err.message;
            console.error('[GFW] Fetch failed:', detail);
            this.health = 'error';
            this.lastError = detail;
        }
    }
}
