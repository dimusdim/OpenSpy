import { useEffect, useRef, useState } from 'react';
import * as Cesium from 'cesium';
import axios from 'axios';
import { useTimelineStore } from '../store/useTimelineStore';
import { API_URL } from '../lib/config';

// ---------------------------------------------------------------------------
// Satellite icons — 32×32 SVG data URIs
// ---------------------------------------------------------------------------
const satDataUri = (svgContent: string) => `data:image/svg+xml,` + encodeURIComponent(svgContent);

const SAT_ICONS: Record<string, string> = {
    military: satDataUri(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24"><polygon points="10,6 14,6 15,8 15,16 14,18 10,18 9,16 9,8" fill="#ef4444" stroke="#000000" stroke-width="1.2"/><line x1="9" y1="10" x2="15" y2="10" stroke="#000000" stroke-width="0.5" opacity="0.6"/><line x1="9" y1="14" x2="15" y2="14" stroke="#000000" stroke-width="0.5" opacity="0.6"/><rect x="1" y="9" width="7" height="6" rx="0.5" fill="#ef4444" stroke="#000000" stroke-width="1"/><line x1="3.3" y1="9" x2="3.3" y2="15" stroke="#000000" stroke-width="0.3" opacity="0.5"/><line x1="5.6" y1="9" x2="5.6" y2="15" stroke="#000000" stroke-width="0.3" opacity="0.5"/><line x1="1" y1="12" x2="8" y2="12" stroke="#000000" stroke-width="0.3" opacity="0.5"/><rect x="16" y="9" width="7" height="6" rx="0.5" fill="#ef4444" stroke="#000000" stroke-width="1"/><line x1="18.3" y1="9" x2="18.3" y2="15" stroke="#000000" stroke-width="0.3" opacity="0.5"/><line x1="20.6" y1="9" x2="20.6" y2="15" stroke="#000000" stroke-width="0.3" opacity="0.5"/><line x1="16" y1="12" x2="23" y2="12" stroke="#000000" stroke-width="0.3" opacity="0.5"/><circle cx="12" cy="12" r="2" fill="#000000" stroke="#000000" stroke-width="0.6" opacity="0.7"/><circle cx="12" cy="12" r="1" fill="#ffffff" opacity="0.9"/><rect x="10.5" y="3.5" width="3" height="2" rx="0.5" fill="#ef4444" stroke="#000000" stroke-width="0.8"/><line x1="12" y1="6" x2="12" y2="5.5" stroke="#000000" stroke-width="0.6"/><polygon points="11,18 13,18 13.5,20 10.5,20" fill="#ef4444" stroke="#000000" stroke-width="0.6" opacity="0.8"/></svg>`),
    commercial: satDataUri(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24"><rect x="9" y="8" width="6" height="8" rx="1" fill="#06b6d4" stroke="#000000" stroke-width="1.2"/><line x1="9" y1="10.5" x2="15" y2="10.5" stroke="#000000" stroke-width="0.4" opacity="0.6"/><line x1="9" y1="13.5" x2="15" y2="13.5" stroke="#000000" stroke-width="0.4" opacity="0.6"/><rect x="0.5" y="8.5" width="7.5" height="7" rx="0.5" fill="#06b6d4" stroke="#000000" stroke-width="1"/><line x1="2.5" y1="8.5" x2="2.5" y2="15.5" stroke="#000000" stroke-width="0.3" opacity="0.5"/><line x1="4.5" y1="8.5" x2="4.5" y2="15.5" stroke="#000000" stroke-width="0.3" opacity="0.5"/><line x1="6.5" y1="8.5" x2="6.5" y2="15.5" stroke="#000000" stroke-width="0.3" opacity="0.5"/><line x1="0.5" y1="12" x2="8" y2="12" stroke="#000000" stroke-width="0.3" opacity="0.5"/><rect x="16" y="8.5" width="7.5" height="7" rx="0.5" fill="#06b6d4" stroke="#000000" stroke-width="1"/><line x1="18" y1="8.5" x2="18" y2="15.5" stroke="#000000" stroke-width="0.3" opacity="0.5"/><line x1="20" y1="8.5" x2="20" y2="15.5" stroke="#000000" stroke-width="0.3" opacity="0.5"/><line x1="22" y1="8.5" x2="22" y2="15.5" stroke="#000000" stroke-width="0.3" opacity="0.5"/><line x1="16" y1="12" x2="23.5" y2="12" stroke="#000000" stroke-width="0.3" opacity="0.5"/><line x1="12" y1="8" x2="12" y2="4.5" stroke="#000000" stroke-width="0.8"/><ellipse cx="12" cy="3.5" rx="3" ry="1.2" fill="#06b6d4" stroke="#000000" stroke-width="0.8"/><circle cx="12" cy="3.5" r="0.5" fill="#ffffff" opacity="0.9"/><line x1="12" y1="3.5" x2="12" y2="1.5" stroke="#000000" stroke-width="0.5" opacity="0.7"/><line x1="9" y1="9" x2="7" y2="7" stroke="#000000" stroke-width="0.5" opacity="0.6"/><circle cx="6.8" cy="6.8" r="0.3" fill="#000000" opacity="0.6"/><line x1="15" y1="9" x2="17" y2="7" stroke="#000000" stroke-width="0.5" opacity="0.6"/><circle cx="17.2" cy="6.8" r="0.3" fill="#000000" opacity="0.6"/><polygon points="11,16 13,16 13.5,18 10.5,18" fill="#06b6d4" stroke="#000000" stroke-width="0.5" opacity="0.7"/></svg>`),
    civilian: satDataUri(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24"><rect x="11" y="5" width="2" height="14" rx="0.5" fill="#84cc16" stroke="#000000" stroke-width="1.2"/><line x1="11" y1="8" x2="13" y2="10" stroke="#000000" stroke-width="0.4" opacity="0.6"/><line x1="13" y1="8" x2="11" y2="10" stroke="#000000" stroke-width="0.4" opacity="0.6"/><line x1="11" y1="13" x2="13" y2="15" stroke="#000000" stroke-width="0.4" opacity="0.6"/><line x1="13" y1="13" x2="11" y2="15" stroke="#000000" stroke-width="0.4" opacity="0.6"/><rect x="1" y="7" width="9" height="3" rx="0.5" fill="#84cc16" stroke="#000000" stroke-width="1"/><line x1="3.25" y1="7" x2="3.25" y2="10" stroke="#000000" stroke-width="0.3" opacity="0.5"/><line x1="5.5" y1="7" x2="5.5" y2="10" stroke="#000000" stroke-width="0.3" opacity="0.5"/><line x1="7.75" y1="7" x2="7.75" y2="10" stroke="#000000" stroke-width="0.3" opacity="0.5"/><rect x="1" y="14" width="9" height="3" rx="0.5" fill="#84cc16" stroke="#000000" stroke-width="1"/><line x1="3.25" y1="14" x2="3.25" y2="17" stroke="#000000" stroke-width="0.3" opacity="0.5"/><line x1="5.5" y1="14" x2="5.5" y2="17" stroke="#000000" stroke-width="0.3" opacity="0.5"/><line x1="7.75" y1="14" x2="7.75" y2="17" stroke="#000000" stroke-width="0.3" opacity="0.5"/><rect x="14" y="7" width="9" height="3" rx="0.5" fill="#84cc16" stroke="#000000" stroke-width="1"/><line x1="16.25" y1="7" x2="16.25" y2="10" stroke="#000000" stroke-width="0.3" opacity="0.5"/><line x1="18.5" y1="7" x2="18.5" y2="10" stroke="#000000" stroke-width="0.3" opacity="0.5"/><line x1="20.75" y1="7" x2="20.75" y2="10" stroke="#000000" stroke-width="0.3" opacity="0.5"/><rect x="14" y="14" width="9" height="3" rx="0.5" fill="#84cc16" stroke="#000000" stroke-width="1"/><line x1="16.25" y1="14" x2="16.25" y2="17" stroke="#000000" stroke-width="0.3" opacity="0.5"/><line x1="18.5" y1="14" x2="18.5" y2="17" stroke="#000000" stroke-width="0.3" opacity="0.5"/><line x1="20.75" y1="14" x2="20.75" y2="17" stroke="#000000" stroke-width="0.3" opacity="0.5"/><rect x="10" y="3" width="4" height="2" rx="0.5" fill="#84cc16" stroke="#000000" stroke-width="0.8"/><circle cx="11" cy="4" r="0.4" fill="#000000" opacity="0.9"/><circle cx="13" cy="4" r="0.4" fill="#000000" opacity="0.9"/><line x1="12" y1="19" x2="12" y2="22" stroke="#000000" stroke-width="0.6" opacity="0.7"/><circle cx="12" cy="22.5" r="0.8" fill="#84cc16" stroke="#000000" stroke-width="0.5" opacity="0.7"/><circle cx="12" cy="22.5" r="0.3" fill="#000000" opacity="0.7"/></svg>`),
};

const SAT_RECON_ICON = satDataUri(
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24"><rect x="9.5" y="5" width="5" height="13" rx="1.5" fill="#f59e0b" stroke="#000000" stroke-width="1.2"/><line x1="9.5" y1="8" x2="14.5" y2="8" stroke="#000000" stroke-width="0.5" opacity="0.6"/><line x1="9.5" y1="11" x2="14.5" y2="11" stroke="#000000" stroke-width="0.5" opacity="0.6"/><line x1="9.5" y1="15" x2="14.5" y2="15" stroke="#000000" stroke-width="0.5" opacity="0.6"/><circle cx="12" cy="3.5" r="2.5" fill="#f59e0b" stroke="#000000" stroke-width="1"/><circle cx="12" cy="3.5" r="1.2" fill="#000000" stroke="#000000" stroke-width="0.5" opacity="0.7"/><circle cx="12" cy="3.5" r="0.5" fill="#ffffff" opacity="0.9"/><ellipse cx="12" cy="2" rx="3.2" ry="0.8" fill="#f59e0b" stroke="#000000" stroke-width="0.6" opacity="0.7"/><rect x="1.5" y="9.5" width="7" height="5" rx="0.5" fill="#f59e0b" stroke="#000000" stroke-width="1"/><line x1="4" y1="9.5" x2="4" y2="14.5" stroke="#000000" stroke-width="0.3" opacity="0.5"/><line x1="6.5" y1="9.5" x2="6.5" y2="14.5" stroke="#000000" stroke-width="0.3" opacity="0.5"/><line x1="1.5" y1="12" x2="8.5" y2="12" stroke="#000000" stroke-width="0.3" opacity="0.5"/><rect x="15.5" y="9.5" width="7" height="5" rx="0.5" fill="#f59e0b" stroke="#000000" stroke-width="1"/><line x1="18" y1="9.5" x2="18" y2="14.5" stroke="#000000" stroke-width="0.3" opacity="0.5"/><line x1="20.5" y1="9.5" x2="20.5" y2="14.5" stroke="#000000" stroke-width="0.3" opacity="0.5"/><line x1="15.5" y1="12" x2="22.5" y2="12" stroke="#000000" stroke-width="0.3" opacity="0.5"/><line x1="12" y1="18" x2="12" y2="21" stroke="#000000" stroke-width="0.8" opacity="0.7"/><path d="M10 21 Q12 23 14 21" fill="none" stroke="#000000" stroke-width="0.6" opacity="0.6"/></svg>`
);

const getSatSvg = (type: string, isRecon?: boolean) => {
    if (isRecon) return SAT_RECON_ICON;
    return SAT_ICONS[type] || SAT_ICONS.civilian;
};

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

// How often to post 'tick' to the Worker (ms). 2 seconds is smooth enough —
// LEO satellites move ~15 km/s, so 2s = 30 km drift, sub-pixel at global zoom.
const WORKER_TICK_INTERVAL = 2000;

export function useSatellitesLayer(viewer: Cesium.Viewer | null) {
    const isSourceOn = useTimelineStore(s => s.sources.satellites);
    const isVisible = useTimelineStore(s => s.visibility.satellites);

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
    const footprintStatesRef = useRef<FootprintState[]>([]);
    const footprintTickRemoveRef = useRef<Cesium.Event.RemoveCallback | null>(null);

    const isFootprintSourceOn = useTimelineStore(s => s.sources.satelliteFootprints);
    const isFootprintVisible = useTimelineStore(s => s.visibility.satelliteFootprints);

    // ---- Effect 1: BillboardCollection + trails primitive lifetime ----
    useEffect(() => {
        if (!viewer) return;

        const bc = new Cesium.BillboardCollection({ scene: viewer.scene });
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
                const res = await axios.get(`${API_URL}/api/satellites`);
                if (!active) return;

                const sats = res.data as any[];
                satDataRef.current = sats;
                useTimelineStore.getState().setStreamMetric('satellites', {
                    count: sats.length,
                    status: 'streaming',
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
                        image: getSatSvg(sat.type, isRecon),
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
                        // Start position ticks
                        worker.postMessage({ type: 'tick', currentTimeMs: Date.now() });
                        tickIntervalRef.current = setInterval(() => {
                            worker.postMessage({ type: 'tick', currentTimeMs: Date.now() });
                        }, WORKER_TICK_INTERVAL);
                    }

                    if (msg.type === 'positions') {
                        // Update billboard positions from Worker Float64Array
                        const positions: Float64Array = msg.positions;
                        const order: number[] = msg.order;
                        const bbMap = billboardMapRef.current;
                        const freshState = useTimelineStore.getState();
                        const show = freshState.sources.satellites && freshState.visibility.satellites;

                        for (let i = 0; i < order.length; i++) {
                            const noradId = order[i];
                            const bb = bbMap.get(noradId);
                            if (!bb) continue;
                            const lon = positions[i * 3];
                            if (isNaN(lon)) continue; // bad propagation
                            const lat = positions[i * 3 + 1];
                            const alt = positions[i * 3 + 2];
                            bb.position = Cesium.Cartesian3.fromDegrees(lon, lat, alt);
                            bb.show = show;
                        }
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
    }, [viewer, isSourceOn]);

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
        const states: FootprintState[] = [];
        let rendered = 0;

        for (const sat of sats) {
            if (!sat.sensor || !sat.sensor.swathMeters || sat.sensor.swathMeters <= 0) continue;

            const isRecon = sat.recon === true;
            const subtype = isRecon ? 'recon' : sat.type;
            const entityId = `sat-${sat.noradId || sat.name}`;
            const bb = billboardMapRef.current.get(sat.noradId);
            const initialPos = bb?.position ?? Cesium.Cartesian3.ZERO;

            const baseColor = subtype === 'military' || subtype === 'recon' ? Cesium.Color.RED
                : subtype === 'commercial' ? Cesium.Color.CYAN
                : Cesium.Color.LIME;

            const radiusMeters = sat.sensor.swathMeters / 2;

            // Compute initial nadir
            let initialNadir = Cesium.Cartesian3.ZERO;
            if (!Cesium.Cartesian3.equals(initialPos, Cesium.Cartesian3.ZERO)) {
                const c = Cesium.Cartographic.fromCartesian(initialPos);
                initialNadir = Cesium.Cartesian3.fromRadians(c.longitude, c.latitude, 0);
            }

            const footprintId = `fp-${entityId}`;
            if (fpDs.entities.getById(footprintId)) continue; // skip duplicate
            const ellipseEntity = fpDs.entities.add({
                id: footprintId,
                position: new Cesium.ConstantPositionProperty(initialNadir),
                ellipse: {
                    semiMinorAxis: radiusMeters,
                    semiMajorAxis: radiusMeters,
                    material: new Cesium.ColorMaterialProperty(baseColor.withAlpha(0.08)),
                    height: 0,
                    outline: true,
                    outlineColor: baseColor.withAlpha(0.5),
                    outlineWidth: 1,
                },
            });

            const fpMeta: SatelliteFootprintMeta = {
                parentSatId: entityId,
                satName: sat.name,
                subtype,
                sensorName: sat.sensor.sensorName || '',
                sensorType: sat.sensor.sensorType || 'OTHER',
                swathMeters: sat.sensor.swathMeters,
                source: sat.sensor.source || 'spectator-earth',
            };
            satelliteFootprintMetaMap.set(footprintId, fpMeta);

            const rayEntities: Cesium.Entity[] = [];
            for (let k = 0; k < FOOTPRINT_RAY_COUNT; k++) {
                const rayId = `beam-${entityId}#${k}`;
                const rayEntity = fpDs.entities.add({
                    id: rayId,
                    polyline: {
                        positions: new Cesium.ConstantProperty(
                            Cesium.Cartesian3.equals(initialPos, Cesium.Cartesian3.ZERO)
                                ? [Cesium.Cartesian3.ZERO, Cesium.Cartesian3.ZERO]
                                : [initialPos, initialNadir]
                        ),
                        width: 1,
                        material: new Cesium.ColorMaterialProperty(baseColor.withAlpha(0.25)),
                    },
                });
                rayEntities.push(rayEntity);
                satelliteFootprintMetaMap.set(rayId, fpMeta);
            }

            states.push({ satId: entityId, noradId: sat.noradId, ellipseEntity, rayEntities, radiusMeters });
            rendered++;
        }

        footprintStatesRef.current = states;

        // Discrete update tick — read positions from BillboardCollection
        let lastUpdateMs = 0;
        const R_EARTH = 6_371_000;
        const bbMap = billboardMapRef.current;

        const onTick = () => {
            const nowMs = Date.now();
            if (nowMs - lastUpdateMs < FOOTPRINT_UPDATE_MS) return;
            lastUpdateMs = nowMs;

            for (const st of footprintStatesRef.current) {
                const bb = bbMap.get(st.noradId);
                if (!bb || !bb.show) continue;
                const satPos = bb.position;
                if (!satPos || Cesium.Cartesian3.equals(satPos, Cesium.Cartesian3.ZERO)) continue;

                const carto = Cesium.Cartographic.fromCartesian(satPos);
                const lat1 = carto.latitude;
                const lon1 = carto.longitude;
                const nadir = Cesium.Cartesian3.fromRadians(lon1, lat1, 0);

                const ellipsePos = st.ellipseEntity.position as Cesium.ConstantPositionProperty | undefined;
                if (ellipsePos instanceof Cesium.ConstantPositionProperty) {
                    ellipsePos.setValue(nadir);
                } else {
                    st.ellipseEntity.position = new Cesium.ConstantPositionProperty(nadir);
                }

                const angDist = st.radiusMeters / R_EARTH;
                const sinLat1 = Math.sin(lat1);
                const cosLat1 = Math.cos(lat1);
                const cosAng = Math.cos(angDist);
                const sinAng = Math.sin(angDist);
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
            }
        };

        onTick();
        footprintTickRemoveRef.current = viewer.clock.onTick.addEventListener(onTick);

        useTimelineStore.getState().setStreamMetric('satelliteFootprints', {
            count: rendered,
            status: rendered > 0 ? 'streaming' : 'warning',
            speed: rendered > 0 ? `${rendered} sats` : 'no sensor data',
        });
        console.log(`[Satellites] Rendered ${rendered} sensor footprints (discrete tick @ ${FOOTPRINT_UPDATE_MS}ms)`);

        return () => {
            if (footprintTickRemoveRef.current) {
                footprintTickRemoveRef.current();
                footprintTickRemoveRef.current = null;
            }
            footprintStatesRef.current = [];
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
        const show = isSourceOn && isVisible;
        const bc = billboardCollectionRef.current;
        if (bc) {
            // BillboardCollection doesn't have a single .show —
            // iterate and set per-billboard
            for (let i = 0; i < bc.length; i++) {
                const bb = bc.get(i);
                if (bb) bb.show = show;
            }
        }
        if (trailsPrimitiveRef.current) {
            trailsPrimitiveRef.current.show = show && showTrajectories;
        }
    }, [isSourceOn, isVisible, showTrajectories]);

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
    }, [isSourceOn, viewer]);

    // ---- Effect 5: footprint overlay visibility ----
    useEffect(() => {
        if (footprintDsRef.current) {
            footprintDsRef.current.show = isFootprintSourceOn && isFootprintVisible;
        }
    }, [isFootprintSourceOn, isFootprintVisible]);

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
            const show = globalShow && subtypeVisibility[`satellites:${sub}`] !== false;
            bb.show = show;

            if (trails && trails.ready) {
                const attrs = trails.getGeometryInstanceAttributes(bb.id);
                if (attrs) {
                    (attrs as any).show = Cesium.ShowGeometryInstanceAttribute.toValue(show);
                }
            }
        }
        useTimelineStore.getState().setSubtypeCounts('satellites', counts);

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
                    const show = globalShow && subtypeVisibility[`satellites:${meta.subtype}`] !== false;
                    const attrs = trails.getGeometryInstanceAttributes(bb.id);
                    if (attrs) {
                        (attrs as any).show = Cesium.ShowGeometryInstanceAttribute.toValue(show);
                    }
                }
            };
            setTimeout(poll, 50);
            return () => { cancelled = true; };
        }
    }, [viewer, subtypeVisibility, satellitesLoadedTick, isSourceOn, isVisible]);
}
