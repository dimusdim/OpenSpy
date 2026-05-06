import axios from 'axios';
import { SourcePersistenceService } from './source-persistence.service';
import { retryWithBackoff } from './http-retry';

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
    timestamp?: number | null;
    event_id_cnty?: string | null;
    data_id?: string | null;
}

export interface AcledDeletedEvent {
    id: string;
    deletedTimestamp: number;
    deletedAt: string;
    reason: 'deleted_endpoint' | 'event_type_out_of_scope';
}

type AcledAuthMode = 'oauth' | 'legacy-key';

export class ACLEDService {
    private events: ConflictEvent[] = [];
    private timer: NodeJS.Timeout | null = null;
    private health: 'streaming' | 'error' | 'auth-missing' = 'streaming';
    private lastError: string | null = null;
    private lastSuccessfulTimestampSec: number | null = null;
    private lastCompleteness: 'complete' | 'incomplete' | 'unavailable' = 'unavailable';
    private accessToken: string | null = null;
    private accessTokenExpiresAtMs = 0;

    constructor(private readonly persistence?: SourcePersistenceService) {}

    start() {
        if (!this.getAuthMode()) {
            console.warn('[ACLED] credentials not configured, skipping');
            this.health = 'auth-missing';
            this.lastError = 'Set ACLED_EMAIL plus ACLED_KEY for legacy key access, or explicitly set ACLED_AUTH_MODE=oauth / ACLED_ENABLE_PASSWORD_OAUTH=true with ACLED_EMAIL plus ACLED_PASSWORD';
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
        return {
            status: this.health,
            note: this.lastError || undefined,
            count: this.events.length,
            completeness: this.lastCompleteness,
            cursorTimestampSec: this.lastSuccessfulTimestampSec,
            auth: this.getAuthDiagnostic(),
        };
    }

    private async fetchEvents() {
        if (!this.getAuthMode()) return;

        try {
            const now = new Date();
            const nowTimestampSec = Math.floor(now.getTime() / 1000);
            const eventTypes = (process.env.ACLED_EVENT_TYPES || 'Battles|Explosions/Remote violence|Violence against civilians')
                .split('|')
                .map((value) => value.trim())
                .filter(Boolean);
            const eventTypeSet = new Set(eventTypes);
            const pageSize = Number.parseInt(process.env.ACLED_PAGE_SIZE || '5000', 10);
            const maxPages = Number.parseInt(process.env.ACLED_MAX_PAGES || '100', 10);
            const bootstrapLookbackDays = Math.max(1, Number.parseInt(process.env.ACLED_BOOTSTRAP_LOOKBACK_DAYS || '7', 10) || 7);
            const overlapHours = Math.max(0, Number.parseFloat(process.env.ACLED_INCREMENTAL_OVERLAP_HOURS || '6') || 6);
            const effectivePageSize = Number.isFinite(pageSize) && pageSize > 0 ? pageSize : 5000;
            const effectiveMaxPages = Number.isFinite(maxPages) && maxPages > 0 ? maxPages : 100;
            const overlapSec = Math.round(overlapHours * 60 * 60);
            const persistedCursor = await this.persistence?.getLatestEventPropertyNumber('conflict', 'acled', 'acledTimestamp');
            const bootstrapCursor = nowTimestampSec - bootstrapLookbackDays * 24 * 60 * 60;
            const selectedCursor = this.lastSuccessfulTimestampSec
                ?? (Number.isFinite(persistedCursor || NaN) ? Number(persistedCursor) : null)
                ?? bootstrapCursor;
            const cursorTimestampSec = Math.max(
                0,
                Math.floor(selectedCursor),
            );
            const startTimestampSec = Math.max(0, cursorTimestampSec - overlapSec);
            const startUpdatedAt = new Date(startTimestampSec * 1000).toISOString();
            const rawPages: unknown[] = [];
            const rawDeletedPages: unknown[] = [];
            const entries: any[] = [];
            const deletedEntries: any[] = [];
            let hitPageLimit = false;
            let malformedPage = false;
            let deletedHitPageLimit = false;
            let deletedMalformedPage = false;

            for (let page = 1; page <= effectiveMaxPages; page += 1) {
                const params = new URLSearchParams({
                    limit: String(effectivePageSize),
                    timestamp: String(startTimestampSec),
                    timestamp_where: '>=',
                    page: String(page),
                });
                const res = await retryWithBackoff(() => this.requestReadEndpoint('acled/read', params), {
                    label: 'ACLED',
                    maxAttempts: 3,
                    baseDelayMs: 1000,
                    maxDelayMs: 10000,
                });
                rawPages.push(res.data);

                if (!Array.isArray(res.data?.data)) {
                    console.warn(`[ACLED] Unexpected response shape on page ${page}`);
                    malformedPage = true;
                    break;
                }

                entries.push(...res.data.data);
                if (res.data.data.length < effectivePageSize) break;
                if (page === effectiveMaxPages) hitPageLimit = true;
            }

            for (let page = 1; page <= effectiveMaxPages; page += 1) {
                const params = new URLSearchParams({
                    limit: String(effectivePageSize),
                    deleted_timestamp: String(startTimestampSec),
                    deleted_timestamp_where: '>=',
                    page: String(page),
                });
                const res = await retryWithBackoff(() => this.requestReadEndpoint('deleted/read', params), {
                    label: 'ACLED deleted',
                    maxAttempts: 3,
                    baseDelayMs: 1000,
                    maxDelayMs: 10000,
                });
                rawDeletedPages.push(res.data);

                if (!Array.isArray(res.data?.data)) {
                    console.warn(`[ACLED] Unexpected deleted response shape on page ${page}`);
                    deletedMalformedPage = true;
                    break;
                }

                deletedEntries.push(...res.data.data);
                if (res.data.data.length < effectivePageSize) break;
                if (page === effectiveMaxPages) deletedHitPageLimit = true;
            }

            const completeness = hitPageLimit || malformedPage || deletedHitPageLimit || deletedMalformedPage
                ? 'incomplete'
                : 'complete';
            const ingestMetadata = {
                deliveryMode: 'incremental',
                cursorField: 'timestamp',
                sourceWindow: {
                    startTimestampSec,
                    startUpdatedAt,
                    fetchedAt: now.toISOString(),
                    bootstrapLookbackDays,
                    overlapHours,
                    cursorTimestampSec,
                    persistedCursorTimestampSec: persistedCursor ?? null,
                },
                filters: {
                    event_type: eventTypes.join('|'),
                    eventTypeFilterLocation: 'local_after_timestamp_fetch',
                },
                pagination: {
                    pageSize: effectivePageSize,
                    maxPages: effectiveMaxPages,
                    fetchedPages: rawPages.length,
                    rawEntryCount: entries.length,
                    hitPageLimit,
                    malformedPage,
                    deletedFetchedPages: rawDeletedPages.length,
                    deletedRawEntryCount: deletedEntries.length,
                    deletedHitPageLimit,
                    deletedMalformedPage,
                    incomplete: completeness === 'incomplete',
                },
                completeness,
            };

            if (hitPageLimit) {
                console.warn(
                    `[ACLED] hit pagination cap (${effectiveMaxPages} x ${effectivePageSize} = ${effectiveMaxPages * effectivePageSize} events); incremental conflict events are incomplete`,
                );
            }
            if (deletedHitPageLimit) {
                console.warn(
                    `[ACLED] hit deleted pagination cap (${effectiveMaxPages} x ${effectivePageSize} = ${effectiveMaxPages * effectivePageSize} events); deleted conflict events are incomplete`,
                );
            }
            if (malformedPage && entries.length === 0) {
                this.health = 'error';
                this.lastError = 'Unexpected ACLED response shape';
                return;
            }
            if (deletedMalformedPage && deletedEntries.length === 0) {
                this.health = 'error';
                this.lastError = 'Unexpected ACLED deleted response shape';
                return;
            }

            const records: ConflictEvent[] = [];
            const deletedRecords: AcledDeletedEvent[] = [];
            let maxTimestampSec = cursorTimestampSec;
            for (const ev of entries) {
                const timestamp = parseAcledTimestamp(ev.timestamp);
                if (timestamp != null) maxTimestampSec = Math.max(maxTimestampSec, timestamp);
                const id = acledEventId(ev, records.length);
                if (!eventTypeSet.has(String(ev.event_type || ''))) {
                    if (id) {
                        deletedRecords.push({
                            id,
                            deletedTimestamp: timestamp ?? nowTimestampSec,
                            deletedAt: new Date((timestamp ?? nowTimestampSec) * 1000).toISOString(),
                            reason: 'event_type_out_of_scope',
                        });
                    }
                    continue;
                }
                const lat = parseFloat(ev.latitude);
                const lng = parseFloat(ev.longitude);
                if (isNaN(lat) || isNaN(lng)) continue;

                records.push({
                    id,
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
                    timestamp,
                    event_id_cnty: ev.event_id_cnty || null,
                    data_id: ev.data_id != null ? String(ev.data_id) : null,
                });
            }
            for (const ev of deletedEntries) {
                const deletedTimestamp = parseAcledTimestamp(ev.deleted_timestamp);
                if (deletedTimestamp != null) maxTimestampSec = Math.max(maxTimestampSec, deletedTimestamp);
                const id = acledDeletedEventId(ev);
                if (!id || deletedTimestamp == null) continue;
                deletedRecords.push({
                    id,
                    deletedTimestamp,
                    deletedAt: new Date(deletedTimestamp * 1000).toISOString(),
                    reason: 'deleted_endpoint',
                });
            }

            this.events = records;
            this.health = malformedPage || deletedMalformedPage ? 'error' : 'streaming';
            this.lastCompleteness = completeness;
            this.lastError = malformedPage || deletedMalformedPage
                ? 'Malformed page in ACLED pagination'
                : hitPageLimit || deletedHitPageLimit
                    ? `Pagination cap hit: events=${rawPages.length} pages, deleted=${rawDeletedPages.length} pages`
                    : null;
            const finalMetadata = {
                ...ingestMetadata,
                normalized: {
                    conflictRecords: records.length,
                    deletedRecords: deletedRecords.filter((entry) => entry.reason === 'deleted_endpoint').length,
                    outOfScopeUpdates: deletedRecords.filter((entry) => entry.reason === 'event_type_out_of_scope').length,
                    maxTimestampSec,
                },
            };
            await this.persistence?.persistAcledConflicts(records, {
                rawPayload: { events: rawPages, deleted: rawDeletedPages },
                metadata: finalMetadata,
                rawPayloadMetadata: finalMetadata,
                deletedRecords,
            });
            if (completeness === 'complete') {
                this.lastSuccessfulTimestampSec = Math.max(maxTimestampSec, nowTimestampSec);
            }
            const battles = records.filter(e => e.event_type === 'Battles').length;
            const explosions = records.filter(e => e.event_type.includes('Explosions')).length;
            const violence = records.filter(e => e.event_type.includes('Violence')).length;
            console.log(`[ACLED] ${records.length} conflict events (${battles} battles, ${explosions} explosions, ${violence} violence; ${deletedRecords.length} removals; ${entries.length} raw + ${deletedEntries.length} deleted raw since ${startUpdatedAt})`);
        } catch (err: any) {
            console.error('[ACLED] Fetch failed:', err.message);
            this.health = 'error';
            this.lastError = err.message;
        }
    }

    private getAuthDiagnostic() {
        const mode = (process.env.ACLED_AUTH_MODE || '').trim().toLowerCase();
        const email = Boolean(process.env.ACLED_EMAIL);
        const password = Boolean(process.env.ACLED_PASSWORD);
        const key = Boolean(process.env.ACLED_KEY);
        const passwordOauthEnabled = process.env.ACLED_ENABLE_PASSWORD_OAUTH === 'true';
        const requestedMode = mode === 'oauth' || mode === 'legacy-key' ? mode : null;
        let effectiveMode: AcledAuthMode | null = null;
        if (mode === 'oauth' && email && password) effectiveMode = 'oauth';
        else if (mode === 'legacy-key' && email && key) effectiveMode = 'legacy-key';
        else if (!requestedMode && email && key) effectiveMode = 'legacy-key';
        else if (!requestedMode && email && password && passwordOauthEnabled) effectiveMode = 'oauth';

        const missing = effectiveMode
            ? []
            : mode === 'oauth'
                ? ['ACLED_EMAIL', 'ACLED_PASSWORD'].filter((name) => (name === 'ACLED_EMAIL' ? !email : !password))
                : mode === 'legacy-key'
                    ? ['ACLED_EMAIL', 'ACLED_KEY'].filter((name) => (name === 'ACLED_EMAIL' ? !email : !key))
                    : email
                        ? (key ? [] : password && !passwordOauthEnabled ? ['ACLED_KEY or ACLED_ENABLE_PASSWORD_OAUTH=true'] : ['ACLED_KEY'])
                        : ['ACLED_EMAIL', 'ACLED_KEY'];

        return {
            configured: Boolean(effectiveMode),
            requestedMode,
            effectiveMode,
            passwordOauthEnabled,
            present: {
                ACLED_EMAIL: email,
                ACLED_KEY: key,
                ACLED_PASSWORD: password,
            },
            missing,
        };
    }

    private getAuthMode(): AcledAuthMode | null {
        return this.getAuthDiagnostic().effectiveMode;
    }

    private async requestReadEndpoint(endpoint: 'acled/read' | 'deleted/read', params: URLSearchParams) {
        const authMode = this.getAuthMode();
        if (authMode === 'oauth') {
            const token = await this.getAccessToken();
            const baseUrl = (process.env.ACLED_API_BASE_URL || 'https://acleddata.com/api').replace(/\/+$/, '');
            const url = `${baseUrl}/${endpoint}?${params.toString()}`;
            return axios.get(url, {
                timeout: 30000,
                headers: { Authorization: `Bearer ${token}` },
            });
        }

        if (authMode === 'legacy-key') {
            const legacyParams = new URLSearchParams(params);
            legacyParams.set('key', process.env.ACLED_KEY || '');
            legacyParams.set('email', process.env.ACLED_EMAIL || '');
            const baseUrl = (process.env.ACLED_LEGACY_API_BASE_URL || 'https://api.acleddata.com').replace(/\/+$/, '');
            const url = `${baseUrl}/${endpoint}?${legacyParams.toString()}`;
            return axios.get(url, { timeout: 30000 });
        }

        throw new Error('ACLED credentials not configured');
    }

    private async getAccessToken(): Promise<string> {
        const now = Date.now();
        if (this.accessToken && this.accessTokenExpiresAtMs - now > 60_000) return this.accessToken;

        const email = process.env.ACLED_EMAIL;
        const password = process.env.ACLED_PASSWORD;
        if (!email || !password) throw new Error('ACLED OAuth requires ACLED_EMAIL and ACLED_PASSWORD');

        const tokenUrl = process.env.ACLED_TOKEN_URL || 'https://acleddata.com/oauth/token';
        const clientId = process.env.ACLED_CLIENT_ID || 'acled';
        const body = new URLSearchParams({
            username: email,
            password,
            grant_type: 'password',
            client_id: clientId,
        });

        const res = await axios.post(tokenUrl, body.toString(), {
            timeout: 30000,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });
        const token = res.data?.access_token;
        if (!token || typeof token !== 'string') throw new Error('ACLED OAuth did not return an access_token');
        const expiresInSec = Number(res.data?.expires_in || 86400);
        this.accessToken = token;
        this.accessTokenExpiresAtMs = now + Math.max(60, expiresInSec) * 1000;
        return token;
    }
}

function parseAcledTimestamp(value: unknown): number | null {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return null;
    return Math.floor(parsed);
}

function acledEventId(event: any, fallbackIndex: number): string {
    return `acled-${event?.event_id_cnty || event?.data_id || fallbackIndex}`;
}

function acledDeletedEventId(event: any): string | null {
    const id = event?.event_id_cnty || event?.data_id;
    return id ? `acled-${id}` : null;
}
