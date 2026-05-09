import { useEffect, useRef } from 'react';
import * as Cesium from 'cesium';
import axios from 'axios';
import { useTimelineStore } from '../store/useTimelineStore';
import { useSecondaryLoadGate } from './useSecondaryLoadGate';
import { API_URL } from '../lib/config';
import { getConflictIcon } from '../icons/map-icons';
import { getViewerAltitudeMeters, safeCartesianFromDegrees } from './position-utils';
import { getLayerSourceVisibilityKey, normalizeLayerSourceId } from '../lib/source-visibility';

export interface ConflictMeta {
    id: string;
    lat: number;
    lng: number;
    subtype: string;
    source: string;
    eventType: string;
    subEventType?: string;
    fatalities?: number;
    aggregated?: boolean;
    count?: number;
}

export const conflictMetaMap = new Map<string, ConflictMeta>();

type ConflictRecord = ConflictMeta;

declare global {
    interface Window {
        __openspyConflictStats?: {
            renderMode: 'raw' | 'cluster';
            rawEvents: number;
            renderedMarkers: number;
            gridDegrees: number | null;
        };
    }
}

function getSubtypeKey(eventType: string): string {
    if (eventType.includes('Explosions') || eventType.includes('Remote violence')) return 'explosions';
    if (eventType === 'Battles' || eventType === 'Fight') return 'battles';
    if (eventType === 'Assault') return 'assaults';
    if (eventType === 'Mass Violence') return 'mass_violence';
    if (eventType === 'Protest') return 'protests';
    if (eventType === 'Threaten') return 'threats';
    if (eventType === 'Force posture') return 'force_posture';
    if (eventType === 'Coerce') return 'coercion';
    return 'violence';
}

function colorForSubtype(subtype: string): Cesium.Color {
    if (subtype === 'explosions') return Cesium.Color.fromCssColorString('#ef4444').withAlpha(0.95);
    if (subtype === 'battles') return Cesium.Color.fromCssColorString('#f97316').withAlpha(0.92);
    if (subtype === 'protests') return Cesium.Color.fromCssColorString('#facc15').withAlpha(0.88);
    if (subtype === 'threats' || subtype === 'force_posture') return Cesium.Color.fromCssColorString('#a855f7').withAlpha(0.9);
    return Cesium.Color.fromCssColorString('#fb7185').withAlpha(0.9);
}

function pixelSizeForCluster(count: number, fatalities: number): number {
    return Math.max(7, Math.min(22, 6 + Math.log2(Math.max(1, count)) * 2.2 + Math.log2(Math.max(1, fatalities + 1)) * 0.6));
}

function getConflictClusterGridDegrees(altitudeMeters: number | null): number | null {
    if (altitudeMeters == null) return 3.0;
    if (altitudeMeters >= 12_000_000) return 6.0;
    if (altitudeMeters >= 6_000_000) return 3.0;
    if (altitudeMeters >= 2_500_000) return 1.5;
    return null;
}

function clusterCoordinate(value: number, min: number, max: number, gridDegrees: number): number {
    const cell = Math.floor((value - min) / gridDegrees);
    return Math.max(min, Math.min(max, min + cell * gridDegrees + gridDegrees / 2));
}

function clusterRecords(records: ConflictRecord[], gridDegrees: number): ConflictRecord[] {
    const clusters = new Map<string, {
        id: string;
        latSum: number;
        lngSum: number;
        count: number;
        fatalities: number;
        subtype: string;
        source: string;
        eventType: string;
        subEventType?: string;
    }>();

    for (const record of records) {
        const latCell = clusterCoordinate(record.lat, -90, 90, gridDegrees);
        const lngCell = clusterCoordinate(record.lng, -180, 180, gridDegrees);
        const key = `${lngCell.toFixed(3)}:${latCell.toFixed(3)}:${record.subtype}:${record.source}`;
        const existing = clusters.get(key);
        if (existing) {
            existing.latSum += record.lat;
            existing.lngSum += record.lng;
            existing.count += 1;
            existing.fatalities += record.fatalities || 0;
            continue;
        }
        clusters.set(key, {
            id: `conflict-cluster-${key.replace(/[^a-z0-9:-]/gi, '_')}`,
            latSum: record.lat,
            lngSum: record.lng,
            count: 1,
            fatalities: record.fatalities || 0,
            subtype: record.subtype,
            source: record.source,
            eventType: record.eventType,
            subEventType: record.subEventType,
        });
    }

    return Array.from(clusters.values()).map((cluster) => ({
        id: cluster.id,
        lat: cluster.latSum / cluster.count,
        lng: cluster.lngSum / cluster.count,
        subtype: cluster.subtype,
        source: cluster.source,
        eventType: `${cluster.count} conflict events`,
        subEventType: cluster.subEventType,
        fatalities: cluster.fatalities,
        aggregated: true,
        count: cluster.count,
    }));
}

export function useConflictsLayer(viewer: Cesium.Viewer | null) {
    const isSourceOn = useTimelineStore(s => s.sources.conflicts);
    const isVisible = useTimelineStore(s => s.visibility.conflicts);
    const mode = useTimelineStore(s => s.mode);
    const subtypeVisibility = useTimelineStore(s => s.subtypeVisibility);
    const sourceVisibility = useTimelineStore(s => s.sourceVisibility);
    const isolatedEntityId = useTimelineStore(s => s.isolatedEntityId);
    const clusteringEnabled = useTimelineStore(s => s.clusteringEnabled);
    const secondaryReleased = useSecondaryLoadGate();
    const rawCollectionRef = useRef<Cesium.BillboardCollection | null>(null);
    const clusterCollectionRef = useRef<Cesium.PointPrimitiveCollection | null>(null);
    const recordsRef = useRef<ConflictRecord[]>([]);
    const recordByIdRef = useRef<Map<string, ConflictRecord>>(new Map());
    const dataVersionRef = useRef(0);
    const rawBuiltVersionRef = useRef(-1);
    const renderModeRef = useRef<'raw' | 'cluster'>('raw');
    const activeGridDegreesRef = useRef<number | null>(null);
    const refreshPresentationRef = useRef<(() => void) | null>(null);

    // ---- Effect 1: scene lifetime ----
    // BillboardCollection lives for the viewer's lifetime. Source toggles
    // only gate the fetch loop below.
    useEffect(() => {
        if (!viewer) return;
        const rawBillboards = new Cesium.BillboardCollection({
            scene: viewer.scene,
            blendOption: Cesium.BlendOption.TRANSLUCENT,
        });
        const clusterPoints = new Cesium.PointPrimitiveCollection({
            blendOption: Cesium.BlendOption.TRANSLUCENT,
        });
        viewer.scene.primitives.add(rawBillboards);
        viewer.scene.primitives.add(clusterPoints);
        rawCollectionRef.current = rawBillboards;
        clusterCollectionRef.current = clusterPoints;

        const recordMatchesState = (record: ConflictRecord): boolean => {
            const state = useTimelineStore.getState();
            const source = normalizeLayerSourceId('conflicts', record.source);
            const subtypeOk = state.subtypeVisibility[`conflicts:${record.subtype}`] !== false;
            const sourceOk = !source || state.sourceVisibility[getLayerSourceVisibilityKey('conflicts', source)] !== false;
            return subtypeOk && sourceOk && (!state.isolatedEntityId || state.isolatedEntityId === record.id);
        };

        const recordInViewport = (record: ConflictRecord): boolean => {
            const rect = viewer.camera.computeViewRectangle();
            if (!rect) return true;
            const south = Cesium.Math.toDegrees(rect.south);
            const north = Cesium.Math.toDegrees(rect.north);
            const west = Cesium.Math.toDegrees(rect.west);
            const east = Cesium.Math.toDegrees(rect.east);
            const crossAM = east < west;
            const inLat = record.lat >= south && record.lat <= north;
            const inLng = crossAM
                ? record.lng >= west || record.lng <= east
                : record.lng >= west && record.lng <= east;
            return inLat && inLng;
        };

        const updateCollectionVisibility = () => {
            const state = useTimelineStore.getState();
            const showLayer = state.mode !== 'playback' && state.sources.conflicts && state.visibility.conflicts;
            rawBillboards.show = showLayer && renderModeRef.current === 'raw';
            clusterPoints.show = showLayer && renderModeRef.current === 'cluster';
        };

        const ensureRawCollection = () => {
            if (rawBuiltVersionRef.current === dataVersionRef.current) return;
            rawBillboards.removeAll();
            for (const record of recordsRef.current) {
                const position = safeCartesianFromDegrees(record.lng, record.lat, 50);
                if (!position) continue;
                rawBillboards.add({
                    id: record.id,
                    position,
                    image: getConflictIcon(record.eventType),
                    scale: (record.fatalities || 0) > 10 ? 1.4 : (record.fatalities || 0) > 0 ? 1.1 : 0.9,
                    verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                });
            }
            rawBuiltVersionRef.current = dataVersionRef.current;
        };

        const applyRawVisibility = () => {
            conflictMetaMap.clear();
            for (let i = 0; i < rawBillboards.length; i++) {
                const billboard = rawBillboards.get(i);
                const record = recordByIdRef.current.get(String(billboard.id));
                if (!record) {
                    billboard.show = false;
                    continue;
                }
                conflictMetaMap.set(record.id, record);
                billboard.show = recordMatchesState(record) && recordInViewport(record);
            }
        };

        const rebuildClusterCollection = (gridDegrees: number) => {
            conflictMetaMap.clear();
            clusterPoints.removeAll();
            const filtered = recordsRef.current.filter(recordMatchesState);
            const clusters = clusterRecords(filtered, gridDegrees);
            for (const cluster of clusters) {
                const position = safeCartesianFromDegrees(cluster.lng, cluster.lat, 0);
                if (!position) continue;
                clusterPoints.add({
                    id: cluster.id,
                    position,
                    color: colorForSubtype(cluster.subtype),
                    outlineColor: Cesium.Color.BLACK.withAlpha(0.45),
                    outlineWidth: 1,
                    pixelSize: pixelSizeForCluster(cluster.count || 1, cluster.fatalities || 0),
                });
                conflictMetaMap.set(cluster.id, cluster);
            }
        };

        const publishStats = () => {
            window.__openspyConflictStats = {
                renderMode: renderModeRef.current,
                rawEvents: recordsRef.current.length,
                renderedMarkers: renderModeRef.current === 'cluster' ? clusterPoints.length : rawBillboards.length,
                gridDegrees: activeGridDegreesRef.current,
            };
        };

        const refreshPresentation = () => {
            if (!viewer || viewer.isDestroyed()) return;
            const state = useTimelineStore.getState();
            const gridDegrees = state.clusteringEnabled && !state.isolatedEntityId
                ? getConflictClusterGridDegrees(getViewerAltitudeMeters(viewer))
                : null;
            renderModeRef.current = gridDegrees != null ? 'cluster' : 'raw';
            activeGridDegreesRef.current = gridDegrees;

            if (gridDegrees != null) {
                rebuildClusterCollection(gridDegrees);
            } else {
                clusterPoints.removeAll();
                ensureRawCollection();
                applyRawVisibility();
            }
            updateCollectionVisibility();
            publishStats();
            viewer.scene.requestRender();
        };
        refreshPresentationRef.current = refreshPresentation;

        let refreshTimer: ReturnType<typeof setTimeout> | null = null;
        const onCameraMoveEnd = () => {
            if (refreshTimer) clearTimeout(refreshTimer);
            refreshTimer = setTimeout(() => {
                refreshTimer = null;
                refreshPresentationRef.current?.();
            }, 120);
        };
        const removeMoveEnd = viewer.camera.moveEnd.addEventListener(onCameraMoveEnd);

        return () => {
            if (refreshTimer) clearTimeout(refreshTimer);
            removeMoveEnd();
            conflictMetaMap.clear();
            delete window.__openspyConflictStats;
            refreshPresentationRef.current = null;
            if (viewer && !viewer.isDestroyed()) {
                viewer.scene.primitives.remove(rawBillboards);
                viewer.scene.primitives.remove(clusterPoints);
            }
            rawCollectionRef.current = null;
            clusterCollectionRef.current = null;
        };
    }, [viewer]);

    // ---- Effect 2: fetch loop ----
    useEffect(() => {
        if (!viewer || !isSourceOn || !secondaryReleased) return;
        let active = true;

        async function fetchConflicts() {
            try {
                // Fetch ACLED + GDELT in parallel, merge results
                const [acledRes, gdeltRes] = await Promise.allSettled([
                    axios.get(`${API_URL}/api/conflicts`),
                    axios.get(`${API_URL}/api/gdelt-conflicts`),
                ]);
                if (!active) return;

                const acledEvents = acledRes.status === 'fulfilled' ? acledRes.value.data : [];
                const gdeltEvents = gdeltRes.status === 'fulfilled' ? gdeltRes.value.data : [];

                // Normalize GDELT events to match ACLED shape for rendering
                const normalizedGdelt = gdeltEvents.map((ev: any) => ({
                    ...ev,
                    event_type: ev.eventType || ev.event_type || 'Unknown',
                    sub_event_type: ev.subEventType || ev.sub_event_type || '',
                    fatalities: ev.fatalities || 0,
                    source: 'GDELT',
                }));

                const events = [
                    ...acledEvents.map((ev: any) => ({ ...ev, source: 'ACLED' })),
                    ...normalizedGdelt,
                ];

                const records: ConflictRecord[] = [];
                const subtypeCounts: Record<string, number> = {};
                const sourceCounts: Record<string, number> = {};

                for (const ev of events) {
                    if (ev.lat == null || ev.lng == null || isNaN(ev.lat) || isNaN(ev.lng)) continue;
                    const subtypeKey = getSubtypeKey(ev.event_type);
                    const id = String(ev.id);
                    const source = ev.source || 'Unknown';
                    const record: ConflictRecord = {
                        id,
                        lat: Number(ev.lat),
                        lng: Number(ev.lng),
                        subtype: subtypeKey,
                        source,
                        eventType: ev.event_type || 'Conflict event',
                        subEventType: ev.sub_event_type,
                        fatalities: Number.isFinite(Number(ev.fatalities)) ? Number(ev.fatalities) : 0,
                    };
                    records.push(record);
                    subtypeCounts[subtypeKey] = (subtypeCounts[subtypeKey] || 0) + 1;
                    const normalizedSource = normalizeLayerSourceId('conflicts', source);
                    if (normalizedSource) sourceCounts[normalizedSource] = (sourceCounts[normalizedSource] || 0) + 1;
                }

                recordsRef.current = records;
                recordByIdRef.current = new Map(records.map((record) => [record.id, record]));
                dataVersionRef.current += 1;
                rawBuiltVersionRef.current = -1;
                rawCollectionRef.current?.removeAll();
                clusterCollectionRef.current?.removeAll();

                useTimelineStore.getState().setStreamMetric('conflicts', {
                    count: records.length,
                    status: records.length > 0 ? 'streaming' : 'connecting',
                });
                useTimelineStore.getState().setSubtypeCounts('conflicts' as any, subtypeCounts);
                useTimelineStore.getState().setSourceCounts('conflicts', sourceCounts);
                refreshPresentationRef.current?.();
            } catch (err: any) {
                console.warn('[Conflicts] fetch failed:', err?.message || err);
                useTimelineStore.getState().setStreamMetric('conflicts', { status: 'error' });
            }
        }

        fetchConflicts();
        const interval = setInterval(fetchConflicts, 5 * 60 * 1000); // refresh every 5 min

        return () => {
            active = false;
            clearInterval(interval);
            // Keep the collection — Effect 1 owns its lifetime.
        };
    }, [viewer, isSourceOn, secondaryReleased]);

    // ---- Effect 3: visibility toggle ----
    // Effective show = sources && visibility.
    useEffect(() => {
        const showLayer = mode !== 'playback' && isSourceOn && isVisible;
        if (rawCollectionRef.current) rawCollectionRef.current.show = showLayer && renderModeRef.current === 'raw';
        if (clusterCollectionRef.current) clusterCollectionRef.current.show = showLayer && renderModeRef.current === 'cluster';
    }, [isSourceOn, isVisible, mode]);

    // ---- Effect 4: per-subtype visibility ----
    useEffect(() => {
        refreshPresentationRef.current?.();
    }, [subtypeVisibility, sourceVisibility, isolatedEntityId, clusteringEnabled]);

    // ---- Effect 5: source-off scene clear ----
    useEffect(() => {
        if (isSourceOn) return;
        rawCollectionRef.current?.removeAll();
        clusterCollectionRef.current?.removeAll();
        recordsRef.current = [];
        recordByIdRef.current.clear();
        dataVersionRef.current += 1;
        rawBuiltVersionRef.current = -1;
        conflictMetaMap.clear();
        delete window.__openspyConflictStats;
        useTimelineStore.getState().setSubtypeCounts('conflicts' as any, {});
        useTimelineStore.getState().setSourceCounts('conflicts', {});
        useTimelineStore.getState().setStreamMetric('conflicts', {
            count: 0,
            status: 'disabled',
        });
    }, [isSourceOn]);
}
