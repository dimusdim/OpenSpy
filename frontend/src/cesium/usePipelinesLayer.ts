import { useCallback, useEffect, useRef } from 'react';
import * as Cesium from 'cesium';
import axios from 'axios';
import { useTimelineStore } from '../store/useTimelineStore';
import { useSecondaryLoadGate } from './useSecondaryLoadGate';
import { API_URL } from '../lib/config';
import { perfLog } from '../lib/perf-log';
import { INFRA_ICONS } from '../icons/map-icons';
import { getViewerAltitudeMeters } from './position-utils';

type PipelineSubstance = 'oil' | 'gas' | 'water' | 'other';
type PipelineStatus = 'connecting' | 'streaming' | 'warning' | 'error' | 'disabled' | 'auth-missing' | 'degraded' | 'limited' | 'rate-limited';

type PipelineRecord = {
    id?: string;
    name?: string;
    lat?: number;
    lng?: number;
    substance?: string | null;
    rawSubstance?: string | null;
    coordinates?: unknown;
};

export interface PipelineMeta {
    id: string;
    name: string;
    substance: PipelineSubstance;
    rawSubstance?: string | null;
    lat: number;
    lng: number;
    layer: 'Pipeline';
    source: 'Overture Maps';
    description: string;
}

export const pipelineMetaMap = new Map<string, PipelineMeta>();
export const pipelineInstanceToLogical = new Map<string, string>();

type PipelineDebugWindow = Window & {
    __openspyPipelineMetaMap?: typeof pipelineMetaMap;
    __openspyPipelineInstanceToLogical?: typeof pipelineInstanceToLogical;
};

export function pipelineStripPartId(instanceId: string): string {
    const hash = instanceId.indexOf('#');
    return hash === -1 ? instanceId : instanceId.slice(0, hash);
}

const TILE_DEG = 2;
const MAX_LOADED_TILES = 80;
const MAX_TILES_PER_VIEWPORT = 20;
// Overture DuckDB reads are serialized server-side. Extra parallel browser
// requests do not make the local cache faster; they only queue behind
// infrastructure/power-line viewport reads and can hit the HTTP timeout during
// full-context startup. Keep this deliberately narrow and let tiles stream in.
const FETCH_CONCURRENCY = 2;
const PIPELINE_FETCH_TIMEOUT_MS = 70_000;
const PIPELINE_ALTITUDE_CUTOFF_KM = 200;

const PIPELINE_COLORS: Record<PipelineSubstance, Cesium.Color> = {
    oil: Cesium.Color.fromCssColorString('#ef4444').withAlpha(0.78),
    gas: Cesium.Color.fromCssColorString('#38bdf8').withAlpha(0.78),
    water: Cesium.Color.fromCssColorString('#2dd4bf').withAlpha(0.78),
    other: Cesium.Color.fromCssColorString('#facc15').withAlpha(0.72),
};

type TileState = {
    linePrimitive: Cesium.GroundPolylinePrimitive | null;
    fallbackCollection: Cesium.BillboardCollection | null;
    fallbackBillboards: Array<{ billboard: Cesium.Billboard; substance: PipelineSubstance; logicalId: string }>;
    instanceIds: string[];
    logicalIds: Set<string>;
};

function emptyCounts(): Record<string, number> {
    return { oil: 0, gas: 0, water: 0, other: 0 };
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

function normalizeSubstance(raw: unknown): PipelineSubstance {
    const value = String(raw ?? '').toLowerCase();
    if (
        value.includes('gas') ||
        value.includes('methane') ||
        value.includes('lng') ||
        value.includes('lpg') ||
        value.includes('ngl') ||
        value.includes('cng') ||
        value.includes('hydrogen') ||
        value.includes('propane') ||
        value.includes('butane') ||
        value.includes('ethane') ||
        value.includes('ethylene') ||
        value.includes('propylene')
    ) return 'gas';
    if (
        value.includes('oil') ||
        value.includes('petroleum') ||
        value.includes('crude') ||
        value.includes('fuel') ||
        value.includes('hydrocarbon') ||
        value.includes('condensate') ||
        value.includes('naphtha')
    ) return 'oil';
    if (
        value.includes('water') ||
        value.includes('sewer') ||
        value.includes('sewage') ||
        value.includes('drain') ||
        value.includes('steam') ||
        value.includes('brine') ||
        value.includes('heat')
    ) return 'water';
    return 'other';
}

function normalizeLineParts(raw: unknown): [number, number][][] {
    if (!Array.isArray(raw) || raw.length === 0) return [];
    const isFlatLine = Array.isArray(raw[0]) && typeof raw[0][0] === 'number';
    const rawParts = isFlatLine ? [raw] : raw;
    const parts: [number, number][][] = [];

    for (const rawPart of rawParts) {
        if (!Array.isArray(rawPart)) continue;
        const part: [number, number][] = [];
        for (const pair of rawPart) {
            if (!Array.isArray(pair) || pair.length < 2) continue;
            const lat = Number(pair[0]);
            const lng = Number(pair[1]);
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
            part.push([lat, lng]);
        }
        if (part.length >= 2) parts.push(part);
    }

    return parts;
}

function pipelineIcon(substance: PipelineSubstance): string {
    if (substance === 'gas') return INFRA_ICONS.pipeline_gas || INFRA_ICONS.refinery;
    if (substance === 'water') return INFRA_ICONS.pipeline_water || INFRA_ICONS.pipeline_gas || INFRA_ICONS.refinery;
    if (substance === 'other') return INFRA_ICONS.pipeline_other || INFRA_ICONS.refinery;
    return INFRA_ICONS.pipeline_oil || INFRA_ICONS.refinery;
}

export function usePipelinesLayer(viewer: Cesium.Viewer | null) {
    const isSourceOn = useTimelineStore((s) => s.sources.pipelines);
    const isVisible = useTimelineStore((s) => s.visibility.pipelines);
    const mode = useTimelineStore((s) => s.mode);
    const subtypeVisibility = useTimelineStore((s) => s.subtypeVisibility);
    const isolatedEntityId = useTimelineStore((s) => s.isolatedEntityId);
    const secondaryReleased = useSecondaryLoadGate();

    const tilesRef = useRef<Map<string, TileState>>(new Map());
    const inFlightCellsRef = useRef<Set<string>>(new Set());
    const activeRef = useRef(false);
    const genRef = useRef(0);
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const readyTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
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
        const state = useTimelineStore.getState();
        const showLayer =
            state.mode !== 'playback' &&
            state.sources.pipelines &&
            state.visibility.pipelines;
        const vis = state.subtypeVisibility;
        const soloId = state.isolatedEntityId;

        if (tile.linePrimitive) tile.linePrimitive.show = showLayer;
        if (tile.fallbackCollection) tile.fallbackCollection.show = showLayer;

        for (const entry of tile.fallbackBillboards) {
            const subtypeOk = vis[`pipelines:${entry.substance}`] !== false;
            const soloOk = !soloId || soloId === entry.logicalId;
            entry.billboard.show = subtypeOk && soloOk;
        }

        if (!tile.linePrimitive?.ready) return;

        const showOn = Cesium.ShowGeometryInstanceAttribute.toValue(true);
        const showOff = Cesium.ShowGeometryInstanceAttribute.toValue(false);
        for (const instanceId of tile.instanceIds) {
            const logicalId = pipelineInstanceToLogical.get(instanceId) ?? pipelineStripPartId(instanceId);
            const meta = pipelineMetaMap.get(logicalId);
            if (!meta) continue;
            const subtypeOk = vis[`pipelines:${meta.substance}`] !== false;
            const soloOk = !soloId || soloId === logicalId;
            const attrs = tile.linePrimitive.getGeometryInstanceAttributes(instanceId);
            if (attrs) (attrs as { show?: unknown }).show = subtypeOk && soloOk ? showOn : showOff;
        }
    }, []);

    const scheduleReadyApply = useCallback((key: string, tile: TileState) => {
        if (readyTimersRef.current.has(key)) return;
        const tick = () => {
            readyTimersRef.current.delete(key);
            const current = tilesRef.current.get(key);
            if (!current || current !== tile || !activeRef.current) return;
            applyTileVisibility(tile);
            if (tile.linePrimitive && !tile.linePrimitive.ready) {
                readyTimersRef.current.set(key, setTimeout(tick, 80));
            }
        };
        readyTimersRef.current.set(key, setTimeout(tick, 80));
    }, [applyTileVisibility]);

    const evictTile = useCallback((v: Cesium.Viewer, key: string) => {
        const tile = tilesRef.current.get(key);
        if (!tile) return;

        const timer = readyTimersRef.current.get(key);
        if (timer) clearTimeout(timer);
        readyTimersRef.current.delete(key);

        if (!v.isDestroyed()) {
            if (tile.linePrimitive) v.scene.groundPrimitives.remove(tile.linePrimitive);
            if (tile.fallbackCollection) v.scene.primitives.remove(tile.fallbackCollection);
        }
        for (const instanceId of tile.instanceIds) {
            pipelineInstanceToLogical.delete(instanceId);
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

    const registerLogical = useCallback((tile: TileState, logicalId: string, meta: PipelineMeta) => {
        if (!pipelineMetaMap.has(logicalId)) {
            pipelineMetaMap.set(logicalId, meta);
            aggregateCountsRef.current[meta.substance] =
                (aggregateCountsRef.current[meta.substance] || 0) + 1;
        }
        if (!tile.logicalIds.has(logicalId)) {
            logicalRefCountRef.current.set(
                logicalId,
                (logicalRefCountRef.current.get(logicalId) || 0) + 1,
            );
            tile.logicalIds.add(logicalId);
        }
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
                    `${API_URL}/api/pipelines?bbox=${west},${south},${east},${north}`,
                    { timeout: PIPELINE_FETCH_TIMEOUT_MS },
                );
                const body = res.data ?? {};
                const records: PipelineRecord[] = Array.isArray(body) ? body : (body.data ?? []);
                perfLog('pipelines.fetch', {
                    ms: Math.round(performance.now() - t0),
                    records: records.length,
                    bbox: [west, south, east, north],
                    source: body.source || 'overture',
                });
                if (v.isDestroyed() || myGen !== genRef.current) return;
                if (!useTimelineStore.getState().sources.pipelines) return;

                const tile: TileState = {
                    linePrimitive: null,
                    fallbackCollection: null,
                    fallbackBillboards: [],
                    instanceIds: [],
                    logicalIds: new Set(),
                };
                const lineInstances: Cesium.GeometryInstance[] = [];
                let fallbackCollection: Cesium.BillboardCollection | null = null;

                for (const rec of records) {
                    const substance = normalizeSubstance(rec.substance || rec.rawSubstance);
                    const lat = Number(rec.lat);
                    const lng = Number(rec.lng);
                    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

                    const logicalId = String(rec.id || `overture-pipeline-${key}-${tile.logicalIds.size}`);
                    const meta: PipelineMeta = {
                        id: logicalId,
                        name: rec.name || `${substance} pipeline`,
                        substance,
                        rawSubstance: rec.rawSubstance || null,
                        lat,
                        lng,
                        layer: 'Pipeline',
                        source: 'Overture Maps',
                        description: rec.name || `${substance} pipeline`,
                    };
                    registerLogical(tile, logicalId, meta);

                    const parts = normalizeLineParts(rec.coordinates);
                    if (parts.length > 0) {
                        parts.forEach((part, partIdx) => {
                            const degreesFlat: number[] = [];
                            for (const pt of part) {
                                degreesFlat.push(pt[1], pt[0]);
                            }
                            if (degreesFlat.length < 4) return;

                            const instanceId = parts.length === 1
                                ? logicalId
                                : `${logicalId}#${partIdx}`;
                            pipelineInstanceToLogical.set(instanceId, logicalId);
                            tile.instanceIds.push(instanceId);
                            lineInstances.push(new Cesium.GeometryInstance({
                                geometry: new Cesium.GroundPolylineGeometry({
                                    positions: Cesium.Cartesian3.fromDegreesArray(degreesFlat),
                                    width: 4.0,
                                }),
                                attributes: {
                                    color: Cesium.ColorGeometryInstanceAttribute.fromColor(PIPELINE_COLORS[substance]),
                                    show: new Cesium.ShowGeometryInstanceAttribute(true),
                                },
                                id: instanceId,
                            }));
                        });
                        continue;
                    }

                    if (!fallbackCollection) {
                        fallbackCollection = new Cesium.BillboardCollection({
                            scene: v.scene,
                            blendOption: Cesium.BlendOption.TRANSLUCENT,
                        });
                    }
                    const billboard = fallbackCollection.add({
                        position: Cesium.Cartesian3.fromDegrees(lng, lat, 0),
                        image: pipelineIcon(substance),
                        scale: 0.82,
                        id: logicalId,
                        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                    });
                    tile.fallbackBillboards.push({ billboard, substance, logicalId });
                }

                if (lineInstances.length > 0) {
                    const primitive = new Cesium.GroundPolylinePrimitive({
                        geometryInstances: lineInstances,
                        appearance: new Cesium.PolylineColorAppearance(),
                        releaseGeometryInstances: false,
                    });
                    v.scene.groundPrimitives.add(primitive);
                    tile.linePrimitive = primitive;
                }

                if (fallbackCollection && fallbackCollection.length > 0) {
                    v.scene.primitives.add(fallbackCollection);
                    tile.fallbackCollection = fallbackCollection;
                }

                tilesRef.current.set(key, tile);
                applyTileVisibility(tile);
                if (tile.linePrimitive && !tile.linePrimitive.ready) scheduleReadyApply(key, tile);
                publishState();

                while (tilesRef.current.size > MAX_LOADED_TILES) {
                    const oldestKey = tilesRef.current.keys().next().value;
                    if (oldestKey === undefined || inFlightCellsRef.current.has(oldestKey)) break;
                    evictTile(v, oldestKey);
                }
            } catch (err: unknown) {
                const errorCode = typeof err === 'object' && err && 'code' in err ? String((err as { code?: unknown }).code) : '';
                const message = err instanceof Error ? err.message : String(err);
                if (!axios.isCancel(err) && errorCode !== 'ERR_CANCELED') {
                    console.warn('[Pipelines] Overture viewport fetch failed:', message);
                    useTimelineStore.getState().setStreamMetric('pipelines', {
                        status: 'error',
                        speed: 'failed',
                    });
                }
            } finally {
                inFlightCellsRef.current.delete(key);
            }
        },
        [applyTileVisibility, evictTile, publishState, registerLogical, scheduleReadyApply],
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
        const debugWindow = window as PipelineDebugWindow;
        debugWindow.__openspyPipelineMetaMap = pipelineMetaMap;
        debugWindow.__openspyPipelineInstanceToLogical = pipelineInstanceToLogical;
        const readyTimers = readyTimersRef.current;
        const tiles = tilesRef.current;
        const inFlightCells = inFlightCellsRef.current;
        const logicalRefCounts = logicalRefCountRef.current;
        return () => {
            activeRef.current = false;
            if (debounceRef.current) clearTimeout(debounceRef.current);
            Array.from(readyTimers.values()).forEach((timer) => clearTimeout(timer));
            readyTimers.clear();
            if (!viewer.isDestroyed()) {
                for (const key of Array.from(tiles.keys())) {
                    evictTile(viewer, key);
                }
            }
            tiles.clear();
            inFlightCells.clear();
            logicalRefCounts.clear();
            aggregateCountsRef.current = emptyCounts();
            pipelineMetaMap.clear();
            pipelineInstanceToLogical.clear();
            delete debugWindow.__openspyPipelineMetaMap;
            delete debugWindow.__openspyPipelineInstanceToLogical;
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
                if (tile.linePrimitive) tile.linePrimitive.show = show;
                if (tile.fallbackCollection) tile.fallbackCollection.show = show;
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
        tilesRef.current.forEach(applyTileVisibility);
    }, [isSourceOn, isVisible, mode, subtypeVisibility, isolatedEntityId, applyTileVisibility]);

    useEffect(() => {
        if (isSourceOn) return;
        genRef.current++;
        if (!viewer || viewer.isDestroyed()) return;
        Array.from(readyTimersRef.current.values()).forEach((timer) => clearTimeout(timer));
        readyTimersRef.current.clear();
        for (const key of Array.from(tilesRef.current.keys())) {
            evictTile(viewer, key);
        }
        tilesRef.current.clear();
        inFlightCellsRef.current.clear();
        logicalRefCountRef.current.clear();
        aggregateCountsRef.current = emptyCounts();
        pipelineMetaMap.clear();
        pipelineInstanceToLogical.clear();
        useTimelineStore.getState().setSubtypeCounts('pipelines', {});
        useTimelineStore.getState().setStreamMetric('pipelines', {
            count: 0,
            status: 'disabled',
            speed: '-',
        });
    }, [isSourceOn, viewer, evictTile]);
}
