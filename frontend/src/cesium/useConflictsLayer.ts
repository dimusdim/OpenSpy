import { useEffect, useRef } from 'react';
import * as Cesium from 'cesium';
import axios from 'axios';
import { useTimelineStore } from '../store/useTimelineStore';
import { useSecondaryLoadGate } from './useSecondaryLoadGate';
import { API_URL } from '../lib/config';
import { getConflictIcon } from '../icons/map-icons';
import { safeCartesianFromDegrees } from './position-utils';
import { getLayerSourceVisibilityKey, normalizeLayerSourceId } from '../lib/source-visibility';

function getConflictColor(eventType: string): Cesium.Color {
    if (eventType.includes('Explosions') || eventType.includes('Remote violence')) return Cesium.Color.RED;
    if (eventType === 'Battles' || eventType === 'Fight') return Cesium.Color.ORANGE;
    if (eventType === 'Assault' || eventType === 'Mass Violence') return Cesium.Color.RED;
    if (eventType === 'Protest') return Cesium.Color.YELLOW;
    if (eventType === 'Threaten') return Cesium.Color.fromCssColorString('#f59e0b'); // amber
    if (eventType === 'Force posture') return Cesium.Color.fromCssColorString('#a855f7'); // purple
    if (eventType === 'Coerce') return Cesium.Color.fromCssColorString('#f97316'); // deep orange
    return Cesium.Color.YELLOW;
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

export function useConflictsLayer(viewer: Cesium.Viewer | null) {
    const isSourceOn = useTimelineStore(s => s.sources.conflicts);
    const isVisible = useTimelineStore(s => s.visibility.conflicts);
    const mode = useTimelineStore(s => s.mode);
    const subtypeVisibility = useTimelineStore(s => s.subtypeVisibility);
    const secondaryReleased = useSecondaryLoadGate();
    const dsRef = useRef<Cesium.CustomDataSource | null>(null);

    // ---- Effect 1: scene lifetime ----
    // CustomDataSource lives for the viewer's lifetime. Source toggles
    // only gate the fetch loop below; existing entities stay on screen.
    useEffect(() => {
        if (!viewer) return;
        const ds = new Cesium.CustomDataSource('conflicts');
        viewer.dataSources.add(ds);
        dsRef.current = ds;
        return () => {
            if (viewer && !viewer.isDestroyed()) {
                viewer.dataSources.remove(ds);
            }
            dsRef.current = null;
        };
    }, [viewer]);

    // ---- Effect 2: fetch loop ----
    useEffect(() => {
        if (!viewer || !isSourceOn || !secondaryReleased) return;
        let active = true;

        async function fetchConflicts() {
            const ds = dsRef.current;
            if (!ds) return;
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
                    country: ev.country || ev.location || '',
                    actor1: ev.actor1 || '',
                    actor2: ev.actor2 || '',
                    event_date: ev.date || ev.event_date || '',
                    notes: ev.sourceUrl ? `Source: ${ev.sourceUrl}` : '',
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

                ds.entities.removeAll();

                for (const ev of events) {
                    if (ev.lat == null || ev.lng == null || isNaN(ev.lat) || isNaN(ev.lng)) continue;
                    const position = safeCartesianFromDegrees(ev.lng, ev.lat, 50);
                    if (!position) continue;
                    const color = getConflictColor(ev.event_type);
                    const subtypeKey = getSubtypeKey(ev.event_type);

                    ds.entities.add({
                        id: `conflict-${ev.id}`,
                        name: `${ev.event_type}: ${ev.country}`,
                        position,
                        properties: new Cesium.PropertyBag({
                            layer: 'Conflict',
                            subtype: subtypeKey,
                            source: ev.source,
                            event_type: ev.event_type,
                            sub_event_type: ev.sub_event_type,
                            fatalities: ev.fatalities,
                            country: ev.country,
                            actor1: ev.actor1,
                            actor2: ev.actor2,
                            event_date: ev.event_date,
                            notes: ev.notes,
                        }),
                        billboard: {
                            image: getConflictIcon(ev.event_type),
                            scale: ev.fatalities > 10 ? 1.4 : ev.fatalities > 0 ? 1.1 : 0.9,
                        },
                        ellipse: {
                            semiMinorAxis: ev.fatalities > 10 ? 30_000 : 15_000,
                            semiMajorAxis: ev.fatalities > 10 ? 30_000 : 15_000,
                            material: new Cesium.ColorMaterialProperty(color.withAlpha(0.08)),
                            height: 0,
                            outline: true,
                            outlineColor: color.withAlpha(0.3),
                            outlineWidth: 1,
                        },
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
            // Do NOT remove the datasource — Effect 1 owns its lifetime so
            // already-loaded conflict events stay visible on source-off.
        };
    }, [viewer, isSourceOn, secondaryReleased]);

    // ---- Effect 3: visibility toggle ----
    // Effective show = sources && visibility.
    useEffect(() => {
        if (dsRef.current) dsRef.current.show = mode !== 'playback' && isSourceOn && isVisible;
    }, [isSourceOn, isVisible, mode]);

    // ---- Effect 4: per-subtype visibility ----
    const sourceVisibility = useTimelineStore(s => s.sourceVisibility);
    const isolatedEntityId = useTimelineStore(s => s.isolatedEntityId);
    useEffect(() => {
        if (!dsRef.current) return;
        const sourceCounts: Record<string, number> = {};
        dsRef.current.entities.values.forEach(e => {
            const sub = (e.properties as any)?.subtype?.getValue?.() ?? 'violence';
            const source = normalizeLayerSourceId('conflicts', (e.properties as any)?.source?.getValue?.());
            const subtypeOk = subtypeVisibility[`conflicts:${sub}`] !== false;
            if (source) sourceCounts[source] = (sourceCounts[source] || 0) + 1;
            const sourceOk = !source || sourceVisibility[getLayerSourceVisibilityKey('conflicts', source)] !== false;
            e.show = subtypeOk && sourceOk && (!isolatedEntityId || isolatedEntityId === e.id);
        });
        useTimelineStore.getState().setSourceCounts('conflicts', sourceCounts);
    }, [subtypeVisibility, sourceVisibility, isolatedEntityId]);

    // ---- Effect 5: source-off scene clear ----
    useEffect(() => {
        if (isSourceOn) return;
        if (dsRef.current) dsRef.current.entities.removeAll();
        useTimelineStore.getState().setSubtypeCounts('conflicts' as any, {});
        useTimelineStore.getState().setSourceCounts('conflicts', {});
        useTimelineStore.getState().setStreamMetric('conflicts', {
            count: 0,
            status: 'disabled',
        });
    }, [isSourceOn]);
}
