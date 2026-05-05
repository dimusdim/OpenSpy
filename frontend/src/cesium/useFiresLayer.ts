import { useEffect, useRef } from 'react';
import * as Cesium from 'cesium';
import axios from 'axios';
import { useTimelineStore } from '../store/useTimelineStore';
import { useSecondaryLoadGate } from './useSecondaryLoadGate';
import { API_URL } from '../lib/config';
import { getViewerAltitudeMeters } from './position-utils';

declare global {
    interface Window {
        __openspyFireStats?: {
            renderMode: 'raw' | 'cluster';
            rawHotspots: number;
            renderedMarkers: number;
            gridDegrees: number | null;
        };
    }
}

export interface FireMeta {
    lat: number;
    lng: number;
    frp: number;
    subtype: 'high' | 'medium' | 'low';
    aggregated?: boolean;
    count?: number;
}

type FireRecord = FireMeta & {
    id: string;
};

export const fireMetaMap = new Map<string, FireMeta>();

function colorForSubtype(sub: 'high' | 'medium' | 'low'): Cesium.Color {
    if (sub === 'high') return Cesium.Color.fromCssColorString('#ef4444').withAlpha(0.95);
    if (sub === 'medium') return Cesium.Color.fromCssColorString('#f97316').withAlpha(0.9);
    return Cesium.Color.fromCssColorString('#eab308').withAlpha(0.85);
}

function frpSubtype(frp: number): 'high' | 'medium' | 'low' {
    if (frp > 100) return 'high';
    if (frp > 30) return 'medium';
    return 'low';
}

function pixelSizeForFrp(frp: number): number {
    return Math.max(3.0, Math.min(9.0, 3.0 + Math.log2(Math.max(1, frp)) * 0.8));
}

function pixelSizeForCluster(count: number, maxFrp: number): number {
    return Math.max(6.0, Math.min(18.0, 5.0 + Math.log2(Math.max(1, count)) * 2.0 + Math.log2(Math.max(1, maxFrp)) * 0.4));
}

function getClusterGridDegrees(altitudeMeters: number | null): number | null {
    if (altitudeMeters == null) return 2.0;
    if (altitudeMeters >= 10_000_000) return 4.0;
    if (altitudeMeters >= 5_000_000) return 2.0;
    if (altitudeMeters >= 2_000_000) return 1.0;
    return null;
}

const CAMERA_CULL_DEBOUNCE_MS = 150;

export function useFiresLayer(viewer: Cesium.Viewer | null) {
    const isSourceOn = useTimelineStore(s => s.sources.fires);
    const isVisible = useTimelineStore(s => s.visibility.fires);
    const mode = useTimelineStore(s => s.mode);
    const subtypeVisibility = useTimelineStore(s => s.subtypeVisibility);
    const isolatedEntityId = useTimelineStore(s => s.isolatedEntityId);
    const secondaryReleased = useSecondaryLoadGate();
    // Global clustering toggle (see TileModeToggle button). When false,
    // fires always render raw — ignore altitude-based grid aggregation.
    const clusteringEnabled = useTimelineStore(s => s.clusteringEnabled);

    const rawCollectionRef = useRef<Cesium.PointPrimitiveCollection | null>(null);
    const clusterCollectionRef = useRef<Cesium.PointPrimitiveCollection | null>(null);
    const fireRecordsRef = useRef<FireRecord[]>([]);
    const clusterIdsRef = useRef<Set<string>>(new Set());
    const dataVersionRef = useRef(0);
    const rawBuiltVersionRef = useRef(-1);
    const renderModeRef = useRef<'raw' | 'cluster'>('raw');
    const activeGridDegreesRef = useRef<number | null>(null);
    const responseAggregatedRef = useRef(false);
    const fetchInFlightRef = useRef(false);
    const refreshPresentationRef = useRef<(() => Promise<void>) | null>(null);
    const updateCollectionVisibilityRef = useRef<(() => void) | null>(null);
    const fetchNowRef = useRef<(() => Promise<void>) | null>(null);

    const requestSceneRender = () => {
        if (!viewer || viewer.isDestroyed()) return;
        viewer.scene.requestRender();
    };

    useEffect(() => {
        if (!viewer) return;

        const rawCollection = new Cesium.PointPrimitiveCollection({
            blendOption: Cesium.BlendOption.TRANSLUCENT,
        });
        const clusterCollection = new Cesium.PointPrimitiveCollection({
            blendOption: Cesium.BlendOption.TRANSLUCENT,
        });

        viewer.scene.primitives.add(rawCollection);
        viewer.scene.primitives.add(clusterCollection);
        rawCollectionRef.current = rawCollection;
        clusterCollectionRef.current = clusterCollection;

        const clearClusterMeta = () => {
            clusterIdsRef.current.forEach((id) => {
                fireMetaMap.delete(id);
            });
            clusterIdsRef.current.clear();
        };

        const clearClusterCollection = () => {
            clearClusterMeta();
            clusterCollection.removeAll();
        };

        const publishStats = () => {
            window.__openspyFireStats = {
                renderMode: renderModeRef.current,
                rawHotspots: fireRecordsRef.current.length,
                renderedMarkers: renderModeRef.current === 'cluster' ? clusterCollection.length : rawCollection.length,
                gridDegrees: activeGridDegreesRef.current,
            };
        };

        const updateCollectionVisibility = () => {
            const state = useTimelineStore.getState();
            const showLayer = state.mode !== 'playback' && state.sources.fires && state.visibility.fires;
            rawCollection.show = showLayer && renderModeRef.current === 'raw';
            clusterCollection.show = showLayer && renderModeRef.current === 'cluster';
        };
        updateCollectionVisibilityRef.current = updateCollectionVisibility;

        const cullRawForViewport = () => {
            if (renderModeRef.current !== 'raw') return;
            const storeState = useTimelineStore.getState();
            const subVis = storeState.subtypeVisibility;
            const isolated = storeState.isolatedEntityId;
            const rect = viewer.camera.computeViewRectangle();

            if (!rect) {
                for (let i = 0; i < rawCollection.length; i++) {
                    const point = rawCollection.get(i);
                    const meta = fireMetaMap.get(point.id as string);
                    point.show = !!meta
                        && subVis[`fires:${meta.subtype}`] !== false
                        && (!isolated || isolated === point.id);
                }
                return;
            }

            const south = Cesium.Math.toDegrees(rect.south);
            const north = Cesium.Math.toDegrees(rect.north);
            const west = Cesium.Math.toDegrees(rect.west);
            const east = Cesium.Math.toDegrees(rect.east);
            const crossAM = east < west;

            for (let i = 0; i < rawCollection.length; i++) {
                const point = rawCollection.get(i);
                const meta = fireMetaMap.get(point.id as string);
                if (!meta) {
                    point.show = false;
                    continue;
                }
                if (isolated && isolated !== point.id) {
                    point.show = false;
                    continue;
                }
                if (subVis[`fires:${meta.subtype}`] === false) {
                    point.show = false;
                    continue;
                }
                const inLat = meta.lat >= south && meta.lat <= north;
                const inLng = crossAM
                    ? meta.lng >= west || meta.lng <= east
                    : meta.lng >= west && meta.lng <= east;
                point.show = inLat && inLng;
            }
        };

        const ensureRawCollection = async () => {
            if (rawBuiltVersionRef.current === dataVersionRef.current) return;

            rawCollection.removeAll();
            const records = fireRecordsRef.current;
            for (let i = 0; i < records.length; i++) {
                const fire = records[i];
                rawCollection.add({
                    position: Cesium.Cartesian3.fromDegrees(fire.lng, fire.lat, 0),
                    color: colorForSubtype(fire.subtype),
                    outlineColor: Cesium.Color.BLACK.withAlpha(0.35),
                    outlineWidth: 1,
                    pixelSize: pixelSizeForFrp(fire.frp),
                    id: fire.id,
                });
                fireMetaMap.set(fire.id, fire);
            }
            rawBuiltVersionRef.current = dataVersionRef.current;
        };

        const rebuildClusterCollection = () => {
            clearClusterCollection();

            const storeState = useTimelineStore.getState();
            const subVis = storeState.subtypeVisibility;
            const isolated = storeState.isolatedEntityId;

            for (const fire of fireRecordsRef.current) {
                if (isolated && isolated !== fire.id) continue;
                if (subVis[`fires:${fire.subtype}`] === false) continue;
                clusterCollection.add({
                    position: Cesium.Cartesian3.fromDegrees(fire.lng, fire.lat, 0),
                    color: colorForSubtype(fire.subtype),
                    outlineColor: Cesium.Color.BLACK.withAlpha(0.45),
                    outlineWidth: 1,
                    pixelSize: pixelSizeForCluster(fire.count || 1, fire.frp),
                    id: fire.id,
                });
                fireMetaMap.set(fire.id, fire);
                clusterIdsRef.current.add(fire.id);
            }
        };

        const refreshPresentation = async () => {
            if (!viewer || viewer.isDestroyed()) return;
            if (responseAggregatedRef.current) {
                renderModeRef.current = 'cluster';
                rebuildClusterCollection();
            } else {
                renderModeRef.current = 'raw';
                clearClusterCollection();
                await ensureRawCollection();
                cullRawForViewport();
            }

            updateCollectionVisibility();
            publishStats();
            requestSceneRender();
        };

        refreshPresentationRef.current = refreshPresentation;

        let cullTimer: ReturnType<typeof setTimeout> | null = null;
        const onCameraMoveEnd = () => {
            if (cullTimer) clearTimeout(cullTimer);
            cullTimer = setTimeout(() => {
                cullTimer = null;
                void fetchNowRef.current?.();
            }, CAMERA_CULL_DEBOUNCE_MS);
        };
        const removeMoveEnd = viewer.camera.moveEnd.addEventListener(onCameraMoveEnd);

        return () => {
            if (cullTimer) clearTimeout(cullTimer);
            removeMoveEnd();
            refreshPresentationRef.current = null;
            updateCollectionVisibilityRef.current = null;
            fetchNowRef.current = null;
            fireMetaMap.clear();
            clusterIdsRef.current.clear();
            delete window.__openspyFireStats;
            if (!viewer.isDestroyed()) {
                viewer.scene.primitives.remove(rawCollection);
                viewer.scene.primitives.remove(clusterCollection);
            }
            rawCollectionRef.current = null;
            clusterCollectionRef.current = null;
        };
    }, [viewer]);

    useEffect(() => {
        if (!viewer || !isSourceOn || mode === 'playback' || !secondaryReleased) return;

        let active = true;
        const abortController = new AbortController();

        async function fetchFires() {
            if (fetchInFlightRef.current || !viewer || viewer.isDestroyed()) return;
            fetchInFlightRef.current = true;
            try {
                const storeState = useTimelineStore.getState();
                const rect = viewer.camera.computeViewRectangle();
                const bbox = rect
                    ? [
                        Cesium.Math.toDegrees(rect.west),
                        Cesium.Math.toDegrees(rect.south),
                        Cesium.Math.toDegrees(rect.east),
                        Cesium.Math.toDegrees(rect.north),
                    ]
                    : null;
                // Clustering toggle is authoritative. When OFF, force raw
                // (null grid) regardless of altitude. When ON, default
                // altitude-based grid still applies.
                const gridDegrees = !storeState.isolatedEntityId && storeState.clusteringEnabled
                    ? getClusterGridDegrees(getViewerAltitudeMeters(viewer))
                    : null;
                const params = new URLSearchParams();
                if (bbox) params.set('bbox', bbox.join(','));
                if (gridDegrees != null) params.set('gridDegrees', String(gridDegrees));
                responseAggregatedRef.current = gridDegrees != null;
                activeGridDegreesRef.current = gridDegrees;

                const res = await axios.get(`${API_URL}/api/fires${params.size ? `?${params.toString()}` : ''}`, {
                    signal: abortController.signal,
                });
                if (!active) return;

                const records = (res.data || []).map((fire: any) => {
                    const frp = fire.frp || 1;
                    return {
                        id: fire.id || `fire-${fire.lat}-${fire.lng}`,
                        lat: fire.lat,
                        lng: fire.lng,
                        frp,
                        subtype: (fire.subtype || frpSubtype(frp)) as 'high' | 'medium' | 'low',
                        aggregated: Boolean(fire.aggregated),
                        count: Number.isFinite(Number(fire.count)) ? Number(fire.count) : undefined,
                    } satisfies FireRecord;
                });

                const counts: Record<string, number> = { high: 0, medium: 0, low: 0 };
                for (const fire of records) counts[fire.subtype] += fire.count || 1;

                fireRecordsRef.current = records;
                fireMetaMap.clear();
                clusterIdsRef.current.clear();
                rawCollectionRef.current?.removeAll();
                clusterCollectionRef.current?.removeAll();
                dataVersionRef.current += 1;
                rawBuiltVersionRef.current = -1;

                useTimelineStore.getState().setSubtypeCounts('fires' as any, counts);
                useTimelineStore.getState().setStreamMetric('fires', {
                    count: records.reduce((sum: number, fire: FireRecord) => sum + (fire.count || 1), 0),
                    status: 'streaming',
                });

                await refreshPresentationRef.current?.();

                const renderedCount = renderModeRef.current === 'cluster'
                    ? (clusterCollectionRef.current?.length ?? 0)
                    : (rawCollectionRef.current?.length ?? 0);
                const logicalCount = records.reduce((sum: number, fire: FireRecord) => sum + (fire.count || 1), 0);
                console.log(`[Fires] Rendered ${renderedCount} ${renderModeRef.current} markers from ${logicalCount} hotspots`);
            } catch (err: any) {
                if (axios.isCancel(err) || err?.code === 'ERR_CANCELED') return;
                console.warn('[Fires] Fetch failed:', err?.message || err);
                useTimelineStore.getState().setStreamMetric('fires', { status: 'error' });
            } finally {
                fetchInFlightRef.current = false;
            }
        }

        fetchNowRef.current = fetchFires;

        void fetchFires();
        const interval = setInterval(fetchFires, 30 * 60_000);

        return () => {
            active = false;
            clearInterval(interval);
            abortController.abort();
        };
    }, [viewer, isSourceOn, mode, secondaryReleased]);

    useEffect(() => {
        updateCollectionVisibilityRef.current?.();
    }, [isSourceOn, isVisible, mode]);

    useEffect(() => {
        void fetchNowRef.current?.();
    }, [subtypeVisibility, isolatedEntityId, clusteringEnabled]);

    useEffect(() => {
        if (isSourceOn) return;
        rawCollectionRef.current?.removeAll();
        clusterCollectionRef.current?.removeAll();
        fireRecordsRef.current = [];
        fireMetaMap.clear();
        clusterIdsRef.current.clear();
        responseAggregatedRef.current = false;
        dataVersionRef.current += 1;
        rawBuiltVersionRef.current = -1;
        delete window.__openspyFireStats;
        useTimelineStore.getState().setSubtypeCounts('fires' as any, {});
        useTimelineStore.getState().setStreamMetric('fires', {
            count: 0,
            status: 'disabled',
        });
        requestSceneRender();
    }, [isSourceOn]);
}
