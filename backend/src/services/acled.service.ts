import axios from 'axios';

export interface ConflictEvent {
    id: string;
    lat: number;
    lng: number;
    event_type: string;
    sub_event_type: string;
    fatalities: number;
    country: string;
    actor1: string;
    actor2: string;
    event_date: string;
    notes: string;
}

export class ACLEDService {
    private events: ConflictEvent[] = [];
    private timer: NodeJS.Timeout | null = null;
    private health: 'streaming' | 'error' | 'auth-missing' = 'streaming';
    private lastError: string | null = null;

    start() {
        const email = process.env.ACLED_EMAIL;
        const key = process.env.ACLED_KEY;

        if (!email || !key) {
            console.warn('[ACLED] API key not configured, skipping');
            this.health = 'auth-missing';
            return;
        }

        console.log('[ACLED] Starting armed conflict event monitoring...');
        this.fetchEvents();
        this.timer = setInterval(() => this.fetchEvents(), 30 * 60 * 1000); // every 30 min
    }

    getEvents(): ConflictEvent[] {
        return this.events;
    }

    getHealth() {
        return { status: this.health, note: this.lastError || undefined, count: this.events.length };
    }

    private async fetchEvents() {
        const email = process.env.ACLED_EMAIL;
        const key = process.env.ACLED_KEY;
        if (!email || !key) return;

        try {
            const now = new Date();
            const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
            const dateStr = sevenDaysAgo.toISOString().split('T')[0];

            const url = `https://api.acleddata.com/acled/read?key=${encodeURIComponent(key)}&email=${encodeURIComponent(email)}&event_type=Battles|Explosions/Remote violence|Violence against civilians&limit=500&event_date=${dateStr}&event_date_where=>`;

            const res = await axios.get(url, { timeout: 30000 });

            if (!res.data?.data) {
                console.warn('[ACLED] Unexpected response shape');
                return;
            }

            const records: ConflictEvent[] = [];
            for (const ev of res.data.data) {
                const lat = parseFloat(ev.latitude);
                const lng = parseFloat(ev.longitude);
                if (isNaN(lat) || isNaN(lng)) continue;

                records.push({
                    id: `acled-${ev.data_id || ev.event_id_cnty || records.length}`,
                    lat,
                    lng,
                    event_type: ev.event_type || 'Unknown',
                    sub_event_type: ev.sub_event_type || '',
                    fatalities: parseInt(ev.fatalities, 10) || 0,
                    country: ev.country || '',
                    actor1: ev.actor1 || '',
                    actor2: ev.actor2 || '',
                    event_date: ev.event_date || '',
                    notes: ev.notes || '',
                });
            }

            this.events = records;
            this.health = 'streaming';
            this.lastError = null;
            const battles = records.filter(e => e.event_type === 'Battles').length;
            const explosions = records.filter(e => e.event_type.includes('Explosions')).length;
            const violence = records.filter(e => e.event_type.includes('Violence')).length;
            console.log(`[ACLED] ${records.length} conflict events (${battles} battles, ${explosions} explosions, ${violence} violence)`);
        } catch (err: any) {
            console.error('[ACLED] Fetch failed:', err.message);
            this.health = 'error';
            this.lastError = err.message;
        }
    }
}
