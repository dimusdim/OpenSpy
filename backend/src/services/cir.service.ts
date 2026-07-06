import axios from 'axios';
import { SourcePersistenceService } from './source-persistence.service';

// ---------------------------------------------------------------------------
// Eyes on Russia / Centre for Information Resilience (CIR)
//
// Free, keyless ArcGIS FeatureServer of volunteer-geolocated, source-linked
// conflict events (Ukraine + CIR's Sudan/Gaza/etc. portfolio). Each entry has
// precise lat/lon, a category, a description, a source link and a timestamp.
// Renders on the existing `conflict` layer as an event source. Attribution: CIR.
//
// The endpoint has no explicit reuse license; under OpenSpy's BYOK model the
// user runs their own instance and accepts the provider's terms.
// ---------------------------------------------------------------------------

const CIR_QUERY_URL =
    'https://services-eu1.arcgis.com/06WOSMGHsCnaFyMp/arcgis/rest/services/EoR_completed_entries/FeatureServer/0/query';

// ArcGIS page size (server maxRecordCount is 1000). Full archive is pulled via
// resultOffset paging; PAGE_SAFETY_CAP is a runaway backstop, not a data cap —
// if hit we log and stop rather than silently truncating.
const PAGE_SIZE = 1000;
const PAGE_SAFETY_CAP = 200; // 200k events

export interface CirConflictEvent {
    id: string;
    lat: number;
    lng: number;
    observedAt: string | null;   // ISO
    category: string;
    secondaryCategory: string | null;
    description: string | null;
    sourceUrl: string | null;
    town: string | null;
    province: string | null;
    country: string | null;
    graphicLevel: string | null;
}

export class CIRService {
    private events: CirConflictEvent[] = [];
    private timer: NodeJS.Timeout | null = null;
    private health: 'streaming' | 'error' | 'connecting' = 'connecting';
    private lastError: string | null = null;
    private lastSuccessfulFetchAt: number | null = null;
    private readonly intervalMs: number;

    constructor(private readonly persistence?: SourcePersistenceService) {
        const envInterval = Number(process.env.CIR_INTERVAL_MS);
        // CIR is a slow-moving archive (dozens of new entries/day); a 30-min
        // cycle is plenty and the stable event_id makes each pull an idempotent
        // upsert.
        this.intervalMs = Number.isFinite(envInterval) && envInterval > 0 ? envInterval : 30 * 60 * 1000;
    }

    start() {
        console.log('[CIR] Starting Eyes on Russia / CIR conflict event monitoring...');
        void this.fetchLatest();
        this.timer = setInterval(() => void this.fetchLatest(), this.intervalMs);
    }

    getEvents(): CirConflictEvent[] {
        return this.events;
    }

    getHealth() {
        return {
            status: this.health,
            note: this.lastError || undefined,
            count: this.events.length,
            lastSuccessfulFetchAt: this.lastSuccessfulFetchAt
                ? new Date(this.lastSuccessfulFetchAt).toISOString()
                : null,
        };
    }

    private toNum(v: any): number | null {
        const n = typeof v === 'number' ? v : parseFloat(v);
        return Number.isFinite(n) ? n : null;
    }

    private async fetchLatest() {
        try {
            const collected: CirConflictEvent[] = [];
            let offset = 0;
            let pages = 0;
            for (; pages < PAGE_SAFETY_CAP; pages++) {
                const res = await axios.get(CIR_QUERY_URL, {
                    params: {
                        where: '1=1',
                        outFields: '*',
                        f: 'json',
                        resultOffset: offset,
                        resultRecordCount: PAGE_SIZE,
                        orderByFields: 'OBJECTID ASC',
                    },
                    timeout: 25_000,
                });
                const feats: any[] = Array.isArray(res.data?.features) ? res.data.features : [];
                for (const f of feats) {
                    const a = f?.attributes || {};
                    const lat = this.toNum(a.latitude) ?? this.toNum(f?.geometry?.y);
                    const lng = this.toNum(a.longitude) ?? this.toNum(f?.geometry?.x);
                    const entry = String(a.Entry_Number || a.OBJECTID || '').trim();
                    if (lat === null || lng === null || !entry) continue;
                    const ts = this.toNum(a.TIMESTAMP);
                    collected.push({
                        id: entry,
                        lat,
                        lng,
                        observedAt: ts !== null ? new Date(ts).toISOString() : null,
                        category: String(a.Primary_category || 'Unknown'),
                        secondaryCategory: a.Secondary_category && a.Secondary_category !== 'None'
                            ? String(a.Secondary_category) : null,
                        description: a.Description ? String(a.Description) : null,
                        sourceUrl: a.Link ? String(a.Link) : null,
                        town: a.Town_or_City ? String(a.Town_or_City) : null,
                        province: a.province ? String(a.province) : null,
                        country: a.country ? String(a.country) : null,
                        graphicLevel: a.Graphic_content_level ? String(a.Graphic_content_level) : null,
                    });
                }
                offset += PAGE_SIZE;
                if (feats.length < PAGE_SIZE || res.data?.exceededTransferLimit === false) break;
            }
            if (pages >= PAGE_SAFETY_CAP) {
                console.warn(`[CIR] page safety cap (${PAGE_SAFETY_CAP}) reached — pull may be incomplete`);
            }

            this.events = collected;
            this.lastSuccessfulFetchAt = Date.now();
            this.health = 'streaming';
            this.lastError = null;
            await this.persistence?.persistCirConflicts(collected);
            console.log(`[CIR] ${collected.length} conflict events ingested.`);
        } catch (err: any) {
            console.error('[CIR] Fetch failed:', err.message);
            this.health = 'error';
            this.lastError = err.message;
        }
    }
}
