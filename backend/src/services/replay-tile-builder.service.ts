import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { encode } from '@msgpack/msgpack';
import { DatabaseService } from '../db/database.service';
import { ReplayQueryService, type ReplayStateFilters, type ReplayWindowFilters } from './replay-query.service';

type ReplayStateEntity = Awaited<ReturnType<ReplayQueryService['listEntityStateAt']>>[number];
type ReplayStateEvent = Awaited<ReturnType<ReplayQueryService['listEventStateAt']>>[number];
type ReplayStateAsset = Awaited<ReturnType<ReplayQueryService['listAssetStateAt']>>[number];
type ReplayWindowItem = Awaited<ReturnType<ReplayQueryService['listWindow']>>[number];

export type ReplayTileLayerManifest = {
    layerId: string;
    bucketSeconds: number;
    zoom: number;
    tiles: ReplayTileManifestEntry[];
};

export type ReplayTileManifestEntry = {
    layerId: string;
    z: number;
    x: number;
    y: number;
    tBucket: string;
    contentHash: string;
    itemCount: number;
    bytes: number;
    url: string;
};

export type ReplayManifestResponse = {
    from: string;
    to: string;
    layers: Record<string, ReplayTileLayerManifest>;
};

export type ReplayTilePayload = {
    version: 1;
    layerId: string;
    z: number;
    x: number;
    y: number;
    tBucket: string;
    bucketSeconds: number;
    bbox: [number, number, number, number];
    snapshotAt: string;
    bucketTo: string;
    snapshot: {
        entities: ReplayStateEntity[];
        events: ReplayStateEvent[];
        assets: ReplayStateAsset[];
    };
    items: ReplayWindowItem[];
};

type ReplayTileIndexRow = {
    layer_id: string;
    z: number;
    x: number;
    y: number;
    t_bucket: string;
    content_hash: string;
    item_count: string;
    bytes: string;
    built_at: string;
};

type ManifestParams = {
    from: string;
    to: string;
    layers: string[];
    z?: number;
    bbox?: [number, number, number, number];
};

type BuildTilesParams = ManifestParams;

type EnsureTileParams = {
    layerId: string;
    z: number;
    x: number;
    y: number;
    tBucket: string;
};

const TILE_ROOT = path.resolve(__dirname, '../../var/replay-tiles');
const DAY_SECONDS = 24 * 60 * 60;

function tile2lon(x: number, z: number): number {
    return (x / 2 ** z) * 360 - 180;
}

function tile2lat(y: number, z: number): number {
    const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
    return (180 / Math.PI) * Math.atan(Math.sinh(n));
}

function normalizeLayerId(layerId: string): string {
    return layerId === 'satellites' ? 'satellite' : layerId;
}

function parseBboxKey(bbox?: [number, number, number, number]): string | null {
    if (!bbox) return null;
    return bbox.map((value) => Number(value.toFixed(6))).join(',');
}

export class ReplayTileBuilderService {
    private readonly manifestBucketCache = new Map<string, ReplayManifestResponse>();

    constructor(
        private readonly database: DatabaseService,
        private readonly replayQueryService: ReplayQueryService,
    ) {}

    private getBucketSeconds(layerId: string): number {
        switch (normalizeLayerId(layerId)) {
            case 'aircraft':
            case 'vessel':
                return 10 * 60;
            case 'conflict':
            case 'disasters':
            case 'outage':
            case 'jamming':
            case 'fire':
            case 'gfw':
                return 60 * 60;
            case 'airspace':
            case 'pipeline':
            case 'cable':
                return DAY_SECONDS;
            default:
                return 60 * 60;
        }
    }

    private floorIsoToBucket(atIso: string, bucketSeconds: number): string {
        const bucketMs = bucketSeconds * 1000;
        const atMs = new Date(atIso).getTime();
        return new Date(Math.floor(atMs / bucketMs) * bucketMs).toISOString();
    }

    // Per-layer hot-bucket freshness policy. A bucket is "fresh enough"
    // if we rebuilt it recently; past that TTL, a request invalidates
    // it. 24h layers (airspace/cable/pipeline) change on daily-ingest
    // cadence, so their current bucket is never treated as hot — that
    // would mean pointlessly rebuilding ~10 MB of polygon data on
    // every manifest call. aircraft/vessel get tight 15s TTL because
    // their data turnover is seconds. Event layers sit at 60s.
    private getHotBucketTtlSeconds(layerId: string): number | null {
        switch (normalizeLayerId(layerId)) {
            case 'aircraft':
            case 'vessel':
                return 15;
            case 'conflict':
            case 'disasters':
            case 'outage':
            case 'jamming':
            case 'fire':
            case 'gfw':
                return 60;
            case 'airspace':
            case 'pipeline':
            case 'cable':
                return null; // never hot — cache indefinitely
            default:
                return 60;
        }
    }

    // True when bucket window is still open AND last rebuild (builtAtIso)
    // is older than per-layer TTL. If no prior build, treat as stale.
    private isStaleHotBucket(
        layerId: string,
        tBucket: string,
        bucketSeconds: number,
        builtAtIso: string | null | undefined,
    ): boolean {
        const bucketEndMs = new Date(tBucket).getTime() + bucketSeconds * 1000;
        if (Date.now() >= bucketEndMs) return false; // bucket closed
        const ttlSec = this.getHotBucketTtlSeconds(layerId);
        if (ttlSec === null) return false; // never hot for this layer
        if (!builtAtIso) return true; // never built → definitely stale
        const builtAtMs = new Date(builtAtIso).getTime();
        if (!Number.isFinite(builtAtMs)) return true;
        return Date.now() - builtAtMs > ttlSec * 1000;
    }

    // Bucket is physically open (not yet closed by wall clock).
    private isBucketOpen(tBucket: string, bucketSeconds: number): boolean {
        return Date.now() < new Date(tBucket).getTime() + bucketSeconds * 1000;
    }

    private bucketRange(fromIso: string, toIso: string, bucketSeconds: number): string[] {
        const bucketMs = bucketSeconds * 1000;
        const startMs = new Date(this.floorIsoToBucket(fromIso, bucketSeconds)).getTime();
        const endMs = new Date(this.floorIsoToBucket(toIso, bucketSeconds)).getTime();
        const buckets: string[] = [];
        for (let currentMs = startMs; currentMs <= endMs; currentMs += bucketMs) {
            buckets.push(new Date(currentMs).toISOString());
        }
        return buckets;
    }

    private getTileBbox(z: number, x: number, y: number): [number, number, number, number] {
        const west = tile2lon(x, z);
        const east = tile2lon(x + 1, z);
        const north = tile2lat(y, z);
        const south = tile2lat(y + 1, z);
        return [south, west, north, east];
    }

    private getTileKey(params: EnsureTileParams): string {
        return `${params.layerId}:${params.z}:${params.x}:${params.y}:${params.tBucket}`;
    }

    private getTileDir(params: EnsureTileParams): string {
        return path.join(TILE_ROOT, params.layerId, String(params.z), String(params.x), String(params.y));
    }

    private getTileFilename(tBucketIso: string, contentHash: string): string {
        const safeBucket = tBucketIso.replace(/[:]/g, '-');
        return `${safeBucket}-${contentHash}.msgpack`;
    }

    private getTilePath(params: EnsureTileParams, contentHash: string): string {
        return path.join(this.getTileDir(params), this.getTileFilename(params.tBucket, contentHash));
    }

    private getTileUrl(params: EnsureTileParams, contentHash: string): string {
        return `/static/replay-tiles/${params.layerId}/${params.z}/${params.x}/${params.y}/${this.getTileFilename(params.tBucket, contentHash)}`;
    }

    private async ensureTileDirectory(params: EnsureTileParams): Promise<void> {
        await fs.promises.mkdir(this.getTileDir(params), { recursive: true });
    }

    private async readIndex(params: EnsureTileParams): Promise<ReplayTileIndexRow | null> {
        const result = await this.database.query<ReplayTileIndexRow>(
            `
                SELECT
                    layer_id,
                    z,
                    x,
                    y,
                    t_bucket::text,
                    content_hash,
                    item_count::text,
                    bytes::text,
                    built_at::text
                FROM app.replay_tile_index
                WHERE layer_id = $1
                  AND z = $2
                  AND x = $3
                  AND y = $4
                  AND t_bucket = $5::timestamptz
                LIMIT 1
            `,
            [params.layerId, params.z, params.x, params.y, params.tBucket],
        );
        const row = result?.rows?.[0] || null;
        return row ? this.normalizeIndexRow(row) : null;
    }

    private normalizeIndexRow(row: ReplayTileIndexRow): ReplayTileIndexRow {
        return {
            ...row,
            t_bucket: new Date(row.t_bucket).toISOString(),
        };
    }

    private async readIndexedEntries(
        layerId: string,
        z: number,
        buckets: string[],
        coords: Array<{ x: number; y: number }>,
    ): Promise<Map<string, ReplayTileIndexRow>> {
        if (buckets.length === 0 || coords.length === 0) return new Map();
        const xValues = coords.map((coord) => coord.x);
        const yValues = coords.map((coord) => coord.y);
        const minX = Math.min(...xValues);
        const maxX = Math.max(...xValues);
        const minY = Math.min(...yValues);
        const maxY = Math.max(...yValues);
        const result = await this.database.query<ReplayTileIndexRow>(
            `
                SELECT
                    layer_id,
                    z,
                    x,
                    y,
                    t_bucket::text,
                    content_hash,
                    item_count::text,
                    bytes::text,
                    built_at::text
                FROM app.replay_tile_index
                WHERE layer_id = $1
                  AND z = $2
                  AND t_bucket = ANY($3::timestamptz[])
                  AND x BETWEEN $4 AND $5
                  AND y BETWEEN $6 AND $7
            `,
            [layerId, z, buckets, minX, maxX, minY, maxY],
        );
        const coordKeys = new Set(coords.map((coord) => `${coord.x}:${coord.y}`));
        const rows = new Map<string, ReplayTileIndexRow>();
        for (const rawRow of result?.rows || []) {
            const row = this.normalizeIndexRow(rawRow);
            const coordKey = `${row.x}:${row.y}`;
            if (!coordKeys.has(coordKey)) continue;
            rows.set(this.getTileKey({
                layerId: row.layer_id,
                z: row.z,
                x: row.x,
                y: row.y,
                tBucket: row.t_bucket,
            }), row);
        }
        return rows;
    }

    private async upsertIndex(params: EnsureTileParams, contentHash: string, itemCount: number, bytes: number): Promise<void> {
        await this.database.query(
            `
                INSERT INTO app.replay_tile_index (
                    layer_id, z, x, y, t_bucket, content_hash, item_count, bytes, built_at
                ) VALUES (
                    $1, $2, $3, $4, $5::timestamptz, $6, $7, $8, now()
                )
                ON CONFLICT (layer_id, z, x, y, t_bucket)
                DO UPDATE SET
                    content_hash = EXCLUDED.content_hash,
                    item_count = EXCLUDED.item_count,
                    bytes = EXCLUDED.bytes,
                    built_at = now()
            `,
            [params.layerId, params.z, params.x, params.y, params.tBucket, contentHash, itemCount, bytes],
        );
        this.manifestBucketCache.clear();
    }

    private async buildTilePayload(params: EnsureTileParams): Promise<ReplayTilePayload> {
        const bucketSeconds = this.getBucketSeconds(params.layerId);
        const bbox = this.getTileBbox(params.z, params.x, params.y);
        const bucketTo = new Date(new Date(params.tBucket).getTime() + bucketSeconds * 1000).toISOString();

        const stateFilters: ReplayStateFilters = {
            at: params.tBucket,
            layerId: params.layerId,
            bbox,
        };
        const windowFilters: ReplayWindowFilters = {
            from: params.tBucket,
            to: bucketTo,
            layerId: params.layerId,
            bbox,
        };

        const [entities, events, assets, items] = await Promise.all([
            this.replayQueryService.listEntityStateAt(stateFilters),
            this.replayQueryService.listEventStateAt(stateFilters),
            this.replayQueryService.listAssetStateAt(stateFilters),
            this.replayQueryService.listWindow(windowFilters),
        ]);

        return {
            version: 1,
            layerId: params.layerId,
            z: params.z,
            x: params.x,
            y: params.y,
            tBucket: params.tBucket,
            bucketSeconds,
            bbox,
            snapshotAt: params.tBucket,
            bucketTo,
            snapshot: {
                entities,
                events,
                assets,
            },
            items,
        };
    }

    async ensureTile(params: EnsureTileParams): Promise<ReplayTileManifestEntry> {
        const bucketSeconds = this.getBucketSeconds(params.layerId);
        const existing = await this.readIndex(params);
        const stale = this.isStaleHotBucket(
            params.layerId,
            params.tBucket,
            bucketSeconds,
            existing?.built_at || null,
        );
        if (existing && !stale) {
            const existingPath = this.getTilePath(params, existing.content_hash);
            if (fs.existsSync(existingPath)) {
                return {
                    layerId: params.layerId,
                    z: params.z,
                    x: params.x,
                    y: params.y,
                    tBucket: params.tBucket,
                    contentHash: existing.content_hash,
                    itemCount: Number(existing.item_count || '0'),
                    bytes: Number(existing.bytes || '0'),
                    url: this.getTileUrl(params, existing.content_hash),
                };
            }
        }

        const payload = await this.buildTilePayload(params);
        const buffer = Buffer.from(encode(payload));
        const contentHash = crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 16);
        await this.ensureTileDirectory(params);
        const filePath = this.getTilePath(params, contentHash);
        await fs.promises.writeFile(filePath, buffer);
        const itemCount = payload.snapshot.entities.length
            + payload.snapshot.events.length
            + payload.snapshot.assets.length
            + payload.items.length;
        await this.upsertIndex(params, contentHash, itemCount, buffer.byteLength);

        return {
            layerId: params.layerId,
            z: params.z,
            x: params.x,
            y: params.y,
            tBucket: params.tBucket,
            contentHash,
            itemCount,
            bytes: buffer.byteLength,
            url: this.getTileUrl(params, contentHash),
        };
    }

    private getTileCoordsForManifest(z: number, bbox?: [number, number, number, number]): Array<{ x: number; y: number }> {
        if (!bbox || z <= 0) return [{ x: 0, y: 0 }];
        const [south, west, north, east] = bbox;
        const lonToX = (lon: number) => Math.floor(((lon + 180) / 360) * 2 ** z);
        const latToY = (lat: number) => {
            const rad = (lat * Math.PI) / 180;
            return Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z);
        };
        const minX = Math.max(0, Math.min(2 ** z - 1, lonToX(west)));
        const maxX = Math.max(0, Math.min(2 ** z - 1, lonToX(east)));
        const minY = Math.max(0, Math.min(2 ** z - 1, latToY(north)));
        const maxY = Math.max(0, Math.min(2 ** z - 1, latToY(south)));
        const coords: Array<{ x: number; y: number }> = [];
        for (let x = Math.min(minX, maxX); x <= Math.max(minX, maxX); x += 1) {
            for (let y = Math.min(minY, maxY); y <= Math.max(minY, maxY); y += 1) {
                coords.push({ x, y });
            }
        }
        return coords.length > 0 ? coords : [{ x: 0, y: 0 }];
    }

    async buildManifest(params: ManifestParams): Promise<ReplayManifestResponse> {
        const z = Number.isFinite(params.z) ? Math.max(0, Math.min(6, Math.trunc(params.z as number))) : 0;
        const cacheKey = [
            params.from,
            params.to,
            z,
            parseBboxKey(params.bbox) || 'global',
            params.layers.join(','),
        ].join('|');
        // Per-layer check: window contains a bucket that is still open
        // AND that layer has a hot TTL. If any such bucket exists, the
        // manifest may mint a new content_hash on this call, so we
        // must bypass the in-memory manifest cache.
        const windowContainsHotBucket = params.layers.some((raw) => {
            const layerId = normalizeLayerId(raw);
            if (layerId === 'satellite') return false;
            if (this.getHotBucketTtlSeconds(layerId) === null) return false;
            const bs = this.getBucketSeconds(layerId);
            const buckets = this.bucketRange(params.from, params.to, bs);
            return buckets.some((t) => this.isBucketOpen(t, bs));
        });
        if (!windowContainsHotBucket) {
            const cached = this.manifestBucketCache.get(cacheKey);
            if (cached) return cached;
        }

        const layers: Record<string, ReplayTileLayerManifest> = {};
        for (const rawLayerId of params.layers) {
            const layerId = normalizeLayerId(rawLayerId);
            if (layerId === 'satellite') {
                layers[layerId] = {
                    layerId,
                    bucketSeconds: 6 * 60 * 60,
                    zoom: z,
                    tiles: [],
                };
                continue;
            }
            const bucketSeconds = this.getBucketSeconds(layerId);
            const buckets = this.bucketRange(params.from, params.to, bucketSeconds);
            const coords = this.getTileCoordsForManifest(z, params.bbox);
            const tiles: ReplayTileManifestEntry[] = [];
            // Force-build only STALE hot buckets (older than per-layer
            // TTL). Previously this rebuilt every hot bucket every call,
            // which turned a manifest fetch for all 11 layers into a
            // ~9.8s synchronous chain that blocked the event loop and
            // froze live WebSocket ingestion. The per-layer TTL lets
            // fresh rebuilds coast on cache.
            const hotBuckets = buckets.filter((t) => this.isBucketOpen(t, bucketSeconds));
            if (hotBuckets.length > 0 && this.getHotBucketTtlSeconds(layerId) !== null) {
                const existingIndex = await this.readIndexedEntries(layerId, z, hotBuckets, coords);
                for (const tBucket of hotBuckets) {
                    for (const coord of coords) {
                        const key = this.getTileKey({ layerId, z, x: coord.x, y: coord.y, tBucket });
                        const indexed = existingIndex.get(key);
                        const stale = this.isStaleHotBucket(
                            layerId,
                            tBucket,
                            bucketSeconds,
                            indexed?.built_at || null,
                        );
                        if (!stale) continue;
                        try {
                            await this.ensureTile({ layerId, z, x: coord.x, y: coord.y, tBucket });
                        } catch (error) {
                            console.error('[ReplayTiles] stale-bucket ensure failed:', error);
                        }
                    }
                }
            }
            const indexedEntries = await this.readIndexedEntries(layerId, z, buckets, coords);
            for (const tBucket of buckets) {
                for (const coord of coords) {
                    const paramsKey = {
                        layerId,
                        z,
                        x: coord.x,
                        y: coord.y,
                        tBucket,
                    };
                    const indexed = indexedEntries.get(this.getTileKey(paramsKey));
                    if (!indexed) continue;
                    const filePath = this.getTilePath(paramsKey, indexed.content_hash);
                    if (!fs.existsSync(filePath)) continue;
                    tiles.push({
                        layerId,
                        z,
                        x: coord.x,
                        y: coord.y,
                        tBucket,
                        contentHash: indexed.content_hash,
                        itemCount: Number(indexed.item_count || '0'),
                        bytes: Number(indexed.bytes || '0'),
                        url: this.getTileUrl(paramsKey, indexed.content_hash),
                    });
                }
            }
            layers[layerId] = {
                layerId,
                bucketSeconds,
                zoom: z,
                tiles,
            };
        }

        const manifest: ReplayManifestResponse = {
            from: params.from,
            to: params.to,
            layers,
        };
        if (!windowContainsHotBucket) {
            this.manifestBucketCache.set(cacheKey, manifest);
        }
        return manifest;
    }

    async buildTiles(params: BuildTilesParams): Promise<ReplayManifestResponse> {
        const z = Number.isFinite(params.z) ? Math.max(0, Math.min(6, Math.trunc(params.z as number))) : 0;
        const layers: Record<string, ReplayTileLayerManifest> = {};
        for (const rawLayerId of params.layers) {
            const layerId = normalizeLayerId(rawLayerId);
            if (layerId === 'satellite') {
                layers[layerId] = {
                    layerId,
                    bucketSeconds: 6 * 60 * 60,
                    zoom: z,
                    tiles: [],
                };
                continue;
            }
            const bucketSeconds = this.getBucketSeconds(layerId);
            const buckets = this.bucketRange(params.from, params.to, bucketSeconds);
            const coords = this.getTileCoordsForManifest(z, params.bbox);
            const tiles: ReplayTileManifestEntry[] = [];
            for (const tBucket of buckets) {
                for (const coord of coords) {
                    tiles.push(await this.ensureTile({
                        layerId,
                        z,
                        x: coord.x,
                        y: coord.y,
                        tBucket,
                    }));
                }
            }
            layers[layerId] = {
                layerId,
                bucketSeconds,
                zoom: z,
                tiles,
            };
        }
        return {
            from: params.from,
            to: params.to,
            layers,
        };
    }

    async readTileBuffer(params: EnsureTileParams): Promise<{ buffer: Buffer; entry: ReplayTileManifestEntry } | null> {
        const entry = await this.ensureTile(params);
        const filePath = this.getTilePath(params, entry.contentHash);
        if (!fs.existsSync(filePath)) return null;
        const buffer = await fs.promises.readFile(filePath);
        return { buffer, entry };
    }
}
