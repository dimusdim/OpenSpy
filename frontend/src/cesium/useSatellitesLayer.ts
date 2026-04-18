import { useEffect, useRef, useState } from 'react';
import * as Cesium from 'cesium';
import axios from 'axios';
import { useTimelineStore } from '../store/useTimelineStore';
import { API_URL } from '../lib/config';
import { getSatIcon } from '../icons/map-icons';
import { isFiniteCartesian } from './position-utils';

// ---------------------------------------------------------------------------
// Footprint types & registry (unchanged — used by Globe.tsx picking)
// ---------------------------------------------------------------------------
const FOOTPRINT_UPDATE_MS = 250;
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
    lat?: number;
    lng?: number;
    alt?: number;
    recon?: boolean;
    reconMeta?: any;
    sensor?: any;
}
export const satelliteMetaMap = new Map<string, SatelliteMeta>();

// ---------------------------------------------------------------------------
// Per-footprint mutable state
// ---------------------------------------------------------------------------
interface FootprintState {
    satId: string;       // sat-{noradId}
    noradId: number;
    ellipseEntity: Cesium.Entity;
    rayEntities: Cesium.Entity[];
    radiusMeters: number;
}

interface FootprintConfig {
    satId: string;
    noradId: number;
    radiusMeters: number;
    baseColor: Cesium.Color;
    meta: SatelliteFootprintMeta;
}

// How often to post 'tick' to the Worker (ms). 2 seconds is smooth enough —
// LEO satellites move ~15 km/s, so 2s = 30 km drift, sub-pixel at global zoom.
const WORKER_TICK_INTERVAL = 2000;

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

    // BillboardCollection for satellite icons (Phase 2)
    const billboardCollectionRef = useRef<Cesium.BillboardCollection | null>(null);
    // Map: noradId → Billboard reference for position updates
    const billboardMapRef = useRef<Map<number, Cesium.Billboard>>(new Map());
    // Batched orbit trails — one GPU draw call
    const trailsPrimitiveRef = useRef<Cesium.Primitive | null>(null);
    // Worker ref
    const workerRef = useRef<Worker | null>(null);
    // Tick interval ref
    const tickIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    // Raw satellite data from API (for footprints + metadata)
    const satDataRef = useRef<any[]>([]);
    // Bumped after Worker finishes initial orbit propagation
    const [satellitesLoadedTick, setSatellitesLoadedTick] = useState(0);

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
            }
            billboardCollectionRef.current = null;
            billboardMapRef.current.clear();
            trailsPrimitiveRef.current = null;
            satelliteMetaMap.clear();
        };
    }, [viewer]);

    // ---- Effect 2: fetch + Worker lifecycle ----
    useEffect(() => {
        if (!viewer || !isSourceOn) return;
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

                // Build index and metadata
                const noradToIndex = new Map<number, number>();
                for (let i = 0; i < sats.length; i++) {
                    const sat = sats[i];
                    const isRecon = sat.recon === true;
                    const subtype = isRecon ? 'recon' : sat.type;
                    const entityId = `sat-${sat.noradId || sat.name}`;
                    noradToIndex.set(sat.noradId, i);

                    // Register metadata for picking (Globe.tsx)
                    satelliteMetaMap.set(entityId, {
                        id: entityId,
                        name: sat.name,
                        noradId: sat.noradId,
                        type: sat.type,
                        subtype,
                        recon: isRecon,
                        reconMeta: sat.reconMeta,
                        sensor: sat.sensor,
                    });

                    // Create billboard (initially at 0,0,0 — Worker will set real position)
                    const bb = bc.add({
                        position: Cesium.Cartesian3.ZERO,
                        image: getSatIcon(sat.type, isRecon),
                        scale: isRecon ? 1.8 : 1.4,
                        show: false, // hidden until first Worker tick
                        id: entityId,
                    });
                    billboardMapRef.current.set(sat.noradId, bb);
                }

                // --- Start Web Worker ---
                const worker = new Worker(
                    new URL('./satellite-worker.ts', import.meta.url)
                );
                workerRef.current = worker;

                worker.onmessage = (e: MessageEvent) => {
                    if (!active) return;
                    const msg = e.data;

                    if (msg.type === 'ready') {
                        console.log(`[Satellites] Worker ready, ${msg.count} satrecs initialized`);
                        // Request full orbit propagation for trails
                        worker.postMessage({
                            type: 'propagate',
                            epochMs: Date.now(),
                            windowMinutes: 240,
                            stepSeconds: 120,
                        });
                        const sendLiveTick = () => {
                            if (useTimelineStore.getState().mode === 'playback') return;
                            worker.postMessage({ type: 'tick', currentTimeMs: Date.now() });
                        };
                        // Start position ticks
                        sendLiveTick();
                        tickIntervalRef.current = setInterval(() => {
                            sendLiveTick();
                        }, WORKER_TICK_INTERVAL);
                    }

                    if (msg.type === 'positions') {
                        // Update billboard positions from Worker Float64Array
                        const positions: Float64Array = msg.positions;
                        const order: number[] = msg.order;
                        const bbMap = billboardMapRef.current;
                        const freshState = useTimelineStore.getState();
                        if (freshState.mode === 'playback') return;
                        let updated = false;

                        for (let i = 0; i < order.length; i++) {
                            const noradId = order[i];
                            const bb = bbMap.get(noradId);
                            if (!bb) continue;
                            const lon = positions[i * 3];
                            if (isNaN(lon)) continue; // bad propagation
                            const lat = positions[i * 3 + 1];
                            const alt = positions[i * 3 + 2];
                            bb.position = Cesium.Cartesian3.fromDegrees(lon, lat, alt);
                            const meta = satelliteMetaMap.get(bb.id as string);
                            if (meta) {
                                meta.lat = lat;
                                meta.lng = lon;
                                meta.alt = alt;
                                bb.show = getSatelliteBillboardShow(freshState, bb.id as string, meta.subtype);
                                updated = true;
                            }
                        }
                        if (updated) requestSceneRender();
                    }

                    if (msg.type === 'orbits') {
                        // Build batched trail primitive from Worker orbit data
                        if (!viewer || viewer.isDestroyed()) return;
                        const results: { noradId: number; positions: Float64Array; validSamples: number }[] = msg.results;
                        const sampleCount: number = msg.sampleCount;
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
                                releaseGeometryInstances: false,
                            });
                            const freshState = useTimelineStore.getState();
                            trailsPrimitive.show =
                                freshState.visibility.satellites && freshState.showTrajectories;
                            viewer.scene.primitives.add(trailsPrimitive);
                            trailsPrimitiveRef.current = trailsPrimitive;
                        }

                        console.log(`[Satellites] ${trailInstances.length} orbital trails built from Worker data`);
                        setSatellitesLoadedTick(t => t + 1);
                        requestSceneRender();
                    }
                };

                // Send TLE data to Worker
                worker.postMessage({
                    type: 'init',
                    satellites: sats.map(s => ({
                        noradId: s.noradId,
                        name: s.name,
                        tleLine1: s.tleLine1,
                        tleLine2: s.tleLine2,
                        type: s.type,
                        recon: s.recon,
                    })),
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
            if (workerRef.current) {
                workerRef.current.terminate();
                workerRef.current = null;
            }
        };
    }, [viewer, isSourceOn, satelliteRenderLimit]);

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
            });
        }

        footprintStatesRef.current = states;

        // Discrete update tick — read positions from BillboardCollection
        let lastUpdateMs = 0;
        const R_EARTH = 6_371_000;
        const bbMap = billboardMapRef.current;

        const onTick = () => {
            if (useTimelineStore.getState().mode === 'playback') return;
            const nowMs = Date.now();
            if (nowMs - lastUpdateMs < FOOTPRINT_UPDATE_MS) return;
            lastUpdateMs = nowMs;
            let updated = false;

            for (const cfg of configs) {
                const bb = bbMap.get(cfg.noradId);
                if (!bb || !bb.show) continue;
                const satPos = bb.position;
                if (!isFiniteCartesian(satPos) || Cesium.Cartesian3.equals(satPos, Cesium.Cartesian3.ZERO)) continue;

                const carto = Cesium.Cartographic.fromCartesian(satPos);
                if (!carto) continue;
                const lat1 = carto.latitude;
                const lon1 = carto.longitude;
                const nadir = Cesium.Cartesian3.fromRadians(lon1, lat1, 0);
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

                    const rayEntities: Cesium.Entity[] = [];
                    for (let k = 0; k < FOOTPRINT_RAY_COUNT; k++) {
                        const angleRad = (k / FOOTPRINT_RAY_COUNT) * 2 * Math.PI;
                        const lat2 = Math.asin(sinLat1 * cosAng + cosLat1 * sinAng * Math.cos(angleRad));
                        const lon2 = lon1 + Math.atan2(
                            Math.sin(angleRad) * sinAng * cosLat1,
                            cosAng - sinLat1 * Math.sin(lat2)
                        );
                        const perimeter = Cesium.Cartesian3.fromRadians(lon2, lat2, 0);
                        const rayId = `beam-${cfg.satId}#${k}`;
                        const rayEntity = fpDs.entities.add({
                            id: rayId,
                            polyline: {
                                positions: new Cesium.ConstantProperty([satPos, perimeter]),
                                width: 1,
                                material: new Cesium.ColorMaterialProperty(cfg.baseColor.withAlpha(0.25)),
                            },
                        });
                        rayEntities.push(rayEntity);
                        satelliteFootprintMetaMap.set(rayId, cfg.meta);
                    }

                    st = {
                        satId: cfg.satId,
                        noradId: cfg.noradId,
                        ellipseEntity,
                        rayEntities,
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

                for (let k = 0; k < st.rayEntities.length; k++) {
                    const angleRad = (k / st.rayEntities.length) * 2 * Math.PI;
                    const lat2 = Math.asin(sinLat1 * cosAng + cosLat1 * sinAng * Math.cos(angleRad));
                    const lon2 = lon1 + Math.atan2(
                        Math.sin(angleRad) * sinAng * cosLat1,
                        cosAng - sinLat1 * Math.sin(lat2)
                    );
                    const perimeter = Cesium.Cartesian3.fromRadians(lon2, lat2, 0);
                    const rayEntity = st.rayEntities[k];
                    if (rayEntity.polyline) {
                        const posProp = rayEntity.polyline.positions as Cesium.ConstantProperty | undefined;
                        if (posProp instanceof Cesium.ConstantProperty) {
                            posProp.setValue([satPos, perimeter]);
                        } else {
                            rayEntity.polyline.positions = new Cesium.ConstantProperty([satPos, perimeter]);
                        }
                    }
                }
                updated = true;
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
            trailsPrimitiveRef.current.show = mode !== 'playback' && isSourceOn && isVisible && showTrajectories;
        }
        requestSceneRender();
    }, [isSourceOn, isVisible, showTrajectories, mode]);

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
        const globalShow = isSourceOn && isVisible;

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
