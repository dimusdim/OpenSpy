import { useEffect, useRef } from 'react';
import * as Cesium from 'cesium';
import axios from 'axios';
import { useTimelineStore } from '../store/useTimelineStore';

// Distinct icons per GDACS event class. The colour also encodes the alert
// level (red/orange/green) so a Red TC reads differently from a Green one.
const svgUri = (body: string, fill: string) => `data:image/svg+xml,` + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24" fill="${fill}" stroke="black" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
);

const ALERT_FILL: Record<string, string> = {
    Red: '#ef4444',
    Orange: '#f97316',
    Green: '#22c55e',
};

const EVENT_BODY: Record<string, string> = {
    EQ: `<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="6" fill="none" stroke-width="1.5"/><circle cx="12" cy="12" r="9" fill="none" stroke-width="1"/>`, // earthquake — concentric ripples
    TC: `<path d="M12 4 a8 8 0 1 1 -8 8 a5 5 0 0 1 5 -5 a3 3 0 0 1 3 3 a1.5 1.5 0 0 1 -3 0" fill-opacity="0.85"/>`, // tropical cyclone — spiral
    FL: `<path d="M2 12 q3 -4 6 0 t6 0 t6 0 v6 h-18 z"/><path d="M2 8 q3 -4 6 0 t6 0 t6 0" fill="none" stroke-width="1.5"/>`, // flood — waves
    VO: `<polygon points="12,3 4,21 20,21"/><circle cx="12" cy="6" r="1.5" fill="black"/><path d="M11 4 q1 -2 2 0 q-1 2 0 4" fill="none" stroke="black"/>`, // volcano — triangle + smoke
    WF: `<path d="M12 3 q3 4 3 8 a3 3 0 1 1 -6 0 q0 -4 3 -8 z"/><path d="M12 9 q1.5 2 1.5 4 a1.5 1.5 0 1 1 -3 0 q0 -2 1.5 -4 z" fill="black"/>`, // wildfire — flame
    DR: `<rect x="3" y="14" width="18" height="6"/><path d="M6 14 v-3 m4 3 v-5 m4 5 v-4 m4 4 v-6"/>`, // drought — cracked land
    XX: `<rect x="6" y="6" width="12" height="12" rx="2"/>`, // unknown
};
const getOsintSvg = (eventType: string, alert: string) => {
    const body = EVENT_BODY[eventType] || EVENT_BODY.XX;
    const fill = ALERT_FILL[alert] || ALERT_FILL.Green;
    return svgUri(body, fill);
};

export function useOsintLayer(viewer: Cesium.Viewer | null) {
    const isOsintVisible = useTimelineStore(s => s.layers.osint);
    const isJammingVisible = useTimelineStore(s => s.layers.jamming);
    
    const osintDsRef = useRef<Cesium.CustomDataSource | null>(null);

    useEffect(() => {
        if (!viewer) return;

        const ds = new Cesium.CustomDataSource('osint');
        viewer.dataSources.add(ds);
        osintDsRef.current = ds;

        let active = true;

        async function fetchEvents() {
            try {
                const res = await axios.get('http://localhost:3055/api/osint');
                if (!active) return;
                
                const events = res.data;
                useTimelineStore.getState().setStreamMetric('osint', { count: events.length, status: 'streaming' });

                events.forEach((ev: any) => {
                    try {
                        if (ev.type === 'strike') {
                            const alertColor = ev.alertLevel === 'Red' ? Cesium.Color.RED
                                : ev.alertLevel === 'Orange' ? Cesium.Color.ORANGE
                                : Cesium.Color.LIME;

                            const opts: any = {
                                id: ev.id,
                                name: ev.description || ev.eventType,
                                position: Cesium.Cartesian3.fromDegrees(ev.lng, ev.lat, 50),
                                properties: new Cesium.PropertyBag({
                                    layer: 'OSINT',
                                    subtype: ev.eventType || 'XX',
                                    alertLevel: ev.alertLevel || 'Green',
                                    source: ev.source || 'GDACS',
                                    description: ev.description || '',
                                }),
                                billboard: {
                                    image: getOsintSvg(ev.eventType || 'XX', ev.alertLevel || 'Green'),
                                    scale: 1.2,
                                },
                            };

                            // Impact zone ellipse when we know the radius
                            if (ev.radiusKm && ev.radiusKm > 0) {
                                opts.ellipse = {
                                    semiMinorAxis: ev.radiusKm * 1000,
                                    semiMajorAxis: ev.radiusKm * 1000,
                                    material: new Cesium.ColorMaterialProperty(alertColor.withAlpha(0.12)),
                                    height: 50,
                                    outline: true,
                                    outlineColor: alertColor.withAlpha(0.4),
                                    outlineWidth: 1,
                                };
                            }

                            ds.entities.add(opts);
                        } else if (ev.type === 'nofly' && ev.polygon) {
                            const positions = ev.polygon.map((p: number[]) => Cesium.Cartesian3.fromDegrees(p[0], p[1], 0));
                            ds.entities.add({
                                id: ev.id,
                                polygon: {
                                    hierarchy: new Cesium.PolygonHierarchy(positions),
                                    material: Cesium.Color.RED.withAlpha(0.3),
                                    extrudedHeight: 20000,
                                    outline: true,
                                    outlineColor: Cesium.Color.RED
                                }
                            });
                        }
                    } catch (e) {
                        // Skip malformed events — don't break the whole loop
                    }
                });
            } catch (err) {}
        }
        
        fetchEvents();

        return () => {
            active = false;
            if (viewer && !viewer.isDestroyed()) {
                viewer.dataSources.remove(ds);
            }
        };
    }, [viewer]);

    useEffect(() => {
        if (osintDsRef.current) {
            osintDsRef.current.show = isOsintVisible; // Simplification, combines both
        }
    }, [isOsintVisible, isJammingVisible]);

    // Recount + apply per-subtype visibility (eventType is the subtype here).
    const subtypeVisibility = useTimelineStore(s => s.subtypeVisibility);
    useEffect(() => {
        if (!viewer) return;
        const tick = () => {
            const ds = osintDsRef.current;
            if (!ds) return;
            const counts: Record<string, number> = {};
            ds.entities.values.forEach(e => {
                const sub = (e.properties as any)?.subtype?.getValue?.() ?? 'XX';
                counts[sub] = (counts[sub] || 0) + 1;
                const show = subtypeVisibility[`osint:${sub}`] !== false;
                e.show = show;
            });
            useTimelineStore.getState().setSubtypeCounts('osint', counts);
        };
        tick();
        const interval = setInterval(tick, 2000);
        return () => clearInterval(interval);
    }, [viewer, subtypeVisibility]);
}
