import { useEffect, useRef } from 'react';
import * as Cesium from 'cesium';
import axios from 'axios';
import { useTimelineStore } from '../store/useTimelineStore';

// Dark/gap event icon — purple warning diamond
const GFW_ICON = `data:image/svg+xml,` + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24">` +
    `<circle cx="12" cy="12" r="11" fill="#7c3aed" opacity="0.25"/>` +
    `<circle cx="12" cy="12" r="6" fill="#8b5cf6" stroke="black" stroke-width="1"/>` +
    `<path d="M12 7 L12 13" stroke="white" stroke-width="2" stroke-linecap="round"/>` +
    `<circle cx="12" cy="16" r="1" fill="white"/>` +
    `</svg>`
);

export function useGFWLayer(viewer: Cesium.Viewer | null) {
    const isVisible = useTimelineStore(s => s.layers.gfw);
    const dsRef = useRef<Cesium.CustomDataSource | null>(null);

    useEffect(() => {
        if (!viewer) return;
        let active = true;

        const ds = new Cesium.CustomDataSource('gfw-events');
        viewer.dataSources.add(ds);
        dsRef.current = ds;

        async function fetchGFWEvents() {
            try {
                const res = await axios.get('http://localhost:3055/api/gfw-events');
                if (!active) return;

                const events = res.data;
                useTimelineStore.getState().setStreamMetric('gfw', {
                    count: events.length,
                    status: events.length > 0 ? 'streaming' : 'connecting',
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
            } catch (err) {
                // Silent fail — will retry next interval
            }
        }

        fetchGFWEvents();
        const interval = setInterval(fetchGFWEvents, 30 * 60 * 1000); // refresh every 30 min

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
}
