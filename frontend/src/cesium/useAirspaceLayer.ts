import { useEffect, useRef } from 'react';
import * as Cesium from 'cesium';
import axios from 'axios';
import { useTimelineStore } from '../store/useTimelineStore';
import { API_URL } from '../lib/config';

// Restricted airspace from OpenAIP, rendered as two batched Primitives:
// one for the translucent volume fill, one for the outline wireframe.
// The previous Entity API version created a CustomDataSource entity per
// polygon, which at 10k+ zones with extruded volumes is enough to choke
// the render thread on every camera move. Primitive API with per-instance
// color + show attributes gives us the same visual at one draw call per
// primitive while keeping picking, subtype filters and the HUD working.
//
// Lifecycle split (HIGH 1 fix):
//   Effect 1 [viewer]             — scene lifetime. Owns the fill +
//                                   outline primitive refs. Cleanup only
//                                   on viewer unmount, never on source off.
//   Effect 2 [viewer, isSourceOn] — lazy-load on first enable, then runs
//                                   the hourly refresh while the source
//                                   stays on. Interval clears on source
//                                   off but the already-loaded polygons
//                                   stay visible (frozen snapshot).
//   Effect 3 [isVisible]          — flips primitive.show for the Legend.
//   Effect 4 [subtypeVisibility]  — per-subtype filter.

// Airspace type codes per OpenAIP API v2
const TYPE_COLORS: Record<number, Cesium.Color> = {
    1: Cesium.Color.RED,        // Restricted
    2: Cesium.Color.ORANGE,     // Danger
    3: Cesium.Color.DARKRED,    // Prohibited
    17: Cesium.Color.YELLOW,    // Alert
    18: Cesium.Color.GOLD,      // Warning
};

const TYPE_SUBTYPE: Record<number, string> = {
    1: 'restricted',
    2: 'danger',
    3: 'prohibited',
    17: 'alert',
    18: 'warning',
};

export interface AirspaceMeta {
    id: string;
    name: string;
    type: number;
    typeName: string;
    subtype: string;
    upperLimit: number;
    lowerLimit: number;
    // Anchor point (centroid of the first polygon's outer ring) used by
    // EntityHUD fly-to and the HUD leader line.
    lat: number;
    lng: number;
    layer: 'Airspace';
    source: 'OpenAIP';
}

// logicalId -> meta
export const airspaceMetaMap = new Map<string, AirspaceMeta>();
// instanceId (part id like "airspace-42#0#fill") -> logicalId
export const airspaceInstanceToLogical = new Map<string, string>();
// subtype -> list of part ids (for fast subtype visibility toggle)
const airspacePartsBySubtype = new Map<string, { fill: string[]; outline: string[] }>();

/**
 * Strip an airspace part id (`airspace-42#0#fill`) down to its logical id.
 */
export function airspaceStripPartId(instanceId: string): string {
    const hash = instanceId.indexOf('#');
    return hash === -1 ? instanceId : instanceId.slice(0, hash);
}

interface AirspacePolygon {
    outer: [number, number][];
    holes: [number, number][][];
}

interface AirspaceZoneDTO {
    id: string;
    name: string;
    type: number;
    typeName: string;
    upperLimit: number;
    lowerLimit: number;
    geometry: AirspacePolygon[];
}

/**
 * Rough centroid of a ring in [lat,lng] format. Used only for the HUD
 * anchor — no need to be precise.
 */
function ringCentroid(ring: [number, number][]): [number, number] {
    let sumLat = 0, sumLng = 0;
    for (const pt of ring) { sumLat += pt[0]; sumLng += pt[1]; }
    return [sumLat / ring.length, sumLng / ring.length];
}

export function useAirspaceLayer(viewer: Cesium.Viewer | null) {
    const isSourceOn = useTimelineStore(s => s.sources.airspace);
    const isVisible = useTimelineStore(s => s.visibility.airspace);
    const subtypeVisibility = useTimelineStore(s => s.subtypeVisibility);
    const fillPrimitiveRef = useRef<Cesium.Primitive | null>(null);
    const outlinePrimitiveRef = useRef<Cesium.Primitive | null>(null);
    // Load state. `hasLoadedRef` is reset on source-off so the next
    // source-on starts a fresh fetch (matches the deterministic
    // "source off = nothing, source on = fresh data" pipeline).
    const hasLoadedRef = useRef(false);
    // In-flight guard for the async fetch path + generation counter so
    // a source-off flip during an in-flight load invalidates the write.
    const inFlightRef = useRef(false);
    const genRef = useRef(0);
    // Active flag tracks viewer lifetime — flipped off on viewer unmount
    // so late async responses don't touch a destroyed scene.
    const activeRef = useRef(false);
    // Tracked timers/intervals so cleanup doesn't leave ready-gate callbacks
    // attached to stale primitives after unmount.
    const pendingTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
    // The shared fetch function, stored in a ref so Effect 2 can call it
    // without re-declaring it on every source toggle.
    const fetchAirspaceRef = useRef<(() => Promise<void>) | null>(null);

    // ---- Effect 1: scene lifetime ----
    // Defines the fetch function and tears down the primitives on viewer
    // unmount. Note: primitives themselves are only created inside
    // fetchAirspace() after the data lands, so the refs may be null until
    // the first load completes.
    useEffect(() => {
        if (!viewer) return;
        activeRef.current = true;

        async function fetchAirspace() {
            if (inFlightRef.current) return; // guard against parallel fetches
            inFlightRef.current = true;
            const myGen = genRef.current;
            try {
                const res = await axios.get(`${API_URL}/api/airspace`);
                if (!activeRef.current || viewer!.isDestroyed()) return;
                // Stale check — source flipped off while we were loading.
                if (myGen !== genRef.current) return;
                if (!useTimelineStore.getState().sources.airspace) return;

                const zones: AirspaceZoneDTO[] = res.data ?? [];

                // Remove previous primitives if any (on refresh)
                if (fillPrimitiveRef.current && !viewer!.isDestroyed()) {
                    viewer!.scene.primitives.remove(fillPrimitiveRef.current);
                    fillPrimitiveRef.current = null;
                }
                if (outlinePrimitiveRef.current && !viewer!.isDestroyed()) {
                    viewer!.scene.primitives.remove(outlinePrimitiveRef.current);
                    outlinePrimitiveRef.current = null;
                }
                airspaceMetaMap.clear();
                airspaceInstanceToLogical.clear();
                airspacePartsBySubtype.clear();

                const fillInstances: Cesium.GeometryInstance[] = [];
                const outlineInstances: Cesium.GeometryInstance[] = [];
                const counts: Record<string, number> = {};

                // Chunked build — 10k+ airspace zones in a single sync
                // pass constructs ~20k PolygonGeometry objects on the
                // main thread, which stalls input for seconds at boot.
                // Yielding every AIRSPACE_CHUNK_SIZE zones keeps the
                // browser processing clicks / drag / wheel while the
                // rest of the zones stream in.
                const AIRSPACE_CHUNK_SIZE = 300;
                for (let zi = 0; zi < zones.length; zi++) {
                    const zone = zones[zi];
                    if (!zone.geometry || zone.geometry.length === 0) continue;

                    const color = TYPE_COLORS[zone.type] || Cesium.Color.RED;
                    const fillColor = color.withAlpha(0.15);
                    const outlineColor = color.withAlpha(0.6);
                    const subtype = TYPE_SUBTYPE[zone.type] ?? zone.typeName.toLowerCase();

                    // Build volume heights: Cesium wants absolute altitudes.
                    // Clamp upper to 20km to prevent extreme extrusions on
                    // zones with unrealistic upper limits.
                    const height = zone.lowerLimit || 0;
                    const extrudedHeight = Math.min(zone.upperLimit || 5000, 20000);
                    if (extrudedHeight <= height) continue;

                    // HUD anchor = centroid of the first polygon's outer ring.
                    const firstOuter = zone.geometry[0]?.outer;
                    if (!firstOuter || firstOuter.length < 3) continue;
                    const [anchorLat, anchorLng] = ringCentroid(firstOuter);

                    airspaceMetaMap.set(zone.id, {
                        id: zone.id,
                        name: zone.name,
                        type: zone.type,
                        typeName: zone.typeName,
                        subtype,
                        upperLimit: zone.upperLimit,
                        lowerLimit: zone.lowerLimit,
                        lat: anchorLat,
                        lng: anchorLng,
                        layer: 'Airspace',
                        source: 'OpenAIP',
                    });

                    // One GeometryInstance per polygon part (Polygon = 1,
                    // MultiPolygon = N). Fill + outline share the same logical
                    // id but use distinct suffixes inside the primitive.
                    const subtypeParts = airspacePartsBySubtype.get(subtype)
                        ?? { fill: [], outline: [] };

                    zone.geometry.forEach((poly, polyIdx) => {
                        if (!poly.outer || poly.outer.length < 3) return;

                        // Convert outer + holes into Cartesian3 arrays.
                        const outerPositions = poly.outer.map(([lat, lng]) =>
                            Cesium.Cartesian3.fromDegrees(lng, lat)
                        );
                        const holePolygons = (poly.holes ?? []).map((ring) => {
                            const positions = ring.map(([lat, lng]) =>
                                Cesium.Cartesian3.fromDegrees(lng, lat)
                            );
                            return new Cesium.PolygonHierarchy(positions);
                        });
                        const hierarchy = new Cesium.PolygonHierarchy(
                            outerPositions,
                            holePolygons
                        );

                        const fillId = `${zone.id}#${polyIdx}#fill`;
                        const outlineId = `${zone.id}#${polyIdx}#outline`;
                        airspaceInstanceToLogical.set(fillId, zone.id);
                        airspaceInstanceToLogical.set(outlineId, zone.id);
                        subtypeParts.fill.push(fillId);
                        subtypeParts.outline.push(outlineId);

                        // Fill: extruded PolygonGeometry with volume vertex
                        // format so PerInstanceColorAppearance can shade it.
                        fillInstances.push(new Cesium.GeometryInstance({
                            geometry: new Cesium.PolygonGeometry({
                                polygonHierarchy: hierarchy,
                                height,
                                extrudedHeight,
                                vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
                            }),
                            attributes: {
                                color: Cesium.ColorGeometryInstanceAttribute.fromColor(fillColor),
                                show: new Cesium.ShowGeometryInstanceAttribute(true),
                            },
                            id: fillId,
                        }));

                        // Outline: PolygonOutlineGeometry gives the full
                        // wireframe (top, bottom, verticals). Matches the
                        // previous Entity API visual.
                        outlineInstances.push(new Cesium.GeometryInstance({
                            geometry: new Cesium.PolygonOutlineGeometry({
                                polygonHierarchy: hierarchy,
                                height,
                                extrudedHeight,
                                vertexFormat: Cesium.PerInstanceColorAppearance.FLAT_VERTEX_FORMAT,
                            }),
                            attributes: {
                                color: Cesium.ColorGeometryInstanceAttribute.fromColor(outlineColor),
                                show: new Cesium.ShowGeometryInstanceAttribute(true),
                            },
                            id: outlineId,
                        }));
                    });

                    airspacePartsBySubtype.set(subtype, subtypeParts);
                    counts[subtype] = (counts[subtype] || 0) + 1;

                    // Yield once per chunk so pointer events aren't
                    // starved by the polygon geometry construction.
                    if ((zi + 1) % AIRSPACE_CHUNK_SIZE === 0 && zi + 1 < zones.length) {
                        await new Promise<void>((resolve) => setTimeout(resolve, 0));
                        if (!activeRef.current || viewer!.isDestroyed()) return;
                        if (myGen !== genRef.current) return;
                        if (!useTimelineStore.getState().sources.airspace) return;
                    }
                }

                if (fillInstances.length === 0) {
                    useTimelineStore.getState().setSubtypeCounts('airspace' as any, counts);
                    hasLoadedRef.current = true;
                    return;
                }

                const fillPrimitive = new Cesium.Primitive({
                    geometryInstances: fillInstances,
                    appearance: new Cesium.PerInstanceColorAppearance({
                        translucent: true,
                        closed: true,
                    }),
                    releaseGeometryInstances: false,
                });
                const outlinePrimitive = new Cesium.Primitive({
                    geometryInstances: outlineInstances,
                    appearance: new Cesium.PerInstanceColorAppearance({
                        flat: true,
                        translucent: true,
                        // Outlines must render as lines, not triangles.
                        renderState: {
                            lineWidth: 1,
                        },
                    }),
                    releaseGeometryInstances: false,
                });

                if (!activeRef.current || viewer!.isDestroyed()) return;
                if (myGen !== genRef.current) return;
                if (!useTimelineStore.getState().sources.airspace) return;
                viewer!.scene.primitives.add(fillPrimitive);
                viewer!.scene.primitives.add(outlinePrimitive);
                fillPrimitiveRef.current = fillPrimitive;
                outlinePrimitiveRef.current = outlinePrimitive;
                hasLoadedRef.current = true;
                // Read both flags fresh from the store — the selectors
                // captured in closure may be stale after a long refresh.
                const store = useTimelineStore.getState();
                const currentShow = store.sources.airspace && store.visibility.airspace;
                fillPrimitive.show = currentShow;
                outlinePrimitive.show = currentShow;

                // Report the real rendered zone count (some source records
                // get dropped by geometry/height validation upstream), not
                // the raw zones.length.
                useTimelineStore.getState().setStreamMetric('airspace', {
                    count: airspaceMetaMap.size,
                    status: 'streaming',
                });

                // Apply the current subtype filter state once both primitives
                // are ready. Tracked-timer polling so unmount can cancel
                // pending callbacks — otherwise they'd touch stale primitives
                // after viewer.scene.primitives.remove().
                const applyInitialFilters = (firedTimerId?: ReturnType<typeof setTimeout>) => {
                    // Drop this timer id from the pending set as soon as
                    // the callback runs — otherwise fired timers accumulate
                    // indefinitely while the hook stays mounted.
                    if (firedTimerId !== undefined) {
                        pendingTimersRef.current.delete(firedTimerId);
                    }
                    if (!activeRef.current) return;
                    if (!fillPrimitive.ready || !outlinePrimitive.ready) {
                        const t = setTimeout(() => applyInitialFilters(t), 50);
                        pendingTimersRef.current.add(t);
                        return;
                    }
                    applyAirspaceFilter(
                        fillPrimitive,
                        outlinePrimitive,
                        useTimelineStore.getState().subtypeVisibility
                    );
                };
                applyInitialFilters();

                useTimelineStore.getState().setSubtypeCounts('airspace' as any, counts);
                console.log(
                    `[Airspace] Rendered ${airspaceMetaMap.size} zones ` +
                    `(${fillInstances.length} polygon parts) via dual Primitive`
                );
            } catch (err) {
                console.warn('[Airspace] Fetch failed:', err);
                useTimelineStore.getState().setStreamMetric('airspace', { status: 'error' });
            } finally {
                inFlightRef.current = false;
            }
        }

        fetchAirspaceRef.current = fetchAirspace;

        return () => {
            activeRef.current = false;
            // Cancel any pending ready-gate poll callbacks so they don't
            // touch primitives we're about to free.
            pendingTimersRef.current.forEach((t) => clearTimeout(t));
            pendingTimersRef.current.clear();

            if (fillPrimitiveRef.current && viewer && !viewer.isDestroyed()) {
                viewer.scene.primitives.remove(fillPrimitiveRef.current);
            }
            if (outlinePrimitiveRef.current && viewer && !viewer.isDestroyed()) {
                viewer.scene.primitives.remove(outlinePrimitiveRef.current);
            }
            fillPrimitiveRef.current = null;
            outlinePrimitiveRef.current = null;
            hasLoadedRef.current = false;
            fetchAirspaceRef.current = null;
            airspaceMetaMap.clear();
            airspaceInstanceToLogical.clear();
            airspacePartsBySubtype.clear();
        };
    }, [viewer]);

    // ---- Effect 2: fetch lifetime ----
    // On source-on, trigger the lazy load (if not already loaded) and then
    // keep an hourly interval alive while the source stays on. Source-off
    // clears the interval but leaves the already-rendered zones in place.
    useEffect(() => {
        if (!viewer || !isSourceOn) return;
        if (!fetchAirspaceRef.current) return;

        if (!hasLoadedRef.current) {
            fetchAirspaceRef.current();
        }
        const interval = setInterval(() => {
            fetchAirspaceRef.current?.();
        }, 60 * 60 * 1000);

        return () => {
            clearInterval(interval);
        };
    }, [viewer, isSourceOn]);

    // ---- Effect 3: visibility toggle ----
    // Effective show = sources && visibility. If no data exists yet,
    // this is a no-op (primitives are null until fetch completes).
    useEffect(() => {
        const show = isSourceOn && isVisible;
        if (fillPrimitiveRef.current) fillPrimitiveRef.current.show = show;
        if (outlinePrimitiveRef.current) outlinePrimitiveRef.current.show = show;
    }, [isSourceOn, isVisible]);

    // ---- Effect 3a: source-off scene clear ----
    // On source-off drop both primitives and reset the load sentinels.
    // Next source-on re-enters Effect 2 with hasLoadedRef = false and
    // triggers a fresh /api/airspace fetch, so re-enable always shows
    // current data rather than a cached pre-toggle snapshot.
    //
    // Critically we ALSO reset `inFlightRef` and bump `genRef`. Without
    // those, a pending /api/airspace fetch (with its in-flight guard
    // still set) would block the re-enable path's `fetchAirspaceRef`
    // call from firing, and the stale request's gen-check bail would
    // never trigger a follow-up refetch.
    useEffect(() => {
        if (isSourceOn) return;
        if (fillPrimitiveRef.current && viewer && !viewer.isDestroyed()) {
            viewer.scene.primitives.remove(fillPrimitiveRef.current);
        }
        if (outlinePrimitiveRef.current && viewer && !viewer.isDestroyed()) {
            viewer.scene.primitives.remove(outlinePrimitiveRef.current);
        }
        fillPrimitiveRef.current = null;
        outlinePrimitiveRef.current = null;
        hasLoadedRef.current = false;
        inFlightRef.current = false;
        genRef.current++;
        airspaceMetaMap.clear();
        airspaceInstanceToLogical.clear();
        airspacePartsBySubtype.clear();
        useTimelineStore.getState().setSubtypeCounts('airspace' as any, {});
        useTimelineStore.getState().setStreamMetric('airspace', {
            count: 0,
            status: 'disabled',
        });
    }, [isSourceOn, viewer]);

    // ---- Effect 4: per-subtype visibility ----
    useEffect(() => {
        const fill = fillPrimitiveRef.current;
        const outline = outlinePrimitiveRef.current;
        if (!fill || !outline || !fill.ready || !outline.ready) return;
        applyAirspaceFilter(fill, outline, subtypeVisibility);
    }, [subtypeVisibility]);
}

function applyAirspaceFilter(
    fill: Cesium.Primitive,
    outline: Cesium.Primitive,
    subtypeVisibility: Record<string, boolean>
) {
    if (!fill.ready || !outline.ready) return;
    airspacePartsBySubtype.forEach((parts, subtype) => {
        const show = subtypeVisibility[`airspace:${subtype}`] !== false;
        const showValue = Cesium.ShowGeometryInstanceAttribute.toValue(show);
        for (const id of parts.fill) {
            const attrs = fill.getGeometryInstanceAttributes(id);
            if (attrs) (attrs as any).show = showValue;
        }
        for (const id of parts.outline) {
            const attrs = outline.getGeometryInstanceAttributes(id);
            if (attrs) (attrs as any).show = showValue;
        }
    });
}
