import axios from 'axios';
import { SourcePersistenceService } from './source-persistence.service';
import { retryWithBackoff } from './http-retry';

export interface CloudflareOutage {
    id: string;
    startDate: string;
    endDate: string;
    scope: string;
    asn: number;
    asnName: string;
    locations: string[];
    locationNames?: string[];
    lat?: number | null;
    lng?: number | null;
    locationCode?: string | null;
    locationName?: string | null;
    locationIndex?: number | null;
    locationCount?: number | null;
    outageType: string;
    outageCause: string;
    url?: string | null;
    description?: string | null;
}

export class CloudflareService {
    private outages: CloudflareOutage[] = [];
    private timer: NodeJS.Timeout | null = null;
    private health: 'streaming' | 'error' | 'auth-missing' = 'streaming';
    private lastError: string | null = null;
    private lastSourceWindow: Record<string, unknown> | null = null;
    private lastPagination: Record<string, unknown> | null = null;

    constructor(private readonly persistence?: SourcePersistenceService) {}

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
        return {
            status: this.health,
            note: this.lastError || undefined,
            count: this.outages.length,
            sourceWindow: this.lastSourceWindow || undefined,
            pagination: this.lastPagination || undefined,
            truncated: Boolean(this.lastPagination?.truncated),
            completeness: this.health === 'auth-missing'
                ? 'unavailable'
                : this.lastPagination?.truncated
                    ? 'incomplete'
                    : 'complete',
        };
    }

    private positiveIntFromEnv(names: string[], fallback: number): number {
        for (const name of names) {
            const value = Number.parseInt(process.env[name] || '', 10);
            if (Number.isFinite(value) && value > 0) return value;
        }
        return fallback;
    }

    private asArray(value: unknown): any[] | null {
        if (Array.isArray(value)) return value;
        return null;
    }

    private async fetchOutages() {
        const token = process.env.CLOUDFLARE_API_TOKEN;
        if (!token) return;

        try {
            const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
            const effectivePageSize = this.positiveIntFromEnv(
                ['CLOUDFLARE_OUTAGE_PAGE_SIZE', 'CLOUDFLARE_OUTAGE_LIMIT'],
                100,
            );
            const effectiveMaxPages = this.positiveIntFromEnv(['CLOUDFLARE_OUTAGE_MAX_PAGES'], 50);
            const annotations: any[] = [];
            const rawPages: unknown[] = [];
            let hitPageLimit = false;
            let malformedPage = false;

            for (let page = 0; page < effectiveMaxPages; page += 1) {
                const offset = page * effectivePageSize;
                const params = new URLSearchParams({
                    limit: String(effectivePageSize),
                    offset: String(offset),
                    dateStart: twentyFourHoursAgo,
                });
                const url = `https://api.cloudflare.com/client/v4/radar/annotations/outages?${params.toString()}`;

                const res = await retryWithBackoff(() => axios.get(url, {
                    timeout: 30000,
                    headers: {
                        'Authorization': `Bearer ${token}`,
                    },
                }), { label: 'Cloudflare', maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 10000 });

                rawPages.push(res.data);
                const pageAnnotations = this.asArray(res.data?.result?.annotations)
                    || this.asArray(res.data?.result)
                    || this.asArray(res.data?.annotations);
                if (!pageAnnotations) {
                    console.warn(`[Cloudflare] Unexpected response shape on page ${page} (offset=${offset})`);
                    malformedPage = true;
                    break;
                }
                if (pageAnnotations.length === 0) break;
                annotations.push(...pageAnnotations);
                if (pageAnnotations.length < effectivePageSize) break;
                if (page === effectiveMaxPages - 1) hitPageLimit = true;
            }

            const ingestMetadata = {
                sourceWindow: { startDate: twentyFourHoursAgo, hours: 24 },
                pagination: {
                    pageSize: effectivePageSize,
                    maxPages: effectiveMaxPages,
                    fetchedPages: rawPages.length,
                    rawEntryCount: annotations.length,
                    hitPageLimit,
                    malformedPage,
                    truncated: hitPageLimit || malformedPage,
                },
            };
            this.lastSourceWindow = ingestMetadata.sourceWindow;
            this.lastPagination = ingestMetadata.pagination;

            if (malformedPage && annotations.length === 0) {
                this.health = 'error';
                this.lastError = 'Malformed page in Cloudflare outage pagination';
                return;
            }
            if (hitPageLimit) {
                console.warn(
                    `[Cloudflare] hit pagination cap (${effectiveMaxPages} x ${effectivePageSize} = ${effectiveMaxPages * effectivePageSize} annotations) since ${twentyFourHoursAgo}; raise CLOUDFLARE_OUTAGE_MAX_PAGES or narrow the source window`,
                );
            }

            const records: CloudflareOutage[] = [];
            for (const a of annotations) {
                const asnDetails = Array.isArray(a.asnDetails)
                    ? a.asnDetails
                    : Array.isArray(a.asnsDetails)
                        ? a.asnsDetails
                        : [];
                const asnValue = a.asn ?? a.asns?.[0] ?? asnDetails[0]?.asn;
                const locationValue = normalizeCloudflareLocations(a);
                records.push({
                    id: `cf-${a.id || a.annotationId || records.length}`,
                    startDate: a.startDate || a.start || a.dateStart || '',
                    endDate: a.endDate || a.end || a.dateEnd || '',
                    scope: a.scope || a.outage?.scope || '',
                    asn: parseInt(asnValue, 10) || 0,
                    asnName: a.asnName || a.asName || asnDetails[0]?.name || '',
                    locations: locationValue.map((location) => location.code),
                    locationNames: locationValue.map((location) => location.name || location.code),
                    outageType: a.outageType || a.type || a.outage?.type || '',
                    outageCause: a.outageCause || a.cause || a.outage?.cause || '',
                    url: a.url || a.link || a.outage?.url || null,
                    description: a.description || a.outage?.description || a.summary || null,
                });
            }

            this.outages = records;
            this.health = malformedPage ? 'error' : 'streaming';
            this.lastError = malformedPage
                ? 'Malformed page in Cloudflare outage pagination'
                : hitPageLimit
                    ? `Pagination cap hit at ${rawPages.length} pages`
                    : null;
            await this.persistence?.persistCloudflareOutages(records, {
                rawPayload: rawPages,
                metadata: ingestMetadata,
                rawPayloadMetadata: ingestMetadata,
            });
            console.log(`[Cloudflare] ${records.length} internet outage annotations loaded (${annotations.length} raw across ${rawPages.length} pages)`);
        } catch (err: any) {
            const body = err.response?.data;
            const detail = body ? JSON.stringify(body) : err.message;
            console.error('[Cloudflare] Fetch failed:', detail);
            this.health = 'error';
            this.lastError = detail;
        }
    }
}

function normalizeCloudflareLocations(annotation: any): Array<{ code: string; name?: string }> {
    const rawLocations = Array.isArray(annotation?.locations)
        ? annotation.locations
        : annotation?.locations
            ? [annotation.locations]
            : annotation?.location
                ? [annotation.location]
                : [];
    const rawNames = Array.isArray(annotation?.locationNames)
        ? annotation.locationNames
        : annotation?.locationName
            ? [annotation.locationName]
            : [];
    const values = rawLocations.length > 0 ? rawLocations : rawNames;
    return values
        .map((entry: any, index: number) => {
            const code = String(
                entry?.alpha2
                || entry?.code
                || entry?.countryCode
                || entry?.isoCode
                || entry?.name
                || entry
                || '',
            ).trim().toUpperCase();
            const name = String(
                entry?.name
                || entry?.countryName
                || rawNames[index]
                || code
                || '',
            ).trim();
            return code ? { code, name: name || code } : null;
        })
        .filter((entry: { code: string; name?: string } | null): entry is { code: string; name?: string } => Boolean(entry));
}
