import { useEffect, useRef } from 'react';
import * as Cesium from 'cesium';
import axios from 'axios';
import { useTimelineStore } from '../store/useTimelineStore';
import { API_URL } from '../lib/config';

// Enhanced conflict marker icons — each type has a distinct shape.
const ICON_EXPLOSIONS = `data:image/svg+xml,` + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 48 48"><circle cx="24" cy="24" r="20" fill="#ef4444" opacity="0.12"/><polygon points="24,2 27,14 34,6 30,16 42,12 33,20 46,24 33,28 42,36 30,32 34,42 27,34 24,46 21,34 14,42 18,32 6,36 15,28 2,24 15,20 6,12 18,16 14,6 21,14" fill="#ef4444" stroke="#991b1b" stroke-width="0.8"/><polygon points="24,10 27,18 32,13 29,19 38,18 31,22 38,24 31,26 38,30 29,29 32,35 27,30 24,38 21,30 16,35 19,29 10,30 17,26 10,24 17,22 10,18 19,19 16,13 21,18" fill="#f97316" stroke="#ea580c" stroke-width="0.5"/><circle cx="24" cy="24" r="5" fill="#fbbf24" stroke="#f59e0b" stroke-width="0.5"/><circle cx="24" cy="24" r="2.5" fill="#fef3c7" opacity="0.8"/><circle cx="24" cy="24" r="1" fill="#ffffff"/></svg>`
);
// Battles icon: assault rifle silhouette from conflict-battles.svg
const ICON_BATTLES = `data:image/svg+xml,` + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 48 48"><path d="M2 22 L10 22 L10 18 L6 16 L2 18 Z" fill="#f97316" stroke="#000" stroke-width="0.8" stroke-linejoin="round"/><path d="M10 18 L10 24 L34 24 L36 20 L34 18 L10 18 Z" fill="#f97316" stroke="#000" stroke-width="0.8" stroke-linejoin="round"/><rect x="34" y="19" width="12" height="3" rx="0.5" fill="#f97316" stroke="#000" stroke-width="0.8"/><rect x="45" y="18" width="2" height="5" rx="0.3" fill="#f97316" stroke="#000" stroke-width="0.8"/><rect x="42" y="16" width="1.5" height="3" rx="0.3" fill="#f97316" stroke="#000" stroke-width="0.8"/><rect x="14" y="16" width="1.5" height="2" rx="0.3" fill="#f97316" stroke="#000" stroke-width="0.8"/><path d="M22 24 L24 24 L26 36 L20 36 Z" fill="#f97316" stroke="#000" stroke-width="0.8" stroke-linejoin="round"/><path d="M28 24 L30 24 L31 34 L27 34 Z" fill="#f97316" stroke="#000" stroke-width="0.8" stroke-linejoin="round"/><path d="M25 24 Q26 28 29 28 L29 24" fill="none" stroke="#000" stroke-width="0.8"/><rect x="20" y="16.5" width="14" height="1.5" rx="0.5" fill="#f97316" stroke="#000" stroke-width="0.6"/></svg>`);
// Violence icon: skull and crossbones from conflict-violence.svg
const ICON_VIOLENCE = `data:image/svg+xml,` + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 48 48"><path d="M8 10 L40 38" stroke="#eab308" stroke-width="4" stroke-linecap="round" fill="none"/><circle cx="7" cy="8" r="2.5" fill="#eab308" stroke="#000" stroke-width="0.8"/><circle cx="10" cy="11" r="2.5" fill="#eab308" stroke="#000" stroke-width="0.8"/><circle cx="41" cy="40" r="2.5" fill="#eab308" stroke="#000" stroke-width="0.8"/><circle cx="38" cy="37" r="2.5" fill="#eab308" stroke="#000" stroke-width="0.8"/><path d="M40 10 L8 38" stroke="#eab308" stroke-width="4" stroke-linecap="round" fill="none"/><circle cx="41" cy="8" r="2.5" fill="#eab308" stroke="#000" stroke-width="0.8"/><circle cx="38" cy="11" r="2.5" fill="#eab308" stroke="#000" stroke-width="0.8"/><circle cx="7" cy="40" r="2.5" fill="#eab308" stroke="#000" stroke-width="0.8"/><circle cx="10" cy="37" r="2.5" fill="#eab308" stroke="#000" stroke-width="0.8"/><ellipse cx="24" cy="18" rx="12" ry="11" fill="#eab308" stroke="#000" stroke-width="1"/><path d="M14 22 L14 28 Q16 32 20 30 L22 32 L24 30 L26 32 L28 30 Q32 32 34 28 L34 22" fill="#eab308" stroke="#000" stroke-width="1"/><ellipse cx="19" cy="17" rx="3.5" ry="4" fill="#000"/><ellipse cx="29" cy="17" rx="3.5" ry="4" fill="#000"/><path d="M22 23 L24 21 L26 23" fill="#000" stroke="#000" stroke-width="0.5"/><line x1="18" y1="28" x2="30" y2="28" stroke="#000" stroke-width="0.6"/><line x1="21" y1="26" x2="21" y2="30" stroke="#000" stroke-width="0.5"/><line x1="24" y1="26" x2="24" y2="32" stroke="#000" stroke-width="0.5"/><line x1="27" y1="26" x2="27" y2="30" stroke="#000" stroke-width="0.5"/></svg>`);

function getConflictIcon(eventType: string): string {
    if (eventType.includes('Explosions') || eventType.includes('Remote violence')) return ICON_EXPLOSIONS;
    if (eventType === 'Battles') return ICON_BATTLES;
    return ICON_VIOLENCE; // Violence against civilians
}

function getConflictColor(eventType: string): Cesium.Color {
    if (eventType.includes('Explosions') || eventType.includes('Remote violence')) return Cesium.Color.RED;
    if (eventType === 'Battles') return Cesium.Color.ORANGE;
    return Cesium.Color.YELLOW;
}

function getSubtypeKey(eventType: string): string {
    if (eventType.includes('Explosions') || eventType.includes('Remote violence')) return 'explosions';
    if (eventType === 'Battles') return 'battles';
    return 'violence';
}

export function useConflictsLayer(viewer: Cesium.Viewer | null) {
    const isSourceOn = useTimelineStore(s => s.sources.conflicts);
    const isVisible = useTimelineStore(s => s.visibility.conflicts);
    const subtypeVisibility = useTimelineStore(s => s.subtypeVisibility);
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
        if (!viewer || !isSourceOn) return;
        let active = true;

        async function fetchConflicts() {
            const ds = dsRef.current;
            if (!ds) return;
            try {
                const res = await axios.get(`${API_URL}/api/conflicts`);
                if (!active) return;

                const events = res.data;
                // Successful fetch (even empty) == streaming. Don't fall back
                // to 'connecting' — that overwrites 'auth-missing' propagated
                // from /api/status when the ACLED key isn't configured.
                useTimelineStore.getState().setStreamMetric('conflicts', {
                    count: events.length,
                    status: 'streaming',
                });

                ds.entities.removeAll();

                for (const ev of events) {
                    const color = getConflictColor(ev.event_type);
                    const subtypeKey = getSubtypeKey(ev.event_type);

                    ds.entities.add({
                        id: `conflict-${ev.id}`,
                        name: `${ev.event_type}: ${ev.country}`,
                        position: Cesium.Cartesian3.fromDegrees(ev.lng, ev.lat, 50),
                        properties: new Cesium.PropertyBag({
                            layer: 'Conflict',
                            subtype: subtypeKey,
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
    }, [viewer, isSourceOn]);

    // ---- Effect 3: visibility toggle ----
    // Effective show = sources && visibility.
    useEffect(() => {
        if (dsRef.current) dsRef.current.show = isSourceOn && isVisible;
    }, [isSourceOn, isVisible]);

    // ---- Effect 4: per-subtype visibility ----
    useEffect(() => {
        if (!dsRef.current) return;
        dsRef.current.entities.values.forEach(e => {
            const sub = (e.properties as any)?.subtype?.getValue?.() ?? 'violence';
            e.show = subtypeVisibility[`conflicts:${sub}`] !== false;
        });
    }, [subtypeVisibility]);

    // ---- Effect 5: source-off scene clear ----
    useEffect(() => {
        if (isSourceOn) return;
        if (dsRef.current) dsRef.current.entities.removeAll();
        useTimelineStore.getState().setSubtypeCounts('conflicts' as any, {});
        useTimelineStore.getState().setStreamMetric('conflicts', {
            count: 0,
            status: 'disabled',
        });
    }, [isSourceOn]);
}
