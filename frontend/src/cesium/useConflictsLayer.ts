import { useEffect, useRef } from 'react';
import * as Cesium from 'cesium';
import axios from 'axios';
import { useTimelineStore } from '../store/useTimelineStore';

// SVG icon builders for conflict markers
const svgUri = (fill: string, stroke: string) => `data:image/svg+xml,` + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24">` +
    `<circle cx="12" cy="12" r="10" fill="${fill}" opacity="0.25"/>` +
    `<circle cx="12" cy="12" r="5" fill="${fill}" stroke="${stroke}" stroke-width="1"/>` +
    `<line x1="12" y1="4" x2="12" y2="8" stroke="${stroke}" stroke-width="1.5"/>` +
    `<line x1="12" y1="16" x2="12" y2="20" stroke="${stroke}" stroke-width="1.5"/>` +
    `<line x1="4" y1="12" x2="8" y2="12" stroke="${stroke}" stroke-width="1.5"/>` +
    `<line x1="16" y1="12" x2="20" y2="12" stroke="${stroke}" stroke-width="1.5"/>` +
    `</svg>`
);

const ICON_EXPLOSIONS = svgUri('#ef4444', '#991b1b');   // red
const ICON_BATTLES    = svgUri('#f97316', '#9a3412');   // orange
const ICON_VIOLENCE   = svgUri('#eab308', '#854d0e');   // yellow

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
    const isVisible = useTimelineStore(s => s.layers.conflicts);
    const subtypeVisibility = useTimelineStore(s => s.subtypeVisibility);
    const dsRef = useRef<Cesium.CustomDataSource | null>(null);

    useEffect(() => {
        if (!viewer) return;
        let active = true;

        const ds = new Cesium.CustomDataSource('conflicts');
        viewer.dataSources.add(ds);
        dsRef.current = ds;

        async function fetchConflicts() {
            try {
                const res = await axios.get('http://localhost:3055/api/conflicts');
                if (!active) return;

                const events = res.data;
                useTimelineStore.getState().setStreamMetric('conflicts', {
                    count: events.length,
                    status: events.length > 0 ? 'streaming' : 'connecting',
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
            } catch (err) {
                // Silent fail — will retry next interval
            }
        }

        fetchConflicts();
        const interval = setInterval(fetchConflicts, 5 * 60 * 1000); // refresh every 5 min

        return () => {
            active = false;
            clearInterval(interval);
            if (viewer && !viewer.isDestroyed()) {
                viewer.dataSources.remove(ds);
            }
        };
    }, [viewer]);

    // Visibility toggle
    useEffect(() => {
        if (dsRef.current) dsRef.current.show = isVisible;
    }, [isVisible]);

    // Per-subtype visibility
    useEffect(() => {
        if (!dsRef.current) return;
        dsRef.current.entities.values.forEach(e => {
            const sub = (e.properties as any)?.subtype?.getValue?.() ?? 'violence';
            e.show = subtypeVisibility[`conflicts:${sub}`] !== false;
        });
    }, [subtypeVisibility]);
}
