import { useEffect, useRef, useState } from 'react';
import * as Cesium from 'cesium';
import * as satelliteJs from 'satellite.js';
import axios from 'axios';
import { useTimelineStore } from '../store/useTimelineStore';
import { API_URL } from '../lib/config';

// Satellite icons — 32x32 with 24x24 viewBox. Black outline + color fill style.
//   military   — angular body, red fill, black stroke
//   commercial — dish + body + panels, cyan fill, black stroke
//   civilian   — ISS-like truss + panels, lime fill, black stroke
//   recon      — telescope tube, amber fill, black stroke
const satDataUri = (svgContent: string) => `data:image/svg+xml,` + encodeURIComponent(svgContent);

const SAT_ICONS: Record<string, string> = {
    military: satDataUri(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24"><polygon points="10,6 14,6 15,8 15,16 14,18 10,18 9,16 9,8" fill="#ef4444" stroke="#000000" stroke-width="1.2"/><line x1="9" y1="10" x2="15" y2="10" stroke="#000000" stroke-width="0.5" opacity="0.6"/><line x1="9" y1="14" x2="15" y2="14" stroke="#000000" stroke-width="0.5" opacity="0.6"/><rect x="1" y="9" width="7" height="6" rx="0.5" fill="#ef4444" stroke="#000000" stroke-width="1"/><line x1="3.3" y1="9" x2="3.3" y2="15" stroke="#000000" stroke-width="0.3" opacity="0.5"/><line x1="5.6" y1="9" x2="5.6" y2="15" stroke="#000000" stroke-width="0.3" opacity="0.5"/><line x1="1" y1="12" x2="8" y2="12" stroke="#000000" stroke-width="0.3" opacity="0.5"/><rect x="16" y="9" width="7" height="6" rx="0.5" fill="#ef4444" stroke="#000000" stroke-width="1"/><line x1="18.3" y1="9" x2="18.3" y2="15" stroke="#000000" stroke-width="0.3" opacity="0.5"/><line x1="20.6" y1="9" x2="20.6" y2="15" stroke="#000000" stroke-width="0.3" opacity="0.5"/><line x1="16" y1="12" x2="23" y2="12" stroke="#000000" stroke-width="0.3" opacity="0.5"/><circle cx="12" cy="12" r="2" fill="#000000" stroke="#000000" stroke-width="0.6" opacity="0.7"/><circle cx="12" cy="12" r="1" fill="#ffffff" opacity="0.9"/><rect x="10.5" y="3.5" width="3" height="2" rx="0.5" fill="#ef4444" stroke="#000000" stroke-width="0.8"/><line x1="12" y1="6" x2="12" y2="5.5" stroke="#000000" stroke-width="0.6"/><polygon points="11,18 13,18 13.5,20 10.5,20" fill="#ef4444" stroke="#000000" stroke-width="0.6" opacity="0.8"/></svg>`),
    commercial: satDataUri(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24"><rect x="9" y="8" width="6" height="8" rx="1" fill="#06b6d4" stroke="#000000" stroke-width="1.2"/><line x1="9" y1="10.5" x2="15" y2="10.5" stroke="#000000" stroke-width="0.4" opacity="0.6"/><line x1="9" y1="13.5" x2="15" y2="13.5" stroke="#000000" stroke-width="0.4" opacity="0.6"/><rect x="0.5" y="8.5" width="7.5" height="7" rx="0.5" fill="#06b6d4" stroke="#000000" stroke-width="1"/><line x1="2.5" y1="8.5" x2="2.5" y2="15.5" stroke="#000000" stroke-width="0.3" opacity="0.5"/><line x1="4.5" y1="8.5" x2="4.5" y2="15.5" stroke="#000000" stroke-width="0.3" opacity="0.5"/><line x1="6.5" y1="8.5" x2="6.5" y2="15.5" stroke="#000000" stroke-width="0.3" opacity="0.5"/><line x1="0.5" y1="12" x2="8" y2="12" stroke="#000000" stroke-width="0.3" opacity="0.5"/><rect x="16" y="8.5" width="7.5" height="7" rx="0.5" fill="#06b6d4" stroke="#000000" stroke-width="1"/><line x1="18" y1="8.5" x2="18" y2="15.5" stroke="#000000" stroke-width="0.3" opacity="0.5"/><line x1="20" y1="8.5" x2="20" y2="15.5" stroke="#000000" stroke-width="0.3" opacity="0.5"/><line x1="22" y1="8.5" x2="22" y2="15.5" stroke="#000000" stroke-width="0.3" opacity="0.5"/><line x1="16" y1="12" x2="23.5" y2="12" stroke="#000000" stroke-width="0.3" opacity="0.5"/><line x1="12" y1="8" x2="12" y2="4.5" stroke="#000000" stroke-width="0.8"/><ellipse cx="12" cy="3.5" rx="3" ry="1.2" fill="#06b6d4" stroke="#000000" stroke-width="0.8"/><circle cx="12" cy="3.5" r="0.5" fill="#ffffff" opacity="0.9"/><line x1="12" y1="3.5" x2="12" y2="1.5" stroke="#000000" stroke-width="0.5" opacity="0.7"/><line x1="9" y1="9" x2="7" y2="7" stroke="#000000" stroke-width="0.5" opacity="0.6"/><circle cx="6.8" cy="6.8" r="0.3" fill="#000000" opacity="0.6"/><line x1="15" y1="9" x2="17" y2="7" stroke="#000000" stroke-width="0.5" opacity="0.6"/><circle cx="17.2" cy="6.8" r="0.3" fill="#000000" opacity="0.6"/><polygon points="11,16 13,16 13.5,18 10.5,18" fill="#06b6d4" stroke="#000000" stroke-width="0.5" opacity="0.7"/></svg>`),
    civilian: satDataUri(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24"><rect x="11" y="5" width="2" height="14" rx="0.5" fill="#84cc16" stroke="#000000" stroke-width="1.2"/><line x1="11" y1="8" x2="13" y2="10" stroke="#000000" stroke-width="0.4" opacity="0.6"/><line x1="13" y1="8" x2="11" y2="10" stroke="#000000" stroke-width="0.4" opacity="0.6"/><line x1="11" y1="13" x2="13" y2="15" stroke="#000000" stroke-width="0.4" opacity="0.6"/><line x1="13" y1="13" x2="11" y2="15" stroke="#000000" stroke-width="0.4" opacity="0.6"/><rect x="1" y="7" width="9" height="3" rx="0.5" fill="#84cc16" stroke="#000000" stroke-width="1"/><line x1="3.25" y1="7" x2="3.25" y2="10" stroke="#000000" stroke-width="0.3" opacity="0.5"/><line x1="5.5" y1="7" x2="5.5" y2="10" stroke="#000000" stroke-width="0.3" opacity="0.5"/><line x1="7.75" y1="7" x2="7.75" y2="10" stroke="#000000" stroke-width="0.3" opacity="0.5"/><rect x="1" y="14" width="9" height="3" rx="0.5" fill="#84cc16" stroke="#000000" stroke-width="1"/><line x1="3.25" y1="14" x2="3.25" y2="17" stroke="#000000" stroke-width="0.3" opacity="0.5"/><line x1="5.5" y1="14" x2="5.5" y2="17" stroke="#000000" stroke-width="0.3" opacity="0.5"/><line x1="7.75" y1="14" x2="7.75" y2="17" stroke="#000000" stroke-width="0.3" opacity="0.5"/><rect x="14" y="7" width="9" height="3" rx="0.5" fill="#84cc16" stroke="#000000" stroke-width="1"/><line x1="16.25" y1="7" x2="16.25" y2="10" stroke="#000000" stroke-width="0.3" opacity="0.5"/><line x1="18.5" y1="7" x2="18.5" y2="10" stroke="#000000" stroke-width="0.3" opacity="0.5"/><line x1="20.75" y1="7" x2="20.75" y2="10" stroke="#000000" stroke-width="0.3" opacity="0.5"/><rect x="14" y="14" width="9" height="3" rx="0.5" fill="#84cc16" stroke="#000000" stroke-width="1"/><line x1="16.25" y1="14" x2="16.25" y2="17" stroke="#000000" stroke-width="0.3" opacity="0.5"/><line x1="18.5" y1="14" x2="18.5" y2="17" stroke="#000000" stroke-width="0.3" opacity="0.5"/><line x1="20.75" y1="14" x2="20.75" y2="17" stroke="#000000" stroke-width="0.3" opacity="0.5"/><rect x="10" y="3" width="4" height="2" rx="0.5" fill="#84cc16" stroke="#000000" stroke-width="0.8"/><circle cx="11" cy="4" r="0.4" fill="#000000" opacity="0.9"/><circle cx="13" cy="4" r="0.4" fill="#000000" opacity="0.9"/><line x1="12" y1="19" x2="12" y2="22" stroke="#000000" stroke-width="0.6" opacity="0.7"/><circle cx="12" cy="22.5" r="0.8" fill="#84cc16" stroke="#000000" stroke-width="0.5" opacity="0.7"/><circle cx="12" cy="22.5" r="0.3" fill="#000000" opacity="0.7"/></svg>`),
};

// Recon satellite icon — black outline, amber fill, telescope/eye shape
const SAT_RECON_ICON = satDataUri(
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24"><rect x="9.5" y="5" width="5" height="13" rx="1.5" fill="#f59e0b" stroke="#000000" stroke-width="1.2"/><line x1="9.5" y1="8" x2="14.5" y2="8" stroke="#000000" stroke-width="0.5" opacity="0.6"/><line x1="9.5" y1="11" x2="14.5" y2="11" stroke="#000000" stroke-width="0.5" opacity="0.6"/><line x1="9.5" y1="15" x2="14.5" y2="15" stroke="#000000" stroke-width="0.5" opacity="0.6"/><circle cx="12" cy="3.5" r="2.5" fill="#f59e0b" stroke="#000000" stroke-width="1"/><circle cx="12" cy="3.5" r="1.2" fill="#000000" stroke="#000000" stroke-width="0.5" opacity="0.7"/><circle cx="12" cy="3.5" r="0.5" fill="#ffffff" opacity="0.9"/><ellipse cx="12" cy="2" rx="3.2" ry="0.8" fill="#f59e0b" stroke="#000000" stroke-width="0.6" opacity="0.7"/><rect x="1.5" y="9.5" width="7" height="5" rx="0.5" fill="#f59e0b" stroke="#000000" stroke-width="1"/><line x1="4" y1="9.5" x2="4" y2="14.5" stroke="#000000" stroke-width="0.3" opacity="0.5"/><line x1="6.5" y1="9.5" x2="6.5" y2="14.5" stroke="#000000" stroke-width="0.3" opacity="0.5"/><line x1="1.5" y1="12" x2="8.5" y2="12" stroke="#000000" stroke-width="0.3" opacity="0.5"/><rect x="15.5" y="9.5" width="7" height="5" rx="0.5" fill="#f59e0b" stroke="#000000" stroke-width="1"/><line x1="18" y1="9.5" x2="18" y2="14.5" stroke="#000000" stroke-width="0.3" opacity="0.5"/><line x1="20.5" y1="9.5" x2="20.5" y2="14.5" stroke="#000000" stroke-width="0.3" opacity="0.5"/><line x1="15.5" y1="12" x2="22.5" y2="12" stroke="#000000" stroke-width="0.3" opacity="0.5"/><line x1="12" y1="18" x2="12" y2="21" stroke="#000000" stroke-width="0.8" opacity="0.7"/><path d="M10 21 Q12 23 14 21" fill="none" stroke="#000000" stroke-width="0.6" opacity="0.6"/></svg>`
);

const getSatSvg = (type: string, isRecon?: boolean) => {
    if (isRecon) return SAT_RECON_ICON;
    return SAT_ICONS[type] || SAT_ICONS.civilian;
};

// Satellite sensor footprints — projected coverage areas.
//
// Only satellites enriched with real Spectator Earth sensor metadata
// (`sensor.swathMeters > 0` in the /api/satellites payload) get a
// footprint rendered. No hardcoded FOV table — if we don't have a real
// swath width we intentionally show nothing.
//
// Visualisation:
//  - `fp-sat-NAME` — ground ellipse centered on the sub-satellite point
//    (nadir), radius = swathMeters / 2. Semi-axes are STATIC (constants);
//    only the entity position moves.
//  - `beam-sat-NAME#0..7` — 8 polyline rays from the satellite down to
//    evenly-spaced points on the perimeter of the ground ellipse.
//
// Picking/HUD: every footprint entity is metadata-keyed to its parent
// `sat-*` entity so clicks resolve back to the satellite card.
//
// MEDIUM 3 perf fix:
// Entity position + polyline positions used to be CallbackProperty(fn,
// false) — that re-evaluates 360 times per frame at 60 Hz = 21.6k calls/s
// of spherical-earth maths + property wrapping. Replaced with DISCRETE
// updates driven off a clock.onTick listener throttled to FOOTPRINT_UPDATE_MS
// (250 ms / ~4 Hz). ConstantProperty writes only fire when we actually
// mutate them, so the steady-state per-frame cost is zero. Sub-satellite
// drift at 250 ms is subpixel at global zoom and ~1-2 px at city zoom,
// well within acceptable visual slop for a coverage overlay.

// How often to re-project the sub-satellite point and rebuild each
// footprint's ellipse centre + ray endpoints. 250 ms matches a visually
// smooth drift (sub-pixel at global zoom, ~1-2 px at city zoom) while
// cutting per-frame cost by ~15× vs the old CallbackProperty loop.
const FOOTPRINT_UPDATE_MS = 250;

// Meta for every spawned footprint primitive. Globe.tsx picking chain
// looks up fp-*/beam-* ids here to resolve back to the parent sat and
// decorate the HUD card with sensor info.
export interface SatelliteFootprintMeta {
    parentSatId: string;     // "sat-NAME" — parent billboard id
    satName: string;
    subtype: string;         // 'military'/'commercial'/'civilian'/'recon' — mirrors sat.subtype
    sensorName: string;
    sensorType: 'OPTICAL' | 'SAR' | 'OTHER';
    swathMeters: number;
    source: string;          // e.g. 'spectator-earth'
}
export const satelliteFootprintMetaMap = new Map<string, SatelliteFootprintMeta>();

// Number of ray polylines drawn from the satellite to the perimeter of
// the ground ellipse. 8 is a good visual cone — higher values add
// negligible info, lower values stop reading as a 3D volume.
const FOOTPRINT_RAY_COUNT = 8;

/** Per-footprint mutable state — used by the discrete update tick. */
interface FootprintState {
    satEntity: Cesium.Entity;
    ellipseEntity: Cesium.Entity;
    rayEntities: Cesium.Entity[]; // length === FOOTPRINT_RAY_COUNT
    radiusMeters: number;
}

export function useSatellitesLayer(viewer: Cesium.Viewer | null) {
    // sources.satellites = pull TLE from backend; visibility.satellites = show billboards/paths
    const isSourceOn = useTimelineStore(s => s.sources.satellites);
    const isVisible = useTimelineStore(s => s.visibility.satellites);
    const dataSourceRef = useRef<Cesium.CustomDataSource | null>(null);
    // Batched orbit-trail primitive — one GPU draw call for all 300
    // satellites, built from the same SGP4 samples that drive the billboards.
    const trailsPrimitiveRef = useRef<Cesium.Primitive | null>(null);
    // Bumped once the async TLE fetch finishes populating the datasource.
    const [satellitesLoadedTick, setSatellitesLoadedTick] = useState(0);

    // Footprint state — separate datasource so it can be toggled without
    // touching the sat billboards themselves.
    const footprintDsRef = useRef<Cesium.CustomDataSource | null>(null);
    const footprintStatesRef = useRef<FootprintState[]>([]);
    const footprintTickRemoveRef = useRef<Cesium.Event.RemoveCallback | null>(null);

    const isFootprintSourceOn = useTimelineStore(s => s.sources.satelliteFootprints);
    const isFootprintVisible = useTimelineStore(s => s.visibility.satelliteFootprints);

    // ---- Effect 1: sat datasource scene lifetime ----
    useEffect(() => {
        if (!viewer) return;

        const ds = new Cesium.CustomDataSource('satellites');
        viewer.dataSources.add(ds);
        dataSourceRef.current = ds;

        // Clustering available but off by default — 300 satellites is fine
        // without clustering, and clustering causes flickering during rotation.
        ds.clustering.enabled = false;
        ds.clustering.pixelRange = 40;
        ds.clustering.minimumClusterSize = 12;
        const bubble = `data:image/svg+xml,` + encodeURIComponent(
            `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="none" stroke="#000000" stroke-width="0.3" opacity="0.3"/><circle cx="12" cy="12" r="9" fill="none" stroke="#000000" stroke-width="0.4" opacity="0.4"/><circle cx="12" cy="12" r="7" fill="#06b6d4" fill-opacity="0.15" stroke="#000000" stroke-width="1"/><circle cx="12" cy="12" r="4.5" fill="none" stroke="#000000" stroke-width="0.4" opacity="0.5"/><rect x="9" y="8.5" width="1.5" height="1" rx="0.3" fill="#ef4444" stroke="#000000" stroke-width="0.5" opacity="0.8"/><line x1="8" y1="9" x2="9" y2="9" stroke="#000000" stroke-width="0.4" opacity="0.6"/><line x1="10.5" y1="9" x2="11.5" y2="9" stroke="#000000" stroke-width="0.4" opacity="0.6"/><rect x="13" y="11.5" width="1.5" height="1" rx="0.3" fill="#06b6d4" stroke="#000000" stroke-width="0.5" opacity="0.7"/><line x1="12" y1="12" x2="13" y2="12" stroke="#000000" stroke-width="0.4" opacity="0.5"/><line x1="14.5" y1="12" x2="15.5" y2="12" stroke="#000000" stroke-width="0.4" opacity="0.5"/><rect x="10" y="14" width="1.5" height="1" rx="0.3" fill="#84cc16" stroke="#000000" stroke-width="0.5" opacity="0.7"/><line x1="9" y1="14.5" x2="10" y2="14.5" stroke="#000000" stroke-width="0.4" opacity="0.5"/><line x1="11.5" y1="14.5" x2="12.5" y2="14.5" stroke="#000000" stroke-width="0.4" opacity="0.5"/></svg>`
        );
        ds.clustering.clusterEvent.addEventListener((entities, cluster) => {
            cluster.label.show = true;
            cluster.label.text = entities.length.toLocaleString();
            cluster.label.font = 'bold 11px monospace';
            cluster.label.fillColor = Cesium.Color.WHITE;
            cluster.label.style = Cesium.LabelStyle.FILL_AND_OUTLINE;
            cluster.label.outlineWidth = 2;
            cluster.label.outlineColor = Cesium.Color.BLACK;
            cluster.label.verticalOrigin = Cesium.VerticalOrigin.CENTER;
            cluster.label.horizontalOrigin = Cesium.HorizontalOrigin.CENTER;
            cluster.billboard.show = true;
            cluster.billboard.image = bubble;
            cluster.billboard.scale = 0.7 + Math.min(0.5, Math.log10(entities.length) * 0.2);
            cluster.billboard.verticalOrigin = Cesium.VerticalOrigin.CENTER;
            cluster.billboard.horizontalOrigin = Cesium.HorizontalOrigin.CENTER;
        });

        return () => {
            if (viewer && !viewer.isDestroyed()) {
                viewer.dataSources.remove(ds);
                if (trailsPrimitiveRef.current) {
                    viewer.scene.primitives.remove(trailsPrimitiveRef.current);
                }
            }
            dataSourceRef.current = null;
            trailsPrimitiveRef.current = null;
        };
    }, [viewer]);

    // ---- Effect 2: sat fetch lifetime ----
    useEffect(() => {
        if (!viewer || !isSourceOn) return;
        let active = true;

        async function fetchSatellites() {
            const ds = dataSourceRef.current;
            if (!ds) return;
            try {
                const res = await axios.get(`${API_URL}/api/satellites`);
                if (!active) return;

                const data = res.data;
                useTimelineStore.getState().setStreamMetric('satellites', { count: data.length, status: 'streaming' });

                // Drop the old datasource contents before repopulating — a
                // refresh shouldn't leave stale billboards around.
                ds.entities.removeAll();

                // Collect every sampled orbit into one list of GeometryInstance
                // so a single batched Primitive can draw all 300 trails in
                // one GPU call.
                const trailInstances: Cesium.GeometryInstance[] = [];

                // Chunked build — 300 satellites × 120 SGP4 propagations
                // each is a real main-thread spike at cold load. Yield
                // every SAT_CHUNK_SIZE satellites so billboard creation
                // happens in batches small enough that pointer events
                // can drain between chunks.
                const SAT_CHUNK_SIZE = 40;
                const sats = data as any[];
                for (let si = 0; si < sats.length; si++) {
                    if (!active) return;
                    const sat = sats[si];
                    const satrec = satelliteJs.twoline2satrec(sat.tleLine1, sat.tleLine2);
                    const positionProperty = new Cesium.SampledPositionProperty();
                    positionProperty.forwardExtrapolationType = Cesium.ExtrapolationType.HOLD;
                    positionProperty.backwardExtrapolationType = Cesium.ExtrapolationType.HOLD;

                    // Precompute orbits for +/- 2 hours from current time.
                    const now = new Date();
                    const start = Cesium.JulianDate.fromDate(new Date(now.getTime() - 2 * 3600 * 1000));
                    const trailPositions: Cesium.Cartesian3[] = [];

                    // Sample every 2 minutes for 4 hours total
                    for (let i = 0; i <= 120; i += 1) {
                        const time = Cesium.JulianDate.addMinutes(start, i * 2, new Cesium.JulianDate());
                        const jsDate = Cesium.JulianDate.toDate(time);
                        const positionAndVelocity = satelliteJs.propagate(satrec, jsDate);

                        if (positionAndVelocity.position && typeof positionAndVelocity.position !== 'boolean') {
                            const p = positionAndVelocity.position as satelliteJs.EciVec3<number>;
                            const gmst = satelliteJs.gstime(jsDate);
                            const geodetic = satelliteJs.eciToGeodetic(p, gmst);

                            const lon = Cesium.Math.toDegrees(geodetic.longitude);
                            const lat = Cesium.Math.toDegrees(geodetic.latitude);
                            const height = geodetic.height * 1000; // to meters

                            const cPos = Cesium.Cartesian3.fromDegrees(lon, lat, height);
                            positionProperty.addSample(time, cPos);
                            trailPositions.push(cPos);
                        }
                    }

                    const isRecon = sat.recon === true;
                    const trailColor = isRecon
                        ? Cesium.Color.fromCssColorString('#f59e0b').withAlpha(0.5)
                        : sat.type === 'military' ? Cesium.Color.RED.withAlpha(0.3)
                        : sat.type === 'commercial' ? Cesium.Color.CYAN.withAlpha(0.3)
                        : Cesium.Color.LIME.withAlpha(0.3);

                    const entityProps: Record<string, any> = {
                        layer: 'Satellite',
                        subtype: isRecon ? 'recon' : sat.type,
                        noradId: sat.noradId,
                    };
                    if (isRecon && sat.reconMeta) {
                        entityProps.country = sat.reconMeta.country;
                        entityProps.sensorType = sat.reconMeta.sensorType;
                        entityProps.resolution = sat.reconMeta.resolution;
                    }
                    if (sat.sensor) {
                        entityProps.sensor = sat.sensor;
                    }

                    const entityId = `sat-${sat.noradId || sat.name}`;
                    ds.entities.add({
                        id: entityId,
                        name: sat.name,
                        position: positionProperty as any,
                        properties: new Cesium.PropertyBag(entityProps),
                        billboard: {
                            image: getSatSvg(sat.type, isRecon),
                            scale: isRecon ? 1.8 : 1.4,
                        },
                    });

                    // Feed one GeometryInstance per satellite into the batched trail primitive.
                    if (trailPositions.length >= 2) {
                        trailInstances.push(new Cesium.GeometryInstance({
                            geometry: new Cesium.PolylineGeometry({
                                positions: trailPositions,
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

                    // Yield so pointer events can drain between chunks.
                    if ((si + 1) % SAT_CHUNK_SIZE === 0 && si + 1 < sats.length) {
                        await new Promise<void>((resolve) => setTimeout(resolve, 0));
                        if (!active) return;
                        if (!useTimelineStore.getState().sources.satellites) return;
                    }
                }

                // Rebuild the batched trail primitive.
                if (trailsPrimitiveRef.current && viewer && !viewer.isDestroyed()) {
                    viewer.scene.primitives.remove(trailsPrimitiveRef.current);
                    trailsPrimitiveRef.current = null;
                }
                if (trailInstances.length > 0 && viewer && !viewer.isDestroyed()) {
                    const trailsPrimitive = new Cesium.Primitive({
                        geometryInstances: trailInstances,
                        appearance: new Cesium.PolylineColorAppearance({
                            translucent: true,
                        }),
                        releaseGeometryInstances: false,
                    });
                    const freshState = useTimelineStore.getState();
                    trailsPrimitive.show =
                        freshState.visibility.satellites && freshState.showTrajectories;
                    viewer.scene.primitives.add(trailsPrimitive);
                    trailsPrimitiveRef.current = trailsPrimitive;
                }

                setSatellitesLoadedTick(t => t + 1);
            } catch (err: any) {
                console.error('Failed to load satellites layer', err);
                useTimelineStore.getState().setStreamMetric('satellites', { status: 'error' });
            }
        }

        fetchSatellites();

        return () => {
            active = false;
            // Keep datasource + trails primitive — Effect 1 owns them.
        };
    }, [viewer, isSourceOn]);

    // ---- Effect 3: footprint overlay build + discrete update tick ----
    // Builds the footprint entities once per (satellite load × source on)
    // pass, then installs a clock.onTick listener that rewrites positions
    // every FOOTPRINT_UPDATE_MS. No per-frame CallbackProperty evaluation.
    useEffect(() => {
        if (!viewer || !dataSourceRef.current) return;
        if (satellitesLoadedTick === 0) return;
        if (!isFootprintSourceOn) return;

        // Remove old footprint DS if exists (re-entrant safety for tick bumps)
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
        footprintStatesRef.current = [];

        const satDs = dataSourceRef.current;
        const states: FootprintState[] = [];
        let rendered = 0;

        satDs.entities.values.forEach(satEntity => {
            if (!satEntity.position) return;
            const props = satEntity.properties as any;
            const sensor = props?.sensor?.getValue?.();
            if (!sensor || !sensor.swathMeters || sensor.swathMeters <= 0) return;

            const subtype = props?.subtype?.getValue?.() ?? 'civilian';
            const satName = satEntity.name ?? satEntity.id ?? 'satellite';

            const baseColor = subtype === 'military' || subtype === 'recon' ? Cesium.Color.RED
                : subtype === 'commercial' ? Cesium.Color.CYAN
                : Cesium.Color.LIME;

            // Static semi-axis radius — no CallbackProperty. The sensor
            // swath is a fixed physical property, and at our altitudes it
            // doesn't vary with nadir movement in any meaningful way.
            const radiusMeters = sensor.swathMeters / 2;

            // Initial nadir position — will be mutated on every tick.
            const currentTime = viewer.clock.currentTime;
            const initialSatPos = satEntity.position.getValue(currentTime);
            const initialNadir = initialSatPos
                ? (() => {
                    const c = Cesium.Cartographic.fromCartesian(initialSatPos);
                    return Cesium.Cartesian3.fromRadians(c.longitude, c.latitude, 0);
                })()
                : Cesium.Cartesian3.ZERO;

            const footprintId = `fp-${satEntity.id}`;
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
            satelliteFootprintMetaMap.set(footprintId, {
                parentSatId: satEntity.id,
                satName: typeof satName === 'string' ? satName : String(satName),
                subtype,
                sensorName: sensor.sensorName || '',
                sensorType: sensor.sensorType || 'OTHER',
                swathMeters: sensor.swathMeters,
                source: sensor.source || 'spectator-earth',
            });

            // Create the rays with placeholder initial positions — the tick
            // handler will compute the first real set immediately after
            // installation.
            const rayEntities: Cesium.Entity[] = [];
            for (let k = 0; k < FOOTPRINT_RAY_COUNT; k++) {
                const rayId = `beam-${satEntity.id}#${k}`;
                const rayEntity = fpDs.entities.add({
                    id: rayId,
                    polyline: {
                        positions: new Cesium.ConstantProperty(
                            initialSatPos ? [initialSatPos, initialNadir] : [initialNadir, initialNadir]
                        ),
                        width: 1,
                        material: new Cesium.ColorMaterialProperty(baseColor.withAlpha(0.25)),
                    },
                });
                rayEntities.push(rayEntity);
                satelliteFootprintMetaMap.set(rayId, {
                    parentSatId: satEntity.id,
                    satName: typeof satName === 'string' ? satName : String(satName),
                    subtype,
                    sensorName: sensor.sensorName || '',
                    sensorType: sensor.sensorType || 'OTHER',
                    swathMeters: sensor.swathMeters,
                    source: sensor.source || 'spectator-earth',
                });
            }

            states.push({ satEntity, ellipseEntity, rayEntities, radiusMeters });
            rendered++;
        });

        footprintStatesRef.current = states;

        // Discrete update tick — fires at ~60 Hz but gated to run the
        // heavy work only every FOOTPRINT_UPDATE_MS. At the tick rate we
        // pick, each state rewrite costs ~9 ConstantProperty mutations
        // (1 ellipse + 8 rays), so 40 sats × 9 × 4 Hz ≈ 1440 writes/s
        // versus the old ~21.6k CallbackProperty evals/s.
        let lastUpdateMs = 0;
        const R_EARTH = 6_371_000;
        const onTick = () => {
            const nowMs = Date.now();
            if (nowMs - lastUpdateMs < FOOTPRINT_UPDATE_MS) return;
            lastUpdateMs = nowMs;
            const time = viewer.clock.currentTime;
            for (const st of footprintStatesRef.current) {
                const satPos = st.satEntity.position?.getValue(time);
                if (!satPos) continue;
                const carto = Cesium.Cartographic.fromCartesian(satPos);
                const lat1 = carto.latitude;
                const lon1 = carto.longitude;
                const nadir = Cesium.Cartesian3.fromRadians(lon1, lat1, 0);

                // Ellipse centre — mutate the existing ConstantPositionProperty
                // via setValue() instead of allocating a new property object
                // every tick. ~4 Hz × (1 ellipse + 8 rays) per satellite ×
                // the satellites that have footprints meant the old version
                // was churning hundreds of property allocations per second
                // for no reason.
                const ellipsePos = st.ellipseEntity.position as Cesium.ConstantPositionProperty | undefined;
                if (ellipsePos instanceof Cesium.ConstantPositionProperty) {
                    ellipsePos.setValue(nadir);
                } else {
                    st.ellipseEntity.position = new Cesium.ConstantPositionProperty(nadir);
                }

                // Rays: recompute perimeter endpoint per bearing and
                // write into the existing ConstantProperty. Cheap — no
                // CallbackProperty wrapping, just a GPU buffer re-upload
                // at ~4 Hz instead of 60 Hz, and now no wrapper allocation
                // either.
                const angDist = st.radiusMeters / R_EARTH;
                const sinLat1 = Math.sin(lat1);
                const cosLat1 = Math.cos(lat1);
                const cosAng = Math.cos(angDist);
                const sinAng = Math.sin(angDist);
                for (let k = 0; k < st.rayEntities.length; k++) {
                    const angleRad = (k / st.rayEntities.length) * 2 * Math.PI;
                    const lat2 = Math.asin(
                        sinLat1 * cosAng + cosLat1 * sinAng * Math.cos(angleRad)
                    );
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

        // Run one immediate update so the placeholder positions are
        // replaced with real geometry on the very next frame, not after a
        // 250 ms delay.
        onTick();
        footprintTickRemoveRef.current = viewer.clock.onTick.addEventListener(onTick);

        // Surface the rendered count in the Legend.
        useTimelineStore.getState().setStreamMetric('satelliteFootprints', {
            count: rendered,
            status: rendered > 0 ? 'streaming' : 'warning',
            speed: rendered > 0 ? `${rendered} sats` : 'no sensor data',
        });
        console.log(`[Satellites] Rendered ${rendered} sensor footprints from Spectator Earth metadata (discrete tick @ ${FOOTPRINT_UPDATE_MS}ms)`);

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
    const clusteringEnabled = useTimelineStore(s => s.clusteringEnabled);

    // ---- Effect 4: layer visibility + trajectories toggle ----
    // Effective show = sources && visibility. Source-off hides the sat
    // billboards (and halts future fetches via Effect 2).
    useEffect(() => {
        const show = isSourceOn && isVisible;
        if (dataSourceRef.current) {
            dataSourceRef.current.show = show;
        }
        if (trailsPrimitiveRef.current) {
            trailsPrimitiveRef.current.show = show && showTrajectories;
        }
    }, [isSourceOn, isVisible, showTrajectories]);

    // ---- Effect 4a: source-off scene clear ----
    // Drop the sat datasource contents + batched trail primitive so
    // the next source-on rebuilds from a fresh /api/satellites pull.
    useEffect(() => {
        if (isSourceOn) return;
        const ds = dataSourceRef.current;
        if (ds) ds.entities.removeAll();
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

    // ---- Effect 5: clustering toggle ----
    useEffect(() => {
        if (dataSourceRef.current) {
            dataSourceRef.current.clustering.enabled = clusteringEnabled;
        }
    }, [clusteringEnabled]);

    // ---- Effect 6: footprint overlay visibility ----
    useEffect(() => {
        if (footprintDsRef.current) {
            footprintDsRef.current.show = isFootprintSourceOn && isFootprintVisible;
        }
    }, [isFootprintSourceOn, isFootprintVisible]);

    // ---- Effect 6a: footprint source-off metric reset ----
    // Effect 3's cleanup already tears down the footprint datasource
    // when `isFootprintSourceOn` flips false, but the LayerManager row
    // would still show the pre-toggle count/status. Reset the metric
    // so the Sensor Footprints row collapses to "disabled / 0 sats"
    // immediately on source-off.
    useEffect(() => {
        if (isFootprintSourceOn) return;
        useTimelineStore.getState().setStreamMetric('satelliteFootprints', {
            count: 0,
            status: 'disabled',
            speed: '-',
        });
    }, [isFootprintSourceOn]);

    // ---- Effect 7: per-subtype visibility + counts ----
    const subtypeVisibility = useTimelineStore(s => s.subtypeVisibility);
    useEffect(() => {
        if (!viewer) return;
        const ds = dataSourceRef.current;
        if (!ds) return;
        const counts: Record<string, number> = {};
        const trails = trailsPrimitiveRef.current;
        ds.entities.values.forEach(e => {
            const sub = (e.properties as any)?.subtype?.getValue?.() ?? 'unknown';
            counts[sub] = (counts[sub] || 0) + 1;
            const show = subtypeVisibility[`satellites:${sub}`] !== false;
            e.show = show;
            if (trails && trails.ready) {
                const attrs = trails.getGeometryInstanceAttributes(e.id);
                if (attrs) {
                    (attrs as any).show = Cesium.ShowGeometryInstanceAttribute.toValue(show);
                }
            }
        });
        useTimelineStore.getState().setSubtypeCounts('satellites', counts);

        // Ready-gate poll for the batched trail primitive.
        if (trails && !trails.ready) {
            let cancelled = false;
            const poll = () => {
                if (cancelled) return;
                if (!trails.ready) {
                    setTimeout(poll, 50);
                    return;
                }
                ds.entities.values.forEach(e => {
                    const sub = (e.properties as any)?.subtype?.getValue?.() ?? 'unknown';
                    const show = subtypeVisibility[`satellites:${sub}`] !== false;
                    const attrs = trails.getGeometryInstanceAttributes(e.id);
                    if (attrs) {
                        (attrs as any).show = Cesium.ShowGeometryInstanceAttribute.toValue(show);
                    }
                });
            };
            setTimeout(poll, 50);
            return () => { cancelled = true; };
        }
    }, [viewer, subtypeVisibility, satellitesLoadedTick]);
}
