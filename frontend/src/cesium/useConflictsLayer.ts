import { useEffect, useRef } from 'react';
import * as Cesium from 'cesium';
import axios from 'axios';
import { useTimelineStore } from '../store/useTimelineStore';
import { useSecondaryLoadGate } from './useSecondaryLoadGate';
import { API_URL } from '../lib/config';
import { getConflictIcon } from '../icons/map-icons';
import { safeCartesianFromDegrees } from './position-utils';
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
}

export const conflictMetaMap = new Map<string, ConflictMeta>();

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

export function useConflictsLayer(viewer: Cesium.Viewer | null) {
    const isSourceOn = useTimelineStore(s => s.sources.conflicts);
    const isVisible = useTimelineStore(s => s.visibility.conflicts);
    const mode = useTimelineStore(s => s.mode);
    const subtypeVisibility = useTimelineStore(s => s.subtypeVisibility);
    const secondaryReleased = useSecondaryLoadGate();
    const collectionRef = useRef<Cesium.BillboardCollection | null>(null);

    // ---- Effect 1: scene lifetime ----
    // BillboardCollection lives for the viewer's lifetime. Source toggles
    // only gate the fetch loop below.
    useEffect(() => {
        if (!viewer) return;
        const billboards = new Cesium.BillboardCollection({
            scene: viewer.scene,
            blendOption: Cesium.BlendOption.TRANSLUCENT,
        });
        viewer.scene.primitives.add(billboards);
        collectionRef.current = billboards;
        return () => {
            if (collectionRef.current === billboards) {
                conflictMetaMap.clear();
                collectionRef.current = null;
            }
            if (viewer && !viewer.isDestroyed()) {
                viewer.scene.primitives.remove(billboards);
            }
        };
    }, [viewer]);

    // ---- Effect 2: fetch loop ----
    useEffect(() => {
        if (!viewer || !isSourceOn || !secondaryReleased) return;
        let active = true;

        async function fetchConflicts() {
            const billboards = collectionRef.current;
            if (!billboards) return;
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

                useTimelineStore.getState().setStreamMetric('conflicts', {
                    count: events.length,
                    status: events.length > 0 ? 'streaming' : 'connecting',
                });

                billboards.removeAll();
                conflictMetaMap.clear();

                for (const ev of events) {
                    if (ev.lat == null || ev.lng == null || isNaN(ev.lat) || isNaN(ev.lng)) continue;
                    const position = safeCartesianFromDegrees(ev.lng, ev.lat, 50);
                    if (!position) continue;
                    const subtypeKey = getSubtypeKey(ev.event_type);
                    const id = String(ev.id);

                    billboards.add({
                        id,
                        position,
                        image: getConflictIcon(ev.event_type),
                        scale: ev.fatalities > 10 ? 1.4 : ev.fatalities > 0 ? 1.1 : 0.9,
                        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                    });
                    conflictMetaMap.set(id, {
                        id,
                        lat: ev.lat,
                        lng: ev.lng,
                        subtype: subtypeKey,
                        source: ev.source,
                        eventType: ev.event_type || 'Conflict event',
                        subEventType: ev.sub_event_type,
                        fatalities: ev.fatalities,
                    });
                }

                // Update subtype counts
                const counts: Record<string, number> = {};
                for (const ev of events) {
                    const key = getSubtypeKey(ev.event_type);
                    counts[key] = (counts[key] || 0) + 1;
                }
                useTimelineStore.getState().setSubtypeCounts('conflicts' as any, counts);
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
        if (collectionRef.current) collectionRef.current.show = mode !== 'playback' && isSourceOn && isVisible;
    }, [isSourceOn, isVisible, mode]);

    // ---- Effect 4: per-subtype visibility ----
    const sourceVisibility = useTimelineStore(s => s.sourceVisibility);
    const isolatedEntityId = useTimelineStore(s => s.isolatedEntityId);
    useEffect(() => {
        const collection = collectionRef.current;
        if (!collection) return;
        const sourceCounts: Record<string, number> = {};
        for (let i = 0; i < collection.length; i++) {
            const bb = collection.get(i);
            const meta = conflictMetaMap.get(bb.id as string);
            const sub = meta?.subtype ?? 'violence';
            const source = normalizeLayerSourceId('conflicts', meta?.source);
            const subtypeOk = subtypeVisibility[`conflicts:${sub}`] !== false;
            if (source) sourceCounts[source] = (sourceCounts[source] || 0) + 1;
            const sourceOk = !source || sourceVisibility[getLayerSourceVisibilityKey('conflicts', source)] !== false;
            bb.show = subtypeOk && sourceOk && (!isolatedEntityId || isolatedEntityId === bb.id);
        }
        useTimelineStore.getState().setSourceCounts('conflicts', sourceCounts);
    }, [subtypeVisibility, sourceVisibility, isolatedEntityId]);

    // ---- Effect 5: source-off scene clear ----
    useEffect(() => {
        if (isSourceOn) return;
        collectionRef.current?.removeAll();
        conflictMetaMap.clear();
        useTimelineStore.getState().setSubtypeCounts('conflicts' as any, {});
        useTimelineStore.getState().setSourceCounts('conflicts', {});
        useTimelineStore.getState().setStreamMetric('conflicts', {
            count: 0,
            status: 'disabled',
        });
    }, [isSourceOn]);
}
