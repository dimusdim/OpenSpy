import { useEffect, useRef } from 'react';
import * as Cesium from 'cesium';
import axios from 'axios';
import { useTimelineStore } from '../store/useTimelineStore';
import { API_URL } from '../lib/config';

// GFW dark/gap event icon: no-fishing sign from gfw-event.svg
const GFW_ICON = `data:image/svg+xml,` + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 48 48"><circle cx="24" cy="24" r="20" fill="none" stroke="#8b5cf6" stroke-width="2.5"/><path d="M12 24 Q18 16 28 18 L34 14 L34 20 Q38 24 34 28 L34 34 L28 30 Q18 32 12 24 Z" fill="#a78bfa" stroke="#7c3aed" stroke-width="0.8"/><circle cx="18" cy="23" r="1.8" fill="#8b5cf6"/><circle cx="18" cy="23" r="0.8" fill="#1e1b4b"/><path d="M33 16 L36 14 L34 20" fill="none" stroke="#7c3aed" stroke-width="0.6"/><path d="M33 32 L36 34 L34 28" fill="none" stroke="#7c3aed" stroke-width="0.6"/><line x1="10" y1="38" x2="38" y2="10" stroke="#8b5cf6" stroke-width="3" stroke-linecap="round"/></svg>`);

export function useGFWLayer(viewer: Cesium.Viewer | null) {
    const isSourceOn = useTimelineStore(s => s.sources.gfw);
    const isVisible = useTimelineStore(s => s.visibility.gfw);
    const dsRef = useRef<Cesium.CustomDataSource | null>(null);

    // ---- Effect 1: scene lifetime ----
    useEffect(() => {
        if (!viewer) return;
        const ds = new Cesium.CustomDataSource('gfw-events');
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

        async function fetchGFWEvents() {
            const ds = dsRef.current;
            if (!ds) return;
            try {
                const res = await axios.get(`${API_URL}/api/gfw-events`);
                if (!active) return;

                const events = res.data;
                // Successful fetch (even empty) == streaming. Don't fall back
                // to 'connecting' — that would overwrite 'auth-missing' from
                // /api/status when GFW_TOKEN isn't configured.
                useTimelineStore.getState().setStreamMetric('gfw', {
                    count: events.length,
                    status: 'streaming',
                });

                ds.entities.removeAll();

                for (const ev of events) {
                    ds.entities.add({
                        id: ev.id,
                        name: `GFW: ${ev.vesselName || 'Unknown Vessel'} (${ev.flagState || '??'})`,
                        position: Cesium.Cartesian3.fromDegrees(ev.lng, ev.lat, 0),
                        properties: new Cesium.PropertyBag({
                            layer: 'GFW',
                            subtype: ev.type || 'gap',
                            vesselId: ev.vesselId,
                            vesselName: ev.vesselName,
                            flagState: ev.flagState,
                            start: ev.start,
                            end: ev.end,
                        }),
                        billboard: {
                            image: GFW_ICON,
                            scale: 1.0,
                        },
                        ellipse: {
                            semiMinorAxis: 40_000,
                            semiMajorAxis: 40_000,
                            material: new Cesium.ColorMaterialProperty(Cesium.Color.PURPLE.withAlpha(0.06)),
                            height: 0,
                            outline: true,
                            outlineColor: Cesium.Color.PURPLE.withAlpha(0.25),
                            outlineWidth: 1,
                        },
                    });
                }
            } catch (err: any) {
                console.warn('[GFW] fetch failed:', err?.message || err);
                useTimelineStore.getState().setStreamMetric('gfw', { status: 'error' });
            }
        }

        fetchGFWEvents();
        const interval = setInterval(fetchGFWEvents, 30 * 60 * 1000); // refresh every 30 min

        return () => {
            active = false;
            clearInterval(interval);
            // Keep datasource — Effect 1 owns its lifetime.
        };
    }, [viewer, isSourceOn]);

    // ---- Effect 3: layer visibility ----
    // Effective show = sources && visibility.
    useEffect(() => {
        if (dsRef.current) dsRef.current.show = isSourceOn && isVisible;
    }, [isSourceOn, isVisible]);

    // ---- Effect 4: source-off scene clear ----
    useEffect(() => {
        if (isSourceOn) return;
        if (dsRef.current) dsRef.current.entities.removeAll();
        useTimelineStore.getState().setStreamMetric('gfw', {
            count: 0,
            status: 'disabled',
        });
    }, [isSourceOn]);
}
