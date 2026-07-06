import axios from 'axios';
import { DatabaseService } from '../db/database.service';
import { retryWithBackoff } from './http-retry';

// ---------------------------------------------------------------------------
// VesselEnrichmentService — on-demand reference lookups for a selected vessel.
//
// Two providers, both fetched lazily when an entity card requests enrichment
// and cached in core.vessel_enrichment:
//   - Wikimedia Commons: photos from the per-ship "Category:IMO <number>"
//     category (no API key required, CC licensing with attribution).
//   - Global Fishing Watch Vessels API: registry identity by IMO using the
//     same GFW_TOKEN already configured for the GFW events source.
// ---------------------------------------------------------------------------

export interface VesselPhoto {
    url: string;                 // direct thumbnail URL (commons, ~640px wide)
    descriptionUrl: string;      // file page (licensing/attribution source)
    title: string;
    attribution: string | null;  // artist as plain text when available
    license: string | null;
}

export interface VesselEnrichment {
    imo: string;
    mmsi: string | null;
    photos: VesselPhoto[];
    photosTruncated: boolean;
    gfwIdentity: Record<string, any> | null;
    providerStatus: Record<string, string>;
    fetchedAt: string;
    cached: boolean;
}

const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const GFW_VESSELS_API = 'https://gateway.api.globalfishingwatch.org/v3/vessels/search';
const COMMONS_PHOTO_LIMIT = 20;          // per-card payload bound, reported via photosTruncated
const CACHE_TTL_HIT_MS = 30 * 24 * 3600 * 1000;   // found data is stable
const CACHE_TTL_MISS_MS = 24 * 3600 * 1000;       // retry empty lookups daily

type CacheRow = {
    imo: string;
    mmsi: string | null;
    photos: VesselPhoto[];
    gfw_identity: Record<string, any> | null;
    provider_status: Record<string, string>;
    fetched_at: string;
};

function stripHtml(value: unknown): string | null {
    if (typeof value !== 'string' || !value.trim()) return null;
    return value.replace(/<[^>]*>/g, '').trim() || null;
}

export class VesselEnrichmentService {
    private readonly inflight = new Map<string, Promise<VesselEnrichment>>();

    constructor(private readonly database: DatabaseService) {}

    isValidImo(imo: string): boolean {
        return /^\d{7}$/.test(imo);
    }

    async getEnrichment(imo: string, mmsi?: string | null, refresh = false): Promise<VesselEnrichment> {
        if (!refresh) {
            const cached = await this.readCache(imo);
            if (cached) return cached;
        }
        const existing = this.inflight.get(imo);
        if (existing) return existing;
        const pending = this.fetchAndCache(imo, mmsi ?? null).finally(() => this.inflight.delete(imo));
        this.inflight.set(imo, pending);
        return pending;
    }

    private async readCache(imo: string): Promise<VesselEnrichment | null> {
        if (!this.database.isReady()) return null;
        const result = await this.database.query<CacheRow>(
            `SELECT imo, mmsi, photos, gfw_identity, provider_status, fetched_at
               FROM core.vessel_enrichment WHERE imo = $1`,
            [imo],
        );
        const row = result?.rows[0];
        if (!row) return null;
        const ageMs = Date.now() - new Date(row.fetched_at).getTime();
        const isHit = (row.photos?.length || 0) > 0 || row.gfw_identity != null;
        if (ageMs > (isHit ? CACHE_TTL_HIT_MS : CACHE_TTL_MISS_MS)) return null;
        return {
            imo: row.imo,
            mmsi: row.mmsi,
            photos: row.photos || [],
            photosTruncated: row.provider_status?.commons === 'truncated',
            gfwIdentity: row.gfw_identity,
            providerStatus: row.provider_status || {},
            fetchedAt: new Date(row.fetched_at).toISOString(),
            cached: true,
        };
    }

    private async fetchAndCache(imo: string, mmsi: string | null): Promise<VesselEnrichment> {
        const providerStatus: Record<string, string> = {};
        const [photosResult, gfwResult] = await Promise.allSettled([
            this.fetchCommonsPhotos(imo),
            this.fetchGfwIdentity(imo),
        ]);

        let photos: VesselPhoto[] = [];
        let photosTruncated = false;
        if (photosResult.status === 'fulfilled') {
            photos = photosResult.value.photos;
            photosTruncated = photosResult.value.truncated;
            providerStatus.commons = photosTruncated ? 'truncated' : photos.length ? 'ok' : 'empty';
        } else {
            providerStatus.commons = `error: ${photosResult.reason?.message || photosResult.reason}`;
        }

        let gfwIdentity: Record<string, any> | null = null;
        if (gfwResult.status === 'fulfilled') {
            gfwIdentity = gfwResult.value;
            providerStatus.gfw = gfwIdentity ? 'ok' : process.env.GFW_TOKEN ? 'empty' : 'auth-missing';
        } else {
            providerStatus.gfw = `error: ${gfwResult.reason?.message || gfwResult.reason}`;
        }

        const fetchedAt = new Date().toISOString();
        if (this.database.isReady()) {
            await this.database.query(
                `INSERT INTO core.vessel_enrichment (imo, mmsi, photos, gfw_identity, provider_status, fetched_at)
                 VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6)
                 ON CONFLICT (imo) DO UPDATE SET
                     mmsi = COALESCE(EXCLUDED.mmsi, core.vessel_enrichment.mmsi),
                     photos = EXCLUDED.photos,
                     gfw_identity = EXCLUDED.gfw_identity,
                     provider_status = EXCLUDED.provider_status,
                     fetched_at = EXCLUDED.fetched_at`,
                [imo, mmsi, JSON.stringify(photos), gfwIdentity ? JSON.stringify(gfwIdentity) : null, JSON.stringify(providerStatus), fetchedAt],
            ).catch((err) => console.warn('[vessel-enrichment] cache write failed:', err?.message || err));
        }

        return { imo, mmsi, photos, photosTruncated, gfwIdentity, providerStatus, fetchedAt, cached: false };
    }

    // Commons convention: lightly documented ships keep files directly in
    // "Category:IMO <number>"; well documented ones nest them in a ship-name
    // subcategory (e.g. "Category:Ever Given (ship, 2018)"). Try the IMO
    // category first, then descend one level into its subcategories.
    private async fetchCommonsPhotos(imo: string): Promise<{ photos: VesselPhoto[]; truncated: boolean }> {
        const direct = await this.fetchCommonsCategoryFiles(`Category:IMO ${imo}`);
        if (direct.photos.length > 0) return direct;
        const subcats = await this.fetchCommonsSubcategories(`Category:IMO ${imo}`);
        for (const subcat of subcats) {
            const nested = await this.fetchCommonsCategoryFiles(subcat);
            if (nested.photos.length > 0) return nested;
        }
        return { photos: [], truncated: false };
    }

    private async fetchCommonsSubcategories(category: string): Promise<string[]> {
        const response = await retryWithBackoff(
            () => axios.get(COMMONS_API, {
                params: {
                    action: 'query',
                    list: 'categorymembers',
                    cmtitle: category,
                    cmtype: 'subcat',
                    cmlimit: 5,
                    format: 'json',
                    origin: '*',
                },
                timeout: 12_000,
                headers: { 'User-Agent': 'OpenSpy/1.0 (vessel enrichment; non-commercial OSINT)' },
            }),
            { maxAttempts: 2, label: 'commons-subcats' },
        );
        const members = response.data?.query?.categorymembers;
        if (!Array.isArray(members)) return [];
        return members.map((m: any) => String(m?.title || '')).filter(Boolean);
    }

    private async fetchCommonsCategoryFiles(category: string): Promise<{ photos: VesselPhoto[]; truncated: boolean }> {
        const response = await retryWithBackoff(
            () => axios.get(COMMONS_API, {
                params: {
                    action: 'query',
                    generator: 'categorymembers',
                    gcmtitle: category,
                    gcmtype: 'file',
                    gcmlimit: COMMONS_PHOTO_LIMIT,
                    prop: 'imageinfo',
                    iiprop: 'url|extmetadata',
                    iiurlwidth: 640,
                    format: 'json',
                    origin: '*',
                },
                timeout: 12_000,
                headers: { 'User-Agent': 'OpenSpy/1.0 (vessel enrichment; non-commercial OSINT)' },
            }),
            { maxAttempts: 2, label: 'commons-photos' },
        );
        const pages = response.data?.query?.pages;
        if (!pages || typeof pages !== 'object') return { photos: [], truncated: false };
        const photos: VesselPhoto[] = [];
        for (const page of Object.values<any>(pages)) {
            const info = Array.isArray(page?.imageinfo) ? page.imageinfo[0] : null;
            if (!info?.thumburl && !info?.url) continue;
            const meta = info.extmetadata || {};
            photos.push({
                url: info.thumburl || info.url,
                descriptionUrl: info.descriptionurl || info.descriptionshorturl || '',
                title: String(page.title || '').replace(/^File:/, ''),
                attribution: stripHtml(meta.Artist?.value),
                license: stripHtml(meta.LicenseShortName?.value),
            });
        }
        return { photos, truncated: Boolean(response.data?.continue) };
    }

    private async fetchGfwIdentity(imo: string): Promise<Record<string, any> | null> {
        const token = process.env.GFW_TOKEN;
        if (!token) return null;
        const response = await retryWithBackoff(
            () => axios.get(GFW_VESSELS_API, {
                params: {
                    query: imo,
                    'datasets[0]': 'public-global-vessel-identity:latest',
                },
                timeout: 12_000,
                headers: { Authorization: `Bearer ${token}` },
            }),
            { maxAttempts: 2, label: 'gfw-vessel-identity' },
        );
        const entry = Array.isArray(response.data?.entries) ? response.data.entries[0] : null;
        if (!entry) return null;
        const registry = Array.isArray(entry.registryInfo) ? entry.registryInfo[0] : null;
        const selfReported = Array.isArray(entry.selfReportedInfo) ? entry.selfReportedInfo[0] : null;
        const owner = Array.isArray(entry.registryOwners) ? entry.registryOwners[0] : null;
        return {
            registry: registry ? {
                shipname: registry.shipname ?? null,
                flag: registry.flag ?? null,
                vesselType: registry.vesselType ?? null,
                geartypes: registry.geartypes ?? null,
                lengthM: registry.lengthM ?? null,
                tonnageGt: registry.tonnageGt ?? null,
                callsign: registry.callsign ?? null,
            } : null,
            selfReported: selfReported ? {
                shipname: selfReported.shipname ?? null,
                flag: selfReported.flag ?? null,
                shiptypes: selfReported.shiptypes ?? null,
                transmissionDateFrom: selfReported.transmissionDateFrom ?? null,
                transmissionDateTo: selfReported.transmissionDateTo ?? null,
            } : null,
            owner: owner ? {
                name: owner.name ?? null,
                flag: owner.flag ?? null,
                ssvid: owner.ssvid ?? null,
            } : null,
            matchCount: Array.isArray(response.data?.entries) ? response.data.entries.length : 0,
        };
    }
}
