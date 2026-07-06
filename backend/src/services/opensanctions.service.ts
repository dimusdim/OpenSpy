import axios from 'axios';
import { databaseService } from '../db/database.service';

// ---------------------------------------------------------------------------
// OpenSanctions maritime enrichment.
//
// Free daily CSV aggregating sanctioned/flagged vessels from OFAC, EU, UK, UAE,
// Tokyo MoU detentions, Ukraine War & Sanctions, etc. We upsert it into
// app.sanctioned_vessels and hold IMO/MMSI lookup maps in memory so live AIS
// tracks can be flagged. Data license CC-BY-NC — provenance kept per row.
// ---------------------------------------------------------------------------

const MARITIME_CSV_URL = 'https://data.opensanctions.org/datasets/latest/maritime/maritime.csv';

export interface SanctionInfo {
    caption: string | null;
    risk: string | null;
    datasets: string | null;
    flag: string | null;
}

type SanctionRow = {
    id: string;
    caption: string;
    imo: string;
    mmsi: string;
    flag: string;
    countries: string;
    risk: string;
    datasets: string;
    url: string;
};

// Minimal RFC-4180 CSV parser (quoted fields, embedded commas/quotes/newlines).
function parseCsv(text: string): string[][] {
    const rows: string[][] = [];
    let field = '';
    let row: string[] = [];
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQuotes) {
            if (c === '"') {
                if (text[i + 1] === '"') { field += '"'; i++; }
                else inQuotes = false;
            } else field += c;
        } else if (c === '"') {
            inQuotes = true;
        } else if (c === ',') {
            row.push(field); field = '';
        } else if (c === '\n') {
            row.push(field); field = '';
            rows.push(row); row = [];
        } else if (c === '\r') {
            // swallow; handled by \n
        } else {
            field += c;
        }
    }
    if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
    return rows;
}

export class OpenSanctionsService {
    private timer: NodeJS.Timeout | null = null;
    private byMmsi = new Map<string, SanctionInfo>();
    private byImo = new Map<string, SanctionInfo>();
    private health: 'streaming' | 'error' | 'connecting' = 'connecting';
    private lastError: string | null = null;
    private lastRefreshAt: number | null = null;
    private readonly intervalMs: number;

    constructor() {
        const env = Number(process.env.OPENSANCTIONS_INTERVAL_MS);
        this.intervalMs = Number.isFinite(env) && env > 0 ? env : 24 * 60 * 60 * 1000;
    }

    start() {
        console.log('[OpenSanctions] Starting sanctioned-vessel enrichment...');
        // Warm the in-memory maps from any previously persisted data first (fast),
        // then refresh the CSV in the background.
        void this.loadFromDb().then(() => void this.refresh());
        this.timer = setInterval(() => void this.refresh(), this.intervalMs);
    }

    getHealth() {
        return {
            status: this.health,
            note: this.lastError || undefined,
            count: this.byImo.size + this.byMmsi.size,
            lastRefreshAt: this.lastRefreshAt ? new Date(this.lastRefreshAt).toISOString() : null,
        };
    }

    isSanctioned(mmsi?: string | null, imo?: string | null): boolean {
        return this.getSanctionInfo(mmsi, imo) !== null;
    }

    getSanctionInfo(mmsi?: string | null, imo?: string | null): SanctionInfo | null {
        if (imo) {
            const hit = this.byImo.get(String(imo).trim());
            if (hit) return hit;
        }
        if (mmsi) {
            const hit = this.byMmsi.get(String(mmsi).trim());
            if (hit) return hit;
        }
        return null;
    }

    private async loadFromDb() {
        if (!databaseService.isReady()) return;
        try {
            const res = await databaseService.query<{ mmsi: string | null; imo: string | null; caption: string | null; risk: string | null; datasets: string | null; flag: string | null }>(
                `SELECT mmsi, imo, caption, risk, datasets, flag FROM app.sanctioned_vessels
                 WHERE (mmsi IS NOT NULL AND mmsi <> '') OR (imo IS NOT NULL AND imo <> '')`,
            );
            this.indexRows(res?.rows || []);
        } catch (err: any) {
            console.warn('[OpenSanctions] loadFromDb failed:', err?.message || err);
        }
    }

    private indexRows(rows: Array<{ mmsi: string | null; imo: string | null; caption: string | null; risk: string | null; datasets: string | null; flag: string | null }>) {
        const byMmsi = new Map<string, SanctionInfo>();
        const byImo = new Map<string, SanctionInfo>();
        // A row may carry several MMSIs ("311001724;636024321") and IMO is stored
        // prefixed ("IMO9307841") while AIS reports a bare number — normalize both.
        for (const r of rows) {
            const info: SanctionInfo = { caption: r.caption, risk: r.risk, datasets: r.datasets, flag: r.flag };
            for (const part of String(r.mmsi || '').split(/[;,]/)) {
                const m = part.trim();
                if (m) byMmsi.set(m, info);
            }
            for (const part of String(r.imo || '').split(/[;,]/)) {
                const digits = part.replace(/\D/g, '');
                if (digits) byImo.set(digits, info);
            }
        }
        this.byMmsi = byMmsi;
        this.byImo = byImo;
    }

    private async refresh() {
        try {
            const res = await axios.get(MARITIME_CSV_URL, { timeout: 60_000, responseType: 'text' });
            const table = parseCsv(String(res.data));
            if (table.length < 2) throw new Error('empty maritime CSV');
            const header = table[0];
            const idx = (name: string) => header.indexOf(name);
            const cType = idx('type'), cCap = idx('caption'), cImo = idx('imo'), cMmsi = idx('mmsi'),
                cFlag = idx('flag'), cCountries = idx('countries'), cRisk = idx('risk'),
                cDatasets = idx('datasets'), cUrl = idx('url'), cId = idx('id');

            const records: SanctionRow[] = [];
            for (let i = 1; i < table.length; i++) {
                const row = table[i];
                if (!row || row.length < header.length) continue;
                if ((row[cType] || '').toUpperCase() !== 'VESSEL') continue;
                const id = (row[cId] || '').trim();
                if (!id) continue;
                records.push({
                    id,
                    caption: row[cCap] || '',
                    imo: (row[cImo] || '').trim(),
                    mmsi: (row[cMmsi] || '').trim(),
                    flag: row[cFlag] || '',
                    countries: row[cCountries] || '',
                    risk: row[cRisk] || '',
                    datasets: row[cDatasets] || '',
                    url: row[cUrl] || '',
                });
            }

            // Dedup by entity id — the CSV can repeat an id, which would trip
            // "ON CONFLICT DO UPDATE cannot affect row a second time".
            const deduped = Array.from(new Map(records.map((r) => [r.id, r])).values());
            await this.upsert(deduped);
            await this.loadFromDb();
            this.lastRefreshAt = Date.now();
            this.health = 'streaming';
            this.lastError = null;
            console.log(`[OpenSanctions] ${deduped.length} sanctioned vessels (mmsi=${this.byMmsi.size}, imo=${this.byImo.size}).`);
        } catch (err: any) {
            console.error('[OpenSanctions] refresh failed:', err.message);
            this.health = this.byImo.size > 0 ? 'streaming' : 'error';
            this.lastError = err.message;
        }
    }

    private async upsert(records: SanctionRow[]) {
        if (!databaseService.isReady() || records.length === 0) return;
        const CHUNK = 5000;
        for (let i = 0; i < records.length; i += CHUNK) {
            const batch = records.slice(i, i + CHUNK);
            await databaseService.query(
                `INSERT INTO app.sanctioned_vessels
                    (id, caption, imo, mmsi, flag, countries, risk, datasets, url, updated_at)
                 SELECT id, NULLIF(caption,''), NULLIF(imo,''), NULLIF(mmsi,''), NULLIF(flag,''),
                        NULLIF(countries,''), NULLIF(risk,''), NULLIF(datasets,''), NULLIF(url,''), now()
                 FROM jsonb_to_recordset($1::jsonb) AS r(
                    id text, caption text, imo text, mmsi text, flag text,
                    countries text, risk text, datasets text, url text)
                 ON CONFLICT (id) DO UPDATE SET
                    caption=EXCLUDED.caption, imo=EXCLUDED.imo, mmsi=EXCLUDED.mmsi, flag=EXCLUDED.flag,
                    countries=EXCLUDED.countries, risk=EXCLUDED.risk, datasets=EXCLUDED.datasets,
                    url=EXCLUDED.url, updated_at=now()`,
                [JSON.stringify(batch)],
            );
        }
    }
}
