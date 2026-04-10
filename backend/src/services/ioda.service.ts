import axios from 'axios';

export interface OutageRecord {
    id: string;
    country: string;
    countryCode: string;
    lat: number;
    lng: number;
    level: string;       // 'critical' | 'warning' | 'normal'
    datasource: string;
    startTime: string;    // ISO 8601
}

// ~200 country centroids (ISO-3166-1 alpha-2 → [lat, lng]).
// Generated from NaturalEarth centroids; covers all UN-recognised states + a
// handful of territories that show up in IODA alerts.
const COUNTRY_CENTROIDS: Record<string, [number, number]> = {
    AF: [33.9, 67.7], AL: [41.2, 20.2], DZ: [28.0, 1.7], AD: [42.5, 1.5],
    AO: [-11.2, 17.9], AG: [17.1, -61.8], AR: [-38.4, -63.6], AM: [40.1, 44.5],
    AU: [-25.3, 133.8], AT: [47.5, 14.6], AZ: [40.1, 47.6], BS: [25.0, -77.4],
    BH: [26.1, 50.6], BD: [23.7, 90.4], BB: [13.2, -59.5], BY: [53.7, 27.9],
    BE: [50.5, 4.5], BZ: [17.2, -88.5], BJ: [9.3, 2.3], BT: [27.5, 90.4],
    BO: [-16.3, -63.6], BA: [43.9, 17.7], BW: [-22.3, 24.7], BR: [-14.2, -51.9],
    BN: [4.5, 114.7], BG: [42.7, 25.5], BF: [12.3, -1.6], BI: [-3.4, 29.9],
    KH: [12.6, 105.0], CM: [7.4, 12.4], CA: [56.1, -106.3], CV: [16.0, -24.0],
    CF: [6.6, 20.9], TD: [15.5, 18.7], CL: [-35.7, -71.5], CN: [35.9, 104.2],
    CO: [4.6, -74.3], KM: [-11.9, 43.9], CD: [-4.0, 21.8], CG: [-0.2, 15.8],
    CR: [9.7, -83.8], CI: [7.5, -5.5], HR: [45.1, 15.2], CU: [21.5, -78.0],
    CY: [35.1, 33.4], CZ: [49.8, 15.5], DK: [56.3, 9.5], DJ: [11.6, 43.1],
    DM: [15.4, -61.4], DO: [18.7, -70.2], EC: [-1.8, -78.2], EG: [26.8, 30.8],
    SV: [13.8, -88.9], GQ: [1.7, 10.3], ER: [15.2, 39.8], EE: [58.6, 25.0],
    SZ: [-26.5, 31.5], ET: [9.1, 40.5], FJ: [-17.7, 178.1], FI: [61.9, 25.7],
    FR: [46.2, 2.2], GA: [-0.8, 11.6], GM: [13.4, -16.6], GE: [42.3, 43.4],
    DE: [51.2, 10.5], GH: [7.9, -1.0], GR: [39.1, 21.8], GD: [12.1, -61.7],
    GT: [15.8, -90.2], GN: [9.9, -9.7], GW: [11.8, -15.2], GY: [5.0, -58.9],
    HT: [19.1, -72.3], HN: [15.2, -86.2], HU: [47.2, 19.5], IS: [65.0, -18.0],
    IN: [20.6, 79.0], ID: [-0.8, 113.9], IR: [32.4, 53.7], IQ: [33.2, 43.7],
    IE: [53.4, -8.2], IL: [31.0, 34.9], IT: [41.9, 12.6], JM: [18.1, -77.3],
    JP: [36.2, 138.3], JO: [30.6, 36.2], KZ: [48.0, 68.0], KE: [-0.0, 37.9],
    KI: [-3.4, -168.7], KP: [40.3, 127.5], KR: [35.9, 127.8], KW: [29.3, 47.5],
    KG: [41.2, 74.8], LA: [19.9, 102.5], LV: [56.9, 24.1], LB: [33.9, 35.9],
    LS: [-29.6, 28.2], LR: [6.4, -9.4], LY: [26.3, 17.2], LI: [47.2, 9.6],
    LT: [55.2, 23.9], LU: [49.8, 6.1], MG: [-18.8, 46.9], MW: [-13.3, 34.3],
    MY: [4.2, 101.9], MV: [3.2, 73.2], ML: [17.6, -4.0], MT: [35.9, 14.4],
    MH: [7.1, 171.2], MR: [21.0, -10.9], MU: [-20.3, 57.6], MX: [23.6, -102.6],
    FM: [7.4, 150.6], MD: [47.4, 28.4], MC: [43.7, 7.4], MN: [46.9, 103.8],
    ME: [42.7, 19.4], MA: [31.8, -7.1], MZ: [-18.7, 35.5], MM: [21.9, 96.0],
    NA: [-22.0, 17.1], NR: [-0.5, 166.9], NP: [28.4, 84.1], NL: [52.1, 5.3],
    NZ: [-40.9, 174.9], NI: [12.9, -85.2], NE: [17.6, 8.1], NG: [9.1, 8.7],
    MK: [41.5, 21.7], NO: [60.5, 8.5], OM: [21.5, 55.9], PK: [30.4, 69.3],
    PW: [7.5, 134.6], PA: [8.5, -80.8], PG: [-6.3, 143.9], PY: [-23.4, -58.4],
    PE: [-9.2, -75.0], PH: [12.9, 121.8], PL: [51.9, 19.1], PT: [39.4, -8.2],
    QA: [25.4, 51.2], RO: [45.9, 25.0], RU: [61.5, 105.3], RW: [-1.9, 29.9],
    KN: [17.4, -62.8], LC: [13.9, -61.0], VC: [12.9, -61.3], WS: [-13.8, -172.1],
    SM: [43.9, 12.5], ST: [0.2, 6.6], SA: [23.9, 45.1], SN: [14.5, -14.5],
    RS: [44.0, 21.0], SC: [-4.7, 55.5], SL: [8.5, -11.8], SG: [1.4, 103.8],
    SK: [48.7, 19.7], SI: [46.2, 15.0], SB: [-9.6, 160.2], SO: [5.2, 46.2],
    ZA: [-30.6, 22.9], SS: [7.9, 29.5], ES: [40.5, -3.7], LK: [7.9, 80.8],
    SD: [12.9, 30.2], SR: [3.9, -56.0], SE: [60.1, 18.6], CH: [46.8, 8.2],
    SY: [34.8, 39.0], TW: [23.7, 121.0], TJ: [38.9, 71.3], TZ: [-6.4, 34.9],
    TH: [15.9, 100.9], TL: [-8.9, 126.0], TG: [8.6, 1.2], TO: [-21.2, -175.2],
    TT: [10.7, -61.2], TN: [33.9, 9.5], TR: [39.0, 35.2], TM: [39.0, 59.6],
    TV: [-7.5, 178.0], UG: [1.4, 32.3], UA: [48.4, 31.2], AE: [23.4, 53.8],
    GB: [55.4, -3.4], US: [37.1, -95.7], UY: [-32.5, -55.8], UZ: [41.4, 64.6],
    VU: [-15.4, 166.9], VE: [6.4, -66.6], VN: [14.1, 108.3], YE: [15.6, 48.5],
    ZM: [-13.1, 28.0], ZW: [-19.0, 29.2], PS: [32.0, 35.2], XK: [42.6, 20.9],
    HK: [22.4, 114.1], MO: [22.2, 113.5], PR: [18.2, -66.6], GU: [13.4, 144.8],
    CW: [12.2, -68.9], AW: [12.5, -70.0], RE: [-21.1, 55.5], GP: [16.3, -61.6],
    MQ: [14.6, -61.0], NC: [-20.9, 165.6], PF: [-17.7, -149.4], GF: [3.9, -53.1],
    GL: [71.7, -42.6],
};

export class IODAService {
    private outages: OutageRecord[] = [];
    private timer: NodeJS.Timeout | null = null;

    start() {
        console.log('[IODA] Starting internet outage monitoring...');
        this.fetchOutages();
        this.timer = setInterval(() => this.fetchOutages(), 10 * 60 * 1000); // every 10 min
    }

    getOutages(): OutageRecord[] {
        return this.outages;
    }

    private async fetchOutages() {
        try {
            const now = Math.floor(Date.now() / 1000);
            const from = now - 86400; // 24h ago
            const url = `https://api.ioda.caida.org/dev/outages/alerts/country?from=${from}&until=${now}`;
            const res = await axios.get(url, { timeout: 20000 });

            if (!res.data?.data) {
                console.warn('[IODA] Unexpected response shape');
                return;
            }

            const records: OutageRecord[] = [];
            const alerts = res.data.data;

            // IODA returns an array of alert objects. Each has:
            //   entity.code  (ISO-3166 alpha-2)
            //   entity.name
            //   level        ('critical' | 'warning' | 'normal')
            //   datasource   ('bgp' | 'active-probing' | 'merit-nt' | ...)
            //   time         (unix timestamp)
            //   condition    ('down' | ...)
            for (const alert of alerts) {
                const entity = alert.entity;
                if (!entity?.code) continue;

                const code = (entity.code as string).toUpperCase();
                const centroid = COUNTRY_CENTROIDS[code];
                if (!centroid) continue; // skip unknown country codes

                // Only surface non-normal alerts (critical + warning)
                const level = (alert.level || 'normal').toLowerCase();
                if (level === 'normal') continue;

                const datasource = alert.datasource || 'unknown';
                const startTime = alert.time
                    ? new Date(alert.time * 1000).toISOString()
                    : new Date().toISOString();

                records.push({
                    id: `ioda-${code}-${datasource}-${alert.time || 0}`,
                    country: entity.name || code,
                    countryCode: code,
                    lat: centroid[0],
                    lng: centroid[1],
                    level,
                    datasource,
                    startTime,
                });
            }

            // Deduplicate: keep the highest-severity alert per country
            const byCountry = new Map<string, OutageRecord>();
            for (const r of records) {
                const existing = byCountry.get(r.countryCode);
                if (!existing || severityRank(r.level) > severityRank(existing.level)) {
                    byCountry.set(r.countryCode, r);
                }
            }

            this.outages = Array.from(byCountry.values());
            console.log(`[IODA] ${this.outages.length} internet outage alerts (${this.outages.filter(o => o.level === 'critical').length} critical, ${this.outages.filter(o => o.level === 'warning').length} warning)`);
        } catch (err: any) {
            console.error('[IODA] Fetch failed:', err.message);
        }
    }
}

function severityRank(level: string): number {
    if (level === 'critical') return 2;
    if (level === 'warning') return 1;
    return 0;
}
