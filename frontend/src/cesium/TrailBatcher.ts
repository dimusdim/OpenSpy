import * as Cesium from 'cesium';

// TrailBatcher — manages trail polylines for live + replay modes.
//
// The plan (ops/specs/swirling-stirring-eagle, AD-3) specifies a custom
// Cesium Primitive with pre-expanded VBOs and a shader-driven age
// uniform. This first iteration backs the public API with
// PolylineCollection, which is enough to drive the live + replay
// integration and meet the functional validation spike target.
// Replacing the internals with a custom Primitive is a self-contained
// follow-up that does not change the API surface used by callers.

export type TrailSample = [number, number, number | null, number]; // [lon, lat, alt, tSec]

export interface TrailBatcherOptions {
    shardKeys: string[];
    maxSamplesPerTrail?: number;   // ring buffer size per entity
    trailLengthSeconds?: number;   // display window
    baseColor?: Cesium.Color;
    baseWidth?: number;
}

interface TrailState {
    samples: TrailSample[];
    polyline: Cesium.Polyline | null;
}

interface Shard {
    collection: Cesium.PolylineCollection | null;
    trails: Map<string, TrailState>;
}

const DEFAULT_MAX_SAMPLES = 400;
const DEFAULT_TRAIL_SECONDS = 1800; // 30 min
const DEFAULT_WIDTH = 1.5;
const DEFAULT_COLOR = Cesium.Color.fromCssColorString('#66ccff').withAlpha(0.85);
const AGE_SYNC_INTERVAL_SEC = 1;

export class TrailBatcher {
    readonly epochRefSec: number;
    private readonly viewer: Cesium.Viewer;
    private readonly shards = new Map<string, Shard>();
    private readonly lastFetchedEnd = new Map<string, number>();
    private readonly maxSamples: number;
    private trailLengthSec: number;
    private readonly color: Cesium.Color;
    private readonly width: number;
    private currentSec: number;
    private lastAgeSyncSec = 0;
    private hiddenShards = new Set<string>();
    private disposed = false;

    constructor(viewer: Cesium.Viewer, options: TrailBatcherOptions) {
        this.viewer = viewer;
        this.epochRefSec = Math.floor(Date.now() / 1000);
        this.currentSec = this.epochRefSec;
        this.maxSamples = Math.max(16, options.maxSamplesPerTrail ?? DEFAULT_MAX_SAMPLES);
        this.trailLengthSec = options.trailLengthSeconds ?? DEFAULT_TRAIL_SECONDS;
        this.color = options.baseColor ?? DEFAULT_COLOR;
        this.width = options.baseWidth ?? DEFAULT_WIDTH;

        for (const key of options.shardKeys) {
            this.shards.set(key, { collection: null, trails: new Map() });
        }
    }

    setTrailLength(seconds: number): void {
        this.trailLengthSec = Math.max(60, seconds);
    }

    tickClock(currentSec?: number): void {
        if (this.disposed) return;
        this.currentSec = currentSec ?? (Date.now() / 1000);
        // Re-sync polylines once per second to age out stale samples even
        // when no new upserts arrive.
        if (this.currentSec - this.lastAgeSyncSec < AGE_SYNC_INTERVAL_SEC) return;
        this.lastAgeSyncSec = this.currentSec;
        for (const [shardKey, shard] of Array.from(this.shards.entries())) {
            if (this.hiddenShards.has(shardKey)) continue;
            for (const [entityId, state] of Array.from(shard.trails.entries())) {
                this.syncPolyline(shardKey, shard, entityId, state);
                if (state.samples.length === 0 && !state.polyline) {
                    shard.trails.delete(entityId);
                    this.lastFetchedEnd.delete(`${shardKey}:${entityId}`);
                }
            }
        }
    }

    setShardVisible(shardKey: string, visible: boolean): void {
        if (this.disposed) return;
        const shard = this.shards.get(shardKey);
        if (!shard) return;
        if (visible) this.hiddenShards.delete(shardKey);
        else this.hiddenShards.add(shardKey);
        if (shard.collection) {
            shard.collection.show = visible;
        }
    }

    // Append new samples to the specified shard/entity trail.
    // Samples should be sorted ascending by tSec.
    upsertTrail(shardKey: string, entityId: string, samples: TrailSample[]): void {
        if (this.disposed || samples.length === 0) return;
        const shard = this.shards.get(shardKey);
        if (!shard) return;

        const key = `${shardKey}:${entityId}`;
        const sinceSec = this.lastFetchedEnd.get(key) ?? Number.NEGATIVE_INFINITY;
        const fresh = samples.filter((s) => Number.isFinite(s[0]) && Number.isFinite(s[1]) && s[3] > sinceSec);
        if (fresh.length === 0) return;

        let state = shard.trails.get(entityId);
        if (!state) {
            state = { samples: [], polyline: null };
            shard.trails.set(entityId, state);
        }

        state.samples.push(...fresh);
        if (state.samples.length > this.maxSamples) {
            state.samples.splice(0, state.samples.length - this.maxSamples);
        }

        this.lastFetchedEnd.set(key, fresh[fresh.length - 1][3]);
        this.syncPolyline(shardKey, shard, entityId, state);
    }

    // Replace all samples for the entity (used by replay seek).
    setTrail(shardKey: string, entityId: string, samples: TrailSample[]): void {
        if (this.disposed) return;
        const shard = this.shards.get(shardKey);
        if (!shard) return;

        const key = `${shardKey}:${entityId}`;
        this.lastFetchedEnd.delete(key);

        let state = shard.trails.get(entityId);
        if (!state) {
            state = { samples: [], polyline: null };
            shard.trails.set(entityId, state);
        }
        state.samples = samples.filter((s) => Number.isFinite(s[0]) && Number.isFinite(s[1]));
        if (state.samples.length > this.maxSamples) {
            state.samples.splice(0, state.samples.length - this.maxSamples);
        }
        if (state.samples.length > 0) {
            this.lastFetchedEnd.set(key, state.samples[state.samples.length - 1][3]);
        }
        this.syncPolyline(shardKey, shard, entityId, state);
    }

    removeTrail(entityId: string, shardKey?: string): void {
        if (this.disposed) return;
        const shardsToScan = shardKey ? [this.shards.get(shardKey)] : Array.from(this.shards.values());
        for (const shard of shardsToScan) {
            if (!shard) continue;
            const state = shard.trails.get(entityId);
            if (state?.polyline && shard.collection) shard.collection.remove(state.polyline);
            shard.trails.delete(entityId);
            if (shardKey) this.lastFetchedEnd.delete(`${shardKey}:${entityId}`);
            else {
                for (const key of Array.from(this.lastFetchedEnd.keys())) {
                    if (key.endsWith(`:${entityId}`)) this.lastFetchedEnd.delete(key);
                }
            }
        }
    }

    clearShard(shardKey: string): void {
        if (this.disposed) return;
        const shard = this.shards.get(shardKey);
        if (!shard) return;
        shard.collection?.removeAll();
        shard.trails.clear();
        for (const key of Array.from(this.lastFetchedEnd.keys())) {
            if (key.startsWith(`${shardKey}:`)) this.lastFetchedEnd.delete(key);
        }
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        const shards = Array.from(this.shards.values());
        for (const shard of shards) {
            shard.collection?.removeAll();
            if (shard.collection && !this.viewer.isDestroyed()) {
                this.viewer.scene.primitives.remove(shard.collection);
            }
        }
        this.shards.clear();
        this.lastFetchedEnd.clear();
    }

    private ensureCollection(shardKey: string, shard: Shard): Cesium.PolylineCollection {
        if (shard.collection) return shard.collection;
        const collection = new Cesium.PolylineCollection();
        collection.show = !this.hiddenShards.has(shardKey);
        this.viewer.scene.primitives.add(collection);
        shard.collection = collection;
        return collection;
    }

    private syncPolyline(shardKey: string, shard: Shard, entityId: string, state: TrailState): void {
        // Drop samples older than the configured trail length so the array
        // doesn't grow unbounded and aging is honest across tick cycles.
        const cutoff = this.currentSec - this.trailLengthSec;
        let dropUpTo = 0;
        while (dropUpTo < state.samples.length && state.samples[dropUpTo][3] < cutoff) {
            dropUpTo++;
        }
        if (dropUpTo > 0) {
            state.samples.splice(0, dropUpTo);
        }

        if (state.samples.length < 2) {
            if (state.polyline) {
                shard.collection?.remove(state.polyline);
                state.polyline = null;
            }
            return;
        }

        const positions = new Array<Cesium.Cartesian3>(state.samples.length);
        for (let i = 0; i < state.samples.length; i++) {
            const s = state.samples[i];
            positions[i] = Cesium.Cartesian3.fromDegrees(s[0], s[1], s[2] ?? 0);
        }

        if (!state.polyline) {
            const collection = this.ensureCollection(shardKey, shard);
            state.polyline = collection.add({
                positions,
                width: this.width,
                material: Cesium.Material.fromType('Color', { color: this.color }),
                id: entityId,
            });
        } else {
            state.polyline.positions = positions;
        }
    }

    get trailLength(): number {
        return this.trailLengthSec;
    }
}
