import { useCallback, useEffect, useRef } from 'react';
import * as Cesium from 'cesium';
import axios from 'axios';
import { useTimelineStore } from '../store/useTimelineStore';
import { useSecondaryLoadGate } from './useSecondaryLoadGate';
import { API_URL } from '../lib/config';
import { perfLog } from '../lib/perf-log';
import { INFRA_ICONS } from '../icons/map-icons';
import { getViewerAltitudeMeters } from './position-utils';

type PipelineSubstance = 'oil' | 'gas';
type PipelineStatus = 'connecting' | 'streaming' | 'warning' | 'error' | 'disabled' | 'auth-missing' | 'degraded' | 'limited' | 'rate-limited';

// Overture pipeline payloads are viewport-scoped point centroids. Full
// geometry/details are intentionally not loaded during initial render.
export interface PipelineMeta {
    id: string;
    name: string;
    substance: PipelineSubstance;
    lat: number;
    lng: number;
    layer: 'Pipeline';
    source: 'Overture Maps';
    description: string;
}

export const pipelineMetaMap = new Map<string, PipelineMeta>();

const TILE_DEG = 2;
const MAX_LOADED_TILES = 80;
const MAX_TILES_PER_VIEWPORT = 20;
const FETCH_CONCURRENCY = 4;
const PIPELINE_FETCH_TIMEOUT_MS = 20_000;
const PIPELINE_ALTITUDE_CUTOFF_KM = 200;

type TileState = {
    collection: Cesium.BillboardCollection | null;
    billboards: Array<{ billboard: Cesium.Billboard; substance: PipelineSubstance; logicalId: string }>;
    logicalIds: Set<string>;
};

function emptyCounts(): Record<string, number> {
    return { oil: 0, gas: 0 };
}

function cellKey(south: number, west: number): string {
    return `${south},${west}`;
}

function wrapLngDelta(a: number, b: number): number {
    const d = Math.abs(a - b);
    return Math.min(d, 360 - d);
}

function cellsForViewport(
    south: number,
    west: number,
    north: number,
    east: number,
): Array<[number, number, number, number]> {
    if (east < west) {
        return [
            ...cellsForViewport(south, west, north, 180),
            ...cellsForViewport(south, -180, north, east),
        ];
    }
    if (east <= west || north <= south) return [];

    const clampedS = Math.max(-90, Math.floor(south / TILE_DEG) * TILE_DEG);
    const clampedW = Math.max(-180, Math.floor(west / TILE_DEG) * TILE_DEG);
    const clampedN = Math.min(90, Math.ceil(north / TILE_DEG) * TILE_DEG);
    const clampedE = Math.min(180, Math.ceil(east / TILE_DEG) * TILE_DEG);

    const out: Array<[number, number, number, number]> = [];
    for (let s = clampedS; s < clampedN; s += TILE_DEG) {
        for (let w = clampedW; w < clampedE; w += TILE_DEG) {
            const n = Math.min(90, s + TILE_DEG);
            const e = Math.min(180, w + TILE_DEG);
            if (s >= 90 || w >= 180) continue;
            out.push([s, w, n, e]);
        }
    }
    return out;
}

function pipelineIcon(substance: PipelineSubstance): string {
    return substance === 'gas'
        ? (INFRA_ICONS.pipeline_gas || INFRA_ICONS.refinery)
        : (INFRA_ICONS.pipeline_oil || INFRA_ICONS.refinery);
}

export function usePipelinesLayer(viewer: Cesium.Viewer | null) {
    const isSourceOn = useTimelineStore((s) => s.sources.pipelines);
    const isVisible = useTimelineStore((s) => s.visibility.pipelines);
    const mode = useTimelineStore((s) => s.mode);
    const subtypeVisibility = useTimelineStore((s) => s.subtypeVisibility);
    const secondaryReleased = useSecondaryLoadGate();

    const tilesRef = useRef<Map<string, TileState>>(new Map());
    const inFlightCellsRef = useRef<Set<string>>(new Set());
    const activeRef = useRef(false);
    const genRef = useRef(0);
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const aggregateCountsRef = useRef<Record<string, number>>(emptyCounts());
    const logicalRefCountRef = useRef<Map<string, number>>(new Map());

    const publishState = useCallback((status: PipelineStatus = 'streaming', speed: string = 'on viewport') => {
        useTimelineStore.getState().setSubtypeCounts('pipelines', { ...aggregateCountsRef.current });
        useTimelineStore.getState().setStreamMetric('pipelines', {
            count: pipelineMetaMap.size,
            status,
            speed,
        });
    }, []);

    const applyTileVisibility = useCallback((tile: TileState) => {
        const showLayer =
            mode !== 'playback' &&
            useTimelineStore.getState().sources.pipelines &&
            useTimelineStore.getState().visibility.pipelines;
        if (tile.collection) tile.collection.show = showLayer;
        const vis = useTimelineStore.getState().subtypeVisibility;
        for (const entry of tile.billboards) {
            entry.billboard.show = vis[`pipelines:${entry.substance}`] !== false;
        }
    }, [mode]);

    const evictTile = useCallback((v: Cesium.Viewer, key: string) => {
        const tile = tilesRef.current.get(key);
        if (!tile) return;
        if (tile.collection && !v.isDestroyed()) {
            v.scene.primitives.remove(tile.collection);
        }
        for (const logicalId of Array.from(tile.logicalIds)) {
            const next = (logicalRefCountRef.current.get(logicalId) || 1) - 1;
            if (next > 0) {
                logicalRefCountRef.current.set(logicalId, next);
                continue;
            }
            logicalRefCountRef.current.delete(logicalId);
            const meta = pipelineMetaMap.get(logicalId);
            if (meta) {
                aggregateCountsRef.current[meta.substance] = Math.max(
                    0,
                    (aggregateCountsRef.current[meta.substance] || 0) - 1,
                );
            }
            pipelineMetaMap.delete(logicalId);
        }
        tilesRef.current.delete(key);
    }, []);

    const fetchTile = useCallback(
        async (v: Cesium.Viewer, south: number, west: number, north: number, east: number) => {
            const key = cellKey(south, west);
            if (tilesRef.current.has(key) || inFlightCellsRef.current.has(key)) return;
            const myGen = genRef.current;
            inFlightCellsRef.current.add(key);

            try {
                const t0 = performance.now();
                const res = await axios.get(
                    `${API_URL}/api/pipelines?bbox=${south},${west},${north},${east}`,
                    { timeout: PIPELINE_FETCH_TIMEOUT_MS },
                );
                perfLog('pipelines.fetch', {
                    ms: Math.round(performance.now() - t0),
                    records: (res.data?.data || res.data || []).length,
                    bbox: [south, west, north, east],
                    source: res.data?.source || 'overture',
                });
                if (v.isDestroyed() || myGen !== genRef.current) return;
                if (!useTimelineStore.getState().sources.pipelines) return;

                const body = res.data ?? {};
                const records: any[] = Array.isArray(body) ? body : (body.data ?? []);
                const tile: TileState = {
                    collection: null,
                    billboards: [],
                    logicalIds: new Set(),
                };

                if (records.length > 0) {
                    const collection = new Cesium.BillboardCollection({
                        scene: v.scene,
                        blendOption: Cesium.BlendOption.TRANSLUCENT,
                    });

                    for (const rec of records) {
                        const substance: PipelineSubstance = rec.substance === 'gas' ? 'gas' : 'oil';
                        const lat = Number(rec.lat);
                        const lng = Number(rec.lng);
                        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

                        const logicalId = String(rec.id || `overture-pipeline-${key}-${tile.billboards.length}`);
                        if (!pipelineMetaMap.has(logicalId)) {
                            pipelineMetaMap.set(logicalId, {
                                id: logicalId,
                                name: rec.name || `${substance} pipeline`,
                                substance,
                                lat,
                                lng,
                                layer: 'Pipeline',
                                source: 'Overture Maps',
                                description: rec.name || `${substance} pipeline`,
                            });
                            aggregateCountsRef.current[substance] =
                                (aggregateCountsRef.current[substance] || 0) + 1;
                        }
                        logicalRefCountRef.current.set(
                            logicalId,
                            (logicalRefCountRef.current.get(logicalId) || 0) + 1,
                        );
                        tile.logicalIds.add(logicalId);

                        const billboard = collection.add({
                            position: Cesium.Cartesian3.fromDegrees(lng, lat, 0),
                            image: pipelineIcon(substance),
                            scale: 0.82,
                            id: logicalId,
                            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                        });
                        tile.billboards.push({ billboard, substance, logicalId });
                    }

                    if (collection.length > 0) {
                        v.scene.primitives.add(collection);
                        tile.collection = collection;
                    }
                }

                tilesRef.current.set(key, tile);
                applyTileVisibility(tile);
                publishState();

                while (tilesRef.current.size > MAX_LOADED_TILES) {
                    const oldestKey = tilesRef.current.keys().next().value;
                    if (oldestKey === undefined || inFlightCellsRef.current.has(oldestKey)) break;
                    evictTile(v, oldestKey);
                }
            } catch (err: any) {
                if (!axios.isCancel(err) && err?.code !== 'ERR_CANCELED') {
                    console.warn('[Pipelines] Overture viewport fetch failed:', err?.message || err);
                    useTimelineStore.getState().setStreamMetric('pipelines', {
                        status: 'error',
                        speed: 'failed',
                    });
                }
            } finally {
                inFlightCellsRef.current.delete(key);
            }
        },
        [applyTileVisibility, evictTile, publishState],
    );

    const fetchForViewport = useCallback(
        async (v: Cesium.Viewer) => {
            if (v.isDestroyed() || !activeRef.current) return;
            if (!useTimelineStore.getState().sources.pipelines) return;

            const altMeters = getViewerAltitudeMeters(v);
            if (altMeters == null) return;
            if (altMeters / 1000 > PIPELINE_ALTITUDE_CUTOFF_KM) {
                publishState('streaming', 'zoom in');
                return;
            }

            const rect = v.camera.computeViewRectangle();
            if (!rect) return;

            const south = Cesium.Math.toDegrees(rect.south);
            const west = Cesium.Math.toDegrees(rect.west);
            const north = Cesium.Math.toDegrees(rect.north);
            const east = Cesium.Math.toDegrees(rect.east);
            const cells = cellsForViewport(south, west, north, east);
            if (cells.length === 0) return;

            const camCarto = v.camera.positionCartographic;
            const camLat = Cesium.Math.toDegrees(camCarto.latitude);
            const camLng = Cesium.Math.toDegrees(camCarto.longitude);
            const capped = cells
                .map(([s, w, n, e]) => {
                    const cLat = (s + n) / 2;
                    const cLng = (w + e) / 2;
                    const dLat = cLat - camLat;
                    const dLng = wrapLngDelta(cLng, camLng);
                    return { s, w, n, e, d: dLat * dLat + dLng * dLng };
                })
                .sort((a, b) => a.d - b.d)
                .slice(0, MAX_TILES_PER_VIEWPORT);

            const todo = capped.filter((cell) => {
                const key = cellKey(cell.s, cell.w);
                const existing = tilesRef.current.get(key);
                if (existing) {
                    tilesRef.current.delete(key);
                    tilesRef.current.set(key, existing);
                    return false;
                }
                return !inFlightCellsRef.current.has(key);
            });
            if (todo.length === 0) return;

            useTimelineStore.getState().setStreamMetric('pipelines', {
                status: 'connecting',
                speed: 'loading...',
            });

            let cursor = 0;
            const worker = async () => {
                while (true) {
                    if (v.isDestroyed() || !activeRef.current) return;
                    const idx = cursor++;
                    if (idx >= todo.length) return;
                    const cell = todo[idx];
                    await fetchTile(v, cell.s, cell.w, cell.n, cell.e);
                }
            };
            const workers: Promise<void>[] = [];
            for (let i = 0; i < Math.min(FETCH_CONCURRENCY, todo.length); i++) {
                workers.push(worker());
            }
            await Promise.all(workers);
        },
        [fetchTile, publishState],
    );

    useEffect(() => {
        if (!viewer) return;
        activeRef.current = true;
        return () => {
            activeRef.current = false;
            if (debounceRef.current) clearTimeout(debounceRef.current);
            if (!viewer.isDestroyed()) {
                for (const key of Array.from(tilesRef.current.keys())) {
                    evictTile(viewer, key);
                }
            }
            tilesRef.current.clear();
            inFlightCellsRef.current.clear();
            logicalRefCountRef.current.clear();
            aggregateCountsRef.current = emptyCounts();
            pipelineMetaMap.clear();
        };
    }, [viewer, evictTile]);

    useEffect(() => {
        if (!viewer || !isSourceOn || mode === 'playback' || !secondaryReleased) return;
        const v = viewer;

        const onCameraMoveEnd = () => {
            const altMeters = getViewerAltitudeMeters(v);
            const show =
                altMeters != null &&
                altMeters / 1000 <= PIPELINE_ALTITUDE_CUTOFF_KM &&
                useTimelineStore.getState().sources.pipelines &&
                useTimelineStore.getState().visibility.pipelines &&
                useTimelineStore.getState().mode !== 'playback';
            tilesRef.current.forEach((tile) => {
                if (tile.collection) tile.collection.show = show;
            });

            if (debounceRef.current) clearTimeout(debounceRef.current);
            debounceRef.current = setTimeout(() => fetchForViewport(v), 250);
        };

        v.camera.moveEnd.addEventListener(onCameraMoveEnd);
        const initialFetchTimer = setTimeout(() => {
            if (v.isDestroyed() || !activeRef.current) return;
            if (!useTimelineStore.getState().sources.pipelines) return;
            fetchForViewport(v);
        }, 100);

        return () => {
            if (debounceRef.current) clearTimeout(debounceRef.current);
            clearTimeout(initialFetchTimer);
            if (!v.isDestroyed()) v.camera.moveEnd.removeEventListener(onCameraMoveEnd);
        };
    }, [viewer, isSourceOn, mode, secondaryReleased, fetchForViewport]);

    useEffect(() => {
        const show = mode !== 'playback' && isSourceOn && isVisible;
        tilesRef.current.forEach((tile) => {
            if (tile.collection) tile.collection.show = show;
        });
    }, [isSourceOn, isVisible, mode]);

    useEffect(() => {
        tilesRef.current.forEach(applyTileVisibility);
    }, [subtypeVisibility, applyTileVisibility]);

    useEffect(() => {
        if (isSourceOn) return;
        genRef.current++;
        if (!viewer || viewer.isDestroyed()) return;
        for (const key of Array.from(tilesRef.current.keys())) {
            evictTile(viewer, key);
        }
        tilesRef.current.clear();
        inFlightCellsRef.current.clear();
        logicalRefCountRef.current.clear();
        aggregateCountsRef.current = emptyCounts();
        pipelineMetaMap.clear();
        useTimelineStore.getState().setSubtypeCounts('pipelines', {});
        useTimelineStore.getState().setStreamMetric('pipelines', {
            count: 0,
            status: 'disabled',
            speed: '-',
        });
    }, [isSourceOn, viewer, evictTile]);
}
