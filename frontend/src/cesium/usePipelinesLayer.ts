import { useEffect, useRef } from 'react';
import * as Cesium from 'cesium';
import axios from 'axios';
import { useTimelineStore } from '../store/useTimelineStore';
import { useSecondaryLoadGate } from './useSecondaryLoadGate';
import { API_URL } from '../lib/config';

// Oil & gas pipelines from OSM Overpass, rendered as batched polylines.
//
// Previous Entity API version created one Entity per pipeline (~8k entities),
// which is prohibitively slow for interactive camera moves. We now batch
// everything into a single Primitive + PolylineGeometry pass with a
// per-instance ColorGeometryInstanceAttribute so oil (red) and gas (blue)
// draw in a single GPU call while keeping per-pipeline picking.
//
// Lifecycle split (HIGH 1 fix):
//   Effect 1 [viewer]             — cleanup-only. Destroys the primitive
//                                   on viewer unmount so frozen pipeline
//                                   data survives source-off flips.
//   Effect 2 [viewer, isSourceOn] — THE ONLY place that triggers the
//                                   one-shot fetch. Uses a promise
//                                   sentinel set synchronously before
//                                   the first await so a second
//                                   invocation on the same tick finds
//                                   the pending load and early-returns.
//                                   Prevents parallel /api/pipelines
//                                   requests that would double-add the
//                                   batched Primitive to the scene.
//   Effect 3 [isVisible]          — flips primitive.show for the Legend.
//   Effect 4 [subtypeVisibility]  — per-subtype (oil/gas) filter.

const OIL_COLOR = Cesium.Color.RED.withAlpha(0.6);
const GAS_COLOR = Cesium.Color.DODGERBLUE.withAlpha(0.6);

// Metadata per pipeline, looked up by Globe.tsx picking + EntityHUD.
export interface PipelineMeta {
    id: string;
    name: string;
    substance: 'oil' | 'gas';
    // Anchor = midpoint of the polyline for EntityHUD fly-to + screen pos.
    lat: number;
    lng: number;
    layer: 'Pipeline';
    source: 'OpenStreetMap';
    description: string;
}

export const pipelineMetaMap = new Map<string, PipelineMeta>();
// Tracks which logical ids belong to each subtype so toggling oil/gas
// visibility doesn't require reading an Overpass-scale metaMap every time.
const pipelineSubtypeIds = new Map<string, string[]>(); // subtype -> logicalIds

export function usePipelinesLayer(viewer: Cesium.Viewer | null) {
    // sources.pipelines = fetch; visibility.pipelines = primitive.show
    const isSourceOn = useTimelineStore((s) => s.sources.pipelines);
    const isVisible = useTimelineStore((s) => s.visibility.pipelines);
    const mode = useTimelineStore((s) => s.mode);
    const primitiveRef = useRef<Cesium.Primitive | null>(null);
    const loadedRef = useRef(false);
    // Shared pending-load sentinel + generation counter. Generation is
    // bumped on source-off so any in-flight fetch bails at the gen check
    // instead of writing stale data to the scene.
    const loadPromiseRef = useRef<Promise<void> | null>(null);
    const genRef = useRef(0);
    const subtypeVisibility = useTimelineStore((s) => s.subtypeVisibility);
    const secondaryReleased = useSecondaryLoadGate();
    // Tracked ready-gate timers so cleanup cancels pending callbacks before
    // the primitive is removed from the scene.
    const pendingTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

    // ---- Effect 1: scene lifetime ----
    useEffect(() => {
        if (!viewer) return;
        return () => {
            pendingTimersRef.current.forEach((t) => clearTimeout(t));
            pendingTimersRef.current.clear();
            pipelineMetaMap.clear();
            pipelineSubtypeIds.clear();
            if (!viewer.isDestroyed() && primitiveRef.current) {
                viewer.scene.primitives.remove(primitiveRef.current);
            }
            primitiveRef.current = null;
            loadedRef.current = false;
            loadPromiseRef.current = null;
        };
    }, [viewer]);

    // ---- Effect 2: single-flight fetch gate ----
    // Deliberately no `cancelled` flag. See useCablesLayer.ts for the
    // full rationale — one-shot Overpass loads must be allowed to
    // complete even across a fast source off→on flip, otherwise the
    // second Effect 2 run early-returns on the pending loadPromiseRef,
    // the first run exits early on cancelled without setting loadedRef,
    // and the layer wedges with no dependency change left to re-trigger.
    useEffect(() => {
        if (!viewer || !isSourceOn || mode === 'playback' || !secondaryReleased) return;
        if (loadedRef.current) return;
        if (loadPromiseRef.current) return;

        const myGen = ++genRef.current;
        const abortController = new AbortController();
        // Self-reference holder so finally can compare without TS2454.
        const self: { promise?: Promise<void> } = {};
        self.promise = (async () => {
            try {
                useTimelineStore.getState().setStreamMetric('pipelines', {
                    status: 'connecting',
                    speed: 'loading...',
                });

                const res = await axios.get(`${API_URL}/api/pipelines`, {
                    signal: abortController.signal,
                    timeout: 150_000, // Overpass can be very slow for global queries
                });
                if (viewer.isDestroyed()) return;
                if (myGen !== genRef.current) return;
                if (!useTimelineStore.getState().sources.pipelines) return;
                const records: any[] = res.data ?? [];
                if (!records.length) {
                    useTimelineStore.getState().setStreamMetric('pipelines', {
                        count: 0,
                        status: 'streaming',
                        speed: 'no data',
                    });
                    loadedRef.current = true;
                    return;
                }

                pipelineMetaMap.clear();
                pipelineSubtypeIds.clear();

                const instances: Cesium.GeometryInstance[] = [];
                const counts: Record<string, number> = { oil: 0, gas: 0 };

                for (let ri = 0; ri < records.length; ri++) {
                    const rec = records[ri];
                    if (!rec.coordinates?.length || rec.coordinates.length < 2) continue;
                    const substance: 'oil' | 'gas' = rec.substance === 'gas' ? 'gas' : 'oil';

                    // Backend sends coords as [lat, lng]. Convert to the
                    // lng,lat,alt flat array Cesium.Cartesian3.fromDegreesArray wants.
                    const degreesFlat: number[] = [];
                    for (const pt of rec.coordinates as [number, number][]) {
                        degreesFlat.push(pt[1], pt[0]);
                    }
                    if (degreesFlat.length < 4) continue;

                    const positions = Cesium.Cartesian3.fromDegreesArray(degreesFlat);

                    // Anchor = midpoint for EntityHUD fly-to + label tether.
                    const midIdx = Math.floor(rec.coordinates.length / 2);
                    const mid = rec.coordinates[midIdx] as [number, number];

                    const logicalId = `pipe-${rec.id || instances.length}`;
                    pipelineMetaMap.set(logicalId, {
                        id: logicalId,
                        name: rec.name || `${substance} pipeline`,
                        substance,
                        lat: mid[0],
                        lng: mid[1],
                        layer: 'Pipeline',
                        source: 'OpenStreetMap',
                        description: rec.name || `${substance} pipeline`,
                    });

                    const color = substance === 'oil' ? OIL_COLOR : GAS_COLOR;
                    instances.push(new Cesium.GeometryInstance({
                        geometry: new Cesium.PolylineGeometry({
                            positions,
                            width: 2.0,
                            vertexFormat: Cesium.PolylineColorAppearance.VERTEX_FORMAT,
                        }),
                        attributes: {
                            color: Cesium.ColorGeometryInstanceAttribute.fromColor(color),
                            show: new Cesium.ShowGeometryInstanceAttribute(true),
                        },
                        id: logicalId,
                    }));

                    counts[substance] = (counts[substance] || 0) + 1;
                    const ids = pipelineSubtypeIds.get(substance) ?? [];
                    ids.push(logicalId);
                    pipelineSubtypeIds.set(substance, ids);

                }

                if (instances.length === 0) {
                    useTimelineStore.getState().setStreamMetric('pipelines', {
                        count: 0,
                        status: 'streaming',
                        speed: 'no data',
                    });
                    loadedRef.current = true;
                    return;
                }

                const primitive = new Cesium.Primitive({
                    geometryInstances: instances,
                    appearance: new Cesium.PolylineColorAppearance({
                        translucent: true,
                    }),
                    releaseGeometryInstances: false,
                });

                if (viewer.isDestroyed()) return;
                if (myGen !== genRef.current) return;
                if (!useTimelineStore.getState().sources.pipelines) return;
                viewer.scene.primitives.add(primitive);
                primitiveRef.current = primitive;
                loadedRef.current = true;
                primitive.show =
                    useTimelineStore.getState().sources.pipelines &&
                    useTimelineStore.getState().visibility.pipelines;

                // Apply the current subtype filter state once the primitive
                // is ready. Tracked timers so unmount can cancel pending
                // callbacks.
                const applyInitialFilters = (firedTimerId?: ReturnType<typeof setTimeout>) => {
                    if (firedTimerId !== undefined) {
                        pendingTimersRef.current.delete(firedTimerId);
                    }
                    if (viewer.isDestroyed()) return;
                    if (!primitive || !primitive.ready) {
                        const t = setTimeout(() => applyInitialFilters(t), 50);
                        pendingTimersRef.current.add(t);
                        return;
                    }
                    const vis = useTimelineStore.getState().subtypeVisibility;
                    applyPipelineFilter(primitive, vis);
                };
                applyInitialFilters();

                useTimelineStore.getState().setStreamMetric('pipelines', {
                    count: pipelineMetaMap.size,
                    status: 'streaming',
                    speed: '-',
                });
                useTimelineStore.getState().setSubtypeCounts('pipelines', counts);
                console.log(`[Pipelines] Rendered ${pipelineMetaMap.size} pipelines (${counts.oil || 0} oil, ${counts.gas || 0} gas) via Primitive`);
            } catch (err: any) {
                if (axios.isCancel(err) || err?.code === 'ERR_CANCELED') return;
                console.warn('[Pipelines] Fetch failed:', err);
                useTimelineStore.getState().setStreamMetric('pipelines', {
                    status: 'error',
                    speed: 'failed',
                });
            } finally {
                if (loadPromiseRef.current === self.promise) {
                    loadPromiseRef.current = null;
                }
            }
        })();
        loadPromiseRef.current = self.promise;

        return () => {
            abortController.abort();
        };
    }, [viewer, isSourceOn, mode, secondaryReleased]);

    // ---- Effect 2a: source-off scene clear ----
    useEffect(() => {
        if (isSourceOn) return;
        if (primitiveRef.current && viewer && !viewer.isDestroyed()) {
            viewer.scene.primitives.remove(primitiveRef.current);
        }
        primitiveRef.current = null;
        loadedRef.current = false;
        loadPromiseRef.current = null;
        genRef.current++;
        pipelineMetaMap.clear();
        pipelineSubtypeIds.clear();
        useTimelineStore.getState().setSubtypeCounts('pipelines', {});
        useTimelineStore.getState().setStreamMetric('pipelines', {
            count: 0,
            status: 'disabled',
            speed: '-',
        });
    }, [isSourceOn, viewer]);

    // ---- Effect 3: layer visibility ----
    // Effective show = sources && visibility.
    useEffect(() => {
        if (primitiveRef.current) primitiveRef.current.show = mode !== 'playback' && isSourceOn && isVisible;
    }, [isSourceOn, isVisible, mode]);

    // ---- Effect 4: per-subtype visibility ----
    useEffect(() => {
        const primitive = primitiveRef.current;
        if (!primitive || !primitive.ready) return;
        applyPipelineFilter(primitive, subtypeVisibility);
    }, [subtypeVisibility]);
}

/**
 * Set GeometryInstance `show` attributes for every pipeline based on the
 * current subtype visibility state. No-op if the primitive isn't ready yet.
 */
function applyPipelineFilter(
    primitive: Cesium.Primitive,
    subtypeVisibility: Record<string, boolean>
) {
    if (!primitive.ready) return;
    pipelineSubtypeIds.forEach((ids, subtype) => {
        const show = subtypeVisibility[`pipelines:${subtype}`] !== false;
        const showValue = Cesium.ShowGeometryInstanceAttribute.toValue(show);
        for (const id of ids) {
            const attrs = primitive.getGeometryInstanceAttributes(id);
            if (attrs) (attrs as any).show = showValue;
        }
    });
}
