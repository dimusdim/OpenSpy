import axios from 'axios';
import crypto from 'crypto';
import { DatabaseService } from '../db/database.service';

type WifiSecurity = 'open' | 'encrypted' | 'unknown';
type WifiHealthStatus = 'streaming' | 'auth-missing' | 'error' | 'rate-limited' | 'disabled';
type WifiTileStatus = 'pending' | 'fetching' | 'partial' | 'complete' | 'rate_limited' | 'error';

export interface WifiRenderRecord {
    id: string;
    lat: number;
    lng: number;
    security: WifiSecurity;
    lastSeen: string | null;
    source: 'WiGLE';
}

export interface WifiDetailsRecord extends WifiRenderRecord {
    layerId: 'wifi';
    featureKind: 'observation';
    name: string;
    ssid: string;
    bssidMasked: string;
    channel: number | null;
    encryption: string;
    networkType: string | null;
    firstSeen: string | null;
    providerUpdatedAt: string | null;
    quality: number | null;
    properties: Record<string, any>;
}

type WigleSearchResult = Record<string, any>;

type WifiBboxPayload = {
    data: WifiRenderRecord[];
    totalResults: number | null;
    fetchedCount: number;
    complete: boolean;
    truncated: boolean;
    source: 'wigle';
    cached: boolean;
    elapsedMs: number;
    completeness: {
        status: WifiTileStatus;
        fetchedCount: number;
        totalResults: number | null;
        pageCount: number;
        nextFetchAfter: string | null;
        note?: string;
    };
};

type WifiTileState = {
    tileKey: string;
    status: WifiTileStatus;
    totalResults: number | null;
    fetchedCount: number;
    pageCount: number;
    nextSearchAfter: string | null;
    lastFetchAt: string | null;
    lastError: string | null;
    nextFetchAfter: string | null;
    complete: boolean;
};

type TileBbox = {
    south: number;
    west: number;
    north: number;
    east: number;
};

function finiteNumber(value: unknown): number | null {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

function isoOrNull(value: unknown): string | null {
    if (!value) return null;
    const date = new Date(String(value));
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function normalizeSecurity(record: WigleSearchResult): WifiSecurity {
    const encryption = String(record.encryption ?? record.encryptionType ?? record.wep ?? '').toLowerCase();
    const type = String(record.type ?? '').toLowerCase();
    if (record.freenet === true || encryption === 'none' || encryption === 'open' || type === 'open') return 'open';
    if (encryption.includes('wpa') || encryption.includes('wep') || encryption.includes('psk') || encryption.includes('encrypted')) return 'encrypted';
    if (record.wep === true || record.wep === 'Y') return 'encrypted';
    return 'unknown';
}

function normalizeWifiId(record: WigleSearchResult): string | null {
    const netid = String(record.netid ?? record.bssid ?? record.mac ?? '').trim().toLowerCase();
    if (!netid) return null;
    const hash = crypto.createHash('sha1').update(`wigle|${netid}`).digest('hex').slice(0, 24);
    return `wifi:${hash}`;
}

function maskBssid(value: unknown): string {
    const text = String(value ?? '').trim();
    if (!text) return '';
    const parts = text.split(':');
    if (parts.length === 6) return `${parts[0]}:${parts[1]}:**:**:**:${parts[5]}`.toLowerCase();
    if (text.length <= 6) return '*'.repeat(text.length);
    return `${text.slice(0, 4)}...${text.slice(-2)}`;
}

function normalizeSsid(value: unknown): string {
    const text = String(value ?? '').trim();
    return text || 'Hidden Wi-Fi Network';
}

function contentHash(value: unknown): string {
    return crypto.createHash('sha1').update(JSON.stringify(value)).digest('hex');
}

function intEnv(name: string, fallback: number, min = 1): number {
    const value = Number(process.env[name]);
    return Number.isFinite(value) ? Math.max(min, Math.floor(value)) : fallback;
}

function dateOrNull(value: unknown): string | null {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(String(value));
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export class WigleService {
    private readonly details = new Map<string, WifiDetailsRecord>();
    private readonly inFlightTiles = new Set<string>();
    private readonly scheduledTiles = new Set<string>();
    private providerQueue: Promise<void> = Promise.resolve();
    private health: { status: WifiHealthStatus; note?: string; count?: number } = { status: 'auth-missing', note: 'WIGLE_API_NAME/WIGLE_API_TOKEN not configured', count: 0 };

    constructor(private readonly database: DatabaseService) {}

    isEnabled(): boolean {
        return process.env.WIGLE_ENABLED !== 'false';
    }

    isConfigured(): boolean {
        return Boolean(process.env.WIGLE_API_NAME && process.env.WIGLE_API_TOKEN);
    }

    getHealth(): { status: WifiHealthStatus; note?: string; count?: number } {
        if (!this.isEnabled()) return { status: 'disabled', note: 'WiGLE provider disabled', count: 0 };
        if (!this.isConfigured()) return { status: 'auth-missing', note: 'WIGLE_API_NAME/WIGLE_API_TOKEN not configured', count: 0 };
        if (this.health.status === 'auth-missing') return { status: 'streaming', note: 'Configured; waiting for Wi-Fi viewport', count: 0 };
        return this.health;
    }

    async searchBbox(south: number, west: number, north: number, east: number): Promise<WifiBboxPayload> {
        if (!this.isEnabled()) {
            const err = new Error('WiGLE provider is disabled');
            (err as any).status = 503;
            throw err;
        }
        if (!this.isConfigured()) {
            const err = new Error('WIGLE_API_NAME/WIGLE_API_TOKEN not configured');
            (err as any).status = 503;
            throw err;
        }
        if (!this.database.isReady()) {
            const err = new Error('Database is not ready for persisted Wi-Fi tile cache');
            (err as any).status = 503;
            throw err;
        }

        const bbox = { south, west, north, east };
        const tileKey = this.tileKey(bbox);
        const startedAt = Date.now();
        await this.ensureTileState(tileKey, bbox);

        let state = await this.getTileState(tileKey);
        let fetchedUpstream = false;
        if (this.shouldFetchTile(state)) {
            state = await this.fetchTilePages(tileKey, bbox, {
                maxPages: intEnv('WIGLE_INTERACTIVE_PAGES_PER_REQUEST', 1),
            });
            fetchedUpstream = true;
        }

        state = await this.getTileState(tileKey);
        if (state && !state.complete && state.status !== 'rate_limited' && state.status !== 'fetching') {
            this.scheduleTileFetch(tileKey, bbox, intEnv('WIGLE_BACKGROUND_RUN_DELAY_MS', 1000));
        }

        const render = await this.listRenderRecords(bbox);
        const fetchedCount = state?.fetchedCount ?? render.length;
        const complete = Boolean(state?.complete);
        const payload: WifiBboxPayload = {
            data: render,
            totalResults: state?.totalResults ?? null,
            fetchedCount,
            complete,
            truncated: !complete,
            source: 'wigle',
            cached: !fetchedUpstream,
            elapsedMs: Date.now() - startedAt,
            completeness: {
                status: state?.status ?? 'pending',
                fetchedCount,
                totalResults: state?.totalResults ?? null,
                pageCount: state?.pageCount ?? 0,
                nextFetchAfter: state?.nextFetchAfter ?? null,
                note: this.tileNote(state, render.length),
            },
        };
        this.health = {
            status: state?.status === 'rate_limited' ? 'rate-limited' : state?.status === 'error' ? 'error' : 'streaming',
            note: payload.completeness.note,
            count: render.length,
        };
        return payload;
    }

    async getWifiDetails(id: string): Promise<WifiDetailsRecord | null> {
        const cached = this.details.get(id);
        if (cached) return cached;
        if (!this.database.isReady()) return null;
        const result = await this.database.query<{
            wifi_id: string;
            ssid: string | null;
            bssid_masked: string | null;
            lat: number;
            lng: number;
            security: WifiSecurity;
            encryption: string | null;
            channel: number | null;
            network_type: string | null;
            first_seen: Date | string | null;
            last_seen: Date | string | null;
            provider_updated_at: Date | string | null;
            quality: number | null;
            properties: Record<string, any>;
        }>(
            `
                SELECT wifi_id, ssid, bssid_masked, lat, lng, security, encryption,
                       channel, network_type, first_seen, last_seen, provider_updated_at,
                       quality, properties
                FROM app.wifi_observations
                WHERE wifi_id = $1
                LIMIT 1
            `,
            [id],
        );
        const row = result?.rows?.[0];
        if (!row) return null;
        return {
            id: row.wifi_id,
            layerId: 'wifi',
            featureKind: 'observation',
            name: row.ssid || 'Hidden Wi-Fi Network',
            ssid: row.ssid || 'Hidden Wi-Fi Network',
            bssidMasked: row.bssid_masked || '',
            lat: Number(row.lat),
            lng: Number(row.lng),
            security: row.security || 'unknown',
            encryption: row.encryption || '',
            channel: row.channel == null ? null : Number(row.channel),
            networkType: row.network_type || null,
            firstSeen: isoOrNull(row.first_seen),
            lastSeen: isoOrNull(row.last_seen),
            providerUpdatedAt: isoOrNull(row.provider_updated_at),
            quality: row.quality == null ? null : Number(row.quality),
            source: 'WiGLE',
            properties: row.properties || {},
        };
    }

    private tileKey(bbox: TileBbox): string {
        return [
            bbox.south.toFixed(6),
            bbox.west.toFixed(6),
            bbox.north.toFixed(6),
            bbox.east.toFixed(6),
        ].join(',');
    }

    private shouldFetchTile(state: WifiTileState | null): boolean {
        if (!state) return true;
        if (state.status === 'fetching') {
            if (this.inFlightTiles.has(state.tileKey)) return false;
            if (!state.nextFetchAfter) return true;
            return Date.now() >= Date.parse(state.nextFetchAfter);
        }
        if (state.complete) return this.isTileStale(state);
        if (!state.nextFetchAfter) return true;
        return Date.now() >= Date.parse(state.nextFetchAfter);
    }

    private isTileStale(state: WifiTileState): boolean {
        if (!state.complete) return false;
        if (!state.lastFetchAt) return true;
        const ageMs = Date.now() - Date.parse(state.lastFetchAt);
        return ageMs >= intEnv('WIGLE_TILE_REFRESH_MS', 43_200_000, 60_000);
    }

    private tileNote(state: WifiTileState | null, renderCount: number): string {
        if (!state) return `WiGLE tile pending; cached ${renderCount} records`;
        if (state.complete) return `WiGLE tile complete: ${renderCount}/${state.totalResults ?? renderCount} records`;
        if (state.status === 'rate_limited') return `WiGLE rate-limited; cached ${renderCount}/${state.totalResults ?? 'unknown'} records`;
        if (state.status === 'error') return `WiGLE tile error; cached ${renderCount}/${state.totalResults ?? 'unknown'} records${state.lastError ? ` (${state.lastError})` : ''}`;
        return `WiGLE tile loading; cached ${renderCount}/${state.totalResults ?? 'unknown'} records`;
    }

    private async ensureTileState(tileKey: string, bbox: TileBbox): Promise<void> {
        await this.database.query(
            `
                INSERT INTO app.wifi_viewport_tiles (
                    tile_key, source_id, south, west, north, east, status,
                    fetched_count, page_count, created_at, updated_at
                )
                VALUES ($1, 'wigle', $2, $3, $4, $5, 'pending', 0, 0, now(), now())
                ON CONFLICT (tile_key) DO UPDATE SET
                    south = EXCLUDED.south,
                    west = EXCLUDED.west,
                    north = EXCLUDED.north,
                    east = EXCLUDED.east,
                    updated_at = app.wifi_viewport_tiles.updated_at
            `,
            [tileKey, bbox.south, bbox.west, bbox.north, bbox.east],
        );
    }

    private async getTileState(tileKey: string): Promise<WifiTileState | null> {
        const result = await this.database.query<{
            tile_key: string;
            status: WifiTileStatus;
            total_results: number | null;
            fetched_count: number | null;
            page_count: number | null;
            next_search_after: string | null;
            last_fetch_at: Date | string | null;
            last_error: string | null;
            next_fetch_after: Date | string | null;
            complete: boolean | null;
        }>(
            `
                SELECT tile_key, status, total_results, fetched_count, page_count,
                       next_search_after, last_fetch_at, last_error, next_fetch_after,
                       (status = 'complete') AS complete
                FROM app.wifi_viewport_tiles
                WHERE tile_key = $1
                LIMIT 1
            `,
            [tileKey],
        );
        const row = result?.rows?.[0];
        if (!row) return null;
        return {
            tileKey: row.tile_key,
            status: row.status,
            totalResults: row.total_results == null ? null : Number(row.total_results),
            fetchedCount: row.fetched_count == null ? 0 : Number(row.fetched_count),
            pageCount: row.page_count == null ? 0 : Number(row.page_count),
            nextSearchAfter: row.next_search_after || null,
            lastFetchAt: dateOrNull(row.last_fetch_at),
            lastError: row.last_error || null,
            nextFetchAfter: dateOrNull(row.next_fetch_after),
            complete: Boolean(row.complete),
        };
    }

    private async listRenderRecords(bbox: TileBbox): Promise<WifiRenderRecord[]> {
        const result = await this.database.query<{
            wifi_id: string;
            lat: number;
            lng: number;
            security: WifiSecurity;
            last_seen: Date | string | null;
        }>(
            `
                SELECT wifi_id, lat, lng, security, last_seen
                FROM app.wifi_observations
                WHERE lat >= $1 AND lat <= $2
                  AND lng >= $3 AND lng <= $4
                ORDER BY last_seen DESC NULLS LAST, wifi_id
            `,
            [bbox.south, bbox.north, bbox.west, bbox.east],
        );
        return (result?.rows || []).map((row) => ({
            id: row.wifi_id,
            lat: Number(row.lat),
            lng: Number(row.lng),
            security: row.security || 'unknown',
            lastSeen: isoOrNull(row.last_seen),
            source: 'WiGLE',
        }));
    }

    private scheduleTileFetch(tileKey: string, bbox: TileBbox, delayMs: number): void {
        if (this.inFlightTiles.has(tileKey) || this.scheduledTiles.has(tileKey)) return;
        this.scheduledTiles.add(tileKey);
        setTimeout(() => {
            this.scheduledTiles.delete(tileKey);
            this.providerQueue = this.providerQueue
                .catch(() => undefined)
                .then(async () => {
                    const state = await this.getTileState(tileKey);
                    if (!this.shouldFetchTile(state)) {
                        if (state && !state.complete && state.status !== 'rate_limited' && state.status !== 'error' && state.nextFetchAfter) {
                            const retryAtMs = Date.parse(state.nextFetchAfter);
                            if (Number.isFinite(retryAtMs)) {
                                this.scheduleTileFetch(tileKey, bbox, Math.max(1_000, retryAtMs - Date.now() + 250));
                            }
                        }
                        return;
                    }
                    const next = await this.fetchTilePages(tileKey, bbox, {
                        maxPages: intEnv('WIGLE_BACKGROUND_PAGES_PER_RUN', 10),
                    });
                    if (next && !next.complete && next.status !== 'rate_limited' && next.status !== 'error') {
                        this.scheduleTileFetch(tileKey, bbox, intEnv('WIGLE_BACKGROUND_RUN_COOLDOWN_MS', 5_000));
                    }
                });
        }, Math.max(0, delayMs));
    }

    private async fetchTilePages(
        tileKey: string,
        bbox: TileBbox,
        options: { maxPages: number },
    ): Promise<WifiTileState | null> {
        if (this.inFlightTiles.has(tileKey)) return this.getTileState(tileKey);
        this.inFlightTiles.add(tileKey);
        try {
            const before = await this.getTileState(tileKey);
            if (before?.complete && !this.isTileStale(before)) return before;
            if (before?.complete && this.isTileStale(before)) {
                await this.database.query('DELETE FROM app.wifi_observation_tiles WHERE tile_key = $1', [tileKey]);
                await this.database.query(
                    `
                        UPDATE app.wifi_viewport_tiles
                        SET status = 'pending',
                            total_results = NULL,
                            fetched_count = 0,
                            page_count = 0,
                            next_search_after = NULL,
                            next_fetch_after = NULL,
                            last_error = NULL,
                            updated_at = now()
                        WHERE tile_key = $1
                    `,
                    [tileKey],
                );
            }

            await this.database.query(
                `
                    UPDATE app.wifi_viewport_tiles
                    SET status = 'fetching',
                        last_error = NULL,
                        next_fetch_after = now() + ($2::text || ' milliseconds')::interval,
                        updated_at = now()
                    WHERE tile_key = $1
                `,
                [tileKey, intEnv('WIGLE_FETCHING_LOCK_TIMEOUT_MS', 30_000, 5_000)],
            );

            let state = await this.getTileState(tileKey);
            let pagesFetched = 0;
            const pageSize = intEnv('WIGLE_RESULTS_PER_PAGE', 100);
            while (pagesFetched < options.maxPages) {
                state = await this.getTileState(tileKey);
                if (!state || state.complete) break;
                const fetchedBefore = state.fetchedCount;
                const response = await axios.get('https://api.wigle.net/api/v2/network/search', {
                    timeout: Number(process.env.WIGLE_TIMEOUT_MS || 20_000),
                    auth: {
                        username: process.env.WIGLE_API_NAME || '',
                        password: process.env.WIGLE_API_TOKEN || '',
                    },
                    headers: {
                        Accept: 'application/json',
                        'User-Agent': 'openspy/1.0 WiFi viewport layer',
                    },
                    params: {
                        latrange1: bbox.south,
                        latrange2: bbox.north,
                        longrange1: bbox.west,
                        longrange2: bbox.east,
                        resultsPerPage: pageSize,
                        ...(fetchedBefore > 0 ? { first: fetchedBefore } : {}),
                    },
                });

                const body = response.data || {};
                const rawResults = Array.isArray(body.results) ? body.results : [];
                const details: WifiDetailsRecord[] = [];
                for (const raw of rawResults) {
                    const normalized = this.normalizeRecord(raw);
                    if (!normalized) continue;
                    details.push(normalized);
                    this.details.set(normalized.id, normalized);
                }
                await this.persistDetails(details, tileKey);

                const totalResults = Number.isFinite(Number(body.totalResults)) ? Number(body.totalResults) : state.totalResults;
                const nextSearchAfter = body.searchAfter == null ? null : String(body.searchAfter);
                const fetchedCount = await this.countTileObservations(tileKey);
                const addedCount = fetchedCount - fetchedBefore;
                if (rawResults.length > 0 && addedCount <= 0) {
                    await this.database.query(
                        `
                            UPDATE app.wifi_viewport_tiles
                            SET status = 'error',
                                total_results = COALESCE($2, total_results),
                                fetched_count = $3,
                                page_count = page_count + 1,
                                next_search_after = $4,
                                last_fetch_at = now(),
                                next_fetch_after = now() + ($5::text || ' milliseconds')::interval,
                                last_error = $6,
                                updated_at = now()
                            WHERE tile_key = $1
                        `,
                        [
                            tileKey,
                            totalResults,
                            fetchedCount,
                            nextSearchAfter,
                            intEnv('WIGLE_ERROR_COOLDOWN_MS', 15_000),
                            `WiGLE pagination made no progress at first=${fetchedBefore}`,
                        ],
                    );
                    break;
                }
                const complete = rawResults.length === 0 || !nextSearchAfter || (totalResults != null && fetchedCount >= totalResults);
                await this.database.query(
                    `
                        UPDATE app.wifi_viewport_tiles
                        SET status = $2,
                            total_results = COALESCE($3, total_results),
                            fetched_count = $4,
                            page_count = page_count + 1,
                            next_search_after = $5,
                            last_fetch_at = now(),
                            next_fetch_after = CASE WHEN $2 = 'complete' THEN NULL ELSE now() END,
                            last_error = NULL,
                            updated_at = now()
                        WHERE tile_key = $1
                    `,
                    [tileKey, complete ? 'complete' : 'partial', totalResults, fetchedCount, nextSearchAfter],
                );
                pagesFetched += 1;
                if (complete) break;
                const delayMs = intEnv('WIGLE_PAGE_DELAY_MS', 250, 0);
                if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
            }

            state = await this.getTileState(tileKey);
            if (state && !state.complete && state.status !== 'rate_limited' && state.status !== 'error') {
                await this.database.query(
                    `
                        UPDATE app.wifi_viewport_tiles
                        SET status = 'partial',
                            next_fetch_after = now() + ($2::text || ' milliseconds')::interval,
                            updated_at = now()
                        WHERE tile_key = $1
                    `,
                    [tileKey, intEnv('WIGLE_BACKGROUND_RUN_COOLDOWN_MS', 5_000)],
                );
            }
            return this.getTileState(tileKey);
        } catch (error: any) {
            const status = Number(error?.response?.status || 0);
            const isRateLimited = status === 429;
            const cooldownMs = isRateLimited
                ? intEnv('WIGLE_RATE_LIMIT_COOLDOWN_MS', 60_000)
                : intEnv('WIGLE_ERROR_COOLDOWN_MS', 15_000);
            await this.database.query(
                `
                    UPDATE app.wifi_viewport_tiles
                    SET status = $2,
                        last_error = $3,
                        next_fetch_after = now() + ($4::text || ' milliseconds')::interval,
                        updated_at = now()
                    WHERE tile_key = $1
                `,
                [tileKey, isRateLimited ? 'rate_limited' : 'error', error?.message || String(error), cooldownMs],
            );
            this.health = {
                status: isRateLimited ? 'rate-limited' : 'error',
                note: isRateLimited ? 'WiGLE rate limit reached; using cached Wi-Fi tile data' : `WiGLE tile fetch failed: ${error?.message || error}`,
            };
            return this.getTileState(tileKey);
        } finally {
            this.inFlightTiles.delete(tileKey);
        }
    }

    private async countTileObservations(tileKey: string): Promise<number> {
        const result = await this.database.query<{ count: string }>(
            `
                SELECT count(*)::text AS count
                FROM app.wifi_observation_tiles
                WHERE tile_key = $1
            `,
            [tileKey],
        );
        return Number(result?.rows?.[0]?.count || 0);
    }

    private normalizeRecord(raw: WigleSearchResult): WifiDetailsRecord | null {
        const id = normalizeWifiId(raw);
        const lat = finiteNumber(raw.trilat ?? raw.lat ?? raw.latitude);
        const lng = finiteNumber(raw.trilong ?? raw.lng ?? raw.lon ?? raw.longitude);
        if (!id || lat == null || lng == null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
        const security = normalizeSecurity(raw);
        const ssid = normalizeSsid(raw.ssid);
        const encryption = String(raw.encryption ?? raw.wep ?? '').trim();
        return {
            id,
            layerId: 'wifi',
            featureKind: 'observation',
            name: ssid,
            ssid,
            bssidMasked: maskBssid(raw.netid ?? raw.bssid ?? raw.mac),
            lat,
            lng,
            security,
            encryption,
            channel: finiteNumber(raw.channel),
            networkType: raw.type ? String(raw.type) : null,
            firstSeen: isoOrNull(raw.firsttime ?? raw.firstSeen),
            lastSeen: isoOrNull(raw.lasttime ?? raw.lastSeen),
            providerUpdatedAt: isoOrNull(raw.lastupdt ?? raw.lastUpdate),
            quality: finiteNumber(raw.qos),
            source: 'WiGLE',
            properties: {
                encryption,
                channel: finiteNumber(raw.channel),
                networkType: raw.type ? String(raw.type) : null,
                firstSeen: isoOrNull(raw.firsttime ?? raw.firstSeen),
                lastSeen: isoOrNull(raw.lasttime ?? raw.lastSeen),
                providerUpdatedAt: isoOrNull(raw.lastupdt ?? raw.lastUpdate),
                quality: finiteNumber(raw.qos),
                freenet: raw.freenet ?? null,
                paynet: raw.paynet ?? null,
            },
        };
    }

    private async persistDetails(records: WifiDetailsRecord[], tileKey?: string): Promise<void> {
        if (!this.database.isReady() || records.length === 0) return;
        await this.database.withTransaction(async () => {
            for (const record of records) {
                const payloadHash = contentHash({
                    lat: record.lat,
                    lng: record.lng,
                    security: record.security,
                    ssid: record.ssid,
                    encryption: record.encryption,
                    channel: record.channel,
                    lastSeen: record.lastSeen,
                    providerUpdatedAt: record.providerUpdatedAt,
                });
                await this.database.query(
                    `
                        INSERT INTO app.wifi_observations (
                            wifi_id, source_id, ssid, bssid_masked, lat, lng, security,
                            encryption, channel, network_type, first_seen, last_seen,
                            provider_updated_at, quality, properties, payload_hash,
                            first_seen_by_us, last_seen_by_us
                        )
                        VALUES (
                            $1, 'wigle', $2, $3, $4, $5, $6, $7, $8, $9,
                            $10::timestamptz, $11::timestamptz, $12::timestamptz,
                            $13, $14::jsonb, $15, now(), now()
                        )
                        ON CONFLICT (wifi_id) DO UPDATE SET
                            ssid = EXCLUDED.ssid,
                            bssid_masked = EXCLUDED.bssid_masked,
                            lat = EXCLUDED.lat,
                            lng = EXCLUDED.lng,
                            security = EXCLUDED.security,
                            encryption = EXCLUDED.encryption,
                            channel = EXCLUDED.channel,
                            network_type = EXCLUDED.network_type,
                            first_seen = COALESCE(app.wifi_observations.first_seen, EXCLUDED.first_seen),
                            last_seen = CASE
                                WHEN EXCLUDED.last_seen IS NULL THEN app.wifi_observations.last_seen
                                WHEN app.wifi_observations.last_seen IS NULL THEN EXCLUDED.last_seen
                                ELSE GREATEST(EXCLUDED.last_seen, app.wifi_observations.last_seen)
                            END,
                            provider_updated_at = CASE
                                WHEN EXCLUDED.provider_updated_at IS NULL THEN app.wifi_observations.provider_updated_at
                                WHEN app.wifi_observations.provider_updated_at IS NULL THEN EXCLUDED.provider_updated_at
                                ELSE GREATEST(EXCLUDED.provider_updated_at, app.wifi_observations.provider_updated_at)
                            END,
                            quality = EXCLUDED.quality,
                            properties = EXCLUDED.properties,
                            payload_hash = EXCLUDED.payload_hash,
                            last_seen_by_us = now()
                    `,
                    [
                        record.id,
                        record.ssid,
                        record.bssidMasked,
                        record.lat,
                        record.lng,
                        record.security,
                        record.encryption,
                        record.channel,
                        record.networkType,
                        record.firstSeen,
                        record.lastSeen,
                        record.providerUpdatedAt,
                        record.quality,
                        JSON.stringify(record.properties),
                        payloadHash,
                    ],
                );
                await this.database.query(
                    `
                        INSERT INTO app.wifi_observation_history (
                            wifi_id, source_id, observed_at, lat, lng, security, payload_hash, properties
                        )
                        VALUES (
                            $1, 'wigle', COALESCE($2::timestamptz, $3::timestamptz, now()),
                            $4, $5, $6, $7, $8::jsonb
                        )
                        ON CONFLICT (wifi_id, source_id, payload_hash) DO NOTHING
                    `,
                    [
                        record.id,
                        record.lastSeen,
                        record.providerUpdatedAt,
                        record.lat,
                        record.lng,
                        record.security,
                        payloadHash,
                        JSON.stringify(record.properties),
                    ],
                );
                if (tileKey) {
                    await this.database.query(
                        `
                            INSERT INTO app.wifi_observation_tiles (
                                tile_key, wifi_id, first_seen_in_tile, last_seen_in_tile
                            )
                            VALUES ($1, $2, now(), now())
                            ON CONFLICT (tile_key, wifi_id) DO UPDATE SET
                                last_seen_in_tile = now()
                        `,
                        [tileKey, record.id],
                    );
                }
            }
        });
    }
}
