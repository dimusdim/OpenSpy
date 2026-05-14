import { useEffect, useRef, useState } from 'react';
import * as Cesium from 'cesium';
import axios from 'axios';
import { useTimelineStore } from '../store/useTimelineStore';
import { useSecondaryLoadGate } from './useSecondaryLoadGate';
import { API_URL } from '../lib/config';
import { getIconOpacity, getIconScale, getSatBillboardImage } from '../icons/map-icons';
import { isFiniteCartesian } from './position-utils';
import { createSatellitePositionsSAB, type SatellitePositionsSAB } from './satellitePositionsSAB';
import {
    clearSatelliteApplySource,
    destroySatelliteApplyManager,
    setSatelliteApplySource,
    type SatelliteApplySlot,
} from './satelliteApplyManager';

// ---------------------------------------------------------------------------
// Footprint types & registry (unchanged — used by Globe.tsx picking)
// ---------------------------------------------------------------------------
// Match the live SGP4 worker cadence. Updating footprints faster just
// recomputes the same billboard positions while allocating Entity geometry.
const FOOTPRINT_UPDATE_MS = 2000;
const FOOTPRINT_RAY_COUNT = 8;

export interface SatelliteFootprintMeta {
    parentSatId: string;
    satName: string;
    subtype: string;
    sensorName: string;
    sensorType: 'OPTICAL' | 'SAR' | 'OTHER';
    swathMeters: number;
    source: string;
}
export const satelliteFootprintMetaMap = new Map<string, SatelliteFootprintMeta>();

// Satellite metadata registry for picking (same pattern as aircraftMetaMap)
export interface SatelliteMeta {
    id: string;          // sat-{noradId}
    name: string;
    noradId: number;
    type: string;        // military/commercial/civilian
    subtype: string;     // military/commercial/civilian/recon
    position?: Cesium.Cartesian3;
    lat?: number;
    lng?: number;
    alt?: number;
    recon?: boolean;
    reconMeta?: any;
    sensor?: any;
    tleEpochAt?: string | null;
    fetchedAt?: string | null;
    provider?: string | null;
    motionConfidence?: string | null;
    motionAgeSec?: number | null;
    motionValiditySec?: number | null;
}
export const satelliteMetaMap = new Map<string, SatelliteMeta>();

// ---------------------------------------------------------------------------
// Per-footprint mutable state
// ---------------------------------------------------------------------------
interface FootprintState {
    satId: string;       // sat-{noradId}
    noradId: number;
    ellipseEntity: Cesium.Entity;
    rayStates: FootprintRayState[];
    radiusMeters: number;
}

interface FootprintConfig {
    satId: string;
    noradId: number;
    radiusMeters: number;
    baseColor: Cesium.Color;
    meta: SatelliteFootprintMeta;
    cartoScratch: Cesium.Cartographic;
    nadirScratch: Cesium.Cartesian3;
}

type FootprintRayPositions = [Cesium.Cartesian3, Cesium.Cartesian3];

interface FootprintRayState {
    entity: Cesium.Entity;
    start: Cesium.Cartesian3;
    end: Cesium.Cartesian3;
    positionsA: FootprintRayPositions;
    positionsB: FootprintRayPositions;
    usePositionsA: boolean;
}

// How often to post 'tick' to the Worker (ms). 2 seconds is smooth enough —
// LEO satellites move ~15 km/s, so 2s = 30 km drift, sub-pixel at global zoom.
const WORKER_TICK_INTERVAL = 2000;
const LIVE_TRAIL_MAX_SATS = 900;
const LIVE_TRAIL_WINDOW_MINUTES = 120;
const LIVE_TRAIL_STEP_SECONDS = 180;

function writeFootprintPerimeterPoint(
    lon1: number,
    sinLat1: number,
    cosLat1: number,
    cosAng: number,
    sinAng: number,
    angleRad: number,
    result: Cesium.Cartesian3,
): Cesium.Cartesian3 {
    const lat2 = Math.asin(sinLat1 * cosAng + cosLat1 * sinAng * Math.cos(angleRad));
    const lon2 = lon1 + Math.atan2(
        Math.sin(angleRad) * sinAng * cosLat1,
        cosAng - sinLat1 * Math.sin(lat2),
    );
    return Cesium.Cartesian3.fromRadians(lon2, lat2, 0, undefined, result);
}

function getSatelliteBillboardShow(
    state: ReturnType<typeof useTimelineStore.getState>,
    entityId: string,
    subtype: string | undefined
): boolean {
    if (state.mode === 'playback') return false;
    if (!state.sources.satellites || !state.visibility.satellites) return false;
    if (state.isolatedEntityId && state.isolatedEntityId !== entityId) return false;
    if (!subtype) return true;
    return state.subtypeVisibility[`satellites:${subtype}`] !== false;
}

export function useSatellitesLayer(viewer: Cesium.Viewer | null) {
    const isSourceOn = useTimelineStore(s => s.sources.satellites);
    const isVisible = useTimelineStore(s => s.visibility.satellites);
    const satelliteRenderLimit = useTimelineStore(s => s.satelliteRenderLimit);
    const secondaryReleased = useSecondaryLoadGate();

    // BillboardCollection for satellite icons (Phase 2)
    const billboardCollectionRef = useRef<Cesium.BillboardCollection | null>(null);
    // Map: noradId → Billboard reference for position updates
    const billboardMapRef = useRef<Map<number, Cesium.Billboard>>(new Map());
    // Batched orbit trails — one GPU draw call
    const trailsPrimitiveRef = useRef<Cesium.Primitive | null>(null);
    // Worker pool ref. Full satellite catalog stays loaded; the pool only
    // parallelizes SGP4 parse/tick work across shards.
    const workerRefsRef = useRef<Worker[]>([]);
    // Tick interval ref
    const tickIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    // Raw satellite data from API (for footprints + metadata)
    const satDataRef = useRef<any[]>([]);
    // Bumped after Worker finishes initial orbit propagation
    const [satellitesLoadedTick, setSatellitesLoadedTick] = useState(0);
    const positionsSabRef = useRef<SatellitePositionsSAB | null>(null);
    const positionsReadyRef = useRef(false);
    const positionScratchRef = useRef<Map<number, Cesium.Cartesian3>>(new Map());
    const applySlotsRef = useRef<SatelliteApplySlot[]>([]);
    const trailRequestNonceRef = useRef(0);
    const lastTrailKeyRef = useRef<string | null>(null);
    const trailAggregationRef = useRef<Map<number, {
        expected: number;
        responses: number;
        sampleCount: number;
        results: { noradId: number; positions: Float64Array; validSamples: number }[];
    }>>(new Map());

    // Footprint state
    const footprintDsRef = useRef<Cesium.CustomDataSource | null>(null);
    const footprintStatesRef = useRef<Map<number, FootprintState>>(new Map());
    const footprintTickRemoveRef = useRef<Cesium.Event.RemoveCallback | null>(null);

    const isFootprintSourceOn = useTimelineStore(s => s.sources.satelliteFootprints);
    const isFootprintVisible = useTimelineStore(s => s.visibility.satelliteFootprints);
    const mode = useTimelineStore(s => s.mode);
    const requestSceneRender = () => {
        if (!viewer || viewer.isDestroyed()) return;
        viewer.scene.requestRender();
    };

    const removeTrailPrimitive = () => {
        if (!viewer || viewer.isDestroyed() || !trailsPrimitiveRef.current) return;
        viewer.scene.primitives.remove(trailsPrimitiveRef.current);
        trailsPrimitiveRef.current = null;
        lastTrailKeyRef.current = null;
    };

    const getViewportTrailNoradIds = (): number[] => {
        const bc = billboardCollectionRef.current;
        if (!viewer || viewer.isDestroyed() || !bc) return [];
        const rect = viewer.camera.computeViewRectangle();
        let south = -90;
        let north = 90;
        let west = -180;
        let east = 180;
        let hasRect = false;
        if (rect) {
            south = Cesium.Math.toDegrees(rect.south);
            north = Cesium.Math.toDegrees(rect.north);
            west = Cesium.Math.toDegrees(rect.west);
            east = Cesium.Math.toDegrees(rect.east);
            hasRect = Number.isFinite(south) && Number.isFinite(north) && Number.isFinite(west) && Number.isFinite(east);
        }
        const crossAM = hasRect && east < west;
        const ids: number[] = [];
        for (let i = 0; i < bc.length && ids.length < LIVE_TRAIL_MAX_SATS; i += 1) {
            const bb = bc.get(i);
            if (!bb || !bb.show) continue;
            const meta = satelliteMetaMap.get(bb.id as string);
            if (!meta || !Number.isFinite(meta.noradId)) continue;
            if (hasRect) {
                const carto = Cesium.Cartographic.fromCartesian(bb.position);
                if (!carto) continue;
                const lat = Cesium.Math.toDegrees(carto.latitude);
                const lng = Cesium.Math.toDegrees(carto.longitude);
                const inLat = lat >= south && lat <= north;
                const inLng = crossAM ? lng >= west || lng <= east : lng >= west && lng <= east;
                if (!inLat || !inLng) continue;
            }
            ids.push(meta.noradId);
        }
        if (ids.length > 0) return ids;
        return satDataRef.current
            .filter((sat) => Number.isFinite(Number(sat.noradId)))
            .slice(0, LIVE_TRAIL_MAX_SATS)
            .map((sat) => Number(sat.noradId));
    };

    const requestTrailRebuild = () => {
        const workers = workerRefsRef.current;
        if (workers.length === 0) return;
        const state = useTimelineStore.getState();
        if (state.mode === 'playback' || !state.showTrajectories || !state.sources.satellites || !state.visibility.satellites) {
            removeTrailPrimitive();
            return;
        }
        const noradIds = getViewportTrailNoradIds();
        if (noradIds.length === 0) {
            removeTrailPrimitive();
            return;
        }
        const trailKey = noradIds.join(',');
        if (lastTrailKeyRef.current === trailKey && trailsPrimitiveRef.current) return;
        lastTrailKeyRef.current = trailKey;
        const nonce = trailRequestNonceRef.current + 1;
        trailRequestNonceRef.current = nonce;
        trailAggregationRef.current.set(nonce, {
            expected: workers.length,
            responses: 0,
            sampleCount: 0,
            results: [],
        });
        for (const worker of workers) {
            worker.postMessage({
                type: 'propagate',
                nonce,
                noradIds,
                epochMs: Date.now(),
                windowMinutes: LIVE_TRAIL_WINDOW_MINUTES,
                stepSeconds: LIVE_TRAIL_STEP_SECONDS,
            });
        }
    };

    // ---- Effect 1: BillboardCollection + trails primitive lifetime ----
    useEffect(() => {
        if (!viewer) return;

        const bc = new Cesium.BillboardCollection({
            scene: viewer.scene,
            blendOption: Cesium.BlendOption.TRANSLUCENT,
        });
        viewer.scene.primitives.add(bc);
        billboardCollectionRef.current = bc;

        return () => {
            if (viewer && !viewer.isDestroyed()) {
                viewer.scene.primitives.remove(bc);
                if (trailsPrimitiveRef.current) {
                    viewer.scene.primitives.remove(trailsPrimitiveRef.current);
                }
                if (viewer && !viewer.isDestroyed()) clearSatelliteApplySource(viewer.scene, 'live');
                destroySatelliteApplyManager(viewer.scene);
            }
            billboardCollectionRef.current = null;
            billboardMapRef.current.clear();
            trailsPrimitiveRef.current = null;
            satelliteMetaMap.clear();
            positionsSabRef.current = null;
            positionScratchRef.current.clear();
            applySlotsRef.current = [];
        };
    }, [viewer]);

    // ---- Effect 2: fetch + Worker lifecycle ----
    useEffect(() => {
        if (!viewer || !isSourceOn || !secondaryReleased) return;
        let active = true;

        async function init() {
            const bc = billboardCollectionRef.current;
            if (!bc) return;

            try {
                const limitParam = satelliteRenderLimit == null ? 'all' : String(satelliteRenderLimit);
                const res = await axios.get(`${API_URL}/api/satellites?limit=${encodeURIComponent(limitParam)}`);
                if (!active) return;

                const sats = res.data as any[];
                satDataRef.current = sats;
                positionsReadyRef.current = false;
                useTimelineStore.getState().setStreamMetric('satellites', {
                    count: sats.length,
                    status: 'streaming',
                    note: satelliteRenderLimit == null
                        ? 'Showing full visible catalog'
                        : `Showing ${sats.length} satellites (limit ${satelliteRenderLimit})`,
                });

                // Clear old billboards
                bc.removeAll();
                billboardMapRef.current.clear();
                satelliteMetaMap.clear();
                positionScratchRef.current.clear();
                applySlotsRef.current = [];
                if (viewer && !viewer.isDestroyed()) clearSatelliteApplySource(viewer.scene, 'live');

                if (typeof SharedArrayBuffer === 'undefined' || !(self as any).crossOriginIsolated) {
                    throw new Error('SharedArrayBuffer is unavailable. crossOriginIsolated must be true before satellites init.');
                }
                const sabState = createSatellitePositionsSAB(sats.length);
                positionsSabRef.current = sabState;

                // Start workers before the main-thread billboard build. SGP4
                // TLE parsing/ticks are sharded, while every shard writes into
                // the same full-catalog SAB by global satellite index.
                workerRefsRef.current.forEach((existing) => existing.terminate());
                workerRefsRef.current = [];
                trailAggregationRef.current.clear();
                let readyWorkers = 0;
                let tickSeq = 0;
                const tickAggregation = new Map<number, { expected: number; responses: number; epochMs: number }>();
                const workerCount = Math.min(4, Math.max(1, Math.ceil(sats.length / 6000)));
                const shardSize = Math.ceil(sats.length / workerCount);
                const expectedWorkerCount = Math.ceil(sats.length / shardSize);
                const sendLiveTickToAll = () => {
                    if (useTimelineStore.getState().mode === 'playback') return;
                    const workers = workerRefsRef.current;
                    if (workers.length === 0 || readyWorkers < expectedWorkerCount) return;
                    const tickId = ++tickSeq;
                    const currentTimeMs = Date.now();
                    tickAggregation.set(tickId, {
                        expected: workers.length,
                        responses: 0,
                        epochMs: currentTimeMs,
                    });
                    for (const worker of workers) {
                        worker.postMessage({ type: 'tick', tickId, currentTimeMs });
                    }
                };

                const handleWorkerMessage = (worker: Worker, shardIndex: number) => (e: MessageEvent) => {
                    if (!active) return;
                    const msg = e.data;

                    if (msg.type === 'ready') {
                        readyWorkers += 1;
                        console.log(`[Satellites] Worker ${shardIndex + 1}/${expectedWorkerCount} ready (${readyWorkers}/${expectedWorkerCount}), ${msg.count} satrecs initialized`);
                        // Codex 2026-04-24: trails build = 2.31M Cartesian3 + 19k
                        // GeometryInstance с releaseGeometryInstances:false.
                        // Раньше всегда запускалось — после снятия 5000 cap это
                        // дало Chrome OOM 52 GB. Trails строим только когда
                        // mode=live И пользователь их показывает (showTrajectories).
                        // Start position ticks only after every shard is
                        // ready. Each tick writes full catalog positions into
                        // the shared buffer, then we apply once on the next
                        // Cesium render instead of applying per-shard.
                        if (readyWorkers >= expectedWorkerCount && !tickIntervalRef.current) {
                            sendLiveTickToAll();
                            tickIntervalRef.current = setInterval(sendLiveTickToAll, WORKER_TICK_INTERVAL);
                        }
                    }

                    if (msg.type === 'positions') {
                        const tickId = Number(msg.tickId);
                        const aggregate = tickAggregation.get(tickId);
                        if (!aggregate) return;
                        aggregate.responses += 1;
                        if (aggregate.responses < aggregate.expected) return;
                        tickAggregation.delete(tickId);
                        if (positionsSabRef.current) {
                            positionsSabRef.current.epochMs = aggregate.epochMs;
                        }
                        if (!positionsReadyRef.current) {
                            positionsReadyRef.current = true;
                            setSatellitesLoadedTick(t => t + 1);
                        }
                        if (!trailsPrimitiveRef.current && useTimelineStore.getState().showTrajectories) {
                            requestTrailRebuild();
                        }
                        requestSceneRender();
                    }

                    if (msg.type === 'orbits') {
                        const nonce = Number(msg.nonce);
                        if (nonce !== trailRequestNonceRef.current) return;
                        const aggregate = trailAggregationRef.current.get(nonce);
                        if (!aggregate) return;
                        aggregate.responses += 1;
                        aggregate.sampleCount = Number(msg.sampleCount) || aggregate.sampleCount;
                        if (Array.isArray(msg.results)) {
                            aggregate.results.push(...msg.results);
                        }
                        if (aggregate.responses < aggregate.expected) return;
                        trailAggregationRef.current.delete(nonce);
                        // Build batched trail primitive from Worker orbit data
                        if (!viewer || viewer.isDestroyed()) return;
                        const results = aggregate.results;
                        const sampleCount = aggregate.sampleCount;
                        const trailInstances: Cesium.GeometryInstance[] = [];

                        for (const r of results) {
                            if (r.validSamples < 2) continue;
                            const meta = satelliteMetaMap.get(`sat-${r.noradId}`);
                            const isRecon = meta?.recon;
                            const satType = meta?.type || 'civilian';

                            const trailColor = isRecon
                                ? Cesium.Color.fromCssColorString('#f59e0b').withAlpha(0.5)
                                : satType === 'military' ? Cesium.Color.RED.withAlpha(0.3)
                                : satType === 'commercial' ? Cesium.Color.CYAN.withAlpha(0.3)
                                : Cesium.Color.LIME.withAlpha(0.3);

                            const positions: Cesium.Cartesian3[] = [];
                            for (let j = 0; j < sampleCount; j++) {
                                const lon = r.positions[j * 3];
                                if (isNaN(lon)) continue;
                                positions.push(Cesium.Cartesian3.fromDegrees(
                                    lon, r.positions[j * 3 + 1], r.positions[j * 3 + 2]
                                ));
                            }
                            if (positions.length < 2) continue;

                            const entityId = `sat-${r.noradId}`;
                            trailInstances.push(new Cesium.GeometryInstance({
                                geometry: new Cesium.PolylineGeometry({
                                    positions,
                                    width: isRecon ? 2.5 : 1.5,
                                    vertexFormat: Cesium.PolylineColorAppearance.VERTEX_FORMAT,
                                }),
                                attributes: {
                                    color: Cesium.ColorGeometryInstanceAttribute.fromColor(trailColor),
                                    show: new Cesium.ShowGeometryInstanceAttribute(true),
                                },
                                id: entityId,
                            }));
                        }

                        // Remove old trail primitive
                        if (trailsPrimitiveRef.current) {
                            viewer.scene.primitives.remove(trailsPrimitiveRef.current);
                            trailsPrimitiveRef.current = null;
                        }

                        if (trailInstances.length > 0) {
                            const trailsPrimitive = new Cesium.Primitive({
                                geometryInstances: trailInstances,
                                appearance: new Cesium.PolylineColorAppearance({ translucent: true }),
                                // Codex 2026-04-24: было false — Cesium держал
                                // CPU-side geometry (19k PolylineGeometry +
                                // 2.31M Cartesian3) после GPU upload → вклад
                                // в OOM. Отпускаем после компиляции. setVisible
                                // использует getGeometryInstanceAttributes(id) —
                                // batch table остаётся после release, attrs работают.
                                releaseGeometryInstances: true,
                                asynchronous: true,
                            });
                            const freshState = useTimelineStore.getState();
                            trailsPrimitive.show =
                                freshState.visibility.satellites && freshState.showTrajectories;
                            viewer.scene.primitives.add(trailsPrimitive);
                            trailsPrimitiveRef.current = trailsPrimitive;
                        }

                        console.log(`[Satellites] ${trailInstances.length} orbital trails built from viewport subset`);
                        setSatellitesLoadedTick(t => t + 1);
                        requestSceneRender();
                    }
                };

                for (let shardIndex = 0; shardIndex < workerCount; shardIndex += 1) {
                    const start = shardIndex * shardSize;
                    const shard = sats.slice(start, start + shardSize);
                    if (shard.length === 0) continue;
                    const worker = new Worker(
                        new URL('./satellite-worker.ts', import.meta.url)
                    );
                    workerRefsRef.current.push(worker);
                    worker.onmessage = handleWorkerMessage(worker, shardIndex);
                    worker.postMessage({
                        type: 'init',
                        sab: sabState.sab,
                        satellites: shard.map((s, offset) => ({
                            index: start + offset,
                            noradId: s.noradId,
                            name: s.name,
                            tleLine1: s.tleLine1,
                            tleLine2: s.tleLine2,
                            type: s.type,
                            recon: s.recon,
                        })),
                    });
                }
                console.log(`[Satellites] Worker pool started: ${workerRefsRef.current.length} shards for ${sats.length} satellites`);

                const iconPromises = new Map<string, Promise<HTMLImageElement>>();
                for (const sat of sats) {
                    const iconKey = sat.recon === true ? 'recon' : (sat.type || 'civilian');
                    if (!iconPromises.has(iconKey)) {
                        iconPromises.set(iconKey, getSatBillboardImage(sat.type, sat.recon === true));
                    }
                }
                const iconEntries = await Promise.all(
                    Array.from(iconPromises.entries(), async ([key, promise]) => [key, await promise] as const)
                );
                if (!active) return;
                const iconByKey = new Map(iconEntries);
                const fallbackIcon = iconByKey.get('civilian')
                    || iconByKey.values().next().value
                    || await getSatBillboardImage('civilian', false);

                const billboardStartedAt = performance.now();

                // Build index and metadata
                const noradToIndex = new Map<number, number>();
                for (let i = 0; i < sats.length; i++) {
                    const sat = sats[i];
                    const isRecon = sat.recon === true;
                    const subtype = isRecon ? 'recon' : sat.type;
                    const entityId = `sat-${sat.noradId || sat.name}`;
                    noradToIndex.set(sat.noradId, i);
                    sabState.indexById.set(entityId, i);

                    // Register metadata for picking (Globe.tsx)
                    const meta: SatelliteMeta = {
                        id: entityId,
                        name: sat.name,
                        noradId: sat.noradId,
                        type: sat.type,
                        subtype,
                        recon: isRecon,
                        reconMeta: sat.reconMeta,
                        sensor: sat.sensor,
                    };
                    satelliteMetaMap.set(entityId, meta);

                    // Create billboard (initially at 0,0,0 — Worker will set real position)
                    const iconKey = isRecon ? 'recon' : (sat.type || 'civilian');
                    const icon = iconByKey.get(iconKey) || fallbackIcon;
                    const bb = bc.add({
                        position: Cesium.Cartesian3.ZERO,
                        image: icon,
                        scale: getIconScale('satellites', iconKey, isRecon ? 1.8 : 1.4),
                        color: Cesium.Color.WHITE.withAlpha(getIconOpacity('satellites', iconKey)),
                        show: false, // hidden until first Worker tick
                        id: entityId,
                    });
                    billboardMapRef.current.set(sat.noradId, bb);
                    const scratch = new Cesium.Cartesian3();
                    positionScratchRef.current.set(sat.noradId, scratch);
                    meta.position = scratch;
                    applySlotsRef.current.push({
                        index: i,
                        targetId: entityId,
                        billboard: bb,
                        scratch,
                        getVisible: () => getSatelliteBillboardShow(useTimelineStore.getState(), entityId, subtype),
                    });
                }
                console.log(`[Satellites] ${sats.length} billboards created in ${Math.round(performance.now() - billboardStartedAt)}ms`);

                if (!viewer || viewer.isDestroyed()) return;
                setSatelliteApplySource(viewer.scene, 'live', {
                    measureName: 'satellite-apply-main',
                    // Visibility is handled by the reactive visibility effects
                    // and by the first satellitesLoadedTick pass. Keeping it
                    // out of the continuous position apply avoids 20k
                    // getState/getVisible calls every satellite epoch.
                    applyVisibility: false,
                    isActive: () => useTimelineStore.getState().mode !== 'playback',
                    getState: () => ({
                        sab: positionsSabRef.current,
                        slots: applySlotsRef.current,
                        epochMs: positionsSabRef.current && Number.isFinite(positionsSabRef.current.epochMs)
                            ? positionsSabRef.current.epochMs
                            : null,
                    }),
                });

            } catch (err: any) {
                console.error('Failed to load satellites layer', err);
                useTimelineStore.getState().setStreamMetric('satellites', { status: 'error' });
            }
        }

        init();

        return () => {
            active = false;
            if (tickIntervalRef.current) {
                clearInterval(tickIntervalRef.current);
                tickIntervalRef.current = null;
            }
            workerRefsRef.current.forEach((worker) => worker.terminate());
            workerRefsRef.current = [];
            trailAggregationRef.current.clear();
            if (viewer && !viewer.isDestroyed()) clearSatelliteApplySource(viewer.scene, 'live');
            positionsReadyRef.current = false;
        };
    }, [viewer, isSourceOn, satelliteRenderLimit, secondaryReleased]);

    // ---- Effect 3: footprint overlay build + discrete update tick ----
    // Footprints still use Entity API (only ~53 satellites with sensor data).
    // Positions come from billboardMapRef instead of Entity.position.
    useEffect(() => {
        if (!viewer) return;
        if (satellitesLoadedTick === 0) return;
        if (!isFootprintSourceOn) return;

        const sats = satDataRef.current;
        if (!sats.length) return;

        // Remove old footprint DS
        const oldDs = viewer.dataSources.getByName('sat-footprints')[0];
        if (oldDs) viewer.dataSources.remove(oldDs);
        if (footprintTickRemoveRef.current) {
            footprintTickRemoveRef.current();
            footprintTickRemoveRef.current = null;
        }

        const fpDs = new Cesium.CustomDataSource('sat-footprints');
        const initialTimelineState = useTimelineStore.getState();
        fpDs.show = initialTimelineState.mode !== 'playback'
            && initialTimelineState.sources.satelliteFootprints
            && initialTimelineState.visibility.satelliteFootprints;
        viewer.dataSources.add(fpDs);
        footprintDsRef.current = fpDs;
        satelliteFootprintMetaMap.clear();
        const states = new Map<number, FootprintState>();
        const configs: FootprintConfig[] = [];

        for (const sat of sats) {
            if (!sat.sensor || !sat.sensor.swathMeters || sat.sensor.swathMeters <= 0) continue;

            const isRecon = sat.recon === true;
            const subtype = isRecon ? 'recon' : sat.type;
            const entityId = `sat-${sat.noradId || sat.name}`;

            const baseColor = subtype === 'military' || subtype === 'recon' ? Cesium.Color.RED
                : subtype === 'commercial' ? Cesium.Color.CYAN
                : Cesium.Color.LIME;

            const radiusMeters = sat.sensor.swathMeters / 2;

            const fpMeta: SatelliteFootprintMeta = {
                parentSatId: entityId,
                satName: sat.name,
                subtype,
                sensorName: sat.sensor.sensorName || '',
                sensorType: sat.sensor.sensorType || 'OTHER',
                swathMeters: sat.sensor.swathMeters,
                source: sat.sensor.source || 'spectator-earth',
            };

            configs.push({
                satId: entityId,
                noradId: sat.noradId,
                radiusMeters,
                baseColor,
                meta: fpMeta,
                cartoScratch: new Cesium.Cartographic(),
                nadirScratch: new Cesium.Cartesian3(),
            });
        }

        footprintStatesRef.current = states;

        // Discrete update tick — read positions from BillboardCollection
        let lastUpdateMs = 0;
        let lastPositionEpochMs: number | null = null;
        const R_EARTH = 6_371_000;
        const bbMap = billboardMapRef.current;

        const onTick = () => {
            const timelineState = useTimelineStore.getState();
            if (timelineState.mode === 'playback') return;
            if (!timelineState.sources.satelliteFootprints || !timelineState.visibility.satelliteFootprints) return;
            const nowMs = Date.now();
            if (nowMs - lastUpdateMs < FOOTPRINT_UPDATE_MS) return;
            const positionEpochMs = positionsSabRef.current?.epochMs ?? null;
            const hasPositionEpoch = typeof positionEpochMs === 'number' && Number.isFinite(positionEpochMs);
            if (hasPositionEpoch && positionEpochMs === lastPositionEpochMs) return;
            lastUpdateMs = nowMs;
            let updated = false;

            for (const cfg of configs) {
                const bb = bbMap.get(cfg.noradId);
                if (!bb || !bb.show) continue;
                const satPos = bb.position;
                if (!isFiniteCartesian(satPos) || Cesium.Cartesian3.equals(satPos, Cesium.Cartesian3.ZERO)) continue;

                const carto = Cesium.Cartographic.fromCartesian(satPos, undefined, cfg.cartoScratch);
                if (!carto) continue;
                const lat1 = carto.latitude;
                const lon1 = carto.longitude;
                const nadir = Cesium.Cartesian3.fromRadians(lon1, lat1, 0, undefined, cfg.nadirScratch);
                if (!isFiniteCartesian(nadir)) continue;
                const angDist = cfg.radiusMeters / R_EARTH;
                const sinLat1 = Math.sin(lat1);
                const cosLat1 = Math.cos(lat1);
                const cosAng = Math.cos(angDist);
                const sinAng = Math.sin(angDist);

                let st = states.get(cfg.noradId);
                if (!st) {
                    const footprintId = `fp-${cfg.satId}`;
                    const ellipseEntity = fpDs.entities.add({
                        id: footprintId,
                        position: new Cesium.ConstantPositionProperty(nadir),
                        ellipse: {
                            semiMinorAxis: cfg.radiusMeters,
                            semiMajorAxis: cfg.radiusMeters,
                            material: new Cesium.ColorMaterialProperty(cfg.baseColor.withAlpha(0.08)),
                            height: 0,
                            outline: true,
                            outlineColor: cfg.baseColor.withAlpha(0.5),
                            outlineWidth: 1,
                        },
                    });
                    satelliteFootprintMetaMap.set(footprintId, cfg.meta);

                    const rayStates: FootprintRayState[] = [];
                    for (let k = 0; k < FOOTPRINT_RAY_COUNT; k++) {
                        const angleRad = (k / FOOTPRINT_RAY_COUNT) * 2 * Math.PI;
                        const rayStart = Cesium.Cartesian3.clone(satPos, new Cesium.Cartesian3());
                        const rayEnd = writeFootprintPerimeterPoint(
                            lon1,
                            sinLat1,
                            cosLat1,
                            cosAng,
                            sinAng,
                            angleRad,
                            new Cesium.Cartesian3(),
                        );
                        const positionsA: FootprintRayPositions = [rayStart, rayEnd];
                        const positionsB: FootprintRayPositions = [rayStart, rayEnd];
                        const rayId = `beam-${cfg.satId}#${k}`;
                        const rayEntity = fpDs.entities.add({
                            id: rayId,
                            polyline: {
                                positions: new Cesium.ConstantProperty(positionsA),
                                width: 1,
                                material: new Cesium.ColorMaterialProperty(cfg.baseColor.withAlpha(0.25)),
                            },
                        });
                        rayStates.push({
                            entity: rayEntity,
                            start: rayStart,
                            end: rayEnd,
                            positionsA,
                            positionsB,
                            usePositionsA: true,
                        });
                        satelliteFootprintMetaMap.set(rayId, cfg.meta);
                    }

                    st = {
                        satId: cfg.satId,
                        noradId: cfg.noradId,
                        ellipseEntity,
                        rayStates,
                        radiusMeters: cfg.radiusMeters,
                    };
                    states.set(cfg.noradId, st);
                }

                const ellipsePos = st.ellipseEntity.position as Cesium.ConstantPositionProperty | undefined;
                if (ellipsePos instanceof Cesium.ConstantPositionProperty) {
                    ellipsePos.setValue(nadir);
                } else {
                    st.ellipseEntity.position = new Cesium.ConstantPositionProperty(nadir);
                }

                for (let k = 0; k < st.rayStates.length; k++) {
                    const rayState = st.rayStates[k];
                    const angleRad = (k / st.rayStates.length) * 2 * Math.PI;
                    Cesium.Cartesian3.clone(satPos, rayState.start);
                    writeFootprintPerimeterPoint(
                        lon1,
                        sinLat1,
                        cosLat1,
                        cosAng,
                        sinAng,
                        angleRad,
                        rayState.end,
                    );
                    const rayEntity = rayState.entity;
                    if (rayEntity.polyline) {
                        const posProp = rayEntity.polyline.positions as Cesium.ConstantProperty | undefined;
                        rayState.usePositionsA = !rayState.usePositionsA;
                        const nextPositions = rayState.usePositionsA ? rayState.positionsA : rayState.positionsB;
                        if (posProp instanceof Cesium.ConstantProperty) {
                            posProp.setValue(nextPositions);
                        } else {
                            rayEntity.polyline.positions = new Cesium.ConstantProperty(nextPositions);
                        }
                    }
                }
                updated = true;
            }

            if (updated && hasPositionEpoch) {
                lastPositionEpochMs = positionEpochMs;
            }
            useTimelineStore.getState().setStreamMetric('satelliteFootprints', {
                count: states.size,
                status: states.size > 0 ? 'streaming' : 'warning',
                speed: states.size > 0 ? `${states.size} sats` : 'waiting for positions',
            });
            if (updated) requestSceneRender();
        };

        onTick();
        footprintTickRemoveRef.current = viewer.clock.onTick.addEventListener(onTick);

        useTimelineStore.getState().setStreamMetric('satelliteFootprints', {
            count: states.size,
            status: states.size > 0 ? 'streaming' : 'warning',
            speed: states.size > 0 ? `${states.size} sats` : 'waiting for positions',
        });
        console.log(`[Satellites] Footprint layer armed for ${configs.length} satellites with sensors (discrete tick @ ${FOOTPRINT_UPDATE_MS}ms)`);

        return () => {
            if (footprintTickRemoveRef.current) {
                footprintTickRemoveRef.current();
                footprintTickRemoveRef.current = null;
            }
            footprintStatesRef.current = new Map();
            if (viewer && !viewer.isDestroyed()) {
                viewer.dataSources.remove(fpDs);
            }
            footprintDsRef.current = null;
            satelliteFootprintMetaMap.clear();
        };
    }, [viewer, isFootprintSourceOn, satellitesLoadedTick]);

    const showTrajectories = useTimelineStore(s => s.showTrajectories);

    // ---- Effect 4: visibility toggle ----
    useEffect(() => {
        const bc = billboardCollectionRef.current;
        if (bc) {
            for (let i = 0; i < bc.length; i++) {
                const bb = bc.get(i);
                if (!bb) continue;
                const meta = satelliteMetaMap.get(bb.id as string);
                bb.show = getSatelliteBillboardShow(useTimelineStore.getState(), bb.id as string, meta?.subtype);
            }
        }
        if (trailsPrimitiveRef.current) {
            // Codex 2026-04-24: раньше при playback/OFF trails только скрывался
            // (show=false), но Cesium Primitive + 19k GeometryInstance держали
            // десятки GB. Теперь при любом "выключенном" состоянии —
            // уничтожаем полностью, а при возврате в live+trajectories
            // init-эффект пересоберёт (см. mount/propagate path).
            const shouldShow = mode !== 'playback' && isSourceOn && isVisible && showTrajectories;
            if (!shouldShow && viewer && !viewer.isDestroyed()) {
                viewer.scene.primitives.remove(trailsPrimitiveRef.current);
                trailsPrimitiveRef.current = null;
            } else {
                trailsPrimitiveRef.current.show = shouldShow;
            }
        } else if (mode !== 'playback' && isSourceOn && isVisible && showTrajectories) {
            requestTrailRebuild();
        }
        requestSceneRender();
    }, [isSourceOn, isVisible, showTrajectories, mode, viewer]);

    useEffect(() => {
        if (!viewer) return;
        const onMoveEnd = () => {
            if (useTimelineStore.getState().showTrajectories) requestTrailRebuild();
        };
        const remove = viewer.camera.moveEnd.addEventListener(onMoveEnd);
        return () => {
            remove();
        };
    }, [viewer]);

    // ---- Effect 4a: source-off cleanup ----
    useEffect(() => {
        if (isSourceOn) return;
        const bc = billboardCollectionRef.current;
        if (bc) bc.removeAll();
        billboardMapRef.current.clear();
        satelliteMetaMap.clear();
        if (trailsPrimitiveRef.current && viewer && !viewer.isDestroyed()) {
            viewer.scene.primitives.remove(trailsPrimitiveRef.current);
            trailsPrimitiveRef.current = null;
        }
        useTimelineStore.getState().setSubtypeCounts('satellites', {});
        useTimelineStore.getState().setStreamMetric('satellites', {
            count: 0,
            status: 'disabled',
        });
        requestSceneRender();
    }, [isSourceOn, viewer]);

    // ---- Effect 5: footprint overlay visibility ----
    // Codex 2026-04-24: footprint data source живёт на live TLE + live onTick,
    // не на replay motion-slots. Если не скрыть в playback — пользователь
    // видит stale live-проекции поверх исторической сцены, причём раньше
    // чем replay satellite billboards загрузятся. Отдельная replay-footprint
    // логика — task #34.
    useEffect(() => {
        if (footprintDsRef.current) {
            footprintDsRef.current.show = mode !== 'playback' && isFootprintSourceOn && isFootprintVisible;
        }
        requestSceneRender();
    }, [isFootprintSourceOn, isFootprintVisible, mode]);

    // ---- Effect 5a: footprint source-off metric reset ----
    useEffect(() => {
        if (isFootprintSourceOn) return;
        useTimelineStore.getState().setStreamMetric('satelliteFootprints', {
            count: 0,
            status: 'disabled',
            speed: '-',
        });
    }, [isFootprintSourceOn]);

    // ---- Effect 6: per-subtype visibility + counts ----
    const subtypeVisibility = useTimelineStore(s => s.subtypeVisibility);
    const isolatedEntityId = useTimelineStore(s => s.isolatedEntityId);
    useEffect(() => {
        if (!viewer) return;
        const bc = billboardCollectionRef.current;
        if (!bc || bc.length === 0) return;
        const counts: Record<string, number> = {};
        const trails = trailsPrimitiveRef.current;

        // Iterate all billboards
        for (let i = 0; i < bc.length; i++) {
            const bb = bc.get(i);
            if (!bb) continue;
            const meta = satelliteMetaMap.get(bb.id as string);
            if (!meta) continue;
            const sub = meta.subtype;
            counts[sub] = (counts[sub] || 0) + 1;
            const show = getSatelliteBillboardShow(useTimelineStore.getState(), bb.id as string, sub);
            bb.show = show;

            if (trails && trails.ready) {
                const attrs = trails.getGeometryInstanceAttributes(bb.id);
                if (attrs) {
                    (attrs as any).show = Cesium.ShowGeometryInstanceAttribute.toValue(show);
                }
            }
        }
        useTimelineStore.getState().setSubtypeCounts('satellites', counts);
        requestSceneRender();

        // Ready-gate poll for async trail primitive
        if (trails && !trails.ready) {
            let cancelled = false;
            const poll = () => {
                if (cancelled) return;
                if (!trails.ready) { setTimeout(poll, 50); return; }
                for (let i = 0; i < bc.length; i++) {
                    const bb = bc.get(i);
                    if (!bb) continue;
                    const meta = satelliteMetaMap.get(bb.id as string);
                    if (!meta) continue;
                    const show = getSatelliteBillboardShow(useTimelineStore.getState(), bb.id as string, meta.subtype);
                    const attrs = trails.getGeometryInstanceAttributes(bb.id);
                    if (attrs) {
                        (attrs as any).show = Cesium.ShowGeometryInstanceAttribute.toValue(show);
                    }
                }
                requestSceneRender();
            };
            setTimeout(poll, 50);
            return () => { cancelled = true; };
        }
    }, [viewer, subtypeVisibility, satellitesLoadedTick, isSourceOn, isVisible, isolatedEntityId]);
}
