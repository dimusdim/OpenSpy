import { useEffect, useRef } from 'react';
import * as Cesium from 'cesium';
import axios from 'axios';
import { useTimelineStore } from '../store/useTimelineStore';
import { useSecondaryLoadGate } from './useSecondaryLoadGate';
import { API_URL } from '../lib/config';
import { GFW_ICON } from '../icons/map-icons';
import { safeCartesianFromDegrees } from './position-utils';

export function useGFWLayer(viewer: Cesium.Viewer | null) {
    const isSourceOn = useTimelineStore(s => s.sources.gfw);
    const isVisible = useTimelineStore(s => s.visibility.gfw);
    const mode = useTimelineStore(s => s.mode);
    const secondaryReleased = useSecondaryLoadGate();
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
        if (!viewer || !isSourceOn || !secondaryReleased) return;
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
                        name: 'GFW AIS signal gap',
                        position,
                        properties: new Cesium.PropertyBag({
                            layer: 'GFW',
                            subtype: ev.type || 'gap',
                            start: ev.start,
                            end: ev.end,
                        }),
                        billboard: {
                            image: GFW_ICON,
                            scale: 1.0,
                        },
                        // 40km ellipse removed 2026-04-22 as part of the
                        // perf experiment: with ~5000 GFW entities the
                        // Entity-attached ellipse was one of the main
                        // drivers behind Cesium typed-array allocations
                        // and per-frame BillboardVisualizer.update work.
                        // The circle is a few pixels at global zoom. Re-
                        // introduce via PrimitiveCollection+EllipseGeometry
                        // if close-zoom context ever needs it.
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
    }, [viewer, isSourceOn, secondaryReleased]);

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
