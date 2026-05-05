import { useEffect, useRef } from 'react';
import * as Cesium from 'cesium';
import axios from 'axios';
import { useTimelineStore } from '../store/useTimelineStore';
import { useSecondaryLoadGate } from './useSecondaryLoadGate';
import { API_URL } from '../lib/config';
import { GFW_ICON } from '../icons/map-icons';
import { safeCartesianFromDegrees } from './position-utils';

export interface GfwMeta {
    id: string;
    lat: number;
    lng: number;
    subtype: string;
    start?: string;
    end?: string;
    source: string;
}

export const gfwMetaMap = new Map<string, GfwMeta>();

export function useGFWLayer(viewer: Cesium.Viewer | null) {
    const isSourceOn = useTimelineStore(s => s.sources.gfw);
    const isVisible = useTimelineStore(s => s.visibility.gfw);
    const mode = useTimelineStore(s => s.mode);
    const secondaryReleased = useSecondaryLoadGate();
    const collectionRef = useRef<Cesium.BillboardCollection | null>(null);

    // ---- Effect 1: scene lifetime ----
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
                gfwMetaMap.clear();
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

        async function fetchGFWEvents() {
            const billboards = collectionRef.current;
            if (!billboards) return;
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

                billboards.removeAll();
                gfwMetaMap.clear();

                for (const ev of events) {
                    if (ev.lat == null || ev.lng == null || isNaN(ev.lat) || isNaN(ev.lng)) continue;
                    const position = safeCartesianFromDegrees(ev.lng, ev.lat, 0);
                    if (!position) continue;
                    const id = String(ev.id);
                    billboards.add({
                        id,
                        position,
                        image: GFW_ICON,
                        scale: 1.0,
                        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                    });
                    gfwMetaMap.set(id, {
                        id,
                        lat: ev.lat,
                        lng: ev.lng,
                        subtype: ev.type || 'gap',
                        start: ev.start,
                        end: ev.end,
                        source: 'Global Fishing Watch',
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
        const collection = collectionRef.current;
        if (!collection) return;
        const globalShow = mode !== 'playback' && isSourceOn && isVisible;
        collection.show = globalShow;
        for (let i = 0; i < collection.length; i++) {
            const bb = collection.get(i);
            bb.show = !isolatedEntityId || isolatedEntityId === bb.id;
        }
    }, [isSourceOn, isVisible, isolatedEntityId, mode]);

    // ---- Effect 4: source-off scene clear ----
    useEffect(() => {
        if (isSourceOn) return;
        collectionRef.current?.removeAll();
        gfwMetaMap.clear();
        useTimelineStore.getState().setStreamMetric('gfw', {
            count: 0,
            status: 'disabled',
        });
    }, [isSourceOn]);
}
