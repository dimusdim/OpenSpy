import axios from 'axios';
import { SourcePersistenceService } from './source-persistence.service';
import { retryWithBackoff } from './http-retry';

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
    private lastSourceWindow: Record<string, unknown> | null = null;
    private lastPagination: Record<string, unknown> | null = null;

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
        return {
            status: this.health,
            note: this.lastError || undefined,
            count: this.events.length,
            sourceWindow: this.lastSourceWindow || undefined,
            pagination: this.lastPagination || undefined,
            truncated: Boolean(this.lastPagination?.truncated),
        };
    }

    private positiveIntFromEnv(name: string, fallback: number): number {
        const value = Number.parseInt(process.env[name] || '', 10);
        return Number.isFinite(value) && value > 0 ? value : fallback;
    }

    private async resolveFetchWindow(now: Date): Promise<{
        startDate: string;
        endDate: string;
        latestObservedAt: string | null;
        bootstrap: boolean;
        overlapHours: number;
        windowDays: number;
    }> {
        const bootstrapDays = this.positiveIntFromEnv('GFW_BOOTSTRAP_LOOKBACK_DAYS', 3);
        const maxWindowDays = this.positiveIntFromEnv('GFW_MAX_WINDOW_DAYS', 7);
        const overlapHours = this.positiveIntFromEnv('GFW_INCREMENTAL_OVERLAP_HOURS', 6);
        const latestObservedAt = await this.persistence?.getLatestEventObservedAt('gfw', 'gfw') || null;
        const latestMs = latestObservedAt ? new Date(latestObservedAt).getTime() : Number.NaN;
        const fallbackStartMs = now.getTime() - bootstrapDays * 24 * 60 * 60 * 1000;
        const incrementalStartMs = Number.isFinite(latestMs)
            ? latestMs - overlapHours * 60 * 60 * 1000
            : fallbackStartMs;
        const earliestAllowedMs = now.getTime() - maxWindowDays * 24 * 60 * 60 * 1000;
        const startMs = Math.max(earliestAllowedMs, incrementalStartMs);
        const start = new Date(startMs);
        return {
            startDate: start.toISOString().slice(0, 10),
            endDate: now.toISOString().slice(0, 10),
            latestObservedAt,
            bootstrap: !Number.isFinite(latestMs),
            overlapHours,
            windowDays: Math.max(1, Math.ceil((now.getTime() - start.getTime()) / (24 * 60 * 60 * 1000))),
        };
    }

    async fetchEventsWindow(input: { startDate?: string; endDate?: string; persist?: boolean } = {}): Promise<{
        records: GFWEvent[];
        rawCount: number;
        rawPages: number;
        metadata: Record<string, any>;
    }> {
        const token = process.env.GFW_TOKEN;
        if (!token) throw new Error('GFW_TOKEN is required for Global Fishing Watch source fetch');

        try {
            const window = input.startDate && input.endDate
                ? {
                    startDate: input.startDate,
                    endDate: input.endDate,
                    latestObservedAt: null,
                    bootstrap: false,
                    overlapHours: 0,
                    windowDays: Math.max(1, Math.ceil((new Date(input.endDate).getTime() - new Date(input.startDate).getTime()) / (24 * 60 * 60 * 1000))),
                }
                : await this.resolveFetchWindow(new Date());
            const { startDate, endDate } = window;

            // Paginate through all pages. The v3 API caps a single call
            // at 100 events — without pagination we only see the most
            // recent slice and older events silently drop off.
            const pageSize = Number.parseInt(process.env.GFW_PAGE_SIZE || '100', 10);
            const maxPages = Number.parseInt(process.env.GFW_MAX_PAGES || '100', 10);
            const effectivePageSize = Number.isFinite(pageSize) && pageSize > 0 ? pageSize : 100;
            const effectiveMaxPages = Number.isFinite(maxPages) && maxPages > 0 ? maxPages : 100;
            const entries: any[] = [];
            const rawPages: unknown[] = [];
            let hitPageLimit = false;
            let malformedPage = false;
            for (let page = 0; page < effectiveMaxPages; page += 1) {
                const offset = page * effectivePageSize;
                const params = new URLSearchParams({
                    'datasets[0]': 'public-global-gaps-events:latest',
                    limit: String(effectivePageSize),
                    offset: String(offset),
                    'start-date': startDate,
                    'end-date': endDate,
                    sort: '-start',
                });
                const url = `https://gateway.api.globalfishingwatch.org/v3/events?${params.toString()}`;
                const res = await retryWithBackoff(() => axios.get(url, {
                    timeout: 30000,
                    headers: { 'Authorization': `Bearer ${token}` },
                }), { label: 'GFW', maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 10000 });
                rawPages.push(res.data);
                const pageEntries = res.data?.entries || res.data;
                if (!Array.isArray(pageEntries)) {
                    console.warn(`[GFW] Malformed response on page ${page} (offset=${offset}); aborting pagination`);
                    malformedPage = true;
                    break;
                }
                if (pageEntries.length === 0) break;
                entries.push(...pageEntries);
                if (pageEntries.length < effectivePageSize) break;
                if (page === effectiveMaxPages - 1) hitPageLimit = true;
            }
            const ingestMetadata = {
                sourceWindow: {
                    startDate,
                    endDate,
                    days: window.windowDays,
                    mode: window.bootstrap ? 'bootstrap' : 'incremental',
                    latestObservedAt: window.latestObservedAt,
                    overlapHours: window.overlapHours,
                },
                pagination: {
                    pageSize: effectivePageSize,
                    maxPages: effectiveMaxPages,
                    fetchedPages: rawPages.length,
                    rawEntryCount: entries.length,
                    hitPageLimit,
                    malformedPage,
                    truncated: hitPageLimit || malformedPage,
                },
            };
            this.lastSourceWindow = ingestMetadata.sourceWindow;
            this.lastPagination = ingestMetadata.pagination;
            if (hitPageLimit) {
                console.warn(
                    `[GFW] hit pagination cap (${effectiveMaxPages} x ${effectivePageSize} = ${effectiveMaxPages * effectivePageSize} events) for ${startDate}..${endDate}; narrow GFW_MAX_WINDOW_DAYS/GFW_BOOTSTRAP_LOOKBACK_DAYS or raise GFW_MAX_PAGES`,
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
            this.lastError = malformedPage
                ? 'Malformed page in GFW pagination'
                : hitPageLimit
                    ? `Pagination cap hit at ${rawPages.length} pages`
                    : null;
            if (input.persist !== false) {
                await this.persistence?.persistGfwEvents(records, {
                    rawPayload: rawPages,
                    metadata: ingestMetadata,
                    rawPayloadMetadata: ingestMetadata,
                });
            }
            console.log(`[GFW] ${records.length} AIS gap events loaded (${entries.length} raw across ${rawPages.length} pages)`);
            return {
                records,
                rawCount: entries.length,
                rawPages: rawPages.length,
                metadata: ingestMetadata,
            };
        } catch (err: any) {
            const body = err.response?.data;
            const detail = body ? JSON.stringify(body) : err.message;
            console.error('[GFW] Fetch failed:', detail);
            this.health = 'error';
            this.lastError = detail;
            throw err;
        }
    }

    private async fetchEvents() {
        try {
            await this.fetchEventsWindow();
        } catch {
            // fetchEventsWindow already updates health and logs provider details.
        }
    }
}
