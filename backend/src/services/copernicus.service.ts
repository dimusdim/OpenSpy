import axios from 'axios';
import crypto from 'crypto';
import { retryWithBackoff } from './http-retry';

type Bbox = [number, number, number, number]; // west, south, east, north

type CopernicusSearchInput = {
    bbox: Bbox;
    from: string;
    to: string;
    collection?: string;
    layer?: string;
    maxCloudCover?: number;
    limit?: number;
};

type CopernicusRenderInput = {
    bbox: Bbox;
    from: string;
    to: string;
    collection?: string;
    layer?: string;
    maxCloudCover?: number;
    width?: number;
    height?: number;
};

export type CopernicusScene = {
    scene_id: string;
    source: 'copernicus';
    provider: 'Copernicus Data Space / Sentinel Hub';
    collection: string;
    datetime: string | null;
    platform: string | null;
    sensor: string | null;
    cloud_cover: number | null;
    bbox: Bbox;
    bbox_order: 'west,south,east,north';
    properties: Record<string, unknown>;
    render_supported: boolean;
    render_unsupported_reason: string | null;
    render: {
        source: 'copernicus';
        collection: string;
        layer: string;
        from: string;
        to: string;
        maxCloudCover: number;
        bbox: Bbox;
        bbox_order: 'west,south,east,north';
    } | null;
};

const TOKEN_URL = 'https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token';
const CATALOG_URL = 'https://sh.dataspace.copernicus.eu/api/v1/catalog/1.0.0/search';
const PROCESS_URL = 'https://sh.dataspace.copernicus.eu/api/v1/process';

function positiveIntFromEnv(name: string, fallback: number): number {
    const value = Number.parseInt(process.env[name] || '', 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

function positiveNumberFromEnv(name: string, fallback: number): number {
    const value = Number.parseFloat(process.env[name] || '');
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function isoDate(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw new Error(`Invalid ISO timestamp: ${value}`);
    return date.toISOString();
}

function windowDays(from: string, to: string): number {
    return Math.max(0, (new Date(to).getTime() - new Date(from).getTime()) / 86_400_000);
}

function bboxAreaDeg2([west, south, east, north]: Bbox): number {
    return Math.max(0, north - south) * Math.max(0, east - west);
}

function hashKey(value: unknown): string {
    return crypto.createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 20);
}

function normalizeCollection(input?: string): string {
    const key = String(input || 'sentinel-2-l2a').trim().toLowerCase().replace(/_/g, '-');
    if (key === 'sentinel-2' || key === 's2' || key === 's2-l2a') return 'sentinel-2-l2a';
    if (key === 'sentinel-1' || key === 's1' || key === 's1-grd') return 'sentinel-1-grd';
    return key || 'sentinel-2-l2a';
}

function isSentinel2Collection(collection: string): boolean {
    return normalizeCollection(collection) === 'sentinel-2-l2a';
}

function normalizeRenderLayer(layer?: string): string {
    const key = String(layer || 'true_color').trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (key === 'false_color' || key === 'vegetation') return 'false_color';
    if (key === 'true_color' || key === 'natural_color' || key === 'rgb') return 'true_color';
    if (key === 'radar' || key === 'radar_vv' || key === 'vv') return 'radar_vv';
    return key || 'true_color';
}

function renderSizeForBbox([west, south, east, north]: Bbox, maxPixels: number): { width: number; height: number } {
    const latSpan = Math.max(0.0001, Math.abs(north - south));
    const lngSpan = Math.max(0.0001, Math.abs(east - west));
    const midLatRad = ((north + south) / 2) * Math.PI / 180;
    const widthAtLat = Math.max(0.0001, lngSpan * Math.max(0.2, Math.cos(midLatRad)));
    const aspect = clamp(widthAtLat / latSpan, 0.25, 4);
    const longSide = clamp(maxPixels, 128, 2048);
    if (aspect >= 1) {
        return { width: longSide, height: clamp(Math.round(longSide / aspect), 128, longSide) };
    }
    return { width: clamp(Math.round(longSide * aspect), 128, longSide), height: longSide };
}

function evalscriptForLayer(layer?: string): string {
    const key = normalizeRenderLayer(layer);
    if (key === 'false_color' || key === 'vegetation') {
        return `//VERSION=3
function setup() {
  return { input: ["B08", "B04", "B03", "dataMask"], output: { bands: 4 } };
}
function evaluatePixel(sample) {
  return [2.5 * sample.B08, 2.5 * sample.B04, 2.5 * sample.B03, sample.dataMask];
}`;
    }
    return `//VERSION=3
function setup() {
  return { input: ["B04", "B03", "B02", "dataMask"], output: { bands: 4 } };
}
function evaluatePixel(sample) {
  return [2.5 * sample.B04, 2.5 * sample.B03, 2.5 * sample.B02, sample.dataMask];
}`;
}

export class CopernicusService {
    private token: { value: string; expiresAt: number } | null = null;
    private searchCache = new Map<string, { expiresAt: number; value: { scenes: CopernicusScene[]; rawCount: number; query: Record<string, unknown> } }>();
    private renderCache = new Map<string, { expiresAt: number; buffer: Buffer; contentType: string }>();
    private lastProviderRequestAt = 0;

    getPolicy() {
        return {
            provider: 'Copernicus Data Space / Sentinel Hub',
            auth: {
                required: true,
                configured: Boolean(process.env.COPERNICUS_CLIENT_ID && process.env.COPERNICUS_CLIENT_SECRET),
                env_keys: ['COPERNICUS_CLIENT_ID', 'COPERNICUS_CLIENT_SECRET'],
            },
            free_tier: 'Copernicus Data Space / Sentinel Hub general-user access is free after registration within monthly/minute quotas; larger use may require a commercial plan.',
            cadence: {
                scene_search_cache_seconds: positiveIntFromEnv('COPERNICUS_SEARCH_CACHE_SECONDS', 600),
                render_cache_seconds: positiveIntFromEnv('COPERNICUS_RENDER_CACHE_SECONDS', 3600),
                min_provider_request_interval_ms: positiveIntFromEnv('COPERNICUS_MIN_REQUEST_INTERVAL_MS', 2500),
            },
            limits: {
                max_search_window_days: positiveIntFromEnv('COPERNICUS_MAX_SEARCH_WINDOW_DAYS', 14),
                max_bbox_area_degrees2: positiveNumberFromEnv('COPERNICUS_MAX_BBOX_AREA_DEG2', 25),
                max_results: positiveIntFromEnv('COPERNICUS_MAX_SEARCH_RESULTS', 10),
                max_render_pixels: positiveIntFromEnv('COPERNICUS_MAX_RENDER_PIXELS', 1024),
                search_cache_max_entries: positiveIntFromEnv('COPERNICUS_SEARCH_CACHE_MAX_ENTRIES', 128),
                render_cache_max_entries: positiveIntFromEnv('COPERNICUS_RENDER_CACHE_MAX_ENTRIES', 64),
            },
        };
    }

    private pruneCache<T extends { expiresAt: number }>(cache: Map<string, T>, maxEntries: number): void {
        const now = Date.now();
        for (const [key, value] of cache) {
            if (now >= value.expiresAt) cache.delete(key);
        }
        while (cache.size > maxEntries) {
            const oldest = cache.keys().next().value;
            if (!oldest) break;
            cache.delete(oldest);
        }
    }

    private requireCredentials(): { clientId: string; clientSecret: string } {
        const clientId = process.env.COPERNICUS_CLIENT_ID;
        const clientSecret = process.env.COPERNICUS_CLIENT_SECRET;
        if (!clientId || !clientSecret) {
            throw new Error('COPERNICUS_CLIENT_ID and COPERNICUS_CLIENT_SECRET are required');
        }
        return { clientId, clientSecret };
    }

    private validateWindowAndBbox(input: { bbox: Bbox; from: string; to: string }) {
        const policy = this.getPolicy();
        if (windowDays(input.from, input.to) > policy.limits.max_search_window_days) {
            throw new Error(`Copernicus search window is capped at ${policy.limits.max_search_window_days} days for the configured account policy`);
        }
        if (bboxAreaDeg2(input.bbox) > policy.limits.max_bbox_area_degrees2) {
            throw new Error(`Copernicus AOI is capped at ${policy.limits.max_bbox_area_degrees2} square degrees to protect free-tier quotas`);
        }
    }

    private async waitProviderGate(): Promise<void> {
        const minInterval = this.getPolicy().cadence.min_provider_request_interval_ms;
        const elapsed = Date.now() - this.lastProviderRequestAt;
        if (elapsed < minInterval) {
            await new Promise((resolve) => setTimeout(resolve, minInterval - elapsed));
        }
        this.lastProviderRequestAt = Date.now();
    }

    private async getToken(): Promise<string> {
        if (this.token && Date.now() < this.token.expiresAt) return this.token.value;
        const { clientId, clientSecret } = this.requireCredentials();
        await this.waitProviderGate();
        const body = new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: clientId,
            client_secret: clientSecret,
        });
        const response = await retryWithBackoff(() => axios.post(TOKEN_URL, body.toString(), {
            timeout: 30_000,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        }), { label: 'Copernicus token', maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 30_000 });
        const accessToken = String(response.data?.access_token || '');
        if (!accessToken) throw new Error('Copernicus token response did not include access_token');
        const expiresInSeconds = Number(response.data?.expires_in || 600);
        this.token = {
            value: accessToken,
            expiresAt: Date.now() + Math.max(60, expiresInSeconds - 60) * 1000,
        };
        return accessToken;
    }

    async searchScenes(input: CopernicusSearchInput): Promise<{ scenes: CopernicusScene[]; rawCount: number; query: Record<string, unknown>; cached: boolean }> {
        const from = isoDate(input.from);
        const to = isoDate(input.to);
        const collection = normalizeCollection(input.collection);
        const layer = normalizeRenderLayer(input.layer);
        const maxCloudCover = clamp(Number(input.maxCloudCover ?? 40), 0, 100);
        const limit = Math.min(Math.max(1, Number(input.limit || 5)), this.getPolicy().limits.max_results);
        this.validateWindowAndBbox({ bbox: input.bbox, from, to });
        const query: Record<string, unknown> = {
            bbox: input.bbox,
            datetime: `${from}/${to}`,
            collections: [collection],
            limit,
        };
        if (collection.includes('sentinel-2')) {
            query['filter-lang'] = 'cql2-text';
            query.filter = `eo:cloud_cover <= ${maxCloudCover}`;
        }
        const cacheKey = hashKey({ ...query, renderLayer: layer });
        this.pruneCache(this.searchCache, this.getPolicy().limits.search_cache_max_entries);
        const cached = this.searchCache.get(cacheKey);
        if (cached && Date.now() < cached.expiresAt) {
            return { ...cached.value, cached: true };
        }
        if (cached) this.searchCache.delete(cacheKey);
        const token = await this.getToken();
        await this.waitProviderGate();
        const response = await retryWithBackoff(() => axios.post(CATALOG_URL, query, {
            timeout: 45_000,
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
                Accept: 'application/geo+json',
            },
        }), { label: 'Copernicus catalog', maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 30_000 });
        const features = Array.isArray(response.data?.features) ? response.data.features : [];
        const scenes = features.map((feature: any) => this.mapFeature(feature, input.bbox, collection, layer, from, to, maxCloudCover));
        const value = { scenes, rawCount: features.length, query };
        this.searchCache.set(cacheKey, {
            expiresAt: Date.now() + this.getPolicy().cadence.scene_search_cache_seconds * 1000,
            value,
        });
        this.pruneCache(this.searchCache, this.getPolicy().limits.search_cache_max_entries);
        return { ...value, cached: false };
    }

    private mapFeature(feature: any, fallbackBbox: Bbox, collection: string, requestedLayer: string, from: string, to: string, maxCloudCover: number): CopernicusScene {
        const props = feature?.properties && typeof feature.properties === 'object' ? feature.properties : {};
        const rawBbox = Array.isArray(feature?.bbox) && feature.bbox.length === 4 ? feature.bbox.map(Number) : null;
        const bbox: Bbox = rawBbox && rawBbox.every(Number.isFinite)
            ? [rawBbox[0], rawBbox[1], rawBbox[2], rawBbox[3]]
            : fallbackBbox;
        const datetime = props.datetime || props.start_datetime || props.end_datetime || null;
        const platform = props.platform || props['sat:platform_international_designator'] || props.constellation || null;
        const instruments = Array.isArray(props.instruments) ? props.instruments.join(', ') : props.instruments || null;
        const cloudCover = props['eo:cloud_cover'] ?? props.cloud_cover ?? props.cloudCover ?? null;
        const renderable = isSentinel2Collection(collection) && requestedLayer !== 'radar_vv';
        const render = renderable
            ? {
                source: 'copernicus' as const,
                collection,
                layer: requestedLayer,
                from,
                to,
                maxCloudCover,
                bbox,
                bbox_order: 'west,south,east,north' as const,
            }
            : null;
        return {
            scene_id: `scene:copernicus:${String(feature?.id || hashKey({ datetime, bbox }))}`,
            source: 'copernicus',
            provider: 'Copernicus Data Space / Sentinel Hub',
            collection,
            datetime: datetime ? String(datetime) : null,
            platform: platform ? String(platform) : null,
            sensor: instruments ? String(instruments) : collection,
            cloud_cover: cloudCover == null || !Number.isFinite(Number(cloudCover)) ? null : Number(cloudCover),
            bbox,
            bbox_order: 'west,south,east,north',
            properties: {
                id: feature?.id || null,
                collection: feature?.collection || collection,
                datetime,
                platform,
                instruments,
                cloud_cover: cloudCover,
            },
            render_supported: Boolean(render),
            render_unsupported_reason: render ? null : 'Copernicus preview rendering currently supports Sentinel-2 L2A optical scenes only.',
            render,
        };
    }

    async renderScene(input: CopernicusRenderInput): Promise<{ buffer: Buffer; contentType: string; cached: boolean; policy: ReturnType<CopernicusService['getPolicy']> }> {
        const from = isoDate(input.from);
        const to = isoDate(input.to);
        this.validateWindowAndBbox({ bbox: input.bbox, from, to });
        const maxPx = this.getPolicy().limits.max_render_pixels;
        const defaultSize = renderSizeForBbox(input.bbox, Math.min(maxPx, 1024));
        const width = Number.isFinite(Number(input.width)) && Number(input.width) > 0
            ? clamp(Number(input.width), 64, maxPx)
            : defaultSize.width;
        const height = Number.isFinite(Number(input.height)) && Number(input.height) > 0
            ? clamp(Number(input.height), 64, maxPx)
            : defaultSize.height;
        const collection = normalizeCollection(input.collection);
        const layer = normalizeRenderLayer(input.layer);
        if (!isSentinel2Collection(collection) || layer === 'radar_vv') {
            throw new Error('Copernicus render currently supports Sentinel-2 L2A optical true_color and false_color previews only');
        }
        const maxCloudCover = clamp(Number(input.maxCloudCover ?? 40), 0, 100);
        const request = {
            input: {
                bounds: {
                    bbox: input.bbox,
                    properties: { crs: 'http://www.opengis.net/def/crs/OGC/1.3/CRS84' },
                },
                data: [{
                    type: collection,
                    dataFilter: {
                        timeRange: { from, to },
                        maxCloudCoverage: maxCloudCover,
                        mosaickingOrder: 'leastCC',
                    },
                }],
            },
            output: {
                width,
                height,
                responses: [{ identifier: 'default', format: { type: 'image/png' } }],
            },
            evalscript: evalscriptForLayer(layer),
        };
        const cacheKey = hashKey(request);
        this.pruneCache(this.renderCache, this.getPolicy().limits.render_cache_max_entries);
        const cached = this.renderCache.get(cacheKey);
        if (cached && Date.now() < cached.expiresAt) {
            return { buffer: cached.buffer, contentType: cached.contentType, cached: true, policy: this.getPolicy() };
        }
        if (cached) this.renderCache.delete(cacheKey);
        const token = await this.getToken();
        await this.waitProviderGate();
        const response = await retryWithBackoff(() => axios.post(PROCESS_URL, request, {
            timeout: 60_000,
            responseType: 'arraybuffer',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
                Accept: 'image/png',
            },
        }), { label: 'Copernicus render', maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 30_000 });
        const contentType = String(response.headers?.['content-type'] || 'image/png');
        const buffer = Buffer.from(response.data);
        this.renderCache.set(cacheKey, {
            expiresAt: Date.now() + this.getPolicy().cadence.render_cache_seconds * 1000,
            buffer,
            contentType,
        });
        this.pruneCache(this.renderCache, this.getPolicy().limits.render_cache_max_entries);
        return { buffer, contentType, cached: false, policy: this.getPolicy() };
    }
}
