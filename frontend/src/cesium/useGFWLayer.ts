import { useEffect, useRef } from 'react';
import * as Cesium from 'cesium';
import axios from 'axios';
import { useTimelineStore } from '../store/useTimelineStore';
import { API_URL } from '../lib/config';
import { GFW_ICON } from '../icons/map-icons';
import { safeCartesianFromDegrees } from './position-utils';

export function useGFWLayer(viewer: Cesium.Viewer | null) {
    const isSourceOn = useTimelineStore(s => s.sources.gfw);
    const isVisible = useTimelineStore(s => s.visibility.gfw);
    const mode = useTimelineStore(s => s.mode);
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
                    if (ev.lat == null || ev.lng == null || isNaN(ev.lat) || isNaN(ev.lng)) continue;
                    const position = safeCartesianFromDegrees(ev.lng, ev.lat, 0);
                    if (!position) continue;
                    ds.entities.add({
                        id: ev.id,
                        name: `GFW: ${ev.vesselName || 'Unknown Vessel'} (${ev.flagState || '??'})`,
                        position,
                        properties: new Cesium.PropertyBag({
                            layer: 'GFW',
                            subtype: ev.type || 'gap',
                            vesselId: ev.vesselId,
                            vesselName: ev.vesselName,
                            flagState: ev.flagState,
                            start: ev.start,
                            end: ev.end,
                            confidence: ev.confidence ?? null,
                            duration: ev.duration ?? null,
                            vesselOwner: ev.vesselOwner || null,
                            vesselMmsi: ev.vesselMmsi || null,
                            vesselType: ev.vesselType || null,
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
    const isolatedEntityId = useTimelineStore(s => s.isolatedEntityId);
    useEffect(() => {
        if (!dsRef.current) return;
        const globalShow = mode !== 'playback' && isSourceOn && isVisible;
        dsRef.current.show = globalShow;
        if (globalShow && isolatedEntityId) {
            dsRef.current.entities.values.forEach(e => {
                e.show = isolatedEntityId === e.id;
            });
        } else if (globalShow) {
            dsRef.current.entities.values.forEach(e => {
                e.show = true;
            });
        }
    }, [isSourceOn, isVisible, isolatedEntityId, mode]);

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
