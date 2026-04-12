import axios from 'axios';

export interface CloudflareOutage {
    id: string;
    startDate: string;
    endDate: string;
    scope: string;
    asn: number;
    asnName: string;
    locations: string[];
    outageType: string;
    outageCause: string;
}

export class CloudflareService {
    private outages: CloudflareOutage[] = [];
    private timer: NodeJS.Timeout | null = null;
    private health: 'streaming' | 'error' | 'auth-missing' = 'streaming';
    private lastError: string | null = null;

    start() {
        const token = process.env.CLOUDFLARE_API_TOKEN;
        if (!token) {
            console.warn('[Cloudflare] API key not configured, skipping');
            this.health = 'auth-missing';
            return;
        }

        console.log('[Cloudflare] Starting internet outage monitoring...');
        this.fetchOutages();
        this.timer = setInterval(() => this.fetchOutages(), 15 * 60 * 1000); // every 15 min
    }

    getOutages(): CloudflareOutage[] {
        return this.outages;
    }

    getHealth() {
        return { status: this.health, note: this.lastError || undefined, count: this.outages.length };
    }

    private async fetchOutages() {
        const token = process.env.CLOUDFLARE_API_TOKEN;
        if (!token) return;

        try {
            const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
            const url = `https://api.cloudflare.com/client/v4/radar/annotations/outages?limit=50&dateStart=${twentyFourHoursAgo}`;

            const res = await axios.get(url, {
                timeout: 30000,
                headers: {
                    'Authorization': `Bearer ${token}`,
                },
            });

            const annotations = res.data?.result?.annotations || res.data?.result || [];
            if (!Array.isArray(annotations)) {
                console.warn('[Cloudflare] Unexpected response shape');
                return;
            }

            const records: CloudflareOutage[] = [];
            for (const a of annotations) {
                records.push({
                    id: `cf-${a.id || records.length}`,
                    startDate: a.startDate || a.start || '',
                    endDate: a.endDate || a.end || '',
                    scope: a.scope || '',
                    asn: parseInt(a.asn, 10) || 0,
                    asnName: a.asnName || a.asName || '',
                    locations: Array.isArray(a.locations) ? a.locations : (a.locations ? [a.locations] : []),
                    outageType: a.outageType || a.type || '',
                    outageCause: a.outageCause || a.cause || '',
                });
            }

            this.outages = records;
            this.health = 'streaming';
            this.lastError = null;
            console.log(`[Cloudflare] ${records.length} internet outage annotations loaded`);
        } catch (err: any) {
            console.error('[Cloudflare] Fetch failed:', err.message);
            this.health = 'error';
            this.lastError = err.message;
        }
    }
}
