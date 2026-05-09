import { useEffect, useRef } from 'react';
import * as Cesium from 'cesium';
import axios from 'axios';
import { useTimelineStore } from '../store/useTimelineStore';
import { API_URL } from '../lib/config';

// Submarine internet cables from TeleGeography. GeoJSON LineString /
// MultiLineString features running along the ocean floor.
//
// Rendered via a batched Polyline Primitive. Previously we
// used the Entity API with `polyline.clampToGround: true`, which forces
// per-frame ground clamping for every entity and kills interactive perf.
// We also avoid GroundPolylinePrimitive here: submarine cables are oceanic
// map overlays, and globe-scale ground clamping is substantially more
// expensive than geodesic polyline geometry while not adding useful visual
// precision for this layer.
//
// Lifecycle split (HIGH 1 fix):
//   Effect 1 [viewer]             — owns the primitive's scene lifetime.
//                                   Runs fetch on initial mount if the
//                                   source is already on, so the data is
//                                   there the first time the user looks.
//                                   Cleanup removes the primitive only
//                                   when the viewer itself goes away.
//   Effect 2 [viewer, isSourceOn] — kicks off the one-shot fetch the first
//                                   time the user flips the source on, if
//                                   it wasn't enabled at mount time. After
//                                   that it's a no-op: cable topology is
//                                   static, there's nothing to re-poll.
//   Effect 3 [isVisible]          — flips primitive.show for the Legend.

// Cable line colour. Applied as a per-instance ColorGeometryInstanceAttribute
// so a single PolylineColorAppearance primitive draws every cable in the
// same pass.
const CABLE_COLOR = Cesium.Color.DEEPSKYBLUE.withAlpha(0.4);

// Metadata per cable, keyed by logical cable id. Multipart MultiLineStrings
// share one logical meta but have multiple instance ids inside the primitive.
export interface CableMeta {
    id: string;
    name: string;
    // Anchor = midpoint of the first line segment (used by EntityHUD fly-to).
    lat: number;
    lng: number;
    layer: 'Cable';
    subtype: 'submarine';
    source: 'TeleGeography';
    description: string;
}

// logicalId -> meta. Looked up by Globe.tsx picking + EntityHUD.
export const cableMetaMap = new Map<string, CableMeta>();
// instanceId (part id) -> logicalId. Used when picking a specific segment.
export const cableInstanceToLogical = new Map<string, string>();

/**
 * Strip a multipart instance id ("cable-123#0") down to its logical id.
 * Safe for single-part ids (no '#') — returns the input unchanged.
 */
export function cableStripPartId(instanceId: string): string {
    const hash = instanceId.indexOf('#');
    return hash === -1 ? instanceId : instanceId.slice(0, hash);
}

export function useCablesLayer(viewer: Cesium.Viewer | null) {
    // sources.cables = fetch; visibility.cables = primitive.show
    const isSourceOn = useTimelineStore(s => s.sources.cables);
    const isVisible = useTimelineStore(s => s.visibility.cables);
    const mode = useTimelineStore(s => s.mode);
    const isolatedEntityId = useTimelineStore(s => s.isolatedEntityId);
    const primitiveRef = useRef<Cesium.Primitive | null>(null);
    // True once the one-shot TeleGeography fetch has finished and the
    // primitive is in the scene. Reset to false on source-off so
    // re-enabling the source fetches and rebuilds from scratch.
    const loadedRef = useRef(false);
    // Pending-fetch sentinel. Set synchronously before the first await
    // so parallel Effect 2 re-runs don't fire duplicate requests. The
    // finally self-check (`if loadPromiseRef === myPromise`) ensures
    // we only clear OUR reference, not a newer one that may have been
    // installed after a source-off → source-on flip invalidated us.
    const loadPromiseRef = useRef<Promise<void> | null>(null);
    // Generation counter bumped on source-off. An in-flight fetch
    // captures the generation at start; if it mismatches at write time
    // the fetch is stale (source flipped off while it was running) and
    // silently bails without touching the scene.
    const genRef = useRef(0);

    // ---- Effect 1: scene lifetime ----
    // Holds no fetch state. Its only job is to destroy the primitive on
    // viewer unmount — the primitive itself is created inside Effect 2
    // once the TeleGeography data lands, so Effect 1 just cleans up.
    useEffect(() => {
        if (!viewer) return;
        return () => {
            cableMetaMap.clear();
            cableInstanceToLogical.clear();
            if (!viewer.isDestroyed() && primitiveRef.current) {
                viewer.scene.primitives.remove(primitiveRef.current);
            }
            primitiveRef.current = null;
            loadedRef.current = false;
            loadPromiseRef.current = null;
        };
    }, [viewer]);

    // ---- Effect 2: fetch gate ----
    // The single place that triggers /api/cables. Fires once when both
    // viewer and source are available, with a promise sentinel set
    // SYNCHRONOUSLY before the first await so a second invocation on the
    // same tick finds it and early-returns — no duplicate requests, no
    // duplicate primitives.
    //
    // Deliberately NO `cancelled` flag. Cables are a one-shot static
    // payload; if the user flips the source off mid-fetch we still let
    // the load complete and materialise. Without this, a fast off→on
    // round-trip during the fetch wedged the layer: the second Effect
    // 2 run would early-return on the pending `loadPromiseRef`, the
    // first run would exit early on `cancelled=true` without setting
    // `loadedRef`, clear the sentinel, and there'd be no dependency
    // change left to re-trigger a fetch. Letting the one-shot always
    // complete side-steps the wedge cleanly — the only kill switch is
    // `viewer.isDestroyed()` which also drops the primitive via
    // Effect 1's cleanup.
    useEffect(() => {
        if (!viewer || !isSourceOn || mode === 'playback') return;
        if (loadedRef.current) return;
        if (loadPromiseRef.current) return; // already loading

        const myGen = ++genRef.current;
        const abortController = new AbortController();
        // Self-reference holder for the async IIFE's finally block.
        // Using a container lets the finally compare
        // `loadPromiseRef.current === self.promise` without tripping
        // TS's "used before assigned" flow analysis on a bare `let`.
        const self: { promise?: Promise<void> } = {};
        self.promise = (async () => {
            try {
                const res = await axios.get(`${API_URL}/api/cables`, {
                    signal: abortController.signal,
                });
                if (viewer.isDestroyed()) return;
                // Stale check — source flipped off while we were loading.
                if (myGen !== genRef.current) return;
                if (!useTimelineStore.getState().sources.cables) return;
                const geojson = res.data;
                if (!geojson?.features?.length) {
                    useTimelineStore.getState().setStreamMetric('cables', {
                        count: 0,
                        status: 'streaming',
                    });
                    loadedRef.current = true;
                    return;
                }

                cableMetaMap.clear();
                cableInstanceToLogical.clear();

                // Build GeometryInstance[] in one pass so we can feed the
                // whole batch to a single Primitive.
                const instances: Cesium.GeometryInstance[] = [];
                const features: any[] = geojson.features;
                for (let fi = 0; fi < features.length; fi++) {
                    const feature = features[fi];
                    const coords = feature.geometry?.coordinates;
                    const name = feature.properties?.name || feature.properties?.cable_id || 'Cable';
                    if (!coords?.length) continue;

                    // GeoJSON can be LineString or MultiLineString.
                    const lines: number[][][] = feature.geometry.type === 'MultiLineString'
                        ? coords
                        : [coords];

                    // Stable logical id: prefer cable_id when present so
                    // picks + counts are consistent across reloads.
                    const logicalId = String(feature.properties?.id || feature.properties?.cable_id || feature.id || `cable:${cableMetaMap.size}`);

                    // Use the midpoint of the first segment as the HUD
                    // anchor. GeoJSON coords are [lng, lat].
                    const firstLine = lines[0];
                    const mid = firstLine[Math.floor(firstLine.length / 2)];
                    const props = feature.properties || {};
                    cableMetaMap.set(logicalId, {
                        id: logicalId,
                        name,
                        lat: mid[1],
                        lng: mid[0],
                        layer: 'Cable',
                        subtype: 'submarine',
                        source: 'TeleGeography',
                        description: name,
                    });

                    lines.forEach((line, partIdx) => {
                        if (!line || line.length < 2) return;
                        // Part ids must be unique inside a single Primitive
                        // because getGeometryInstanceAttributes(id) keys on
                        // them. Single-part features get the plain logical id
                        // (keeps /Globe.tsx lookups simple); multipart features
                        // get "#<index>" suffix.
                        const instanceId = lines.length === 1
                            ? logicalId
                            : `${logicalId}#${partIdx}`;
                        cableInstanceToLogical.set(instanceId, logicalId);

                        const degreesFlat: number[] = [];
                        for (const pt of line) {
                            degreesFlat.push(pt[0], pt[1]);
                        }

                        instances.push(new Cesium.GeometryInstance({
                            geometry: new Cesium.PolylineGeometry({
                                positions: Cesium.Cartesian3.fromDegreesArray(degreesFlat),
                                width: 1.5,
                                vertexFormat: Cesium.PolylineColorAppearance.VERTEX_FORMAT,
                            }),
                            attributes: {
                                // Per-instance colour feeds PolylineColorAppearance.
                                color: Cesium.ColorGeometryInstanceAttribute.fromColor(CABLE_COLOR),
                                // Per-instance show attribute — lets us toggle
                                // individual cables without rebuilding the
                                // whole primitive.
                                show: new Cesium.ShowGeometryInstanceAttribute(true),
                            },
                            id: instanceId,
                        }));
                    });

                }

                if (instances.length === 0) {
                    useTimelineStore.getState().setStreamMetric('cables', {
                        count: 0,
                        status: 'streaming',
                    });
                    loadedRef.current = true;
                    return;
                }

                const primitive = new Cesium.Primitive({
                    geometryInstances: instances,
                    appearance: new Cesium.PolylineColorAppearance({
                        translucent: true,
                    }),
                    // We keep a ref for visibility toggle; no releasing the
                    // geometry instances because we never rebuild per tile.
                    releaseGeometryInstances: false,
                });

                if (viewer.isDestroyed()) return;
                if (myGen !== genRef.current) return;
                if (!useTimelineStore.getState().sources.cables) return;
                viewer.scene.primitives.add(primitive);
                primitiveRef.current = primitive;
                loadedRef.current = true;
                // Read visibility fresh from the store so a toggle-off that
                // happened during the async fetch is respected immediately
                // instead of flashing into view until the next toggle.
                primitive.show =
                    useTimelineStore.getState().sources.cables &&
                    useTimelineStore.getState().visibility.cables;

                useTimelineStore.getState().setStreamMetric('cables', {
                    count: cableMetaMap.size,
                    status: 'streaming',
                });
                console.log(`[Cables] Rendered ${instances.length} segments (${cableMetaMap.size} cables) via Polyline Primitive`);
            } catch (err: any) {
                if (axios.isCancel(err) || err?.code === 'ERR_CANCELED') return;
                console.warn('[Cables] Fetch failed:', err?.message || err);
                useTimelineStore.getState().setStreamMetric('cables', { status: 'error' });
            } finally {
                // Only clear the sentinel if it still points at MY promise.
                // A source-off-clear may have already nulled it and a new
                // fetch installed a different promise; in that case we must
                // not clobber the newcomer.
                if (loadPromiseRef.current === self.promise) {
                    loadPromiseRef.current = null;
                }
            }
        })();
        loadPromiseRef.current = self.promise;

        return () => {
            abortController.abort();
        };
    }, [viewer, isSourceOn, mode]);

    // ---- Effect 3: visibility toggle ----
    // Effective show = sources && visibility.
    useEffect(() => {
        if (primitiveRef.current) primitiveRef.current.show = mode !== 'playback' && isSourceOn && isVisible;
    }, [isSourceOn, isVisible, mode]);

    // ---- Effect 3a: solo filter (isolatedEntityId) ----
    // Per-instance show toggle via ShowGeometryInstanceAttribute. The
    // primitive must be ready before getGeometryInstanceAttributes works,
    // so bail early if it isn't.
    useEffect(() => {
        const prim = primitiveRef.current;
        if (!prim || !prim.ready) return;
        const showAll = Cesium.ShowGeometryInstanceAttribute.toValue(true);
        const showNone = Cesium.ShowGeometryInstanceAttribute.toValue(false);
        cableInstanceToLogical.forEach((_logicalId, instanceId) => {
            const logicalId = cableInstanceToLogical.get(instanceId);
            const visible = !isolatedEntityId || isolatedEntityId === logicalId;
            const attrs = prim.getGeometryInstanceAttributes(instanceId);
            if (attrs) (attrs as any).show = visible ? showAll : showNone;
        });
    }, [isolatedEntityId]);

    // ---- Effect 4: source-off scene clear ----
    // When the user turns the cables source OFF we drop the primitive
    // and reset the load sentinels so the next source-on fires a fresh
    // fetch. Matches the "source off = nothing visible, source on =
    // current data" deterministic model; no cached snapshot survives
    // the toggle.
    useEffect(() => {
        if (isSourceOn) return;
        if (primitiveRef.current && viewer && !viewer.isDestroyed()) {
            viewer.scene.primitives.remove(primitiveRef.current);
        }
        primitiveRef.current = null;
        loadedRef.current = false;
        loadPromiseRef.current = null;
        // Invalidate any in-flight fetch so its scene write bails on the
        // generation check. A subsequent source-on bumps genRef again
        // (new fetch starts with a fresh generation number).
        genRef.current++;
        cableMetaMap.clear();
        cableInstanceToLogical.clear();
        useTimelineStore.getState().setStreamMetric('cables', {
            count: 0,
            status: 'disabled',
        });
    }, [isSourceOn, viewer]);
}
